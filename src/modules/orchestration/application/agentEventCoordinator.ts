import { Clock } from "../../../shared/core/clock";
import { AgentPlanRepository, AgentRuntimeEvent, AgentRuntimePort } from "../../agents/public";
import { TaskLifecycleService } from "../../tasks/public";
import { ExecutionRepository, TaskExecutionRecord } from "../ports/executionRepository";

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
      try {
        const agent = await this.agents.start({
          cwd: found.value.workspace.path, model: found.value.model,
          prompt: ["You are the implementer stage revising work after review.", `Stage objective: ${implementer.objective}`,
            "Inspect the shared worktree and address every review finding.", `Reviewer feedback:\n${handoff ?? "Changes were requested without textual feedback."}`,
            "Finish with a concise handoff for the reviewer."].join("\n\n")
        });
        const revised: TaskExecutionRecord = {
          ...found.value, agent,
          previousAgents: [...(found.value.previousAgents ?? []), found.value.agent].slice(-8),
          stage: { index: implementerIndex, total: found.value.stage.total, role: "implementer" },
          reviewCycles: cycles + 1, updatedAt: this.clock.now(), version: found.value.version + 1
        };
        const saved = await this.executions.save(revised, found.value.version);
        if (!saved.ok) { await this.agents.interrupt(agent); await this.failStage(found.value, "agent-plan.review-return-failed", saved.error); return; }
        this.diagnostics.taskChanged?.(found.value.taskId, true);
        return;
      } catch (cause) { await this.failStage(found.value, "agent-plan.review-return-start-failed", cause); return; }
    }
    if (success && this.plans && found.value.stage && found.value.stage.index + 1 < found.value.stage.total) {
      const plan = await this.plans.findByTask(found.value.taskId);
      if (!plan.ok) { await this.failStage(found.value, "agent-plan.load-failed", plan.error); return; }
      const next = plan.value?.snapshot().stages[found.value.stage.index + 1];
      if (!next) { await this.failStage(found.value, "agent-plan.stage-missing"); return; }
      try {
        const agent = await this.agents.start({
          cwd: found.value.workspace.path,
          model: found.value.model,
          prompt: [`You are the ${next.role} stage in a multi-agent task pipeline.`, `Stage objective: ${next.objective}`,
            "Inspect the shared worktree and continue from the previous stage.", handoff ? `Previous stage handoff:\n${handoff}` : "No textual handoff was produced; rely on the worktree and task context.",
            next.role === "reviewer" ? "End your response with exactly one verdict line: VERDICT: APPROVED or VERDICT: CHANGES_REQUESTED. Explain required changes before the verdict." : ""].filter(Boolean).join("\n\n")
        });
        const advanced: TaskExecutionRecord = {
          ...found.value, agent,
          previousAgents: [...(found.value.previousAgents ?? []), found.value.agent].slice(-8),
          stage: { index: found.value.stage.index + 1, total: found.value.stage.total, role: next.role },
          updatedAt: this.clock.now(), version: found.value.version + 1
        };
        const saved = await this.executions.save(advanced, found.value.version);
        if (!saved.ok) { await this.agents.interrupt(agent); await this.failStage(found.value, "agent-plan.advance-failed", saved.error); return; }
        this.diagnostics.taskChanged?.(found.value.taskId, true);
        return;
      } catch (cause) {
        await this.failStage(found.value, "agent-plan.start-failed", cause);
        return;
      }
    }
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
      this.diagnostics.taskChanged?.(found.value.taskId, false);
    }
  }

  private async failStage(execution: TaskExecutionRecord, reason: string, cause?: unknown): Promise<void> {
    const saved = await this.executions.save({
      ...execution, status: "failed", updatedAt: this.clock.now(), version: execution.version + 1
    }, execution.version);
    if (!saved.ok) this.diagnostics.error("Could not persist failed agent stage.", saved.error);
    const transitioned = await this.tasks.transition(execution.taskId, "failed", reason);
    if (!transitioned.ok) this.diagnostics.error("Could not fail task after agent stage error.", transitioned.error);
    else this.diagnostics.taskChanged?.(execution.taskId, false);
    this.diagnostics.error("Agent pipeline stage failed.", cause);
  }
}

function requestsChanges(handoff: string | undefined): boolean {
  return /(?:^|\n)\s*VERDICT:\s*CHANGES_REQUESTED\s*$/im.test(handoff ?? "");
}
