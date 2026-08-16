import assert from "node:assert/strict";
import test from "node:test";
import { TaskId } from "../../tasks/public";
import { Approval, ApprovalId } from "./approval";

const now = new Date("2026-08-15T12:00:00Z");

function pending(): Approval {
  const created = Approval.create({
    id: "approval-1" as ApprovalId,
    taskId: "task-1" as TaskId,
    runtimeRequestId: "runtime-1",
    runtimeMethod: "item/fileChange/requestApproval",
    risk: "write",
    title: "Modify files",
    payload: {},
    now
  });
  assert.equal(created.ok, true);
  if (!created.ok) throw new Error("fixture failed");
  return created.value;
}

test("creates a pending approval", () => {
  assert.equal(pending().snapshot().status, "pending");
});

test("allows exactly one terminal decision", () => {
  const approval = pending();
  assert.equal(approval.decide("approved", now, "Reviewed").ok, true);
  const second = approval.decide("declined", now);
  assert.equal(second.ok, false);
  if (second.ok) return;
  assert.equal(second.error.code, "approval.already-decided");
});

