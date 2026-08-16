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
      const limit = spec.maxOutputBytes ?? 2 * 1024 * 1024;
      let stdout: Buffer = Buffer.alloc(0);
      let stderr: Buffer = Buffer.alloc(0);
      let truncated = false;
      let forceKillTimer: NodeJS.Timeout | undefined;

      const append = (current: Buffer, chunk: Buffer): Buffer => {
        const remaining = Math.max(0, limit - current.byteLength);
        if (chunk.byteLength > remaining) truncated = true;
        return remaining === 0 ? current : Buffer.concat([current, chunk.subarray(0, remaining)]);
      };
      child.stdout.on("data", chunk => { stdout = append(stdout, Buffer.from(chunk)); });
      child.stderr.on("data", chunk => { stderr = append(stderr, Buffer.from(chunk)); });
      child.once("error", reject);
      child.once("close", (exitCode, exitSignal) => {
        if (forceKillTimer) clearTimeout(forceKillTimer);
        resolve({
          exitCode,
          signal: exitSignal,
          stdout: stdout.toString("utf8"),
          stderr: stderr.toString("utf8"),
          truncated
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
