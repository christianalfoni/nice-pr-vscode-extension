import * as vscode from "vscode";
import { API, Commit, Repository } from "./git";
import * as cp from "child_process";
import { FileChange, Rebaser } from "./Rebaser";
import { promisify } from "util";
import {
  FileChangeType,
  getFileOperationChangeFromChanges as getFileOperationChangeFromChanges,
  getParentCommitHash,
  isLineOverlappingWithChange,
  mapChunkToFileChange,
  toMultiFileDiffEditorUris,
} from "./utils";
import { join } from "path";
import parseGitDiff from "parse-git-diff";

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

async function getGitExtension() {
  try {
    const extension = vscode.extensions.getExtension("vscode.git");
    if (!extension) {
      return undefined;
    }
    const gitExtension = extension.isActive
      ? extension.exports
      : await extension.activate();
    return gitExtension;
  } catch (err) {
    console.error("Failed to activate git extension", err);
    return undefined;
  }
}

class InMemoryContentProvider implements vscode.TextDocumentContentProvider {
  private _onDidChange = new vscode.EventEmitter<vscode.Uri>();
  readonly onDidChange = this._onDidChange.event;
  private contents = new Map<string, string>();

  public setContent(uri: vscode.Uri, content: string) {
    this.contents.set(uri.toString(), content);
    this._onDidChange.fire(uri);
  }

  public clear(uri: vscode.Uri) {
    this.contents.delete(uri.toString());
  }

  provideTextDocumentContent(uri: vscode.Uri): string {
    return this.contents.get(uri.toString()) || "";
  }
}

type RebaseMode =
  | {
      mode: "IDLE";
    }
  | {
      mode: "REBASING";
      rebaser: Rebaser;
    }
  | {
      mode: "READY_TO_PUSH";
      rebaser: Rebaser;
    };

type RebaseFileOperation =
  | {
      type: "write";
      fileName: string;
      content: string;
    }
  | {
      type: "remove";
      fileName: string;
    }
  | {
      type: "move";
      oldFileName: string;
      fileName: string;
      content: string;
    };

type RebaseCommitOperation = {
  message: string;
  fileOperations: RebaseFileOperation[];
};

type ShowFileDiffOptions = {
  fileName: string;
  hash: string;
  selection?: { from: number; to: number };
};

export class GitState {
  private _onDidChange = new vscode.EventEmitter<void>();
  readonly onDidChange = this._onDidChange.event;
  private _commits: Commit[] = [];
  private _branch: string | undefined;
  private _api: API | undefined;
  private _mode: RebaseMode = {
    mode: "IDLE",
  };
  private _contentProvider: InMemoryContentProvider;
  private _activeDiffs = new Map<string, Set<string>>();

  private set mode(value: RebaseMode) {
    this._mode = value;
    vscode.commands.executeCommand(
      "setContext",
      "nicePr.mode",
      this._mode.mode
    );
    this._onDidChange.fire();
  }

  get mode() {
    return this._mode;
  }

  constructor(private context: vscode.ExtensionContext) {
    this._contentProvider = new InMemoryContentProvider();
    context.subscriptions.push(
      vscode.workspace.registerTextDocumentContentProvider(
        "nice-pr-diff",
        this._contentProvider
      )
    );
    // Set initial rebase state context
    vscode.commands.executeCommand("setContext", "nicePr.isRebasing", false);
    this.initialize().catch((err) => {
      console.error("Failed to initialize GitState:", err);
    });

    context.subscriptions.push(
      vscode.workspace.onDidChangeWorkspaceFolders(() => this.setState())
    );

    this.mode = {
      mode: "IDLE",
    };
  }

  private async initialize() {
    const gitExtension = await getGitExtension();
    if (!gitExtension) {
      console.error("Git extension not found");
      return;
    }

    this._api = gitExtension.getAPI(1);

    // Subscribe to git repository changes
    this.context.subscriptions.push(
      // @ts-ignore
      this._api.onDidOpenRepository(async (repo) => {
        this.context.subscriptions.push(
          repo.state.onDidChange(() => this.setState())
        );
        await this.setState();
      }),
      // @ts-ignore
      this._api.onDidCloseRepository(() => this.setState())
    );

    // Subscribe to existing repositories
    // @ts-ignore
    this._api.repositories.forEach((repo) => {
      this.context.subscriptions.push(
        repo.state.onDidChange(() => this.setState())
      );
    });

    console.log("GitState initialized, updating state...");
    await this.setState();
  }

