// tutorgo: правки плавности доски (спека TutorGo 2026-10-14-board-render-performance).
import React from "react";
import { pointFrom } from "@excalidraw/math";

import { Excalidraw } from "../index";
import { getElementAbsoluteCoords } from "../element/bounds";
import { GESTURE_DPR, staticCanvasScale } from "../tutorgo";

import { API } from "./helpers/api";
import { fireEvent, render, waitFor } from "./test-utils";

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

describe("tutorgo: staticCanvasScale", () => {
  it("вне жеста — dpr экрана, в жесте — не выше GESTURE_DPR", () => {
    expect(staticCanvasScale(false, 2)).toBe(2);
    expect(staticCanvasScale(true, 2)).toBe(Math.min(2, GESTURE_DPR));
    // экран плотностью ниже ручки не повышаем
    expect(staticCanvasScale(true, 0.5)).toBe(0.5);
  });
});

describe("tutorgo: пан колесом — жест", () => {
  it("пан тачпадом/колесом включает shouldCacheIgnoreZoom и двигает сцену", async () => {
    const { container } = await render(<Excalidraw />);
    const before = window.h.state.scrollY;
    // handleWheel слушает контейнер, но игнорирует цели кроме холста
    fireEvent.wheel(container.querySelector("canvas.interactive")!, {
      deltaY: 40,
    });
    await waitFor(() => {
      expect(window.h.state.scrollY).not.toBe(before);
      expect(window.h.state.shouldCacheIgnoreZoom).toBe(true);
    });
  });
});
