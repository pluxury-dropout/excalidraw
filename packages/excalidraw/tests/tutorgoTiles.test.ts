// tutorgo: тайлы статичного слоя (спека TutorGo 2026-10-15-board-tiled-rendering §3.1–3.2).
import rough from "roughjs/bin/rough";

import { getDefaultAppState } from "../appState";
import { THEME } from "../constants";
import { mutateElement } from "../element/mutateElement";
import { syncInvalidIndices } from "../fractionalIndex";
import {
  TileStore,
  __tutorgoTilesForTests as T,
  drawTutorgoTiles,
  levelFor,
  tileKey,
  tileRange,
  tileSceneSize,
  withLod,
} from "../renderer/tutorgoTiles";
import { Renderer } from "../scene/Renderer";
import Scene from "../scene/Scene";
import { TutorgoSpatialIndex } from "../scene/tutorgoIndex";
import { HOT_BULK, HOT_MS, LOD_SIDE, TILE_BUDGET } from "../tutorgo";

import type { StaticSceneRenderConfig } from "../scene/types";
import type { NormalizedZoomValue, StaticCanvasAppState } from "../types";

import { API } from "./helpers/api";

import type { TileRect } from "../renderer/tutorgoTiles";
import type {
  ExcalidrawElement,
  NonDeletedExcalidrawElement,
} from "../element/types";

const mapOf = (els: readonly ExcalidrawElement[]) =>
  new Map(els.map((e) => [e.id, e])) as any;

const rect = (x: number, y: number) =>
  API.createElement({
    type: "rectangle",
    x,
    y,
    width: 100,
    height: 100,
  }) as NonDeletedExcalidrawElement;

/** Сцена + индекс + учёт, подключённые как в приложении; часы — вручную. */
const setup = (els: NonDeletedExcalidrawElement[]) => {
  let now = 1000;
  const store = new TileStore(() => now);
  const index = new TutorgoSpatialIndex();
  let nonce = 0;
  let scene = els;
  const sync = (next: NonDeletedExcalidrawElement[] = scene) => {
    // дробные индексы (z-порядок) — как у элементов настоящей сцены
    scene = syncInvalidIndices(next) as NonDeletedExcalidrawElement[];
    TutorgoSpatialIndex.onSync = (i, c, m) => store.onIndexSync(i, c, m);
    index.sync(scene, mapOf(scene), ++nonce);
    TutorgoSpatialIndex.onSync = null;
  };
  /** Тайл уровня 0 «нарисован» на текущем seq. */
  const paint = (tx: number, ty: number) => {
    const t = store.tile(0, tx, ty);
    t.canvas = document.createElement("canvas");
    t.contentSeq = store.seq;
    t.maxIndex = scene.length ? scene[scene.length - 1].index : null;
    return t;
  };
  const advance = (ms: number) => {
    now += ms;
  };
  sync();
  return { store, index, sync, paint, advance };
};

const screen: TileRect = { level: 0, tx1: -2, ty1: -2, tx2: 2, ty2: 2 };

describe("tutorgo: тайлы — сетка", () => {
  it("levelFor: только уменьшение при выводе на экран", () => {
    expect(levelFor(1, 2)).toBe(1);
    expect(levelFor(1, 1)).toBe(0);
    expect(levelFor(0.3, 2)).toBe(0);
    expect(levelFor(0.01, 2)).toBe(-5);
    for (const dpr of [1, 1.25, 2, 3]) {
      for (let i = 0; i < 100; i++) {
        const zoom = 0.01 + (i / 100) * 30;
        const k = (zoom * dpr) / 2 ** levelFor(zoom, dpr);
        expect(k).toBeGreaterThan(0.5);
        expect(k).toBeLessThanOrEqual(1 + 1e-9);
      }
    }
  });

  it("tileRange: floor, отрицательные индексы", () => {
    expect(tileSceneSize(0)).toBe(512);
    expect(tileSceneSize(-1)).toBe(1024);
    expect(tileRange(0, [0, 0, 513, 10])).toEqual({
      level: 0,
      tx1: 0,
      ty1: 0,
      tx2: 1,
      ty2: 0,
    });
    expect(tileRange(0, [-1, -600, -1, -1])).toMatchObject({
      tx1: -1,
      ty1: -2,
      tx2: -1,
      ty2: -1,
    });
  });
});

