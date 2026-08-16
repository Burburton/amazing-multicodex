import assert from "node:assert/strict";
import test from "node:test";
import { CoalescingAsyncRunner } from "./coalescingAsyncRunner";

test("reruns after a request arrives during an active operation", async () => {
  const values: number[] = [];
  let releaseFirst!: () => void;
  const firstBlocked = new Promise<void>(resolve => { releaseFirst = resolve; });
  const runner = new CoalescingAsyncRunner<number>(async value => {
    values.push(value);
    if (values.length === 1) await firstBlocked;
  }, (current, incoming) => current + incoming);

  const first = runner.run(1);
  const sameRun = runner.run(2);
  runner.run(3);
  assert.equal(first, sameRun);
  releaseFirst();
  await first;
  assert.deepEqual(values, [1, 5]);
});

test("accepts a fresh request after an operation rejects", async () => {
  let attempts = 0;
  const runner = new CoalescingAsyncRunner<void>(async () => {
    attempts += 1;
    if (attempts === 1) throw new Error("failed");
  }, () => undefined);

  await assert.rejects(runner.run(undefined), /failed/);
  await runner.run(undefined);
  assert.equal(attempts, 2);
});
