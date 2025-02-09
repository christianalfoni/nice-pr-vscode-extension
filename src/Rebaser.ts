import {
  FileChangeType as ChangeType,
  FileChangeType,
  isLineOverlappingWithChange,
  isTextFileChange,
  mapChunkToFileChange,
} from "./utils.js";
import parseGitDiff from "parse-git-diff";
import { z } from "zod";

export const ResponseSchema = z.object({
  commits: z.array(z.string().describe("The commit message")),
  diffs: z.array(
    z.object({
      filePath: z.string().describe("The file path"),
      index: z.number().describe("The original index of the change"),
      commitIndex: z.number().describe("A reference to the commit index"),
      dependencies: z
        .array(z.number())
        .describe(
          "This change can only use a hash that is the same or later than changes referenced in this list"
        ),
      type: z.enum(["add", "delete", "modify", "rename"]),
      isDropped: z.boolean().describe("If the change is dropped"),
      lines: z
        .array(z.string())
        .optional()
        .describe("The diff lines of the change, if any"),
    })
  ),
});

export type BaseFileChange = {
  path: string;
  index: number;
  hash: string | "trash";
  originalHash: string;
  dependencies: number[];
};

export type ModifyBinaryFileChange = BaseFileChange & {
  type: ChangeType.MODIFY;
  fileType: "binary";
};

export type FileModifications = Array<`+${string}` | `-${string}`>;

export type ModifyTextFileChange = BaseFileChange & {
  type: ChangeType.MODIFY;
  fileType: "text";
  // The actual line diffs of "-" and "+". We do not have unified diffs,
  // so there can only be those kinds of lines
  modifications: FileModifications;
  // The range we need to modify to apply the modifications. When we only add,
  // the range is [5, 5] for example, but with deletions we need to capture what
  // we delete or modify, for example [5, 8], where we delete 2 lines and modify 1
  modificationRange: [number, number];
  // The number of lines being modified (Some are replaced)
  linesChangedCount: number;
};

export type RenameFileChange = BaseFileChange & {
  type: ChangeType.RENAME;
  oldFileName: string;
};

export type AddFileChange = BaseFileChange & {
  type: ChangeType.ADD;
};

export type DeleteFileChange = BaseFileChange & {
  type: ChangeType.DELETE;
};

export type FileChange =
  | ModifyTextFileChange
  | ModifyBinaryFileChange
  | RenameFileChange
  | AddFileChange
  | DeleteFileChange;

export type Commit = {
  hash: string;
  message: string;
};

export type RebaseCommit = {
  hash: string;
  message: string;
  files: RebaseCommitFile[];
  hasChangeSetBeforeDependent: boolean;
};

export type RebaseCommitFile = {
  fileName: string;
  changes: RebaseCommitFileChange[];
  hasChangeSetBeforeDependent: boolean;
  hasChanges: boolean;
};

