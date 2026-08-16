import { CommandRunnerPort, CommandSpec } from "../shared/ports/commandRunner";
import { redactAndTruncateSensitiveText } from "../shared/core/sensitiveData";

export interface RuntimePreflightOptions {
  readonly cwd: string;
  readonly codexExecutable: string;
  readonly baseRef: string;
  readonly timeoutMs?: number;
}

export interface RuntimeCheck {
  readonly id: "codex" | "repository" | "baseRef";
  readonly label: string;
  readonly ok: boolean;
  readonly detail: string;
}

export class RuntimePreflight {
  constructor(private readonly commands: CommandRunnerPort) {}

  async inspect(options: RuntimePreflightOptions): Promise<readonly RuntimeCheck[]> {
    const timeoutMs = options.timeoutMs ?? 5_000;
    return Promise.all([
      this.check(
        "codex",
        "Codex CLI",
        { executable: options.codexExecutable, args: ["--version"], cwd: options.cwd, maxOutputBytes: 4_096 },
        timeoutMs,
        output => output || "Codex CLI is available."
      ),
      this.check(
        "repository",
        "Git repository",
        { executable: "git", args: ["rev-parse", "--show-toplevel"], cwd: options.cwd, maxOutputBytes: 4_096 },
        timeoutMs,
        output => output || options.cwd
      ),
      this.check(
        "baseRef",
        "Git base ref",
        { executable: "git", args: ["rev-parse", "--verify", "--end-of-options", `${options.baseRef}^{commit}`], cwd: options.cwd, maxOutputBytes: 4_096 },
        timeoutMs,
        () => `${options.baseRef} resolves to a commit.`
      )
    ]);
  }

  private async check(
    id: RuntimeCheck["id"],
    label: string,
    spec: CommandSpec,
    timeoutMs: number,
    successDetail: (output: string) => string
  ): Promise<RuntimeCheck> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const result = await this.commands.run(spec, controller.signal);
      const output = redactAndTruncateSensitiveText(firstLine(result.stdout) || firstLine(result.stderr), 2_000);
      if (controller.signal.aborted) return { id, label, ok: false, detail: `Timed out after ${timeoutMs} ms.` };
      if (result.exitCode !== 0) {
        return { id, label, ok: false, detail: output || `Exited with code ${String(result.exitCode)}.` };
      }
      if (result.truncated) return { id, label, ok: false, detail: "Diagnostic output was truncated." };
      return { id, label, ok: true, detail: successDetail(output) };
    } catch (cause) {
      return {
        id,
        label,
        ok: false,
        detail: redactAndTruncateSensitiveText(cause instanceof Error ? cause.message : String(cause), 2_000)
      };
    } finally {
      clearTimeout(timeout);
    }
  }
}

function firstLine(value: string): string {
  return value.trim().split(/\r?\n/, 1)[0] ?? "";
}
