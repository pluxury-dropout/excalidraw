// tutorgo: миниатюры картинок на доске (спека TutorGo 2026-10-30-board-image-thumbs §4.3):
// подмена версии файла без мигания, тайлы, LOD-копия, кроп по миниатюре.
import React from "react";
import rough from "roughjs/bin/rough";

import { getDefaultAppState } from "../appState";
import { Excalidraw } from "../index";
import { renderElement } from "../renderer/renderElement";
import {
  __tutorgoTilesForTests as T,
  lodImage,
  tileKey,
} from "../renderer/tutorgoTiles";

import { actionToggleCropEditor } from "../actions/actionCropEditor";
import { actionCopyAsPng, actionCopyAsSvg } from "../actions/actionClipboard";
import { copyToClipboard, createPasteEvent } from "../clipboard";
import { KEYS } from "../keys";

import { API } from "./helpers/api";
import { Keyboard, Pointer } from "./helpers/ui";
import {
  act,
  fireEvent,
  GlobalTestState,
  render,
  unmountComponent,
  waitFor,
} from "./test-utils";

import type {
  BinaryFileData,
  DataURL,
  ExcalidrawImperativeAPI,
  NormalizedZoomValue,
  StaticCanvasAppState,
} from "../types";
import type { FileId, NonDeletedExcalidrawElement } from "../element/types";

// Буфер обмена: ClipboardItem хранит значения как есть (в т.ч. промис блоба);
// write ждёт их, как браузер, — отклонённый промис = запись не удалась.
const clip = vi.hoisted(() => {
  const written: unknown[] = [];
  const clipboard = {
    write: vi.fn(async (items: { items: Record<string, unknown> }[]) => {
      for (const item of items) {
        for (const v of Object.values(item.items)) {
          written.push(await v);
        }
      }
    }),
    writeText: vi.fn(async (_text: string) => {}),
  };
  Object.defineProperty(navigator, "clipboard", {
    configurable: true,
    value: clipboard,
  });
  (window as any).ClipboardItem = class {
    constructor(public items: Record<string, unknown>) {}
  };
  return { clipboard, written };
});

// Экспорт: запоминаем, с какими files рисовали (полные или миниатюры).
const exp = vi.hoisted(() => ({
  canvasFiles: [] as any[],
  svgFiles: [] as any[],
}));
vi.mock("../scene/export", async (orig) => {
  const actual = await orig<typeof import("../scene/export")>();
  return {
    ...actual,
    exportToCanvas: async (_els: unknown, _st: unknown, files: any) => {
      exp.canvasFiles.push(files);
      return document.createElement("canvas");
    },
    exportToSvg: async (_els: unknown, _st: unknown, files: any) => {
      exp.svgFiles.push(files);
      const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
      svg.setAttribute("data-u", files?.A?.dataURL ?? "");
      return svg;
    },
  };
});

// Раскодирование под контролем теста: каждый вызов ждёт resolve/reject вручную.
const decodes = vi.hoisted(
  () =>
    [] as {
      url: string;
      resolve: (img: HTMLImageElement) => void;
      reject: (e: unknown) => void;
    }[],
);
vi.mock("../element/image", async (orig) => {
  const actual = await orig<typeof import("../element/image")>();
  return {
    ...actual,
    loadHTMLImageElement: (url: string) =>
      new Promise<HTMLImageElement>((resolve, reject) => {
        decodes.push({ url, resolve, reject });
      }),
  };
});

const imgOf = (w: number, h: number) => {
  const img = new Image();
  Object.defineProperty(img, "naturalWidth", { value: w });
  Object.defineProperty(img, "naturalHeight", { value: h });
  return img;
};

const A = "A" as FileId;
const fileOf = (dataURL: string, thumb = false): BinaryFileData => ({
  id: A,
  mimeType: "image/jpeg",
  dataURL: dataURL as DataURL,
  created: 1,
  tutorgoUrl: "https://x/public/board-assets/a.jpg",
  ...(thumb ? { tutorgoThumb: true as const } : {}),
});

