// tutorgo: пространственный индекс сцены (спека TutorGo 2026-10-15-board-tiled-rendering, §3.3).
import React from "react";
import { pointFrom } from "@excalidraw/math";

import { DEFAULT_COLLISION_THRESHOLD } from "../constants";
import { getElementAbsoluteCoords, getElementBounds } from "../element/bounds";
import { LinearElementEditor } from "../element/linearElementEditor";
import { mutateElement } from "../element/mutateElement";
import { isElementInViewport } from "../element/sizeHelpers";
import { isTextElement } from "../element/typeChecks";
import { syncInvalidIndices } from "../fractionalIndex";
import { getContainingFrame, isCursorInFrame } from "../frame";
import { Excalidraw } from "../index";
import { Renderer } from "../scene/Renderer";
import Scene from "../scene/Scene";
import { TutorgoSpatialIndex } from "../scene/tutorgoIndex";

import { API } from "./helpers/api";
import { Pointer, UI } from "./helpers/ui";
import { render } from "./test-utils";

import type { LocalPoint } from "@excalidraw/math";
import type {
  ExcalidrawElement,
  NonDeletedExcalidrawElement,
} from "../element/types";
import type { NormalizedZoomValue } from "../types";

const { h } = window;
const mouse = new Pointer("mouse");

// mulberry32: детерминированный ГПСЧ, чтобы падение воспроизводилось.
const seeded = (seed: number) => () => {
  seed = (seed + 0x6d2b79f5) | 0;
  let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};

const mapOf = (els: readonly ExcalidrawElement[]) =>
  new Map(els.map((e) => [e.id, e])) as any;

const rect = (x: number, y: number, width = 100, height = 100) =>
  API.createElement({ type: "rectangle", x, y, width, height });

const makeScene = () => {
  const rnd = seeded(42);
  const span = 200_000;
  const els: NonDeletedExcalidrawElement[] = [];
  for (let i = 0; i < 2000; i++) {
    const x = (rnd() - 0.5) * span;
    const y = (rnd() - 0.5) * span;
    const kind = rnd();
    if (kind < 0.3) {
      const points: LocalPoint[] = [pointFrom(0, 0)];
      for (let p = 0; p < 20; p++) {
        points.push(pointFrom(rnd() * 600 - 300, rnd() * 600 - 300));
      }
      els.push(API.createElement({ type: "freedraw", x, y, points }) as any);
    } else {
      els.push(
        API.createElement({
          type: "rectangle",
          x,
          y,
          width: 10 + rnd() * 3000,
          height: 10 + rnd() * 3000,
          angle: (kind < 0.6 ? rnd() * Math.PI : 0) as any,
        }) as any,
      );
    }
  }
  for (let i = 0; i < 20; i++) {
    els.push(
      rect((rnd() - 0.5) * span, (rnd() - 0.5) * span, 300_000, 300_000) as any,
    );
  }
  for (let i = 0; i < 3; i++) {
    els.push(
      API.createElement({
        type: "frame",
        x: (rnd() - 0.5) * span,
        y: (rnd() - 0.5) * span,
        width: 400,
        height: 300,
      }) as any,
    );
  }
  return { els, rnd, span };
};

