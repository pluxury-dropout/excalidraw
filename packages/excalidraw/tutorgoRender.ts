// tutorgo: страница рендера archiver'а (спека TutorGo 2026-10-30-board-lesson-archive §7,
// план 2026-10-30-board-archive-B-archiver Task 2). Отдельный бандл: кладёт
// window.tutorgoRender = { bounds, render }; данные задачи — GET с локального сервера
// archiver'а (archiver/server.go), результаты — POST туда же.
//
// Вход — только кандидаты архива (спека §3): надгробий, формул и «всегда живых»
// (рамки и элементы в рамках, iframe-like, со ссылкой, стрелки с подписью) тут нет —
// их отсекает отбор в Go, поэтому клип рамкой и DOM не нужны: хватает paintTile.
import rough from "roughjs/bin/rough";

import { getDefaultAppState } from "./appState";
import { THEME } from "./constants";
import { getElementBounds } from "./element/bounds";
import { Fonts } from "./fonts";
import { getCanvasPadding } from "./renderer/renderElement";
import { paintTile, tileElementsOf, tileKey } from "./renderer/tutorgoTiles";
import { TILE_PX } from "./tutorgo";

import type { Bounds } from "./scene/tutorgoIndex";
import type { StaticSceneRenderConfig } from "./scene/types";
import type { AppClassProperties, StaticCanvasAppState } from "./types";
import type {
  ExcalidrawElement,
  NonDeletedExcalidrawElement,
} from "./element/types";

type Rect = [string, number, number, number, number];

/** Живые элементы с границами; на ком getElementBounds бросил — пропускаем. */
const boundsOf = (elements: readonly ExcalidrawElement[]) => {
  const live = elements.filter(
    (el) => !el.isDeleted,
  ) as NonDeletedExcalidrawElement[];
  const map = new Map(live.map((el) => [el.id, el])) as any;
  const out: [NonDeletedExcalidrawElement, Bounds][] = [];
  for (const el of live) {
    try {
      out.push([el, getElementBounds(el, map)]);
    } catch (error) {
      console.warn("tutorgoRender: bounds", el.id, error);
    }
  }
  return out;
};

/** Рамки элементов с запасом getCanvasPadding — то, что тайлы считают «касается». */
export const elementRects = (elements: readonly ExcalidrawElement[]): Rect[] =>
  boundsOf(elements).map(([el, [x1, y1, x2, y2]]) => {
    const p = getCanvasPadding(el);
    return [el.id, x1 - p, y1 - p, x2 + p, y2 + p];
  });

export type PyramidStep = {
  level: number;
  key: string;
  children: { key: string; dx: 0 | 1; dy: 0 | 1 }[];
};

const parseKey = (key: string) => {
  const [level, tx, ty] = key.split(":").map(Number);
  return { level, tx, ty };
};

/**
 * Шаги сборки грубых уровней от maxLevel−1 до minLevel: родители набора уровня
 * ниже. Уровни ниже prevMin в опубликованном манифесте не было — их строим на всю
 * доску: к детям уровня prevMin добавляется prevBottom (все его тайлы).
 * children — только новые дети; остальные четверти рендер берёт из Prev.
 */
export const planPyramid = (
  tiles: string[],
  maxLevel: number,
  minLevel: number,
  prevMin: number | null,
  prevBottom: string[],
): PyramidStep[] => {
  const steps: PyramidStep[] = [];
  let current = new Set(tiles);
  for (let level = maxLevel - 1; level >= minLevel; level--) {
    if (prevMin !== null && level === prevMin - 1) {
      for (const k of prevBottom) {
        current.add(k);
      }
    }
    const parents = new Map<string, PyramidStep>();
    for (const childKey of current) {
      const c = parseKey(childKey);
      const tx = Math.floor(c.tx / 2);
      const ty = Math.floor(c.ty / 2);
      const key = tileKey(level, tx, ty);
      let step = parents.get(key);
      if (!step) {
        parents.set(key, (step = { level, key, children: [] }));
      }
      step.children.push({
        key: childKey,
        dx: (c.tx - 2 * tx) as 0 | 1,
        dy: (c.ty - 2 * ty) as 0 | 1,
      });
    }
    const byPos = (a: string, b: string) => {
      const p = parseKey(a);
      const q = parseKey(b);
      return p.ty - q.ty || p.tx - q.tx;
    };
    const row = [...parents.values()].sort((a, b) => byPos(a.key, b.key));
    row.forEach((s) => s.children.sort((a, b) => byPos(a.key, b.key)));
    steps.push(...row);
    current = new Set(parents.keys());
  }
  return steps;
};

