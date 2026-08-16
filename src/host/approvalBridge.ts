import { AgentApprovalDecision, AgentApprovalRequest, AgentRuntimePort } from "../modules/agents/public";
import { ApprovalProps, ApprovalRisk, ApprovalService, ApprovalStatus } from "../modules/approvals/public";
import { ExecutionRepository } from "../modules/orchestration/public";
import { TaskLifecycleService } from "../modules/tasks/public";

export interface ApprovalPrompt {
  decide(approval: ApprovalProps): Promise<Exclude<ApprovalStatus, "pending">>;
}

export class ApprovalBridge {
  private unsubscribe?: () => void;

  constructor(
    private readonly agents: AgentRuntimePort,
    private readonly executions: ExecutionRepository,
    private readonly approvals: ApprovalService,
    private readonly tasks: TaskLifecycleService,
    private readonly prompt: ApprovalPrompt
  ) {}

  start(): void {
    if (!this.unsubscribe) this.unsubscribe = this.agents.handleApprovals(request => this.handle(request));
  }

  stop(): void {
    this.unsubscribe?.();
    this.unsubscribe = undefined;
  }

  private async handle(request: AgentApprovalRequest): Promise<AgentApprovalDecision> {
    if (!request.threadId || !request.turnId) return { decision: "cancel" };
    const execution = await this.executions.findByAgent(request.threadId, request.turnId);
    if (!execution.ok || !execution.value) return { decision: "cancel" };
    const classification = classify(request);
    const captured = await this.approvals.capture({
      taskId: execution.value.taskId,
      request,
      risk: classification.risk,
      title: classification.title,
      detail: classification.detail
    });
    if (!captured.ok) return { decision: "cancel" };
    await this.tasks.transition(execution.value.taskId, "awaitingApproval", request.method);
    const decision = await this.prompt.decide(captured.value);
    const decided = await this.approvals.decide({ approvalId: captured.value.id, decision });
    await this.tasks.transition(execution.value.taskId, "running");
    if (!decided.ok) return { decision: "cancel" };
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

