import assert from "node:assert/strict";
import test from "node:test";
import { TaskId } from "../../tasks/public";
import { workspaceBranch } from "./workspaceNaming";

test("creates bounded safe branch names", () => {
  assert.equal(
    workspaceBranch("task-12345678" as TaskId, " Add retry handling! ", "workspace-abcdef12"),
    "multicodex/add-retry-handling-12345678-abcdef12"
  );
});

test("uses a distinct branch for each execution lineage", () => {
  const first = workspaceBranch("task-12345678" as TaskId, "Retry", "workspace-first001");
  const second = workspaceBranch("task-12345678" as TaskId, "Retry", "workspace-second02");
  assert.notEqual(first, second);
});
