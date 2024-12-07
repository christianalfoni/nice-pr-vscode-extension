import * as vscode from "vscode";
import { API, Change, Repository, Status } from "./git";

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
  submoduleOf?: string;
}

interface GitUriOptions {
  scheme?: string;
  replaceFileExtension?: boolean;
  submoduleOf?: string;
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

  if (options.submoduleOf) {
    params.submoduleOf = options.submoduleOf;
  }

  let path = uri.path;

  if (options.replaceFileExtension) {
    path = `${path}.git`;
  } else if (options.submoduleOf) {
    path = `${path}.diff`;
  }

  return uri.with({
    scheme: options.scheme ?? "git",
    path,
    query: JSON.stringify(params),
  });
}

function toMultiFileDiffEditorUris(
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

async function isGitRepository(): Promise<boolean> {
  const gitExtension = await getGitExtension();

  if (!gitExtension) {
    return false;
  }

  const api = gitExtension.getAPI(1);
  return api.repositories.length > 0;
}

interface CommitItem {
  message: string;
  hash: string;
  action: "pick" | "reword" | "squash" | "drop";
}

class BranchTreeDataProvider
  implements
    vscode.TreeDataProvider<CommitItem | string>,
    vscode.TreeDragAndDropController<CommitItem | string>
{
  private _onDidChangeTreeData = new vscode.EventEmitter<
    CommitItem | string | undefined
  >();
  readonly onDidChangeTreeData = this._onDidChangeTreeData.event;
  private view: vscode.TreeView<CommitItem | string>;
  private commitsToBePushed: CommitItem[] | null = null;
  isRebaseMode: boolean = false;
  isExecutingRebase: boolean = false;
  isPushingRebase: boolean = false;
  private rebasedCommits: CommitItem[] = [];
  dropMimeTypes = ["application/vnd.code.tree.nicePrView"];
  dragMimeTypes = ["application/vnd.code.tree.nicePrView"];

  constructor() {
    // Register the tree data provider first
    vscode.window.registerTreeDataProvider("nicePrView", this);

    // Then create the tree view
    this.view = vscode.window.createTreeView("nicePrView", {
      treeDataProvider: this,
      showCollapseAll: false,
      dragAndDropController: this,
    });
    this.refresh();
  }

  hasLocalChanges(repo: Repository): boolean {
    return Boolean(
      repo.state.untrackedChanges.length || repo.state.workingTreeChanges.length
    );
  }

  async showCommitDiff(commit: CommitItem): Promise<void> {
    const gitExtension = await getGitExtension();

    if (!gitExtension) {
      return;
    }

    const api: API = gitExtension.getAPI(1);
    const repo = api.repositories[0];

    // Get the commit details and its parent
    const commitDetails = await repo.getCommit(commit.hash);
    const commitParentId = commitDetails.parents[0] || `${commit.hash}^`;

    // Get all changes between the commit and its parent
    const changes = await repo.diffBetween(commitParentId, commit.hash);

    // Create the source URI for the multi-diff editor
    const multiDiffSourceUri = vscode.Uri.from({
      scheme: "scm-history-item",
      path: `${repo.rootUri.path}/${commitParentId}..${commit.hash}`,
    });

    // Map changes to diff resources
    const resources = changes.map((change) =>
      toMultiFileDiffEditorUris(change, commitParentId, commit.hash)
    );

    // Open the multi-file diff editor
    await vscode.commands.executeCommand(
      "_workbench.openMultiDiffEditor",
      {
        multiDiffSourceUri,
        title: `${commit.hash.substring(0, 7)} - ${commit.message}`,
        resources,
      },
      {
        preserveFocus: true,
        preview: true,
        viewColumn: vscode.ViewColumn.Active,
      }
    );
  }

  async getTreeItem(element: CommitItem | string): Promise<vscode.TreeItem> {
    if (typeof element === "string") {
      return new vscode.TreeItem(element);
    }

    let label = element.message;
    const item = new vscode.TreeItem(label);
    item.description = element.hash.substring(0, 7);
    item.tooltip = `${element.message}\n${element.hash}`;

    if (element.action === "squash") {
      item.iconPath = new vscode.ThemeIcon("arrow-down");
    } else if (element.action === "drop") {
      item.iconPath = new vscode.ThemeIcon("trash");
    } else {
      item.iconPath = new vscode.ThemeIcon("git-commit");
    }

    const isLastCommit =
      element === this.rebasedCommits[this.rebasedCommits.length - 1];
    item.contextValue = this.isRebaseMode
      ? isLastCommit
        ? "rebaseModeLastNoSquash"
        : "rebaseMode"
      : "normalMode";

    item.command = {
      command: "nicePr.showDiff",
      title: "Show Diff",
      arguments: [element],
    };

    return item;
  }

  async toggleDropCommit(commit: CommitItem): Promise<void> {
    if (!this.isRebaseMode) {
      return;
    }

    this.rebasedCommits = this.rebasedCommits.map((c) =>
      c.hash === commit.hash
        ? { ...c, action: c.action === "drop" ? "pick" : "drop" }
        : c
    );
    this.refresh();
  }

  async editCommitMessage(commit: CommitItem): Promise<void> {
    if (!this.isRebaseMode) {
      return;
    }

    const newMessage = await vscode.window.showInputBox({
      value: commit.message,
      prompt: "Edit commit message",
      validateInput: (value) => {
        return value.trim().length === 0
          ? "Commit message cannot be empty"
          : null;
      },
    });

    if (newMessage && newMessage !== commit.message) {
      this.rebasedCommits = this.rebasedCommits.map((c) =>
        c.hash === commit.hash
          ? { ...c, message: newMessage, action: "reword" }
          : c
      );
      this.refresh();
    }
  }

  async squashCommit(commit: CommitItem): Promise<void> {
    if (!this.isRebaseMode) {
      return;
    }

    this.rebasedCommits = this.rebasedCommits.map((c) =>
      c.hash === commit.hash
        ? { ...c, action: c.action === "squash" ? "pick" : "squash" }
        : c
    );
    this.refresh();
  }

  async getChildren(): Promise<(CommitItem | string)[]> {
    if (this.isRebaseMode) {
      return this.rebasedCommits;
    }

    const gitExtension = await getGitExtension();
    if (!gitExtension) {
      return [];
    }

    const api = gitExtension.getAPI(1) as API;
    if (api.repositories.length === 0) {
      return [];
    }

    const repo = api.repositories[0];
    const branch = repo.state.HEAD?.name;

    if (!branch || branch === "main" || branch === "master") {
      return [];
    }

    try {
      const commits = await repo.log({
        range: `origin/main..${branch}`,
      });

      return commits.map((commit) => ({
        message: commit.message,
        hash: commit.hash,
        action: "pick",
      }));
    } catch (e) {
      console.error("Failed to get commits:", e);
      return [];
    }
  }

  refresh(): void {
    let title = "Nice PR";
    if (this.isPushingRebase) {
      title = "Pushing rebase...";
    } else if (this.isExecutingRebase) {
      title = "Executing rebase...";
    } else if (this.isRebaseMode) {
      title = "Rebasing";
    } else if (this.commitsToBePushed) {
      title = "Ready to Push";
    }

    this.view.title = title;

    vscode.commands.executeCommand(
      "setContext",
      "nicePr.hasPendingPush",
      Boolean(this.commitsToBePushed)
    );
    vscode.commands.executeCommand(
      "setContext",
      "nicePr.isRebaseMode",
      this.isRebaseMode
    );
    vscode.commands.executeCommand(
      "setContext",
      "nicePr.isExecutingRebase",
      this.isExecutingRebase
    );
    this._onDidChangeTreeData.fire(undefined);
  }

  private subscribeToRepository(repo: any, context: vscode.ExtensionContext) {
    context.subscriptions.push(
      repo.state.onDidChange(() => {
        console.log(
          "Repository state changed:",
          repo.state.HEAD?.name,
          this.hasLocalChanges(repo)
        );
        this.refresh();
      })
    );
  }

  async subscribe(context: vscode.ExtensionContext) {
    const gitExtension = await getGitExtension();
    if (gitExtension) {
      const api = gitExtension.getAPI(1) as API;

      // Listen to repository changes
      context.subscriptions.push(
        api.onDidOpenRepository((repo) => {
          this.subscribeToRepository(repo, context);
          this.refresh();
        }),
        api.onDidCloseRepository(() => this.refresh())
      );

      // Subscribe to existing repositories
      api.repositories.forEach((repo) => {
        this.subscribeToRepository(repo, context);
      });
    }
  }

  async toggleRebaseMode(): Promise<void> {
    const gitExtension = await getGitExtension();
    if (!gitExtension) {
      return;
    }

    const api = gitExtension.getAPI(1) as API;
    if (api.repositories.length === 0) {
      return;
    }

    const repo = api.repositories[0];

    if (await this.hasLocalChanges(repo)) {
      vscode.window.showErrorMessage(
        "Cannot enter rebase mode with local changes"
      );
      return;
    }

    // Cache current commits before entering rebase mode
    if (!this.isRebaseMode) {
      const commits = await repo.log({
        range: `origin/main..${repo.state.HEAD?.name}`,
      });
      this.rebasedCommits = commits.map((commit) => ({
        message: commit.message,
        hash: commit.hash,
        action: "pick",
      }));
    }

    this.isRebaseMode = true;
    this.refresh();
  }

  cancelRebase(): void {
    this.isRebaseMode = false;
    this.rebasedCommits = [];
    this.refresh();
  }

  private async automateRebase(
    repo: Repository,
    commits: CommitItem[]
  ): Promise<void> {
    const fs = require("fs");
    const os = require("os");
    const path = require("path");

    const rebaseTodoPath = path.join(os.tmpdir(), "git-rebase-todo");
    const rewordMessagesPath = path.join(os.tmpdir(), "reword-messages");
    const editMessageScriptPath = path.join(
      os.tmpdir(),
      "edit-commit-message.sh"
    );

    const editMessageScript = `#!/bin/bash
set -e

message_file="$1"
messages_path="${rewordMessagesPath}"

# If messages file doesn't exist, keep original message
if [ ! -f "$messages_path" ]; then
    exit 0
fi

# If messages file is empty, keep original message
if [ ! -s "$messages_path" ]; then
    exit 0
fi

# Read the first line and store it
next_message=$(head -n 1 "$messages_path")

if [ -z "$next_message" ]; then
    exit 0
fi

# Write the message to the target file
echo "$next_message" > "$message_file"

# Remove the first line from messages file
tail -n +2 "$messages_path" > "$messages_path.tmp" && mv "$messages_path.tmp" "$messages_path"
`;

    try {
      const rebaseInstructions = commits
        .slice()
        .reverse()
        .map((commit) =>
          `${commit.action} ${commit.hash} ${commit.message}`.trim()
        )
        .join("\n");

      const rewordedMessages = commits
        .filter((commit) => commit.action === "reword")
        .reverse()
        .map((commit) => commit.message)
        .join("\n");

      fs.writeFileSync(rebaseTodoPath, rebaseInstructions);
      fs.writeFileSync(editMessageScriptPath, editMessageScript);
      fs.chmodSync(editMessageScriptPath, "755");

      // Only create reword messages file if there are rewording commits
      if (rewordedMessages) {
        fs.writeFileSync(rewordMessagesPath, rewordedMessages + "\n");
      }

      console.log("Instructions", rebaseInstructions);

      this.executeGitCommand(repo, `git rebase -i HEAD~${commits.length}`, {
        env: {
          ...process.env,
          GIT_SEQUENCE_EDITOR: `cat "${rebaseTodoPath}" >`,
          GIT_EDITOR: editMessageScriptPath,
        },
      });
    } catch (error) {
      console.error("Error automating rebase:", error);
      throw error;
    } finally {
      // Cleanup temporary files
      try {
        fs.unlinkSync(rebaseTodoPath);
        fs.unlinkSync(editMessageScriptPath);
        if (fs.existsSync(rewordMessagesPath)) {
          fs.unlinkSync(rewordMessagesPath);
        }
      } catch (e) {
        console.error("Error cleaning up temporary files:", e);
      }
    }
  }

  private executeGitCommand(
    repo: Repository,
    command: string,
    options: { env?: NodeJS.ProcessEnv } = {}
  ): string {
    console.log(`Executing git command: ${command}`);
    try {
      return require("child_process").execSync(command, {
        stdio: ["inherit", "pipe", "pipe"], // Change from 'inherit' to capture output
        cwd: repo.rootUri.fsPath,
        env: options.env,
        encoding: "utf-8", // Ensure we get string output
      });
    } catch (error: any) {
      console.error("Git command failed:", {
        command,
        stderr: error.stderr?.toString(),
        stdout: error.stdout?.toString(),
        error: error.message,
      });
      throw error;
    }
  }

  async applyRebase(): Promise<void> {
    const gitExtension = await getGitExtension();
    if (!gitExtension) {
      return;
    }

    const api: API = gitExtension.getAPI(1);
    const repo = api.repositories[0];
    const branch = repo.state.HEAD?.name;

    if (!branch) {
      return;
    }

    const backupBranch = `backup-${branch}-${Date.now()}`;
    console.log("Starting rebase process...");

    try {
      this.isExecutingRebase = true;
      this.refresh();

      this.executeGitCommand(repo, `git branch ${backupBranch}`);
      console.log(`Created backup branch: ${backupBranch}`);

      await this.automateRebase(repo, this.rebasedCommits);

      // Store commits to be pushed instead of pushing immediately
      this.commitsToBePushed = [...this.rebasedCommits];
    } catch (error) {
      console.error("Rebase failed:", error);

      try {
        this.executeGitCommand(repo, "git rebase --abort");
      } catch (e) {
        console.error("Failed to abort rebase:", e);
      }

      try {
        this.executeGitCommand(repo, `git reset --hard ${backupBranch}`);
        this.executeGitCommand(repo, `git branch -D ${backupBranch}`);
        vscode.window.showInformationMessage(
          "Successfully restored from backup branch"
        );
      } catch (e) {
        console.error("Failed to restore from backup:", e);
        vscode.window.showErrorMessage(
          `Failed to restore from backup. Your backup branch is: ${backupBranch}`
        );
      }
    } finally {
      this.isExecutingRebase = false;
      this.isRebaseMode = false;
      this.rebasedCommits = [];
      this.refresh();
    }
  }

  async pushRebase(): Promise<void> {
    if (!this.commitsToBePushed) {
      return;
    }

    const commitsToBePushed = this.commitsToBePushed;
    this.commitsToBePushed = null;

    const gitExtension = await getGitExtension();
    if (!gitExtension) {
      return;
    }

    const api: API = gitExtension.getAPI(1);
    const repo = api.repositories[0];
    const branch = repo.state.HEAD?.name;

    if (!branch) {
      return;
    }

    try {
      this.isPushingRebase = true;
      this.refresh();

      this.executeGitCommand(
        repo,
        `git push --force-with-lease origin ${branch}`
      );

      vscode.window.showInformationMessage(
        "Rebase completed and pushed successfully!"
      );
    } catch (error) {
      console.error("Push failed:", error);
      this.commitsToBePushed = commitsToBePushed;
      vscode.window.showErrorMessage(
        "Failed to push changes. Please try again."
      );
    } finally {
      this.isPushingRebase = false;
      this.refresh();
    }
  }

  async discardRebase(): Promise<void> {
    if (!this.commitsToBePushed) {
      return;
    }

    const gitExtension = await getGitExtension();
    if (!gitExtension) {
      return;
    }

    const api: API = gitExtension.getAPI(1);
    const repo = api.repositories[0];
    const branch = repo.state.HEAD?.name;

    if (!branch) {
      return;
    }

    try {
      this.executeGitCommand(repo, `git reset --hard origin/${branch}`);
      this.commitsToBePushed = null;
      vscode.window.showInformationMessage("Successfully discarded rebase");
    } catch (error) {
      console.error("Failed to discard rebase:", error);
      vscode.window.showErrorMessage("Failed to discard rebase");
    } finally {
      this.refresh();
    }
  }

  async handleDrag(
    sources: (CommitItem | string)[],
    dataTransfer: vscode.DataTransfer
  ): Promise<void> {
    if (!this.isRebaseMode) {
      return;
    }

    const commits = sources.filter(
      (item): item is CommitItem => typeof item !== "string"
    );
    dataTransfer.set(
      "application/vnd.code.tree.nicePrView",
      new vscode.DataTransferItem(commits)
    );
  }

  async handleDrop(
    target: CommitItem | string | undefined,
    dataTransfer: vscode.DataTransfer
  ): Promise<void> {
    if (!this.isRebaseMode) {
      return;
    }

    const transferItem = dataTransfer.get(
      "application/vnd.code.tree.nicePrView"
    );
    const draggedCommits: CommitItem[] = transferItem?.value || [];

    if (typeof target === "string" || !target || draggedCommits.length === 0) {
      return;
    }

    const targetIndex = this.rebasedCommits.findIndex(
      (c) => c.hash === target.hash
    );
    if (targetIndex === -1) {
      return;
    }

    // Remove dragged items
    const newCommits = this.rebasedCommits.filter(
      (c) => !draggedCommits.some((dc) => dc.hash === c.hash)
    );

    // Insert them at the target position
    newCommits.splice(targetIndex, 0, ...draggedCommits);

    this.rebasedCommits = newCommits;
    this.refresh();
  }
}

export async function activate(context: vscode.ExtensionContext) {
  const treeDataProvider = new BranchTreeDataProvider();
  await treeDataProvider.subscribe(context);

  // Register commands - removed moveCommitUp and moveCommitDown
  context.subscriptions.push(
    vscode.commands.registerCommand("nicePr.toggleRebaseMode", () =>
      treeDataProvider.toggleRebaseMode()
    ),

    vscode.commands.registerCommand("nicePr.cancelRebase", () =>
      treeDataProvider.cancelRebase()
    ),

    vscode.commands.registerCommand("nicePr.acceptRebase", () =>
      treeDataProvider.applyRebase()
    ),

    vscode.commands.registerCommand(
      "nicePr.editCommitMessage",
      (commit: CommitItem) => treeDataProvider.editCommitMessage(commit)
    ),

    vscode.commands.registerCommand("nicePr.showDiff", (commit: CommitItem) =>
      treeDataProvider.showCommitDiff(commit)
    ),

    vscode.commands.registerCommand(
      "nicePr.squashCommit",
      (commit: CommitItem) => treeDataProvider.squashCommit(commit)
    ),

    vscode.commands.registerCommand(
      "nicePr.toggleDropCommit",
      (commit: CommitItem) => treeDataProvider.toggleDropCommit(commit)
    ),

    vscode.commands.registerCommand("nicePr.pushRebase", async () => {
      const answer = await vscode.window.showWarningMessage(
        "This will rewrite commit history and force push to remote. Are you sure?",
        "Yes",
        "No"
      );

      if (answer === "Yes") {
        await treeDataProvider.pushRebase();
      }
    }),

    vscode.commands.registerCommand("nicePr.discardRebase", async () => {
      const answer = await vscode.window.showWarningMessage(
        "This will discard all rebased changes. Are you sure?",
        "Yes",
        "No"
      );

      if (answer === "Yes") {
        await treeDataProvider.discardRebase();
      }
    }),

    vscode.workspace.onDidChangeWorkspaceFolders(async () => {
      treeDataProvider.refresh();
    })
  );
}

export function deactivate() {}
