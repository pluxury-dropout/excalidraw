// tutorgo: страница рендера archiver'а — рамки элементов и план пирамиды
// (план TutorGo 2026-10-30-board-archive-B-archiver, Task 2). Пиксели — Task 8 (Chromium).
import { getElementBounds } from "../element/bounds";
import { elementRects, planPyramid } from "../tutorgoRender";

import { API } from "./helpers/api";

describe("elementRects", () => {
  it("прямоугольник — запас 20", () => {
    const el = API.createElement({
      type: "rectangle",
      x: 0,
      y: 0,
      width: 100,
      height: 100,
    });
    expect(elementRects([el])).toEqual([[el.id, -20, -20, 120, 120]]);
  });

  it("freedraw — запас strokeWidth × 12", () => {
    const el = API.createElement({
      type: "freedraw",
      x: 10,
      y: 10,
      strokeWidth: 2,
      points: [
        [0, 0],
        [40, 30],
      ] as any,
    });
    const [x1, y1, x2, y2] = getElementBounds(
      el,
      new Map([[el.id, el]]) as any,
    );
    expect(elementRects([el])).toEqual([
      [el.id, x1 - 24, y1 - 24, x2 + 24, y2 + 24],
    ]);
  });

  it("надгробие пропущено", () => {
    const dead = API.createElement({ type: "rectangle", isDeleted: true });
    const live = API.createElement({ type: "ellipse" });
    expect(elementRects([dead, live]).map((r) => r[0])).toEqual([live.id]);
  });
});

const keysOf = (steps: ReturnType<typeof planPyramid>) =>
  steps.map((s) => s.key);

describe("planPyramid", () => {
  it("4 тайла уровня 1 → 0:0:0 с четырьмя детьми, -1:0:0 с одним", () => {
    const steps = planPyramid(
      ["1:0:0", "1:1:0", "1:0:1", "1:1:1"],
      1,
      -1,
      null,
      [],
    );
    expect(steps).toEqual([
      {
        level: 0,
        key: "0:0:0",
        children: [
          { key: "1:0:0", dx: 0, dy: 0 },
          { key: "1:1:0", dx: 1, dy: 0 },
          { key: "1:0:1", dx: 0, dy: 1 },
          { key: "1:1:1", dx: 1, dy: 1 },
        ],
      },
      { level: -1, key: "-1:0:0", children: [{ key: "0:0:0", dx: 0, dy: 0 }] },
    ]);
  });

  it("один тайл 1:3:3 → ребёнок 0:1:1 с dx/dy 1", () => {
    expect(planPyramid(["1:3:3"], 1, 0, null, [])).toEqual([
      { level: 0, key: "0:1:1", children: [{ key: "1:3:3", dx: 1, dy: 1 }] },
    ]);
  });

  it("отрицательные координаты — floor", () => {
    expect(planPyramid(["1:-1:-1"], 1, 0, null, [])).toEqual([
      {
        level: 0,
        key: "0:-1:-1",
        children: [{ key: "1:-1:-1", dx: 1, dy: 1 }],
      },
    ]);
    expect(planPyramid(["1:-2:-3"], 1, 0, null, [])).toEqual([
      {
        level: 0,
        key: "0:-1:-2",
        children: [{ key: "1:-2:-3", dx: 0, dy: 1 }],
      },
    ]);
  });

  it("новые грубые уровни ниже prevMin — на всю доску (prevBottom)", () => {
    const steps = planPyramid(["1:0:0"], 1, -2, 0, ["0:5:5"]);
    expect(keysOf(steps)).toEqual([
      "0:0:0",
      "-1:0:0",
      "-1:2:2",
      "-2:0:0",
      "-2:1:1",
    ]);
    expect(steps.find((s) => s.key === "-1:2:2")!.children).toEqual([
      { key: "0:5:5", dx: 1, dy: 1 },
    ]);
    // на уровнях не ниже prevMin prevBottom не участвует
    expect(keysOf(planPyramid(["1:0:0"], 1, 0, 0, ["0:5:5"]))).toEqual([
      "0:0:0",
    ]);
  });

  it("ключи без дублей, порядок детерминирован", () => {
    const a = ["1:3:1", "1:-1:0", "1:2:1", "1:0:0", "1:3:1"];
    const steps = planPyramid(a, 1, -3, null, []);
    expect(new Set(keysOf(steps)).size).toBe(steps.length);
    expect(planPyramid([...a].reverse(), 1, -3, null, [])).toEqual(steps);
    expect(keysOf(steps)).toEqual([
      "0:-1:0",
      "0:0:0",
      "0:1:0",
      "-1:-1:0",
      "-1:0:0",
      "-2:-1:0",
      "-2:0:0",
      "-3:-1:0",
      "-3:0:0",
    ]);
    expect(steps[1].children).toEqual([{ key: "1:0:0", dx: 0, dy: 0 }]);
  });
});
