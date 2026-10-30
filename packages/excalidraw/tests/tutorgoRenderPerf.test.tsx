// tutorgo: правки плавности доски (спека TutorGo 2026-10-14-board-render-performance).
import { pointFrom } from "@excalidraw/math";

import { getElementAbsoluteCoords } from "../element/bounds";

import { API } from "./helpers/api";

import type { LocalPoint } from "@excalidraw/math";

describe("tutorgo: кэш границ штриха пера", () => {
  it("новый массив точек — новые границы, тот же — тот же результат", () => {
    const el = API.createElement({
      type: "freedraw",
      x: 10,
      y: 20,
      points: [pointFrom<LocalPoint>(0, 0), pointFrom<LocalPoint>(5, 7)],
    });
    expect(getElementAbsoluteCoords(el, new Map())).toEqual([
      10, 20, 15, 27, 12.5, 23.5,
    ]);
    expect(getElementAbsoluteCoords(el, new Map())).toEqual([
      10, 20, 15, 27, 12.5, 23.5,
    ]);
    const longer = {
      ...el,
      points: [...el.points, pointFrom<LocalPoint>(-3, 30)],
    };
    expect(getElementAbsoluteCoords(longer, new Map())).toEqual([
      7, 20, 15, 50, 11, 35,
    ]);
  });
});
