import { describe, test, expect } from "vitest";
import { Rebaser } from "../Rebaser";
import { FileChangeType } from "../utils";

const fixtures = Object.entries<{ default: string }>(
  // @ts-ignore
  import.meta.glob("./fixtures/*.diff", {
    query: "?raw",
    eager: true,
  })
).reduce<Record<string, string>>((acc, [path, module]) => {
  acc[path.substring("./fixtures/".length)] = module.default;

  return acc;
}, {});

describe("Rebaser", () => {
  describe("Applying diffs", () => {
    test("should apply changes", () => {
      const rebaser = new Rebaser([]);
      const document = ``;
      const result = rebaser.applyChanges(document, [
        {
          type: FileChangeType.MODIFY,
          dependencies: [],
          fileType: "text",
          hash: "123",
          index: 0,
          modifications: ["+Hello", "+World"],
          linesChangedCount: 2,
          modificationRange: [1, 1],
          originalHash: "123",
          path: "test.text",
        },
      ]);
      expect(result).toBe(`Hello\nWorld`);
    });
    test("should replaces lines", () => {
      const rebaser = new Rebaser([]);
      const document = `hello there`;
      const result = rebaser.applyChanges(document, [
        {
          type: FileChangeType.MODIFY,
          dependencies: [],
          fileType: "text",
          hash: "123",
          index: 0,
          modifications: ["-hello there", "+okay"],
          linesChangedCount: 0,
          modificationRange: [0, 0],
          originalHash: "123",
          path: "test.text",
        },
      ]);
      expect(result).toBe(`okay`);
    });
    test("should delete lines", () => {
      const rebaser = new Rebaser([]);
      const document = `hello there`;
      const result = rebaser.applyChanges(document, [
        {
          type: FileChangeType.MODIFY,
          dependencies: [],
          fileType: "text",
          hash: "123",
          index: 0,
          modifications: ["-hello there"],
          linesChangedCount: 1,
          modificationRange: [0, 0],
          originalHash: "123",
          path: "test.text",
        },
      ]);
      expect(result).toBe(``);
    });
    test("should handle complicated deletions and additions", () => {
      const rebaser = new Rebaser([]);
      const document = `line1\nline2\nline3`;
      const result = rebaser.applyChanges(document, [
        {
          type: FileChangeType.MODIFY,
          dependencies: [],
          fileType: "text",
          hash: "123",
          index: 0,
          modifications: [
            "-line1",
            "+line1-replace",
            "-line2",
            "-line3",
            "+line-hipp",
            "+line4",
            "+line5",
          ],
          linesChangedCount: 1,
          modificationRange: [0, 2],
          originalHash: "123",
          path: "test.text",
        },
      ]);
      expect(result).toBe(`line1-replace\nline-hipp\nline4\nline5`);
    });
  });
  describe("Rebasing", () => {
    test("Should create rebase commits", () => {
      const rebaser = new Rebaser([
        {
          commit: {
            message: "Whatever",
            hash: "123",
          },
          diff: fixtures["single_line_modification.diff"],
        },
      ]);

      expect(rebaser.rebaseCommits).toMatchSnapshot();
    });
  });
});
