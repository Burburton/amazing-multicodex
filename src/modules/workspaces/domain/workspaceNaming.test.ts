import assert from "node:assert/strict";
import test from "node:test";
import { TaskId } from "../../tasks/public";
import { workspaceBranch } from "./workspaceNaming";

test("creates bounded safe branch names", () => {
  assert.equal(
    workspaceBranch("task-12345678" as TaskId, " Add retry handling! "),
    "multicodex/add-retry-handling-12345678"
  );
});

