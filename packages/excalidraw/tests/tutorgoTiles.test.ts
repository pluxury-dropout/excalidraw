// tutorgo: тайлы статичного слоя (спека TutorGo 2026-10-15-board-tiled-rendering §3.1–3.2).
import { mutateElement } from "../element/mutateElement";
import {
  TileStore,
  levelFor,
  tileKey,
  tileRange,
  tileSceneSize,
} from "../renderer/tutorgoTiles";
import { TutorgoSpatialIndex } from "../scene/tutorgoIndex";
import { HOT_BULK, HOT_MS, TILE_BUDGET } from "../tutorgo";

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
    scene = next;
    TutorgoSpatialIndex.onSync = (i, c, m) => store.onIndexSync(i, c, m);
    index.sync(scene, mapOf(scene), ++nonce);
    TutorgoSpatialIndex.onSync = null;
  };
  /** Тайл уровня 0 «нарисован» на текущем seq. */
  const paint = (tx: number, ty: number) => {
    const t = store.tile(0, tx, ty);
    t.canvas = document.createElement("canvas");
    t.contentSeq = store.seq;
    t.maxOrder = scene.length - 1;
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
    t.maxOrder = -1;
    expect(store.canAppend(t, low.id)).toBe(true);
    t.maxOrder = 1;
    expect(store.canAppend(t, low.id)).toBe(false);
    expect(store.canAppend(t, top.id)).toBe(false); // order 1 не выше maxOrder 1

    t.maxOrder = 0;
    let appended = 0;
    store.bake(top.id, () => ++appended > 0);
    expect(appended).toBe(1);
    expect(store.fresh(t)).toBe(true);
    expect(t.maxOrder).toBe(1);
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
