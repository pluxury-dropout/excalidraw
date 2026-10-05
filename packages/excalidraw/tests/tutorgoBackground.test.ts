// tutorgo: видимость узора фона доски от зума.
import { patternOpacity, BG_FADE_FROM_PX, BG_FADE_TO_PX } from "../tutorgo";

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
