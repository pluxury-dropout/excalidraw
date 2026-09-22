import { useEffect, useState } from "react";

import { t } from "../i18n";
import { KEYS } from "../keys";

import "./FontSizeInput.scss";

// tutorgo: числовое поле размера шрифта вместо четырёх пресетов S/M/L/XL.
//
// Значение уходит наружу через onChange → actionChangeFontSize, то есть всю
// тяжёлую часть (перерисовку bbox текста, перенос строк в контейнере, сдвиг
// элемента вокруг центра, привязанные стрелки, currentItemFontSize и запись в
// историю) по-прежнему делает апстримовый changeFontSize. Здесь только ввод.
//
// Нижняя граница — как в панели Stats (MIN_FONT_SIZE = 4): ниже текст
// нечитаем и Excalidraw сам его больше не отрисовывает осмысленно.

export const MIN_FONT_SIZE = 4;
export const MAX_FONT_SIZE = 400;

/** Шаг кнопок «−»/«+». Абсолютный, а не относительный (как у Ctrl+Shift+./,),
 * чтобы значения оставались круглыми: 20 → 22 → 24, а не 20 → 22 → 24.2. */
const STEP = 2;

const clamp = (value: number) =>
  Math.min(MAX_FONT_SIZE, Math.max(MIN_FONT_SIZE, Math.round(value)));

export const FontSizeInput = ({
  /** null = у выделенных элементов размеры разные */
  value,
  onChange,
}: {
  value: number | null;
  onChange: (value: number) => void;
}) => {
  const [draft, setDraft] = useState(value === null ? "" : String(value));

  // Значение меняется и мимо поля: другой выделенный элемент, Ctrl+Shift+./,,
  // undo. Поле всегда идёт за состоянием сцены.
  useEffect(() => {
    setDraft(value === null ? "" : String(value));
  }, [value]);

  // Применяем по Enter и blur, а не на каждый keystroke: иначе «20» → «2» в
  // процессе набора успело бы схлопнуть текст до минимума.
  const commit = (raw: string) => {
    const parsed = Number.parseFloat(raw);
    if (Number.isNaN(parsed)) {
      setDraft(value === null ? "" : String(value));
      return;
    }
    const next = clamp(parsed);
    setDraft(String(next));
    if (next !== value) {
      onChange(next);
    }
  };

  const step = (delta: number) => {
    const base = value ?? Number.parseFloat(draft);
    if (Number.isNaN(base)) {
      return;
    }
    const next = clamp(base + delta);
    setDraft(String(next));
    if (next !== value) {
      onChange(next);
    }
  };

  return (
    <div className="tutorgo-font-size">
      <button
        type="button"
        className="tutorgo-font-size__step"
        title={t("labels.decreaseFontSize")}
        onClick={() => step(-STEP)}
      >
        −
      </button>
      <input
        type="number"
        className="tutorgo-font-size__input"
        min={MIN_FONT_SIZE}
        max={MAX_FONT_SIZE}
        step={1}
        value={draft}
        placeholder="—"
        data-testid="fontSize-input"
        aria-label={t("labels.fontSize")}
        onChange={(event) => setDraft(event.target.value)}
        onBlur={(event) => commit(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === KEYS.ENTER) {
            event.preventDefault();
            commit(event.currentTarget.value);
            event.currentTarget.blur();
          } else if (event.key === KEYS.ESCAPE) {
            event.preventDefault();
            setDraft(value === null ? "" : String(value));
            event.currentTarget.blur();
          }
          // Остальные клавиши не всплывают до канвы: иначе «e» из размера
          // переключила бы инструмент (глобальные хоткеи Excalidraw).
          event.stopPropagation();
        }}
      />
      <button
        type="button"
        className="tutorgo-font-size__step"
        title={t("labels.increaseFontSize")}
        onClick={() => step(STEP)}
      >
        +
      </button>
    </div>
  );
};