describe("tutorgo: тайлы — учёт", () => {
  afterEach(() => {
    TutorgoSpatialIndex.onSync = null;
  });

  it("свежая правка живая HOT_MS, потом — пока тайл экрана старше правки", () => {
    // внутри тайла 0:0 с запасом (getCanvasPadding = 20) — соседи не задеты
    const a = rect(200, 200);
    const b = rect(300, 300);
    const { store, sync, paint, advance } = setup([b]);
    paint(0, 0);
    sync([b, a]);
    expect(store.isLive(a.id, screen)).toBe(true);
    expect(store.isLive(b.id, screen)).toBe(false);

    advance(HOT_MS);
    const cooled = store.tick();
    expect(cooled).toEqual([a.id]);
    expect(store.isHot(a.id)).toBe(false);
    // тайл нарисован до правки — a в нём нет
    expect(store.isLive(a.id, screen)).toBe(true);

    store.bake(a.id, () => false); // не дорисовали — тайл устарел
    expect(store.fresh(store.tiles.get(tileKey(0, 0, 0))!)).toBe(false);
    paint(0, 0); // перерисовали
    expect(store.isLive(a.id, screen)).toBe(false);
    expect(store.hasTimedHot()).toBe(false);
  });

  it("повторная правка горячего элемента не инвалидирует тайлы", () => {
    const a = rect(10, 10);
    const { sync, paint } = setup([a]);
    const t = paint(0, 0);
    mutateElement(a, { x: 20 });
    sync();
    const first = t.invalidSeq;
    expect(first).toBeGreaterThan(t.contentSeq); // запечённый — тайл перерисовать
    mutateElement(a, { x: 30 });
    sync();
    mutateElement(a, { x: 40 });
    sync();
    expect(t.invalidSeq).toBe(first);
  });

  it("удаление инвалидирует тайлы по старым границам", () => {
    const a = rect(10, 10);
    const { store, sync, paint } = setup([a]);
    const t = paint(0, 0);
    const far = paint(5, 5);
    sync([]);
    expect(store.fresh(t)).toBe(false);
    expect(store.fresh(far)).toBe(true);
  });

  it("первая синхронизация — загрузка, не правки", () => {
    const a = rect(10, 10);
    const { store } = setup([a]);
    expect(store.isLive(a.id, screen)).toBe(false);
    expect(store.hasTimedHot()).toBe(false);
  });

  it("HOT_BULK: массовая загрузка — не живьём, тайлы перерисовать", () => {
    const first = rect(10, 10);
    const { store, sync, paint } = setup([first]);
    const t = paint(0, 0);
    const many = Array.from({ length: HOT_BULK + 1 }, (_, i) =>
      rect((i % 50) * 10, Math.floor(i / 50) * 10),
    );
    sync([first, ...many]);
    expect(many.some((el) => store.isLive(el.id, screen))).toBe(false);
    expect(store.fresh(t)).toBe(false);
  });

  it("остывший верхний элемент дорисовывается, нижний — нет", () => {
    const low = rect(10, 10);
    const top = rect(50, 50);
    const { store, sync, paint, advance } = setup([low, top]);
    const t = paint(0, 0);
    mutateElement(top, { x: 60 });
    mutateElement(low, { x: 20 });
    sync();
    advance(HOT_MS);
    store.tick();
    // правки инвалидировали тайл; «перерисовали» без них (горячие исключены)
    t.contentSeq = store.seq;
    t.maxIndex = null;
    expect(store.canAppend(t, low.id)).toBe(true);
    t.maxIndex = top.index;
    expect(store.canAppend(t, low.id)).toBe(false);
    expect(store.canAppend(t, top.id)).toBe(false); // не выше самого себя

    t.maxIndex = low.index;
    let appended = 0;
    store.bake(top.id, () => ++appended > 0);
    expect(appended).toBe(1);
    expect(store.fresh(t)).toBe(true);
    expect(t.maxIndex).toBe(top.index);
  });

  it("перетаскивание больше HOT_BULK элементов — правки, живьём", () => {
    const many = Array.from({ length: HOT_BULK + 1 }, (_, i) =>
      rect((i % 50) * 10, Math.floor(i / 50) * 10),
    );
    const { store, sync } = setup(many);
    for (const el of many) {
      mutateElement(el, { x: el.x + 5 });
    }
    sync();
    expect(many.every((el) => store.isLive(el.id, screen))).toBe(true);
  });

  it("всегда живой после остывания в тайл не дорисовывается", () => {
    const linked = {
      ...rect(10, 10),
      link: "https://example.com",
    } as NonDeletedExcalidrawElement;
    const { store, sync, paint, advance } = setup([linked]);
    const t = paint(0, 0);
    const moved = { ...linked, x: 20, version: linked.version + 1 };
    sync([moved as NonDeletedExcalidrawElement]);
    advance(HOT_MS);
    store.tick();
    t.contentSeq = store.seq;
    let appended = 0;
    store.bake(linked.id, () => ++appended > 0);
    expect(appended).toBe(0);
    expect(store.isLive(linked.id, screen)).toBe(true);
  });

  it("остывшая правка вне экрана не копится в учёте", () => {
    const far = rect(100_000, 100_000);
    const { store, sync, advance } = setup([far]);
    store.screen = screen;
    mutateElement(far, { x: 100_010 });
    sync();
    advance(HOT_MS);
    store.tick();
    store.bake(far.id, () => false);
    expect((store as any).recent.size).toBe(0);
  });

  it("картинка без файла живая, с файлом — тайлы по её границам перерисовать", () => {
    const img = API.createElement({
      type: "image",
      x: 10,
      y: 10,
      width: 100,
      height: 100,
    }) as NonDeletedExcalidrawElement;
    const { store, paint, advance } = setup([img]);
    expect([...store.images]).toEqual([img.id]);
    const t = paint(0, 0);
    store.setStateHot(new Set([img.id]));
    expect(store.isLive(img.id, screen)).toBe(true);
    advance(HOT_MS * 10);
    expect(store.tick()).toEqual([]); // держится состоянием, не временем

    store.setStateHot(new Set());
    expect(store.tick()).toEqual([img.id]);
    store.bake(img.id, () => false);
    expect(store.fresh(t)).toBe(false);
  });

  it("новый индекс (другая страница) — кэш сброшен", () => {
    const a = rect(10, 10);
    const { store, paint } = setup([a]);
    paint(0, 0);
    const other = new TutorgoSpatialIndex();
    TutorgoSpatialIndex.onSync = (i, c, m) => store.onIndexSync(i, c, m);
    other.sync([a], mapOf([a]), 1);
    expect(store.tiles.size).toBe(0);
    expect(store.index).toBe(other);
  });

  it("всегда живые: ссылка, рамка, стрелка с подписью", () => {
    const linked = {
      ...rect(10, 10),
      link: "https://example.com",
    } as NonDeletedExcalidrawElement;
    const framed = {
      ...rect(10, 10),
      frameId: "f1",
    } as NonDeletedExcalidrawElement;
    const arrow = API.createElement({
      type: "arrow",
      x: 0,
      y: 0,
      boundElements: [{ type: "text", id: "label" }],
    }) as NonDeletedExcalidrawElement;
    const plain = rect(10, 10);
    const { store, advance } = setup([linked, framed, arrow, plain]);
    advance(HOT_MS);
    store.tick();
    expect(store.isLive(linked.id, screen)).toBe(true);
    expect(store.isLive(framed.id, screen)).toBe(true);
    expect(store.isLive(arrow.id, screen)).toBe(true);
    expect(store.isHot(plain.id)).toBe(false);
  });

  it("LRU: сверх бюджета выгоняет старые, нужные в кадре не трогает", () => {
    const { store } = setup([]);
    for (let i = 0; i < TILE_BUDGET + 5; i++) {
      const t = store.tile(0, i, 0);
      t.canvas = document.createElement("canvas");
      t.lastUsed = i < 10 ? 7 : 1; // первые 10 нужны в кадре 7
    }
    const freed = store.evict(7);
    expect(freed).toHaveLength(5);
    for (let i = 0; i < 10; i++) {
      expect(store.tiles.has(tileKey(0, i, 0))).toBe(true);
    }
  });
});

