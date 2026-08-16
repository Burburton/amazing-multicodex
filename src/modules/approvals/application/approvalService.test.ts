import assert from "node:assert/strict";
import test from "node:test";
import { Clock } from "../../../shared/core/clock";
import { IdGenerator } from "../../../shared/core/idGenerator";
import { TaskId } from "../../tasks/public";
import { InMemoryApprovalRepository } from "../adapters/inMemoryApprovalRepository";
import { ApprovalId } from "../domain/approval";
import { ApprovalService } from "./approvalService";

class FixedClock implements Clock {
  now(): Date { return new Date("2026-08-15T12:00:00Z"); }
}
class FixedIds implements IdGenerator {
  next(): string { return "approval-1"; }
}

test("captures and decides an approval through repository ports", async () => {
  const repository = new InMemoryApprovalRepository();
  const service = new ApprovalService(repository, new FixedClock(), new FixedIds());
  const captured = await service.capture({
    taskId: "task-1" as TaskId,
    request: { requestId: "runtime-1", method: "approval", payload: { path: "x" } },
    risk: "write",
    title: "Write a file"
  });
  assert.equal(captured.ok, true);
  const decided = await service.decide({
    approvalId: "approval-1" as ApprovalId,
    decision: "approved"
  });
  assert.equal(decided.ok, true);
  if (!decided.ok) return;
  assert.equal(decided.value.status, "approved");
  const pending = await repository.findPendingByTask("task-1" as TaskId);
  assert.equal(pending.ok && pending.value.length, 0);
});

test("redacts nested approval secrets before persistence", async () => {
  const repository = new InMemoryApprovalRepository();
  const service = new ApprovalService(repository, new FixedClock(), new FixedIds());
  const captured = await service.capture({
    taskId: "task-1" as TaskId,
    request: {
      requestId: "runtime-1",
      method: "approval",
      payload: {
        password: "correct horse battery staple",
        command: "curl -H 'Authorization: Bearer secret-token-value' example.com",
        nested: { apiKey: "not-safe" }
      }
    },
    risk: "execute",
    title: "Run a command",
    detail: "OPENAI_API_KEY=sk-example1234567890"
  });

  assert.equal(captured.ok, true);
  if (!captured.ok) return;
  assert.equal(captured.value.detail?.includes("sk-example"), false);
  assert.deepEqual(captured.value.payload, {
    password: "[REDACTED]",
    command: "curl -H 'Authorization: Bearer [REDACTED] example.com",
    nested: { apiKey: "[REDACTED]" }
  });
});

test("bounds approval text before persistence", async () => {
  const repository = new InMemoryApprovalRepository();
  const captured = await new ApprovalService(repository, new FixedClock(), new FixedIds()).capture({
    taskId: "task-1" as TaskId,
    request: { requestId: "runtime-1", method: "approval", payload: {} },
    risk: "execute",
    title: "t".repeat(1_000),
    detail: "d".repeat(50_000)
  });
  assert.equal(captured.ok, true);
  if (!captured.ok) return;
  assert.equal(captured.value.title.length, 500);
  assert.equal(captured.value.detail?.length, 32_000);
  assert.match(captured.value.detail ?? "", /truncated/);
});
