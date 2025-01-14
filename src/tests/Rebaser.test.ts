import { describe, test, expect } from "vitest";
import { Rebaser } from "../Rebaser";

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

    expect(rebaser.getRebaseCommits()).toMatchSnapshot();
  });
});
