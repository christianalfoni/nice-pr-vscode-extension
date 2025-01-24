import { promisify } from "util";
import * as cp from "child_process";
import { Commit, Repository } from "./git.js";
import { ParsedDiff } from "diff";
import {
  FileChange,
  FileModifications,
  ModifyTextFileChange,
  RebaseCommitFileChange,
} from "./Rebaser.js";
import { AnyChunk } from "parse-git-diff";

const execAsync = promisify(cp.exec);

// Add these helper functions at the top of the file
export async function executeGitCommand(
  repo: Repository,
  command: string
): Promise<string> {
  const { stdout } = await execAsync(`git ${command}`, {
    cwd: repo.rootUri.fsPath,
  });
  return stdout;
}

export async function executeGitCommandWithBinaryOutput(
  repo: Repository,
  command: string
): Promise<Buffer> {
  const { stdout } = await execAsync(`git ${command}`, {
    cwd: repo.rootUri.fsPath,
    encoding: "buffer",
    // 20MB max buffer
    maxBuffer: 20 * 10 * 1024 * 1024,
  });

  return stdout;
}

export async function getGitDiff(
  repo: Repository,
  fromHash: string,
  toHash: string,
  filePath?: string
): Promise<string> {
  const filePathArg = filePath ? `-- "${filePath}"` : "";
  return executeGitCommand(
    repo,
    `diff --unified=0 ${fromHash} ${toHash} ${filePathArg}`
  );
}

export enum FileChangeType {
  ADD = "ADD",
  MODIFY = "MODIFY",
  RENAME = "RENAME",
  DELETE = "DELETE",
}

export function getFileOperation(parsedDiff: ParsedDiff) {
  if (parsedDiff.oldFileName === "/dev/null") {
    return FileChangeType.ADD;
  }

  if (parsedDiff.newFileName === "/dev/null") {
    return FileChangeType.DELETE;
  }

  if (
    parsedDiff.oldFileName &&
    parsedDiff.newFileName &&
    // Files on ParsedDiff er prefixed with a/ and b/ so we need to remove them
    parsedDiff.oldFileName.substring(2) !== parsedDiff.newFileName?.substring(2)
  ) {
    return FileChangeType.RENAME;
  }

  return FileChangeType.MODIFY;
}

export function getFileOperationChangeFromChanges(
  changes: RebaseCommitFileChange[]
) {
  if (changes.length === 0) {
    throw new Error("Can not do file operation on empty changes");
  }

  let fileOperationChange = changes[0];

  for (const change of changes) {
    // We never want to modify if we have a rename or delete
    // TODO: How do we handle rename and delete together? Should we just make it invalid?
    if (
      fileOperationChange.type === FileChangeType.MODIFY &&
      fileOperationChange.type !== change.type
    ) {
      fileOperationChange = change;
    }
  }

  return fileOperationChange;
}

export function getParentCommitHash(commit: Commit) {
  return commit.hash + "^";
}

// This is used for UI color to conceptually identify additions, deletions or modifications,
// where modifications are strictly changing existing lines
export function getModificationTypeFromChange(
  change: ModifyTextFileChange & { fileType: "text" }
) {
  if (change.linesChangedCount > 0) {
    return "ADD";
  }
  if (change.linesChangedCount < 0) {
    return "DELETE";
  }

  return "MODIFY";
}

export function mapChunkToFileChange({
  chunk,
  hash,
  path,
  index,
  dependencies,
}: {
  chunk: AnyChunk;
  hash: string;
  path: string;
  index: number;
  dependencies: number[];
}): FileChange {
  if (chunk.type === "CombinedChunk") {
    throw new Error("Combined chunk not supported");
  }

  // Need to support binary files
  if (chunk.type === "BinaryFilesChunk") {
    return {
      type: FileChangeType.MODIFY,
      fileType: "binary",
      index,
      dependencies,
      hash,
      originalHash: hash,
      path,
    };
  }

  const { modifications, modificationCount } = chunk.changes.reduce<{
    modifications: FileModifications;
    modificationCount: 0;
  }>(
    (acc, lineChange) => {
      if (lineChange.type === "DeletedLine") {
        acc.modifications.push(`-${lineChange.content}`);
        acc.modificationCount--;
      }
      if (lineChange.type === "AddedLine") {
        acc.modifications.push(`+${lineChange.content}`);
        acc.modificationCount++;
      }

      return acc;
    },
    {
      modifications: [],
      modificationCount: 0,
    }
  );

  const startIndex = chunk.toFileRange.start - 1;

  return {
    type: FileChangeType.MODIFY,
    fileType: "text",
    index,
    dependencies,
    hash,
    originalHash: hash,
    path,
    modificationRange: [
      startIndex,
      // The range can not be smaller than [0, 0], it just means that it
      // only adds lines
      Math.max(
        0,
        startIndex + chunk.fromFileRange.lines - chunk.toFileRange.lines
      ),
    ],
    modifications,
    linesChangedCount: modificationCount,
  };
}

export function isTextFileChange(
  change: FileChange
): change is ModifyTextFileChange {
  return change.type === FileChangeType.MODIFY && change.fileType === "text";
}

export function isLineOverlappingWithChange(
  line: number,
  previousChange: FileChange
) {
  if (!isTextFileChange(previousChange)) {
    return false;
  }

  const range = previousChange.modificationRange;

  return line >= range[0] && line <= range[1];
}

export async function getBranchCommits(
  repo: Repository,
  branch: string
): Promise<Commit[]> {
  if (branch === "main" || branch === "master") {
    return [];
  }

  return repo.log({
    range: `origin/main..${branch}`,
  });
}
