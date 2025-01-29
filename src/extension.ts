import * as vscode from "vscode";
/*
  - Handle "sync" after rebase, or document it. Cause sync does not work after rebase,
  you have to force push. Maybe we can rather open the conflicted diffs and handle it
  all in the extension
  - Rebase diff does not show as deletion
  
  - Create multiple additions, deletions and a mix in the same file
  - Verify overlapping hunks
  
  - Option to choose how dependencies should work
      - Show warning
      - Block and show message
      - Move dependencies along
  
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
import { init as initAnalytics, trackEvent } from "./analytics.js";

class CommitItem extends vscode.TreeItem {
  toJSON() {
    return {
      type: "CommitItem" as const,
      message: this.message,
      hash: this.hash,
    };
  }
  constructor(public readonly message: string, public readonly hash: string) {
    super(message);

    this.description = `${hash.substring(0, 7)}`;

    this.tooltip = `${message}\n${hash}`;
    this.iconPath = new vscode.ThemeIcon("git-commit");
    this.command = {
      command: "nicePr.showDiff",
      title: "Show Diff",
      arguments: [this],
    };
  }
}

class RebaseChangeItem extends vscode.TreeItem {
  static getLabel(change: RebaseCommitFileChange) {
    if (change.type === FileChangeType.ADD) {
      return "File added";
    }

    if (change.type === FileChangeType.RENAME) {
      return "File renamed from " + change.oldFileName;
    }

    if (change.type === FileChangeType.DELETE) {
      return "File deleted";
    }

    if (isTextFileChange(change)) {
      return change.modifications.join("\n");
    }

    return "Binary";
  }
  toJSON() {
    return {
      type: "RebaseChangeItem" as const,
      ref: this.ref,
      fileName: this.fileName,
      change: this.change,
    };
  }
  constructor(
    public readonly ref: string,
    public readonly fileName: string,
    public readonly change: RebaseCommitFileChange
  ) {
    super(
      change.isSetBeforeDependent
        ? `${RebaseChangeItem.getLabel(change)}
    
This change depends on changes from later commits`
        : RebaseChangeItem.getLabel(change)
    );
    this.id = "RebaseChangeItem-" + ref + "-" + fileName + "-" + change.index;
    this.iconPath = this.getIcon();
    this.contextValue = "droppableHunk";
    this.command = this.getCommand();
  }
  private getCommand() {
    if (isTextFileChange(this.change)) {
      return {
        command: "nicePr.showFileDiff",
        title: "Show File Changes",
        arguments: [this],
      };
    }
  }
  private getIcon() {
    if (this.change.isSetBeforeDependent) {
      return new vscode.ThemeIcon(
        "warning",
        new vscode.ThemeColor("charts.red")
      );
    }

    if (this.change.type === FileChangeType.ADD) {
      return new vscode.ThemeIcon(
        "plus",
        new vscode.ThemeColor("charts.green")
      );
    }

    if (this.change.type === FileChangeType.RENAME) {
      return new vscode.ThemeIcon(
        "arrow-right",
        new vscode.ThemeColor("charts.blue")
      );
    }

    if (this.change.type === FileChangeType.DELETE) {
      return new vscode.ThemeIcon("x", new vscode.ThemeColor("charts.red"));
    }

    if (isTextFileChange(this.change)) {
      const modificationType = getModificationTypeFromChange(this.change);
      return new vscode.ThemeIcon(
        "code",
        new vscode.ThemeColor(
          modificationType === "ADD"
            ? "charts.green"
            : modificationType === "DELETE"
            ? "charts.red"
            : "charts.yellow"
        )
      );
    }

    return new vscode.ThemeIcon("file-binary");
  }
}

class RebaseFileItem extends vscode.TreeItem {
  public readonly fileName: string;
  toJSON() {
    return {
      type: "RebaseFileItem" as const,
      ref: this.ref,
      file: this.file,
      fileName: this.fileName,
    };
  }
  constructor(
    public readonly ref: string,
    public readonly file: RebaseCommitFile
  ) {
    const parts = file.fileName.split("/");
    const lastFileNamePart = parts.pop() || "";

    super(
      file.hasChangeSetBeforeDependent
        ? `${lastFileNamePart}
  
This file has a change with dependencies to later commits`
        : lastFileNamePart,
      vscode.TreeItemCollapsibleState.Collapsed
    );

    this.id = "RebaseFileItem-" + ref + "-" + file.fileName;
    this.fileName = file.fileName;
    this.description = vscode.workspace.asRelativePath(parts.join("/"));

    this.iconPath = this.getIcon();
    this.tooltip = file.fileName;
    this.contextValue = "droppableFile";
    this.command = {
      command: "nicePr.showFileDiff",
      title: "Show File Changes",
      arguments: [this],
    };
  }
  private getIcon() {
    if (this.file.hasChangeSetBeforeDependent) {
      return new vscode.ThemeIcon(
        "warning",
        new vscode.ThemeColor("charts.red")
      );
    }
    return new vscode.ThemeIcon(
      "file",
      this.file.hasChanges ? new vscode.ThemeColor("charts.orange") : undefined
    );
  }
}

class TrashItem extends vscode.TreeItem {
  toJSON() {
    return {
      type: "TrashItem" as const,
    };
  }
  constructor(public readonly trash: RebaseCommitFile[]) {
    super("Trash", vscode.TreeItemCollapsibleState.Expanded);
    this.id = "TrashItem";
    this.iconPath = new vscode.ThemeIcon(
      "trash",
      new vscode.ThemeColor("charts.purple")
    );
    this.contextValue = "trash";
  }
}

class RebaseCommitItem extends vscode.TreeItem {
  toJSON() {
    return {
      type: "RebaseCommitItem" as const,
      commit: this.commit,
    };
  }
  constructor(public readonly commit: RebaseCommit) {
    super(
      commit.hasChangeSetBeforeDependent
        ? `${commit.message}

This commit has a change with dependencies to later commits
`
        : commit.message,
      vscode.TreeItemCollapsibleState.Expanded
    );

    // Set contextValue based on whether commit has changes
    this.id = "RebaseCommitItem-" + commit.hash;
    this.contextValue =
      this.commit.files.length === 0 ? "emptyCommit" : "droppableCommit";
    this.iconPath = this.getIcon();
    this.command = {
      command: "nicePr.editCommitMessage",
      title: "Edit Commit Message",
      arguments: [this.commit],
    };
  }
  private getIcon() {
    if (this.commit.hasChangeSetBeforeDependent) {
      return new vscode.ThemeIcon(
        "warning",
        new vscode.ThemeColor("charts.red")
      );
    }

    return new vscode.ThemeIcon(
      this.commit.files.length === 0 ? "kebab-vertical" : "git-commit",
      // We can check if it is a new commit by prefix of new- on commit hash
      new vscode.ThemeColor("charts.blue")
    );
  }
}

class RebasedCommitItem extends vscode.TreeItem {
  toJSON() {
    return {
      type: "RebasedCommitItem" as const,
      commit: this.commit,
    };
  }
  constructor(public readonly commit: RebaseCommit) {
    super(commit.message, vscode.TreeItemCollapsibleState.None);
    this.id = "RebasedCommitItem-" + commit.hash;
    this.iconPath = new vscode.ThemeIcon(
      "git-commit",
      new vscode.ThemeColor("charts.blue")
    );
    this.command = {
      command: "nicePr.showRebasedDiff",
      title: "Show rebased diff",
      // @ts-ignore
      arguments: [commit],
    };
  }
}

type RebaseTreeItem =
  | CommitItem
  | RebasedCommitItem
  | TrashItem
  | RebaseCommitItem
  | RebaseFileItem
  | RebaseChangeItem;

class RebaseTreeDataProvider
  implements vscode.TreeDataProvider<RebaseTreeItem | vscode.TreeItem>
{
  private _onDidChangeTreeData = new vscode.EventEmitter<
    RebaseTreeItem | undefined
  >();
  readonly onDidChangeTreeData = this._onDidChangeTreeData.event;
  private view: vscode.TreeView<RebaseTreeItem | vscode.TreeItem>;

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
      if ("toJSON" in source) {
        dataTransfer.set(
          this.dragMimeTypes[0],
          new vscode.DataTransferItem(source.toJSON())
        );
      }
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
    const sourceData: ReturnType<RebaseTreeItem["toJSON"]> = dataTransfer.get(
      this.dragMimeTypes[0]
    )?.value;

    if (!sourceData) {
      return;
    }

    // You can not drag and drop rebased commits or original commits
    if (
      sourceData.type === "RebasedCommitItem" ||
      target instanceof RebasedCommitItem ||
      sourceData.type === "CommitItem" ||
      target instanceof CommitItem
    ) {
      return;
    }

    if (sourceData.type === "TrashItem") {
      return;
    }

    if (sourceData.type === "RebaseCommitItem") {
      const targetRef =
        target instanceof TrashItem
          ? "trash"
          : target instanceof RebaseCommitItem
          ? target.commit.hash
          : target.ref;
      rebaser.moveCommit(sourceData.commit.hash, targetRef);
      const hasInvalidChange = Boolean(
        rebaser.rebaseCommits.find(
          (commit) => commit.hasChangeSetBeforeDependent
        )
      );

      trackEvent({ name: "moved_commit", props: { hasInvalidChange } });

      this._onDidChangeTreeData.fire(undefined);
      const fileNames = sourceData.commit.files.map((file) => file.fileName);

      fileNames.forEach((fileName) => {
        const hashesForFile = rebaser.getHashesForFile(fileName);
        hashesForFile.forEach((hash) => {
          nicePR.updateDiffView({ fileName, hash });
        });
      });
      return;
    }

    const changes =
      sourceData.type === "RebaseFileItem"
        ? sourceData.file.changes
        : [sourceData.change];

    changes.forEach((change) => {
      if (target instanceof TrashItem) {
        rebaser.moveChange(sourceData.fileName, change, "trash");
        return;
      }

      const targetRef =
        target instanceof RebaseCommitItem ? target.commit.hash : target.ref;

      rebaser.moveChange(sourceData.fileName, change, targetRef);
    });

    const hasInvalidChange = Boolean(
      rebaser.rebaseCommits.find((commit) => commit.hasChangeSetBeforeDependent)
    );

    trackEvent({
      name:
        sourceData.type === "RebaseFileItem" ? "moved_file" : "moved_change",
      props: { hasInvalidChange },
    });

    this._onDidChangeTreeData.fire(undefined);

    nicePR.updateDiffView({
      fileName: sourceData.fileName,
      hash: sourceData.ref,
    });
  }

  getTreeItem(
    element: RebaseTreeItem
  ): vscode.TreeItem | Thenable<vscode.TreeItem> {
    return element;
  }

  // This is where we build up the tree items
  async getChildren(
    element?: RebaseTreeItem
  ): Promise<Array<RebaseTreeItem | vscode.TreeItem>> {
    if (this.initializer.state.state !== "INITIALIZED") {
      return [];
    }

    const mode = this.initializer.state.nicePR.mode;

    if (mode.mode === "PUSHING" || mode.mode === "SUGGESTING") {
      return [];
    }

    if (mode.mode === "IDLE") {
      return this.initializer.state.nicePR.commits.map(
        (commit) => new CommitItem(commit.message, commit.hash)
      );
    }

    const rebaser = mode.rebaser;
    const rebaseCommits = rebaser.rebaseCommits;

    if (mode.mode === "READY_TO_PUSH") {
      const rebasedCommits = rebaseCommits
        .filter((commit) => Boolean(commit.files.length))
        .map((commit) => new RebasedCommitItem(commit));
      const commits = this.initializer.state.nicePR.commits.map(
        (commit) => new CommitItem(commit.message, commit.hash)
      );

      return [
        new vscode.TreeItem(
          "# NEW HISTORY:",
          vscode.TreeItemCollapsibleState.None
        ),
        ...rebasedCommits,
        new vscode.TreeItem(
          "# PREVIOUS HISTORY:",
          vscode.TreeItemCollapsibleState.None
        ),
        ...commits,
      ];
    }

    if (!element) {
      return [
        new TrashItem(rebaser.getTrash()),
        ...rebaseCommits.map((commit) => new RebaseCommitItem(commit)),
      ];
    }

    if (element instanceof TrashItem) {
      return element.trash.map((file) => new RebaseFileItem("trash", file));
    }

    if (element instanceof RebaseCommitItem) {
      const commit = element.commit;

      return commit.files.map((file) => new RebaseFileItem(commit.hash, file));
    }

    if (element instanceof RebaseFileItem) {
      const changes = element.file.changes;

      return changes.map(
        (change) =>
          new RebaseChangeItem(element.ref, element.file.fileName, change)
      );
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
      title = "Commits";

      if (nicePR.mode.mode === "REBASING") {
        title = "Rebasing";
      } else if (nicePR.mode.mode === "READY_TO_PUSH") {
        title = "Reviewing";
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
          stateChangeDisposer.dispose();
          this.initializeRepo(repo);
        }
      });

      this.state = {
        state: "INITIALIZING",
        repo,
        abortController,
        dispose() {
          abortController.abort();
        },
      };

      // We'll wait for the branch to be available
      if (!branch) {
        return;
      }

      const commits = await getBranchCommits(repo, branch);

      if (abortController.signal.aborted) {
        stateChangeDisposer.dispose();
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
  const rebaseTreeDataProvider = new RebaseTreeDataProvider(initializer);

  initAnalytics(context);

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
    vscode.commands.registerCommand("nicePr.revertBranch", async () => {
      if (initializer.state.state !== "INITIALIZED") {
        return;
      }

      try {
        await initializer.state.nicePR.revertToBackupBranch();
      } catch (error) {
        vscode.window.showWarningMessage(String(error).replace("Error: ", ""));
      }
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
      trackEvent({
        name: "edit_commits_cancelled",
      });
    }),
    vscode.commands.registerCommand("nicePr.approveRebase", () => {
      if (initializer.state.state !== "INITIALIZED") {
        return;
      }

      initializer.state.nicePR.setRebaseMode("READY_TO_PUSH");
      const rebaser = initializer.state.nicePR.getRebaser();

      trackEvent({
        name: "edit_commits_approved",
        props: {
          changesCount: rebaser.getChangesCount(),
          trashedCount: rebaser
            .getTrash()
            .reduce((acc, file) => acc + file.changes.length, 0),
        },
      });
    }),
    vscode.commands.registerCommand("nicePr.editRebase", () => {
      if (initializer.state.state !== "INITIALIZED") {
        return;
      }

      const currentMode = initializer.state.nicePR.mode.mode;

      initializer.state.nicePR.setRebaseMode("REBASING");
      trackEvent({
        name: "edited_commits",
        props: { isInitialEdit: currentMode === "IDLE" },
      });
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
          trackEvent({ name: "changed_commit_message" });
        }
      }
    ),
    vscode.commands.registerCommand(
      "nicePr.removeCommit",
      (treeItem: RebaseTreeItem) => {
        if (initializer.state.state !== "INITIALIZED") {
          return;
        }

        if (treeItem instanceof RebaseCommitItem) {
          initializer.state.nicePR.removeCommit(treeItem.commit.hash);
          trackEvent({ name: "commit_removed" });
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
        trackEvent({ name: "commit_added" });
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
          (item instanceof RebaseFileItem && item.file.changes.length === 0) ||
          item.ref === "trash"
        ) {
          return;
        }

        // Add this as well to the click of a hunk, though pass the selection
        return initializer.state.nicePR.showFileDiff({
          fileName: item.fileName,
          hash: item.ref,
          selection:
            item instanceof RebaseChangeItem &&
            item.change.type === FileChangeType.MODIFY &&
            item.change.fileType === "text"
              ? {
                  from: item.change.modificationRange[0],
                  to: item.change.modificationRange[1],
                }
              : undefined,
        });
      }
    )
  );
}

export function deactivate() {}
