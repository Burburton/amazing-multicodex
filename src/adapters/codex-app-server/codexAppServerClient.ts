import {
  AgentApprovalHandler,
  AgentApprovalRequest,
  AgentEventListener,
  AgentExecutionRef,
  AgentRuntimeEvent,
  AgentRuntimeHealth,
  AgentRuntimePort,
  AgentThreadId,
  AgentTurnId,
  ExecutionId,
  ResumeExecutionInput,
  StartExecutionInput
} from "../../modules/agents/public";
import { JsonRpcPeer } from "./jsonRpc";

interface InitializeResult {
  readonly userAgent?: string;
}

interface ThreadResult {
  readonly thread: { readonly id: string };
}

interface TurnResult {
  readonly turn: { readonly id: string };
}

interface NotificationEnvelope {
  readonly threadId?: unknown;
  readonly turn?: { readonly id?: unknown; readonly status?: unknown; readonly error?: unknown };
  readonly turnId?: unknown;
  readonly delta?: unknown;
  readonly item?: unknown;
}

const approvalMethods = [
  "item/commandExecution/requestApproval",
  "item/fileChange/requestApproval",
  "item/tool/requestUserInput"
] as const;

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
    const result = await this.peer.request<InitializeResult>("initialize", {
      clientInfo: {
        name: "amazing_multicodex",
        title: "Amazing MultiCodex",
        version: "0.1.0"
      }
    });
    this.peer.notify("initialized", {});
    this.initialized = true;
    this.runtimeHealth = { status: "ready", userAgent: result.userAgent };
  }

  async start(input: StartExecutionInput): Promise<AgentExecutionRef> {
    this.requireInitialized();
    const threadResult = await this.peer.request<ThreadResult>("thread/start", {
      model: input.model,
      cwd: input.cwd
    });
    return this.startTurn(threadResult.thread.id as AgentThreadId, input.prompt, input.cwd);
  }

  async resume(input: ResumeExecutionInput): Promise<AgentExecutionRef> {
    this.requireInitialized();
    await this.peer.request<ThreadResult>("thread/resume", { threadId: input.threadId });
    return this.startTurn(input.threadId, input.prompt, input.cwd);
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
    const result = await this.peer.request<TurnResult>("turn/start", {
      threadId,
      input: [{ type: "text", text: prompt }],
      cwd
    });
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
    const threadId = stringValue(value.threadId);
    const turnId = stringValue(value.turn?.id);
    if (threadId && turnId) this.publish({
      type: "turnStarted",
      threadId: threadId as AgentThreadId,
      turnId: turnId as AgentTurnId
    });
  }

  private mapAgentDelta(params: unknown): void {
    const value = envelope(params);
    const threadId = stringValue(value.threadId);
    const turnId = stringValue(value.turnId);
    const delta = stringValue(value.delta);
    if (threadId && turnId && delta !== undefined) this.publish({
      type: "agentMessageDelta",
      threadId: threadId as AgentThreadId,
      turnId: turnId as AgentTurnId,
      delta
    });
  }

  private mapItem(type: "itemStarted" | "itemCompleted", params: unknown): void {
    const value = envelope(params);
    const threadId = stringValue(value.threadId);
    const turnId = stringValue(value.turnId);
    if (threadId && turnId) this.publish({
      type,
      threadId: threadId as AgentThreadId,
      turnId: turnId as AgentTurnId,
      item: value.item
    });
  }

  private mapTurnCompleted(params: unknown): void {
    const value = envelope(params);
    const threadId = stringValue(value.threadId);
    const turnId = stringValue(value.turn?.id);
    if (threadId && turnId) this.publish({
      type: "turnCompleted",
      threadId: threadId as AgentThreadId,
      turnId: turnId as AgentTurnId,
      status: stringValue(value.turn?.status) ?? "unknown",
      error: value.turn?.error
    });
  }

  private publish(event: AgentRuntimeEvent): void {
    for (const listener of this.listeners) listener(event);
  }

  private async handleApproval(method: string, params: unknown): Promise<unknown> {
    if (!this.approvalHandler) throw new Error("No approval handler is registered.");
    const value = envelope(params);
    const request: AgentApprovalRequest = {
      requestId: `${method}:${Date.now()}:${Math.random().toString(36).slice(2)}`,
      method,
      threadId: stringValue(value.threadId) as AgentThreadId | undefined,
      turnId: stringValue(value.turnId) as AgentTurnId | undefined,
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

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

