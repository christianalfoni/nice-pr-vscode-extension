import { describe, it, expect } from "vitest";
import {
  FileChange,
  RebaseCommit,
  RebaseCommitFileChange,
  Rebaser,
  Commit,
} from "./Rebaser";
import { FileChangeType } from "./utils";
import { isSet } from "util/types";

describe("Rebaser", () => {
  describe("getRebaseCommits", () => {
    it("should return a structure ideal for the view", () => {
      const commit1 = {
        hash: "123",
        message: "foo",
      };
      const commits: Commit[] = [commit1];
      const changes: FileChange[] = [
        {
          index: 0,
          fileOperation: FileChangeType.MODIFY,
          hash: commit1.hash,
          oldStart: 1,
          newStart: 1,
          oldLines: 1,
          newLines: 1,
          lines: ["-foo", "+bar"],
          dependencies: [],
        },
      ];
      const rebaser = new Rebaser("foo", commits, { "package.json": changes });
      const rebaseCommits: RebaseCommit[] = [
        {
          hash: commit1.hash,
          message: commit1.message,
          files: [
            {
              fileName: "package.json",
              changes: changes.map((change) => ({
                ...change,
                isSetBeforeDependent: false,
              })),
              hasChangeSetBeforeDependent: false,
            },
          ],
          hasChangeSetBeforeDependent: false,
        },
      ];
      expect(rebaser.getRebaseCommits()).toEqual(rebaseCommits);
    });

    it("should handle multiple commits and files", () => {
      const commit1 = {
        hash: "123",
        message: "first commit",
      };
      const commit2 = {
        hash: "456",
        message: "second commit",
      };
      const commits: Commit[] = [commit1, commit2];

      const packageChanges: FileChange[] = [
        {
          index: 0,
          fileOperation: FileChangeType.MODIFY,
          hash: commit1.hash,
          oldStart: 1,
          newStart: 1,
          oldLines: 1,
          newLines: 1,
          lines: ["-foo", "+bar"],
          dependencies: [],
        },
      ];

      const readmeChanges: FileChange[] = [
        {
          index: 1,
          fileOperation: FileChangeType.ADD,
          hash: commit2.hash,
          oldStart: 0,
          newStart: 1,
          oldLines: 0,
          newLines: 2,
          lines: ["+# Project", "+Description"],
          dependencies: [],
        },
      ];

      const rebaser = new Rebaser("foo", commits, {
        "package.json": packageChanges,
        "README.md": readmeChanges,
      });

      expect(rebaser.getRebaseCommits()).toEqual([
        {
          hash: commit1.hash,
          message: commit1.message,
          files: [
            {
              fileName: "package.json",
              changes: packageChanges.map((change) => ({
                ...change,
                isSetBeforeDependent: false,
              })),
              hasChangeSetBeforeDependent: false,
            },
          ],
          hasChangeSetBeforeDependent: false,
        },
        {
          hash: commit2.hash,
          message: commit2.message,
          files: [
            {
              fileName: "README.md",
              changes: readmeChanges.map((change) => ({
                ...change,
                isSetBeforeDependent: false,
              })),
              hasChangeSetBeforeDependent: false,
            },
          ],
          hasChangeSetBeforeDependent: false,
        },
      ]);
    });
  });

  it("should not normalize changes that are overlapping", () => {
    const commit1 = {
      hash: "123",
      message: "first commit",
    };
    const commit2 = {
      hash: "456",
      message: "second commit",
    };
    const commits: Commit[] = [commit2, commit1];

    // First change adds 2 lines, which would normally offset the second change
    const changes: FileChange[] = [
      {
        index: 0,
        fileOperation: FileChangeType.MODIFY,
        hash: commit1.hash,
        oldStart: 1,
        newStart: 1,
        oldLines: 1,
        newLines: 3, // Adding 2 new lines
        lines: ["-original", "+modified", "+new line 1", "+new line 2"],
        dependencies: [],
      },
      {
        index: 1,
        fileOperation: FileChangeType.MODIFY,
        hash: commit2.hash,
        oldStart: 2,
        newStart: 2,
        oldLines: 1,
        newLines: 1,
        lines: ["-old content", "+new content"],
        dependencies: [],
      },
    ];

    const rebaser = new Rebaser("foo", commits, {
      "test.txt": changes,
    });

    expect(rebaser["_changes"]["test.txt"][0]).toEqual({
      index: 0,
      fileOperation: FileChangeType.MODIFY,
      hash: commit1.hash,
      oldStart: 1,
      newStart: 1,
      oldLines: 1,
      newLines: 3,
      lines: ["-original", "+modified", "+new line 1", "+new line 2"],
      dependents: [],
    });
    expect(rebaser["_changes"]["test.txt"][1]).toEqual({
      index: 1,
      fileOperation: FileChangeType.MODIFY,
      hash: commit2.hash,
      oldStart: 2,
      newStart: 2,
      oldLines: 1,
      newLines: 1,
      lines: ["-old content", "+new content"],
      dependents: [0],
    });

    // We need to also rebuild the correct line number in getRebaseCommits on overlapping changes
    expect(rebaser.getRebaseCommits()).toEqual([
      {
        hash: commit2.hash,
        message: commit2.message,
        files: [
          {
            fileName: "test.txt",
            changes: [
              { ...changes[1], isSetBeforeDependent: false, dependents: [0] },
            ],
            hasChangeSetBeforeDependent: false,
          },
        ],
        hasChangeSetBeforeDependent: false,
      },
      {
        hash: commit1.hash,
        message: commit1.message,
        files: [
          {
            fileName: "test.txt",
            changes: [{ ...changes[0], isSetBeforeDependent: false }],
            hasChangeSetBeforeDependent: false,
          },
        ],
        hasChangeSetBeforeDependent: false,
      },
    ]);
  });

  it("should normalize changes by adjusting line numbers based on previous changes", () => {
    const commit1 = {
      hash: "123",
      message: "first commit",
    };
    const commit2 = {
      hash: "456",
      message: "second commit",
    };
    const commits: Commit[] = [commit2, commit1];

    // First change adds 2 lines, which would normally offset the second change
    const changes: FileChange[] = [
      {
        index: 0,
        fileOperation: FileChangeType.MODIFY,
        hash: commit1.hash,
        oldStart: 1,
        newStart: 1,
        oldLines: 1,
        newLines: 3, // Adding 2 new lines
        lines: ["-original", "+modified", "+new line 1", "+new line 2"],
        dependencies: [],
      },
      {
        index: 1,
        fileOperation: FileChangeType.MODIFY,
        hash: commit2.hash,
        oldStart: 7,
        newStart: 7,
        oldLines: 1,
        newLines: 1,
        lines: ["-old content", "+new content"],
        dependencies: [],
      },
    ];

    const rebaser = new Rebaser("foo", commits, {
      "test.txt": changes,
    });

    // The changes should normalize
    expect(rebaser["_changes"]["test.txt"][0]).toEqual({
      index: 0,
      fileOperation: FileChangeType.MODIFY,
      hash: commit1.hash,
      oldStart: 1,
      newStart: 1,
      oldLines: 1,
      newLines: 3,
      lines: ["-original", "+modified", "+new line 1", "+new line 2"],
      dependents: [],
    });
    expect(rebaser["_changes"]["test.txt"][1]).toEqual({
      index: 1,
      fileOperation: FileChangeType.MODIFY,
      hash: commit2.hash,
      oldStart: 5,
      newStart: 5,
      oldLines: 1,
      newLines: 1,
      lines: ["-old content", "+new content"],
      dependents: [],
    });

    expect(rebaser.getRebaseCommits()).toEqual([
      {
        hash: commit2.hash,
        message: commit2.message,
        files: [
          {
            fileName: "test.txt",
            changes: [{ ...changes[1], isSetBeforeDependent: false }],
            hasChangeSetBeforeDependent: false,
          },
        ],
        hasChangeSetBeforeDependent: false,
      },
      {
        hash: commit1.hash,
        message: commit1.message,
        files: [
          {
            fileName: "test.txt",
            changes: [{ ...changes[0], isSetBeforeDependent: false }],
            hasChangeSetBeforeDependent: false,
          },
        ],
        hasChangeSetBeforeDependent: false,
      },
    ]);
  });

  it("should normalize changes by adjusting line numbers when lines are removed", () => {
    const commit1 = {
      hash: "123",
      message: "first commit",
    };
    const commit2 = {
      hash: "456",
      message: "second commit",
    };
    const commits: Commit[] = [commit2, commit1];

    // First change removes 2 lines, which should offset the second change
    const changes: FileChange[] = [
      {
        index: 0,
        fileOperation: FileChangeType.MODIFY,
        hash: commit1.hash,
        oldStart: 1,
        newStart: 1,
        oldLines: 3, // Removing 2 lines
        newLines: 1,
        lines: [
          "-original",
          "-to be removed 1",
          "-to be removed 2",
          "+modified",
        ],
        dependencies: [],
      },
      {
        index: 1,
        fileOperation: FileChangeType.MODIFY,
        hash: commit2.hash,
        oldStart: 8,
        newStart: 8,
        oldLines: 1,
        newLines: 1,
        lines: ["-old content", "+new content"],
        dependencies: [],
      },
    ];

    const rebaser = new Rebaser("foo", commits, {
      "test.txt": changes,
    });

    // The second change should be adjusted by -2 lines due to the removal
    expect(rebaser["_changes"]["test.txt"][1]).toEqual({
      index: 1,
      fileOperation: FileChangeType.MODIFY,
      hash: commit2.hash,
      oldStart: 10,
      newStart: 10,
      oldLines: 1,
      newLines: 1,
      lines: ["-old content", "+new content"],
      dependents: [],
    });

    expect(rebaser.getRebaseCommits()).toEqual([
      {
        hash: commit2.hash,
        message: commit2.message,
        files: [
          {
            fileName: "test.txt",
            changes: [{ ...changes[1], isSetBeforeDependent: false }],
            hasChangeSetBeforeDependent: false,
          },
        ],
        hasChangeSetBeforeDependent: false,
      },
      {
        hash: commit1.hash,
        message: commit1.message,
        files: [
          {
            fileName: "test.txt",
            changes: [{ ...changes[0], isSetBeforeDependent: false }],
            hasChangeSetBeforeDependent: false,
          },
        ],
        hasChangeSetBeforeDependent: false,
      },
    ]);
  });

  it("should correctly adjust line numbers when moving changes between commits", () => {
    const commit1 = {
      hash: "123",
      message: "first commit",
    };
    const commit2 = {
      hash: "456",
      message: "second commit",
    };
    const commits: Commit[] = [commit2, commit1];

    const changes: FileChange[] = [
      {
        index: 0,
        fileOperation: FileChangeType.MODIFY,
        hash: commit1.hash,
        oldStart: 1,
        newStart: 1,
        oldLines: 1,
        newLines: 3, // Adding 2 new lines
        lines: ["-original", "+modified", "+new line 1", "+new line 2"],
        dependencies: [],
      },
      {
        index: 1,
        fileOperation: FileChangeType.MODIFY,
        hash: commit2.hash,
        oldStart: 10,
        newStart: 10,
        oldLines: 1,
        newLines: 1,
        lines: ["-old content", "+new content"],
        dependencies: [],
      },
    ];

    const rebaser = new Rebaser("foo", commits, {
      "test.txt": changes,
    });

    const change = rebaser["_changes"]["test.txt"][1];

    // Move the second change to the first commit
    rebaser.moveChange("test.txt", change, commit1.hash);

    // The second change should now be part of the first commit and line numbers adjusted
    expect(rebaser.getRebaseCommits()).toEqual([
      {
        hash: commit2.hash,
        message: commit2.message,
        files: [],
        hasChangeSetBeforeDependent: false,
      },
      {
        hash: commit1.hash,
        message: commit1.message,
        files: [
          {
            fileName: "test.txt",
            changes: [
              { ...changes[0], isSetBeforeDependent: false },
              {
                index: 1,
                fileOperation: "MODIFY",
                hash: commit1.hash,
                oldStart: 8,
                newStart: 10,
                oldLines: 1,
                newLines: 1,
                lines: ["-old content", "+new content"],
                dependents: [],
                isSetBeforeDependent: false,
              },
            ],
            hasChangeSetBeforeDependent: false,
          },
        ],
        hasChangeSetBeforeDependent: false,
      },
    ]);
  });

  it("should correctly adjust line numbers when moving changes between commits with line removal", () => {
    const commit1 = {
      hash: "123",
      message: "first commit",
    };
    const commit2 = {
      hash: "456",
      message: "second commit",
    };
    const commits: Commit[] = [commit2, commit1];

    const changes: FileChange[] = [
      {
        index: 0,
        fileOperation: FileChangeType.MODIFY,
        hash: commit1.hash,
        oldStart: 1,
        newStart: 1,
        oldLines: 3,
        newLines: 1, // Removing 2 lines
        lines: ["-line 1", "-line 2", "-line 3", "+modified line"],
        dependencies: [],
      },
      {
        index: 1,
        fileOperation: FileChangeType.MODIFY,
        hash: commit2.hash,
        oldStart: 10,
        newStart: 10,
        oldLines: 1,
        newLines: 1,
        lines: ["-old content", "+new content"],
        dependencies: [],
      },
    ];

    const rebaser = new Rebaser("foo", commits, {
      "test.txt": changes,
    });

    const change = rebaser["_changes"]["test.txt"][1];

    // Move the second change to the first commit
    rebaser.moveChange("test.txt", change, commit1.hash);

    // The second change should now be part of the first commit with adjusted line numbers
    expect(rebaser.getRebaseCommits()).toEqual([
      {
        hash: commit2.hash,
        message: commit2.message,
        files: [],
        hasChangeSetBeforeDependent: false,
      },
      {
        hash: commit1.hash,
        message: commit1.message,
        files: [
          {
            fileName: "test.txt",
            changes: [
              { ...changes[0], isSetBeforeDependent: false },
              {
                index: 1,
                fileOperation: "MODIFY",
                hash: commit1.hash,
                oldStart: 12,
                newStart: 10,
                oldLines: 1,
                newLines: 1,
                lines: ["-old content", "+new content"],
                dependents: [],
                isSetBeforeDependent: false,
              },
            ],
            hasChangeSetBeforeDependent: false,
          },
        ],
        hasChangeSetBeforeDependent: false,
      },
    ]);
  });

  it("should verify document state after moving changes between commits", () => {
    const commit1 = {
      hash: "123",
      message: "first commit",
    };
    const commit2 = {
      hash: "456",
      message: "second commit",
    };
    const commits: Commit[] = [commit1, commit2];

    const initialDocument = "line1\nline2\nline3\nline4\n";

    const changes: FileChange[] = [
      {
        index: 0,
        fileOperation: FileChangeType.MODIFY,
        hash: commit1.hash,
        oldStart: 2,
        newStart: 2,
        oldLines: 1,
        newLines: 3,
        lines: ["-line2", "+newline2", "+inserted1", "+inserted2"],
        dependencies: [],
      },
      {
        index: 1,
        fileOperation: FileChangeType.MODIFY,
        hash: commit2.hash,
        oldStart: 5,
        newStart: 5,
        oldLines: 1,
        newLines: 1,
        lines: ["-line4", "+modified4"],
        dependencies: [],
      },
    ];

    const rebaser = new Rebaser("foo", commits, {
      "test.txt": changes,
    });

    const change = rebaser["_changes"]["test.txt"][1];

    // Move the second change to the first commit
    rebaser.moveChange("test.txt", change, commit1.hash);

    const rebaseCommits = rebaser.getRebaseCommits();
    const firstCommitChanges = rebaseCommits[0].files[0].changes;

    // Apply changes and verify the final document state
    const result = rebaser.applyChanges(initialDocument, firstCommitChanges);

    expect(result).toBe(
      "line1\nnewline2\ninserted1\ninserted2\nline3\nmodified4\n"
    );
  });

  it("should verify document state after moving first change to second commit", () => {
    const commit1 = {
      hash: "123",
      message: "first commit",
    };
    const commit2 = {
      hash: "456",
      message: "second commit",
    };
    const commits: Commit[] = [commit1, commit2];

    const initialDocument = "line1\nline2\nline3\nline4\n";

    const changes: FileChange[] = [
      {
        index: 0,
        fileOperation: FileChangeType.MODIFY,
        hash: commit1.hash,
        oldStart: 2,
        newStart: 2,
        oldLines: 1,
        newLines: 3,
        lines: ["-line2", "+newline2", "+inserted1", "+inserted2"],
        dependencies: [],
      },
      {
        index: 1,
        fileOperation: FileChangeType.MODIFY,
        hash: commit2.hash,
        oldStart: 5,
        newStart: 5,
        oldLines: 1,
        newLines: 1,
        lines: ["-line4", "+modified4"],
        dependencies: [],
      },
    ];

    const rebaser = new Rebaser("foo", commits, {
      "test.txt": changes,
    });

    const change = rebaser["_changes"]["test.txt"][0];

    // Move the first change to the second commit
    rebaser.moveChange("test.txt", change, commit2.hash);

    const rebaseCommits = rebaser.getRebaseCommits();
    const secondCommitChanges = rebaseCommits[1].files[0].changes;

    // Apply changes and verify the final document state
    const result = rebaser.applyChanges(initialDocument, secondCommitChanges);

    expect(result).toBe(
      "line1\nnewline2\ninserted1\ninserted2\nline3\nmodified4\n"
    );
  });

  it("should move a change to trash and maintain correct document state", () => {
    const commit1 = {
      hash: "123",
      message: "first commit",
    };
    const commits: Commit[] = [commit1];

    const changes: FileChange[] = [
      {
        index: 0,
        fileOperation: FileChangeType.MODIFY,
        hash: commit1.hash,
        oldStart: 2,
        newStart: 2,
        oldLines: 1,
        newLines: 2,
        lines: ["-line2", "+newline2", "+inserted1"],
        dependencies: [],
      },
    ];

    const rebaser = new Rebaser("foo", commits, {
      "test.txt": changes,
    });

    const change = rebaser["_changes"]["test.txt"][0];

    rebaser.moveChangeToTrash("test.txt", change);

    const rebaseCommits = rebaser.getRebaseCommits();
    expect(rebaseCommits[0].files).toHaveLength(0);
  });

  it("should move a change from trash to commit and maintain correct document state", () => {
    const commit1 = {
      hash: "123",
      message: "first commit",
    };
    const commits: Commit[] = [commit1];

    const change: FileChange = {
      index: 0,
      fileOperation: FileChangeType.MODIFY,
      hash: commit1.hash,
      oldStart: 2,
      newStart: 2,
      oldLines: 1,
      newLines: 2,
      lines: ["-line2", "+newline2", "+inserted1"],
      dependencies: [],
    };

    const rebaser = new Rebaser("foo", commits, {
      "test.txt": [change],
    });

    const currentChange = rebaser["_changes"]["test.txt"][0];

    // First move to trash
    rebaser.moveChangeToTrash("test.txt", currentChange);
    // Then move back to commit
    rebaser.moveChangeFromTrash("test.txt", currentChange, commit1.hash);

    const rebaseCommits = rebaser.getRebaseCommits();
    expect(rebaseCommits[0].files[0].changes).toEqual([
      {
        ...change,
        hash: commit1.hash,
        isSetBeforeDependent: false,
      },
    ]);
  });

  it("should highlight dependents of overlapping changes", () => {
    const commit1 = {
      hash: "123",
      message: "first commit",
    };
    const commit2 = {
      hash: "456",
      message: "second commit",
    };
    const commit3 = {
      hash: "789",
      message: "third commit",
    };
    const commits: Commit[] = [commit3, commit2, commit1];

    // First change adds 2 lines, which would normally offset the second change
    const changes: FileChange[] = [
      {
        index: 0,
        fileOperation: FileChangeType.MODIFY,
        hash: commit2.hash,
        oldStart: 1,
        newStart: 1,
        oldLines: 1,
        newLines: 3, // Adding 2 new lines
        lines: ["-original", "+modified", "+new line 1", "+new line 2"],
        dependencies: [],
      },
      {
        index: 1,
        fileOperation: FileChangeType.MODIFY,
        hash: commit3.hash,
        oldStart: 2,
        newStart: 2,
        oldLines: 1,
        newLines: 1,
        lines: ["-old content", "+new content"],
        dependencies: [],
      },
    ];

    const rebaser = new Rebaser("foo", commits, {
      "test.txt": changes,
    });

    // The changes should normalize
    expect(rebaser["_changes"]["test.txt"][0]).toEqual({
      index: 0,
      fileOperation: FileChangeType.MODIFY,
      hash: commit2.hash,
      oldStart: 1,
      newStart: 1,
      oldLines: 1,
      newLines: 3,
      lines: ["-original", "+modified", "+new line 1", "+new line 2"],
      dependents: [],
    });
    expect(rebaser["_changes"]["test.txt"][1]).toEqual({
      index: 1,
      fileOperation: FileChangeType.MODIFY,
      hash: commit3.hash,
      oldStart: 2,
      newStart: 2,
      oldLines: 1,
      newLines: 1,
      lines: ["-old content", "+new content"],
      dependents: [0],
    });

    rebaser.moveChange("test.txt", changes[1], commit1.hash);

    expect(rebaser.getRebaseCommits()).toEqual([
      {
        hash: commit3.hash,
        message: commit3.message,
        files: [],
        hasChangeSetBeforeDependent: false,
      },
      {
        hash: commit2.hash,
        message: commit2.message,
        files: [
          {
            fileName: "test.txt",
            changes: [{ ...changes[0], isSetBeforeDependent: false }],
            hasChangeSetBeforeDependent: false,
          },
        ],
        hasChangeSetBeforeDependent: false,
      },
      {
        hash: commit1.hash,
        message: commit1.message,
        files: [
          {
            fileName: "test.txt",
            changes: [
              {
                ...changes[1],
                hash: commit1.hash,
                dependencies: [0],
                isSetBeforeDependent: true,
              },
            ],
            hasChangeSetBeforeDependent: true,
          },
        ],
        hasChangeSetBeforeDependent: true,
      },
    ]);
  });
});