describe("tutorgo: пространственный индекс", () => {
  it("кандидаты покрывают перебор", () => {
    const { els, rnd, span } = makeScene();
    const map = mapOf(els);
    const index = new TutorgoSpatialIndex();
    index.sync(els, map, 1);
    const t = 10;

    const check = (x: number, y: number) => {
      const found = index.query(x - t, y - t, x + t, y + t);
      let hits = 0;
      for (const el of els) {
        const [x1, y1, x2, y2] = getElementBounds(el, map);
        if (x1 - t <= x && x <= x2 + t && y1 - t <= y && y <= y2 + t) {
          hits++;
          expect(found.has(el.id)).toBe(true);
        }
      }
      return hits;
    };

    for (let i = 0; i < 500; i++) {
      check((rnd() - 0.5) * span, (rnd() - 0.5) * span);
    }
    // случайные точки редко попадают в мелкие элементы — берём центры самих
    // элементов, иначе проверка вырождается в «гигантов и рамки».
    for (let i = 0; i < 500; i++) {
      const [x1, y1, x2, y2] = getElementBounds(els[i], map);
      expect(check((x1 + x2) / 2, (y1 + y2) / 2)).toBeGreaterThan(0);
    }
  });

  it("рамки и гигантские элементы возвращаются любым запросом", () => {
    const { els } = makeScene();
    const index = new TutorgoSpatialIndex();
    index.sync(els, mapOf(els), 1);
    const found = index.query(1e7, 1e7, 1e7 + 1, 1e7 + 1);
    expect(found.size).toBe(23);
    for (const el of els.slice(2000)) {
      expect(found.has(el.id)).toBe(true);
    }
  });

  it("следует за правками", () => {
    const a = rect(0, 0);
    const b = rect(50, 50);
    const els = [a, b] as NonDeletedExcalidrawElement[];
    const index = new TutorgoSpatialIndex();
    index.sync(els, mapOf(els), 1);
    expect(index.query(10, 10, 20, 20).has(a.id)).toBe(true);

    mutateElement(a, { x: a.x + 5000 });
    index.sync(els, mapOf(els), 2);
    expect(index.query(10, 10, 20, 20).has(a.id)).toBe(false);
    expect(index.query(10, 10, 20, 20).has(b.id)).toBe(true);
    expect(index.query(5010, 10, 5020, 20).has(a.id)).toBe(true);

    index.sync([b] as NonDeletedExcalidrawElement[], mapOf([b]), 3);
    expect(index.query(-1e6, -1e6, 1e6, 1e6).has(a.id)).toBe(false);
    expect(index.query(5010, 10, 5020, 20).has(a.id)).toBe(false);
    expect(index.query(60, 60, 70, 70).has(b.id)).toBe(true);
  });

  it("та же version, другой versionNonce (LWW-reconcile) — пересчитывается", () => {
    const a = rect(0, 0);
    const index = new TutorgoSpatialIndex();
    index.sync([a] as NonDeletedExcalidrawElement[], mapOf([a]), 1);

    // чужая правка того же элемента: version совпала, versionNonce и координаты нет
    const moved = {
      ...a,
      x: a.x + 5000,
      y: a.y + 5000,
      versionNonce: a.versionNonce + 1,
    } as NonDeletedExcalidrawElement;
    index.sync([moved], mapOf([moved]), 2);
    expect(index.query(10, 10, 20, 20).has(a.id)).toBe(false);
    expect(index.query(5010, 5010, 5020, 5020).has(a.id)).toBe(true);
  });

  it("тот же nonce — no-op", () => {
    const a = rect(0, 0);
    const els = [a] as NonDeletedExcalidrawElement[];
    const index = new TutorgoSpatialIndex();
    index.sync(els, mapOf(els), 1);
    mutateElement(a, { x: a.x + 5000 });
    index.sync(els, mapOf(els), 1);
    expect(index.query(10, 10, 20, 20).has(a.id)).toBe(true);
    expect(index.query(5010, 10, 5020, 20).has(a.id)).toBe(false);
  });

  it("order совпадает с индексом в массиве", () => {
    const { els } = makeScene();
    const index = new TutorgoSpatialIndex();
    index.sync(els, mapOf(els), 1);
    els.forEach((el, i) => expect(index.order(el.id)).toBe(i));

    const reversed = [...els].reverse();
    index.sync(reversed, mapOf(reversed), 2);
    reversed.forEach((el, i) => expect(index.order(el.id)).toBe(i));
  });

  it("видимые через индекс == перебор", () => {
    const { els, rnd, span } = makeScene();
    const scene = new Scene();
    // без fractional index сцена в тестовом окружении бросает на валидации
    scene.replaceAllElements(syncInvalidIndices(els));
    const renderer = new Renderer(scene);
    const small = new Set(els.slice(0, 2000).map((el) => el.id));
    let total = 0;

    for (let i = 0; i < 200; i++) {
      if (i % 50 === 49) {
        // правки между кадрами (mutateElement поднимает nonce сцены) — индекс
        // обязан их догнать
        for (let k = 0; k < 100; k++) {
          const el = els[Math.floor(rnd() * 2000)];
          mutateElement(el, { x: el.x + (rnd() - 0.5) * 20_000 });
        }
      }
      // каждый второй кадр — вокруг случайного элемента: доска разрежена, и
      // наугад кадр почти всегда пуст
      const [x1, y1] = getElementBounds(
        els[Math.floor(rnd() * 2000)],
        scene.getNonDeletedElementsMap(),
      );
      const vp = {
        zoom: { value: (0.05 + rnd() * 3.95) as NormalizedZoomValue },
        offsetLeft: rnd() * 100,
        offsetTop: rnd() * 100,
        scrollX: i % 2 ? (rnd() - 0.5) * span : -x1 + 100,
        scrollY: i % 2 ? (rnd() - 0.5) * span : -y1 + 100,
        width: 400 + rnd() * 1600,
        height: 300 + rnd() * 900,
      };
      const { visibleElements } = renderer.getRenderableElements({
        ...vp,
        editingTextElement: null,
        newElementId: undefined,
        pendingImageElementId: null,
        sceneNonce: scene.getSceneNonce(),
      });
      const expected = scene
        .getNonDeletedElements()
        .filter((el) =>
          isElementInViewport(
            el,
            vp.width,
            vp.height,
            vp,
            scene.getNonDeletedElementsMap(),
          ),
        );
      expect(visibleElements.map((el) => el.id)).toEqual(
        expected.map((el) => el.id),
      );
      total += expected.filter((el) => small.has(el.id)).length;
    }
    // проверка не выродилась в «гигантов и рамки»: в каждом кадре вокруг
    // элемента есть хотя бы он сам
    expect(total).toBeGreaterThanOrEqual(100);
  });
});

