import * as vscode from "vscode";
import { API, Change, Commit, Repository, Status } from "./git.js";
import * as cp from "child_process";
import { Rebaser, ResponseSchema } from "./Rebaser.js";
import { promisify } from "util";
import {
  executeGitCommand,
  executeGitCommandWithBinaryOutput,
  FileChangeType,
  getBranchCommits,
  getFileOperationChangeFromChanges as getFileOperationChangeFromChanges,
  getParentCommitHash,
} from "./utils.js";
import { join } from "path";
import OpenaI from "openai";
import { zodResponseFormat } from "openai/helpers/zod";

const openai = new OpenaI({
  baseURL: vscode.workspace.getConfiguration("nicePr").get("openAiBaseUrl"),
  apiKey: vscode.workspace.getConfiguration("nicePr").get("openAiApiKey"),
});

const execAsync = promisify(cp.exec);

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

export class InMemoryContentProvider
  implements vscode.TextDocumentContentProvider
{
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

  public clearAll() {
    this.contents.clear();
  }

  provideTextDocumentContent(uri: vscode.Uri): string {
    return this.contents.get(uri.toString()) || "";
  }
}

const BACKUP_BRANCH_PREFIX = "nice-pr-backup";

type RebaseMode =
  | {
      mode: "IDLE";
      hasBackupBranch: boolean;
    }
  | {
      mode: "REBASING";
      rebaser: Rebaser;
    }
  | {
      mode: "READY_TO_PUSH";
      rebaser: Rebaser;
    }
  | {
      mode: "PUSHING";
    }
  | {
      mode: "SUGGESTING";
    };

