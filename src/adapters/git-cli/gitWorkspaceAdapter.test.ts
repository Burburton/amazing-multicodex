import assert from "node:assert/strict";
import test from "node:test";
import { CommandResult, CommandRunnerPort, CommandSpec } from "../../shared/ports/commandRunner";
import { TaskId } from "../../modules/tasks/public";
import { WorkspaceId, WorkspaceRef } from "../../modules/workspaces/public";
import { GitWorkspaceAdapter } from "./gitWorkspaceAdapter";

class ScriptedCommands implements CommandRunnerPort {
  readonly calls: CommandSpec[] = [];
  readonly responses: CommandResult[] = [];
  async run(spec: CommandSpec): Promise<CommandResult> {
    this.calls.push(spec);
    return this.responses.shift() ?? success();
  }
}

const success = (stdout = ""): CommandResult => ({
  exitCode: 0,
  signal: null,
  stdout,
  stderr: "",
  truncated: false
});

const workspace: WorkspaceRef = {
  id: "workspace-1" as WorkspaceId,
  taskId: "task-1" as TaskId,
  repositoryRoot: "/repo",
  worktreeRoot: "/worktrees",
  path: "/worktrees/workspace-1",
  branch: "multicodex/task-1",
  baseRef: "main"
};

test("prepares a worktree with structured Git arguments", async () => {
  const commands = new ScriptedCommands();
  commands.responses.push(success("/repo\n"), success());
  const adapter = new GitWorkspaceAdapter(commands);
  const result = await adapter.prepare({
    id: workspace.id,
    taskId: workspace.taskId,
    repositoryRoot: "/repo",
    worktreeRoot: "/worktrees",
    branch: workspace.branch,
    baseRef: "main"
  });
  assert.equal(result.ok, true);
  assert.deepEqual(commands.calls[1].args, [
    "worktree", "add", "-b", "multicodex/task-1", "/worktrees/workspace-1", "main"
  ]);
});

test("rejects a worktree path that resolves to the configured root", async () => {
  const result = await new GitWorkspaceAdapter(new ScriptedCommands()).prepare({
    id: ".." as WorkspaceId,
    taskId: workspace.taskId,
    repositoryRoot: "/repo",
    worktreeRoot: "/worktrees",
    branch: workspace.branch,
    baseRef: "main"
  });
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.error.code, "workspace.unsafe-path");
});

test("does not release a dirty workspace without force", async () => {
  const commands = new ScriptedCommands();
  commands.responses.push(success("commit\n"), success(" M file.ts\n"));
  const result = await new GitWorkspaceAdapter(commands).release({ workspace, force: false });
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.error.code, "workspace.dirty");
  assert.equal(commands.calls.some(call => call.args.includes("remove")), false);
});
