import assert from "node:assert/strict";
import test from "node:test";
import { AgentEventListener, AgentThreadId, AgentTurnId } from "../modules/agents/public";
import { TaskId } from "../modules/tasks/public";
import { AgentActivityBridge } from "./agentActivityBridge";

test("bounds buffered turns and clears them when stopped", () => {
  let listener: AgentEventListener | undefined;
  const agents = {
    subscribe: (candidate: AgentEventListener) => {
      listener = candidate;
      return () => { listener = undefined; };
    }
  };
  const bridge = new AgentActivityBridge(
    agents as never,
    {} as never,
    {} as never,
    100,
    { error: () => undefined },
    2
  );
  bridge.start();
  for (const id of ["one", "two", "three"]) {
    listener?.({
      type: "agentMessageDelta",
      threadId: id as AgentThreadId,
      turnId: id as AgentTurnId,
      delta: id
    });
  }
  const buffers = (bridge as unknown as { messageBuffers: Map<string, string> }).messageBuffers;
  assert.equal(buffers.size, 2);
  assert.equal(buffers.has("one:one"), false);
  bridge.stop();
  assert.equal(buffers.size, 0);
});

test("notifies the host after terminal activity is persisted", async () => {
  let listener: AgentEventListener | undefined;
  const agents = {
    subscribe: (candidate: AgentEventListener) => {
      listener = candidate;
      return () => { listener = undefined; };
    }
  };
  const taskId = "task-1" as TaskId;
  const changed: TaskId[] = [];
  const summaries: string[] = [];
  const bridge = new AgentActivityBridge(
    agents as never,
    { findByAgent: async () => ({ ok: true, value: { taskId, agent: { threadId: "thread", turnId: "turn" }, stage: { role: "reviewer", index: 1, total: 2 } } }) } as never,
    { record: async (command: { summary: string }) => { summaries.push(command.summary); return { ok: true, value: {} }; } } as never,
    100,
    { error: () => undefined, activityRecorded: id => changed.push(id) }
  );
  bridge.start();
  listener?.({
    type: "turnCompleted",
    threadId: "thread" as AgentThreadId,
    turnId: "turn" as AgentTurnId,
    status: "completed"
  });
  await new Promise(resolve => setImmediate(resolve));

  assert.deepEqual(changed, [taskId]);
  assert.deepEqual(summaries, ["Reviewer turn completed"]);
});