// ─── страница ────────────────────────────────────────────────────────────────

/** POST по снятой задаче: сервер уже забыл её (404) — работу прекращаем, не ретраим. */
class JobRemoved extends Error {}

/** null — 404 (нет); иной не-2xx — ошибка задачи. */
const get = async (url: string) => {
  const res = await fetch(url);
  if (res.status === 404) {
    return null;
  }
  if (!res.ok) {
    throw new Error(`GET ${url}: ${res.status}`);
  }
  return res;
};

const post = async (url: string, body: BodyInit) => {
  const res = await fetch(url, { method: "POST", body });
  if (res.status === 404) {
    throw new JobRemoved(`POST ${url}: задача снята`);
  }
  if (!res.ok) {
    throw new Error(`POST ${url}: ${res.status}`);
  }
};

const bounds = async (job: string): Promise<void> => {
  const scene = await get(`${job}scene`);
  if (!scene) {
    throw new JobRemoved(`GET ${job}scene: задача снята`);
  }
  const { elements } = await scene.json();
  await post(`${job}bounds`, JSON.stringify(elementRects(elements)));
};

type RenderScene = {
  maxLevel: number;
  minLevel: number;
  tilePx: number;
  quality: number;
  tiles: string[];
  prevMin: number | null;
  prevBottom: string[];
  elements: ExcalidrawElement[];
  files: Record<string, { mimeType: string }>;
};

type ImageCache = AppClassProperties["imageCache"];

/** Картинки задачи; 404 и битые байты — не кладём: renderElement нарисует как отсутствующую. */
const loadImages = async (job: string, files: RenderScene["files"]) => {
  const cache: ImageCache = new Map();
  await Promise.all(
    Object.entries(files).map(async ([fileId, { mimeType }]) => {
      const res = await get(`${job}file/${encodeURIComponent(fileId)}`);
      if (!res) {
        return;
      }
      const url = URL.createObjectURL(await res.blob());
      const image = new Image();
      image.src = url;
      try {
        await image.decode();
        cache.set(fileId as any, { image, mimeType: mimeType as any });
      } catch (error) {
        console.warn("tutorgoRender: decode", fileId, error);
      } finally {
        URL.revokeObjectURL(url);
      }
    }),
  );
  return cache;
};

const webp = (canvas: HTMLCanvasElement, quality: number) =>
  new Promise<Blob>((resolve, reject) =>
    canvas.toBlob(
      (blob) =>
        // без поддержки WebP toBlob молча отдаёт PNG — такой тайл не нужен
        blob?.type === "image/webp"
          ? resolve(blob)
          : reject(new Error(`toBlob: ${blob?.type ?? "null"}`)),
      "image/webp",
      quality,
    ),
  );

const outPath = (job: string, key: string) => {
  const { level, tx, ty } = parseKey(key);
  return `${job}out/${level}/${tx}_${ty}`;
};

