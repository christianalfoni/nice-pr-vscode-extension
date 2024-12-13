import { applyPatch } from "diff";
import * as vscode from "vscode";
import { API, Repository, Status } from "./git";

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
        originalUri: toGitUri(change.uri, originalRef),
        modifiedUri: toGitUri(change.renameUri, modifiedRef),
      };
    default:
      return {
        originalUri: toGitUri(change.uri, originalRef),
        modifiedUri: toGitUri(change.uri, modifiedRef),
      };
  }
}

interface HunkData {
  id: string; // New property
  oldStart: number;
  oldLength: number;
  newStart: number;
  newLength: number;
  diffText: string;
  parentCommitHash?: string; // Add this to track original commit
}

interface BaseChange {
  id: string;
  uri: vscode.Uri;
  index: number; // Add this line
}

interface ModifiedChange extends BaseChange {
  status: Status.MODIFIED;
  oldStart: number;
  oldLength: number;
  newStart: number;
  newLength: number;
  diffText: string;
}

interface DeletedChange extends BaseChange {
  status: Status.DELETED;
}

interface AddedChange extends BaseChange {
  status: Status.INDEX_ADDED;
}

interface RenamedChange extends BaseChange {
  status: Status.INDEX_RENAMED;
  renameUri: vscode.Uri;
}

type Change = ModifiedChange | AddedChange | DeletedChange | RenamedChange;

interface CommitItem {
  message: string;
  hash: string;
  changes: Change[];
}

interface RebaseCommitItem {
  id: string;
  message: string;
  changeIds: string[];
}

class InMemoryContentProvider implements vscode.TextDocumentContentProvider {
  private _onDidChange = new vscode.EventEmitter<vscode.Uri>();
  readonly onDidChange = this._onDidChange.event;
  private contents = new Map<string, string>();

  public setContent(uri: vscode.Uri, content: string) {
    this.contents.set(uri.toString(), content);
  }

  public clear() {
    this.contents.clear();
  }

  provideTextDocumentContent(uri: vscode.Uri): string {
    return this.contents.get(uri.toString()) || "";
  }
}

