import { Clock } from "../../../shared/core/clock";
import { IdGenerator } from "../../../shared/core/idGenerator";
import { AppError, Result, err } from "../../../shared/core/result";
import { redactAndTruncateSensitiveText, redactSensitiveData } from "../../../shared/core/sensitiveData";
import { AgentApprovalRequest } from "../../agents/public";
import { TaskId } from "../../tasks/public";
import { Approval, ApprovalId, ApprovalProps, ApprovalRisk, ApprovalStatus } from "../domain/approval";
import { ApprovalRepository } from "../ports/approvalRepository";
import { OutboxService } from "../../outbox/public";

export interface CaptureApprovalCommand {
  readonly taskId: TaskId;
  readonly request: AgentApprovalRequest;
  readonly risk: ApprovalRisk;
  readonly title: string;
  readonly detail?: string;
}

export interface DecideApprovalCommand {
  readonly approvalId: ApprovalId;
  readonly decision: Exclude<ApprovalStatus, "pending">;
  readonly reason?: string;
}

export class ApprovalService {
  constructor(
    private readonly repository: ApprovalRepository,
    private readonly clock: Clock,
    private readonly ids: IdGenerator,
    private readonly outbox?: OutboxService
  ) {}

  async listPending(): Promise<Result<readonly ApprovalProps[]>> {
    const pending = await this.repository.listPending();
    if (!pending.ok) return pending;
    return { ok: true, value: pending.value.map(approval => approval.snapshot()) };
  }

  async capture(command: CaptureApprovalCommand): Promise<Result<ApprovalProps>> {
    const created = Approval.create({
      id: this.ids.next() as ApprovalId,
      taskId: command.taskId,
      runtimeRequestId: command.request.requestId,
      runtimeMethod: command.request.method,
      threadId: command.request.threadId,
      turnId: command.request.turnId,
      risk: command.risk,
      title: redactAndTruncateSensitiveText(command.title, 500),
      detail: command.detail ? redactAndTruncateSensitiveText(command.detail, 32_000) : undefined,
      payload: redactSensitiveData(command.request.payload),
      now: this.clock.now()
    });
    if (!created.ok) return created;
    const saved = await this.repository.save(created.value, -1);
    if (!saved.ok) return saved;
    if (this.outbox) {
      const published = await this.outbox.publish({ aggregateType: "approval", aggregateId: created.value.snapshot().id, eventType: "approval.created", payload: { taskId: command.taskId, risk: command.risk } });
      if (!published.ok) return published;
    }
    return { ok: true, value: created.value.snapshot() };
  }

  async decide(command: DecideApprovalCommand): Promise<Result<ApprovalProps>> {
    const found = await this.repository.findById(command.approvalId);
    if (!found.ok) return found;
    if (!found.value) return err(notFound(command.approvalId));
    const approval = found.value;
    const before = approval.snapshot().version;
    const decided = approval.decide(command.decision, this.clock.now(), command.reason);
    if (!decided.ok) return decided;
    const saved = await this.repository.save(approval, before);
    if (!saved.ok) return saved;
    if (this.outbox) {
      const published = await this.outbox.publish({ aggregateType: "approval", aggregateId: command.approvalId, eventType: "approval.decided", payload: { taskId: approval.snapshot().taskId, status: approval.snapshot().status } });
      if (!published.ok) return published;
    }
    return { ok: true, value: approval.snapshot() };
  }
}

function notFound(id: ApprovalId): AppError {
  return {
    code: "approval.not-found",
    category: "validation",
    message: "Approval request was not found.",
    retryable: false,
    context: { id }
  };
}