  private getRepo() {
    if (!this._api) {
      throw new Error("No API available");
    }

    const repo = this._api.repositories[0];

    if (!repo) {
      throw new Error("No REPO available");
    }

    return repo;
  }

  private getBranch() {
    const branch = this.getRepo().state.HEAD?.name;

    if (!branch) {
      throw new Error("No BRANCH available");
    }

    return branch;
  }

  private async setState() {
    const repo = this.getRepo();
    const branch = this.getBranch();

    // TODO: Show a warning if we are rebasing and the branch changes

    if (branch === "main" || branch === "master") {
      this._branch = undefined;
      this._commits = [];
      this.mode = {
        mode: "IDLE",
      };
      this._onDidChange.fire();
      return;
    }

    this._branch = branch;

    try {
      this._commits = await repo.log({
        range: `origin/main..${branch}`,
      });

      console.log("Processed commits:", this._commits.length);
      this._onDidChange.fire();
    } catch (e) {
      console.error("Failed to get commits:", e);
    }
  }

  get commits(): Commit[] {
    return this._commits;
  }

  get branch(): string | undefined {
    return this._branch;
  }

  get isRebasing(): boolean {
    return this.mode.mode === "REBASING";
  }

  getRebaser() {
    if (this.mode.mode === "IDLE") {
      throw new Error("No rebaser available");
    }

    return this.mode.rebaser;
  }

  async setRebaseMode(mode: RebaseMode["mode"]) {
    switch (mode) {
      case "IDLE": {
        this.mode = {
          mode: "IDLE",
        };
        return;
      }
      case "REBASING": {
        if (this.mode.mode === "READY_TO_PUSH") {
          this.mode = {
            mode: "REBASING",
            rebaser: this.mode.rebaser,
          };
        }

        const repo = this.getRepo();

        // We grab the changes for each commit, which represents the files affected
        const diffs = await Promise.all(
          this._commits
            .slice()
            .reverse()
            .map((commit) =>
              executeGitCommand(
                repo,
                `diff --unified=0 ${getParentCommitHash(commit)} ${commit.hash}`
              ).then((diff) => ({ commit, diff: parseGitDiff(diff).files }))
            )
        );

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
                      .filter(
                        (prevChange) => prevChange.path === diffChange.path
                      )
                      .map((prevChange) => prevChange.index),
                    hash: commit.hash,
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
                        (prevChange) =>
                          prevChange.path === diffChange.pathBefore
                      )
                      .map((prevChange) => prevChange.index),
                    hash: commit.hash,
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

        this.mode = {
          mode: "REBASING",
          rebaser: new Rebaser(this.getBranch(), this._commits, fileChanges),
        };
        return;
      }
      case "READY_TO_PUSH": {
        if (this.mode.mode !== "REBASING") {
          throw new Error("Can not push without rebasing");
        }

        const rebasedCommits = this.mode.rebaser.getRebaseCommits();
        const invalidCommit = rebasedCommits.find(
          (commit) => commit.hasChangeSetBeforeDependent
        );

        if (invalidCommit) {
          vscode.window.showErrorMessage(
            `Invalid commit detected: ${invalidCommit.message}. The commit has changes depending on later changes.`
          );
          return;
        }

        // TODO: Verify here that we do not have any wrong overlapping changes
        this.mode = {
          mode: "READY_TO_PUSH",
          rebaser: this.mode.rebaser,
        };
      }
    }

