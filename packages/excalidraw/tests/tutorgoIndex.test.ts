// tutorgo: пространственный индекс сцены (спека TutorGo 2026-10-15-board-tiled-rendering, §3.3).
import { pointFrom } from "@excalidraw/math";

import { getElementBounds } from "../element/bounds";
import { mutateElement } from "../element/mutateElement";
import { TutorgoSpatialIndex } from "../scene/tutorgoIndex";

import { API } from "./helpers/api";

import type { LocalPoint } from "@excalidraw/math";
import type {
  ExcalidrawElement,
  NonDeletedExcalidrawElement,
} from "../element/types";

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
});
