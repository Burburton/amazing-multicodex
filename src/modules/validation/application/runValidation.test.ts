import assert from "node:assert/strict";
import test from "node:test";
import { Clock } from "../../../shared/core/clock";
import { IdGenerator } from "../../../shared/core/idGenerator";
import { CommandResult, CommandRunnerPort, CommandSpec } from "../../../shared/ports/commandRunner";
import { TaskId } from "../../tasks/public";
import { WorkspaceId, WorkspaceRef } from "../../workspaces/public";
import { ValidationCheckId, ValidationProfile, ValidationProfileId } from "../domain/validation";
import { RunValidationHandler } from "./runValidation";

class SteppingClock implements Clock {
  private time = Date.parse("2026-08-15T12:00:00Z");
  now(): Date { const value = new Date(this.time); this.time += 100; return value; }
}
class FixedIds implements IdGenerator { next(): string { return "run-1"; } }
class FakeCommands implements CommandRunnerPort {
  readonly calls: CommandSpec[] = [];
  readonly results: CommandResult[] = [];
  async run(spec: CommandSpec): Promise<CommandResult> {
    this.calls.push(spec);
    return this.results.shift() ?? result(0);
  }
}

const result = (exitCode: number): CommandResult => ({
  exitCode, signal: null, stdout: "output", stderr: "", truncated: false
});
const workspace: WorkspaceRef = {
  id: "workspace-1" as WorkspaceId,
  taskId: "task-1" as TaskId,
  repositoryRoot: "/repo",
  worktreeRoot: "/worktrees",
  path: "/worktrees/workspace-1",
  branch: "branch",
  baseRef: "main"
};
const profile = (mode: ValidationProfile["mode"]): ValidationProfile => ({
  id: "profile-1" as ValidationProfileId,
  mode,
  checks: [
    { id: "check-1" as ValidationCheckId, label: "First", executable: "npm", args: ["run", "check"] },
    { id: "check-2" as ValidationCheckId, label: "Second", executable: "npm", args: ["test"] }
  ]
});

test("stops sequential validation after a failed check", async () => {
  const commands = new FakeCommands();
  commands.results.push(result(1), result(0));
  const validation = await new RunValidationHandler(commands, new SteppingClock(), new FixedIds())
    .execute({ workspace, profile: profile("sequential") });
  assert.equal(validation.ok, true);
  if (!validation.ok) return;
  assert.equal(validation.value.status, "failed");
  assert.equal(validation.value.checks.length, 1);
  assert.equal(commands.calls.length, 1);
});

test("runs all checks for a parallel profile", async () => {
  const commands = new FakeCommands();
  const validation = await new RunValidationHandler(commands, new SteppingClock(), new FixedIds())
    .execute({ workspace, profile: profile("parallel") });
  assert.equal(validation.ok, true);
  if (!validation.ok) return;
  assert.equal(validation.value.status, "passed");
  assert.equal(validation.value.checks.length, 2);
  assert.equal(commands.calls[0].cwd, workspace.path);
});

