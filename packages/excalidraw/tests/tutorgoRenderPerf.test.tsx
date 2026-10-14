// tutorgo: правки плавности доски (спека TutorGo 2026-10-14-board-render-performance).
import React from "react";
import { pointFrom } from "@excalidraw/math";

import { Excalidraw } from "../index";
import { getElementAbsoluteCoords } from "../element/bounds";
import { GESTURE_DPR, staticCanvasScale } from "../tutorgo";

import { API } from "./helpers/api";
import { fireEvent, render, waitFor } from "./test-utils";

import type { LocalPoint } from "@excalidraw/math";

describe("tutorgo: эксперимент IMG_DIRECT", () => {
  // Флаг читается из localStorage при импорте модуля — каждому случаю свежий граф.
  const renderImage = async (flag: string | null) => {
    vi.resetModules();
    if (flag === null) {
      localStorage.removeItem("tg-img-direct");
    } else {
      localStorage.setItem("tg-img-direct", flag);
    }
    const { renderElement, elementWithCanvasCache } = await import(
      "../renderer/renderElement"
    );
    const { getDefaultAppState } = await import("../appState");
    const { arrayToMap } = await import("../utils");
    const rough = (await import("roughjs/bin/rough")).default;

    const el = API.createElement({ type: "image", width: 100, height: 140 });
    const canvas = document.createElement("canvas");
    const map = arrayToMap([el]) as any;
    renderElement(
      el,
      map,
      map,
      rough.canvas(canvas),
      canvas.getContext("2d")!,
      {
        imageCache: new Map(),
        isExporting: false,
        renderGrid: false,
        canvasBackgroundColor: "#fff",
        embedsValidationStatus: new Map(),
        elementsPendingErasure: new Set(),
        pendingFlowchartNodes: null,
      },
      { ...getDefaultAppState(), width: 800, height: 600 } as any,
    );
    localStorage.removeItem("tg-img-direct");
    return elementWithCanvasCache.has(el);
  };

  it("без флага картинка идёт через кэш-холст (апстрим)", async () => {
    expect(await renderImage(null)).toBe(true);
  });

  it("с флагом — мимо кэш-холста", async () => {
    expect(await renderImage("1")).toBe(false);
  });
});

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
