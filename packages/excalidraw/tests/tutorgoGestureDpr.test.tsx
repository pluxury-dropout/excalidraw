// tutorgo: пониженная плотность холста во время жеста (GESTURE_DPR).
import React from "react";

import { Excalidraw } from "../index";
import { GESTURE_DPR, staticCanvasScale } from "../tutorgo";

import { fireEvent, render, waitFor } from "./test-utils";

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
