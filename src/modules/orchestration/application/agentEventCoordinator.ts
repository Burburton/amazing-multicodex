import { Clock } from "../../../shared/core/clock";
import { AgentRuntimeEvent, AgentRuntimePort } from "../../agents/public";
import { TaskLifecycleService } from "../../tasks/public";
import { ExecutionRepository, TaskExecutionRecord } from "../ports/executionRepository";

export interface CoordinatorDiagnostics {
  readonly error: (message: string, cause?: unknown) => void;
  readonly taskChanged?: () => void;
}

const silentDiagnostics: CoordinatorDiagnostics = { error: () => undefined };

export class AgentEventCoordinator {
  private unsubscribe?: () => void;

  constructor(
    private readonly agents: AgentRuntimePort,
    private readonly executions: ExecutionRepository,
    private readonly tasks: TaskLifecycleService,
    private readonly clock: Clock,
    private readonly diagnostics: CoordinatorDiagnostics = silentDiagnostics
  ) {}

  start(): void {
    if (this.unsubscribe) return;
    this.unsubscribe = this.agents.subscribe(event => { void this.handle(event); });
  }

  stop(): void {
    this.unsubscribe?.();
    this.unsubscribe = undefined;
  }

  private async handle(event: AgentRuntimeEvent): Promise<void> {
    if (event.type !== "turnCompleted") return;
    const found = await this.executions.findByAgent(event.threadId, event.turnId);
    if (!found.ok) {
      this.diagnostics.error("Could not resolve completed agent execution.", found.error);
      return;
    }
    if (!found.value || found.value.status !== "running") return;
    const success = event.status === "completed";
    const updated: TaskExecutionRecord = {
      ...found.value,
      status: success ? "completed" : event.status === "interrupted" ? "cancelled" : "failed",
      updatedAt: this.clock.now(),
      version: found.value.version + 1
    };
    const saved = await this.executions.save(updated, found.value.version);
    if (!saved.ok) {
      this.diagnostics.error("Could not persist completed agent execution.", saved.error);
      return;
    }
    const transitioned = await this.tasks.transition(
      found.value.taskId,
      success ? "validating" : event.status === "interrupted" ? "cancelled" : "failed",
      success ? undefined : `codex.turn-${event.status}`
    );
    if (!transitioned.ok) {
      this.diagnostics.error("Could not advance task after agent completion.", transitioned.error);
    } else {
      this.diagnostics.taskChanged?.();
    }
  }
}
