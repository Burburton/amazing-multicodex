import {
  AgentApprovalHandler,
  AgentApprovalRequest,
  AgentEventListener,
  AgentExecutionRef,
  AgentRuntimeEvent,
  AgentRuntimeHealth,
  AgentRuntimePort,
  AgentRuntimeSnapshot,
  AgentThreadId,
  AgentTurnId,
  ExecutionId,
  ResumeExecutionInput,
  StartExecutionInput
} from "../../modules/agents/public";
import { JsonRpcPeer } from "./jsonRpc";
import { AppError } from "../../shared/core/result";
import { Result, err, ok } from "../../shared/core/result";

interface InitializeResult {
  readonly userAgent?: string;
}

interface ThreadResult {
  readonly thread: { readonly id: string };
}

interface TurnResult {
  readonly turn: { readonly id: string };
}

interface ThreadReadResult { readonly thread: Record<string, unknown>; }

interface NotificationEnvelope {
  readonly threadId?: unknown;
  readonly turn?: { readonly id?: unknown; readonly status?: unknown; readonly error?: unknown };
  readonly turnId?: unknown;
  readonly delta?: unknown;
  readonly item?: unknown;
}

const approvalMethods = [
  "item/commandExecution/requestApproval",
  "item/fileChange/requestApproval"
] as const;
const MAX_RUNTIME_ID_CHARACTERS = 1_000;
const MAX_AGENT_DELTA_CHARACTERS = 200_000;

export class CodexAppServerClient implements AgentRuntimePort {
  private readonly listeners = new Set<AgentEventListener>();
  private approvalHandler?: AgentApprovalHandler;
  private runtimeHealth: AgentRuntimeHealth = { status: "disconnected" };
  private initialized = false;
  private executionSequence = 0;

  constructor(private readonly peer: JsonRpcPeer) {
    this.bindNotifications();
    for (const method of approvalMethods) {
      peer.handleServerRequest(method, params => this.handleApproval(method, params));
    }
  }

  async initialize(): Promise<void> {
    if (this.initialized) return;
    const raw = await this.peer.request<unknown>("initialize", {
      clientInfo: {
        name: "amazing_multicodex",
        title: "Amazing MultiCodex",
        version: "0.1.0"
      }
    });
    const result = initializeResult(raw);
    this.peer.notify("initialized", {});
    this.initialized = true;
    this.runtimeHealth = { status: "ready", userAgent: result.userAgent };
  }

  async start(input: StartExecutionInput): Promise<AgentExecutionRef> {
    this.requireInitialized();
    const threadResult = threadResultOf(await this.peer.request<unknown>("thread/start", {
      model: input.model,
      cwd: input.cwd
    }));
    return this.startTurn(threadResult.thread.id as AgentThreadId, input.prompt, input.cwd);
  }

  async resume(input: ResumeExecutionInput): Promise<AgentExecutionRef> {
    this.requireInitialized();
    threadResultOf(await this.peer.request<unknown>("thread/resume", { threadId: input.threadId }));
    return this.startTurn(input.threadId, input.prompt, input.cwd);
  }

  async inspect(execution: AgentExecutionRef): Promise<Result<AgentRuntimeSnapshot>> {
    try {
      this.requireInitialized();
      const response = await this.peer.request<unknown>("thread/read", {
        threadId: execution.threadId,
        includeTurns: true
      });
      const thread = threadReadResultOf(response).thread;
      const turn = Array.isArray(thread.turns)
        ? (thread.turns as Array<Record<string, unknown>>).find(item => item.id === execution.turnId)
        : undefined;
      const error = turnErrorOf(turn?.error);
      return ok({
        threadId: execution.threadId,
        turnId: execution.turnId,
        threadStatus: threadStatusOf(thread.status),
        turnStatus: turnStatusOf(turn?.status),
        handoff: handoffOf(turn),
        ...(error ? { error } : {})
      });
    } catch (cause) {
      return err({
        code: "codex.inspect-failed",
        category: "unavailable",
        message: "Codex thread state could not be inspected.",
        retryable: true,
        cause
      });
    }
  }

