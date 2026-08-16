import { Readable, Writable } from "node:stream";
import { StringDecoder } from "node:string_decoder";
import { JsonRpcMessage, JsonRpcTransport } from "./jsonRpc";

export interface JsonLineTransportHandlers {
  readonly onMessage: (message: JsonRpcMessage) => void;
  readonly onMalformedLine: (line: string, cause: unknown) => void;
}

export class JsonLineTransport implements JsonRpcTransport {
  private readonly decoder = new StringDecoder("utf8");
  private buffer = "";
  private discardedLine = false;
  private disposed = false;
  private readonly onData = (chunk: Buffer | string): void => {
    this.receiveChunk(typeof chunk === "string" ? chunk : this.decoder.write(chunk));
  };
  private readonly onEnd = (): void => {
    const remainder = this.decoder.end();
    if (remainder) this.receiveChunk(remainder);
    this.finishLine();
  };

  constructor(
    private readonly input: Readable,
    private readonly output: Writable,
    private readonly handlers: JsonLineTransportHandlers,
    private readonly maxLineCharacters = 4 * 1024 * 1024
  ) {
    this.input.on("data", this.onData);
    this.input.once("end", this.onEnd);
  }

  send(message: JsonRpcMessage): void {
    if (this.disposed) throw new Error("JSONL transport is closed.");
    this.output.write(`${JSON.stringify(message)}\n`);
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.input.removeListener("data", this.onData);
    this.input.removeListener("end", this.onEnd);
  }

  private receiveChunk(chunk: string): void {
    let offset = 0;
    while (offset < chunk.length) {
      const newline = chunk.indexOf("\n", offset);
      const end = newline === -1 ? chunk.length : newline;
      this.appendFragment(chunk.slice(offset, end));
      if (newline === -1) return;
      this.finishLine();
      offset = newline + 1;
    }
  }

  private appendFragment(fragment: string): void {
    if (this.discardedLine) return;
    const remaining = this.maxLineCharacters - this.buffer.length;
    if (fragment.length <= remaining) {
      this.buffer += fragment;
      return;
    }
    this.buffer += fragment.slice(0, Math.max(0, remaining));
    this.discardedLine = true;
  }

  private finishLine(): void {
    if (!this.buffer && !this.discardedLine) return;
    const line = this.buffer.endsWith("\r") ? this.buffer.slice(0, -1) : this.buffer;
    this.buffer = "";
    if (this.discardedLine) {
      this.discardedLine = false;
      this.handlers.onMalformedLine(line, new Error(
        `JSONL message exceeded ${this.maxLineCharacters.toLocaleString()} characters.`
      ));
      return;
    }
    this.receiveLine(line);
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
