import assert from "node:assert/strict";
import test from "node:test";
import { AgentRuntimeEvent } from "../../modules/agents/public";
import { CodexAppServerClient } from "./codexAppServerClient";
import { JsonRpcMessage, JsonRpcPeer, JsonRpcTransport } from "./jsonRpc";

class RecordingTransport implements JsonRpcTransport {
  readonly messages: JsonRpcMessage[] = [];
  send(message: JsonRpcMessage): void { this.messages.push(message); }
}

function latestRequest(transport: RecordingTransport): { id: number | string; method: string } {
  const message = transport.messages.at(-1);
  assert.ok(message && "id" in message && "method" in message);
  return message;
}

async function initializedClient(): Promise<{
  client: CodexAppServerClient;
  peer: JsonRpcPeer;
  transport: RecordingTransport;
}> {
  const transport = new RecordingTransport();
  const peer = new JsonRpcPeer(transport);
  const client = new CodexAppServerClient(peer);
  const initialization = client.initialize();
  const request = latestRequest(transport);
  peer.receive({ id: request.id, result: { userAgent: "codex-test" } });
  await initialization;
  return { client, peer, transport };
}

test("performs the required initialize handshake once", async () => {
  const { client, transport } = await initializedClient();
  assert.deepEqual(transport.messages[0], {
    id: 1,
    method: "initialize",
    params: {
      clientInfo: {
        name: "amazing_multicodex",
        title: "Amazing MultiCodex",
        version: "0.1.0"
      }
    }
  });
  assert.deepEqual(transport.messages[1], { method: "initialized", params: {} });
  assert.deepEqual(client.health(), { status: "ready", userAgent: "codex-test" });
  await client.initialize();
  assert.equal(transport.messages.length, 2);
});

test("starts a thread followed by a turn", async () => {
  const { client, peer, transport } = await initializedClient();
  const started = client.start({ prompt: "Implement it", cwd: "/repo", model: "model-a" });
  let request = latestRequest(transport);
  assert.equal(request.method, "thread/start");
  peer.receive({ id: request.id, result: { thread: { id: "thread-1" } } });
  await new Promise(resolve => setImmediate(resolve));
  request = latestRequest(transport);
  assert.equal(request.method, "turn/start");
  peer.receive({ id: request.id, result: { turn: { id: "turn-1" } } });
  assert.deepEqual(await started, {
    executionId: "thread-1:turn-1:1",
    threadId: "thread-1",
    turnId: "turn-1"
  });
});

test("normalizes streamed notifications", async () => {
  const { client, peer } = await initializedClient();
  const events: AgentRuntimeEvent[] = [];
  client.subscribe(event => events.push(event));
  peer.receive({
    method: "item/agentMessage/delta",
    params: { threadId: "thread-1", turnId: "turn-1", delta: "hello" }
  });
  peer.receive({
    method: "turn/completed",
    params: { threadId: "thread-1", turn: { id: "turn-1", status: "completed" } }
  });
  assert.equal(events[0].type, "agentMessageDelta");
  assert.equal(events[1].type, "turnCompleted");
});

test("bridges server approval requests to the registered handler", async () => {
  const { client, peer, transport } = await initializedClient();
  client.handleApprovals(async request => ({ decision: request.method === "item/fileChange/requestApproval" ? "accept" : "decline" }));
  peer.receive({
    id: 77,
    method: "item/fileChange/requestApproval",
    params: { threadId: "thread-1", turnId: "turn-1", reason: "edit" }
  });
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(transport.messages.at(-1), { id: 77, result: { decision: "accept" } });
});