const flush = () => act(() => new Promise((r) => setTimeout(r, 0)));

describe("tutorgo: подмена версии файла", () => {
  let api: ExcalidrawImperativeAPI;
  let thumbImg: HTMLImageElement;
  let el: NonDeletedExcalidrawElement;

  beforeEach(async () => {
    unmountComponent();
    decodes.length = 0;
    T.setEnabled(true);
    await render(<Excalidraw excalidrawAPI={(a) => (api = a)} />);
    el = API.createElement({
      type: "image",
      x: 0,
      y: 0,
      width: 200,
      height: 100,
      fileId: A,
      status: "saved",
    });
    API.setElements([el]);
    thumbImg = imgOf(256, 128);
    const app = window.h.app;
    app.files = { [A]: fileOf("data:thumb", true) };
    app.imageCache.set(A, { image: thumbImg, mimeType: "image/jpeg" });
  });
  afterEach(() => T.setEnabled(false));

  it("во время раскодирования в кэше старая", async () => {
    const done = api.tutorgoReplaceFiles([fileOf("data:full")]);
    await flush();
    expect(decodes.map((d) => d.url)).toEqual(["data:full"]);
    const app = window.h.app;
    expect(app.imageCache.get(A)!.image).toBe(thumbImg);
    expect(app.files[A].dataURL).toBe("data:thumb");

    const full = imgOf(2000, 1000);
    decodes[0].resolve(full);
    expect(await done).toEqual([]);
    expect(app.imageCache.get(A)!.image).toBe(full);
    expect(app.files[A].dataURL).toBe("data:full");
    expect(app.files[A].tutorgoThumb).toBeUndefined();
  });

  it("подмена инвалидирует тайлы картинки на всех уровнях", async () => {
    window.h.app.scene.getTutorgoIndex(); // индекс сцены → учёт тайлов
    const baked = (level: number, tx: number, ty: number) => {
      const t = T.store.tile(level, tx, ty);
      t.canvas = document.createElement("canvas");
      t.contentSeq = t.invalidSeq = T.store.seq;
      return t;
    };
    const mine = [baked(0, 0, 0), baked(2, 0, 0), baked(2, 1, 0)];
    const other = baked(0, 10, 10);
    const otherSeq = other.invalidSeq;
    const lod = lodImage(A, imgOf(2000, 1000))!;
    expect(T.lods.has(A)).toBe(true);

    const done = api.tutorgoReplaceFiles([fileOf("data:full")]);
    await flush();
    decodes[0].resolve(imgOf(2000, 1000));
    await done;

    for (const t of mine) {
      expect(t.invalidSeq).toBeGreaterThan(t.contentSeq);
    }
    expect(other.invalidSeq).toBe(otherSeq);
    expect(T.lods.has(A)).toBe(false);
    expect(lod.width).toBe(0); // память холста копии отдана
    expect(T.store.tiles.get(tileKey(0, 0, 0))).toBe(mine[0]);
  });

  it("двойная подмена: побеждает последняя", async () => {
    const first = api.tutorgoReplaceFiles([fileOf("data:v1")]);
    const second = api.tutorgoReplaceFiles([fileOf("data:v2")]);
    await flush();
    expect(decodes.map((d) => d.url)).toEqual(["data:v1", "data:v2"]);
    const v2 = imgOf(2000, 1000);
    decodes[1].resolve(v2);
    await second;
    decodes[0].resolve(imgOf(2000, 1000)); // первая раскодировалась позже
    await first;
    const app = window.h.app;
    expect(app.imageCache.get(A)!.image).toBe(v2);
    expect(app.files[A].dataURL).toBe("data:v2");
  });

  it("упавший декод — старая версия и id в ответе", async () => {
    const done = api.tutorgoReplaceFiles([fileOf("data:broken")]);
    await flush();
    decodes[0].reject(new Error("decode"));
    expect(await done).toEqual([A]);
    const app = window.h.app;
    expect(app.imageCache.get(A)!.image).toBe(thumbImg);
    expect(app.files[A].dataURL).toBe("data:thumb");
  });

  it("неизвестный id — добавляется, как addFiles", async () => {
    const B = "B" as FileId;
    const done = api.tutorgoReplaceFiles([
      { ...fileOf("data:b"), id: B, tutorgoThumb: true },
    ]);
    expect(window.h.app.files[B].dataURL).toBe("data:b");
    expect(await done).toEqual([]);
  });
});

