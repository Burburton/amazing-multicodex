import { AppError, Result, err, ok } from "../../shared/core/result";
import { CommandResult, CommandRunnerPort } from "../../shared/ports/commandRunner";
import {
  IntegrateWorkspaceInput,
  IntegrationPort,
  IntegrationResult
} from "../../modules/integration/public";

export class GitIntegrationAdapter implements IntegrationPort {
  constructor(private readonly commands: CommandRunnerPort) {}

  async integrate(input: IntegrateWorkspaceInput): Promise<Result<IntegrationResult>> {
    const cleanTarget = await this.git(input.targetRepositoryRoot, ["status", "--porcelain=v1"]);
    if (!cleanTarget.ok) return cleanTarget;
    if (cleanTarget.value.stdout.trim()) {
      return err(integrationError("integration.target-dirty", "Target repository has uncommitted changes."));
    }
    const added = await this.git(input.workspace.path, ["add", "-A"]);
    if (!added.ok) return added;
    const staged = await this.git(input.workspace.path, ["diff", "--cached", "--quiet"], [0, 1]);
    if (!staged.ok) return staged;
    if (staged.value.exitCode === 1) {
      const committed = await this.git(input.workspace.path, ["commit", "-m", input.commitMessage]);
      if (!committed.ok) return committed;
    }
    const source = await this.git(input.workspace.path, ["rev-parse", "HEAD"]);
    if (!source.ok) return source;
    if (input.strategy === "merge") {
      const merged = await this.git(input.targetRepositoryRoot, [
        "merge", "--no-ff", input.workspace.branch, "-m", input.commitMessage
      ]);
      if (!merged.ok) return merged;
    } else {
      const squashed = await this.git(input.targetRepositoryRoot, ["merge", "--squash", input.workspace.branch]);
      if (!squashed.ok) return squashed;
      const committed = await this.git(input.targetRepositoryRoot, ["commit", "-m", input.commitMessage]);
      if (!committed.ok) return committed;
    }
    const target = await this.git(input.targetRepositoryRoot, ["rev-parse", "HEAD"]);
    if (!target.ok) return target;
    return ok({
      sourceCommit: source.value.stdout.trim(),
      targetCommit: target.value.stdout.trim(),
      strategy: input.strategy
    });
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

