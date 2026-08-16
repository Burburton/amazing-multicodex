import assert from "node:assert/strict";
import test from "node:test";
import { BoundedOutputCapture, NodeCommandRunner } from "./nodeCommandRunner";

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

test("aborting a command terminates descendants that retain its output pipes", {
  skip: process.platform === "win32"
}, async () => {
  const controller = new AbortController();
  const result = new NodeCommandRunner().run({
    executable: process.execPath,
    args: [
      "-e",
      "require('node:child_process').spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'inherit'});setInterval(()=>{},1000)"
    ]
  }, controller.signal);
  const abortTimer = setTimeout(() => controller.abort(), 100);
  let failureTimer!: NodeJS.Timeout;
  try {
    const completed = await Promise.race([
      result,
      new Promise<never>((_, reject) => {
        failureTimer = setTimeout(() => reject(new Error("process tree did not terminate")), 3_000);
      })
    ]);
    assert.notEqual(completed.signal, null);
  } finally {
    clearTimeout(abortTimer);
    clearTimeout(failureTimer);
  }
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

test("shares the output budget across stdout and stderr", () => {
  const capture = new BoundedOutputCapture(10);
  capture.append("stdout", Buffer.from("a".repeat(8)));
  capture.append("stderr", Buffer.from("b".repeat(8)));
  const result = capture.result();

  assert.equal(Buffer.byteLength(result.stdout) + Buffer.byteLength(result.stderr), 10);
  assert.equal(result.stdout, "a".repeat(8));
  assert.equal(result.stderr, "b".repeat(2));
  assert.equal(result.truncated, true);
});
