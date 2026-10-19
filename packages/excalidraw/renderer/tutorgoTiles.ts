// tutorgo: тайлы статичного слоя (спека TutorGo 2026-10-15-board-tiled-rendering
// §3.1–3.2, план 2026-10-19-board-tiles-prototype). Кадр — фон, затем готовые
// квадраты-битмапы, затем «живые» элементы обычным путём. Цена кадра — от размера
// экрана, а не от числа элементов доски.
//
// Здесь — учёт: сетка уровней, какие тайлы устарели, какие элементы рисовать
// живьём. Рисование и насос — ниже, в части «рисование».
import rough from "roughjs/bin/rough";

import { THEME } from "../constants";
import { getBoundTextElement } from "../element/textElement";
import {
  hasBoundTextElement,
  isArrowElement,
  isFrameLikeElement,
  isIframeLikeElement,
  isInitializedImageElement,
  isTextElement,
} from "../element/typeChecks";
import { TutorgoSpatialIndex } from "../scene/tutorgoIndex";
import {
  HOT_BULK,
  HOT_MS,
  LOD_SIDE,
  TILES,
  TILE_BUDGET,
  TILE_EMPTY_BUDGET_MS,
  TILE_FALLBACK_LEVELS,
  TILE_FRAME_BUDGET_MS,
  TILE_POOL,
  TILE_PX,
} from "../tutorgo";

import { getCanvasPadding, renderElement } from "./renderElement";
import { renderStaticScene } from "./staticScene";

import type { RoughCanvas } from "roughjs/bin/canvas";
import type { Bounds, IndexChange } from "../scene/tutorgoIndex";
import type {
  StaticCanvasRenderConfig,
  StaticSceneRenderConfig,
} from "../scene/types";
import type { StaticCanvasAppState } from "../types";
import type {
  ElementsMap,
  ExcalidrawElement,
  NonDeletedExcalidrawElement,
} from "../element/types";

type Id = ExcalidrawElement["id"];

/** Диапазон тайлов одного уровня, включительно. */
export type TileRect = {
  level: number;
  tx1: number;
  ty1: number;
  tx2: number;
  ty2: number;
};

export type Tile = {
  key: string;
  level: number;
  tx: number;
  ty: number;
  /** null — ещё не нарисован ни разу. */
  canvas: HTMLCanvasElement | null;
  /** seq на момент начала отрисовки (или дорисовки) содержимого. */
  contentSeq: number;
  /** seq последней правки, задевшей тайл. */
  invalidSeq: number;
  /**
   * Дробный индекс (element.index) самого верхнего нарисованного элемента —
   * для дорисовки поверх. Не позиция в массиве: та сдвигается при undo удаления.
   */
  maxIndex: string | null;
  /** Номер кадра, когда тайл последний раз был нужен на экране. */
  lastUsed: number;
};

type Recent = {
  /** seq последнего изменения (правка или остывание). */
  changeSeq: number;
  hotUntil: number;
  hot: boolean;
};

/**
 * Уровень L: тайл рисуется с 2^L пикселей устройства на единицу сцены, на экран —
 * с масштабом zoom·dpr/2^L ∈ (0,5; 1], то есть только уменьшается — резко.
 */
export const levelFor = (zoom: number, dpr: number): number => {
  // 1e-9: zoom·dpr ровно 2^n не должен уехать на уровень выше из-за округления
  const level = Math.ceil(Math.log2(zoom * dpr) - 1e-9);
  return level === 0 ? 0 : level; // без -0
};

/** Сторона тайла уровня в единицах сцены. */
export const tileSceneSize = (level: number) => TILE_PX / 2 ** level;

export const tileKey = (level: number, tx: number, ty: number) =>
  `${level}:${tx}:${ty}`;

export const tileRange = (
  level: number,
  [x1, y1, x2, y2]: Bounds,
): TileRect => {
  const s = tileSceneSize(level);
  return {
    level,
    tx1: Math.floor(x1 / s),
    ty1: Math.floor(y1 / s),
    tx2: Math.floor(x2 / s),
    ty2: Math.floor(y2 / s),
  };
};

/** Запас на сглаживание: 2 пикселя устройства уровня, в единицах сцены. */
const aaPad = (level: number) => 2 / 2 ** level;

const tileIntersects = (t: Tile, b: Bounds, pad: number) => {
  const s = tileSceneSize(t.level);
  const e = pad + aaPad(t.level);
  return (
    b[0] - e < (t.tx + 1) * s &&
    b[2] + e > t.tx * s &&
    b[1] - e < (t.ty + 1) * s &&
    b[3] + e > t.ty * s
  );
};

