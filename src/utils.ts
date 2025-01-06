import { promisify } from "util";
import * as cp from "child_process";
import * as vscode from "vscode";
import { Change, Commit, Repository, Status } from "./git";
import { ParsedDiff } from "diff";
import {
  FileChange,
  ModifyTextFileChange,
  RebaseCommitFileChange,
} from "./Rebaser";
import { Chunk } from "parse-git-diff";
import { AnyChunk } from "parse-git-diff";

const execAsync = promisify(cp.exec);

// Add these helper functions at the top of the file
async function executeGitCommand(
  repo: Repository,
  command: string
): Promise<string> {
  try {
    const { stdout } = await execAsync(`git ${command}`, {
      cwd: repo.rootUri.fsPath,
    });
    return stdout;
  } catch (error) {
    console.error("Git command failed:", error);
    return "";
  }
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

export function getLineChanges(change: FileChange) {
  return change.type === FileChangeType.MODIFY && change.fileType === "text"
    ? change.lines
        .filter((line) => line[0] === "+")
        .map((line) => line.slice(1))
    : [];
}

export function mapChunkToFileChange(
  chunk: AnyChunk,
  hash: string,
  path: string,
  index: number
): FileChange {
  if (chunk.type === "CombinedChunk") {
    throw new Error("Combined chunk not supported");
  }

  // Need to support binary files
  if (chunk.type === "BinaryFilesChunk") {
    return {
      type: FileChangeType.MODIFY,
      fileType: "binary",
      index,
      dependents: [],
      hash,
      path,
    };
  }

  console.log("CHUNK", chunk);

  return {
    type: FileChangeType.MODIFY,
    fileType: "text",
    index,
    dependents: [],
    hash,
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
        return acc.concat(`+ ${lineChange.content}`);
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

interface GitUriParams {
  path: string;
  ref: string;
}

interface GitUriOptions {
  scheme?: string;
}

export function toGitUri(
  uri: vscode.Uri,
  ref: string,
  options: GitUriOptions = {}
): vscode.Uri {
  const params: GitUriParams = {
    path: uri.fsPath,
    ref,
  };

  return uri.with({
    scheme: options.scheme ?? "git",
    path: uri.path,
    query: JSON.stringify(params),
  });
}

export function toMultiFileDiffEditorUris(
  uri: vscode.Uri,
  change: Change,
  originalRef: string,
  modifiedRef: string
): {
  originalUri: vscode.Uri | undefined;
  modifiedUri: vscode.Uri | undefined;
} {
  switch (change.status) {
    case Status.INDEX_ADDED:
      return {
        originalUri: undefined,
        modifiedUri: toGitUri(change.uri, modifiedRef),
      };
    case Status.DELETED:
      return {
        originalUri: toGitUri(change.uri, originalRef),
        modifiedUri: undefined,
      };
    case Status.INDEX_RENAMED:
      return {
        originalUri: toGitUri(change.originalUri, originalRef),
        modifiedUri: toGitUri(change.uri, modifiedRef),
      };
    default:
      return {
        originalUri: toGitUri(change.uri, originalRef),
        modifiedUri: toGitUri(change.uri, modifiedRef),
      };
  }
}
