import { Clock } from "../../../shared/core/clock";
import { AgentPlanRepository, AgentRuntimeEvent, AgentRuntimePort, AgentRuntimeSnapshot } from "../../agents/public";
import { TaskLifecycleService } from "../../tasks/public";
import { AgentStageHistoryEntry, ExecutionRepository, PendingAgentStage, TaskExecutionRecord } from "../ports/executionRepository";
import { pendingStagePrompt } from "./agentStagePrompt";

export interface CoordinatorDiagnostics {
  readonly error: (message: string, cause?: unknown) => void;
  readonly taskChanged?: (taskId: TaskExecutionRecord["taskId"], remainsActive: boolean) => void;
}

const silentDiagnostics: CoordinatorDiagnostics = { error: () => undefined };
const MAX_REVIEW_CYCLES = 3;

export class AgentEventCoordinator {
  private unsubscribe?: () => void;
  private readonly handoffs = new Map<string, string>();

  constructor(
    private readonly agents: AgentRuntimePort,
    private readonly executions: ExecutionRepository,
    private readonly tasks: TaskLifecycleService,
    private readonly clock: Clock,
    private readonly diagnostics: CoordinatorDiagnostics = silentDiagnostics,
    private readonly plans?: AgentPlanRepository
  ) {}

  start(): void {
    if (this.unsubscribe) return;
    this.unsubscribe = this.agents.subscribe(event => { void this.handle(event); });
  }

  stop(): void {
    this.unsubscribe?.();
    this.unsubscribe = undefined;
    this.handoffs.clear();
  }

  async reconcile(snapshot: AgentRuntimeSnapshot): Promise<void> {
    if (!["completed", "interrupted", "failed"].includes(snapshot.turnStatus)) return;
    const key = `${snapshot.threadId}\0${snapshot.turnId}`;
    if (snapshot.handoff) this.handoffs.set(key, snapshot.handoff);
    await this.handle({
      type: "turnCompleted",
      threadId: snapshot.threadId,
      turnId: snapshot.turnId,
      status: snapshot.turnStatus,
      error: snapshot.error
    });
  }

  private async handle(event: AgentRuntimeEvent): Promise<void> {
    const eventKey = `${event.threadId}\0${event.turnId}`;
    if (event.type === "agentMessageDelta") {
      this.handoffs.set(eventKey, ((this.handoffs.get(eventKey) ?? "") + event.delta).slice(-20_000));
      return;
    }
    if (event.type !== "turnCompleted") return;
    const found = await this.executions.findByAgent(event.threadId, event.turnId);
    if (!found.ok) {
      this.diagnostics.error("Could not resolve completed agent execution.", found.error);
      return;
    }
    if (!found.value || found.value.status !== "running") return;
    if (found.value.agent?.threadId !== event.threadId || found.value.agent.turnId !== event.turnId) return;
    if (found.value.pendingStage) return;
    const success = event.status === "completed";
    const handoff = this.handoffs.get(eventKey);
    this.handoffs.delete(eventKey);
    if (success && this.plans && found.value.stage?.role === "reviewer" && requestsChanges(handoff)) {
      const plan = await this.plans.findByTask(found.value.taskId);
      if (!plan.ok) { await this.failStage(found.value, "agent-plan.load-failed", plan.error); return; }
      const stages = plan.value?.snapshot().stages;
      const implementerIndex = stages?.findIndex(stage => stage.role === "implementer") ?? -1;
      const cycles = found.value.reviewCycles ?? 0;
      if (implementerIndex < 0) { await this.failStage(found.value, "agent-plan.implementer-missing"); return; }
      if (cycles >= MAX_REVIEW_CYCLES) { await this.failStage(found.value, "agent-plan.review-limit"); return; }
      const implementer = stages![implementerIndex];
      await this.startPendingStage(found.value, {
        index: implementerIndex, role: "implementer", objective: implementer.objective,
        handoff, reason: "reviewReturn"
      }, cycles + 1);
      return;
    }
    if (success && this.plans && found.value.stage && found.value.stage.index + 1 < found.value.stage.total) {
      const plan = await this.plans.findByTask(found.value.taskId);
      if (!plan.ok) { await this.failStage(found.value, "agent-plan.load-failed", plan.error); return; }
      const next = plan.value?.snapshot().stages[found.value.stage.index + 1];
      if (!next) { await this.failStage(found.value, "agent-plan.stage-missing"); return; }
      await this.startPendingStage(found.value, {
        index: found.value.stage.index + 1, role: next.role, objective: next.objective,
        handoff, reason: "advance"
      }, found.value.reviewCycles);
      return;
    }
    const updated: TaskExecutionRecord = {
      ...found.value,
      status: success ? "completed" : event.status === "interrupted" ? "cancelled" : "failed",
      stageHistory: closeCurrentStage(found.value.stageHistory, success ? "completed" : event.status === "interrupted" ? "cancelled" : "failed", this.clock.now()),
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
      this.diagnostics.taskChanged?.(found.value.taskId, false);
    }
  }