/**
 * Элементы, которые в тайлы не идут никогда: рамки и всё в рамках (клип),
 * iframe-like (DOM поверх), со ссылкой (иконка ссылки — UI), стрелки с подписью
 * (экспорт рисует их через холст размера exportScale — мыло на крупных уровнях).
 */
const isAlwaysLive = (el: ExcalidrawElement) =>
  !!el.frameId ||
  isFrameLikeElement(el) ||
  isIframeLikeElement(el) ||
  !!el.link ||
  (isArrowElement(el) && hasBoundTextElement(el));

const toggle = (set: Set<Id>, id: Id, on: boolean) =>
  on ? set.add(id) : set.delete(id);

export class TileStore {
  tiles = new Map<string, Tile>();
  seq = 0;
  index: TutorgoSpatialIndex | null = null;
  /** id картинок — для проверки «файл ещё не загружен» каждый кадр. */
  images = new Set<Id>();

  private recent = new Map<Id, Recent>();
  private stateHot = new Set<Id>();
  private alwaysLive = new Set<Id>();
  /** Запас границ на элемент (getCanvasPadding): нужен и после удаления. */
  private pads = new Map<Id, number>();
  /** Контейнеры с подписью: дорисовка поверх их не рисует — только перерисовка. */
  private withText = new Set<Id>();
  /** Подпись → её контейнер: рисуется контейнером, сама не запекается. */
  private containerOf = new Map<Id, Id>();
  /** Дробный индекс элемента (z-порядок) на последнем sync. */
  private zIndex = new Map<Id, string | null>();
  /** Экран последнего кадра: недавние правки за его пределами не копятся. */
  screen: TileRect | null = null;

  constructor(private now: () => number) {}

  /** Сбрасывает всё; возвращает холсты тайлов для переиспользования. */
  reset(): HTMLCanvasElement[] {
    const freed: HTMLCanvasElement[] = [];
    for (const t of this.tiles.values()) {
      if (t.canvas) {
        freed.push(t.canvas);
      }
    }
    this.tiles.clear();
    this.recent.clear();
    this.stateHot.clear();
    this.alwaysLive.clear();
    this.pads.clear();
    this.withText.clear();
    this.containerOf.clear();
    this.zIndex.clear();
    this.images.clear();
    this.index = null;
    this.screen = null;
    return freed;
  }

  onIndexSync(
    index: TutorgoSpatialIndex,
    changes: readonly IndexChange[],
    elementsMap: ElementsMap,
  ): HTMLCanvasElement[] {
    // Новый индекс — новая сцена (сменили страницу доски): старые тайлы чужие, а
    // первая синхронизация — загрузка сцены, не правки.
    const isNew = index !== this.index;
    const freed = isNew ? this.reset() : [];
    this.index = index;
    // Массовая — по новым элементам (сид, импорт, вставка): перетаскивание
    // большого выделения — правки, им место в горячем слое.
    let added = 0;
    for (const c of changes) {
      if (!c.prev) {
        added++;
      }
    }
    const bulk = isNew || added > HOT_BULK;

    for (const c of changes) {
      const el = c.next ? elementsMap.get(c.id) : undefined;
      if (!el) {
        // удалён: в готовых тайлах ещё нарисован — перерисовать
        if (!bulk && c.prev) {
          this.invalidate(c.prev, this.pads.get(c.id) ?? 0, ++this.seq);
        }
        this.forget(c.id);
        continue;
      }
      this.classify(el);
      if (bulk) {
        continue;
      }
      this.touch(c.id, c.prev);
      // Подпись рисуется контейнером: правка подписи — правка контейнера.
      if (isTextElement(el) && el.containerId) {
        this.touch(el.containerId, index.bounds(el.containerId));
      }
    }
    if (bulk) {
      // Сид, импорт, большой undo: не «свежее» живьём, а перерисовка тайлов.
      for (const c of changes) {
        this.recent.delete(c.id);
      }
      this.invalidateAll();
    }
    return freed;
  }

  /** Стираемые, кропаемая, картинки без файла — живьём, пока состояние держится. */
  setStateHot(ids: ReadonlySet<Id>) {
    for (const id of ids) {
      if (!this.stateHot.has(id)) {
        this.touch(id, this.index?.bounds(id) ?? null);
      }
    }
    for (const id of this.stateHot) {
      if (!ids.has(id)) {
        const r = this.recent.get(id);
        if (r) {
          r.hotUntil = 0; // остынет на ближайшем tick
        }
      }
    }
    this.stateHot = new Set(ids);
  }

