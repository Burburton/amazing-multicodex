import { AgentApprovalDecision, AgentApprovalRequest, AgentRuntimePort } from "../modules/agents/public";
import { ApprovalProps, ApprovalRisk, ApprovalService, ApprovalStatus } from "../modules/approvals/public";
import { ExecutionRepository } from "../modules/orchestration/public";
import { TaskLifecycleService } from "../modules/tasks/public";

export interface ApprovalPrompt {
  decide(approval: ApprovalProps): Promise<Exclude<ApprovalStatus, "pending">>;
}

export interface ApprovalBridgeDiagnostics {
  readonly error: (message: string, cause?: unknown) => void;
  readonly taskChanged?: (taskId: ApprovalProps["taskId"]) => void;
}

const silentDiagnostics: ApprovalBridgeDiagnostics = { error: () => undefined };

export class ApprovalBridge {
  private unsubscribe?: () => void;

  constructor(
    private readonly agents: AgentRuntimePort,
    private readonly executions: ExecutionRepository,
    private readonly approvals: ApprovalService,
    private readonly tasks: TaskLifecycleService,
    private readonly prompt: ApprovalPrompt,
    private readonly diagnostics: ApprovalBridgeDiagnostics = silentDiagnostics
  ) {}

  start(): void {
    if (!this.unsubscribe) this.unsubscribe = this.agents.handleApprovals(request => this.handle(request));
  }

  stop(): void {
    this.unsubscribe?.();
    this.unsubscribe = undefined;
  }

  private async handle(request: AgentApprovalRequest): Promise<AgentApprovalDecision> {
    if (!request.threadId || !request.turnId) {
      this.diagnostics.error("Codex approval request did not identify its execution.");
      return { decision: "cancel" };
    }
    const execution = await this.executions.findByAgent(request.threadId, request.turnId);
    if (!execution.ok || !execution.value) {
      this.diagnostics.error("Could not associate Codex approval with a task.", execution.ok ? undefined : execution.error);
      return { decision: "cancel" };
    }
    const classification = classify(request);
    const captured = await this.approvals.capture({
      taskId: execution.value.taskId,
      request,
      risk: classification.risk,
      title: classification.title,
      detail: classification.detail
    });
    if (!captured.ok) {
      this.diagnostics.error("Could not persist Codex approval request.", captured.error);
      return { decision: "cancel" };
    }
    const awaiting = await this.tasks.transition(execution.value.taskId, "awaitingApproval", request.method);
    if (!awaiting.ok) {
      await this.approvals.decide({
        approvalId: captured.value.id,
        decision: "cancelled",
        reason: awaiting.error.code
      });
      this.diagnostics.error("Task could not enter approval state.", awaiting.error);
      return { decision: "cancel" };
    }
    this.diagnostics.taskChanged?.(execution.value.taskId);
    let decision: Exclude<ApprovalStatus, "pending">;
    try {
      decision = await this.prompt.decide(captured.value);
    } catch {
      decision = "cancelled";
    }
    const decided = await this.approvals.decide({ approvalId: captured.value.id, decision });
    if (!decided.ok) {
      await this.tasks.transition(execution.value.taskId, "blocked", decided.error.code);
      this.diagnostics.taskChanged?.(execution.value.taskId);
      this.diagnostics.error("Could not persist Codex approval decision.", decided.error);
      return { decision: "cancel" };
    }
    const running = await this.tasks.transition(execution.value.taskId, "running");
    if (!running.ok) {
      await this.tasks.transition(execution.value.taskId, "blocked", running.error.code);
      this.diagnostics.taskChanged?.(execution.value.taskId);
      this.diagnostics.error("Task could not leave approval state.", running.error);
      return { decision: "cancel" };
    }
    this.diagnostics.taskChanged?.(execution.value.taskId);
    return { decision: decision === "approved" ? "accept" : decision === "declined" ? "decline" : "cancel" };
  }
}

function classify(request: AgentApprovalRequest): { risk: ApprovalRisk; title: string; detail?: string } {
  const payload = request.payload && typeof request.payload === "object"
    ? request.payload as Record<string, unknown> : {};
  if (request.method === "item/fileChange/requestApproval") {
    return { risk: "write", title: "Allow Codex to modify files?", detail: stringValue(payload.reason) };
  }
  const command = stringValue(payload.command);
  return {
    risk: command && /\b(rm|delete|drop|reset)\b/i.test(command) ? "destructive" : "execute",
    title: "Allow Codex to run a command?",
    detail: command ?? stringValue(payload.reason)
  };
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}
