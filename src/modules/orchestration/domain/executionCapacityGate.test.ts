import assert from "node:assert/strict";
import test from "node:test";
import { ExecutionCapacityGate } from "./executionCapacityGate";

test("accounts for in-flight reservations before execution persistence", () => {
  const gate = new ExecutionCapacityGate();
  const release = gate.tryAcquire(0, 1);
  assert.equal(typeof release, "function");
  assert.equal(gate.tryAcquire(0, 1), undefined);
  release?.();
  assert.equal(typeof gate.tryAcquire(0, 1), "function");
});