  /** Остывание по времени. Возвращает остывшие id — их надо запечь (bake). */
  tick(): Id[] {
    const now = this.now();
    const cooled: Id[] = [];
    for (const [id, r] of this.recent) {
      if (r.hot && now >= r.hotUntil && !this.stateHot.has(id)) {
        r.hot = false;
        r.changeSeq = ++this.seq;
        cooled.push(id);
      }
    }
    return cooled;
  }

  /** Есть горячие по времени — насосу есть что ждать. */
  hasTimedHot() {
    for (const [id, r] of this.recent) {
      if (r.hot && !this.stateHot.has(id)) {
        return true;
      }
    }
    return false;
  }

  /**
   * Остывший элемент — в тайлы по его границам: дорисовать поверх (append вернул
   * true — тайл свежий, элемент выше всех в нём), иначе тайл перерисуется.
   */
  bake(id: Id, append: (tile: Tile) => boolean) {
    const r = this.recent.get(id);
    const b = this.index?.bounds(id);
    const container = this.containerOf.get(id);
    if (
      !r ||
      !b ||
      // всегда-живой в тайл не идёт (иначе нарисован дважды)
      this.alwaysLive.has(id) ||
      // подпись запекается вместе с контейнером (его правка помечена в
      // onIndexSync) — если контейнер есть; висячая рисуется сама
      (container && this.index!.bounds(container))
    ) {
      if (r && !r.hot) {
        this.recent.delete(id);
      }
      return;
    }
    const pad = this.pads.get(id) ?? 0;
    const zi = this.zIndex.get(id) ?? null;
    for (const t of this.tiles.values()) {
      if (!tileIntersects(t, b, pad)) {
        continue;
      }
      if (this.canAppend(t, id) && append(t)) {
        t.contentSeq = r.changeSeq;
        t.invalidSeq = r.changeSeq;
        t.maxIndex = zi;
      } else {
        t.invalidSeq = Math.max(t.invalidSeq, r.changeSeq);
      }
    }
    // Вне экрана — забываем: тайлы там уже помечены устаревшими, а учёт
    // недавних не должен расти весь урок, пока ученик рисует в стороне.
    const s = this.screen;
    if (s) {
      const range = tileRange(s.level, b);
      if (
        range.tx2 < s.tx1 ||
        range.tx1 > s.tx2 ||
        range.ty2 < s.ty1 ||
        range.ty1 > s.ty2
      ) {
        this.recent.delete(id);
      }
    }
  }

  canAppend(t: Tile, id: Id): boolean {
    const zi = this.zIndex.get(id);
    return (
      this.fresh(t) &&
      !!zi &&
      (t.maxIndex === null || zi > t.maxIndex) &&
      !this.withText.has(id)
    );
  }

  /** Дробный индекс элемента для maxIndex тайла. */
  zIndexOf(id: Id): string | null {
    return this.zIndex.get(id) ?? null;
  }

  fresh(t: Tile): boolean {
    return !!t.canvas && t.contentSeq >= t.invalidSeq;
  }

  /** В тайл не рисовать: всегда-живой или горячий. */
  isHot(id: Id): boolean {
    return (
      this.alwaysLive.has(id) ||
      this.stateHot.has(id) ||
      !!this.recent.get(id)?.hot
    );
  }

  /**
   * Рисовать живьём поверх тайлов: горячий, или недавний, а тайл экрана в его
   * границах ещё без него. Покрытый всеми тайлами (и целиком на экране) —
   * забывается.
   */
  isLive(id: Id, screen: TileRect): boolean {
    if (this.alwaysLive.has(id)) {
      return true;
    }
    const r = this.recent.get(id);
    if (!r) {
      return false;
    }
    if (r.hot || this.stateHot.has(id)) {
      return true;
    }
    const b = this.index?.bounds(id);
    if (!b) {
      this.recent.delete(id);
      return false;
    }
    const e = (this.pads.get(id) ?? 0) + aaPad(screen.level);
    const range = tileRange(screen.level, [
      b[0] - e,
      b[1] - e,
      b[2] + e,
      b[3] + e,
    ]);
    for (
      let tx = Math.max(range.tx1, screen.tx1);
      tx <= Math.min(range.tx2, screen.tx2);
      tx++
    ) {
      for (
        let ty = Math.max(range.ty1, screen.ty1);
        ty <= Math.min(range.ty2, screen.ty2);
        ty++
      ) {
        const t = this.tiles.get(tileKey(screen.level, tx, ty));
        if (!t?.canvas || t.contentSeq < r.changeSeq) {
          return true;
        }
      }
    }
    if (
      range.tx1 >= screen.tx1 &&
      range.tx2 <= screen.tx2 &&
      range.ty1 >= screen.ty1 &&
      range.ty2 <= screen.ty2
    ) {
      this.recent.delete(id);
    }
    return false;
  }

