// tutorgo: UIOptions.tools прячет инструменты вместе с их хоткеями.
import React from "react";

import { KEYS } from "../keys";
import { Excalidraw } from "../index";

import { Keyboard } from "./helpers/ui";
import { render, queryByTestId } from "./test-utils";

const HIDDEN = {
  image: false,
  diamond: false,
  line: false,
  frame: false,
  embeddable: false,
  mermaid: false,
  lock: false,
  help: false,
};

describe("tutorgo: UIOptions.tools", () => {
  it("не рендерит спрятанные кнопки", async () => {
    const { container } = await render(
      <Excalidraw UIOptions={{ tools: HIDDEN }} handleKeyboardGlobally />,
    );
    for (const id of ["toolbar-diamond", "toolbar-line", "toolbar-lock"]) {
      expect(queryByTestId(container, id)).toBe(null);
    }
    expect(container.querySelector(".help-icon")).toBe(null);
    // Остальное на месте.
    expect(queryByTestId(container, "toolbar-rectangle")).not.toBe(null);
    expect(queryByTestId(container, "toolbar-freedraw")).not.toBe(null);
  });

  it("хоткеи спрятанных инструментов ничего не включают", async () => {
    await render(
      <Excalidraw UIOptions={{ tools: HIDDEN }} handleKeyboardGlobally />,
    );
    for (const key of [KEYS.D, "3", KEYS.L, "6", KEYS.F]) {
      Keyboard.keyPress(key);
      expect(window.h.state.activeTool.type).toBe("selection");
    }
    Keyboard.keyPress(KEYS.Q);
    expect(window.h.state.activeTool.locked).toBe(false);
    Keyboard.keyPress(KEYS.QUESTION_MARK);
    expect(window.h.state.openDialog).toBe(null);
  });

  it("лазер по-прежнему включается хоткеем K", async () => {
    await render(
      <Excalidraw UIOptions={{ tools: HIDDEN }} handleKeyboardGlobally />,
    );
    Keyboard.keyPress(KEYS.K);
    expect(window.h.state.activeTool.type).toBe("laser");
  });

  it("без UIOptions всё как в апстриме", async () => {
    await render(<Excalidraw handleKeyboardGlobally />);
    Keyboard.keyPress(KEYS.D);
    expect(window.h.state.activeTool.type).toBe("diamond");
  });
});
