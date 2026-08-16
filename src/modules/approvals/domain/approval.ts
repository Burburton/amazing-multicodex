import { Brand } from "../../../shared/core/brand";
import { AppError, Result, err, ok } from "../../../shared/core/result";
import { AgentThreadId, AgentTurnId } from "../../agents/public";
import { TaskId } from "../../tasks/public";

export type ApprovalId = Brand<string, "ApprovalId">;
export type ApprovalStatus = "pending" | "approved" | "declined" | "cancelled";
export type ApprovalRisk = "read" | "write" | "execute" | "destructive" | "external";

export interface ApprovalProps {
  readonly id: ApprovalId;
  readonly taskId: TaskId;
  readonly runtimeRequestId: string;
  readonly runtimeMethod: string;
  readonly threadId?: AgentThreadId;
  readonly turnId?: AgentTurnId;
  readonly risk: ApprovalRisk;
  readonly title: string;
  readonly detail?: string;
  readonly payload: unknown;
  readonly status: ApprovalStatus;
  readonly decisionReason?: string;
  readonly createdAt: Date;
  readonly decidedAt?: Date;
  readonly version: number;
}

export interface NewApprovalProps {
  readonly id: ApprovalId;
  readonly taskId: TaskId;
  readonly runtimeRequestId: string;
  readonly runtimeMethod: string;
  readonly threadId?: AgentThreadId;
  readonly turnId?: AgentTurnId;
  readonly risk: ApprovalRisk;
  readonly title: string;
  readonly detail?: string;
  readonly payload: unknown;
  readonly now: Date;
}

export class Approval {
  private constructor(private props: ApprovalProps) {}

  static create(input: NewApprovalProps): Result<Approval> {
    const title = input.title.trim();
    if (!title) return err(approvalError("approval.title-required", "Approval title is required."));
    if (!input.runtimeRequestId.trim()) {
      return err(approvalError("approval.runtime-request-required", "Runtime request ID is required."));
    }
    return ok(new Approval({
      ...input,
      runtimeRequestId: input.runtimeRequestId.trim(),
      runtimeMethod: input.runtimeMethod.trim(),
      title,
      detail: normalize(input.detail),
      status: "pending",
      createdAt: input.now,
      version: 0
    }));
  }

  static restore(props: ApprovalProps): Approval {
    return new Approval({ ...props });
  }

  snapshot(): ApprovalProps {
    return { ...this.props };
  }

  decide(
    decision: Exclude<ApprovalStatus, "pending">,
    now: Date,
    reason?: string
  ): Result<void> {
    if (this.props.status !== "pending") {
      return err(approvalError(
        "approval.already-decided",
        `Approval already has terminal status '${this.props.status}'.`
      ));
    }
    this.props = {
      ...this.props,
      status: decision,
      decisionReason: normalize(reason),
      decidedAt: now,
      version: this.props.version + 1
    };
    return ok(undefined);
  }
}

function normalize(value: string | undefined): string | undefined {
  const normalized = value?.trim();
  return normalized || undefined;
}

function approvalError(code: string, message: string): AppError {
  return { code, category: "conflict", message, retryable: false };
}