  /** Элемент с запасом задевает тайл — его стоит рисовать в этот тайл. */
  touches(id: Id, level: number, tx: number, ty: number): boolean {
    const b = this.index?.bounds(id);
    return (
      !!b &&
      tileIntersects({ level, tx, ty } as Tile, b, this.pads.get(id) ?? 0)
    );
  }

  invalidate(b: Bounds, pad: number, seq: number) {
    for (const t of this.tiles.values()) {
      if (tileIntersects(t, b, pad)) {
        t.invalidSeq = Math.max(t.invalidSeq, seq);
      }
    }
  }

  invalidateAll() {
    const seq = ++this.seq;
    for (const t of this.tiles.values()) {
      t.invalidSeq = seq;
    }
  }

  /** Тайл по ключу, заводит пустой. */
  tile(level: number, tx: number, ty: number): Tile {
    const key = tileKey(level, tx, ty);
    let t = this.tiles.get(key);
    if (!t) {
      t = {
        key,
        level,
        tx,
        ty,
        canvas: null,
        contentSeq: -1,
        invalidSeq: 0,
        maxIndex: null,
        lastUsed: 0,
      };
      this.tiles.set(key, t);
    }
    return t;
  }

  /** LRU: сверх TILE_BUDGET выгоняет давно не нужные; нужные в кадре `frame` не трогает. */
  evict(frame: number): HTMLCanvasElement[] {
    const drawn = [...this.tiles.values()].filter((t) => t.canvas);
    const extra = drawn.length - TILE_BUDGET;
    if (extra <= 0) {
      return [];
    }
    const freed: HTMLCanvasElement[] = [];
    drawn
      .filter((t) => t.lastUsed !== frame)
      .sort((a, b) => a.lastUsed - b.lastUsed)
      .slice(0, extra)
      .forEach((t) => {
        freed.push(t.canvas!);
        this.tiles.delete(t.key);
      });
    return freed;
  }

  /**
   * Холодный → горячий: в готовых тайлах он нарисован по старым границам —
   * перерисовать их. Уже горячий — тайлы его не содержат, не трогаем (иначе
   * перетаскивание перезапускало бы тайлы каждый кадр).
   */
  private touch(id: Id, prev: Bounds | null) {
    const r = this.recent.get(id);
    if (!r?.hot) {
      ++this.seq;
      if (prev) {
        this.invalidate(prev, this.pads.get(id) ?? 0, this.seq);
      }
    }
    this.recent.set(id, {
      changeSeq: this.seq,
      hotUntil: this.now() + HOT_MS,
      hot: true,
    });
  }

  private classify(el: ExcalidrawElement) {
    this.pads.set(el.id, getCanvasPadding(el));
    toggle(this.alwaysLive, el.id, isAlwaysLive(el));
    toggle(this.images, el.id, el.type === "image");
    toggle(this.withText, el.id, hasBoundTextElement(el));
    if (isTextElement(el) && el.containerId) {
      this.containerOf.set(el.id, el.containerId);
    } else {
      this.containerOf.delete(el.id);
    }
    this.zIndex.set(el.id, el.index);
  }

  private forget(id: Id) {
    this.recent.delete(id);
    this.alwaysLive.delete(id);
    this.images.delete(id);
    this.pads.delete(id);
    this.withText.delete(id);
    this.containerOf.delete(id);
    this.zIndex.delete(id);
  }
}

// ─── рисование ───────────────────────────────────────────────────────────────

type TilePos = { level: number; tx: number; ty: number };

type Job = TilePos & {
  canvas: HTMLCanvasElement;
  rc: RoughCanvas;
  elements: readonly NonDeletedExcalidrawElement[];
  i: number;
  seq: number;
  maxIndex: string | null;
  appState: StaticCanvasAppState;
  renderConfig: StaticCanvasRenderConfig;
};

const store = new TileStore(() => performance.now());
const pool: HTMLCanvasElement[] = [];
const roughOf = new WeakMap<HTMLCanvasElement, RoughCanvas>();
let enabled = false;
let job: Job | null = null;
let queue: TilePos[] = [];
let lastConfig: StaticSceneRenderConfig | null = null;
/** На экране есть тайл без холста и без заглушки — бюджет побольше. */
let hole = false;
let frame = 0;
let raf = 0;

const release = (canvases: readonly HTMLCanvasElement[]) => {
  for (const c of canvases) {
    if (pool.length < TILE_POOL) {
      pool.push(c);
    } else {
      // освобождает память холста сразу, не дожидаясь GC
      c.width = 0;
      c.height = 0;
    }
  }
};

