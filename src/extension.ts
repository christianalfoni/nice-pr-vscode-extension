import * as vscode from "vscode";

/*
  - Create backup branch with a known prefix to identify if a backup is available. Run the backup as part
  of the rebase + push process. Make sure the back is kept up to date if already exists
  - Create crash report feature
  - Write final file operations snapshot tests from diffs and making changes, remember to write for trash as well
*/

import {
  RebaseCommit,
  RebaseCommitFile,
  RebaseCommitFileChange,
} from "./Rebaser.js";
import {
  FileChangeType,
  getModificationTypeFromChange,
  isTextFileChange,
  getBranchCommits,
} from "./utils.js";
import { InMemoryContentProvider, NicePR } from "./NicePR.js";
import { API, Repository } from "./git.js";

type CommitItem = {
  hash: string;
  message: string;
};

class BranchTreeDataProvider
  implements vscode.TreeDataProvider<CommitItem | string>
{
  private _onDidChangeTreeData = new vscode.EventEmitter<
    CommitItem | string | undefined
  >();
  readonly onDidChangeTreeData = this._onDidChangeTreeData.event;
  private view: vscode.TreeView<CommitItem | string>;

  constructor(private initializer: Initializer) {
    vscode.window.registerTreeDataProvider("nicePrView", this);
    this.view = vscode.window.createTreeView("nicePrView", {
      treeDataProvider: this,
      showCollapseAll: false,
    });
    this.initializer.onDidChange(() => this.refresh());
  }

  async getTreeItem(element: CommitItem | string): Promise<vscode.TreeItem> {
    if (typeof element === "string") {
      return new vscode.TreeItem(element);
    }

    const item = new vscode.TreeItem(element.message);
    item.description = `${element.hash.substring(0, 7)}`;
    item.tooltip = `${element.message}\n${element.hash}`;
    item.iconPath = new vscode.ThemeIcon("git-commit");
    item.command = {
      command: "nicePr.showDiff",
      title: "Show Diff",
      arguments: [element],
    };

    return item;
  }

  async getChildren(): Promise<(CommitItem | string)[]> {
    return this.initializer.state.state === "INITIALIZED"
      ? this.initializer.state.nicePR.commits
      : [];
  }

  refresh(): void {
    this.view.title = "Original Commits";
    this._onDidChangeTreeData.fire(undefined);
  }
}

interface TrashItem {
  type: "trash";
  trash: RebaseCommitFile[];
}

interface RebaseCommitItem {
  type: "commit";
  commit: RebaseCommit;
}

interface RebasedCommitItem {
  type: "rebasedCommit";
  commit: RebaseCommit;
}

interface RebaseFileItem {
  type: "file";
  file: RebaseCommitFile;
  fileChangeType: FileChangeType;
  fileName: string;
  // Ref can be a hash or "trash"
  ref: string;
}

interface RebaseChangeItem {
  type: "change";
  change: RebaseCommitFileChange;
  // Ref can be a hash or "trash"
  ref: string;
  fileName: string;
}

type RebaseTreeItem =
  | RebasedCommitItem
  | TrashItem
  | RebaseCommitItem
  | RebaseFileItem
  | RebaseChangeItem;

