import assert from "node:assert/strict";
import test from "node:test";
import { Clock } from "../../../shared/core/clock";
import { IdGenerator } from "../../../shared/core/idGenerator";
import { CommandResult, CommandRunnerPort } from "../../../shared/ports/commandRunner";
import { AgentThreadId, AgentTurnId, ExecutionId } from "../../agents/public";
import { InMemoryTaskRepository } from "../../tasks/adapters/inMemoryTaskRepository";
import { Task, TaskId, TaskLifecycleService } from "../../tasks/public";
import { RunValidationHandler, ValidationCheckId, ValidationProfileId } from "../../validation/public";
import { WorkspaceId } from "../../workspaces/public";
import { InMemoryExecutionRepository } from "../adapters/inMemoryExecutionRepository";
import { TaskExecutionId } from "../ports/executionRepository";
import { ValidateTaskWorkflow } from "./validateTaskWorkflow";

class FixedClock implements Clock { now(): Date { return new Date("2026-08-15T12:00:00Z"); } }
class FixedIds implements IdGenerator { next(): string { return "validation-1"; } }
class PassingCommand implements CommandRunnerPort {
  async run(): Promise<CommandResult> {
    return { exitCode: 0, signal: null, stdout: "ok", stderr: "", truncated: false };
  }
}

test("moves a successfully validated task to ready for review", async () => {
  const clock = new FixedClock();
  const tasks = new InMemoryTaskRepository();
  const task = Task.create({ id: "task-1" as TaskId, title: "Task", now: clock.now() });
  assert.equal(task.ok, true);
  if (!task.ok) return;
  for (const status of ["queued", "preparing", "running", "validating"] as const) {
    task.value.transition(status, clock.now());
  }
  await tasks.save(task.value, -1);
  const executions = new InMemoryExecutionRepository();
  await executions.save({
    id: "execution-1" as TaskExecutionId,
    taskId: "task-1" as TaskId,
    workspace: {
      id: "workspace-1" as WorkspaceId,
      taskId: "task-1" as TaskId,
      repositoryRoot: "/repo",
      worktreeRoot: "/worktrees",
      path: "/worktrees/one",
      branch: "branch",
      baseRef: "main"
    },
    agent: {
      executionId: "agent-1" as ExecutionId,
      threadId: "thread-1" as AgentThreadId,
      turnId: "turn-1" as AgentTurnId
    },
    status: "completed",
    createdAt: clock.now(),
    updatedAt: clock.now(),
    version: 1
  }, -1);
  const workflow = new ValidateTaskWorkflow(
    new TaskLifecycleService(tasks, clock),
    executions,
    new RunValidationHandler(new PassingCommand(), clock, new FixedIds())
  );
  const result = await workflow.execute({
    taskId: "task-1" as TaskId,
    profile: {
      id: "profile" as ValidationProfileId,
      mode: "sequential",
      checks: [{ id: "check" as ValidationCheckId, label: "Check", executable: "check", args: [] }]
    }
  });
  assert.equal(result.ok, true);
  const found = await tasks.findById("task-1" as TaskId);
  assert.equal(found.ok && found.value?.snapshot().status, "readyForReview");
});

test("blocks a validating task when its execution record is missing", async () => {
  const clock = new FixedClock();
  const tasks = new InMemoryTaskRepository();
  const task = Task.create({ id: "task-missing" as TaskId, title: "Task", now: clock.now() });
  assert.equal(task.ok, true);
  if (!task.ok) return;
  for (const status of ["queued", "preparing", "running", "validating"] as const) {
    task.value.transition(status, clock.now());
  }
  await tasks.save(task.value, -1);
  const workflow = new ValidateTaskWorkflow(
    new TaskLifecycleService(tasks, clock),
    new InMemoryExecutionRepository(),
    new RunValidationHandler(new PassingCommand(), clock, new FixedIds())
  );

  const result = await workflow.execute({ taskId: "task-missing" as TaskId, profile: {
    id: "profile" as ValidationProfileId, mode: "sequential", checks: []
  } });

  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.error.code, "execution.not-found");
  const found = await tasks.findById("task-missing" as TaskId);
  assert.equal(found.ok && found.value?.snapshot().status, "blocked");
  if (found.ok && found.value) assert.equal(found.value.snapshot().statusReason, "execution.not-found");
});