const abortJob = () => {
  if (job) {
    release([job.canvas]);
    // заготовка без холста (startJob) больше никому не нужна
    const key = tileKey(job.level, job.tx, job.ty);
    if (!store.tiles.get(key)?.canvas) {
      store.tiles.delete(key);
    }
    job = null;
  }
};

/** Всё забыть: тайлы, работу, конфиг (уход с доски, флаг выключен). */
const resetAll = () => {
  abortJob();
  release(store.reset());
  lastConfig = null;
  queue = [];
  if (raf) {
    cancelAnimationFrame(raf);
    raf = 0;
  }
};

const onSync: NonNullable<typeof TutorgoSpatialIndex.onSync> = (
  index,
  changes,
  elementsMap,
) => {
  if (index !== store.index) {
    // другая сцена: конфиг и работа — от старой страницы
    abortJob();
    lastConfig = null;
    queue = [];
  }
  release(store.onIndexSync(index, changes, elementsMap));
};

// Шрифт догрузился — текст в тайлах нарисован запасным шрифтом.
const onFontsLoaded = () => {
  store.invalidateAll();
  if (lastConfig) {
    renderStaticScene(lastConfig);
  }
};

const setEnabled = (on: boolean) => {
  enabled = on;
  TutorgoSpatialIndex.onSync = on ? onSync : null;
  // тестовое окружение мокает document.fonts без событий
  if (typeof document?.fonts?.addEventListener === "function") {
    if (on) {
      document.fonts.addEventListener("loadingdone", onFontsLoaded);
    } else {
      document.fonts.removeEventListener("loadingdone", onFontsLoaded);
    }
  }
  if (!on) {
    resetAll();
  }
};

if (TILES) {
  setEnabled(true);
}

const applicable = ({ appState, renderConfig }: StaticSceneRenderConfig) =>
  enabled &&
  // индекс ещё не пришёл (сброс без новой синхронизации) — тайлам не из чего
  // рисовать, пустой холст хуже старого пути
  !!store.index &&
  !renderConfig.isExporting &&
  appState.theme !== THEME.DARK &&
  appState.openDialog?.name !== "elementLinkSelector" &&
  !appState.frameToHighlight;

/** Прямоугольник тайла на экране в целых пикселях устройства: у соседей общий край — без швов. */
const destRect = (
  { level, tx, ty }: TilePos,
  appState: StaticCanvasAppState,
  f: number,
) => {
  const s = tileSceneSize(level);
  const x1 = Math.round((tx * s + appState.scrollX) * f);
  const y1 = Math.round((ty * s + appState.scrollY) * f);
  const x2 = Math.round(((tx + 1) * s + appState.scrollX) * f);
  const y2 = Math.round(((ty + 1) * s + appState.scrollY) * f);
  return [x1, y1, x2 - x1, y2 - y1] as const;
};

/** Заглушка: кусок тайла грубее (растянут), поверх — тайлы детальнее, что есть. */
const drawFallback = (
  context: CanvasRenderingContext2D,
  pos: TilePos,
  appState: StaticCanvasAppState,
  f: number,
) => {
  const [dx, dy, dw, dh] = destRect(pos, appState, f);
  let found = false;
  for (let p = 1; p <= TILE_FALLBACK_LEVELS && !found; p++) {
    const n = 2 ** p;
    const px = Math.floor(pos.tx / n);
    const py = Math.floor(pos.ty / n);
    const parent = store.tiles.get(tileKey(pos.level - p, px, py));
    if (parent?.canvas) {
      parent.lastUsed = frame;
      const sub = TILE_PX / n;
      context.drawImage(
        parent.canvas,
        (pos.tx - px * n) * sub,
        (pos.ty - py * n) * sub,
        sub,
        sub,
        dx,
        dy,
        dw,
        dh,
      );
      found = true;
    }
  }
  for (let i = 0; i < 2; i++) {
    for (let j = 0; j < 2; j++) {
      const child: TilePos = {
        level: pos.level + 1,
        tx: pos.tx * 2 + i,
        ty: pos.ty * 2 + j,
      };
      const t = store.tiles.get(tileKey(child.level, child.tx, child.ty));
      if (t?.canvas) {
        t.lastUsed = frame;
        context.drawImage(t.canvas, ...destRect(child, appState, f));
        found = true;
      }
    }
  }
  return found;
};

/**
 * Живьём по состоянию: стираемые, кропаемая, редактируемый текст (и его
 * контейнер), рисуемый элемент, вставляемая картинка, картинки без файла.
 * Редактируемого и рисуемого нет в elementsMap — запечь их можно только после
 * выхода из состояния, иначе тайл перерисуется без них, а учёт их забудет.
 */
