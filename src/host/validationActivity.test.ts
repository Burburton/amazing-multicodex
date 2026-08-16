import assert from "node:assert/strict";
import test from "node:test";
import { ValidationCheckId, ValidationProfileId, ValidationRunId } from "../modules/validation/public";
import { WorkspaceId } from "../modules/workspaces/public";
import { formatValidationActivity } from "./validationActivity";

test("formats labelled validation diagnostics and retains the latest bounded output", () => {
  const occurredAt = new Date("2026-08-16T12:00:00Z");
  const detail = formatValidationActivity({
    id: "run" as ValidationRunId,
    workspaceId: "workspace" as WorkspaceId,
    profileId: "profile" as ValidationProfileId,
    status: "failed",
    checks: [{
      checkId: "check" as ValidationCheckId,
      status: "failed",
      exitCode: 1,
      stdout: "older stdout",
      stderr: "0123456789",
      truncated: true,
      startedAt: occurredAt,
      completedAt: occurredAt
    }],
    startedAt: occurredAt,
    completedAt: occurredAt
  }, ["Unit tests"], 5);

  assert.match(detail, /^Unit tests: failed \(exit 1, output truncated\)/);
  assert.match(detail, /tdout$/);
  assert.doesNotMatch(detail, /01234/);
});
