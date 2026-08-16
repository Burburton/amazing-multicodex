import assert from "node:assert/strict";
import test from "node:test";
import { parseSettings } from "./settings";

test("normalizes valid settings over defaults", () => {
  const result = parseSettings({ codexExecutable: " /opt/codex ", concurrencyLimit: 4 });
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.value.codexExecutable, "/opt/codex");
  assert.equal(result.value.concurrencyLimit, 4);
  assert.equal(result.value.baseRef, "HEAD");
});

test("rejects unsafe resource limits", () => {
  const result = parseSettings({ concurrencyLimit: 0 });
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.error.code, "settings.concurrency-limit");
});

