// tutorgo: тайлы статичного слоя (спека TutorGo 2026-10-15-board-tiled-rendering
// §3.1–3.2, план 2026-10-19-board-tiles-prototype). Кадр — фон, затем готовые
// квадраты-битмапы, затем «живые» элементы обычным путём. Цена кадра — от размера
// экрана, а не от числа элементов доски.
//
// Здесь — учёт: сетка уровней, какие тайлы устарели, какие элементы рисовать
// живьём. Рисование и насос — ниже, в части «рисование».
import {
  hasBoundTextElement,
  isArrowElement,
  isFrameLikeElement,
  isIframeLikeElement,
  isTextElement,
} from "../element/typeChecks";
import { HOT_BULK, HOT_MS, TILE_BUDGET, TILE_PX } from "../tutorgo";

import { getCanvasPadding } from "./renderElement";

import type {
  Bounds,
  IndexChange,
  TutorgoSpatialIndex,
} from "../scene/tutorgoIndex";
import type { ElementsMap, ExcalidrawElement } from "../element/types";

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
  /** Самый верхний по z нарисованный элемент — для дорисовки поверх. */
  maxOrder: number;
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
  /** Подписи с контейнером: рисуются контейнером, сами не запекаются. */
  private contained = new Set<Id>();

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
    this.contained.clear();
    this.images.clear();
    this.index = null;
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
    const bulk = isNew || changes.length > HOT_BULK;

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
    // подпись запекается вместе с контейнером (его правка помечена в onIndexSync)
    if (!r || !b || this.contained.has(id)) {
      this.recent.delete(id);
      return;
    }
    const pad = this.pads.get(id) ?? 0;
    for (const t of this.tiles.values()) {
      if (!tileIntersects(t, b, pad)) {
        continue;
      }
      if (this.canAppend(t, id) && append(t)) {
        t.contentSeq = r.changeSeq;
        t.invalidSeq = r.changeSeq;
        t.maxOrder = this.index!.order(id);
      } else {
        t.invalidSeq = Math.max(t.invalidSeq, r.changeSeq);
      }
    }
  }

  canAppend(t: Tile, id: Id): boolean {
    return (
      this.fresh(t) &&
      !!this.index &&
      this.index.order(id) > t.maxOrder &&
      !this.withText.has(id)
    );
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
        maxOrder: -1,
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
    toggle(this.contained, el.id, isTextElement(el) && !!el.containerId);
  }

  private forget(id: Id) {
    this.recent.delete(id);
    this.alwaysLive.delete(id);
    this.images.delete(id);
    this.pads.delete(id);
    this.withText.delete(id);
    this.contained.delete(id);
  }
}
