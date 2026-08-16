import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { TaskId } from "../../modules/tasks/public";
import { WorkspaceId } from "../../modules/workspaces/public";
import { NodeCommandRunner } from "../process/nodeCommandRunner";
import { GitIntegrationAdapter } from "./gitIntegrationAdapter";
import { GitWorkspaceAdapter } from "./gitWorkspaceAdapter";

test("real Git contract covers worktree diff and reviewed merge integration", async () => {
  const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), "multicodex-git-contract-"));
  const repositoryRoot = path.join(temporaryRoot, "repository");
  const worktreeRoot = path.join(temporaryRoot, "worktrees");
  fs.mkdirSync(repositoryRoot);
  fs.mkdirSync(worktreeRoot);
  const commands = new NodeCommandRunner();
  try {
    await git(commands, repositoryRoot, ["init", "-b", "main"]);
    await git(commands, repositoryRoot, ["config", "user.name", "MultiCodex Test"]);
    await git(commands, repositoryRoot, ["config", "user.email", "multicodex@example.invalid"]);
    fs.writeFileSync(path.join(repositoryRoot, "tracked.txt"), "before\n");
    await git(commands, repositoryRoot, ["add", "tracked.txt"]);
    await git(commands, repositoryRoot, ["commit", "-m", "initial"]);

    const workspaces = new GitWorkspaceAdapter(commands);
    const prepared = await workspaces.prepare({
      id: "workspace-1" as WorkspaceId,
      taskId: "task-1" as TaskId,
      repositoryRoot,
      worktreeRoot,
      branch: "multicodex/contract-task",
      baseRef: "HEAD"
    });
    assert.equal(prepared.ok, true);
    if (!prepared.ok) return;
    assert.match(prepared.value.baseRef, /^[0-9a-f]{40}$/);

    fs.writeFileSync(path.join(prepared.value.path, "tracked.txt"), "after\n");
    fs.writeFileSync(path.join(prepared.value.path, "new.txt"), "new file\n");
    const changes = await workspaces.diff(prepared.value);
    assert.equal(changes.ok, true);
    if (!changes.ok) return;
    assert.match(changes.value.patch, /tracked\.txt/);
    assert.match(changes.value.patch, /new\.txt/);

    const integrated = await new GitIntegrationAdapter(commands).integrate({
      workspace: prepared.value,
      targetRepositoryRoot: repositoryRoot,
      strategy: "merge",
      commitMessage: "Integrate contract task"
    });
    assert.equal(integrated.ok, true);
    if (!integrated.ok) return;
    assert.equal(fs.readFileSync(path.join(repositoryRoot, "tracked.txt"), "utf8"), "after\n");
    assert.equal(fs.readFileSync(path.join(repositoryRoot, "new.txt"), "utf8"), "new file\n");
  } finally {
    fs.rmSync(temporaryRoot, { recursive: true, force: true });
  }
});

test("real Git contract restores a clean target after an integration conflict", async () => {
  const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), "multicodex-git-conflict-"));
  const repositoryRoot = path.join(temporaryRoot, "repository");
  const worktreeRoot = path.join(temporaryRoot, "worktrees");
  fs.mkdirSync(repositoryRoot);
  fs.mkdirSync(worktreeRoot);
  const commands = new NodeCommandRunner();
  try {
    await git(commands, repositoryRoot, ["init", "-b", "main"]);
    await git(commands, repositoryRoot, ["config", "user.name", "MultiCodex Test"]);
    await git(commands, repositoryRoot, ["config", "user.email", "multicodex@example.invalid"]);
    fs.writeFileSync(path.join(repositoryRoot, "conflict.txt"), "base\n");
    await git(commands, repositoryRoot, ["add", "conflict.txt"]);
    await git(commands, repositoryRoot, ["commit", "-m", "initial"]);
    const prepared = await new GitWorkspaceAdapter(commands).prepare({
      id: "workspace-conflict" as WorkspaceId,
      taskId: "task-conflict" as TaskId,
      repositoryRoot, worktreeRoot, branch: "multicodex/conflict", baseRef: "HEAD"
    });
    assert.equal(prepared.ok, true);
    if (!prepared.ok) return;
    fs.writeFileSync(path.join(prepared.value.path, "conflict.txt"), "task\n");
    fs.writeFileSync(path.join(repositoryRoot, "conflict.txt"), "target\n");
    await git(commands, repositoryRoot, ["add", "conflict.txt"]);
    await git(commands, repositoryRoot, ["commit", "-m", "target change"]);

    const integrated = await new GitIntegrationAdapter(commands).integrate({
      workspace: prepared.value, targetRepositoryRoot: repositoryRoot,
      strategy: "merge", commitMessage: "conflicting task"
    });

    assert.equal(integrated.ok, false);
    const status = await commands.run({ executable: "git", args: ["status", "--porcelain=v1"], cwd: repositoryRoot });
    assert.equal(status.stdout, "");
    assert.equal(fs.readFileSync(path.join(repositoryRoot, "conflict.txt"), "utf8"), "target\n");
  } finally {
    fs.rmSync(temporaryRoot, { recursive: true, force: true });
  }
});

async function git(commands: NodeCommandRunner, cwd: string, args: readonly string[]): Promise<void> {
  const result = await commands.run({ executable: "git", args, cwd });
  assert.equal(result.exitCode, 0, result.stderr);
}
