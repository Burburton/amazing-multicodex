import assert from "node:assert/strict";
import test from "node:test";
import { parseSettings } from "./settings";

test("normalizes valid settings over defaults", () => {
  const result = parseSettings({ codexExecutable: " /opt/codex ", defaultModel: " gpt-5.6 ", concurrencyLimit: 4 });
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.value.codexExecutable, "/opt/codex");
  assert.equal(result.value.concurrencyLimit, 4);
  assert.equal(result.value.defaultModel, "gpt-5.6");
  assert.equal(result.value.baseRef, "HEAD");
  assert.equal(result.value.validationTimeoutMs, 900_000);
});

test("treats an empty model override as Codex default selection", () => {
  const result = parseSettings({ defaultModel: "  " });
  assert.equal(result.ok && result.value.defaultModel, undefined);
});

test("rejects unsafe resource limits", () => {
  const result = parseSettings({ concurrencyLimit: 0 });
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.error.code, "settings.concurrency-limit");
});

test("rejects validation timeouts outside the safe range", () => {
  const result = parseSettings({ validationTimeoutMs: 3_600_001 });
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.error.code, "settings.validation-timeout");
});

test("rejects Git base refs that could be parsed as command options", () => {
  for (const baseRef of ["--help", "-C", "main\n--help"]) {
    const result = parseSettings({ baseRef });
    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.error.code, "settings.base-ref");
  }
});

test("returns typed errors for malformed runtime configuration shapes", () => {
  const executable = parseSettings({ codexExecutable: 42 } as never);
  assert.equal(executable.ok, false);
  if (!executable.ok) assert.equal(executable.error.code, "settings.codex-executable");
  const commands = parseSettings({
    validationCommands: [{ label: "Test", executable: "npm", args: [42] }]
  } as never);
  assert.equal(commands.ok, false);
  if (!commands.ok) assert.equal(commands.error.code, "settings.validation-commands");
});

test("bounds and normalizes configured validation commands", () => {
  const normalized = parseSettings({
    validationCommands: [{ label: " Test ", executable: " npm ", args: ["test"] }]
  });
  assert.equal(normalized.ok, true);
  if (normalized.ok) {
    assert.equal(normalized.value.validationCommands[0]?.label, "Test");
    assert.equal(normalized.value.validationCommands[0]?.executable, "npm");
  }
  const oversized = parseSettings({
    validationCommands: Array.from({ length: 51 }, () => ({ label: "Test", executable: "npm", args: ["test"] }))
  });
  assert.equal(oversized.ok, false);
  if (!oversized.ok) assert.equal(oversized.error.code, "settings.validation-commands");
});