const stateHotOf = ({
  appState,
  renderConfig,
  elementsMap,
}: StaticSceneRenderConfig) => {
  const ids = new Set<string>(renderConfig.elementsPendingErasure);
  for (const id of [
    appState.croppingElementId,
    appState.editingTextElement?.id,
    appState.editingTextElement?.type === "text"
      ? appState.editingTextElement.containerId
      : null,
    appState.newElement?.id,
    appState.pendingImageElementId,
  ]) {
    if (id) {
      ids.add(id);
    }
  }
  for (const id of store.images) {
    const el = elementsMap.get(id);
    if (el && isInitializedImageElement(el)) {
      const img = renderConfig.imageCache.get(el.fileId)?.image;
      if (!img || img instanceof Promise) {
        ids.add(id);
      }
    }
  }
  return ids;
};

/**
 * Кадр статичного слоя из тайлов: композит готовых (или заглушек), очередь на
 * дорисовку, живые элементы — вызывающему. null — тайлы неприменимы, рисовать
 * по-старому.
 */
export const drawTutorgoTiles = (
  context: CanvasRenderingContext2D,
  config: StaticSceneRenderConfig,
  normalizedWidth: number,
  normalizedHeight: number,
): readonly NonDeletedExcalidrawElement[] | null => {
  if (!applicable(config)) {
    // экспорт рисует на свой холст — тайлам не мешает; иначе (тёмная тема и
    // т.п.) насос не должен дорисовывать устаревший кадр поверх обычного
    if (!config.renderConfig.isExporting && lastConfig) {
      abortJob();
      lastConfig = null;
    }
    return null;
  }
  lastConfig = config;
  frame++;
  const { appState, scale } = config;
  const zoom = appState.zoom.value;
  const f = zoom * scale;
  const level = levelFor(zoom, scale);
  const sx = -appState.scrollX;
  const sy = -appState.scrollY;
  const screen = tileRange(level, [
    sx,
    sy,
    sx + normalizedWidth / zoom,
    sy + normalizedHeight / zoom,
  ]);
  store.screen = screen;
  store.setStateHot(stateHotOf(config));

  const cx = (screen.tx1 + screen.tx2) / 2;
  const cy = (screen.ty1 + screen.ty2) / 2;
  const need: (TilePos & { d: number })[] = [];
  const ring: TilePos[] = [];
  hole = false;

  context.save();
  context.setTransform(1, 0, 0, 1, 0, 0);
  for (let tx = screen.tx1 - 1; tx <= screen.tx2 + 1; tx++) {
    for (let ty = screen.ty1 - 1; ty <= screen.ty2 + 1; ty++) {
      const pos = { level, tx, ty };
      const t = store.tiles.get(tileKey(level, tx, ty));
      const onScreen =
        tx >= screen.tx1 &&
        tx <= screen.tx2 &&
        ty >= screen.ty1 &&
        ty <= screen.ty2;
      if (!onScreen) {
        if (t) {
          t.lastUsed = frame;
        }
        if (!t || !store.fresh(t)) {
          ring.push(pos);
        }
        continue;
      }
      if (t?.canvas) {
        t.lastUsed = frame;
        context.drawImage(t.canvas, ...destRect(pos, appState, f));
      } else if (!drawFallback(context, pos, appState, f)) {
        hole = true;
      }
      if (!t || !store.fresh(t)) {
        need.push({ ...pos, d: (tx - cx) ** 2 + (ty - cy) ** 2 });
      }
    }
  }
  context.restore();

  need.sort((a, b) => a.d - b.d);
  queue = [...need, ...ring];
  if (
    job &&
    (job.level !== level ||
      !queue.some((q) => q.tx === job!.tx && q.ty === job!.ty))
  ) {
    abortJob();
  }
  ensurePump();

  return config.visibleElements.filter((el) => store.isLive(el.id, screen));
};

const ensurePump = () => {
  if (
    !raf &&
    enabled &&
    lastConfig &&
    (job || queue.length || store.hasTimedHot())
  ) {
    raf = requestAnimationFrame(() => {
      raf = 0;
      work(
        performance.now() +
          (hole ? TILE_EMPTY_BUDGET_MS : TILE_FRAME_BUDGET_MS),
      );
    });
  }
};

