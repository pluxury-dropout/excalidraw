/**
 * Ручки форка TutorGo. Всё, что калибруется «на глаз», собрано здесь; точечные
 * правки поведения живут на месте и помечены комментарием `tutorgo:` —
 * `grep -rn "tutorgo:" packages/` показывает полный список при ребейзе на
 * апстрим.
 *
 * Перо (perfect-freehand 1.2.0, getStrokeOutlinePoints):
 *
 *   sp       = min(1, distance / SPEED_SCALE)   // distance = px между точками = скорость
 *   pressure → 1 - sp                           // с инерцией 0.275 за точку
 *   radius   = size * easing(0.5 - thinning * (0.5 - pressure))
 *
 *   1. PEN_THINNING — амплитуда. 0 отключает весь pressure-путь (радиус =
 *      size/2, ровное перо). 0.6 — штатное Excalidraw: ширина гуляет от
 *      0.62×size (быстро) до 1.9×size (медленно).
 *   2. PEN_SCALE — толщина: ширина = strokeWidth × PEN_SCALE. Нижний конец
 *      диапазона не должен уходить под 1.5px: freedraw заливается как фигура, и
 *      субпиксельная ширина бледнеет в антиалиасинге. В апстриме здесь 4.25.
 *      Тоньше здесь, а не через appState.currentItemStrokeWidth, потому что
 *      strokeWidth общий для всех инструментов: там 0.25 дало бы волосяные
 *      прямоугольники и стрелки. Тулбар продолжает работать, три его градации
 *      просто становятся тоньше.
 *   3. PEN_SPEED_SCALE — порог скорости в px на событие указателя: скорость, на
 *      которой штрих истончается до минимума. В оригинале эту роль играет сам
 *      size, из-за чего эффект зависел от толщины пера и на тонком (size 1.5)
 *      насыщался в «всегда быстро»: мышь на 60 Гц легко проходит 5–20px за
 *      кадр. Больше — утоньшение начинается на более быстрых движениях,
 *      меньше — на более медленных. Как шкала отвязывается от size, см.
 *      getFreeDrawSvgPath в renderer/renderElement.ts.
 *
 * Всё это работает только для мыши/тачпада (simulatePressure: true). У стилуса
 * Excalidraw пишет реальные element.pressures, и толщина идёт от нажима.
 */
export const PEN_SCALE = 1;
export const PEN_THINNING = 0.9;
export const PEN_SPEED_SCALE = 10;

/**
 * Фон доски (спека TutorGo 2026-10-05). Всё «на глаз»: узор должен быть виден,
 * но не спорить с чернилами. Шаг — в единицах сцены (масштабируется с зумом),
 * толщины и радиус точек — в экранных px (не толстеют при приближении).
 * Цвет под узором ставит хост через viewBackgroundColor.
 */
export const BG_STEP = 24;
/** Линейка: под строку текста по умолчанию (Nunito 20 × lineHeight 1.25 = 25). */
export const BG_LINED_STEP = 25;
export const BG_DOT_COLOR = "#D6D6DB";
export const BG_DOT_RADIUS_PX = 0.75;
export const BG_LINE_COLOR = "#ECECEF";
export const BG_LINE_BOLD_COLOR = "#DCDCE1";
export const BG_LINE_BOLD_EVERY = 5;
/** Шаг на экране, ниже которого узор начинает гаснуть и где пропадает совсем. */
export const BG_FADE_FROM_PX = 14;
export const BG_FADE_TO_PX = 8;

/**
 * Точки — два слоя: крупный (каждая вторая по обеим осям) и мелкий (остальные).
 * Мелкий гаснет раньше: у порога затухания точек на экране вчетверо меньше
 * (иначе ~30k прямоугольников на каждую перерисовку), и прореживание — не скачком.
 */
export const BG_DOTS_FINE_FROM_PX = 18;
export const BG_DOTS_FINE_TO_PX = 12;

const fade = (stepPx: number, from: number, to: number) =>
  Math.min(1, Math.max(0, (stepPx - to) / (from - to)));

/** Видимость узора от шага на экране (шаг × zoom): 1 → 0 линейно. */
export const patternOpacity = (stepPx: number) =>
  fade(stepPx, BG_FADE_FROM_PX, BG_FADE_TO_PX);

/** Видимость мелкого слоя точек — множитель к patternOpacity. */
export const fineDotsOpacity = (stepPx: number) =>
  fade(stepPx, BG_DOTS_FINE_FROM_PX, BG_DOTS_FINE_TO_PX);

// отступ, затем «1.» / «1)» или «-» / «•», затем пробел(ы)
const LIST_ITEM = /^(\s*)(?:(\d+)([.)])|([-•]))\s+/;

/** Отступ, с которого начинается список (как Tab в редакторе текста). */
export const LIST_INDENT = "    ";
// начало строки до только что набранного пробела: «1.», «1)», «-», «*», «•»
const LIST_START = /^(\s*)(\d+[.)]|[-*•]) $/;

/**
 * Пробел после «1.» / «-» / «*» в начале строки начинает список, как в Miro:
 * строка без отступа получает LIST_INDENT, «-» и «*» становятся «•».
 * `cursor` — позиция сразу после набранного пробела. null — ничего не менять.
 */
export const startList = (
  value: string,
  cursor: number,
): { value: string; cursor: number } | null => {
  const lineStart = value.lastIndexOf("\n", cursor - 1) + 1;
  const m = value.slice(lineStart, cursor).match(LIST_START);
  if (!m) {
    return null;
  }
  const marker = /\d/.test(m[2]) ? m[2] : "•";
  const head = `${m[1] || LIST_INDENT}${marker} `;
  if (head === m[0]) {
    return null;
  }
  return {
    value: value.slice(0, lineStart) + head + value.slice(cursor),
    cursor: lineStart + head.length,
  };
};

/**
 * Enter в текстовом поле на строке-пункте списка: новая строка с тем же
 * отступом и следующим маркером. Enter на пустом пункте стирает маркер —
 * список закончен. Возвращает null, если строка не пункт списка (или курсор
 * стоит внутри маркера) — тогда Enter обычный.
 * ponytail: пункты ниже не перенумеровываются при вставке в середину.
 */
export const continueList = (
  value: string,
  selStart: number,
  selEnd: number,
): { value: string; cursor: number } | null => {
  const lineStart = value.lastIndexOf("\n", selStart - 1) + 1;
  const lineEndIdx = value.indexOf("\n", selStart);
  const lineEnd = lineEndIdx === -1 ? value.length : lineEndIdx;
  const line = value.slice(lineStart, lineEnd);
  const m = line.match(LIST_ITEM);
  if (!m || selStart < lineStart + m[0].length) {
    return null;
  }
  if (m[0].length === line.length && selStart === selEnd) {
    return {
      value: value.slice(0, lineStart) + value.slice(lineEnd),
      cursor: lineStart,
    };
  }
  const [, indent, num, delim, bullet] = m;
  const insert = `\n${indent}${num ? `${Number(num) + 1}${delim}` : bullet} `;
  return {
    value: value.slice(0, selStart) + insert + value.slice(selEnd),
    cursor: selStart + insert.length,
  };
};
