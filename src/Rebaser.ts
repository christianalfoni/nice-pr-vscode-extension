import * as git from "./git";
import { applyPatch, applyPatches, Hunk, parsePatch } from "diff";

/**
 * 1. Introduce an apply index, so that we can sort overlapping changes
 * 2. Introduce trash
 * 3. When showing the rebase data, show an error if oldStart is minus
 */

import { FileChangeType as ChangeType, isTextFileChange } from "./utils";

export type BaseFileChange = {
  path: string;
  index: number;
  hash: string;
  dependents: number[];
};

// TODO: When building up the file operations for rebase, read the binary files at the initial hash, which
// is still the current hash
export type ModifyBinaryFileChange = BaseFileChange & {
  type: ChangeType.MODIFY;
  fileType: "binary";
};

export type ModifyTextFileChange = BaseFileChange &
  Hunk & {
    type: ChangeType.MODIFY;
    fileType: "text";
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
};

export type RebaseCommitFileChange = FileChange & {
  isSetBeforeDependent: boolean;
};

export class Rebaser {
  private _isRebasing = false;
  private _trash: FileChange[] = [];
  private _commits: Commit[] = [];
  private _changes: FileChange[];
  constructor(
    private _branch: string,
    /**
     * Should be commits from newest to oldest
     */
    _commits: Commit[],
    /**
     * Should be changes from oldest to newest
     */
    _changes: FileChange[]
  ) {
    this._commits = _commits.map((commit) => ({
      hash: commit.hash,
      message: commit.message,
    }));

    this._changes = this.normalizeChanges(_changes);
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
      let oldStart = 0;
      let newStart = 0;
      const dependents: number[] = [];

      for (const originalChange of changes) {
        // We only normalize actual text changes
        if (
          !isTextFileChange(originalChange) ||
          originalChange.path !== currentChange.path
        ) {
          continue;
        }

        // We only iterate up to the current change
        if (originalChange.index === currentChange.index) {
          break;
        }

        // Changes beyond this line does not affect the starting position. We include
        // any overlaps here, because we'll ensure order of overlaps, which will result
        // in the same result
        if (
          originalChange.oldStart + originalChange.oldLines >
          currentChange.oldStart
        ) {
          continue;
        }

        const lineStart = originalChange.oldStart;
        const lineChanges = originalChange.newLines - originalChange.oldLines;
        const lineEnd = originalChange.oldStart + lineChanges;

        // When we find a dependent change, we do not use it to normalize
        // the current change
        if (
          currentChange.oldStart >= lineStart &&
          currentChange.oldStart <= lineEnd
        ) {
          dependents.push(originalChange.index);
          continue;
        }

        newStart += lineChanges;

        // Any commits before the current hash will affect the starting position
        if (originalChange.hash !== currentChange.hash) {
          oldStart += lineChanges;
        }
      }

      currentChange.oldStart -= oldStart;
      currentChange.newStart -= newStart;
      currentChange.dependents = dependents;
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

      if (
        a.hash === b.hash &&
        a.type === ChangeType.MODIFY &&
        b.type === ChangeType.MODIFY &&
        a.fileType === "text" &&
        b.fileType === "text"
      ) {
        // If hunks overlap sort by their creation index
        if (a.oldStart >= b.oldStart && a.oldStart <= b.oldStart + b.oldLines) {
          return 1;
        } else if (
          b.oldStart >= a.oldStart &&
          b.oldStart <= a.oldStart + a.oldLines
        ) {
          return -1;
        }

        return a.oldStart - b.oldStart;
      }

      return bIndex - aIndex;
    });
  }
  private getChangeFromRef(fileName: string, changeRef: FileChange) {
    const changes = this._changes
      .concat(this._trash)
      .filter((change) => change.path === fileName);

    const change = changes.find((change) => change.index === changeRef.index);

    if (!change) {
      throw new Error("Could not find change");
    }

    return change;
  }
  getTrash() {
    const trash: RebaseCommitFile[] = [];

    for (const change of this._trash) {
      let commitFile = trash.find((item) => item.fileName === change.path);

      if (!commitFile) {
        commitFile = {
          changes: [],
          fileName: change.path,
          hasChangeSetBeforeDependent: false,
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
      let currentHashLineChangesCount = 0;
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
          previousChange.oldStart < change.oldStart &&
          !change.dependents.includes(previousChange.index)
        ) {
          // We'll always increase the currentLineChangesCount
          currentLineChangesCount +=
            previousChange.newLines - previousChange.oldLines;
        }

        // But we only update the currentHashLineChangesCount if we're on a new hash
        if (previousChange.hash !== currentHash) {
          currentHash = previousChange.hash;
          currentHashLineChangesCount = currentLineChangesCount;
        }
      }

      change.oldStart += currentHashLineChangesCount;
      change.newStart += currentLineChangesCount;
    }

    return changesCopy;
  }
  getRebaseCommits(): RebaseCommit[] {
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
      const rebaseCommit = rebaseCommitsByHash[change.hash];
      const file = rebaseCommit.files.find(
        (file) => file.fileName === change.path
      );

      let isSetBeforeDependent = false;

      if (change.dependents.length) {
        for (const dependent of change.dependents) {
          const dependentIndex = changesCopy.findIndex(
            (otherChange) => otherChange.index === dependent
          );

          if (dependentIndex > changesCopy.indexOf(change)) {
            isSetBeforeDependent = true;
            break;
          }
        }
      }

      if (file) {
        rebaseCommit.hasChangeSetBeforeDependent = isSetBeforeDependent
          ? true
          : rebaseCommit.hasChangeSetBeforeDependent;
        file.hasChangeSetBeforeDependent = isSetBeforeDependent
          ? true
          : file.hasChangeSetBeforeDependent;

        file.changes.push({
          ...change,
          isSetBeforeDependent,
        });
      } else {
        rebaseCommit.hasChangeSetBeforeDependent = isSetBeforeDependent;
        rebaseCommit.files.push({
          fileName: change.path,
          changes: [
            {
              ...change,
              isSetBeforeDependent,
            },
          ],
          hasChangeSetBeforeDependent: isSetBeforeDependent,
        });
      }
    }

    return this._commits.map((commit) => rebaseCommitsByHash[commit.hash]);
  }
  addCommit(message: string) {
    const hash = String(Date.now());

    this._commits.unshift({
      hash,
      message,
    });
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
  }
  updateCommitMessage(hash: string, newMessage: string) {
    const commit = this._commits.find((commit) => commit.hash === hash);

    if (!commit) {
      throw new Error("Could not find commit");
    }

    commit.message = newMessage;
  }
  toggleRebase() {
    if (this._isRebasing) {
      this._isRebasing = false;
    } else {
      this._isRebasing = true;
    }
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
    let result = changes.reduce<string | false>(
      (acc, change) =>
        acc === false || !isTextFileChange(change)
          ? acc
          : applyPatch(acc, {
              hunks: [change],
            }),
      document
    );

    if (result === false) {
      throw new Error("Could not apply changes");
    }

    // Because we use unified=0 in the diff command, there is an issue with EOF handling. It can
    // calculate wrong minLines, which I believe to be because of hunks normally including
    // lines before and after the change
    const currentLineNumber = document.split("\n").length;
    const resultLineNumber = result.split("\n").length;
    const expectedLineNumberChange = changes.reduce((acc, change) => {
      if (isTextFileChange(change)) {
        return acc + change.newLines - change.oldLines;
      }

      return acc;
    }, 0);
    const lineNumberChange = resultLineNumber - currentLineNumber;

    if (expectedLineNumberChange !== lineNumberChange) {
      result = result.split("\n").slice(0, -lineNumberChange).join("\n");
    }

    return result;
  }
  moveChangeToTrash(fileName: string, changeRef: FileChange) {
    const change = this.getChangeFromRef(fileName, changeRef);

    this._changes = this._changes.filter(
      (currentChange) => currentChange !== change
    );
    this._trash = this._trash.concat(change);
    this.sortChanges(this._trash);
  }
  // Moves a commit in the array after a target hash. If after trash, it is put
  // on the first index
  moveCommit(hash: string, afterRef?: string | "trash") {
    const commit = this._commits.find((commit) => commit.hash === hash);

    if (!commit) {
      throw new Error("Could not find commit");
    }

    const targetIndex =
      afterRef === "trash"
        ? 0
        : this._commits.findIndex((commit) => commit.hash === afterRef);

    if (targetIndex === -1) {
      throw new Error("Could not find target");
    }

    const currentIndex = this._commits.indexOf(commit);

    this._commits.splice(currentIndex, 1);
    this._commits.splice(targetIndex, 0, commit);
  }
  moveChangeFromTrash(
    fileName: string,
    changeRef: FileChange,
    targetHash: string
  ) {
    const change = this.getChangeFromRef(fileName, changeRef);

    this._trash = this._trash.filter(
      (currentChange) => currentChange !== change
    );

    change.hash = targetHash;
    this._changes = this._changes.concat(change);
    this.sortChanges(this._changes);
  }
  // Change to using the index, which should be called changeIndex
  moveChange(fileName: string, changeRef: FileChange, targetHash: string) {
    const change = this.getChangeFromRef(fileName, changeRef);
    change.hash = targetHash;
    this.sortChanges(this._changes);
  }
  showFileDiff() {}
  push() {}
  getFileOperationFromChanges(fileName: string) {
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
  }
}
