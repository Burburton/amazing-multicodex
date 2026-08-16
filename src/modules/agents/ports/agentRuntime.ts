import { Brand } from "../../../shared/core/brand";

export type ExecutionId = Brand<string, "ExecutionId">;
export type AgentThreadId = Brand<string, "AgentThreadId">;
export type AgentTurnId = Brand<string, "AgentTurnId">;

export interface StartExecutionInput {
  readonly prompt: string;
  readonly cwd: string;
  readonly model?: string;
}

export interface ResumeExecutionInput {
  readonly threadId: AgentThreadId;
  readonly prompt: string;
  readonly cwd: string;
}

export interface AgentExecutionRef {
  readonly executionId: ExecutionId;
  readonly threadId: AgentThreadId;
  readonly turnId: AgentTurnId;
}

export type AgentRuntimeHealth =
  | { readonly status: "disconnected" }
  | { readonly status: "ready"; readonly userAgent?: string };

export interface AgentApprovalRequest {
  readonly requestId: string;
  readonly method: string;
  readonly threadId?: AgentThreadId;
  readonly turnId?: AgentTurnId;
  readonly payload: unknown;
}

export type AgentApprovalDecision = Readonly<Record<string, unknown>>;

export type AgentRuntimeEvent =
  | {
      readonly type: "turnStarted";
      readonly threadId: AgentThreadId;
      readonly turnId: AgentTurnId;
    }
  | {
      readonly type: "agentMessageDelta";
      readonly threadId: AgentThreadId;
      readonly turnId: AgentTurnId;
      readonly delta: string;
    }
  | {
      readonly type: "itemStarted" | "itemCompleted";
      readonly threadId: AgentThreadId;
      readonly turnId: AgentTurnId;
      readonly item: unknown;
    }
  | {
      readonly type: "turnCompleted";
      readonly threadId: AgentThreadId;
      readonly turnId: AgentTurnId;
      readonly status: string;
      readonly error?: unknown;
    };

export type AgentEventListener = (event: AgentRuntimeEvent) => void;
export type AgentApprovalHandler = (request: AgentApprovalRequest) => Promise<AgentApprovalDecision>;

export interface AgentRuntimePort {
  initialize(): Promise<void>;
  start(input: StartExecutionInput): Promise<AgentExecutionRef>;
  resume(input: ResumeExecutionInput): Promise<AgentExecutionRef>;
  steer(execution: AgentExecutionRef, prompt: string): Promise<void>;
  interrupt(execution: AgentExecutionRef): Promise<void>;
  subscribe(listener: AgentEventListener): () => void;
  handleApprovals(handler: AgentApprovalHandler): () => void;
  health(): AgentRuntimeHealth;
}

