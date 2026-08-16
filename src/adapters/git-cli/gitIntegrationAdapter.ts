import { AppError, Result, err, ok } from "../../shared/core/result";
import path from "node:path";
import { CommandResult, CommandRunnerPort } from "../../shared/ports/commandRunner";
import {
  IntegrateWorkspaceInput,
  IntegrationPort,
  IntegrationResult
} from "../../modules/integration/public";

export class GitIntegrationAdapter implements IntegrationPort {
  constructor(private readonly commands: CommandRunnerPort) {}

  async integrate(input: IntegrateWorkspaceInput): Promise<Result<IntegrationResult>> {
    if (path.resolve(input.targetRepositoryRoot) !== path.resolve(input.workspace.repositoryRoot)) {
      return err(integrationError(
        "integration.target-mismatch",
        "The open target repository does not match the repository that created this task workspace."
      ));
    }
    const cleanTarget = await this.git(input.targetRepositoryRoot, ["status", "--porcelain=v1"]);
    if (!cleanTarget.ok) return cleanTarget;
    if (cleanTarget.value.stdout.trim()) {
      return err(integrationError("integration.target-dirty", "Target repository has uncommitted changes."));
    }
    const added = await this.git(input.workspace.path, ["add", "-A"]);
    if (!added.ok) return added;
    const currentPatch = await this.git(input.workspace.path, [
      "diff", "--cached", "--binary", "--no-ext-diff", input.workspace.baseRef
    ]);
    if (!currentPatch.ok) return currentPatch;
    if (canonicalPatch(currentPatch.value.stdout) !== canonicalPatch(input.reviewedPatch)) {
      const unstaged = await this.git(input.workspace.path, ["reset", input.workspace.baseRef]);
      if (!unstaged.ok) return unstaged;
      return err(integrationError(
        "integration.review-stale",
        "Task changes no longer match the reviewed diff. Review the latest changes before integrating.",
        true
      ));
    }
    const staged = await this.git(input.workspace.path, ["diff", "--cached", "--quiet"], [0, 1]);
    if (!staged.ok) return staged;
    if (staged.value.exitCode === 1) {
      const committed = await this.git(input.workspace.path, ["commit", "-m", input.commitMessage]);
      if (!committed.ok) return committed;
    }
    const source = await this.git(input.workspace.path, ["rev-parse", "HEAD"]);
    if (!source.ok) return source;
    const sourceCommit = source.value.stdout.trim();
    if (sourceCommit === input.workspace.baseRef) {
      return err(integrationError("integration.no-changes", "The task workspace has no changes to integrate."));
    }
    if (input.strategy === "merge") {
      const merged = await this.git(input.targetRepositoryRoot, [
        "merge", "--no-ff", sourceCommit, "-m", input.commitMessage
      ]);
      if (!merged.ok) return this.rollback(input.targetRepositoryRoot, merged.error);
    } else {
      const squashed = await this.git(input.targetRepositoryRoot, ["merge", "--squash", sourceCommit]);
      if (!squashed.ok) return this.rollback(input.targetRepositoryRoot, squashed.error);
      const committed = await this.git(input.targetRepositoryRoot, ["commit", "-m", input.commitMessage]);
      if (!committed.ok) return this.rollback(input.targetRepositoryRoot, committed.error);
    }
    const target = await this.git(input.targetRepositoryRoot, ["rev-parse", "HEAD"]);
    if (!target.ok) return target;
    return ok({
      sourceCommit,
      targetCommit: target.value.stdout.trim(),
      strategy: input.strategy
    });
  }

  private async rollback<T>(repositoryRoot: string, integrationFailure: AppError): Promise<Result<T>> {
    const restored = await this.git(repositoryRoot, ["reset", "--merge", "HEAD"]);
    if (restored.ok) return err(integrationFailure);
    return err(integrationError(
      "integration.rollback-failed",
      "Integration failed and the target repository could not be restored automatically.",
      false,
      { integrationFailure, rollbackFailure: restored.error }
    ));
  }

  private async git(
    cwd: string,
    args: readonly string[],
    acceptedExitCodes: readonly (number | null)[] = [0]
  ): Promise<Result<CommandResult>> {
    let result: CommandResult;
    try {
      result = await this.commands.run({ executable: "git", args, cwd });
    } catch (cause) {
      return err(integrationError("git.unavailable", "Git command could not be started.", true, cause));
    }
    if (result.truncated) {
      return err(integrationError(
        "integration.output-truncated",
        "Git output exceeded the safe review limit, so integration was stopped."
      ));
    }
    if (!acceptedExitCodes.includes(result.exitCode)) {
      return err(integrationError(
        "integration.git-failed",
        result.stderr.trim() || `Git exited with code ${String(result.exitCode)}.`,
        false,
        result
      ));
    }
    return ok(result);
  }
}

function integrationError(code: string, message: string, retryable = false, cause?: unknown): AppError {
  return { code, category: code === "git.unavailable" ? "unavailable" : "conflict", message, retryable, cause };
}

function canonicalPatch(patch: string): string {
  return patch
    .split(/(?=^diff --git )/m)
    .map(block => block.replace(/^\n+|\n+$/g, ""))
    .filter(Boolean)
    .sort()
    .join("\n");
}