/** Камера и конфиг рендера тайла: экспорт прямоугольника сцены в масштабе 2^L. */
const tileView = (
  config: StaticSceneRenderConfig,
  { level, tx, ty }: TilePos,
) => {
  const s = tileSceneSize(level);
  return {
    appState: {
      ...config.appState,
      scrollX: -tx * s,
      scrollY: -ty * s,
      zoom: { value: 2 ** level / config.scale },
    } as StaticCanvasAppState,
    renderConfig: {
      ...config.renderConfig,
      isExporting: true,
      tutorgoTile: true,
      renderGrid: false,
      embedsValidationStatus: new Map(),
      elementsPendingErasure: new Set(),
      pendingFlowchartNodes: null,
    } as StaticCanvasRenderConfig,
  };
};

type LodCanvas = HTMLCanvasElement & {
  naturalWidth: number;
  naturalHeight: number;
};

// ponytail: копии живут, пока жива вкладка (~180 КБ на картинку, 330 страниц PDF ≈
// 60 МБ); LRU или серверные /thumb вместо них — на шаге «полная версия».
const lods = new Map<string, LodCanvas>();

/**
 * Уменьшенная копия картинки (длинная сторона LOD_SIDE): на дальнем уровне
 * тайл рисует её, а не полный JPEG страницы. null — картинка и так не больше.
 * naturalWidth/Height — их читает drawElementOnCanvas вместо размеров img.
 */
export const lodImage = (
  fileId: string,
  img: HTMLImageElement,
): LodCanvas | null => {
  const cached = lods.get(fileId);
  if (cached) {
    return cached;
  }
  const s = LOD_SIDE / Math.max(img.naturalWidth, img.naturalHeight);
  if (!(s < 1)) {
    return null;
  }
  const w = Math.max(1, Math.round(img.naturalWidth * s));
  const h = Math.max(1, Math.round(img.naturalHeight * s));
  const canvas = Object.assign(document.createElement("canvas"), {
    naturalWidth: w,
    naturalHeight: h,
  });
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext("2d")!;
  ctx.imageSmoothingQuality = "high"; // иначе уменьшение в 8 раз — «лесенка»
  ctx.drawImage(img, 0, 0, w, h);
  lods.set(fileId, canvas);
  return canvas;
};

/**
 * Конфиг рендера с копией вместо полной картинки, если на тайле картинка не
 * больше LOD_SIDE. Кроп задан в пикселях исходника — с копией не сойдётся.
 */
export const withLod = (
  el: NonDeletedExcalidrawElement,
  renderConfig: StaticCanvasRenderConfig,
  k: number,
): StaticCanvasRenderConfig => {
  if (
    !isInitializedImageElement(el) ||
    el.crop ||
    Math.max(el.width, el.height) * k > LOD_SIDE
  ) {
    return renderConfig;
  }
  const entry = renderConfig.imageCache.get(el.fileId);
  if (!(entry?.image instanceof HTMLImageElement)) {
    return renderConfig;
  }
  const lod = lodImage(el.fileId, entry.image);
  if (!lod) {
    return renderConfig;
  }
  return {
    ...renderConfig,
    imageCache: new Map([
      [el.fileId, { ...entry, image: lod as unknown as HTMLImageElement }],
    ]),
  };
};

/** Тело цикла _renderStaticScene для одного элемента (без клипа рамкой: такие живые). */
const paintOne = (
  el: NonDeletedExcalidrawElement,
  ctx: CanvasRenderingContext2D,
  rc: RoughCanvas,
  config: StaticSceneRenderConfig,
  appState: StaticCanvasAppState,
  renderConfig: StaticCanvasRenderConfig,
  k: number,
) => {
  ctx.save();
  try {
    renderElement(
      el,
      config.elementsMap,
      config.allElementsMap,
      rc,
      ctx,
      withLod(el, renderConfig, k),
      appState,
    );
    const text = getBoundTextElement(el, config.elementsMap);
    if (text) {
      renderElement(
        text,
        config.elementsMap,
        config.allElementsMap,
        rc,
        ctx,
        renderConfig,
        appState,
      );
    }
  } catch (error) {
    console.error(error, el.id);
  }
  ctx.restore();
};

const takeCanvas = () => {
  const canvas = pool.pop() ?? document.createElement("canvas");
  if (canvas.width !== TILE_PX || canvas.height !== TILE_PX) {
    canvas.width = TILE_PX; // заодно очищает
    canvas.height = TILE_PX;
  } else {
    const ctx = canvas.getContext("2d")!;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, TILE_PX, TILE_PX);
  }
  let rc = roughOf.get(canvas);
  if (!rc) {
    roughOf.set(canvas, (rc = rough.canvas(canvas)));
  }
  return { canvas, rc };
};