describe("tutorgo: миниатюра в кэше", () => {
  it("lodImage по миниатюре не строит копию", () => {
    T.lods.clear();
    expect(lodImage("t1", imgOf(256, 180))).toBe(null);
    expect(lodImage("t2", imgOf(200, 100))).toBe(null);
    expect(T.lods.size).toBe(0);
  });

  it("кроп по миниатюре рисует тот же кусок", () => {
    const el = {
      ...API.createElement({
        type: "image",
        x: 0,
        y: 0,
        width: 400,
        height: 300,
        fileId: A,
        status: "saved",
      }),
      crop: {
        x: 100,
        y: 50,
        width: 400,
        height: 300,
        naturalWidth: 1000,
        naturalHeight: 800,
      },
    } as NonDeletedExcalidrawElement;
    const map = new Map([[el.id, el]]) as any;
    const sourceRect = (img: HTMLImageElement) => {
      const canvas = document.createElement("canvas");
      const ctx = canvas.getContext("2d")!;
      const draw = vi.spyOn(ctx, "drawImage");
      renderElement(
        el,
        map,
        map,
        rough.canvas(canvas),
        ctx,
        {
          imageCache: new Map([[A, { image: img, mimeType: "image/jpeg" }]]),
          isExporting: true,
          renderGrid: false,
          canvasBackgroundColor: "#ffffff",
          embedsValidationStatus: new Map(),
          elementsPendingErasure: new Set(),
          pendingFlowchartNodes: null,
        },
        getDefaultAppState() as unknown as StaticCanvasAppState,
      );
      const call = draw.mock.calls.find((c) => c[0] === img)!;
      return call.slice(1, 5);
    };
    // 256/1000 по x, 205/800 по y: миниатюра 1000×800 со стороной 256
    const thumb = sourceRect(imgOf(256, 205));
    [25.6, 12.8125, 102.4, 76.875].forEach((v, i) =>
      expect(thumb[i]).toBeCloseTo(v, 6),
    );
    expect(sourceRect(imgOf(1000, 800))).toEqual([100, 50, 400, 300]);
  });
});

// tutorgo: §4.2 «Обрезка» — кроп в пикселях оригинала, по миниатюре нельзя.
describe("tutorgo: обрезка по миниатюре не стартует", () => {
  const mouse = new Pointer("mouse");
  let ensure: ReturnType<typeof vi.fn>;
  let img: NonDeletedExcalidrawElement;

  const setup = async (thumb: boolean) => {
    unmountComponent();
    mouse.reset();
    ensure = vi.fn(() => Promise.resolve());
    Object.assign(document, { elementFromPoint: () => GlobalTestState.canvas });
    await render(
      <Excalidraw
        autoFocus={true}
        handleKeyboardGlobally={true}
        tutorgoEnsureFullFiles={ensure}
      />,
    );
    API.setAppState({ zoom: { value: 1 as NormalizedZoomValue } });
    img = API.createElement({
      type: "image",
      width: 200,
      height: 100,
      fileId: A,
      status: "saved",
    });
    API.setElements([img]);
    API.setAppState({ selectedElementIds: { [img.id]: true } });
    window.h.app.files = { [A]: fileOf("data:x", thumb) };
  };

  const entries: [string, () => void][] = [
    ["двойной клик", () => mouse.doubleClickOn(img)],
    ["Enter", () => Keyboard.keyDown(KEYS.ENTER)],
    ["actionToggleCropEditor", () => API.executeAction(actionToggleCropEditor)],
  ];

  it.each(entries)(
    "%s: по миниатюре — нет и просит полную, по полной — да",
    async (_name, enter) => {
      await setup(true);
      enter();
      expect(window.h.state.croppingElementId).toBe(null);
      expect(ensure).toHaveBeenCalledWith([A]);

      await setup(false);
      enter();
      expect(window.h.state.croppingElementId).toBe(img.id);
      expect(ensure).not.toHaveBeenCalled();
    },
  );

  it("undo не возвращает обрезку на картинку с миниатюрой", async () => {
    await setup(false);
    mouse.doubleClickOn(img);
    expect(window.h.state.croppingElementId).toBe(img.id);
    Keyboard.keyDown(KEYS.ESCAPE);
    expect(window.h.state.croppingElementId).toBe(null);

    // хост подменил полную миниатюрой; undo вернул бы режим обрезки по ней
    window.h.app.files = { [A]: fileOf("data:x", true) };
    Keyboard.undo();
    expect(window.h.state.croppingElementId).toBe(null);
    expect(ensure).toHaveBeenCalledWith([A]);
  });
});

