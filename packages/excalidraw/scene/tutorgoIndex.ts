// tutorgo: пространственный индекс сцены (спека TutorGo 2026-10-15-board-tiled-rendering, §3.3).
// Равномерная сетка: ячейка → id элементов, чьи рамки её задевают. Потребители
// (хит-тест, отбор видимых) берут кандидатов из ячеек вместо прохода по всем
// элементам доски; точные фильтры остаются за ними — индекс отвечает «может».
import { getElementBounds } from "../element/bounds";
import { isFrameLikeElement } from "../element/typeChecks";
import { INDEX_CELL, INDEX_MAX_CELLS } from "../tutorgo";

import type {
  ElementsMap,
  ExcalidrawElement,
  NonDeletedExcalidrawElement,
} from "../element/types";

type Id = ExcalidrawElement["id"];

type Entry = {
  version: number;
  /** LWW-reconcile: два участника дают одну version, но разный versionNonce. */
  versionNonce: number;
  /** null — элемент в «всегда»-наборе, в сетке его нет. */
  cells: string[] | null;
  order: number;
  /** Поколение последнего sync, на котором элемент встретился. */
  gen: number;
};

export class TutorgoSpatialIndex {
  private grid = new Map<string, Set<Id>>();
  private entries = new Map<Id, Entry>();
  private always = new Set<Id>();
  private lastNonce: number | undefined;
  private gen = 0;

  /** Пересобирает изменённое (по version), удаляет пропавшее; no-op при том же nonce. */
  sync(
    elements: readonly NonDeletedExcalidrawElement[],
    elementsMap: ElementsMap,
    nonce: number | undefined,
  ) {
    // undefined — вызывающий nonce не знает, доверять нечему: проходим всегда.
    if (nonce !== undefined && nonce === this.lastNonce) {
      return;
    }
    this.lastNonce = nonce;
    const gen = ++this.gen;

    for (let i = 0; i < elements.length; i++) {
      const el = elements[i];
      const prev = this.entries.get(el.id);
      if (
        prev &&
        prev.version === el.version &&
        prev.versionNonce === el.versionNonce
      ) {
        prev.order = i;
        prev.gen = gen;
        continue;
      }
      if (prev) {
        this.unlink(el.id, prev);
      }
      const cells = this.cellsOf(el, elementsMap);
      this.entries.set(el.id, {
        version: el.version,
        versionNonce: el.versionNonce,
        cells,
        order: i,
        gen,
      });
      if (cells) {
        for (const key of cells) {
          let bucket = this.grid.get(key);
          if (!bucket) {
            this.grid.set(key, (bucket = new Set()));
          }
          bucket.add(el.id);
        }
      } else {
        this.always.add(el.id);
      }
    }

    // Удаление по поколению: кого не встретили в этом проходе, того в сцене нет.
    // Map допускает удаление во время обхода.
    if (this.entries.size > elements.length) {
      for (const [id, entry] of this.entries) {
        if (entry.gen !== gen) {
          this.unlink(id, entry);
          this.entries.delete(id);
        }
      }
    }
  }

  /** id элементов, чьи рамки МОГУТ пересекать прямоугольник сцены; плюс «всегда»-набор. */
  query(x1: number, y1: number, x2: number, y2: number): Set<Id> {
    const result = new Set(this.always);
    const cx1 = Math.floor(x1 / INDEX_CELL);
    const cx2 = Math.floor(x2 / INDEX_CELL);
    const cy1 = Math.floor(y1 / INDEX_CELL);
    const cy2 = Math.floor(y2 / INDEX_CELL);

    // Запрос шире, чем занятых ячеек (отдалённый вид): дешевле отдать всех, чем
    // обходить пустые ключи. Надмножество допустимо — контракт «могут».
    if (
      !Number.isFinite(cx2 - cx1 + 1) ||
      (cx2 - cx1 + 1) * (cy2 - cy1 + 1) > this.grid.size
    ) {
      for (const id of this.entries.keys()) {
        result.add(id);
      }
      return result;
    }

    for (let cx = cx1; cx <= cx2; cx++) {
      for (let cy = cy1; cy <= cy2; cy++) {
        const bucket = this.grid.get(`${cx}:${cy}`);
        if (bucket) {
          for (const id of bucket) {
            result.add(id);
          }
        }
      }
    }
    return result;
  }

  /** Позиция элемента в массиве сцены на момент sync — z-порядок для сортировки. */
  order(id: Id): number {
    return this.entries.get(id)?.order ?? -1;
  }

  private unlink(id: Id, entry: Entry) {
    if (!entry.cells) {
      this.always.delete(id);
      return;
    }
    for (const key of entry.cells) {
      const bucket = this.grid.get(key);
      if (bucket) {
        bucket.delete(id);
        if (!bucket.size) {
          this.grid.delete(key);
        }
      }
    }
  }

  /** Ключи ячеек под рамкой элемента; null — в «всегда»-набор. */
  private cellsOf(el: ExcalidrawElement, elementsMap: ElementsMap) {
    // Рамка рисует подпись над собой — её видимость не равна пересечению с её
    // прямоугольником.
    if (isFrameLikeElement(el)) {
      return null;
    }
    const [x1, y1, x2, y2] = getElementBounds(el, elementsMap);
    const cx1 = Math.floor(x1 / INDEX_CELL);
    const cx2 = Math.floor(x2 / INDEX_CELL);
    const cy1 = Math.floor(y1 / INDEX_CELL);
    const cy2 = Math.floor(y2 / INDEX_CELL);
    const count = (cx2 - cx1 + 1) * (cy2 - cy1 + 1);
    // !(count <= MAX) ловит и NaN/Infinity у битых элементов.
    if (!(count <= INDEX_MAX_CELLS)) {
      return null;
    }
    const cells: string[] = [];
    for (let cx = cx1; cx <= cx2; cx++) {
      for (let cy = cy1; cy <= cy2; cy++) {
        cells.push(`${cx}:${cy}`);
      }
    }
    return cells;
  }
}
