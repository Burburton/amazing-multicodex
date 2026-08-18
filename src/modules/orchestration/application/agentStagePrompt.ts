import { PendingAgentStage } from "../ports/executionRepository";

export function pendingStagePrompt(stage: PendingAgentStage): string {
  return [
    stage.reason === "reviewReturn"
      ? "You are the implementer stage revising work after review."
      : `You are the ${stage.role} stage in a multi-agent task pipeline.`,
    `Stage objective: ${stage.objective}`,
    stage.reason === "reviewReturn"
      ? "Inspect the shared worktree and address every review finding."
      : "Inspect the shared worktree and continue from the previous stage.",
    stage.handoff
      ? `${stage.reason === "reviewReturn" ? "Reviewer feedback" : "Previous stage handoff"}:\n${stage.handoff}`
      : stage.reason === "reviewReturn"
        ? "Changes were requested without textual feedback."
        : "No textual handoff was produced; rely on the worktree and task context.",
    stage.role === "reviewer"
      ? "End your response with exactly one verdict line: VERDICT: APPROVED or VERDICT: CHANGES_REQUESTED. Explain required changes before the verdict."
      : stage.reason === "reviewReturn" ? "Finish with a concise handoff for the reviewer." : ""
  ].filter(Boolean).join("\n\n");
}
