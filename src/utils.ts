import { promisify } from "util";
import * as cp from "child_process";
import { Commit, Repository } from "./git.js";
import { ParsedDiff } from "diff";
import {
  FileChange,
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

export function getModificationTypeFromChange(
  change: ModifyTextFileChange & { fileType: "text" }
) {
  if (change.oldLines === 0) {
    return "ADD";
  }
  if (change.newLines === 0) {
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

  return {
    type: FileChangeType.MODIFY,
    fileType: "text",
    index,
    dependencies,
    hash,
    originalHash: hash,
    path,
    oldStart: chunk.fromFileRange.start,
    oldLines: chunk.fromFileRange.lines,
    newStart: chunk.toFileRange.start,
    newLines: chunk.toFileRange.lines,
    lines: chunk.changes.reduce<string[]>((acc, lineChange) => {
      if (lineChange.type === "DeletedLine") {
        return acc.concat(`-${lineChange.content}`);
      }
      if (lineChange.type === "AddedLine") {
        return acc.concat(`+${lineChange.content}`);
      }

      return acc;
    }, []),
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

  const lineStart = previousChange.oldStart;
  const lineChanges = previousChange.newLines - previousChange.oldLines;
  const lineEnd = previousChange.oldStart + lineChanges;

  // When we find a dependent change, we do not use it to normalize
  // the current change
  if (line >= lineStart && line <= lineEnd) {
    return true;
  }
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
