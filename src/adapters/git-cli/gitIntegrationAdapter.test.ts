import assert from "node:assert/strict";
import test from "node:test";
import { TaskId } from "../../modules/tasks/public";
import { WorkspaceId } from "../../modules/workspaces/public";
import { CommandResult, CommandRunnerPort, CommandSpec } from "../../shared/ports/commandRunner";
import { GitIntegrationAdapter } from "./gitIntegrationAdapter";

class Commands implements CommandRunnerPort {
  readonly calls: CommandSpec[] = [];
  readonly results: CommandResult[] = [];
  async run(spec: CommandSpec): Promise<CommandResult> {
    this.calls.push(spec);
    return this.results.shift() ?? success();
  }
}
const success = (stdout = "", exitCode = 0): CommandResult => ({ exitCode, signal: null, stdout, stderr: "", truncated: false });

test("commits pending task changes and merges only into a clean target", async () => {
  const commands = new Commands();
  commands.results.push(
    success(), success(), success(), success("", 1), success(), success("source\n"), success(), success("target\n")
  );
  const result = await new GitIntegrationAdapter(commands).integrate({
    workspace: {
      id: "workspace" as WorkspaceId,
      taskId: "task" as TaskId,
      repositoryRoot: "/repo",
      worktreeRoot: "/worktrees",
      path: "/worktrees/task",
      branch: "multicodex/task",
      baseRef: "main"
    },
    targetRepositoryRoot: "/repo",
    strategy: "merge",
    commitMessage: "Integrate task", reviewedPatch: ""
  });
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.value.targetCommit, "target");
  assert.deepEqual(commands.calls[6].args, ["merge", "--no-ff", "source", "-m", "Integrate task"]);
});

test("squashes the resolved source commit rather than the mutable branch name", async () => {
  const commands = new Commands();
  commands.results.push(
    success(), success(), success(), success("", 0), success("source-sha\n"), success(), success(), success("target-sha\n")
  );
  const result = await new GitIntegrationAdapter(commands).integrate({
    workspace: {
      id: "workspace" as WorkspaceId, taskId: "task" as TaskId,
      repositoryRoot: "/repo", worktreeRoot: "/worktrees", path: "/worktrees/task",
      branch: "multicodex/task", baseRef: "base"
    },
    targetRepositoryRoot: "/repo", strategy: "squash", commitMessage: "Integrate task", reviewedPatch: ""
  });

  assert.equal(result.ok, true);
  assert.deepEqual(commands.calls[5].args, ["merge", "--squash", "source-sha"]);
});

test("rejects a workspace whose HEAD still equals its immutable base", async () => {
  const commands = new Commands();
  commands.results.push(success(), success(), success(), success("", 0), success("base-sha\n"));
  const result = await new GitIntegrationAdapter(commands).integrate({
    workspace: {
      id: "workspace" as WorkspaceId, taskId: "task" as TaskId,
      repositoryRoot: "/repo", worktreeRoot: "/worktrees", path: "/worktrees/task",
      branch: "multicodex/task", baseRef: "base-sha"
    },
    targetRepositoryRoot: "/repo", strategy: "merge", commitMessage: "Integrate task", reviewedPatch: ""
  });

  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.error.code, "integration.no-changes");
  assert.equal(commands.calls.some(call => call.args[0] === "merge"), false);
});

test("restores the clean target after a merge failure", async () => {
  const commands = new Commands();
  const failed = { ...success("", 1), stderr: "conflict" };
  commands.results.push(success(), success(), success(), success("", 0), success("source-sha\n"), failed, success());
  const result = await new GitIntegrationAdapter(commands).integrate({
    workspace: {
      id: "workspace" as WorkspaceId, taskId: "task" as TaskId,
      repositoryRoot: "/repo", worktreeRoot: "/worktrees", path: "/worktrees/task",
      branch: "multicodex/task", baseRef: "base"
    },
    targetRepositoryRoot: "/repo", strategy: "merge", commitMessage: "Integrate task", reviewedPatch: ""
  });

  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.error.code, "integration.git-failed");
  assert.deepEqual(commands.calls.at(-1)?.args, ["reset", "--merge", "HEAD"]);
});

test("reports when a failed integration cannot restore the target", async () => {
  const commands = new Commands();
  const failed = { ...success("", 1), stderr: "conflict" };
  commands.results.push(success(), success(), success(), success("", 0), success("source-sha\n"), failed, failed);
  const result = await new GitIntegrationAdapter(commands).integrate({
    workspace: {
      id: "workspace" as WorkspaceId, taskId: "task" as TaskId,
      repositoryRoot: "/repo", worktreeRoot: "/worktrees", path: "/worktrees/task",
      branch: "multicodex/task", baseRef: "base"
    },
    targetRepositoryRoot: "/repo", strategy: "squash", commitMessage: "Integrate task", reviewedPatch: ""
  });

  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.error.code, "integration.rollback-failed");
});

test("rejects changes made after review and unstages the workspace", async () => {
  const commands = new Commands();
  commands.results.push(success(), success(), success("current patch\n"), success());
  const result = await new GitIntegrationAdapter(commands).integrate({
    workspace: {
      id: "workspace" as WorkspaceId, taskId: "task" as TaskId,
      repositoryRoot: "/repo", worktreeRoot: "/worktrees", path: "/worktrees/task",
      branch: "multicodex/task", baseRef: "base"
    },
    targetRepositoryRoot: "/repo", strategy: "merge", commitMessage: "Integrate task",
    reviewedPatch: "reviewed patch\n"
  });

  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.error.code, "integration.review-stale");
  assert.deepEqual(commands.calls.at(-1)?.args, ["reset", "base"]);
  assert.equal(commands.calls.some(call => call.args[0] === "merge"), false);
});

test("rejects integration into a different repository before running Git", async () => {
  const commands = new Commands();
  const result = await new GitIntegrationAdapter(commands).integrate({
    workspace: {
      id: "workspace" as WorkspaceId, taskId: "task" as TaskId,
      repositoryRoot: "/original", worktreeRoot: "/worktrees", path: "/worktrees/task",
      branch: "multicodex/task", baseRef: "base"
    },
    targetRepositoryRoot: "/different", strategy: "merge", commitMessage: "Integrate task",
    reviewedPatch: "patch"
  });

  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.error.code, "integration.target-mismatch");
  assert.equal(commands.calls.length, 0);
});

test("rejects truncated Git output before changing the target", async () => {
  const commands = new Commands();
  commands.results.push({ ...success("partial status"), truncated: true });
  const result = await new GitIntegrationAdapter(commands).integrate({
    workspace: {
      id: "workspace" as WorkspaceId, taskId: "task" as TaskId,
      repositoryRoot: "/repo", worktreeRoot: "/worktrees", path: "/worktrees/task",
      branch: "multicodex/task", baseRef: "base"
    },
    targetRepositoryRoot: "/repo", strategy: "merge", commitMessage: "Integrate task",
    reviewedPatch: "patch"
  });
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.error.code, "integration.output-truncated");
  assert.equal(commands.calls.length, 1);
});
