import assert from "node:assert/strict";
import { once } from "node:events";
import test from "node:test";
import { NodeProcessFactory } from "./nodeProcessFactory";

test("terminating a managed process closes pipes held by descendants", {
  skip: process.platform === "win32" ? "POSIX process groups are unavailable on Windows" : false
}, async () => {
  const managed = new NodeProcessFactory().spawn({
    command: process.execPath,
    args: [
      "-e",
      "require('node:child_process').spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'inherit'});process.stdout.write('ready');setInterval(()=>{},1000)"
    ]
  });
  await once(managed.stdout, "data");
  const streamsClosed = Promise.all([once(managed.stdout, "end"), once(managed.stderr, "end")]);

  managed.terminate();
  let failureTimer: NodeJS.Timeout | undefined;
  try {
    await Promise.race([
      streamsClosed,
      new Promise<never>((_, reject) => {
        failureTimer = setTimeout(() => reject(new Error("managed process tree retained its output pipes")), 3_000);
      })
    ]);
  } finally {
    if (failureTimer) clearTimeout(failureTimer);
  }
  assert.ok(true);
});

test("force kills a managed process tree that ignores graceful termination", {
  skip: process.platform === "win32" ? "POSIX process groups are unavailable on Windows" : false
}, async () => {
  const managed = new NodeProcessFactory().spawn({
    command: process.execPath,
    args: [
      "-e",
      "process.on('SIGTERM',()=>{});require('node:child_process').spawn(process.execPath,['-e',\"process.on('SIGTERM',()=>{});setInterval(()=>{},1000)\"],{stdio:'inherit'});process.stdout.write('ready');setInterval(()=>{},1000)"
    ]
  });
  await once(managed.stdout, "data");
  const streamsClosed = Promise.all([once(managed.stdout, "end"), once(managed.stderr, "end")]);

  managed.terminate();
  let failureTimer: NodeJS.Timeout | undefined;
  try {
    await Promise.race([
      streamsClosed,
      new Promise<never>((_, reject) => {
        failureTimer = setTimeout(() => reject(new Error("stubborn process tree was not force killed")), 3_000);
      })
    ]);
  } finally {
    if (failureTimer) clearTimeout(failureTimer);
  }
  assert.ok(true);
});
