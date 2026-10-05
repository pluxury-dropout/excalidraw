// tutorgo: узор фона доски. Координаты — как у strokeGrid: контекст уже
// отмасштабирован на zoom, сцена ещё не сдвинута на scroll.
import {
  BG_DOT_COLOR,
  BG_DOT_RADIUS_PX,
  BG_LINED_STEP,
  BG_LINE_BOLD_COLOR,
  BG_LINE_BOLD_EVERY,
  BG_LINE_COLOR,
  BG_STEP,
  patternOpacity,
} from "../tutorgo";

import type { AppState, Zoom } from "../types";

export const strokeTutorgoBackground = (
  context: CanvasRenderingContext2D,
  background: NonNullable<AppState["tutorgoBackground"]>,
  scrollX: number,
  scrollY: number,
  zoom: Zoom,
  width: number,
  height: number,
) => {
  if (background === "plain") {
    return;
  }
  const step = background === "lined" ? BG_LINED_STEP : BG_STEP;
  const alpha = patternOpacity(step * zoom.value);
  if (alpha === 0) {
    return;
  }
  const px = 1 / zoom.value; // один экранный пиксель в единицах контекста
  const offsetX = (scrollX % step) - step;
  const offsetY = (scrollY % step) - step;
  const endX = offsetX + width + step * 2;
  const endY = offsetY + height + step * 2;

  context.save();
  context.globalAlpha = alpha;

  if (background === "dots") {
    // ponytail: прямоугольник на каждую точку — до ~30k на кадр у порога
    // затухания; если профайлер покажет, перейти на CanvasPattern из тайла.
    const r = BG_DOT_RADIUS_PX * px;
    context.fillStyle = BG_DOT_COLOR;
    context.beginPath();
    for (let x = offsetX; x < endX; x += step) {
      for (let y = offsetY; y < endY; y += step) {
        context.rect(x - r, y - r, r * 2, r * 2);
      }
    }
    context.fill();
  } else {
    // Каждая BG_LINE_BOLD_EVERY-я линия клетки темнее — счёт от начала сцены,
    // чтобы жирные линии не прыгали при пане.
    const isBold = (v: number, scroll: number) =>
      background === "grid" &&
      Math.round((v - scroll) / step) % BG_LINE_BOLD_EVERY === 0;
    context.lineWidth = px;
    const line = (
      x1: number,
      y1: number,
      x2: number,
      y2: number,
      bold: boolean,
    ) => {
      context.strokeStyle = bold ? BG_LINE_BOLD_COLOR : BG_LINE_COLOR;
      context.beginPath();
      context.moveTo(x1, y1);
      context.lineTo(x2, y2);
      context.stroke();
    };
    for (let y = offsetY; y < endY; y += step) {
      line(offsetX, y, endX, y, isBold(y, scrollY));
    }
    if (background === "grid") {
      for (let x = offsetX; x < endX; x += step) {
        line(x, offsetY, x, endY, isBold(x, scrollX));
      }
    }
  }
  context.restore();
};
