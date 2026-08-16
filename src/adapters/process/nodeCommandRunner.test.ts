import assert from "node:assert/strict";
import test from "node:test";
import { NodeCommandRunner } from "./nodeCommandRunner";

test("command runner terminates a command for an already-aborted signal", async () => {
  const controller = new AbortController();
  controller.abort();

  let rejectionTimer: NodeJS.Timeout | undefined;
  const timeoutFailure = new Promise<never>((_, reject) => {
    rejectionTimer = setTimeout(() => reject(new Error("abort did not terminate command")), 3_000);
    rejectionTimer.unref();
  });
  const result = await Promise.race([
    new NodeCommandRunner().run({
      executable: process.execPath,
      args: ["-e", "setInterval(() => undefined, 1000)"]
    }, controller.signal),
    timeoutFailure
  ]);
  if (rejectionTimer) clearTimeout(rejectionTimer);

  assert.notEqual(result.signal, null);
});

test("command runner bounds stdout capture", async () => {
  const result = await new NodeCommandRunner().run({
    executable: "git",
    args: ["--version"],
    maxOutputBytes: 8
  });

  assert.equal(result.stdout.length, 8);
  assert.equal(result.stderr, "");
  assert.equal(result.truncated, true);
});
