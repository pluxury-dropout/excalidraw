// tutorgo: хоткеи на нелатинской раскладке — буква берётся с физической клавиши.
import React from "react";

import { Excalidraw } from "../index";
import { shortcutKey } from "../tutorgo";

import { API } from "./helpers/api";
import { fireEvent, render } from "./test-utils";

describe("tutorgo: хоткеи на русской раскладке", () => {
  it("К (KeyR) включает прямоугольник, Ctrl+Ф (KeyA) выделяет всё", async () => {
    await render(<Excalidraw handleKeyboardGlobally />);
    fireEvent.keyDown(document, { key: "к", code: "KeyR" });
    expect(window.h.state.activeTool.type).toBe("rectangle");

    API.setElements([API.createElement({ type: "rectangle" })]);
    fireEvent.keyDown(document, { key: "ф", code: "KeyA", ctrlKey: true });
    expect(Object.keys(window.h.state.selectedElementIds)).toHaveLength(1);
  });
});

describe("tutorgo: shortcutKey", () => {
  it.each([
    // [key, code, shift, ожидание]
    ["к", "KeyR", false, "r"], // русская: R → прямоугольник
    ["К", "KeyR", true, "R"],
    ["К", "KeyR", false, "r"], // CapsLock на русской
    ["ф", "KeyA", false, "a"], // Ctrl+A
    ["R", "KeyR", false, "r"], // CapsLock на латинице (апстрим #2372)
    ["r", "KeyR", true, "R"],
    ["r", "KeyR", false, "r"],
    ["q", "KeyA", false, "q"], // AZERTY: латиницу по code не переназначаем
    ["1", "Digit1", false, "1"],
    ["х", "BracketLeft", false, "х"], // не буквенная клавиша — как есть
    ["ё", "Backquote", false, "ё"],
    ["Escape", "Escape", false, "Escape"],
    [" ", "Space", false, " "],
  ])("%s / %s / shift=%s → %s", (key, code, shift, want) => {
    expect(shortcutKey(key, code, shift)).toBe(want);
  });
});