export type RebaseCommitFileChange = FileChange & {
  isSetBeforeDependent: boolean;
};
export class Rebaser {
  private _isRebasing = false;
  private _commits: Commit[] = [];
  private _changes: FileChange[];
  private _rebaseCommits: RebaseCommit[] = [];
  private _changesCount = 0;
  get rebaseCommits() {
    return this._rebaseCommits;
  }
  // This is used to keep track of the original change references, per commit and file.
  // This way we can easily detect if a commit or file has changes in it
  private _originalChangeReferences: Record<string, Record<string, number[]>> =
    {};
  constructor(
    /**
     * Should be commits from newest to oldest
     */
    commits: {
      commit: Commit;
      diff: string;
    }[]
  ) {
    this._commits = commits.map(({ commit }) => commit).reverse();
    this._changes = this.normalizeChanges(
      this.getFileChangesOfCommits(commits)
    );
    this._originalChangeReferences = this.getOriginalChangeReferences();
    this._rebaseCommits = this.getRebaseCommits();
  }
  private getOriginalChangeReferences() {
    const changeReferences: Record<string, Record<string, number[]>> = {};

    for (const change of this._changes) {
      if (!changeReferences[change.hash]) {
        changeReferences[change.hash] = {};
      }

      if (!changeReferences[change.hash][change.path]) {
        changeReferences[change.hash][change.path] = [];
      }

      changeReferences[change.hash][change.path].push(change.index);
    }

    return changeReferences;
  }
  private getFileChangesOfCommits(
    commits: {
      commit: Commit;
      diff: string;
    }[]
  ) {
    // We grab the changes for each commit, which represents the files affected
    const diffs = commits.map(({ commit, diff }) => ({
      commit,
      diff: parseGitDiff(diff).files,
    }));

    // Then we group the changes by file. We do not actually care about the type of change,
    // the hunks themselves represents the actual changes to apply
    let changeIndex = 0;
    let fileChanges: FileChange[] = [];

    for (const { diff, commit } of diffs) {
      for (const diffChange of diff) {
        switch (diffChange.type) {
          case "AddedFile": {
            fileChanges = [
              ...fileChanges,
              {
                type: FileChangeType.ADD,
                index: changeIndex++,
                dependencies: [],
                hash: commit.hash,
                path: diffChange.path,
                originalHash: commit.hash,
              },
            ];
            break;
          }
          case "DeletedFile": {
            fileChanges = [
              ...fileChanges,
              {
                type: FileChangeType.DELETE,
                index: changeIndex++,
                // A deletion of a file depends on any changes made before the deletion
                dependencies: fileChanges
                  .filter((prevChange) => prevChange.path === diffChange.path)
                  .map((prevChange) => prevChange.index),
                hash: commit.hash,
                originalHash: commit.hash,
                path: diffChange.path,
              },
            ];
            break;
          }
          case "RenamedFile": {
            fileChanges = [
              ...fileChanges,
              {
                type: FileChangeType.RENAME,
                index: changeIndex++,
                // Renames depend on the previous file path changes
                dependencies: fileChanges
                  .filter(
                    (prevChange) => prevChange.path === diffChange.pathBefore
                  )
                  .map((prevChange) => prevChange.index),
                hash: commit.hash,
                originalHash: commit.hash,
                oldFileName: diffChange.pathBefore,
                path: diffChange.pathAfter,
              },
            ];
            break;
          }
        }

        // We do not care about the actual changes for a deleted file, as
        // the developer intended to delete the file in whatever state it was
        if (diffChange.type === "DeletedFile") {
          break;
        }

        const path =
          diffChange.type === "RenamedFile"
            ? diffChange.pathAfter
            : diffChange.path;

        fileChanges = [
          ...fileChanges,
          ...diffChange.chunks.map((chunk) =>
            mapChunkToFileChange({
              chunk,
              hash: commit.hash,
              path,
              index: changeIndex++,
              dependencies: fileChanges
                .filter(
                  (prevChange) =>
                    (prevChange.path === path &&
                      // Adding a file, renaming it or having overlapping changes means we depend on the previous change
                      prevChange.type === FileChangeType.ADD) ||
                    prevChange.type === FileChangeType.RENAME ||
                    (chunk.type === "Chunk" &&
                      isLineOverlappingWithChange(
                        chunk.fromFileRange.start,
                        prevChange
                      ))
                )
                .map((prevChange) => prevChange.index),
            })
          ),
        ];
      }
    }

    return fileChanges;
  }