describe("tutorgo: тайлы — рисование", () => {
  const W = 1000;
  const H = 800;

  /** Кадр статичного слоя, как его строит StaticCanvas: Renderer → drawTutorgoTiles. */
  const frameOf = (
    scene: Scene,
    renderer: Renderer,
    patch: Partial<StaticCanvasAppState> = {},
    isExporting = false,
  ) => {
    const appState = {
      ...getDefaultAppState(),
      width: W,
      height: H,
      offsetLeft: 0,
      offsetTop: 0,
      scrollX: 0,
      scrollY: 0,
      zoom: { value: 1 as NormalizedZoomValue },
      ...patch,
    } as StaticCanvasAppState;
    const { elementsMap, visibleElements } = renderer.getRenderableElements({
      zoom: appState.zoom,
      offsetLeft: 0,
      offsetTop: 0,
      scrollX: appState.scrollX,
      scrollY: appState.scrollY,
      width: W,
      height: H,
      editingTextElement: null,
      newElementId: undefined,
      pendingImageElementId: null,
      sceneNonce: scene.getSceneNonce(),
    });
    const canvas = document.createElement("canvas");
    canvas.width = W;
    canvas.height = H;
    const config: StaticSceneRenderConfig = {
      canvas,
      rc: rough.canvas(canvas),
      elementsMap,
      allElementsMap: scene.getNonDeletedElementsMap(),
      visibleElements,
      scale: 1,
      appState,
      renderConfig: {
        imageCache: new Map(),
        isExporting,
        renderGrid: false,
        canvasBackgroundColor: "#ffffff",
        embedsValidationStatus: new Map(),
        elementsPendingErasure: new Set(),
        pendingFlowchartNodes: null,
      },
    };
    return drawTutorgoTiles(canvas.getContext("2d")!, config, W, H);
  };

  const makeScene = () => {
    const els = Array.from({ length: 50 }, (_, i) =>
      rect((i % 10) * 90, Math.floor(i / 10) * 150),
    );
    const scene = new Scene();
    scene.replaceAllElements(syncInvalidIndices(els));
    return { els, scene, renderer: new Renderer(scene) };
  };

  const screenTiles = () =>
    [0, 1].flatMap((tx) =>
      [0, 1].map((ty) => T.store.tiles.get(tileKey(0, tx, ty))),
    );

  beforeEach(() => T.setEnabled(true));
  afterEach(() => T.setEnabled(false));

  it("без флага — null и ни одного тайла", () => {
    T.setEnabled(false);
    const { scene, renderer } = makeScene();
    expect(frameOf(scene, renderer)).toBe(null);
    expect(T.store.tiles.size).toBe(0);
  });

  it("первый кадр — живых нет, тайлы в очереди; после насоса тайлы экрана свежие", () => {
    const { scene, renderer } = makeScene();
    expect(frameOf(scene, renderer)).toEqual([]);
    expect(T.queueLength()).toBeGreaterThan(0);
    T.work(performance.now() + 1e9);
    expect(T.queueLength()).toBe(0);
    for (const t of screenTiles()) {
      expect(t && T.store.fresh(t)).toBe(true);
    }
  });

  it("правка одного прямоугольника — живой только он", () => {
    const { els, scene, renderer } = makeScene();
    frameOf(scene, renderer);
    T.work(performance.now() + 1e9);
    mutateElement(els[7], { x: els[7].x + 5 }); // информирует сцену — новый nonce
    expect(frameOf(scene, renderer)?.map((el) => el.id)).toEqual([els[7].id]);
  });

  it("картинка: маленькая на тайле — копия LOD_SIDE, крупная и с кропом — полная", () => {
    const img = new Image();
    Object.defineProperty(img, "naturalWidth", { value: 2000 });
    Object.defineProperty(img, "naturalHeight", { value: 1000 });
    const page = (extra: Record<string, unknown> = {}) =>
      ({
        ...API.createElement({
          type: "image",
          x: 0,
          y: 0,
          width: 800,
          height: 400,
        }),
        fileId: "f1",
        status: "saved",
        crop: null,
        ...extra,
      } as unknown as NonDeletedExcalidrawElement);
    const renderConfig = {
      imageCache: new Map([["f1", { image: img, mimeType: "image/jpeg" }]]),
    } as any;
    const source = (cfg: any) => cfg.imageCache.get("f1").image;

    // 800 × 0,25 = 200 px на тайле ≤ LOD_SIDE — копия
    const small = source(withLod(page(), renderConfig, 0.25));
    expect(small).not.toBe(img);
    expect(small.naturalWidth).toBe(LOD_SIDE);
    expect(small.naturalHeight).toBe(LOD_SIDE / 2);
    // та же копия на следующий раз — не пересоздаётся
    expect(source(withLod(page(), renderConfig, 0.125))).toBe(small);
    // 800 × 1 — полная
    expect(source(withLod(page(), renderConfig, 1))).toBe(img);
    // кроп в пикселях исходника — полная
    const cropped = page({
      crop: {
        x: 0,
        y: 0,
        width: 10,
        height: 10,
        naturalWidth: 2000,
        naturalHeight: 1000,
      },
    });
    expect(source(withLod(cropped, renderConfig, 0.25))).toBe(img);
  });

  it("правка во время отрисовки тайла его инвалидирует (заготовка в учёте)", () => {
    const { els, scene, renderer } = makeScene();
    frameOf(scene, renderer);
    // часы идут на 1 мс за вызов: работа начнётся и прервётся после элемента
    let t = 0;
    const spy = vi.spyOn(performance, "now").mockImplementation(() => t++);
    T.work(2);
    spy.mockRestore();
    expect(T.queueLength()).toBeGreaterThan(0);
    const draft = [...T.store.tiles.values()].find((tile) => !tile.canvas);
    expect(draft).toBeDefined();
    const before = draft!.invalidSeq;
    mutateElement(els[0], { isDeleted: true }); // ученик стёр, пока тайл рисуется
    frameOf(scene, renderer);
    expect(draft!.invalidSeq).toBeGreaterThan(before);
  });

  it("пустая новая страница — тайлы прошлой сброшены", () => {
    const { scene, renderer } = makeScene();
    frameOf(scene, renderer);
    T.work(performance.now() + 1e9);
    expect(T.store.tiles.size).toBeGreaterThan(0);
    const empty = new Scene();
    frameOf(empty, new Renderer(empty));
    expect(T.store.tiles.size).toBe(0);
  });

  it("после кадра в тёмной теме насос не дорисовывает старый кадр", () => {
    const { scene, renderer } = makeScene();
    frameOf(scene, renderer);
    frameOf(scene, renderer, { theme: THEME.DARK });
    T.work(performance.now() + 1e9);
    expect([...T.store.tiles.values()].some((tile) => tile.canvas)).toBe(false);
  });

  it("Renderer.destroy (уход с доски) — тайлы освобождены", () => {
    const { scene, renderer } = makeScene();
    frameOf(scene, renderer);
    T.work(performance.now() + 1e9);
    renderer.destroy();
    expect(T.store.tiles.size).toBe(0);
    expect(T.queueLength()).toBe(0);
  });

  it("редактируемый текст и рисуемый элемент — горячие, пока в состоянии", () => {
    const { els, scene, renderer } = makeScene();
    frameOf(scene, renderer);
    T.work(performance.now() + 1e9);
    frameOf(scene, renderer, {
      editingTextElement: els[1] as any,
      newElement: els[2] as any,
    });
    expect(T.store.isHot(els[1].id)).toBe(true);
    expect(T.store.isHot(els[2].id)).toBe(true);
    frameOf(scene, renderer);
    T.work(performance.now() + 1e9); // остыли и запеклись
    expect(T.store.isHot(els[1].id)).toBe(false);
    expect(T.store.isHot(els[2].id)).toBe(false);
  });

  it("тёмная тема и экспорт — null", () => {
    const { scene, renderer } = makeScene();
    expect(frameOf(scene, renderer, { theme: THEME.DARK })).toBe(null);
    expect(frameOf(scene, renderer, {}, true)).toBe(null);
  });
});