class GitState {
  private _onDidChange = new vscode.EventEmitter<void>();
  readonly onDidChange = this._onDidChange.event;
  private _commits: CommitItem[] = [];
  private _branch: string | undefined;
  private _api: API | undefined;
  private _isRebasing: boolean = false;
  private _rebaseCommits: RebaseCommitItem[] = [];
  private _changeById = new Map<string, Change>();
  private _contentProvider: InMemoryContentProvider;
  private _activeDiffs = new Set<string>();

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
      vscode.workspace.onDidChangeWorkspaceFolders(() => this.updateState())
    );
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
      this._api.onDidOpenRepository(async (repo) => {
        this.context.subscriptions.push(
          repo.state.onDidChange(() => this.updateState())
        );
        await this.updateState();
      }),
      this._api.onDidCloseRepository(() => this.updateState())
    );

    // Subscribe to existing repositories
    this._api.repositories.forEach((repo) => {
      this.context.subscriptions.push(
        repo.state.onDidChange(() => this.updateState())
      );
    });

    console.log("GitState initialized, updating state...");
    await this.updateState();
  }

  private async updateState() {
    if (!this._api || this._api.repositories.length === 0) {
      console.log("No repositories found");
      this._branch = undefined;
      this._commits = [];
      this._onDidChange.fire();
      return;
    }

    const repo = this._api.repositories[0];
    const branch = repo.state.HEAD?.name;

    console.log("Current branch:", branch);

    if (!branch || branch === "main" || branch === "master") {
      this._branch = undefined;
      this._commits = [];
      this._onDidChange.fire();
      return;
    }

    this._branch = branch;

    try {
      const commits = await repo.log({
        range: `origin/main..${branch}`,
      });

      console.log("Found commits:", commits.length);

      let changeIndex = 0; // Add this line to track change index

      this._commits = await Promise.all(
        commits.reverse().map(async (commit) => {
          // Add reverse() to process oldest first
          // Get the parent commit hash
          const parentHash = `${commit.hash}^`;
          const diffs = await repo.diffBetween(parentHash, commit.hash);

          console.log(`Diffing ${parentHash} with ${commit.hash}`, diffs);

          const changes = await Promise.all(
            diffs.map(async (diff) => {
              const fileDiff = await repo.diffBetween(
                parentHash,
                commit.hash,
                diff.uri.fsPath
              );
              const diffChanges: Change[] = [];

              console.log("Diff for", diff.uri.fsPath, diff);

              if (fileDiff) {
                const lines = fileDiff.split("\n");
                let currentHunk: HunkData | null = null;
                let hunkLines: string[] = [];

                for (const line of lines) {
                  if (line.startsWith("@@")) {
                    if (currentHunk && hunkLines.length) {
                      currentHunk.diffText = hunkLines.join("\n");
                      // Generate unique ID for hunk
                      currentHunk.id = `${commit.hash}-${diff.uri.path}-${currentHunk.oldStart}`;
                      const change: Change = {
                        ...currentHunk,
                        status: Status.MODIFIED,
                        uri: diff.uri,
                        index: changeIndex++, // Add this line
                      };
                      this._changeById.set(currentHunk.id, change);
                      diffChanges.push(change);
                      hunkLines = [];
                    }

                    const match = line.match(
                      /^@@ -(\d+),?(\d+)? \+(\d+),?(\d+)? @@/
                    );
                    if (match) {
                      currentHunk = {
                        oldStart: parseInt(match[1]),
                        oldLength: parseInt(match[2] || "1"),
                        newStart: parseInt(match[3]),
                        newLength: parseInt(match[4] || "1"),
                        diffText: "",
                        id: "", // Initialize with empty string
                      };
                    }
                  }

                  if (currentHunk) {
                    hunkLines.push(line);
                  }
                }

                if (currentHunk && hunkLines.length) {
                  currentHunk.diffText = hunkLines.join("\n");
                  // Generate unique ID for last hunk
                  currentHunk.id = `${commit.hash}-${diff.uri.path}-${currentHunk.oldStart}`;
                  const change: Change = {
                    ...currentHunk,
                    status: Status.MODIFIED,
                    uri: diff.uri,
                    index: changeIndex++, // Add this line
                  };
                  this._changeById.set(currentHunk.id, change);
                  diffChanges.push(change);
                }
              }

              return diffChanges;
            })
          );

          return {
            message: commit.message,
            hash: commit.hash,
            changes: changes.flat(),
          };
        })
      );

      this._commits = this._commits.reverse(); // Reverse back to newest first for display
      console.log("Processed commits:", this._commits.length);
      this._onDidChange.fire();
    } catch (e) {
      console.error("Failed to get commits:", e);
    }
  }

  get commits(): CommitItem[] {
    return this._commits;
  }

  get branch(): string | undefined {
    return this._branch;
  }

  get isRebasing(): boolean {
    return this._isRebasing;
  }

  get rebaseCommits(): RebaseCommitItem[] {
    return this._rebaseCommits;
  }

  setRebaseState(isRebasing: boolean) {
    this._isRebasing = isRebasing;

    if (this._isRebasing) {
      this._rebaseCommits = this.commits.map((commit) => ({
        id: commit.hash,
        changeIds: commit.changes.map((change) => change.id),
        message: commit.message,
      }));
    } else {
      this._rebaseCommits = [];
    }

    vscode.commands.executeCommand(
      "setContext",
      "nicePr.isRebasing",
      isRebasing
    );
    this._onDidChange.fire();
  }

  removeCommit(commitId: string) {
    const commit = this._rebaseCommits.find((c) => c.id === commitId);
    // Only remove if commit exists and has no changes
    if (commit && commit.changeIds.length === 0) {
      this._rebaseCommits = this._rebaseCommits.filter(
        (c) => c.id !== commitId
      );
      this._onDidChange.fire();
    }
  }

  async showCommitDiff(commit: CommitItem): Promise<void> {
    if (!this._api) {
      return;
    }

    /*
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
    */
  }

  async updateCommitMessage(commitId: string, newMessage: string) {
    const commit = this._rebaseCommits.find((c) => c.id === commitId);
    if (commit) {
      commit.message = newMessage;
      this._onDidChange.fire();
    }
  }

  getChangeById(id: string) {
    return this._changeById.get(id);
  }

  moveChange(changeId: string, targetCommitId: string) {
    const change = this.getChangeById(changeId);

    const sourceCommit = this._rebaseCommits.find((commit) =>
      commit.changeIds.includes(changeId)
    );

    // Add to target commit if not already present
    const targetCommit = this._rebaseCommits.find(
      (c) => c.id === targetCommitId
    );

    if (!sourceCommit || !targetCommit || !change) {
      throw new Error("Invalid change move");
    }

    // Remove change from source commit
    sourceCommit.changeIds = sourceCommit.changeIds.filter(
      (id) => id !== changeId
    );

    // Add the change and sort by index
    targetCommit.changeIds.push(changeId);
    targetCommit.changeIds.sort((a, b) => {
      const changeA = this._changeById.get(a);
      const changeB = this._changeById.get(b);
      return (changeA?.index ?? 0) - (changeB?.index ?? 0);
    });
    this._onDidChange.fire();

    this.updateDiffView(
      change.uri.path,
      targetCommit.id,
      targetCommit.changeIds
    );
  }

  private async getFileContents(filePath: string): Promise<string> {
    if (!this._api || !this._branch) {
      return "";
    }

    const repo = this._api.repositories[0];
    try {
      const mergeBase = await repo.getMergeBase("origin/main", this._branch);

      if (!mergeBase) {
        throw new Error("No merge base");
      }

      return repo.show(mergeBase, filePath);
    } catch (error) {
      console.error("Failed to get file contents:", error);
      return "";
    }
  }

  async showFileDiff(fileItem: FileItem) {
    const changes = fileItem.changeIds
      .map((id) => this._changeById.get(id))
      .filter(
        (change): change is ModifiedChange =>
          change !== undefined && "diffText" in change
      );

    if (changes.length === 0) {
      return;
    }

    this._activeDiffs.add(fileItem.uri.path);

    // Get original file contents and show diff
    await this.updateDiffView(
      fileItem.uri.path,
      fileItem.commitId,
      fileItem.changeIds
    );
  }

  private async updateDiffView(
    uriString: string,
    id: string,
    changeIds: string[]
  ) {
    const existingView = this._activeDiffs.has(uriString);

    if (!existingView) {
      return;
    }

    console.log("UPDATING DIFF VIEW!", changeIds);

    // Add timestamp to make URIs unique
    const timestamp = Date.now();
    const leftUri = vscode.Uri.parse(
      `nice-pr-diff://original/${timestamp}/${id}/${uriString}`
    );
    const rightUri = vscode.Uri.parse(
      `nice-pr-diff://modified/${timestamp}/${id}/${uriString}`
    );

    const originalContent = await this.getFileContents(uriString);
    const changes = changeIds
      .map((id) => this._changeById.get(id))
      .filter(
        (change): change is ModifiedChange =>
          change !== undefined && "diffText" in change
      );

    const updatedContent = changes.reduce(
      (aggr, change) => applyPatch(aggr, change.diffText),
      originalContent
    );

    this._contentProvider.clear();
    this._contentProvider.setContent(leftUri, originalContent);
    this._contentProvider.setContent(rightUri, updatedContent);

    vscode.commands.executeCommand(
      "vscode.diff",
      leftUri,
      rightUri,
      `${uriString} (Changes)`,
      { preview: true }
    );
  }

  addNewCommit(message: string) {
    if (!this._isRebasing) {
      return;
    }

    const newCommit: RebaseCommitItem = {
      id: `new-${Date.now()}`, // Generate a temporary unique ID
      message: message,
      changeIds: [], // Start with no changes
    };

    this._rebaseCommits.unshift(newCommit); // Add to the beginning of the array
    this._onDidChange.fire();
  }
}

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
    item.description = `${element.hash.substring(0, 7)} (${
      element.changes.length
    } files)`;
    item.tooltip = `${element.message}\n${
      element.hash
    }\n\nChanges:\n${element.changes
      .map((change) => `${Status[change.status]}: ${change.uri.path}`)
      .join("\n")}`;
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

