import { spawn } from "node:child_process";
import { ManagedProcess, ProcessFactory, ProcessSpec } from "./processPort";

export class NodeProcessFactory implements ProcessFactory {
  spawn(spec: ProcessSpec): ManagedProcess {
    const child = spawn(spec.command, [...spec.args], {
      cwd: spec.cwd,
      env: { ...process.env, ...spec.env },
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true
    });
    if (!child.stdin || !child.stdout || !child.stderr) {
      child.kill();
      throw new Error("Spawned process does not expose stdio streams.");
    }
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
        if (!child.killed) child.kill();
      }
    };
  }
}

