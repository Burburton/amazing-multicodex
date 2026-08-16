import { Clock } from "../../../shared/core/clock";
import { IdGenerator } from "../../../shared/core/idGenerator";
import { AppError, Result, err, ok } from "../../../shared/core/result";
import { CommandRunnerPort } from "../../../shared/ports/commandRunner";
import { WorkspaceRef } from "../../workspaces/public";
import {
  ValidationCheckDefinition,
  ValidationCheckResult,
  ValidationProfile,
  ValidationRun,
  ValidationRunId,
  validateProfile
} from "../domain/validation";

export interface RunValidationCommand {
  readonly workspace: WorkspaceRef;
  readonly profile: ValidationProfile;
  readonly signal?: AbortSignal;
}

export class RunValidationHandler {
  constructor(
    private readonly commands: CommandRunnerPort,
    private readonly clock: Clock,
    private readonly ids: IdGenerator
  ) {}

  async execute(command: RunValidationCommand): Promise<Result<ValidationRun>> {
    const profile = validateProfile(command.profile);
    if (!profile.ok) return profile;
    const startedAt = this.clock.now();
    const checks = profile.value.mode === "parallel"
      ? await Promise.all(profile.value.checks.map(check => this.runCheck(check, command.workspace.path, command.signal)))
      : await this.runSequential(profile.value.checks, command.workspace.path, command.signal);
    const failed = checks.find(result => !result.ok);
    if (failed && !failed.ok) return failed;
    const results = checks.map(result => {
      if (!result.ok) throw new Error("Unreachable failed validation result.");
      return result.value;
    });
    const status = command.signal?.aborted || results.some(result => result.status === "cancelled")
      ? "cancelled"
      : results.some(result => result.status === "failed") ? "failed" : "passed";
    return ok({
      id: this.ids.next() as ValidationRunId,
      workspaceId: command.workspace.id,
      profileId: profile.value.id,
      status,
      checks: results,
      startedAt,
      completedAt: this.clock.now()
    });
  }

  private async runSequential(
    checks: readonly ValidationCheckDefinition[],
    cwd: string,
    signal?: AbortSignal
  ): Promise<readonly Result<ValidationCheckResult>[]> {
    const results: Result<ValidationCheckResult>[] = [];
    for (const check of checks) {
      if (signal?.aborted) break;
      const result = await this.runCheck(check, cwd, signal);
      results.push(result);
      if (!result.ok || result.value.status !== "passed") break;
    }
    return results;
  }

  private async runCheck(
    check: ValidationCheckDefinition,
    cwd: string,
    signal?: AbortSignal
  ): Promise<Result<ValidationCheckResult>> {
    const startedAt = this.clock.now();
    const timeout = check.timeoutMs ? AbortSignal.timeout(check.timeoutMs) : undefined;
    const combined = combineSignals(signal, timeout);
    try {
      const result = await this.commands.run({
        executable: check.executable,
        args: check.args,
        cwd,
        maxOutputBytes: check.maxOutputBytes
      }, combined);
      const userCancelled = signal?.aborted ?? false;
      const timedOut = !userCancelled && (timeout?.aborted ?? false);
      return ok({
        checkId: check.id,
        status: userCancelled ? "cancelled" : timedOut || result.exitCode !== 0 ? "failed" : "passed",
        exitCode: result.exitCode,
        stdout: result.stdout,
        stderr: timedOut && !result.stderr.trim()
          ? `Timed out after ${check.timeoutMs?.toLocaleString()} ms.`
          : result.stderr,
        truncated: result.truncated,
        startedAt,
        completedAt: this.clock.now()
      });
    } catch (cause) {
      return err(commandError(check, cause));
    }
  }
}

function combineSignals(first?: AbortSignal, second?: AbortSignal): AbortSignal | undefined {
  if (!first) return second;
  if (!second) return first;
  return AbortSignal.any([first, second]);
}

function commandError(check: ValidationCheckDefinition, cause: unknown): AppError {
  return {
    code: "validation.command-unavailable",
    category: "unavailable",
    message: `Could not run validation check '${check.label}'.`,
    retryable: true,
    context: { checkId: check.id },
    cause
  };
}
