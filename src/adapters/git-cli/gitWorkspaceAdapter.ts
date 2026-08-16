import * as path from "node:path";
import { AppError, Result, err, ok } from "../../shared/core/result";
import { CommandResult, CommandRunnerPort } from "../../shared/ports/commandRunner";
import {
  ChangeSet,
  PrepareWorkspaceInput,
  ReleaseWorkspaceInput,
  WorkspacePort,
  WorkspaceRef,
  WorkspaceSnapshot
} from "../../modules/workspaces/public";

export class GitWorkspaceAdapter implements WorkspacePort {
  constructor(private readonly commands: CommandRunnerPort) {}

  async prepare(input: PrepareWorkspaceInput): Promise<Result<WorkspaceRef>> {
    const workspacePath = path.resolve(input.worktreeRoot, input.id);
    const safe = ensureDescendant(input.worktreeRoot, workspacePath);
    if (!safe.ok) return safe;
    const repository = path.resolve(input.repositoryRoot);
    const verified = await this.git(repository, ["rev-parse", "--show-toplevel"]);
    if (!verified.ok) return verified;
    if (path.resolve(verified.value.stdout.trim()) !== repository) {
      return err(gitError("workspace.repository-root-mismatch", "Configured repository root does not match Git."));
    }

    const added = await this.git(repository, [
      "worktree", "add", "-b", input.branch, workspacePath, input.baseRef
    ]);
    if (!added.ok) return added;
    return ok({
      id: input.id,
      taskId: input.taskId,
      repositoryRoot: repository,
      worktreeRoot: path.resolve(input.worktreeRoot),
      path: workspacePath,
      branch: input.branch,
      baseRef: input.baseRef
    });
  }

  async inspect(workspace: WorkspaceRef): Promise<Result<WorkspaceSnapshot>> {
    const head = await this.git(workspace.path, ["rev-parse", "HEAD"]);
    if (!head.ok) return head;
    const status = await this.git(workspace.path, ["status", "--porcelain=v1"]);
    if (!status.ok) return status;
    return ok({ ...workspace, headCommit: head.value.stdout.trim(), dirty: status.value.stdout.length > 0 });
  }

  async diff(workspace: WorkspaceRef): Promise<Result<ChangeSet>> {
    const summary = await this.git(workspace.path, ["diff", "--stat", `${workspace.baseRef}...HEAD`]);
    if (!summary.ok) return summary;
    const patch = await this.git(workspace.path, ["diff", "--no-ext-diff", `${workspace.baseRef}...HEAD`]);
    if (!patch.ok) return patch;
    return ok({ workspaceId: workspace.id, summary: summary.value.stdout, patch: patch.value.stdout });
  }

  async release(input: ReleaseWorkspaceInput): Promise<Result<void>> {
    const safe = ensureDescendant(input.workspace.worktreeRoot, input.workspace.path);
    if (!safe.ok) return safe;
    if (!input.force) {
      const snapshot = await this.inspect(input.workspace);
      if (!snapshot.ok) return snapshot;
      if (snapshot.value.dirty) {
        return err(gitError("workspace.dirty", "Workspace has uncommitted changes and cannot be released."));
      }
    }
    const args = ["worktree", "remove"];
    if (input.force) args.push("--force");
    args.push(input.workspace.path);
    const removed = await this.git(input.workspace.repositoryRoot, args);
    return removed.ok ? ok(undefined) : removed;
  }

  private async git(cwd: string, args: readonly string[]): Promise<Result<CommandResult>> {
    let result: CommandResult;
    try {
      result = await this.commands.run({ executable: "git", args, cwd });
    } catch (cause) {
      return err(gitError("git.unavailable", "Git command could not be started.", true, cause));
    }
    if (result.exitCode !== 0) {
      return err(gitError(
        "git.command-failed",
        result.stderr.trim() || `Git exited with code ${String(result.exitCode)}.`,
        false,
        result
      ));
    }
    return ok(result);
  }
}

function ensureDescendant(root: string, candidate: string): Result<void> {
  const relative = path.relative(path.resolve(root), path.resolve(candidate));
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) {
    return err(gitError("workspace.unsafe-path", "Workspace path must be a child of the worktree root."));
  }
  return ok(undefined);
}

function gitError(code: string, message: string, retryable = false, cause?: unknown): AppError {
  return { code, category: code === "workspace.dirty" ? "conflict" : "unavailable", message, retryable, cause };
}
