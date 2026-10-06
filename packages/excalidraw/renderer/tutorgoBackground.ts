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
  fineDotsOpacity,
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
    // Два слоя (см. fineDotsOpacity): крупный — точки с чётными индексами по
    // обеим осям, мелкий — остальные. Индекс считается от начала сцены, чтобы
    // слои не менялись местами при пане. Мелкий гаснет раньше, поэтому у порога
    // затухания на экране не больше ~8k точек вместо ~30k.
    const r = BG_DOT_RADIUS_PX * px;
    const even = (v: number, scroll: number) =>
      Math.round((v - scroll) / step) % 2 === 0;
    const dots = (coarse: boolean) => {
      const s = coarse ? step * 2 : step;
      const startX = (scrollX % s) - s;
      const startY = (scrollY % s) - s;
      context.beginPath();
      for (let x = startX; x < endX; x += s) {
        for (let y = startY; y < endY; y += s) {
          if (!coarse && even(x, scrollX) && even(y, scrollY)) {
            continue;
          }
          context.rect(x - r, y - r, r * 2, r * 2);
        }
      }
      context.fill();
    };
    context.fillStyle = BG_DOT_COLOR;
    dots(true);
    const fine = fineDotsOpacity(step * zoom.value);
    if (fine > 0) {
      context.globalAlpha = alpha * fine;
      dots(false);
    }
  } else {
    // Как strokeGrid в апстриме: на зуме 100% линия в 1px на целой координате
    // размазывается на два пикселя — сдвигаем на полпикселя.
    if (zoom.value === 1) {
      context.translate(offsetX % 1 ? 0 : 0.5, offsetY % 1 ? 0 : 0.5);
    }
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