describe("tutorgo: индекс в приложении", () => {
  beforeEach(async () => {
    await render(
      React.createElement(Excalidraw, { handleKeyboardGlobally: true }),
    );
  });

  const at = (x: number, y: number) =>
    (h.app as any).getElementAtPosition(x, y) as ExcalidrawElement | null;

  /** id видимых в кадре 100×100 вокруг точки сцены (zoom 1). */
  const visibleAround = (x: number, y: number) =>
    h.app.renderer
      .getRenderableElements({
        zoom: h.state.zoom,
        offsetLeft: 0,
        offsetTop: 0,
        scrollX: -(x - 50),
        scrollY: -(y - 50),
        width: 100,
        height: 100,
        editingTextElement: null,
        newElementId: undefined,
        pendingImageElementId: null,
        sceneNonce: h.app.scene.getSceneNonce(),
      })
      .visibleElements.map((el) => el.id);

  it("хит-тест после перетаскивания", () => {
    const r = API.createElement({
      type: "rectangle",
      x: 0,
      y: 0,
      width: 100,
      height: 100,
      backgroundColor: "#ff0000",
      fillStyle: "solid",
    });
    API.setElements([r]);
    expect(at(50, 50)?.id).toBe(r.id);

    mouse.downAt(50, 50);
    mouse.moveTo(350, 50);
    mouse.up();
    expect(r.x).toBe(300);

    expect(at(350, 50)?.id).toBe(r.id);
    expect(at(50, 50)).toBe(null);

    // и кликом: снять выделение в пустоте, выбрать на новом месте
    mouse.clickAt(-500, -500);
    expect(h.state.selectedElementIds[r.id]).toBeFalsy();
    mouse.clickAt(350, 50);
    expect(h.state.selectedElementIds[r.id]).toBe(true);
  });

  it("стрелка, привязанная к прямоугольнику, — на новом месте после его перетаскивания", () => {
    const rectangle = UI.createElement("rectangle", {
      x: 0,
      y: 0,
      width: 100,
      height: 100,
    });
    const arrow = UI.createElement("arrow", {
      x: 110,
      y: 50,
      width: 200,
      height: 1,
    });
    expect(arrow.startBinding?.elementId).toBe(rectangle.id);

    const mid = () => {
      const a = arrow.points[0];
      const b = arrow.points[arrow.points.length - 1];
      return {
        x: arrow.x + (a[0] + b[0]) / 2,
        y: arrow.y + (a[1] + b[1]) / 2,
      };
    };
    const before = mid();
    // точка, где стрелка окажется: свободный конец (310, 50) на месте, начало
    // уезжает с прямоугольником на +3000 по x — середина около (1650, 50)
    expect(at(1650, 50)).toBe(null);
    expect(visibleAround(1650, 50)).not.toContain(arrow.id);

    // за левую кромку: незалитый прямоугольник ловится по контуру
    mouse.downAt(0, 50);
    mouse.moveTo(3000, 50);
    mouse.up();
    expect(rectangle.x).toBe(3000);
    expect(arrow.startBinding?.elementId).toBe(rectangle.id);

    const after = mid();
    expect(after.x).toBeGreaterThan(before.x + 1000);
    expect(at(after.x, after.y)?.id).toBe(arrow.id);
    expect(visibleAround(after.x, after.y)).toContain(arrow.id);
    expect(at(before.x, before.y)).toBe(null);
  });

  it("подпись стрелки, выросшая после индексации, ловит стрелку", () => {
    const [arrow, label] = API.createLabeledArrow();
    API.setElements([arrow, label]);
    const arrowX2 = getElementBounds(
      arrow,
      h.app.scene.getNonDeletedElementsMap(),
    )[2];
    expect(arrowX2).toBeLessThan(1000);
    expect(at(1400, arrow.y)).toBe(null); // индекс синкнут до роста подписи

    // подпись растёт — version стрелки не меняется, её ячейки прежние
    const version = arrow.version;
    mutateElement(label, { width: 3000 });
    expect(arrow.version).toBe(version);

    const pos = LinearElementEditor.getBoundTextElementPosition(
      arrow as any,
      label as any,
      h.app.scene.getNonDeletedElementsMap(),
    );
    const px = pos.x + 3000 - 50;
    expect(px).toBeGreaterThan(1400);
    expect(at(px, pos.y + label.height / 2)?.id).toBe(arrow.id);
  });

  it("повёрнутый выделенный — ловится по углу рамки выделения за пределами своих границ", () => {
    // рамка выделения — прямоугольник, раздутый на t и повёрнутый вместе с
    // элементом: на 45° её угол выходит за AABB элемента на t·√2 > t. Ставим
    // правую кромку AABB чуть левее границы ячейки индекса (1024).
    const t = DEFAULT_COLLISION_THRESHOLD;
    const half = 50 * Math.SQRT2;
    const right = 1024 - 0.1 * t;
    const cx = right - half;
    const r = API.createElement({
      type: "rectangle",
      x: cx - 50,
      y: -50,
      width: 100,
      height: 100,
      angle: (Math.PI / 4) as any,
    });
    API.setElements([r]);
    API.setSelectedElements([r]);
    expect(
      getElementBounds(r, h.app.scene.getNonDeletedElementsMap())[2],
    ).toBeCloseTo(right);
    expect(at(1024 + 1.2 * t, 0)?.id).toBe(r.id);
  });

  it("выделенные ромб, эллипс, штрих под 45° — ловятся в углу рамки выделения", () => {
    // Рамка выделения строится по неповёрнутому прямоугольнику и поворачивается
    // целиком, а границы в индексе — узкая рамка уже повёрнутой геометрии:
    // у ромба и диагонального штриха на 45° разница — сотни пикселей.
    const cases = [
      API.createElement({ type: "diamond", x: 0, y: 0, width: 1000 }),
      API.createElement({ type: "ellipse", x: -50, y: 0, width: 1000 }),
      API.createElement({
        type: "freedraw",
        x: 0,
        y: 0,
        width: 1000,
        points: [
          pointFrom<LocalPoint>(0, 0),
          pointFrom<LocalPoint>(1000, 1000),
        ],
      }),
    ];
    const missed: string[] = [];
    for (const el of cases) {
      mutateElement(el, { angle: (Math.PI / 4) as any }, false);
      API.setElements([el]);
      API.setSelectedElements([el]);
      const map = h.app.scene.getNonDeletedElementsMap();
      const [, , x2] = getElementBounds(el, map);
      const [, , , , cx, cy] = getElementAbsoluteCoords(el, map);
      // в правом «острие» повёрнутой рамки выделения, в соседней ячейке индекса
      const px = cx + 650;
      const t = DEFAULT_COLLISION_THRESHOLD;
      expect(Math.floor((px - 2 * t) / 1024)).toBeGreaterThan(
        Math.floor(x2 / 1024),
      );
      if (at(px, cy)?.id !== el.id) {
        missed.push(el.type);
      }
    }
    expect(missed).toEqual([]);
  });

  it("паритет хит-теста с перебором (типы, повороты, выделение, zoom)", () => {
    const rnd = seeded(7);
    const types = [
      "rectangle",
      "diamond",
      "ellipse",
      "freedraw",
      "line",
      "arrow",
    ] as const;
    const frame = API.createElement({
      type: "frame",
      x: -1000,
      y: -1000,
      width: 2000,
      height: 2000,
    });
    const els: ExcalidrawElement[] = [frame];
    for (let i = 0; i < 150; i++) {
      const type = types[i % types.length];
      // крупные (до 4 ячеек): у повёрнутых выделенных угол рамки выделения
      // уходит за их ячейки в индексе — то, что тест обязан ловить
      const w = 10 + rnd() * 4000;
      const hh = 10 + rnd() * 4000;
      const common = {
        x: (rnd() - 0.5) * 12000,
        y: (rnd() - 0.5) * 12000,
        width: w,
        height: hh,
        angle: (rnd() < 0.5 ? rnd() * 2 * Math.PI : 0) as any,
        frameId: rnd() < 0.1 ? frame.id : null,
        ...(rnd() < 0.5
          ? { backgroundColor: "#ff0000", fillStyle: "solid" as const }
          : {}),
      };
      let el: ExcalidrawElement;
      if (type === "freedraw" || type === "line" || type === "arrow") {
        const points = [pointFrom<LocalPoint>(0, 0)];
        const n = type === "freedraw" ? 20 : 1 + Math.floor(rnd() * 3);
        for (let p = 0; p < n; p++) {
          points.push(pointFrom<LocalPoint>(rnd() * w, rnd() * hh));
        }
        points.push(pointFrom<LocalPoint>(w, hh));
        el = API.createElement({ type, ...common, points });
      } else {
        el = API.createElement({ type, ...common });
      }
      if (rnd() < 0.1) {
        mutateElement(el, { locked: true }, false);
      }
      els.push(el);
    }
    els.push(...API.createLabeledArrow());
    API.setElements(syncInvalidIndices(els));
    API.setSelectedElements(els.filter(() => rnd() < 0.5));

    const app = h.app as any;
    // апстримный getElementsAtPosition: те же фильтры по всем элементам
    const reference = (x: number, y: number) => {
      const map = h.app.scene.getNonDeletedElementsMap();
      return h.app.scene
        .getNonDeletedElements()
        .filter((el) => !el.locked && !(isTextElement(el) && el.containerId))
        .filter((el) => app.hitElement(x, y, el))
        .filter((el) => {
          const f = getContainingFrame(el, map);
          return f &&
            h.state.frameRendering.enabled &&
            h.state.frameRendering.clip
            ? isCursorInFrame({ x, y }, f, map)
            : true;
        })
        .map((el) => el.id);
    };

    let hits = 0;
    for (const z of [0.05, 0.3, 1, 2.5, 4]) {
      API.setAppState({ zoom: { value: z as NormalizedZoomValue } });
      const t = DEFAULT_COLLISION_THRESHOLD / z;
      const map = h.app.scene.getNonDeletedElementsMap();
      for (let i = 0; i < 300; i++) {
        // точка у элемента с запасом за его границы — туда, где рамка
        // выделения (у ромба на 45° — до половины ширины) и порог хит-теста
        // выходят за рамку в индексе
        const el = els[1 + Math.floor(rnd() * (els.length - 1))];
        const [x1, y1, x2, y2] = getElementBounds(el, map);
        const mx = 0.5 * (x2 - x1) + 3 * t;
        const my = 0.5 * (y2 - y1) + 3 * t;
        const x = x1 - mx + rnd() * (x2 - x1 + 2 * mx);
        const y = y1 - my + rnd() * (y2 - y1 + 2 * my);
        const expected = reference(x, y);
        const actual = app
          .getElementsAtPosition(x, y)
          .map((e: ExcalidrawElement) => e.id);
        expect(actual).toEqual(expected);
        hits += expected.length;
      }
    }
    // проверка не выродилась в «везде пусто»
    expect(hits).toBeGreaterThan(100);
  });
});
