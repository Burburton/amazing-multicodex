import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SqliteKeyValueState } from "./sqliteKeyValueState";

test("persists JSON state across SQLite connections", async () => {
  const root = mkdtempSync(join(tmpdir(), "amazing-multicodex-sqlite-"));
  const path = join(root, "state.db");
  const first = new SqliteKeyValueState(path);
  await first.update("tasks", [{ id: "task-1", status: "queued" }]);
  first.close();
  const second = new SqliteKeyValueState(path);
  assert.deepEqual(second.get("tasks", []), [{ id: "task-1", status: "queued" }]);
  second.close();
  rmSync(root, { recursive: true, force: true });
});