  async steer(execution: AgentExecutionRef, prompt: string): Promise<void> {
    this.requireInitialized();
    await this.peer.request("turn/steer", {
      threadId: execution.threadId,
      expectedTurnId: execution.turnId,
      input: [{ type: "text", text: prompt }]
    });
  }

  async interrupt(execution: AgentExecutionRef): Promise<void> {
    this.requireInitialized();
    await this.peer.request("turn/interrupt", {
      threadId: execution.threadId,
      turnId: execution.turnId
    });
  }

  subscribe(listener: AgentEventListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  handleApprovals(handler: AgentApprovalHandler): () => void {
    this.approvalHandler = handler;
    return () => {
      if (this.approvalHandler === handler) this.approvalHandler = undefined;
    };
  }

  health(): AgentRuntimeHealth {
    return this.runtimeHealth;
  }

  disconnected(): void {
    this.initialized = false;
    this.runtimeHealth = { status: "disconnected" };
  }

  private async startTurn(
    threadId: AgentThreadId,
    prompt: string,
    cwd: string
  ): Promise<AgentExecutionRef> {
    const result = turnResultOf(await this.peer.request<unknown>("turn/start", {
      threadId,
      input: [{ type: "text", text: prompt }],
      cwd
    }));
    return {
      executionId: `${threadId}:${result.turn.id}:${++this.executionSequence}` as ExecutionId,
      threadId,
      turnId: result.turn.id as AgentTurnId
    };
  }

  private bindNotifications(): void {
    this.peer.onNotification("turn/started", params => this.mapTurnStarted(params));
    this.peer.onNotification("item/agentMessage/delta", params => this.mapAgentDelta(params));
    this.peer.onNotification("item/started", params => this.mapItem("itemStarted", params));
    this.peer.onNotification("item/completed", params => this.mapItem("itemCompleted", params));
    this.peer.onNotification("turn/completed", params => this.mapTurnCompleted(params));
  }

  private mapTurnStarted(params: unknown): void {
    const value = envelope(params);
    const threadId = boundedString(value.threadId, MAX_RUNTIME_ID_CHARACTERS);
    const turnId = boundedString(value.turn?.id, MAX_RUNTIME_ID_CHARACTERS);
    if (threadId && turnId) this.publish({
      type: "turnStarted",
      threadId: threadId as AgentThreadId,
      turnId: turnId as AgentTurnId
    });
  }

  private mapAgentDelta(params: unknown): void {
    const value = envelope(params);
    const threadId = boundedString(value.threadId, MAX_RUNTIME_ID_CHARACTERS);
    const turnId = boundedString(value.turnId, MAX_RUNTIME_ID_CHARACTERS);
    const rawDelta = stringValue(value.delta);
    const delta = rawDelta?.slice(-MAX_AGENT_DELTA_CHARACTERS);
    if (threadId && turnId && delta !== undefined) this.publish({
      type: "agentMessageDelta",
      threadId: threadId as AgentThreadId,
      turnId: turnId as AgentTurnId,
      delta
    });
  }

  private mapItem(type: "itemStarted" | "itemCompleted", params: unknown): void {
    const value = envelope(params);
    const threadId = boundedString(value.threadId, MAX_RUNTIME_ID_CHARACTERS);
    const turnId = boundedString(value.turnId, MAX_RUNTIME_ID_CHARACTERS);
    if (threadId && turnId) this.publish({
      type,
      threadId: threadId as AgentThreadId,
      turnId: turnId as AgentTurnId,
      item: value.item
    });
  }

  private mapTurnCompleted(params: unknown): void {
    const value = envelope(params);
    const threadId = boundedString(value.threadId, MAX_RUNTIME_ID_CHARACTERS);
    const turnId = boundedString(value.turn?.id, MAX_RUNTIME_ID_CHARACTERS);
    if (threadId && turnId) this.publish({
      type: "turnCompleted",
      threadId: threadId as AgentThreadId,
      turnId: turnId as AgentTurnId,
      status: boundedString(value.turn?.status, 100) ?? "unknown",
      error: value.turn?.error
    });
  }

  private publish(event: AgentRuntimeEvent): void {
    for (const listener of this.listeners) {
      try {
        listener(event);
      } catch {
        // Runtime event observers are independent projections.
      }
    }
  }

  private async handleApproval(method: string, params: unknown): Promise<unknown> {
    if (!this.approvalHandler) throw new Error("No approval handler is registered.");
    const value = envelope(params);
    const request: AgentApprovalRequest = {
      requestId: `${method}:${Date.now()}:${Math.random().toString(36).slice(2)}`,
      method,
      threadId: boundedString(value.threadId, MAX_RUNTIME_ID_CHARACTERS) as AgentThreadId | undefined,
      turnId: boundedString(value.turnId, MAX_RUNTIME_ID_CHARACTERS) as AgentTurnId | undefined,
      payload: params
    };
    return this.approvalHandler(request);
  }

  private requireInitialized(): void {
    if (!this.initialized) throw new Error("Codex App Server client is not initialized.");
  }
}

function envelope(value: unknown): NotificationEnvelope {
  return value && typeof value === "object" ? value as NotificationEnvelope : {};
}

function initializeResult(value: unknown): InitializeResult {
  if (!value || typeof value !== "object") throw invalidResponse("initialize");
  const userAgent = (value as Record<string, unknown>).userAgent;
  if (userAgent !== undefined && typeof userAgent !== "string") throw invalidResponse("initialize");
  if (typeof userAgent === "string" && userAgent.length > 1_000) throw invalidResponse("initialize");
  return { userAgent };
}

function threadResultOf(value: unknown): ThreadResult {
  const id = nestedId(value, "thread");
  if (!id) throw invalidResponse("thread");
  return { thread: { id } };
}

function turnResultOf(value: unknown): TurnResult {
  const id = nestedId(value, "turn");
  if (!id) throw invalidResponse("turn");
  return { turn: { id } };
}

function threadReadResultOf(value: unknown): ThreadReadResult {
  if (!value || typeof value !== "object") throw invalidResponse("thread/read");
  const thread = (value as Record<string, unknown>).thread;
  if (!thread || typeof thread !== "object") throw invalidResponse("thread/read");
  const id = boundedString((thread as Record<string, unknown>).id, MAX_RUNTIME_ID_CHARACTERS);
  if (!id) throw invalidResponse("thread/read");
  return { thread: thread as Record<string, unknown> };
}

function threadStatusOf(value: unknown): AgentRuntimeSnapshot["threadStatus"] {
  const type = value && typeof value === "object" ? (value as Record<string, unknown>).type : undefined;
  return type === "active" || type === "idle" || type === "systemError" || type === "notLoaded" ? type : "unknown";
}

function turnStatusOf(value: unknown): AgentRuntimeSnapshot["turnStatus"] {
  return value === "inProgress" || value === "completed" || value === "interrupted" || value === "failed" ? value : "unknown";
}

function turnErrorOf(value: unknown): string | undefined {
  if (!value || typeof value !== "object") return undefined;
  const message = (value as Record<string, unknown>).message;
  return typeof message === "string" ? message.slice(-2_000) : undefined;
}

function handoffOf(turn: Record<string, unknown> | undefined): string | undefined {
  if (!turn || !Array.isArray(turn.items)) return undefined;
  const text: string[] = [];
  for (const item of turn.items as Array<Record<string, unknown>>) {
    if (item.type !== "agentMessage") continue;
    const content = item.content;
    if (Array.isArray(content)) {
      for (const part of content as Array<Record<string, unknown>>) {
        if (typeof part.text === "string") text.push(part.text);
      }
    } else if (typeof item.text === "string") text.push(item.text);
  }
  const result = text.join("\n").trim();
  return result ? result.slice(-20_000) : undefined;
}

function nestedId(value: unknown, key: string): string | undefined {
  if (!value || typeof value !== "object") return undefined;
  const nested = (value as Record<string, unknown>)[key];
  if (!nested || typeof nested !== "object") return undefined;
  const id = (nested as Record<string, unknown>).id;
  return boundedString(id, MAX_RUNTIME_ID_CHARACTERS);
}

function invalidResponse(method: string): AppError {
  return {
    code: "codex.invalid-response",
    category: "unavailable",
    message: `Codex returned an invalid ${method} response.`,
    retryable: true,
    context: { method }
  };
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function boundedString(value: unknown, maxCharacters: number): string | undefined {
  return typeof value === "string" && value.length > 0 && value.length <= maxCharacters ? value : undefined;
}
