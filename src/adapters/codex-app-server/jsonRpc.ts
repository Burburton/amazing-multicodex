import { AppError } from "../../shared/core/result";

export type JsonRpcId = number | string;

export interface JsonRpcRequest {
  readonly id: JsonRpcId;
  readonly method: string;
  readonly params?: unknown;
}

export interface JsonRpcNotification {
  readonly method: string;
  readonly params?: unknown;
}

export interface JsonRpcSuccess {
  readonly id: JsonRpcId;
  readonly result: unknown;
}

export interface JsonRpcFailure {
  readonly id: JsonRpcId;
  readonly error: { readonly code: number; readonly message: string; readonly data?: unknown };
}

export type JsonRpcMessage =
  | JsonRpcRequest
  | JsonRpcNotification
  | JsonRpcSuccess
  | JsonRpcFailure;

export interface JsonRpcTransport {
  send(message: JsonRpcMessage): void;
}

export type ServerRequestHandler = (params: unknown) => Promise<unknown>;
export type NotificationHandler = (params: unknown) => void;

interface PendingRequest {
  readonly method: string;
  readonly resolve: (value: unknown) => void;
  readonly reject: (error: AppError) => void;
  readonly timeout: NodeJS.Timeout;
}

export class JsonRpcPeer {
  private nextId = 1;
  private readonly pending = new Map<JsonRpcId, PendingRequest>();
  private readonly notificationHandlers = new Map<string, Set<NotificationHandler>>();
  private readonly serverRequestHandlers = new Map<string, ServerRequestHandler>();
  private closed = false;

  constructor(
    private readonly transport: JsonRpcTransport,
    private readonly requestTimeoutMs = 30_000
  ) {}

  request<T>(method: string, params?: unknown): Promise<T> {
    if (this.closed) return Promise.reject(peerError("codex.connection-closed", "Codex connection is closed."));
    const id = this.nextId++;
    return new Promise<T>((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pending.delete(id);
        reject(peerError(
          "codex.request-timeout",
          `Codex request '${method}' timed out.`,
          true,
          { method }
        ));
      }, this.requestTimeoutMs);
      this.pending.set(id, {
        method,
        resolve: value => resolve(value as T),
        reject,
        timeout
      });
      try {
        this.transport.send({ id, method, params });
      } catch (cause) {
        clearTimeout(timeout);
        this.pending.delete(id);
        reject(peerError("codex.send-failed", "Failed to send request to Codex.", true, { method }, cause));
      }
    });
  }

  notify(method: string, params?: unknown): void {
    if (this.closed) throw peerError("codex.connection-closed", "Codex connection is closed.");
    this.transport.send({ method, params });
  }

  onNotification(method: string, handler: NotificationHandler): () => void {
    const handlers = this.notificationHandlers.get(method) ?? new Set<NotificationHandler>();
    handlers.add(handler);
    this.notificationHandlers.set(method, handlers);
    return () => handlers.delete(handler);
  }

  handleServerRequest(method: string, handler: ServerRequestHandler): () => void {
    this.serverRequestHandlers.set(method, handler);
    return () => {
      if (this.serverRequestHandlers.get(method) === handler) this.serverRequestHandlers.delete(method);
    };
  }

  receive(message: JsonRpcMessage): void {
    if (this.closed) return;
    if (isResponse(message)) {
      this.receiveResponse(message);
      return;
    }
    if ("id" in message) {
      void this.receiveServerRequest(message);
      return;
    }
    for (const handler of this.notificationHandlers.get(message.method) ?? []) {
      try {
        handler(message.params);
      } catch {
        // Notification consumers are isolated so one observer cannot block others.
      }
    }
  }

  close(cause?: unknown): void {
    if (this.closed) return;
    this.closed = true;
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timeout);
      pending.reject(peerError(
        "codex.connection-lost",
        `Codex connection closed while '${pending.method}' was pending.`,
        true,
        { method: pending.method },
        cause
      ));
    }
    this.pending.clear();
  }

  private receiveResponse(message: JsonRpcSuccess | JsonRpcFailure): void {
    const pending = this.pending.get(message.id);
    if (!pending) return;
    clearTimeout(pending.timeout);
    this.pending.delete(message.id);
    if ("error" in message) {
      pending.reject(peerError(
        "codex.rpc-error",
        message.error.message,
        message.error.code === -32001,
        { method: pending.method, rpcCode: String(message.error.code) },
        message.error.data
      ));
    } else {
      pending.resolve(message.result);
    }
  }

  private async receiveServerRequest(request: JsonRpcRequest): Promise<void> {
    const handler = this.serverRequestHandlers.get(request.method);
    if (!handler) {
      this.sendServerResponse({
        id: request.id,
        error: { code: -32601, message: `Unsupported server request: ${request.method}` }
      });
      return;
    }
    try {
      const result = await handler(request.params);
      this.sendServerResponse({ id: request.id, result });
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : "Server request handler failed.";
      this.sendServerResponse({ id: request.id, error: { code: -32603, message } });
    }
  }

  private sendServerResponse(message: JsonRpcSuccess | JsonRpcFailure): void {
    if (this.closed) return;
    try {
      this.transport.send(message);
    } catch {
      // The process can close between the state check and the transport write.
    }
  }
}

function isResponse(message: JsonRpcMessage): message is JsonRpcSuccess | JsonRpcFailure {
  return "id" in message && ("result" in message || "error" in message);
}

function peerError(
  code: string,
  message: string,
  retryable = false,
  context?: Record<string, string>,
  cause?: unknown
): AppError {
  return { code, category: "unavailable", message, retryable, context, cause };
}