    this._onDidChange.fire();
  }

  addNewCommit(message: string) {
    const rebaser = this.getRebaser();

    rebaser.addCommit(message);

    this._onDidChange.fire();
  }

  removeCommit(hash: string) {
    const rebaser = this.getRebaser();

    rebaser.removeCommit(hash);

    this._onDidChange.fire();
  }

  async updateCommitMessage(hash: string, newMessage: string) {
    const rebaser = this.getRebaser();

    rebaser.updateCommitMessage(hash, newMessage);

    this._onDidChange.fire();
  }

  async showCommitDiff(commit: {
    message: string;
    hash: string;
  }): Promise<void> {
    if (!this._api) {
      return;
    }

    const repo = this._api.repositories[0];
    const commitParentId = `${commit.hash}^`;

    const changes = await repo.diffBetween(commitParentId, commit.hash);

    const title = `${commit.message} (${commit.hash.substring(0, 7)})`;
    const multiDiffSourceUri = vscode.Uri.from({
      scheme: "scm-history-item",
      path: `${repo.rootUri.path}/${commitParentId}..${commit.hash}`,
    });

    const resources: {
      originalUri: vscode.Uri | undefined;
      modifiedUri: vscode.Uri | undefined;
    }[] = [];
    for (const change of changes) {
      resources.push(
        toMultiFileDiffEditorUris(change, commitParentId, commit.hash)
      );
    }

    await vscode.commands.executeCommand(
      "_workbench.openMultiDiffEditor",
      {
        multiDiffSourceUri,
        title,
        resources,
      },
      {
        preserveFocus: true,
        preview: true,
        viewColumn: vscode.ViewColumn.Active,
      }
    );
  }

  async showRebasedCommitDiff(commit: {
    message: string;
    hash: string;
  }): Promise<void> {
    if (!this._api) {
      return;
    }

    const rebaser = this.getRebaser();
    const repo = this.getRepo();
    const commitParentId = `${commit.hash}^`;
    const title = `${commit.message} (${commit.hash.substring(0, 7)})`;
    const multiDiffSourceUri = vscode.Uri.from({
      scheme: "scm-history-item",
      path: `${repo.rootUri.path}/rebased/${commitParentId}..${commit.hash}`,
    });
    const rebasedCommit = rebaser
      .getRebaseCommits()
      .find((rebasedCommit) => rebasedCommit.hash === commit.hash);

    if (!rebasedCommit) {
      throw new Error("Commit not found in rebased commits");
    }

    const resources: {
      originalUri: vscode.Uri | undefined;
      modifiedUri: vscode.Uri | undefined;
    }[] = [];
    for (const file of rebasedCommit.files) {
      const { leftUri, rightUri } = await this.generateDiffUris({
        fileName: file.fileName,
        hash: commit.hash,
      });
      resources.push({
        originalUri: leftUri,
        modifiedUri: rightUri,
      });
    }

    await vscode.commands.executeCommand(
      "_workbench.openMultiDiffEditor",
      {
        multiDiffSourceUri,
        title,
        resources,
      },
      {
        preserveFocus: true,
        preview: true,
        viewColumn: vscode.ViewColumn.Active,
      }
    );
  }

  private async getInitialHash() {
    if (!this._api || !this._branch) {
      return "";
    }

    const repo = this._api.repositories[0];

    const mergeBase = await repo.getMergeBase("origin/main", this._branch);

    if (!mergeBase) {
      throw new Error("No merge base");
    }

    return mergeBase;
  }

  private async getInitialFileContents(filePath: string): Promise<string> {
    if (!this._api || !this._branch) {
      return "";
    }

    const repo = this._api.repositories[0];

    try {
      const mergeBase = await this.getInitialHash();
      // Use executeGitCommand to get the file content from the merge base
      return await executeGitCommand(repo, `show ${mergeBase}:${filePath}`);
    } catch (error) {
      console.error("Failed to get file contents:", error);
      return "";
    }
  }

  async showFileDiff({ fileName, hash: ref, selection }: ShowFileDiffOptions) {
    const activeDiffHashesForFile =
      this._activeDiffs.get(fileName) || new Set();

    activeDiffHashesForFile.add(fileName);

    this._activeDiffs.set(fileName, activeDiffHashesForFile);

    // Get original file contents and show diff
    await this.updateDiffView({ fileName, hash: ref, selection });
  }

  private async generateDiffUris({
    fileName,
    hash,
  }: Omit<ShowFileDiffOptions, "selection">) {
    const leftUri = vscode.Uri.parse(
      `nice-pr-diff://original/${hash}/${fileName}`
    );
    const rightUri = vscode.Uri.parse(
      `nice-pr-diff://modified/${hash}/${fileName}`
    );

    const rebaser = this.getRebaser();
    const changesForFile = rebaser.getChangesForFileByHash(fileName, hash);

    // If the current hash renames the file, we need to pass the old file name
    // to get the initial contents of the file at this hash to apply any modifications
    const oldFileName =
      changesForFile[0]?.type === FileChangeType.RENAME
        ? changesForFile[0].oldFileName
        : undefined;

    // With renames we need to get the contents by the previous file name
    const originalContent = await this.getInitialFileContents(
      oldFileName || fileName
    );

    const changes = rebaser.getChangesForFileByHash(fileName, hash);
    const changesInHash = changes.filter((change) => change.hash === hash);
    const changesExludingHash = changes.filter(
      (change) => change.hash !== hash
    );

    const contentBeforeHash = rebaser.applyChanges(
      originalContent,
      changesExludingHash
    );

    const contentInHash = rebaser.applyChanges(
      contentBeforeHash,
      changesInHash
    );

    this._contentProvider.clear(leftUri);
    this._contentProvider.clear(rightUri);
    this._contentProvider.setContent(leftUri, contentBeforeHash);
    this._contentProvider.setContent(rightUri, contentInHash);

    return { leftUri, rightUri };
  }

  async updateDiffView({ fileName, hash, selection }: ShowFileDiffOptions) {
    const existingView = this._activeDiffs.has(fileName);

    if (!existingView) {
      return;
    }

    const { leftUri, rightUri } = await this.generateDiffUris({
      fileName,
      hash,
    });

    vscode.commands.executeCommand(
      "vscode.diff",
      leftUri,
      rightUri,
      `${fileName} (${hash.substring(0, 7)})`,
      {
        preview: true,
        selection: selection
          ? {
              start: { line: selection.from, character: 0 },
              end: { line: selection.to, character: 0 },
            }
          : undefined,
      }
    );
  }
  async rebase() {
    const rebaser = this.getRebaser();
    const commits = rebaser.getRebaseCommits();
    const commitsToHandle = commits
      .filter((commit) => Boolean(commit.files.length))
      .reverse();
    const fileStates: Record<string, string> = {};

    const commitOperations: RebaseCommitOperation[] = await Promise.all(
      commitsToHandle.map(async (commit) => {
        return {
          message: commit.message,
          fileOperations: await Promise.all(
            commit.files.map((file) =>
              Promise.resolve(
                fileStates[file.fileName] ||
                  this.getInitialFileContents(file.fileName)
              )
                // There is no file yet, so we use empty string as initial content
                .catch(() => "")
                .then((content): RebaseFileOperation => {
                  fileStates[file.fileName] = content;

                  const fileOperationChange = getFileOperationChangeFromChanges(
                    file.changes
                  );

                  switch (fileOperationChange.type) {
                    case FileChangeType.ADD:
                    case FileChangeType.MODIFY: {
                      return {
                        type: "write",
                        fileName: file.fileName,
                        content: rebaser.applyChanges(content, file.changes),
                      };
                    }
                    case FileChangeType.RENAME: {
                      return {
                        type: "move",
                        oldFileName: fileOperationChange.oldFileName,
                        fileName: file.fileName,
                        content: rebaser.applyChanges(content, file.changes),
                      };
                    }
                    case FileChangeType.DELETE: {
                      return {
                        type: "remove",
                        fileName: file.fileName,
                      };
                    }
                  }
                })
            )
          ),
        };
      })
    );

    await executeGitCommand(
      this.getRepo(),
      `reset --hard ${await this.getInitialHash()}`
    );

    for (const commitOperation of commitOperations) {
      for (const fileOperation of commitOperation.fileOperations) {
        const workspacePath = this.getRepo().rootUri.fsPath;
        const filePath = vscode.Uri.file(
          join(workspacePath, fileOperation.fileName)
        );

        switch (fileOperation.type) {
          case "write": {
            await vscode.workspace.fs.writeFile(
              filePath,
              Buffer.from(fileOperation.content)
            );
            break;
          }
          case "move": {
            await vscode.workspace.fs.rename(
              filePath,
              vscode.Uri.file(join(workspacePath, fileOperation.oldFileName))
            );
            await vscode.workspace.fs.writeFile(
              filePath,
              Buffer.from(fileOperation.content)
            );
            break;
          }
          case "remove": {
            await vscode.workspace.fs.delete(filePath);
            break;
          }
        }
      }
      await executeGitCommand(this.getRepo(), `add .`);
      await executeGitCommand(
        this.getRepo(),
        `commit -m "${commitOperation.message}"`
      );
    }

    this.setRebaseMode("READY_TO_PUSH");
  }
}
