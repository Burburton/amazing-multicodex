import { AgentPlan, AgentPlanProps, AgentPlanRepository, AgentRole } from "../../modules/agents/public";
import { TaskId } from "../../modules/tasks/public";
import { AppError, Result, err, ok } from "../../shared/core/result";
import { AsyncOperationQueue } from "../../shared/core/asyncOperationQueue";
import { KeyValueState } from "../../shared/ports/keyValueState";

interface StoredPlan extends Omit<AgentPlanProps, "updatedAt"> { readonly updatedAt: string }
const STORAGE_KEY = "amazingMultiCodex.agentPlans.v1";
const MAX_PLANS = 10_000;

export class MementoAgentPlanRepository implements AgentPlanRepository {
  private readonly writes = new AsyncOperationQueue();
  constructor(private readonly state: KeyValueState) {}
  async findByTask(taskId: TaskId): Promise<Result<AgentPlan | undefined>> {
    const records = this.records();
    if (!records.ok) return records;
    const found = records.value.find(record => record.taskId === taskId);
    return ok(found ? AgentPlan.restore(toProps(found)) : undefined);
  }
  async save(plan: AgentPlan): Promise<Result<void>> {
    return this.writes.run(async () => {
      const records = this.records();
      if (!records.ok) return records;
      const stored = toStored(plan.snapshot());
      if (!isStoredPlan(stored)) return err(invalidState());
      const index = records.value.findIndex(record => record.taskId === stored.taskId);
      if (index < 0) {
        if (records.value.length >= MAX_PLANS) return err(invalidState("Agent plan capacity has been reached."));
        records.value.push(stored);
      } else records.value[index] = stored;
      try { await this.state.update(STORAGE_KEY, records.value); return ok(undefined); }
      catch (cause) { return err(persistenceError(cause)); }
    });
  }
  async deleteByTask(taskId: TaskId): Promise<Result<void>> {
    return this.writes.run(async () => {
      const records = this.records();
      if (!records.ok) return records;
      try { await this.state.update(STORAGE_KEY, records.value.filter(record => record.taskId !== taskId)); return ok(undefined); }
      catch (cause) { return err(persistenceError(cause)); }
    });
  }
  private records(): Result<StoredPlan[]> {
    try {
      const value = this.state.get<unknown>(STORAGE_KEY, []);
      if (!Array.isArray(value) || value.length > MAX_PLANS || !value.every(isStoredPlan) || new Set(value.map(item => item.taskId)).size !== value.length) return err(invalidState());
      return ok([...value]);
    } catch (cause) { return err(persistenceError(cause)); }
  }
}
const validRoles = new Set<AgentRole>(["planner", "implementer", "reviewer", "tester"]);
function isStoredPlan(value: unknown): value is StoredPlan {
  if (!value || typeof value !== "object") return false;
  const item = value as Record<string, unknown>;
  const stages = item.stages as Array<{ role: AgentRole; objective: string }> | undefined;
  return typeof item.taskId === "string" && item.taskId.length > 0 && item.taskId.length <= 1_000
    && Array.isArray(item.stages) && item.stages.length >= 1 && item.stages.length <= 8
    && item.stages.every(stage => !!stage && typeof stage === "object" && validRoles.has((stage as { role: AgentRole }).role)
      && typeof (stage as { objective: unknown }).objective === "string" && (stage as { objective: string }).objective.length > 0 && (stage as { objective: string }).objective.length <= 2_000)
    && new Set(stages?.map(stage => stage.role)).size === stages?.length && stages?.some(stage => stage.role === "implementer") === true
    && typeof item.updatedAt === "string" && !Number.isNaN(Date.parse(item.updatedAt));
}
function toStored(props: AgentPlanProps): StoredPlan { return { ...props, updatedAt: props.updatedAt.toISOString() }; }
function toProps(record: StoredPlan): AgentPlanProps { return { ...record, taskId: record.taskId as TaskId, updatedAt: new Date(record.updatedAt) }; }
function invalidState(message = "Stored agent plans are invalid."): AppError { return { code: "agent-plan.state-invalid", category: "validation", message, retryable: false }; }
function persistenceError(cause: unknown): AppError { return { code: "agent-plan.persistence-failed", category: "unavailable", message: "Agent plans could not be persisted.", retryable: true, cause }; }
