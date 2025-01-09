import * as vscode from "vscode";

/*
  - Write final file operations snapshot tests from diffs and making changes, remember to write for trash as well
  - Create backup branch with a known prefix to identify if a backup is available. Run the backup as part
  of the rebase + push process. Make sure the back is kept up to date if already exists
*/

import {
  RebaseCommit,
  RebaseCommitFile,
  RebaseCommitFileChange,
} from "./Rebaser";
import {
  FileChangeType,
  getFileOperationChangeFromChanges,
  getLineChanges,
  isTextFileChange,
} from "./utils";
import { GitState } from "./GitState";

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

  constructor(private gitState: GitState) {
    vscode.window.registerTreeDataProvider("nicePrView", this);
    this.view = vscode.window.createTreeView("nicePrView", {
      treeDataProvider: this,
      showCollapseAll: false,
    });
    this.gitState.onDidChange(() => this.refresh());
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
    return this.gitState.commits;
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

  constructor(private gitState: GitState) {
    this.view = vscode.window.createTreeView("nicePrRebaseView", {
      treeDataProvider: this,
      showCollapseAll: false,
      dragAndDropController: this,
    });
    this.gitState.onDidChange(() => this.refresh());
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
    if (!target) {
      return;
    }

    const rebaser = this.gitState.getRebaser();

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
          this.gitState.updateDiffView({ fileName, hash });
        });
      });
      return;
    }

    const changes =
      source.type === "file" ? source.file.changes : [source.change];

    changes.forEach((change) => {
      if (target.type === "trash") {
        rebaser.moveChangeToTrash(source.fileName, change);
        return;
      }

      const targetRef =
        target.type === "commit" ? target.commit.hash : target.ref;

      if (source.ref === "trash") {
        rebaser.moveChangeFromTrash(source.fileName, change, targetRef);
        return;
      }

      rebaser.moveChange(source.fileName, change, targetRef);
    });

    this._onDidChangeTreeData.fire(undefined);

    this.gitState.updateDiffView({
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
        change.isSetBeforeDependent ? "warning" : "plus"
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
        change.isSetBeforeDependent ? "warning" : "arrow-right"
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
        change.isSetBeforeDependent ? "warning" : "x"
      );
      item.contextValue = "droppableHunk";

      return item;
    }

    if (element.type === "change" && isTextFileChange(element.change)) {
      const change = element.change;
      const item = new vscode.TreeItem(getLineChanges(change).join("\n"));
      item.iconPath = new vscode.ThemeIcon(
        change.isSetBeforeDependent ? "warning" : "code"
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

      const fileOperationChange = getFileOperationChangeFromChanges(
        element.file.changes
      );

      item.iconPath = new vscode.ThemeIcon(
        element.file.hasChangeSetBeforeDependent ? "warning" : "file"
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
      item.iconPath = new vscode.ThemeIcon("trash");
      item.contextValue = "trash";
      return item;
    }

    if (element.type === "commit") {
      const item = new vscode.TreeItem(
        element.commit.message,
        vscode.TreeItemCollapsibleState.Expanded
      );
      item.iconPath = new vscode.ThemeIcon(
        element.commit.files.length === 0
          ? "kebab-vertical"
          : element.commit.hasChangeSetBeforeDependent
          ? "warning"
          : "git-commit"
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
    const mode = this.gitState.mode;

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
    let title = "Waiting to rebase";

    if (this.gitState.mode.mode === "REBASING") {
      title = "Rebasing";
    } else if (this.gitState.mode.mode === "READY_TO_PUSH") {
      title = "Review and Push";
    }

    this.view.title = title;
    this._onDidChangeTreeData.fire(undefined);
  }
}

export async function activate(context: vscode.ExtensionContext) {
  const gitState = new GitState(context);
  const treeDataProvider = new BranchTreeDataProvider(gitState);
  const rebaseTreeDataProvider = new RebaseTreeDataProvider(gitState);

  context.subscriptions.push(
    vscode.commands.registerCommand("nicePr.showDiff", (commit: CommitItem) =>
      gitState.showCommitDiff(commit)
    ),
    vscode.commands.registerCommand(
      "nicePr.showRebasedDiff",
      (commit: CommitItem) => gitState.showRebasedCommitDiff(commit)
    ),
    vscode.commands.registerCommand("nicePr.startRebase", () => {
      gitState.setRebaseMode("REBASING");
    }),
    vscode.commands.registerCommand("nicePr.suggest", () => {
      gitState.setRebaseMode("SUGGESTING");
    }),
    vscode.commands.registerCommand("nicePr.cancelRebase", () => {
      gitState.setRebaseMode("IDLE");
    }),
    vscode.commands.registerCommand("nicePr.approveRebase", () => {
      gitState.setRebaseMode("READY_TO_PUSH");
    }),
    vscode.commands.registerCommand("nicePr.editRebase", () => {
      gitState.setRebaseMode("REBASING");
    }),
    vscode.commands.registerCommand("nicePr.rebase", () => {
      gitState.setRebaseMode("PUSHING");
    }),
    vscode.commands.registerCommand(
      "nicePr.editCommitMessage",
      async (rebaseCommit: RebaseCommit) => {
        const newMessage = await vscode.window.showInputBox({
          prompt: "Edit commit message",
          value: rebaseCommit.message,
        });

        if (newMessage !== undefined) {
          await gitState.updateCommitMessage(rebaseCommit.hash, newMessage);
        }
      }
    ),
    vscode.commands.registerCommand(
      "nicePr.removeCommit",
      (treeItem: RebaseTreeItem) => {
        if (treeItem?.type === "commit") {
          gitState.removeCommit(treeItem.commit.hash);
        }
      }
    ),
    vscode.commands.registerCommand("nicePr.selectHunk", () => {}),
    vscode.commands.registerCommand("nicePr.selectCommit", () => {}),
    vscode.commands.registerCommand("nicePr.addCommit", async () => {
      const message = await vscode.window.showInputBox({
        prompt: "Enter commit message",
        placeHolder: "feat: my new feature",
      });

      if (message) {
        gitState.addNewCommit(message);
      }
    }),
    // Register the command for internal use
    vscode.commands.registerCommand(
      "nicePr.showFileDiff",
      (item: RebaseFileItem | RebaseChangeItem) => {
        if (item.type === "file" && item.file.changes.length === 0) {
          return;
        }

        // Add this as well to the click of a hunk, though pass the selection
        return gitState.showFileDiff({
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