class RebaseTreeDataProvider
  implements vscode.TreeDataProvider<RebaseTreeItem>
{
  private _onDidChangeTreeData = new vscode.EventEmitter<
    RebaseTreeItem | undefined
  >();
  readonly onDidChangeTreeData = this._onDidChangeTreeData.event;
  private view: vscode.TreeView<RebaseTreeItem>;

  constructor(private initializer: Initializer) {
    this.view = vscode.window.createTreeView("nicePrRebaseView", {
      treeDataProvider: this,
      showCollapseAll: false,
      dragAndDropController: this,
    });
    this.initializer.onDidChange(() => this.refresh());
  }

  dropMimeTypes = ["application/vnd.code.tree.niceprdrop"] as const;
  dragMimeTypes = ["application/vnd.code.tree.niceprdrop"] as const;
  handleDrag(sources: RebaseTreeItem[], dataTransfer: vscode.DataTransfer) {
    sources.forEach((source) => {
      dataTransfer.set(
        this.dragMimeTypes[0],
        new vscode.DataTransferItem(source)
      );
    });
  }
  handleDrop(
    target: RebaseTreeItem | undefined,
    dataTransfer: vscode.DataTransfer
  ) {
    if (!target || this.initializer.state.state !== "INITIALIZED") {
      return;
    }

    const nicePR = this.initializer.state.nicePR;
    const rebaser = nicePR.getRebaser();

    const source: RebaseTreeItem = dataTransfer.get(
      this.dragMimeTypes[0]
    )?.value;

    if (!source) {
      return;
    }

    // You can not drag and drop rebased commits
    if (source.type === "rebasedCommit" || target.type === "rebasedCommit") {
      return;
    }

    if (source.type === "trash") {
      return;
    }

    if (source.type === "commit") {
      const targetRef =
        target.type === "trash"
          ? "trash"
          : target.type === "commit"
          ? target.commit.hash
          : target.ref;
      rebaser.moveCommit(source.commit.hash, targetRef);
      this._onDidChangeTreeData.fire(undefined);
      const fileNames = source.commit.files.map((file) => file.fileName);

      fileNames.forEach((fileName) => {
        const hashesForFile = rebaser.getHashesForFile(fileName);
        hashesForFile.forEach((hash) => {
          nicePR.updateDiffView({ fileName, hash });
        });
      });
      return;
    }

    const changes =
      source.type === "file" ? source.file.changes : [source.change];

    changes.forEach((change) => {
      if (target.type === "trash") {
        rebaser.moveChange(source.fileName, change, "trash");
        return;
      }

      const targetRef =
        target.type === "commit" ? target.commit.hash : target.ref;

      if (source.ref === "trash") {
        rebaser.moveChange(source.fileName, change, targetRef);
        return;
      }

      rebaser.moveChange(source.fileName, change, targetRef);
    });

    this._onDidChangeTreeData.fire(undefined);

    nicePR.updateDiffView({
      fileName: source.fileName,
      hash: source.ref,
    });
  }

  // This is where we RENDER the tree item
  async getTreeItem(element: RebaseTreeItem): Promise<vscode.TreeItem> {
    if (element.type === "rebasedCommit") {
      const item = new vscode.TreeItem(element.commit.message);
      item.iconPath = new vscode.ThemeIcon("git-commit");
      item.contextValue = "droppableCommit";
      item.command = {
        command: "nicePr.showRebasedDiff",
        title: "Show rebased diff",
        // @ts-ignore
        arguments: [element.commit],
      };
      return item;
    }

    if (
      element.type === "change" &&
      element.change.type === FileChangeType.ADD
    ) {
      const change = element.change;
      const item = new vscode.TreeItem("Add file");
      item.iconPath = new vscode.ThemeIcon(
        change.isSetBeforeDependent ? "warning" : "plus",
        new vscode.ThemeColor(
          change.isSetBeforeDependent
            ? "debugTokenExpression.error"
            : "gitDecoration.addedResourceForeground"
        )
      );
      item.contextValue = "droppableHunk";

      return item;
    }

    if (
      element.type === "change" &&
      element.change.type === FileChangeType.RENAME
    ) {
      const change = element.change;
      const item = new vscode.TreeItem("Rename from " + change.oldFileName);
      item.iconPath = new vscode.ThemeIcon(
        change.isSetBeforeDependent ? "warning" : "arrow-right",
        new vscode.ThemeColor(
          change.isSetBeforeDependent
            ? "debugTokenExpression.error"
            : "gitDecoration.renamedResourceForeground"
        )
      );
      item.contextValue = "droppableHunk";

      return item;
    }

    if (
      element.type === "change" &&
      element.change.type === FileChangeType.DELETE
    ) {
      const change = element.change;
      const item = new vscode.TreeItem("Delete");
      item.iconPath = new vscode.ThemeIcon(
        change.isSetBeforeDependent ? "warning" : "x",
        new vscode.ThemeColor(
          change.isSetBeforeDependent
            ? "debugTokenExpression.error"
            : "gitDecoration.deletedResourceForeground"
        )
      );
      item.contextValue = "droppableHunk";

      return item;
    }

    if (element.type === "change" && isTextFileChange(element.change)) {
      const change = element.change;
      const modificationType = getModificationTypeFromChange(change);
      const item = new vscode.TreeItem(change.lines.join("\n"));
      const hasWarning = change.isSetBeforeDependent;
      item.iconPath = new vscode.ThemeIcon(
        hasWarning ? "warning" : "code",
        new vscode.ThemeColor(
          hasWarning
            ? "debugTokenExpression.error"
            : modificationType === "ADD"
            ? "gitDecoration.addedResourceForeground"
            : modificationType === "DELETE"
            ? "gitDecoration.deletedResourceForeground"
            : "gitDecoration.modifiedResourceForeground"
        )
      );
      item.contextValue = "droppableHunk";
      // Add command to show diff when clicking the file
      item.command = {
        command: "nicePr.showFileDiff",
        title: "Show File Changes",
        arguments: [element],
      };
      return item;
    }

    if (element.type === "file") {
      const parts = element.fileName.split("/");
      const fileName = parts.pop() || "";

      const item = new vscode.TreeItem(
        fileName,
        vscode.TreeItemCollapsibleState.Collapsed
      );

      item.description = vscode.workspace.asRelativePath(parts.join("/"));

      const hasWarning = element.file.hasChangeSetBeforeDependent;

      item.iconPath = new vscode.ThemeIcon(
        hasWarning ? "warning" : "file",
        new vscode.ThemeColor(
          hasWarning
            ? "debugTokenExpression.error"
            : element.fileChangeType === FileChangeType.MODIFY
            ? "gitDecoration.modifiedResourceForeground"
            : element.fileChangeType === FileChangeType.ADD
            ? "gitDecoration.addedResourceForeground"
            : element.fileChangeType === FileChangeType.DELETE
            ? "gitDecoration.deletedResourceForeground"
            : "gitDecoration.renamedResourceForeground"
        )
      );
      item.tooltip = element.fileName;
      item.contextValue = "droppableFile"; // Change to droppable
      // Add command to show diff when clicking the file
      item.command = {
        command: "nicePr.showFileDiff",
        title: "Show File Changes",
        arguments: [element],
      };
      return item;
    }

    if (element.type === "trash") {
      const item = new vscode.TreeItem(
        "Trash",
        vscode.TreeItemCollapsibleState.Expanded
      );
      item.iconPath = new vscode.ThemeIcon(
        "trash",
        new vscode.ThemeColor("debugTokenExpression.error")
      );
      item.contextValue = "trash";
      return item;
    }

    if (element.type === "commit") {
      const item = new vscode.TreeItem(
        element.commit.message,
        vscode.TreeItemCollapsibleState.Expanded
      );
      const hasWarning = element.commit.hasChangeSetBeforeDependent;
      item.iconPath = new vscode.ThemeIcon(
        element.commit.files.length === 0
          ? "kebab-vertical"
          : hasWarning
          ? "warning"
          : "git-commit",
        new vscode.ThemeColor(
          hasWarning
            ? "debugTokenExpression.error"
            : "scmGraph.historyItemRefColor"
        )
      );
      // Set contextValue based on whether commit has changes
      item.contextValue =
        element.commit.files.length === 0 ? "emptyCommit" : "droppableCommit";
      item.command = {
        command: "nicePr.editCommitMessage",
        title: "Edit Commit Message",
        arguments: [element.commit],
      };
      return item;
    }

    const item = new vscode.TreeItem(
      // @ts-ignore
      element.commit.message,
      vscode.TreeItemCollapsibleState.Expanded
    );
    item.iconPath = new vscode.ThemeIcon(
      // @ts-ignore
      element.commit.changeIds.length === 0 ? "kebab-vertical" : "git-commit"
    );
    item.contextValue = "droppableCommit";
    item.command = {
      command: "nicePr.editCommitMessage",
      title: "Edit Commit Message",
      // @ts-ignore
      arguments: [element.commit],
    };
    return item;
  }

  // This is where we build up the tree items
  async getChildren(element?: RebaseTreeItem): Promise<RebaseTreeItem[]> {
    if (this.initializer.state.state !== "INITIALIZED") {
      return [];
    }

    const mode = this.initializer.state.nicePR.mode;

    if (
      mode.mode === "IDLE" ||
      mode.mode === "PUSHING" ||
      mode.mode === "SUGGESTING"
    ) {
      return [];
    }

    const rebaser = mode.rebaser;
    const rebaseCommits = rebaser.getRebaseCommits();

    if (mode.mode === "READY_TO_PUSH") {
      return rebaseCommits
        .filter((commit) => Boolean(commit.files.length))
        .map((commit) => ({ type: "rebasedCommit", commit }));
    }

    if (!element) {
      return [
        {
          type: "trash",
          trash: rebaser.getTrash(),
        },
        ...rebaseCommits.map((commit) => ({
          type: "commit" as const,
          commit,
        })),
      ];
    }

    if (element.type === "trash") {
      return element.trash.map((file) => ({
        type: "file" as const,
        ref: "trash",
        fileChangeType: rebaser.getFileChangeType(file.fileName),
        file,
        fileName: file.fileName,
        changes: file.changes,
      }));
    }

    if (element.type === "commit") {
      const commit = element.commit;

      return commit.files.map((file) => ({
        type: "file" as const,
        file,
        ref: commit.hash,
        fileChangeType: rebaser.getFileChangeType(file.fileName),
        fileName: file.fileName,
        changes: file.changes,
      }));
    }

    if (element.type === "file") {
      const changes = element.file.changes;

      return changes.map((change) => ({
        type: "change",
        change,
        fileName: element.fileName,
        ref: element.ref,
      }));
    }

    return [];
  }

  refresh(): void {
    let title: string;

    if (this.initializer.state.state === "IDLE") {
      title = "No active repository";
    } else if (this.initializer.state.state === "INITIALIZING") {
      title = "Initializing repository";
    } else if (this.initializer.state.state === "ERROR") {
      title = this.initializer.state.error;
    } else {
      const nicePR = this.initializer.state.nicePR;
      title = "Ready to rebase";

      if (nicePR.mode.mode === "REBASING") {
        title = "Rebasing";
      } else if (nicePR.mode.mode === "READY_TO_PUSH") {
        title = "Review and Push";
      }
    }

    this.view.title = title;
    this._onDidChangeTreeData.fire(undefined);
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

type InitializerState =
  | {
      state: "IDLE";
    }
  | {
      state: "INITIALIZING";
      repo: Repository;
      abortController: AbortController;
      dispose(): void;
    }
  | {
      state: "INITIALIZED";
      repo: Repository;
      nicePR: NicePR;
      dispose(): void;
    }
  | {
      state: "ERROR";
      error: string;
    };

class Initializer {
  private _onDidChange = new vscode.EventEmitter<void>();
  readonly onDidChange = this._onDidChange.event;
  private _state: InitializerState = {
    state: "IDLE",
  };
  get state() {
    return this._state;
  }
  set state(state) {
    if ("dispose" in this._state) {
      this._state.dispose();
    }

    this._state = state;
    this._onDidChange.fire();
  }
  static async create(
    context: vscode.ExtensionContext,
    contentProvider: InMemoryContentProvider
  ) {
    const gitExtension = await getGitExtension();

    if (!gitExtension) {
      throw new Error("No Git Extension found");
    }

    const api: API = gitExtension.getAPI(1);

    if (!api) {
      throw new Error("No Git Extension API found");
    }

    return new Initializer(context, contentProvider, api);
  }
  constructor(
    _context: vscode.ExtensionContext,
    private _inMemoryContentProvider: InMemoryContentProvider,
    private _api: API
  ) {
    _context.subscriptions.push(
      _api.onDidOpenRepository(async (repo) => {
        this.initializeRepo(repo);
      }),
      _api.onDidCloseRepository((repo) => {
        if (
          (this.state.state === "INITIALIZED" ||
            this.state.state === "INITIALIZING") &&
          this.state.repo === repo
        ) {
          this.state = { state: "IDLE" };
        }
      })
    );

    const initialRepo = _api.repositories[0];

    if (initialRepo) {
      this.initializeRepo(initialRepo);
    }
  }
  private async initializeRepo(repo: Repository) {
    try {
      const branch = repo.state.HEAD?.name;
      const abortController = new AbortController();
      const stateChangeDisposer = repo.state.onDidChange(() => {
        // Any change to the branch while initializing or initialized should
        // trigger a new initialize
        if (
          (this.state.state === "INITIALIZING" ||
            this.state.state === "INITIALIZED") &&
          this.state.repo === repo &&
          repo.state.HEAD?.name !== branch
        ) {
          this.initializeRepo(repo);
        }
      });

      this.state = {
        state: "INITIALIZING",
        repo,
        abortController,
        dispose() {
          abortController.abort();
          stateChangeDisposer.dispose();
        },
      };

      if (branch) {
        const commits = await getBranchCommits(repo, branch);

        if (abortController.signal.aborted) {
          return;
        }

        const contentProvider = this._inMemoryContentProvider;

        const nicePR = new NicePR({
          contentProvider: this._inMemoryContentProvider,
          api: this._api,
          repo,
          branch,
          commits,
        });

        const nicePRChangeDisposer = nicePR.onDidChange(() => {
          this._onDidChange.fire();
        });

        this.state = {
          state: "INITIALIZED",
          repo,
          nicePR,
          dispose() {
            stateChangeDisposer.dispose();
            nicePRChangeDisposer.dispose();
            contentProvider.clearAll();
            nicePR.dispose();
          },
        };
      }
    } catch (error) {
      this.state = {
        state: "ERROR",
        error: String(error),
      };
    }

    this._onDidChange.fire();
  }
}

export async function activate(context: vscode.ExtensionContext) {
  const contentProvider = new InMemoryContentProvider();
  const initializer = await Initializer.create(context, contentProvider);
  const treeDataProvider = new BranchTreeDataProvider(initializer);
  const rebaseTreeDataProvider = new RebaseTreeDataProvider(initializer);

  context.subscriptions.push(
    vscode.workspace.registerTextDocumentContentProvider(
      "nice-pr-diff",
      contentProvider
    ),
    vscode.commands.registerCommand(
      "nicePr.showDiff",
      (commit: CommitItem) =>
        initializer.state.state === "INITIALIZED" &&
        initializer.state.nicePR.showCommitDiff(commit)
    ),
    vscode.commands.registerCommand(
      "nicePr.showRebasedDiff",
      (commit: CommitItem) => {
        if (initializer.state.state !== "INITIALIZED") {
          return;
        }

        initializer.state.nicePR.showRebasedCommitDiff(commit);
      }
    ),
    vscode.commands.registerCommand("nicePr.startRebase", () => {
      if (initializer.state.state !== "INITIALIZED") {
        return;
      }

      initializer.state.nicePR.setRebaseMode("REBASING");
    }),
    vscode.commands.registerCommand("nicePr.revertBranch", () => {
      if (initializer.state.state !== "INITIALIZED") {
        return;
      }

      initializer.state.nicePR.revertToBackupBranch();
    }),
    vscode.commands.registerCommand("nicePr.suggest", () => {
      if (initializer.state.state !== "INITIALIZED") {
        return;
      }

      initializer.state.nicePR.setRebaseMode("SUGGESTING");
    }),
    vscode.commands.registerCommand("nicePr.cancelRebase", () => {
      if (initializer.state.state !== "INITIALIZED") {
        return;
      }

      initializer.state.nicePR.setRebaseMode("IDLE");
    }),
    vscode.commands.registerCommand("nicePr.approveRebase", () => {
      if (initializer.state.state !== "INITIALIZED") {
        return;
      }

      initializer.state.nicePR.setRebaseMode("READY_TO_PUSH");
    }),
    vscode.commands.registerCommand("nicePr.editRebase", () => {
      if (initializer.state.state !== "INITIALIZED") {
        return;
      }

      initializer.state.nicePR.setRebaseMode("REBASING");
    }),
    vscode.commands.registerCommand("nicePr.rebase", () => {
      if (initializer.state.state !== "INITIALIZED") {
        return;
      }

      initializer.state.nicePR.setRebaseMode("PUSHING");
    }),
    vscode.commands.registerCommand(
      "nicePr.editCommitMessage",
      async (rebaseCommit: RebaseCommit) => {
        if (initializer.state.state !== "INITIALIZED") {
          return;
        }

        const newMessage = await vscode.window.showInputBox({
          prompt: "Edit commit message",
          value: rebaseCommit.message,
        });

        if (newMessage !== undefined) {
          await initializer.state.nicePR.updateCommitMessage(
            rebaseCommit.hash,
            newMessage
          );
        }
      }
    ),
    vscode.commands.registerCommand(
      "nicePr.removeCommit",
      (treeItem: RebaseTreeItem) => {
        if (initializer.state.state !== "INITIALIZED") {
          return;
        }

        if (treeItem?.type === "commit") {
          initializer.state.nicePR.removeCommit(treeItem.commit.hash);
        }
      }
    ),
    vscode.commands.registerCommand("nicePr.addCommit", async () => {
      if (initializer.state.state !== "INITIALIZED") {
        return;
      }

      const message = await vscode.window.showInputBox({
        prompt: "Enter commit message",
        placeHolder: "feat: my new feature",
      });

      if (message) {
        initializer.state.nicePR.addNewCommit(message);
      }
    }),
    // Register the command for internal use
    vscode.commands.registerCommand(
      "nicePr.showFileDiff",
      (item: RebaseFileItem | RebaseChangeItem) => {
        if (initializer.state.state !== "INITIALIZED") {
          return;
        }

        if (
          (item.type === "file" && item.file.changes.length === 0) ||
          item.ref === "trash"
        ) {
          return;
        }

        // Add this as well to the click of a hunk, though pass the selection
        return initializer.state.nicePR.showFileDiff({
          fileName: item.fileName,
          hash: item.ref,
          selection:
            item.type === "change" &&
            item.change.type === FileChangeType.MODIFY &&
            item.change.fileType === "text"
              ? {
                  from: item.change.newStart,
                  to:
                    item.change.newStart +
                    (item.change.oldLines || item.change.newLines) -
                    1,
                }
              : undefined,
        });
      }
    )
  );
}

export function deactivate() {}
