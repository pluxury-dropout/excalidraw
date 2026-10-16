// tutorgo: пространственный индекс сцены (спека TutorGo 2026-10-15-board-tiled-rendering, §3.3).
import React from "react";
import { pointFrom } from "@excalidraw/math";

import { DEFAULT_COLLISION_THRESHOLD } from "../constants";
import { getElementBounds } from "../element/bounds";
import { LinearElementEditor } from "../element/linearElementEditor";
import { mutateElement } from "../element/mutateElement";
import { isElementInViewport } from "../element/sizeHelpers";
import { syncInvalidIndices } from "../fractionalIndex";
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
});
