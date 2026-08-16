import { Readable, Writable } from "node:stream";

export interface ProcessExit {
  readonly code: number | null;
  readonly signal: NodeJS.Signals | null;
}

export interface ManagedProcess {
  readonly stdin: Writable;
  readonly stdout: Readable;
  readonly stderr: Readable;
  readonly pid?: number;
  onExit(listener: (exit: ProcessExit) => void): () => void;
  onError(listener: (error: Error) => void): () => void;
  terminate(): void;
}

export interface ProcessSpec {
  readonly command: string;
  readonly args: readonly string[];
  readonly cwd?: string;
  readonly env?: Readonly<Record<string, string | undefined>>;
}

export interface ProcessFactory {
  spawn(spec: ProcessSpec): ManagedProcess;
}

