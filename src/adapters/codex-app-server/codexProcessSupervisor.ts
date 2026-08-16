import { AppError } from "../../shared/core/result";
import { ManagedProcess, ProcessFactory, ProcessExit } from "../process/processPort";
import { CodexAppServerClient } from "./codexAppServerClient";
import { JsonLineTransport } from "./jsonLineTransport";
import { JsonRpcPeer } from "./jsonRpc";

export interface CodexProcessOptions {
  readonly executable?: string;
  readonly cwd?: string;
  readonly env?: Readonly<Record<string, string | undefined>>;
  readonly requestTimeoutMs?: number;
}

export interface CodexProcessDiagnostics {
  readonly malformedProtocolLine: (line: string, cause: unknown) => void;
  readonly stderr: (chunk: string) => void;
  readonly exited: (exit: ProcessExit) => void;
  readonly processError: (error: Error) => void;
}

const noDiagnostics: CodexProcessDiagnostics = {
  malformedProtocolLine: () => undefined,
  stderr: () => undefined,
  exited: () => undefined,
  processError: () => undefined
};

export class CodexProcessSupervisor {
  private process?: ManagedProcess;
  private transport?: JsonLineTransport;
  private peer?: JsonRpcPeer;
  private client?: CodexAppServerClient;
  private disposers: Array<() => void> = [];
  private starting?: Promise<CodexAppServerClient>;

  constructor(
    private readonly processes: ProcessFactory,
    private readonly diagnostics: CodexProcessDiagnostics = noDiagnostics
  ) {}

  start(options: CodexProcessOptions = {}): Promise<CodexAppServerClient> {
    if (this.client?.health().status === "ready") return Promise.resolve(this.client);
    if (this.starting) return this.starting;
    this.starting = this.startOnce(options).finally(() => { this.starting = undefined; });
    return this.starting;
  }

  stop(): void {
    const process = this.process;
    this.release(new Error("Codex process stopped by host."));
    process?.terminate();
  }

  current(): CodexAppServerClient | undefined {
    return this.client;
  }

  private async startOnce(options: CodexProcessOptions): Promise<CodexAppServerClient> {
    this.stop();
    let child: ManagedProcess;
    try {
      child = this.processes.spawn({
        command: options.executable ?? "codex",
        args: ["app-server"],
        cwd: options.cwd,
        env: options.env
      });
    } catch (cause) {
      throw supervisorError("codex.spawn-failed", "Could not start Codex App Server.", cause);
    }

    this.process = child;
    let peer: JsonRpcPeer;
    const transport = new JsonLineTransport(child.stdout, child.stdin, {
      onMessage: message => peer.receive(message),
      onMalformedLine: (line, cause) => this.diagnostics.malformedProtocolLine(line, cause)
    });
    peer = new JsonRpcPeer(transport, options.requestTimeoutMs);
    const client = new CodexAppServerClient(peer);
    this.transport = transport;
    this.peer = peer;
    this.client = client;
    child.stderr.on("data", chunk => this.diagnostics.stderr(String(chunk)));
    this.disposers = [
      child.onExit(exit => {
        this.release(new Error(`Codex exited with code ${String(exit.code)}.`));
        this.diagnostics.exited(exit);
      }),
      child.onError(error => {
        this.release(error);
        this.diagnostics.processError(error);
      })
    ];

    try {
      await client.initialize();
      return client;
    } catch (cause) {
      child.terminate();
      this.release(cause);
      throw cause;
    }
  }

  private release(cause: unknown): void {
    for (const dispose of this.disposers.splice(0)) dispose();
    this.peer?.close(cause);
    this.transport?.dispose();
    this.client?.disconnected();
    this.process = undefined;
    this.peer = undefined;
    this.transport = undefined;
    this.client = undefined;
  }
}

function supervisorError(code: string, message: string, cause: unknown): AppError {
  return { code, category: "unavailable", message, retryable: true, cause };
}
