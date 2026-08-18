import { AppError, Result, err, ok } from "../../../shared/core/result";
import { TaskId } from "../../tasks/public";

export type AgentRole = "planner" | "implementer" | "reviewer" | "tester";
export interface AgentStage { readonly role: AgentRole; readonly objective: string }
export interface AgentPlanProps { readonly taskId: TaskId; readonly stages: readonly AgentStage[]; readonly updatedAt: Date }

const roles = new Set<AgentRole>(["planner", "implementer", "reviewer", "tester"]);

export class AgentPlan {
  private constructor(private readonly props: AgentPlanProps) {}
  static create(props: AgentPlanProps): Result<AgentPlan> {
    if (props.stages.length < 1 || props.stages.length > 8) return err(planError("agent-plan.stage-count", "An agent plan must contain 1 to 8 stages."));
    const stages = props.stages.map(stage => ({ role: stage.role, objective: stage.objective.trim() }));
    if (stages.some(stage => !roles.has(stage.role) || !stage.objective || stage.objective.length > 2_000)) {
      return err(planError("agent-plan.stage-invalid", "Every agent stage needs a valid role and an objective of at most 2,000 characters."));
    }
    if (new Set(stages.map(stage => stage.role)).size !== stages.length) return err(planError("agent-plan.role-duplicate", "Each role can appear only once in an agent plan."));
    if (!stages.some(stage => stage.role === "implementer")) return err(planError("agent-plan.implementer-required", "An agent plan must include an implementer."));
    return ok(new AgentPlan({ ...props, stages }));
  }
  static restore(props: AgentPlanProps): AgentPlan { return new AgentPlan({ ...props, stages: props.stages.map(stage => ({ ...stage })) }); }
  snapshot(): AgentPlanProps { return { ...this.props, stages: this.props.stages.map(stage => ({ ...stage })) }; }
}

export function agentPlanTemplate(template: "solo" | "delivery" | "reviewed" | "full"): readonly AgentStage[] {
  const stages: Record<string, readonly AgentStage[]> = {
    solo: [{ role: "implementer", objective: "Implement the task and satisfy its acceptance criteria." }],
    delivery: [{ role: "planner", objective: "Analyze the task and produce an implementation plan." }, { role: "implementer", objective: "Implement the approved plan." }],
    reviewed: [{ role: "implementer", objective: "Implement the task." }, { role: "reviewer", objective: "Review correctness, maintainability, and risk; request fixes when needed." }],
    full: [{ role: "planner", objective: "Analyze constraints and produce an implementation plan." }, { role: "implementer", objective: "Implement the plan." }, { role: "reviewer", objective: "Review the implementation and identify required fixes." }, { role: "tester", objective: "Validate acceptance criteria and report evidence." }]
  };
  return stages[template].map(stage => ({ ...stage }));
}

function planError(code: string, message: string): AppError { return { code, category: "validation", message, retryable: false }; }
