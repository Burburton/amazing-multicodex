import assert from "node:assert/strict";
import test from "node:test";
import { KeyValueState } from "../../shared/ports/keyValueState";
import { MementoApprovalRepository } from "./mementoApprovalRepository";

class FakeState implements KeyValueState {
  get<T>(_key: string, _defaultValue: T): T { return [{ id: "incomplete" }] as T; }
  update(): Thenable<void> { return Promise.resolve(); }
}

test("returns a typed error for malformed stored approvals", async () => {
  const repository = new MementoApprovalRepository(new FakeState());
  const result = await repository.findPendingByTask("task" as never);
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.error.code, "approval.state-invalid");
});