type RebaseFileOperation =
  | {
      type: "write";
      fileName: string;
      content: string | Buffer;
    }
  | {
      type: "remove";
      fileName: string;
    }
  | {
      type: "rename";
      oldFileName: string;
      fileName: string;
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

export class NicePR {
  private _onDidChange = new vscode.EventEmitter<void>();
  readonly onDidChange = this._onDidChange.event;
  private _mode: RebaseMode = {
    mode: "IDLE",
    hasBackupBranch: false,
  };
  private _contentProvider: InMemoryContentProvider;
  private _activeDiffs = new Map<string, Set<string>>();
  private _api: API;
  private _repo: Repository;
  private _commits: Commit[];
  private _branch: string;
  // TODO: Use git reflog and parse out the likely target branch
  private _targetBranch: string = "main";
  private _stateChangeListenerDisposer: vscode.Disposable;

  private set mode(value: RebaseMode) {
    this._mode = value;
    vscode.commands.executeCommand(
      "setContext",
      "nicePr.mode",
      this._mode.mode
    );
    vscode.commands.executeCommand(
      "setContext",
      "nicePr.hasBackupBranch",
      this._mode.mode === "IDLE" && this._mode.hasBackupBranch
    );
    this._onDidChange.fire();
  }

  get mode() {
    return this._mode;
  }

  constructor(options: {
    contentProvider: InMemoryContentProvider;
    api: API;
    repo: Repository;
    branch: string;
    commits: Commit[];
  }) {
    this._api = options.api;
    this._repo = options.repo;
    this._branch = options.branch;
    this._commits = options.commits;
    this._contentProvider = options.contentProvider;

    // Set initial rebase state context
    vscode.commands.executeCommand("setContext", "nicePr.isRebasing", false);
    this._stateChangeListenerDisposer = this._repo.state.onDidChange(
      async () => {
        this._commits = await getBranchCommits(this._repo, this._branch);
        this._onDidChange.fire();
      }
    );

    // We set it again as checking backup branch is async
    this.setRebaseMode("IDLE");
  }

  private checkBackupBranch() {
    if (!this._branch) {
      throw new Error("No branch available");
    }

    const backupBranch = `${BACKUP_BRANCH_PREFIX}-${this._branch}`;

    return executeGitCommand(this._repo, `rev-parse --verify ${backupBranch}`)
      .then(() => true)
      .catch(() => false);
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
    if (
      this.mode.mode === "IDLE" ||
      this.mode.mode === "PUSHING" ||
      this.mode.mode === "SUGGESTING"
    ) {
      throw new Error("No rebaser available");
    }

    return this.mode.rebaser;
  }

  private async checkNeedsRebaseFromTarget(): Promise<boolean> {
    // Pull target branch to be able to diff correctly
    await executeGitCommand(
      this._repo,
      `fetch origin ${this._targetBranch}:${this._targetBranch}`
    );

    // Check if we are diverging from target branch
    const hasDivergingLogs = Boolean(
      await executeGitCommand(this._repo, `log HEAD..${this._targetBranch}`)
    );

    if (hasDivergingLogs) {
      const choice = await vscode.window.showWarningMessage(
        `You need to rebase onto ${this._targetBranch} before being able to edit this branch`,
        "Rebase"
      );

      if (choice === "Rebase") {
        try {
          // @ts-ignore
          await this._repo.repository.rebase(this._targetBranch);
        } catch {
          vscode.commands.executeCommand("workbench.view.scm");
          vscode.window.showWarningMessage(
            `Please resolve and stage conflicts to continue. Once you are done, you can change the history`
          );
        }
      }

      return true;
    }

    return false;
  }

  async setRebaseMode(mode: RebaseMode["mode"]) {
    if (this.mode.mode === "SUGGESTING") {
      return;
    }

    switch (mode) {
      case "IDLE": {
        this.mode = {
          mode: "IDLE",
          hasBackupBranch: await this.checkBackupBranch(),
        };
        break;
      }
      case "SUGGESTING": {
        const needsRebaseFromTarget = await this.checkNeedsRebaseFromTarget();

        if (needsRebaseFromTarget) {
          return;
        }

        // Show the progress indicator
        await vscode.window.withProgress(
          {
            location: vscode.ProgressLocation.Notification,
            title: "Suggesting...",
            cancellable: false,
          },
          async (progress) => {
            const commitsWithDiffs = await Promise.all(
              this._commits
                .slice()
                .reverse()
                .map((commit) =>
                  executeGitCommand(
                    this._repo,
                    `diff --unified=0 ${getParentCommitHash(commit)} ${
                      commit.hash
                    }`
                  ).then((diff) => ({ commit, diff }))
                )
            );

            const rebaser = new Rebaser(commitsWithDiffs);
            const diffs = rebaser.getSuggestionDiffs();

            /**
             IMPROVEMENTS:
             - We could get the description of the PR?
             - Be even more concise about what relevant changes are
             */
            const response = await openai.chat.completions.create({
              model: "gpt-4o",
              messages: [
                {
                  role: "system",
                  content: vscode.workspace
                    .getConfiguration("nicePr")
                    .get("suggestionInstructions")!,
                },
                {
                  role: "user",
                  content: `These are commit message of the original commits:
                  
${commitsWithDiffs.map(({ commit }) => "- " + commit.message).join("\n")}

And these are the diffs:

${JSON.stringify(diffs)}`,
                },
              ],
              response_format: zodResponseFormat(ResponseSchema, "rebase"),
              temperature: 0.2,
            });

            const parsedResponse = ResponseSchema.parse(
              JSON.parse(response.choices[0].message.content!)
            );

            rebaser.setSuggestedRebaseCommits(parsedResponse);

            this.mode = {
              mode: "REBASING",
              rebaser,
            };
          }
        );

        break;
      }
      case "REBASING": {
        await vscode.window.withProgress(
          {
            location: vscode.ProgressLocation.Notification,
            title: `Verifying ${this._branch} for rebase...`,
            cancellable: false,
          },
          async (progress) => {
            const needsRebaseFromTarget =
              // Optimise this to first to a quick check and only pull if differ
              await this.checkNeedsRebaseFromTarget();

            if (needsRebaseFromTarget) {
              return;
            }

            if (this.mode.mode === "READY_TO_PUSH") {
              this.mode = {
                mode: "REBASING",
                rebaser: this.mode.rebaser,
              };
              return;
            }

            const diffs = await Promise.all(
              this._commits
                .slice()
                .reverse()
                .map((commit) =>
                  executeGitCommand(
                    this._repo,
                    `diff --unified=0 ${getParentCommitHash(commit)} ${
                      commit.hash
                    }`
                  ).then((diff) => ({ commit, diff }))
                )
            );

            this.mode = {
              mode: "REBASING",
              rebaser: new Rebaser(diffs),
            };
          }
        );

        break;
      }
      case "READY_TO_PUSH": {
        if (this.mode.mode !== "REBASING") {
          throw new Error("Can not push without rebasing");
        }

        const rebasedCommits = this.mode.rebaser.rebaseCommits;
        const invalidCommit = rebasedCommits.find(
          (commit) => commit.hasChangeSetBeforeDependent
        );

        if (invalidCommit) {
          vscode.window.showErrorMessage(
            `Invalid commit detected: ${invalidCommit.message}. The commit has changes depending on later changes.`
          );
          return;
        }

        this.mode = {
          mode: "READY_TO_PUSH",
          rebaser: this.mode.rebaser,
        };
        break;
      }
      case "PUSHING": {
        if (this.mode.mode !== "READY_TO_PUSH") {
          throw new Error("Can not push without rebasing");
        }

        await vscode.window.withProgress(
          {
            location: vscode.ProgressLocation.Notification,
            title: "Rebasing and pushing to remote...",
            cancellable: false,
          },
          async (progress) => {
            await this.rebase();
            await executeGitCommand(
              this._repo,
              `push origin ${this._branch} --force-with-lease`
            );
            this.setRebaseMode("IDLE");
          }
        );

        return;
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
    const commitParentId = `${commit.hash}^`;
    const title = `${commit.message} (${commit.hash.substring(0, 7)})`;
    const multiDiffSourceUri = vscode.Uri.from({
      scheme: "scm-history-item",
      path: `${this._repo.rootUri.path}/rebased/${commitParentId}..${commit.hash}`,
    });
    const rebasedCommit = rebaser.rebaseCommits.find(
      (rebasedCommit) => rebasedCommit.hash === commit.hash
    );

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

    const mergeBase = await repo.getMergeBase(
      "origin/" + this._targetBranch,
      this._branch
    );

    if (!mergeBase) {
      throw new Error("No merge base");
    }

    return mergeBase;
  }

  private async getInitialFileContents(
    fileName: string,
    hash: string
  ): Promise<string> {
    if (!this._api || !this._branch) {
      return "";
    }

    const changesForFile = this.getRebaser().getChangesForFileByHash(
      fileName,
      hash
    );

    // If the current hash renames the file, we need to pass the old file name
    // to get the initial contents of the file at this hash to apply any modifications
    const oldFileName =
      changesForFile[0]?.type === FileChangeType.RENAME
        ? changesForFile[0].oldFileName
        : undefined;

    try {
      const mergeBase = await this.getInitialHash();

      // Use executeGitCommand to get the file content from the merge base
      return await executeGitCommand(
        this._repo,
        `cat-file -p ${mergeBase}:${oldFileName || fileName}`
      );
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
    const originalContent = await this.getInitialFileContents(fileName, hash);
    const hashes = this._commits.map((commit) => commit.hash);
    const changes = rebaser.getChangesForFileByHash(fileName, hash);
    const changesInHash = changes.filter((change) => change.hash === hash);
    const changesBeforeHash = changes.filter(
      (change) => hashes.indexOf(change.hash) > hashes.indexOf(hash)
    );

    const contentBeforeHash = rebaser.applyChanges(
      originalContent,
      changesBeforeHash
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
    const commits = rebaser.rebaseCommits;
    const commitsToHandle = commits
      .filter((commit) => Boolean(commit.files.length))
      .reverse();
    const fileStates: Record<string, string> = {};
    const commitOperations: RebaseCommitOperation[] = [];

    for (const commit of commitsToHandle) {
      const fileOperations: RebaseFileOperation[] = [];

      for (const file of commit.files) {
        // We need to identify if this file is a binary, make that happen!
        // If it is a binary, we need to diverge the logic
        const fileOperationChange = getFileOperationChangeFromChanges(
          file.changes
        );
        const lastBinaryChange = file.changes
          .filter(
            (change) =>
              change.type === FileChangeType.MODIFY &&
              change.fileType === "binary"
          )
          .pop();

        let content: string | Buffer;

        // If we a are dealing with a binary change, which would be the last change of the file, we read
        // the contents of that file using git binary output with the hash it was originally added for
        if (lastBinaryChange) {
          content = await executeGitCommandWithBinaryOutput(
            this._repo,
            `cat-file -p ${lastBinaryChange.originalHash}:${file.fileName}`
          );
        } else {
          const updatedContents =
            fileOperationChange.type === FileChangeType.RENAME
              ? fileStates[fileOperationChange.oldFileName]
              : fileStates[file.fileName];

          const currentContent = await Promise.resolve(
            typeof updatedContents === "string"
              ? updatedContents
              : this.getInitialFileContents(file.fileName, commit.hash)
          )
            // There is no file yet, so we use empty string as initial content
            .catch(() => "");

          content = fileStates[file.fileName] = rebaser.applyChanges(
            currentContent,
            file.changes
          );
        }

        switch (fileOperationChange.type) {
          case FileChangeType.ADD:
          case FileChangeType.MODIFY: {
            fileOperations.push({
              type: "write",
              fileName: file.fileName,
              content,
            });
            break;
          }
          case FileChangeType.RENAME: {
            fileOperations.push({
              type: "rename",
              oldFileName: fileOperationChange.oldFileName,
              fileName: file.fileName,
            });
            fileOperations.push({
              type: "write",
              fileName: file.fileName,
              content,
            });
            break;
          }
          case FileChangeType.DELETE: {
            fileOperations.push({
              type: "remove",
              fileName: file.fileName,
            });
            break;
          }
        }
      }

      commitOperations.push({
        message: commit.message,
        fileOperations,
      });
    }

    // Create backup branch
    const currentBranch = this._branch;
    const backupBranch = `${BACKUP_BRANCH_PREFIX}-${currentBranch}`;

    // Create or update backup branch without checking it out
    await executeGitCommand(this._repo, `branch -f ${backupBranch}`);

    await executeGitCommand(
      this._repo,
      `reset --hard ${await this.getInitialHash()}`
    );

    async function ensureDirectoryExists(filePath: vscode.Uri) {
      try {
        await vscode.workspace.fs.createDirectory(
          vscode.Uri.joinPath(filePath, "..")
        );
      } catch (err) {
        // Directory might already exist, which is fine
      }
    }

    for (const commitOperation of commitOperations) {
      for (const fileOperation of commitOperation.fileOperations) {
        const workspacePath = this._repo.rootUri.fsPath;
        const filePath = vscode.Uri.file(
          join(workspacePath, fileOperation.fileName)
        );

        switch (fileOperation.type) {
          case "write": {
            await ensureDirectoryExists(filePath);
            await vscode.workspace.fs.writeFile(
              filePath,
              Buffer.from(fileOperation.content)
            );
            break;
          }
          case "rename": {
            await vscode.workspace.fs.rename(
              vscode.Uri.file(join(workspacePath, fileOperation.oldFileName)),
              filePath
            );
            break;
          }
          case "remove": {
            await vscode.workspace.fs.delete(filePath);
            break;
          }
        }
      }

      await executeGitCommand(this._repo, `add .`);
      await executeGitCommand(
        this._repo,
        `commit --no-verify -m "${commitOperation.message}"`
      );
    }
  }
  async revertToBackupBranch() {
    if (this.mode.mode !== "IDLE") {
      throw new Error("Can not revert to backup branch while rebasing");
    }

    if (!this.mode.hasBackupBranch) {
      throw new Error("No backup branch available");
    }

    await executeGitCommand(
      this._repo,
      `reset --hard ${BACKUP_BRANCH_PREFIX}-${this._branch}`
    );
  }
  dispose() {
    this._stateChangeListenerDisposer.dispose();
  }
}
