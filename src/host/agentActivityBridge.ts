import { AgentPlanRepository, AgentRole, AgentRuntimeEvent, AgentRuntimePort } from "../modules/agents/public";
import { ActivityService } from "../modules/activity/public";
import { ExecutionRepository, TaskExecutionRecord } from "../modules/orchestration/public";

export interface ActivityBridgeDiagnostics {
  readonly error: (message: string, cause?: unknown) => void;
  readonly activityRecorded?: (taskId: TaskExecutionRecord["taskId"]) => void;
}

export class AgentActivityBridge {
  private readonly messageBuffers = new Map<string, string>();
  private unsubscribe?: () => void;

  constructor(
    private readonly agents: AgentRuntimePort,
    private readonly executions: ExecutionRepository,
    private readonly activity: ActivityService,
    private readonly maxMessageCharacters = 32_000,
    private readonly diagnostics: ActivityBridgeDiagnostics = { error: () => undefined },
    private readonly maxBufferedTurns = 128,
    private readonly plans?: AgentPlanRepository
  ) {}

  start(): void {
    if (!this.unsubscribe) this.unsubscribe = this.agents.subscribe(event => { void this.handle(event); });
  }

  stop(): void {
    this.unsubscribe?.();
    this.unsubscribe = undefined;
    this.messageBuffers.clear();
  }

  private async handle(event: AgentRuntimeEvent): Promise<void> {
    const key = JSON.stringify([event.threadId, event.turnId]);
    if (event.type === "agentMessageDelta") {
      const current = this.messageBuffers.get(key) ?? "";
      if (!current && !this.messageBuffers.has(key) && this.messageBuffers.size >= this.maxBufferedTurns) {
        const oldest = this.messageBuffers.keys().next().value as string | undefined;
        if (oldest) this.messageBuffers.delete(oldest);
      }
      this.messageBuffers.set(key, (current + event.delta).slice(-this.maxMessageCharacters));
      return;
    }
    if (event.type !== "turnCompleted") return;
    const message = this.messageBuffers.get(key);
    this.messageBuffers.delete(key);
    const execution = await this.executions.findByAgent(event.threadId, event.turnId);
    if (!execution.ok || !execution.value) {
      this.diagnostics.error("Could not associate Codex activity with a task.", execution.ok ? undefined : execution.error);
      return;
    }
    const role = await this.roleFor(execution.value, event.threadId, event.turnId);
    const prefix = role ? `${roleLabel(role)} ` : "Codex ";
    if (message) {
      const recorded = await this.activity.record({
        taskId: execution.value.taskId,
        kind: "agentMessage",
        summary: `${prefix}response`,
        detail: message
      });
      if (!recorded.ok) this.diagnostics.error("Could not persist Codex response activity.", recorded.error);
    }
    const terminal = await this.activity.record({
      taskId: execution.value.taskId,
      kind: event.status === "completed" ? "lifecycle" : "error",
      summary: `${prefix}turn ${event.status}`
    });
    if (!terminal.ok) this.diagnostics.error("Could not persist Codex terminal activity.", terminal.error);
    else this.diagnostics.activityRecorded?.(execution.value.taskId);
  }

  private async roleFor(execution: TaskExecutionRecord, threadId: string, turnId: string): Promise<AgentRole | undefined> {
    if (execution.agent?.threadId === threadId && execution.agent.turnId === turnId) return execution.stage?.role;
    const index = execution.previousAgents?.findIndex(agent => agent.threadId === threadId && agent.turnId === turnId) ?? -1;
    if (index < 0 || !this.plans) return undefined;
    const plan = await this.plans.findByTask(execution.taskId);
    return plan.ok ? plan.value?.snapshot().stages[index]?.role : undefined;
  }
}

function roleLabel(role: AgentRole): string { return role[0].toUpperCase() + role.slice(1); }
