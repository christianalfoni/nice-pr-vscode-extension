import * as vscode from "vscode";
import { API, Change, Commit, Repository, Status } from "./git";
import * as cp from "child_process";
import { Rebaser, ResponseSchema } from "./Rebaser";
import { promisify } from "util";
import {
  FileChangeType,
  getFileOperationChangeFromChanges as getFileOperationChangeFromChanges,
  getParentCommitHash,
  getBranchCommits,
} from "./utils";
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

// Add these helper functions at the top of the file
async function executeGitCommand(
  repo: Repository,
  command: string
): Promise<string> {
  const { stdout } = await execAsync(`git ${command}`, {
    cwd: repo.rootUri.fsPath,
  });

  return stdout;
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
                  /*
                  content: vscode.workspace
                    .getConfiguration("nicePr")
                    .get("suggestionInstructions")!,*/
                  content: `You are an assistant that creates a nice PR for an other engineer to review.
                  
Please follow these instructions:

- Evaluate what commit messages and diffs are actuall relevant for a PR
- Create new commit messages that describes the changes in a clear way. Do not create commits for debugging, linting,
formatting or other non-functional changes
- Evaluate what diffs are relevant for the PR and assign them to the respective generated commits
- Diffs that can be safely ignored should be marked as dropped
`,
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

            console.log(parsedResponse);

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
                `diff --unified=0 ${getParentCommitHash(commit)} ${commit.hash}`
              ).then((diff) => ({ commit, diff }))
            )
        );

        this.mode = {
          mode: "REBASING",
          rebaser: new Rebaser(diffs),
        };
        break;
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

        await this.rebase();
        await executeGitCommand(
          this._repo,
          `push origin ${this._branch} --force-with-lease`
        );
        this.setRebaseMode("IDLE");
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
        `show ${mergeBase}:${oldFileName || fileName}`
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

    // With renames we need to get the contents by the previous file name
    const originalContent = await this.getInitialFileContents(fileName, hash);

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
                  this.getInitialFileContents(file.fileName, commit.hash)
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
      await executeGitCommand(this._repo, `add .`);
      await executeGitCommand(
        this._repo,
        `commit -m "${commitOperation.message}"`
      );
    }
  }
}
