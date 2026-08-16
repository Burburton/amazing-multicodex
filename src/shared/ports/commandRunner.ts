export interface CommandSpec {
  readonly executable: string;
  readonly args: readonly string[];
  readonly cwd?: string;
  readonly env?: Readonly<Record<string, string | undefined>>;
  readonly maxOutputBytes?: number;
}

export interface CommandResult {
  readonly exitCode: number | null;
  readonly signal: NodeJS.Signals | null;
  readonly stdout: string;
  readonly stderr: string;
  readonly truncated: boolean;
}

export interface CommandRunnerPort {
  run(spec: CommandSpec, signal?: AbortSignal): Promise<CommandResult>;
}

