import { Readable, Writable } from "node:stream";
import { createInterface, Interface } from "node:readline";
import { JsonRpcMessage, JsonRpcTransport } from "./jsonRpc";

export interface JsonLineTransportHandlers {
  readonly onMessage: (message: JsonRpcMessage) => void;
  readonly onMalformedLine: (line: string, cause: unknown) => void;
}

export class JsonLineTransport implements JsonRpcTransport {
  private readonly lines: Interface;
  private disposed = false;

  constructor(
    input: Readable,
    private readonly output: Writable,
    private readonly handlers: JsonLineTransportHandlers
  ) {
    this.lines = createInterface({ input, crlfDelay: Infinity });
    this.lines.on("line", line => this.receiveLine(line));
  }

  send(message: JsonRpcMessage): void {
    if (this.disposed) throw new Error("JSONL transport is closed.");
    this.output.write(`${JSON.stringify(message)}\n`);
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.lines.close();
  }

  private receiveLine(line: string): void {
    if (!line.trim()) return;
    try {
      const message = JSON.parse(line) as unknown;
      if (!isMessage(message)) throw new Error("Line is not a JSON-RPC message.");
      this.handlers.onMessage(message);
    } catch (cause) {
      this.handlers.onMalformedLine(line, cause);
    }
  }
}

function isMessage(value: unknown): value is JsonRpcMessage {
  if (!value || typeof value !== "object") return false;
  const record = value as Record<string, unknown>;
  const hasId = "id" in record;
  const validId = typeof record.id === "number" || typeof record.id === "string";
  if (typeof record.method === "string") return !hasId || validId;
  if (!hasId || !validId) return false;
  if ("result" in record) return !("error" in record);
  if (!("error" in record) || !record.error || typeof record.error !== "object") return false;
  const error = record.error as Record<string, unknown>;
  return typeof error.code === "number" && typeof error.message === "string";
}
