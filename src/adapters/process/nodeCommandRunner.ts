import { spawn } from "node:child_process";
import { CommandResult, CommandRunnerPort, CommandSpec } from "../../shared/ports/commandRunner";

export class NodeCommandRunner implements CommandRunnerPort {
  run(spec: CommandSpec, signal?: AbortSignal): Promise<CommandResult> {
    return new Promise((resolve, reject) => {
      const child = spawn(spec.executable, [...spec.args], {
        cwd: spec.cwd,
        env: { ...process.env, ...spec.env },
        shell: false,
        windowsHide: true
      });
      const capture = new BoundedOutputCapture(spec.maxOutputBytes ?? 2 * 1024 * 1024);
      let forceKillTimer: NodeJS.Timeout | undefined;

      child.stdout.on("data", chunk => { capture.append("stdout", Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)); });
      child.stderr.on("data", chunk => { capture.append("stderr", Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)); });
      child.once("error", reject);
      child.once("close", (exitCode, exitSignal) => {
        if (forceKillTimer) clearTimeout(forceKillTimer);
        resolve({
          exitCode,
          signal: exitSignal,
          ...capture.result()
        });
      });

      const abort = () => {
        if (child.exitCode !== null || child.signalCode !== null) return;
        child.kill();
        forceKillTimer = setTimeout(() => {
          if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
        }, 1_000);
        forceKillTimer.unref();
      };
      if (signal?.aborted) abort();
      else signal?.addEventListener("abort", abort, { once: true });
      child.once("close", () => signal?.removeEventListener("abort", abort));
    });
  }
}

export class BoundedOutputCapture {
  private readonly chunks = { stdout: [] as Buffer[], stderr: [] as Buffer[] };
  private capturedBytes = 0;
  private truncated = false;
  private readonly limit: number;

  constructor(limit: number) {
    this.limit = Math.max(0, limit);
  }

  append(stream: "stdout" | "stderr", chunk: Buffer): void {
    const remaining = Math.max(0, this.limit - this.capturedBytes);
    if (chunk.byteLength > remaining) this.truncated = true;
    if (remaining === 0) return;
    const retained = Buffer.from(chunk.subarray(0, remaining));
    this.chunks[stream].push(retained);
    this.capturedBytes += retained.byteLength;
  }

  result(): Pick<CommandResult, "stdout" | "stderr" | "truncated"> {
    return {
      stdout: Buffer.concat(this.chunks.stdout).toString("utf8"),
      stderr: Buffer.concat(this.chunks.stderr).toString("utf8"),
      truncated: this.truncated
    };
  }
}