interface FileItem {
  commitId: string;
  type: "file";
  uri: vscode.Uri;
  changeIds: string[];
  parentCommit: RebaseCommitItem; // Add this line
}

interface RebaseCommitTreeItem {
  type: "commit";
  commit: RebaseCommitItem;
}

interface HunkItem {
  type: "hunk";
  changeId: string;
  diffText: string;
  lineInfo: string;
  parentCommit: RebaseCommitItem; // Add this line
}

type RebaseTreeItem = RebaseCommitTreeItem | FileItem | HunkItem;

class RebaseTreeDataProvider
  implements vscode.TreeDataProvider<RebaseTreeItem>
{
  static readonly TRASH_ID = "trash-bin";
  private static readonly TRASH_MESSAGE = "Trash";
  private _trashedChangeIds: string[] = []; // Add this field

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

  private getTrashItem(): RebaseCommitTreeItem {
    return {
      type: "commit",
      commit: {
        id: RebaseTreeDataProvider.TRASH_ID,
        message: RebaseTreeDataProvider.TRASH_MESSAGE,
        changeIds: this._trashedChangeIds,
      },
    };
  }

  dropMimeTypes = ["application/vnd.code.tree.niceprdrop"] as const;
  dragMimeTypes = ["application/vnd.code.tree.niceprdrop"] as const;
  handleDrag(sources: RebaseTreeItem[], dataTransfer: vscode.DataTransfer) {
    const changeIds: string[] = [];

    sources.forEach((source) => {
      if (source.type === "file") {
        changeIds.push(...source.changeIds);
      } else if (source.type === "hunk") {
        changeIds.push(source.changeId);
      }
    });

    dataTransfer.set(
      this.dragMimeTypes[0],
      new vscode.DataTransferItem(changeIds)
    );
  }
  handleDrop(
    target: RebaseTreeItem | undefined,
    dataTransfer: vscode.DataTransfer
  ) {
    if (!target) {
      return;
    }

    // Redirect to parent commit if target is a file or hunk
    const targetCommit =
      target.type === "commit" ? target.commit : target.parentCommit;

    const dragData = dataTransfer.get(
      "application/vnd.code.tree.niceprdrop"
    )?.value;

    if (!dragData) {
      return;
    }

    const changeIds: string[] = dragData;

    changeIds.forEach((changeId: string) => {
      // Check if the change is in trash first
      const inTrash = this._trashedChangeIds.includes(changeId);

      if (inTrash) {
        // Remove from trash
        this._trashedChangeIds = this._trashedChangeIds.filter(
          (id) => id !== changeId
        );

        if (targetCommit.id !== RebaseTreeDataProvider.TRASH_ID) {
          // Add to target commit if not moving to trash
          targetCommit.changeIds.push(changeId);
        }
      } else {
        // Original commit handling
        const sourceCommit = this.gitState.rebaseCommits.find((commit) =>
          commit.changeIds.includes(changeId)
        );

        if (!sourceCommit) {
          return;
        }

        // Remove from source commit
        sourceCommit.changeIds = sourceCommit.changeIds.filter(
          (id) => id !== changeId
        );

        if (targetCommit.id === RebaseTreeDataProvider.TRASH_ID) {
          // Add to trash
          this._trashedChangeIds.push(changeId);
        } else {
          // Add to target commit
          targetCommit.changeIds.push(changeId);
        }
      }
    });

    this._onDidChangeTreeData.fire(undefined);
  }

  async getTreeItem(element: RebaseTreeItem): Promise<vscode.TreeItem> {
    if (element.type === "hunk") {
      const item = new vscode.TreeItem(element.lineInfo);
      item.description = element.diffText.split("\n")[0];
      item.iconPath = new vscode.ThemeIcon("split-horizontal");
      item.contextValue = "droppableHunk"; // Change to droppable
      return item;
    }

    if (element.type === "file") {
      const parts = element.uri.path.split("/");
      const fileName = parts.pop() || "";

      const item = new vscode.TreeItem(
        fileName,
        element.changeIds.length === 1
          ? vscode.TreeItemCollapsibleState.None
          : element.changeIds.some((id) => {
              const change = this.gitState.getChangeById(id);
              return change && "diffText" in change;
            })
          ? vscode.TreeItemCollapsibleState.Collapsed
          : vscode.TreeItemCollapsibleState.None
      );

      // If there's only one change, show its diff text in the description
      if (element.changeIds.length === 1) {
        const change = this.gitState.getChangeById(element.changeIds[0]);
        if (change && "diffText" in change) {
          item.description = change.diffText.split("\n")[0]; // Show first line of diff
        }
      } else {
        item.description = vscode.workspace.asRelativePath(parts.join("/"));
      }

      item.iconPath = vscode.ThemeIcon.File;
      item.tooltip = element.uri.path;
      item.contextValue = "droppableFile"; // Change to droppable
      // Add command to show diff when clicking the file
      item.command = {
        command: "nicePr.showFileDiff",
        title: "Show File Changes",
        arguments: [element],
      };
      return item;
    }

    if (element.type === "commit") {
      // Special handling for trash item
      if (element.commit.id === RebaseTreeDataProvider.TRASH_ID) {
        const item = new vscode.TreeItem(
          element.commit.message,
          vscode.TreeItemCollapsibleState.Expanded
        );
        item.iconPath = new vscode.ThemeIcon("trash");
        item.contextValue = "trash";
        return item;
      }

      const item = new vscode.TreeItem(
        element.commit.message,
        vscode.TreeItemCollapsibleState.Expanded
      );
      item.iconPath = new vscode.ThemeIcon(
        element.commit.changeIds.length === 0 ? "kebab-vertical" : "git-commit"
      );
      // Set contextValue based on whether commit has changes
      item.contextValue =
        element.commit.changeIds.length === 0
          ? "emptyCommit"
          : "droppableCommit";
      item.command = {
        command: "nicePr.editCommitMessage",
        title: "Edit Commit Message",
        arguments: [element.commit],
      };
      return item;
    }

    const item = new vscode.TreeItem(
      element.commit.message,
      vscode.TreeItemCollapsibleState.Expanded
    );
    item.iconPath = new vscode.ThemeIcon(
      element.commit.changeIds.length === 0 ? "kebab-vertical" : "git-commit"
    );
    item.contextValue = "droppableCommit";
    item.command = {
      command: "nicePr.editCommitMessage",
      title: "Edit Commit Message",
      arguments: [element.commit],
    };
    return item;
  }

  async getChildren(element?: RebaseTreeItem): Promise<RebaseTreeItem[]> {
    if (!element) {
      // Root level - show trash first, then commits
      const trashItem = this.getTrashItem();
      const fileMap = new Map<string, string[]>();

      // Group trashed changes by file
      this._trashedChangeIds.forEach((changeId) => {
        const change = this.gitState.getChangeById(changeId);
        if (change) {
          const uriString = change.uri.toString();
          const existing = fileMap.get(uriString) || [];
          fileMap.set(uriString, [...existing, changeId]);
        }
      });

      // Create file items for trash
      const trashFiles = Array.from(fileMap.entries()).map(
        ([uriString, changeIds]) => ({
          type: "file" as const,
          uri: vscode.Uri.parse(uriString),
          changeIds,
          commitId: trashItem.commit.id,
          parentCommit: trashItem.commit,
        })
      );

      return [
        {
          type: "commit",
          commit: {
            ...trashItem.commit,
            changeIds: this._trashedChangeIds,
          },
        },
        ...this.gitState.rebaseCommits.map((commit) => ({
          type: "commit",
          commit,
        })),
      ];
    }

    if (element.type === "commit") {
      const fileMap = new Map<string, string[]>();

      element.commit.changeIds.forEach((changeId) => {
        const change = this.gitState.getChangeById(changeId);
        if (change) {
          const uriString = change.uri.toString();
          const existing = fileMap.get(uriString) || [];
          fileMap.set(uriString, [...existing, changeId]);
        }
      });

      return Array.from(fileMap.entries()).map(([uriString, changeIds]) => ({
        type: "file",
        uri: vscode.Uri.parse(uriString),
        changeIds,
        commitId: element.commit.id,
        parentCommit: element.commit, // Add this line
      }));
    }

    if (element.type === "file") {
      if (element.changeIds.length === 1) {
        return [];
      }

      const hunks: HunkItem[] = [];

      for (const changeId of element.changeIds) {
        const change = this.gitState.getChangeById(changeId);
        if (change && "diffText" in change) {
          hunks.push({
            type: "hunk",
            changeId,
            diffText: change.diffText,
            lineInfo: `@@ -${change.oldStart},${change.oldLength} +${change.newStart},${change.newLength} @@`,
            parentCommit: element.parentCommit, // Add this line
          });
        }
      }

      return hunks.length > 0 ? hunks : [];
    }

    return [];
  }

  refresh(): void {
    this.view.title = "Rebase Changes";
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
    vscode.commands.registerCommand("nicePr.startRebase", () => {
      gitState.setRebaseState(true);
    }),
    vscode.commands.registerCommand("nicePr.cancelRebase", () => {
      gitState.setRebaseState(false);
    }),
    vscode.commands.registerCommand("nicePr.approveRebase", () => {
      // Implementation coming later
    }),
    vscode.commands.registerCommand(
      "nicePr.editCommitMessage",
      async (commit: RebaseCommitItem) => {
        const newMessage = await vscode.window.showInputBox({
          prompt: "Edit commit message",
          value: commit.message,
        });

        if (newMessage !== undefined) {
          await gitState.updateCommitMessage(commit.id, newMessage);
        }
      }
    ),
    vscode.commands.registerCommand(
      "nicePr.removeCommit",
      (treeItem: RebaseTreeItem) => {
        if (treeItem?.type === "commit") {
          gitState.removeCommit(treeItem.commit.id);
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
      (fileItem: FileItem) => gitState.showFileDiff(fileItem)
    )
  );
}

export function deactivate() {}
