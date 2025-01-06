import * as vscode from "vscode";
import { API, Commit, Repository } from "./git";
import * as cp from "child_process";
import { FileChange, Rebaser } from "./Rebaser";
import { promisify } from "util";
import {
  FileChangeType,
  getFileOperationChangeFromChanges as getFileOperationChangeFromChanges,
  getParentCommitHash,
  mapChunkToFileChange,
  toMultiFileDiffEditorUris,
} from "./utils";
import { parsePatch } from "diff";
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

  private get mode() {
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
    if (this.mode.mode !== "REBASING") {
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
          for (const change of diff) {
            switch (change.type) {
              case "AddedFile": {
                fileChanges = [
                  ...fileChanges,
                  {
                    type: FileChangeType.ADD,
                    index: changeIndex++,
                    dependents: [],
                    hash: commit.hash,
                    path: change.path,
                  },
                  ...change.chunks.map((chunk) =>
                    mapChunkToFileChange(
                      chunk,
                      commit.hash,
                      change.path,
                      changeIndex++
                    )
                  ),
                ];
                break;
              }
              case "DeletedFile": {
                fileChanges = [
                  ...fileChanges,
                  {
                    type: FileChangeType.DELETE,
                    index: changeIndex++,
                    // TODO: This depends on any other changes to this file
                    dependents: [],
                    hash: commit.hash,
                    path: change.path,
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
                    // TODO: This depends on any other changes to the before path of this file, but we'll
                    // handle this in the Rebaser
                    dependents: [],
                    hash: commit.hash,
                    oldFileName: change.pathBefore,
                    path: change.pathAfter,
                  },
                  ...change.chunks.map((chunk) =>
                    mapChunkToFileChange(
                      chunk,
                      commit.hash,
                      change.pathAfter,
                      changeIndex++
                    )
                  ),
                ];
                break;
              }
              case "ChangedFile": {
                fileChanges = [
                  ...fileChanges,
                  ...change.chunks.map((chunk) =>
                    mapChunkToFileChange(
                      chunk,
                      commit.hash,
                      change.path,
                      changeIndex++
                    )
                  ),
                ];
                break;
              }
            }
          }
        }

        console.log(fileChanges);

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
        toMultiFileDiffEditorUris(
          change.renameUri || change.originalUri,
          change,
          commitParentId,
          commit.hash
        )
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

  async showFileDiff(
    fileName: string,
    ref: string,
    selection?: { from: number; to: number }
  ) {
    const activeDiffHashesForFile =
      this._activeDiffs.get(fileName) || new Set();

    activeDiffHashesForFile.add(fileName);

    this._activeDiffs.set(fileName, activeDiffHashesForFile);

    // Get original file contents and show diff
    await this.updateDiffView(fileName, ref, selection);
  }

  async updateDiffView(
    fileName: string,
    hash: string,
    selection?: { from: number; to: number }
  ) {
    const existingView = this._activeDiffs.has(fileName);

    if (!existingView) {
      return;
    }

    const leftUri = vscode.Uri.parse(
      `nice-pr-diff://original/${hash}/${fileName}`
    );
    const rightUri = vscode.Uri.parse(
      `nice-pr-diff://modified/${hash}/${fileName}`
    );

    const originalContent = await this.getInitialFileContents(fileName);

    const rebaser = this.getRebaser();

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

    console.log("Commit operations:", commits, commitOperations);

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