  // This will effectively remove the line additions from previous changes of each change.
  // We will also track dependents of each change, so that we can show a warning if a change
  // depending on another change is moved before it. The dependents does not affect
  // the normalized change
  private normalizeChanges(changes: FileChange[]): FileChange[] {
    const normalizedChanges = structuredClone(changes);

    // We go through each change
    for (const currentChange of normalizedChanges) {
      // We only normalize actual text changes
      if (!isTextFileChange(currentChange)) {
        continue;
      }

      // And then find all changes affecting the line number
      // of this current change

      // We need to keep track of the accumulated changes up to the current hash,
      // cause line changes within a hash does not affect the oldStart
      let normalizeOffset = 0;

      for (const previousChange of changes) {
        // We only normalize actual text changes
        if (
          !isTextFileChange(previousChange) ||
          previousChange.path !== currentChange.path
        ) {
          continue;
        }

        // We only iterate up to the current change
        if (previousChange.index === currentChange.index) {
          break;
        }

        // We only want to adjust the current change if the previous change
        // was on a line before the current change
        if (
          previousChange.modificationRange[0] <=
          currentChange.modificationRange[0]
        ) {
          // We adjust the range as if the previous changes did not happen. We do this by simply
          // reversing the count of lines changed
          normalizeOffset += previousChange.linesChangedCount * -1;
        }
      }

      currentChange.modificationRange[0] += normalizeOffset;
      currentChange.modificationRange[1] += normalizeOffset;
    }

    return normalizedChanges;
  }
  private sortChanges(changes: FileChange[]) {
    changes.sort((a, b) => {
      const aIndex = this._commits.findIndex(
        (commit) => commit.hash === a.hash
      );
      const bIndex = this._commits.findIndex(
        (commit) => commit.hash === b.hash
      );
      const isSameFile = a.path === b.path;
      const isSameHash = a.hash === b.hash;
      const isSameFileAndHash = isSameFile && isSameHash;

      // Actual file operation changes should always come first
      if (
        isSameFileAndHash &&
        a.type !== ChangeType.MODIFY &&
        b.type === ChangeType.MODIFY
      ) {
        return -1;
      } else if (
        isSameFileAndHash &&
        a.type === ChangeType.MODIFY &&
        b.type !== ChangeType.MODIFY
      ) {
        return 1;
      }

      if (
        isSameFileAndHash &&
        a.type === ChangeType.MODIFY &&
        b.type === ChangeType.MODIFY &&
        a.fileType === "text" &&
        b.fileType === "text"
      ) {
        // We just need to sort by when they where originally created,
        // we do not care about sorting by the actual line number
        return a.index - b.index;
      }

      return bIndex - aIndex;
    });
  }
  private getChangeFromRef(fileName: string, changeRef: FileChange) {
    const changes = this._changes.filter((change) => change.path === fileName);

    const change = changes.find((change) => change.index === changeRef.index);

    if (!change) {
      throw new Error("Could not find change");
    }

    return change;
  }
  getTrash() {
    const trashChanges = this._changes.filter(
      (change) => change.hash === "trash"
    );
    const trash: RebaseCommitFile[] = [];

    for (const change of trashChanges) {
      let commitFile = trash.find((item) => item.fileName === change.path);

      if (!commitFile) {
        commitFile = {
          changes: [],
          fileName: change.path,
          hasChangeSetBeforeDependent: false,
          hasChanges: false,
        };
        trash.push(commitFile);
      }

      commitFile.changes.push({
        ...change,
        isSetBeforeDependent: false,
      });
    }

    return trash;
  }
  // This will rebuild the changes with the correct starting position
  private createFileChanges(changes: FileChange[]): FileChange[] {
    const hashIndexes = this._commits.map((commit) => commit.hash).reverse();

    // We make a copy of the normalized changes to avoid modifying the original
    const changesCopy = structuredClone(changes);

    // We'll go through each change and find all previous changes
    // affecting its line number
    for (const change of changesCopy) {
      // We only normalize actual text changes
      if (!isTextFileChange(change)) {
        continue;
      }

      // There is a difference of how oldStart and newStart accumulates. OldStart
      // is the accumulated changes up to the hash, while NewStart is the accumulated
      // changes up to that hash + any preceeding changes within that hash
      let currentLineChangesCount = 0;
      let currentHash = changesCopy[0].hash;

      // We'll go through all previous changes to find changes affecting the current.
      // We can iterate the same changes as we only count lines, not the starting position
      for (const previousChange of changesCopy) {
        // We only normalize actual text changes
        if (
          !isTextFileChange(previousChange) ||
          previousChange.path !== change.path
        ) {
          continue;
        }

        if (
          hashIndexes.indexOf(previousChange.hash) >
          hashIndexes.indexOf(change.hash)
        ) {
          break;
        }

        // We only care about changes made on lines before the current change,
        // as those are the only lines that affects the starting position. Also
        // we do not adjust the starting position if the previous change is a dependent
        if (
          change.modificationRange[0] > previousChange.modificationRange[0] &&
          !change.dependencies.includes(previousChange.index)
        ) {
          // We adjust the range by now applying the actual changes before this change
          currentLineChangesCount += previousChange.linesChangedCount;
        }

        if (previousChange.hash !== currentHash) {
          currentHash = previousChange.hash;
        }
      }

      change.modificationRange[0] += currentLineChangesCount;
      change.modificationRange[1] += currentLineChangesCount;
    }

    return changesCopy;
  }
  private getRebaseCommits(): RebaseCommit[] {
    const rebaseCommitsByHash = this._commits.reduce<
      Record<string, RebaseCommit>
    >((acc, commit) => {
      acc[commit.hash] = {
        hash: commit.hash,
        message: commit.message,
        files: [],
        hasChangeSetBeforeDependent: false,
      };

      return acc;
    }, {});

    const changesCopy = this.createFileChanges(this._changes);

    for (const change of changesCopy) {
      if (change.hash === "trash") {
        continue;
      }

      const rebaseCommit = rebaseCommitsByHash[change.hash];
      const file = rebaseCommit.files.find(
        (file) => file.fileName === change.path
      );

      let isSetBeforeDependent = false;

      if (change.dependencies.length) {
        for (const dependency of change.dependencies) {
          const dependent = changesCopy.find(
            (otherChange) => otherChange.index === dependency
          )!;
          const changeIndex = changesCopy.indexOf(change);
          const isInTrash = dependent.hash === "trash";

          if (changesCopy.indexOf(dependent) > changeIndex && !isInTrash) {
            isSetBeforeDependent = true;
            break;
          }
        }
      }

      if (file) {
        rebaseCommit.hasChangeSetBeforeDependent =
          rebaseCommit.hasChangeSetBeforeDependent || isSetBeforeDependent;
        file.hasChangeSetBeforeDependent =
          file.hasChangeSetBeforeDependent || isSetBeforeDependent;

        file.changes.push({
          ...change,
          isSetBeforeDependent,
        });
      } else {
        rebaseCommit.hasChangeSetBeforeDependent =
          rebaseCommit.hasChangeSetBeforeDependent
            ? true
            : isSetBeforeDependent;
        rebaseCommit.files.push({
          fileName: change.path,
          changes: [
            {
              ...change,
              isSetBeforeDependent,
            },
          ],
          hasChangeSetBeforeDependent: isSetBeforeDependent,
          hasChanges: false,
        });
      }
    }

    for (const hash in rebaseCommitsByHash) {
      const commit = rebaseCommitsByHash[hash];

      for (const file of commit.files) {
        // If no original reference it has changes
        if (!this._originalChangeReferences[hash]?.[file.fileName]) {
          file.hasChanges = true;
          continue;
        }

        const originalChangeIndexes = file.changes.map(
          (change) => change.index
        );
        const changeIndexes =
          this._originalChangeReferences[hash]?.[file.fileName];
        const hasFileChanges =
          String(originalChangeIndexes) !== String(changeIndexes);

        if (hasFileChanges) {
          file.hasChanges = true;
        }
      }
    }

    return this._commits.map((commit) => rebaseCommitsByHash[commit.hash]);
  }
  private generateHash() {
    return "new-" + Math.random().toString(36).substring(2, 15);
  }
  getChangesCount() {
    return this._changesCount;
  }
  addCommit(message: string) {
    const hash = this.generateHash();

    this._commits.unshift({
      hash,
      message,
    });

    this._rebaseCommits = this.getRebaseCommits();
  }
  removeCommit(hash: string) {
    const commit = this._commits.find((commit) => commit.hash === hash);

    if (!commit) {
      throw new Error("Could not find commit");
    }

    if (this._changes.some((change) => change.hash === hash)) {
      throw new Error("Commit has files");
    }

    const index = this._commits.indexOf(commit);
    this._commits.splice(index, 1);
    this._rebaseCommits = this.getRebaseCommits();
    this._changesCount++;
  }
  updateCommitMessage(hash: string, newMessage: string) {
    const commit = this._commits.find((commit) => commit.hash === hash);

    if (!commit) {
      throw new Error("Could not find commit");
    }

    commit.message = newMessage;

    this._rebaseCommits = this.getRebaseCommits();
    this._changesCount++;
  }
  getChangesForFile(fileName: string) {
    const fileChanges = this._changes.filter(
      (change) => change.path === fileName
    );

    return this.createFileChanges(fileChanges);
  }
  getHashesForFile(fileName: string) {
    const fileChanges = this._changes.filter(
      (change) => change.path === fileName
    );
    const allHashes = fileChanges.map((change) => change.hash);

    // Only unique hashes
    return Array.from(new Set(allHashes));
  }
  getChangesForFileByHash(fileName: string, hash: string) {
    const changes = this.getChangesForFile(fileName);

    const allHashes = this._commits.map((commit) => commit.hash).reverse();
    const hashIndex = allHashes.indexOf(hash);
    const includedHashes = allHashes.filter(
      (currentHash) => allHashes.indexOf(currentHash) <= hashIndex
    );

    return changes.filter((change) => {
      return includedHashes.includes(change.hash);
    });
  }
  applyChanges(document: string, changes: FileChange[]) {
    const lines = document.length ? document.split("\n") : [];

    for (const change of changes) {
      if (!isTextFileChange(change)) {
        continue;
      }

      const chunkSize =
        change.modificationRange[1] - change.modificationRange[0] + 1;
      const startIndex = change.modificationRange[0];
      const chunk = lines.splice(startIndex, chunkSize);
      let offset = 0;

      for (const modification of change.modifications) {
        if (modification.startsWith("-")) {
          chunk.splice(offset, 1);
        } else if (modification.startsWith("+")) {
          chunk.splice(offset, 0, modification.slice(1));
          offset++;
        }
      }

      lines.splice(startIndex, 0, ...chunk);
    }

    return lines.join("\n");
  }
  // Moves a commit in the array after a target hash. If after trash, it is put
  // on the first index
  moveCommit(hash: string, afterRef?: string | "trash") {
    const commit = this._commits.find((commit) => commit.hash === hash);

    if (!commit) {
      throw new Error("Could not find commit");
    }

    const currentIndex = this._commits.indexOf(commit);

    this._commits.splice(currentIndex, 1);

    if (afterRef === "trash") {
      this._changes.forEach((change) => {
        if (change.hash === hash) {
          change.hash = "trash";
        }
      });
      this.sortChanges(this._changes);

      return;
    }

    const targetIndex = this._commits.findIndex(
      (commit) => commit.hash === afterRef
    );

    if (targetIndex === -1) {
      throw new Error("Could not find target");
    }

    this._commits.splice(targetIndex, 0, commit);

    this.sortChanges(this._changes);

    this._rebaseCommits = this.getRebaseCommits();
    this._changesCount++;
  }
  // Change to using the index, which should be called changeIndex
  moveChange(fileName: string, changeRef: FileChange, targetHash: string) {
    const change = this.getChangeFromRef(fileName, changeRef);
    change.hash = targetHash;
    this.sortChanges(this._changes);

    this._rebaseCommits = this.getRebaseCommits();
    this._changesCount++;
  }
  getFileChangeType(fileName: string) {
    const changes = this._changes.filter((change) => change.path === fileName);

    if (changes.length === 0) {
      throw new Error("Can not derive file operation from empty changes");
    }

    let fileOperation = changes[0].type;

    for (const change of changes) {
      if (
        fileOperation === ChangeType.MODIFY &&
        change.type !== ChangeType.MODIFY
      ) {
        fileOperation = change.type;
        continue;
      }
    }

    return fileOperation;
  }
  getSuggestionDiffs(): Omit<
    z.infer<typeof ResponseSchema>["diffs"][number],
    "commitIndex"
  >[] {
    return this._changes.map((change) => ({
      dependencies: change.dependencies,
      filePath: change.path,
      isDropped: false,
      index: change.index,
      type:
        change.type === FileChangeType.ADD
          ? "add"
          : change.type === FileChangeType.DELETE
          ? "delete"
          : change.type === FileChangeType.MODIFY
          ? "modify"
          : "rename",
      lines:
        change.type === FileChangeType.MODIFY && change.fileType === "text"
          ? change.modifications
          : undefined,
    }));
  }
  setSuggestedRebaseCommits(suggestions: z.infer<typeof ResponseSchema>) {
    this._commits = suggestions.commits.map((message) => ({
      hash: this.generateHash(),
      message,
    }));

    for (const diff of suggestions.diffs) {
      const change = this._changes.find(
        (change) => change.index === diff.index
      );

      if (!change) {
        throw new Error("Could not find change");
      }

      change.hash = diff.isDropped
        ? "trash"
        : this._commits[diff.commitIndex].hash;
    }

    this.sortChanges(this._changes);

    this._rebaseCommits = this.getRebaseCommits();
  }
}
