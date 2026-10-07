// tutorgo: Enter продолжает список в текстовом поле.
import { continueList } from "../tutorgo";

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
