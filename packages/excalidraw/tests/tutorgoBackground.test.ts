// tutorgo: видимость узора фона доски от зума.
import {
  patternOpacity,
  fineDotsOpacity,
  BG_FADE_FROM_PX,
  BG_FADE_TO_PX,
  BG_DOTS_FINE_FROM_PX,
  BG_DOTS_FINE_TO_PX,
} from "../tutorgo";

// Точки рисуются двумя слоями: «крупный» (каждая вторая по обеим осям) и
// «мелкий» (остальные). Мелкий гаснет раньше — у порога затухания на экране
// остаётся вчетверо меньше точек, а прореживание не скачком.
describe("tutorgo: fineDotsOpacity", () => {
  it("мелкий слой виден целиком на обычном зуме", () => {
    expect(fineDotsOpacity(24)).toBe(1);
    expect(fineDotsOpacity(BG_DOTS_FINE_FROM_PX)).toBe(1);
  });
  it("мелкий слой пропадает раньше, чем гаснет весь узор", () => {
    expect(fineDotsOpacity(BG_DOTS_FINE_TO_PX)).toBe(0);
    expect(BG_DOTS_FINE_TO_PX).toBeGreaterThan(BG_FADE_TO_PX);
    // Пока мелкий слой ещё виден, крупный — непрозрачный: нет «дыры» в узоре.
    expect(patternOpacity(BG_DOTS_FINE_TO_PX)).toBeGreaterThan(0);
  });
  it("плавно между порогами", () => {
    const mid = fineDotsOpacity((BG_DOTS_FINE_FROM_PX + BG_DOTS_FINE_TO_PX) / 2);
    expect(mid).toBeGreaterThan(0.4);
    expect(mid).toBeLessThan(0.6);
  });
});

describe("tutorgo: patternOpacity", () => {
  it("полностью виден, пока шаг на экране крупный", () => {
    expect(patternOpacity(24)).toBe(1);
    expect(patternOpacity(BG_FADE_FROM_PX)).toBe(1);
  });
  it("исчезает при сильном отдалении, а не сереет", () => {
    expect(patternOpacity(BG_FADE_TO_PX)).toBe(0);
    expect(patternOpacity(1)).toBe(0);
  });
  it("плавно между порогами", () => {
    const mid = patternOpacity((BG_FADE_FROM_PX + BG_FADE_TO_PX) / 2);
    expect(mid).toBeGreaterThan(0.4);
    expect(mid).toBeLessThan(0.6);
  });
});
