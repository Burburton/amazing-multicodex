import assert from "node:assert/strict";
import test from "node:test";
import { Approval, ApprovalId } from "../../modules/approvals/public";
import { TaskId } from "../../modules/tasks/public";
import { KeyValueState } from "../../shared/ports/keyValueState";
import { MementoApprovalRepository } from "./mementoApprovalRepository";

class FakeState implements KeyValueState {
  value: unknown;
  constructor(value: unknown = []) { this.value = value; }
  get<T>(_key: string, _defaultValue: T): T { return this.value as T; }
  update(_key: string, value: unknown): Thenable<void> { this.value = value; return Promise.resolve(); }
}

test("returns a typed error for malformed stored approvals", async () => {
  const repository = new MementoApprovalRepository(new FakeState([{ id: "incomplete" }]));
  const result = await repository.findPendingByTask("task" as never);
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.error.code, "approval.state-invalid");
});

test("bounds terminal approval history while retaining pending requests", async () => {
  const terminal = Array.from({ length: 501 }, (_, index) => ({
    id: `old-${index}`,
    taskId: "task",
    runtimeRequestId: `request-${index}`,
    runtimeMethod: "approval",
    risk: "execute",
    title: "Old approval",
    payload: {},
    status: "approved",
    createdAt: "2026-08-16T12:00:00.000Z",
    decidedAt: "2026-08-16T12:00:01.000Z",
    version: 1
  }));
  const state = new FakeState(terminal);
  const repository = new MementoApprovalRepository(state);
  const pending = Approval.create({
    id: "pending" as ApprovalId,
    taskId: "task" as TaskId,
    runtimeRequestId: "pending-request",
    runtimeMethod: "approval",
    risk: "write",
    title: "Pending approval",
    payload: {},
    now: new Date("2026-08-16T12:00:02.000Z")
  });
  assert.equal(pending.ok, true);
  if (!pending.ok) return;

  const saved = await repository.save(pending.value, -1);
  assert.equal(saved.ok, true);
  const stored = state.value as Array<{ id: string; status: string }>;
  assert.equal(stored.length, 500);
  assert.equal(stored.some(record => record.id === "pending" && record.status === "pending"), true);
});

test("deletes approvals owned by a task", async () => {
  const state = new FakeState([{
    id: "approval", taskId: "task", runtimeRequestId: "request", runtimeMethod: "approval",
    risk: "write", title: "Approval", payload: {}, status: "pending",
    createdAt: "2026-08-16T12:00:00.000Z", version: 0
  }]);
  const repository = new MementoApprovalRepository(state);
  assert.equal((await repository.deleteByTask("task" as TaskId)).ok, true);
  assert.deepEqual(state.value, []);
});
