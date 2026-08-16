import { spawn } from "node:child_process";
import { ManagedProcess, ProcessFactory, ProcessSpec } from "./processPort";

export class NodeProcessFactory implements ProcessFactory {
  spawn(spec: ProcessSpec): ManagedProcess {
    const child = spawn(spec.command, [...spec.args], {
      cwd: spec.cwd,
      env: { ...process.env, ...spec.env },
      stdio: ["pipe", "pipe", "pipe"],
      detached: process.platform !== "win32",
      windowsHide: true
    });
    if (!child.stdin || !child.stdout || !child.stderr) {
      child.kill();
      throw new Error("Spawned process does not expose stdio streams.");
    }
    let closed = false;
    let terminationRequested = false;
    let forceKillTimer: NodeJS.Timeout | undefined;
    child.once("close", () => {
      closed = true;
      if (forceKillTimer) clearTimeout(forceKillTimer);
    });

    const signal = (processSignal: NodeJS.Signals): void => {
      if (process.platform !== "win32" && child.pid !== undefined) {
        try {
          process.kill(-child.pid, processSignal);
          return;
        } catch {
          // Fall back to the direct child when a process group is unavailable.
        }
      }
      child.kill(processSignal);
    };
    return {
      stdin: child.stdin,
      stdout: child.stdout,
      stderr: child.stderr,
      pid: child.pid,
      onExit(listener) {
        const wrapped = (code: number | null, signal: NodeJS.Signals | null) => listener({ code, signal });
        child.on("exit", wrapped);
        return () => child.off("exit", wrapped);
      },
      onError(listener) {
        child.on("error", listener);
        return () => child.off("error", listener);
      },
      terminate() {
        if (closed || terminationRequested) return;
        terminationRequested = true;
        signal("SIGTERM");
        forceKillTimer = setTimeout(() => {
          if (!closed) signal("SIGKILL");
        }, 1_000);
        forceKillTimer.unref();
      }
    };
  }
}
