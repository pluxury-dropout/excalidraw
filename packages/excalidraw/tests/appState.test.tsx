import React from "react";
import { fireEvent, queryByTestId, render, waitFor } from "./test-utils";
import { Excalidraw } from "../index";
import { API } from "./helpers/api";
import { getDefaultAppState } from "../appState";
import { EXPORT_DATA_TYPES, MIME_TYPES } from "../constants";
import { Pointer, UI } from "./helpers/ui";
import type { ExcalidrawTextElement } from "../element/types";

const { h } = window;

describe("appState", () => {
  it("drag&drop file doesn't reset non-persisted appState", async () => {
    const defaultAppState = getDefaultAppState();
    const exportBackground = !defaultAppState.exportBackground;

    await render(
      <Excalidraw
        initialData={{
          appState: {
            exportBackground,
            viewBackgroundColor: "#F00",
          },
        }}
      />,
      {},
    );

    await waitFor(() => {
      expect(h.state.exportBackground).toBe(exportBackground);
      expect(h.state.viewBackgroundColor).toBe("#F00");
    });

    await API.drop(
      new Blob(
        [
          JSON.stringify({
            type: EXPORT_DATA_TYPES.excalidraw,
            appState: {
              viewBackgroundColor: "#000",
            },
            elements: [API.createElement({ type: "rectangle", id: "A" })],
          }),
        ],
        { type: MIME_TYPES.json },
      ),
    );

    await waitFor(() => {
      expect(h.elements).toEqual([expect.objectContaining({ id: "A" })]);
      // non-imported prop → retain
      expect(h.state.exportBackground).toBe(exportBackground);
      // imported prop → overwrite
      expect(h.state.viewBackgroundColor).toBe("#000");
    });
  });

  it("changing fontSize with text tool selected (no element created yet)", async () => {
    const { container } = await render(
      <Excalidraw
        initialData={{
          appState: {
            currentItemFontSize: 30,
          },
        }}
      />,
    );

    UI.clickTool("text");

    expect(h.state.currentItemFontSize).toBe(30);

    // tutorgo: числовое поле вместо пресетов S/M/L/XL. Значение применяется по
    // blur, а не на каждый keystroke.
    const input = queryByTestId(container, "fontSize-input") as HTMLInputElement;
    fireEvent.change(input, { target: { value: "16" } });
    fireEvent.blur(input);
    expect(h.state.currentItemFontSize).toBe(16);

    // ниже MIN_FONT_SIZE не пускаем
    fireEvent.change(input, { target: { value: "1" } });
    fireEvent.blur(input);
    expect(h.state.currentItemFontSize).toBe(4);

    // мусор в поле откатывается к текущему значению
    fireEvent.change(input, { target: { value: "abc" } });
    fireEvent.blur(input);
    expect(h.state.currentItemFontSize).toBe(4);
    expect(input.value).toBe("4");

    fireEvent.change(input, { target: { value: "16" } });
    fireEvent.blur(input);
    expect(h.state.currentItemFontSize).toBe(16);

    const mouse = new Pointer("mouse");

    mouse.clickAt(100, 100);

    expect((h.elements[0] as ExcalidrawTextElement).fontSize).toBe(16);
  });
});