const startJob = (
  config: StaticSceneRenderConfig,
  pos: TilePos,
): Job | null => {
  const index = store.index;
  if (!index) {
    return null;
  }
  const s = tileSceneSize(pos.level);
  // запас: getCanvasPadding (до ~50) и сглаживание; точный отбор — touches
  const m = 100 + 2 / 2 ** pos.level;
  const x0 = pos.tx * s;
  const y0 = pos.ty * s;
  const elements = index
    .candidates(x0 - m, y0 - m, x0 + s + m, y0 + s + m, config.elementsMap)
    .filter(
      (el) =>
        // подпись рисует контейнер
        !(
          isTextElement(el) &&
          el.containerId &&
          config.elementsMap.has(el.containerId)
        ) && store.touches(el.id, pos.level, pos.tx, pos.ty),
    );
  // Заготовка в учёте с первого кадра работы: правки, пришедшие, пока тайл
  // рисуется, должны его инвалидировать — иначе коммит сочтёт тайл свежим с
  // призраком удалённого внутри.
  const t = store.tile(pos.level, pos.tx, pos.ty);
  t.lastUsed = frame;
  const { canvas, rc } = takeCanvas();
  return {
    ...pos,
    ...tileView(config, pos),
    canvas,
    rc,
    elements,
    i: 0,
    seq: store.seq,
    maxIndex: null,
  };
};

/** Рисует элементы работы до дедлайна; true — тайл готов. */
const paintJob = (
  j: Job,
  config: StaticSceneRenderConfig,
  deadline: number,
) => {
  const ctx = j.canvas.getContext("2d")!;
  const k = 2 ** j.level;
  ctx.setTransform(k, 0, 0, k, 0, 0);
  while (j.i < j.elements.length) {
    const id = j.elements[j.i++].id;
    // свежая версия элемента: объект в сцене могли заменить, пока шла работа
    const el = config.elementsMap.get(id);
    if (!el || store.isHot(id)) {
      continue;
    }
    paintOne(el, ctx, j.rc, config, j.appState, j.renderConfig, k);
    const zi = store.zIndexOf(id);
    if (zi && (j.maxIndex === null || zi > j.maxIndex)) {
      j.maxIndex = zi;
    }
    if (performance.now() >= deadline) {
      break;
    }
  }
  return j.i >= j.elements.length;
};

const commit = (j: Job) => {
  const t = store.tile(j.level, j.tx, j.ty);
  const old = t.canvas;
  t.canvas = j.canvas;
  t.contentSeq = j.seq;
  t.maxIndex = j.maxIndex;
  t.lastUsed = frame;
  if (old) {
    release([old]);
  }
  release(store.evict(frame));
};

/** Дорисовать остывший элемент поверх готового тайла. */
const appendOne = (
  t: Tile,
  id: string,
  config: StaticSceneRenderConfig,
): boolean => {
  const el = config.elementsMap.get(id);
  if (!el || !t.canvas) {
    return false;
  }
  const ctx = t.canvas.getContext("2d")!;
  const k = 2 ** t.level;
  ctx.setTransform(k, 0, 0, k, 0, 0);
  const view = tileView(config, t);
  let rc = roughOf.get(t.canvas);
  if (!rc) {
    roughOf.set(t.canvas, (rc = rough.canvas(t.canvas)));
  }
  paintOne(el, ctx, rc, config, view.appState, view.renderConfig, k);
  return true;
};

/** Шаг насоса: остывание, дорисовки, тайлы из очереди до дедлайна. */
const work = (deadline: number) => {
  const config = lastConfig;
  if (!config || !enabled) {
    return;
  }
  let dirty = false;
  for (const id of store.tick()) {
    store.bake(id, (t) => appendOne(t, id, config));
    dirty = true;
  }
  while (performance.now() < deadline) {
    if (!job) {
      let next: TilePos | undefined;
      while ((next = queue.shift())) {
        const t = store.tiles.get(tileKey(next.level, next.tx, next.ty));
        if (!t || !store.fresh(t)) {
          break;
        }
      }
      job = next ? startJob(config, next) : null;
      if (!job) {
        break;
      }
    }
    if (paintJob(job, config, deadline)) {
      commit(job);
      job = null;
      dirty = true;
    }
  }
  if (dirty) {
    // Композит заново: новые тайлы, остывшие — в них. Без троттла: троттл хранит
    // последние аргументы, и наш config перебил бы более свежий кадр React.
    renderStaticScene(config);
  }
  ensurePump();
};

/** Уход с доски (Renderer.destroy): холсты тайлов и старая сцена не держатся. */
export const tutorgoTilesReset = resetAll;

/** Только для тестов: включить без localStorage и прогнать насос синхронно. */
export const __tutorgoTilesForTests = {
  store,
  setEnabled,
  work,
  queueLength: () => queue.length + (job ? 1 : 0),
};
