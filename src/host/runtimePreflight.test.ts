import assert from "node:assert/strict";
import test from "node:test";
import { CommandRunnerPort, CommandSpec } from "../shared/ports/commandRunner";
import { RuntimePreflight } from "./runtimePreflight";

test("runtime preflight reports successful Codex and Git checks", async () => {
  const runner = new StubRunner(spec => ({
    exitCode: 0,
    signal: null,
    stdout: spec.executable === "codex" ? "codex-cli 1.2.3\n" : "/repo\n",
    stderr: "",
    truncated: false
  }));

  const checks = await new RuntimePreflight(runner).inspect({
    cwd: "/repo",
    codexExecutable: "codex",
    baseRef: "HEAD"
  });

  assert.deepEqual(checks.map(check => check.ok), [true, true, true]);
  assert.equal(checks[0]?.detail, "codex-cli 1.2.3");
  assert.deepEqual(runner.specs[2]?.args, ["rev-parse", "--verify", "HEAD^{commit}"]);
});

test("runtime preflight isolates command failures", async () => {
  const runner = new StubRunner(spec => {
    if (spec.executable === "codex") throw new Error("spawn codex ENOENT");
    return { exitCode: 128, signal: null, stdout: "", stderr: "bad revision\nmore", truncated: false };
  });

  const checks = await new RuntimePreflight(runner).inspect({
    cwd: "/repo",
    codexExecutable: "codex",
    baseRef: "missing"
  });

  assert.equal(checks[0]?.detail, "spawn codex ENOENT");
  assert.equal(checks[1]?.detail, "bad revision");
  assert.ok(checks.every(check => !check.ok));
});

class StubRunner implements CommandRunnerPort {
  readonly specs: CommandSpec[] = [];

  constructor(private readonly respond: (spec: CommandSpec) => Awaited<ReturnType<CommandRunnerPort["run"]>>) {}

  async run(spec: CommandSpec): Promise<Awaited<ReturnType<CommandRunnerPort["run"]>>> {
    this.specs.push(spec);
    return this.respond(spec);
  }
}
