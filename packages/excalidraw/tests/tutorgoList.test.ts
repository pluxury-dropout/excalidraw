// tutorgo: пробел начинает список, Enter его продолжает.
import { continueList, startList } from "../tutorgo";

// «|» — курсор сразу после набранного пробела
const space = (text: string) => {
  const at = text.indexOf("|");
  const r = startList(text.replace("|", ""), at);
  return r && r.value.slice(0, r.cursor) + "|" + r.value.slice(r.cursor);
};

describe("tutorgo: startList", () => {
  it.each([
    ["1. |", "    1. |"],
    ["12) |", "    12) |"],
    ["- |", "    • |"],
    ["* |", "    • |"],
    ["x\n1. |\ny", "x\n    1. |\ny"],
    ["1. |хвост", "    1. |хвост"],
    // уже с отступом (Tab): отступ не удваивается, «-» всё равно становится «•»
    ["    - |", "    • |"],
  ])("%j → %j", (before, after) => {
    expect(space(before)).toBe(after);
  });

  it("не начало списка — пробел как есть", () => {
    expect(space("    1. |")).toBeNull();
    expect(space("    • |")).toBeNull();
    expect(space("текст 1. |")).toBeNull();
    expect(space("1.5 |")).toBeNull();
    expect(space("1. a |")).toBeNull();
  });

  it("продолжение списка по Enter сохраняет отступ", () => {
    const r = startList("1. ", 3)!;
    expect(continueList(r.value + "а", r.cursor + 1, r.cursor + 1)?.value).toBe(
      "    1. а\n    2. ",
    );
  });
});

// «|» — курсор
const enter = (text: string) => {
  const at = text.indexOf("|");
  const r = continueList(text.replace("|", ""), at, at);
  return r && r.value.slice(0, r.cursor) + "|" + r.value.slice(r.cursor);
};

describe("tutorgo: continueList", () => {
  it.each([
    ["1. яблоко|", "1. яблоко\n2. |"],
    ["9) a|", "9) a\n10) |"],
    ["- a|", "- a\n- |"],
    ["• a|", "• a\n• |"],
    ["    3. a|", "    3. a\n    4. |"],
    ["x\n1. a|\ny", "x\n1. a\n2. |\ny"],
    ["1. ab|cd", "1. ab\n2. |cd"],
  ])("%j → %j", (before, after) => {
    expect(enter(before)).toBe(after);
  });

  it("Enter на пустом пункте стирает маркер", () => {
    expect(enter("1. a\n2. |")).toBe("1. a\n|");
    expect(enter("- a\n- |\nx")).toBe("- a\n|\nx");
  });

  it("не список или курсор внутри маркера — обычный Enter", () => {
    expect(enter("текст|")).toBeNull();
    expect(enter("1.5 кг|")).toBeNull();
    expect(enter("-a|")).toBeNull();
    expect(enter("1|. a")).toBeNull();
  });
});