  private async startPendingStage(
    execution: TaskExecutionRecord,
    pendingStage: PendingAgentStage,
    reviewCycles: number | undefined
  ): Promise<void> {
    const checkpoint: TaskExecutionRecord = {
      ...execution, pendingStage, updatedAt: this.clock.now(), version: execution.version + 1
    };
    const checkpointed = await this.executions.save(checkpoint, execution.version);
    if (!checkpointed.ok) {
      if (checkpointed.error.code === "execution.version-conflict") {
        this.diagnostics.error("Another handler already advanced this agent stage.", checkpointed.error);
        return;
      }
      await this.failStage(execution, "agent-plan.checkpoint-failed", checkpointed.error);
      return;
    }
    let agent;
    try {
      agent = await this.agents.start({
        cwd: checkpoint.workspace.path,
        model: checkpoint.model,
        prompt: pendingStagePrompt(pendingStage)
      });
    } catch (cause) {
      await this.failStage(checkpoint, pendingStage.reason === "reviewReturn"
        ? "agent-plan.review-return-start-failed" : "agent-plan.start-failed", cause);
      return;
    }
    const { pendingStage: _completedCheckpoint, ...checkpointBase } = checkpoint;
    const advanced: TaskExecutionRecord = {
      ...checkpointBase,
      agent,
      previousAgents: [...(checkpoint.previousAgents ?? []), ...(checkpoint.agent ? [checkpoint.agent] : [])].slice(-8),
      stage: { index: pendingStage.index, total: checkpoint.stage?.total ?? pendingStage.index + 1, role: pendingStage.role },
      stageHistory: advanceStageHistory(checkpoint.stageHistory, {
        index: pendingStage.index, total: checkpoint.stage?.total ?? pendingStage.index + 1,
        role: pendingStage.role, agent, startedAt: this.clock.now(), outcome: "running"
      }, this.clock.now()),
      reviewCycles,
      updatedAt: this.clock.now(),
      version: checkpoint.version + 1
    };
    const saved = await this.executions.save(advanced, checkpoint.version);
    if (!saved.ok) {
      try { await this.agents.interrupt(agent); } catch (cause) {
        this.diagnostics.error("Could not interrupt an unpersisted agent stage.", cause);
      }
      if (saved.error.code === "execution.version-conflict") {
        this.diagnostics.error("Another handler already bound the pending agent stage.", saved.error);
        return;
      }
      await this.failStage(checkpoint, pendingStage.reason === "reviewReturn"
        ? "agent-plan.review-return-failed" : "agent-plan.advance-failed", saved.error);
      return;
    }
    this.diagnostics.taskChanged?.(execution.taskId, true);
  }

  private async failStage(execution: TaskExecutionRecord, reason: string, cause?: unknown): Promise<void> {
    const { pendingStage: _pendingStage, ...executionBase } = execution;
    const saved = await this.executions.save({
      ...executionBase, status: "failed", stageHistory: closeCurrentStage(execution.stageHistory, "failed", this.clock.now()), updatedAt: this.clock.now(), version: execution.version + 1
    }, execution.version);
    if (!saved.ok) this.diagnostics.error("Could not persist failed agent stage.", saved.error);
    const transitioned = await this.tasks.transition(execution.taskId, "failed", reason);
    if (!transitioned.ok) this.diagnostics.error("Could not fail task after agent stage error.", transitioned.error);
    else this.diagnostics.taskChanged?.(execution.taskId, false);
    this.diagnostics.error("Agent pipeline stage failed.", cause);
  }
}

function closeCurrentStage(
  history: readonly AgentStageHistoryEntry[] | undefined,
  outcome: AgentStageHistoryEntry["outcome"],
  completedAt: Date
): readonly AgentStageHistoryEntry[] | undefined {
  if (!history?.length) return history;
  return history.map((entry, index) => index === history.length - 1 && entry.outcome === "running"
    ? { ...entry, outcome, completedAt } : entry);
}

function advanceStageHistory(
  history: readonly AgentStageHistoryEntry[] | undefined,
  next: AgentStageHistoryEntry,
  completedAt: Date
): readonly AgentStageHistoryEntry[] {
  const closed = closeCurrentStage(history, "completed", completedAt) ?? [];
  return [...closed, next].slice(-32);
}

function requestsChanges(handoff: string | undefined): boolean {
  return /(?:^|\n)\s*VERDICT:\s*CHANGES_REQUESTED\s*$/im.test(handoff ?? "");
}
