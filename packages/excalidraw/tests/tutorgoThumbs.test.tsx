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

import { API } from "./helpers/api";
import { act, render, unmountComponent } from "./test-utils";

import type {
  BinaryFileData,
  DataURL,
  ExcalidrawImperativeAPI,
  StaticCanvasAppState,
} from "../types";
import type { FileId, NonDeletedExcalidrawElement } from "../element/types";

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
