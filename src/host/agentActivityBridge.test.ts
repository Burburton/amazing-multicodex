import assert from "node:assert/strict";
import test from "node:test";
import { AgentEventListener, AgentThreadId, AgentTurnId } from "../modules/agents/public";
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