// tutorgo: §4.4 — экспорт и копирование рисуют только полные версии.
describe("tutorgo: экспорт ждёт полные", () => {
  const B = "B" as FileId;
  let ensure: ReturnType<typeof vi.fn>;
  let settle: { resolve: () => void; reject: (e: unknown) => void }[];
  let elA: NonDeletedExcalidrawElement;
  let elB: NonDeletedExcalidrawElement;

  const full = () => ({
    [A]: fileOf("data:full"),
    [B]: { ...fileOf("data:fullB"), id: B },
  });

  beforeEach(async () => {
    unmountComponent();
    decodes.length = 0;
    exp.canvasFiles.length = 0;
    exp.svgFiles.length = 0;
    clip.written.length = 0;
    clip.clipboard.write.mockClear();
    clip.clipboard.writeText.mockClear();
    settle = [];
    ensure = vi.fn(
      () =>
        new Promise<void>((resolve, reject) =>
          settle.push({ resolve, reject }),
        ),
    );
    // autoFocus: вставка из буфера работает, только когда фокус в редакторе
    await render(
      <Excalidraw autoFocus={true} tutorgoEnsureFullFiles={ensure} />,
    );
    elA = API.createElement({
      type: "image",
      x: 0,
      y: 0,
      width: 200,
      height: 100,
      fileId: A,
      status: "saved",
    });
    elB = API.createElement({
      type: "image",
      x: 300,
      y: 0,
      width: 200,
      height: 100,
      fileId: B,
      status: "saved",
    });
    API.setElements([elA, elB]);
    window.h.app.files = {
      [A]: fileOf("data:thumb", true),
      [B]: { ...fileOf("data:thumbB", true), id: B },
    };
  });

  /** как tutorgoReplaceFiles у хоста: новый объект files, перерисовка, резолв */
  const swapToFullAndResolve = () =>
    act(async () => {
      window.h.app.files = full();
      window.h.app.scene.triggerUpdate();
      settle[settle.length - 1].resolve();
    });

  it("Копировать как PNG: clipboard.write синхронно, до ensure; рисует полные", async () => {
    API.executeAction(actionCopyAsPng);
    expect(ensure).toHaveBeenCalledWith([A, B]);
    // ClipboardItem с промисом создан в том же тике — Safari не теряет жест
    expect(clip.clipboard.write).toHaveBeenCalledTimes(1);
    expect(exp.canvasFiles).toEqual([]);

    await swapToFullAndResolve();
    await waitFor(() => expect(clip.written).toHaveLength(1));
    expect(exp.canvasFiles).toHaveLength(1);
    expect(exp.canvasFiles[0][A].dataURL).toBe("data:full");
    expect(exp.canvasFiles[0][B].dataURL).toBe("data:fullB");
    expect(window.h.state.errorMessage).toBe(null);
  });

  it("Копировать как PNG: действия за время загрузки не откатываются", async () => {
    API.executeAction(actionCopyAsPng);
    API.setAppState({ scrollX: 777, selectedElementIds: { [elA.id]: true } });
    await swapToFullAndResolve();
    await waitFor(() => expect(window.h.state.toast).not.toBe(null));
    expect(window.h.state.scrollX).toBe(777);
    expect(window.h.state.selectedElementIds).toEqual({ [elA.id]: true });
  });

  it("Копировать как PNG: ensure отклонён — ошибка, PNG не записан", async () => {
    API.executeAction(actionCopyAsPng);
    await act(async () => settle[0].reject(new Error("нет сети")));
    await waitFor(() => expect(window.h.state.errorMessage).toBeTruthy());
    expect(clip.written).toEqual([]);
    expect(exp.canvasFiles).toEqual([]);
  });

  it("Копировать как SVG: собран из files после резолва", async () => {
    API.executeAction(actionCopyAsSvg);
    expect(ensure).toHaveBeenCalledWith([A, B]);
    expect(exp.svgFiles).toEqual([]);

    await swapToFullAndResolve();
    await waitFor(() =>
      expect(clip.clipboard.writeText).toHaveBeenCalledTimes(1),
    );
    expect(exp.svgFiles[0][A].dataURL).toBe("data:full");
    expect(clip.clipboard.writeText.mock.calls[0][0]).toContain(
      'data-u="data:full"',
    );
  });

  it("без пропа — как апстрим: files сразу, ensure не нужен", async () => {
    unmountComponent();
    await render(<Excalidraw />);
    API.setElements([elA]);
    window.h.app.files = { [A]: fileOf("data:thumb", true) };
    API.executeAction(actionCopyAsSvg);
    await waitFor(() => expect(exp.svgFiles).toHaveLength(1));
    expect(exp.svgFiles[0][A].dataURL).toBe("data:thumb");
  });

  it("диалог экспорта: ждёт полные, кнопки выключены, превью после резолва", async () => {
    const width = vi
      .spyOn(HTMLElement.prototype, "offsetWidth", "get")
      .mockReturnValue(300);
    try {
      API.setAppState({
        selectedElementIds: { [elB.id]: true },
        openDialog: { name: "imageExport" },
      });
      // выделение есть → «только выделенное» включено → ждём только B
      await waitFor(() => expect(ensure).toHaveBeenCalledWith([B]));
      const buttons = () =>
        Array.from(
          document.querySelectorAll<HTMLButtonElement>(
            ".ImageExportModal__settings__buttons button",
          ),
        );
      expect(buttons().length).toBeGreaterThan(0);
      expect(buttons().every((b) => b.disabled)).toBe(true);
      expect(exp.canvasFiles).toEqual([]);

      await swapToFullAndResolve();
      await waitFor(() => expect(exp.canvasFiles.length).toBeGreaterThan(0));
      expect(exp.canvasFiles.every((f) => f[B].dataURL === "data:fullB")).toBe(
        true,
      );
      expect(buttons().some((b) => b.disabled)).toBe(false);

      // «только выделенное» выкл → в экспорт попала вся сцена → новый набор
      const ensured = ensure.mock.calls.length;
      fireEvent.click(
        document.querySelector<HTMLElement>(
          'input[name="exportOnlySelected"]',
        )!,
      );
      await waitFor(() =>
        expect(ensure.mock.calls.length).toBeGreaterThan(ensured),
      );
      expect(ensure).toHaveBeenLastCalledWith([A, B]);
      expect(buttons().every((b) => b.disabled)).toBe(true);
    } finally {
      width.mockRestore();
    }
  });

  it("маркеры едут через буфер", async () => {
    await copyToClipboard([elA], window.h.app.files);
    const text = clip.clipboard.writeText.mock.calls.at(-1)![0];
    API.setElements([]);
    window.h.app.files = {};
    Object.assign(document, { elementFromPoint: () => GlobalTestState.canvas });
    document.dispatchEvent(createPasteEvent({ types: { "text/plain": text } }));
    await waitFor(() => expect(window.h.app.files[A]).toBeDefined());
    expect(window.h.app.files[A].tutorgoUrl).toBe(
      "https://x/public/board-assets/a.jpg",
    );
    expect(window.h.app.files[A].tutorgoThumb).toBe(true);
  });
});
