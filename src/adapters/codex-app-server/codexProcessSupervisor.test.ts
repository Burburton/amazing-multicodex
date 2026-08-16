import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import test from "node:test";
import { ManagedProcess, ProcessExit, ProcessFactory, ProcessSpec } from "../process/processPort";
import { CodexProcessSupervisor } from "./codexProcessSupervisor";

class FakeProcess implements ManagedProcess {
  readonly stdin = new PassThrough();
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  readonly pid = 123;
  readonly events = new EventEmitter();
  terminated = false;
  written: string[] = [];

  constructor() {
    this.stdin.on("data", chunk => this.written.push(String(chunk)));
  }

  onExit(listener: (exit: ProcessExit) => void): () => void {
    this.events.on("exit", listener);
    return () => this.events.off("exit", listener);
  }

  onError(listener: (error: Error) => void): () => void {
    this.events.on("error", listener);
    return () => this.events.off("error", listener);
  }

  terminate(): void { this.terminated = true; }

  reply(index: number, result: unknown): void {
    const request = JSON.parse(this.written[index]) as { id: number };
    this.stdout.write(`${JSON.stringify({ id: request.id, result })}\n`);
  }
}

class FakeProcessFactory implements ProcessFactory {
  readonly child = new FakeProcess();
  spec?: ProcessSpec;
  spawn(spec: ProcessSpec): ManagedProcess {
    this.spec = spec;
    return this.child;
  }
}

test("starts Codex with stdio and initializes the client", async () => {
  const factory = new FakeProcessFactory();
  const supervisor = new CodexProcessSupervisor(factory);
  const starting = supervisor.start({ executable: "/bin/codex", cwd: "/repo" });
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(factory.spec, {
    command: "/bin/codex",
    args: ["app-server"],
    cwd: "/repo",
    env: undefined
  });
  factory.child.reply(0, { userAgent: "test" });
  const client = await starting;
  assert.equal(client.health().status, "ready");
  assert.match(factory.child.written[1], /"method":"initialized"/);
});

test("marks the client disconnected and rejects pending work on exit", async () => {
  const factory = new FakeProcessFactory();
  const supervisor = new CodexProcessSupervisor(factory);
  const starting = supervisor.start();
  await new Promise(resolve => setImmediate(resolve));
  factory.child.reply(0, {});
  const client = await starting;
  const pending = client.start({ prompt: "work", cwd: "/repo" });
  factory.child.events.emit("exit", { code: 1, signal: null });
  await assert.rejects(pending, error => (error as { code: string }).code === "codex.connection-lost");
  assert.equal(client.health().status, "disconnected");
  assert.equal(supervisor.current(), undefined);
});

test("releases runtime state before reporting process exit", async () => {
  const factory = new FakeProcessFactory();
  let supervisor!: CodexProcessSupervisor;
  let currentDuringExit: ReturnType<CodexProcessSupervisor["current"]> | undefined;
  supervisor = new CodexProcessSupervisor(factory, {
    malformedProtocolLine: () => undefined,
    stderr: () => undefined,
    exited: () => { currentDuringExit = supervisor.current(); },
    processError: () => undefined
  });
  const starting = supervisor.start();
  await new Promise(resolve => setImmediate(resolve));
  factory.child.reply(0, {});
  await starting;

  factory.child.events.emit("exit", { code: 1, signal: null });

  assert.equal(currentDuringExit, undefined);
});

test("stop is idempotent and terminates the child", async () => {
  const factory = new FakeProcessFactory();
  const supervisor = new CodexProcessSupervisor(factory);
  const starting = supervisor.start();
  await new Promise(resolve => setImmediate(resolve));
  factory.child.reply(0, {});
  await starting;
  supervisor.stop();
  supervisor.stop();
  assert.equal(factory.child.terminated, true);
});