const render = async (
  job: string,
): Promise<{ empty: string[]; fonts: string[] }> => {
  const res = await get(`${job}scene`);
  if (!res) {
    throw new JobRemoved(`GET ${job}scene: задача снята`);
  }
  const s: RenderScene = await res.json();
  if (s.tilePx !== TILE_PX) {
    throw new Error(`tilePx ${s.tilePx} != ${TILE_PX}`); // сетка тайлов — из форка
  }
  const half = s.tilePx / 2;

  const withBounds = boundsOf(s.elements);
  const elements = withBounds.map(([el]) => el);
  const rects = new Map(withBounds.map(([el, b]) => [el.id, b]));
  const pads = new Map(elements.map((el) => [el.id, getCanvasPadding(el)]));
  const map = new Map(elements.map((el) => [el.id, el])) as any;

  await Fonts.loadElementsFonts(elements);
  await document.fonts.ready;
  const imageCache = await loadImages(job, s.files);

  const canvas = document.createElement("canvas");
  const defaults = getDefaultAppState();
  const appState = {
    ...defaults,
    theme: THEME.LIGHT,
    width: s.tilePx,
    height: s.tilePx,
    offsetLeft: 0,
    offsetTop: 0,
  } as unknown as StaticCanvasAppState;
  const config: StaticSceneRenderConfig = {
    canvas,
    rc: rough.canvas(canvas),
    elementsMap: map,
    allElementsMap: map,
    visibleElements: elements,
    scale: 1,
    appState,
    renderConfig: {
      canvasBackgroundColor: defaults.viewBackgroundColor,
      imageCache,
      renderGrid: false,
      isExporting: true,
      embedsValidationStatus: new Map(),
      elementsPendingErasure: new Set(),
      pendingFlowchartNodes: null,
    },
  };

  const empty: string[] = [];
  // уменьшенные вдвое копии тайлов этой задачи для родителя; null — пустой
  const own = new Map<string, ImageBitmap | null>();
  const shrink = (src: CanvasImageSource | Blob) =>
    createImageBitmap(src as ImageBitmapSource, {
      resizeWidth: half,
      resizeHeight: half,
      resizeQuality: "high",
    });

  for (const key of s.tiles) {
    const pos = parseKey(key);
    const picked = tileElementsOf(elements, map, rects, pads, pos);
    if (!picked.length) {
      empty.push(key);
      own.set(key, null);
      continue;
    }
    const tile = document.createElement("canvas");
    tile.width = tile.height = s.tilePx;
    paintTile(tile.getContext("2d")!, rough.canvas(tile), config, pos, picked);
    await post(outPath(job, key), await webp(tile, s.quality));
    own.set(key, s.minLevel < s.maxLevel ? await shrink(tile) : null);
    tile.width = 0; // сразу вернуть память холста
  }

  for (const step of planPyramid(
    s.tiles,
    s.maxLevel,
    s.minLevel,
    s.prevMin,
    s.prevBottom,
  )) {
    const { level, tx, ty } = parseKey(step.key);
    const quads: [ImageBitmap, number, number][] = [];
    for (const [dx, dy] of [
      [0, 0],
      [1, 0],
      [0, 1],
      [1, 1],
    ]) {
      const key = tileKey(level + 1, 2 * tx + dx, 2 * ty + dy);
      let bmp: ImageBitmap | null | undefined = own.get(key);
      own.delete(key); // у ребёнка один родитель
      // уровней ниже prevMin в опубликованном манифесте нет — не спрашиваем
      if (bmp === undefined && s.prevMin !== null && level + 1 >= s.prevMin) {
        const prev = await get(
          `${job}prev/${level + 1}/${tx * 2 + dx}_${ty * 2 + dy}`,
        );
        bmp = prev ? await shrink(await prev.blob()) : null;
      }
      if (bmp) {
        quads.push([bmp, dx * half, dy * half]);
      }
    }
    if (!quads.length) {
      empty.push(step.key);
      own.set(step.key, null);
      continue;
    }
    const tile = document.createElement("canvas");
    tile.width = tile.height = s.tilePx;
    const ctx = tile.getContext("2d")!;
    for (const [bmp, x, y] of quads) {
      ctx.drawImage(bmp, x, y);
      bmp.close();
    }
    await post(outPath(job, step.key), await webp(tile, s.quality));
    own.set(step.key, level > s.minLevel ? await shrink(tile) : null);
    tile.width = 0;
  }

  const fonts = new Set<string>();
  document.fonts.forEach((f) => f.status === "loaded" && fonts.add(f.family));
  return { empty, fonts: [...fonts] };
};

declare global {
  interface Window {
    tutorgoRender?: { bounds: typeof bounds; render: typeof render };
  }
}

if (typeof window !== "undefined") {
  window.tutorgoRender = { bounds, render };
}
