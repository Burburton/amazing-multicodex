import assert from "node:assert/strict";
import test from "node:test";
import { JsonRpcMessage, JsonRpcPeer, JsonRpcTransport } from "./jsonRpc";

class RecordingTransport implements JsonRpcTransport {
  readonly messages: JsonRpcMessage[] = [];
  send(message: JsonRpcMessage): void { this.messages.push(message); }
}

test("correlates responses with requests", async () => {
  const transport = new RecordingTransport();
  const peer = new JsonRpcPeer(transport);
  const response = peer.request<{ value: number }>("demo", { input: true });
  const request = transport.messages[0];
  assert.ok("id" in request);
  peer.receive({ id: request.id, result: { value: 42 } });
  assert.deepEqual(await response, { value: 42 });
});

test("maps protocol failures to typed errors", async () => {
  const transport = new RecordingTransport();
  const peer = new JsonRpcPeer(transport);
  const response = peer.request("demo");
  const request = transport.messages[0];
  assert.ok("id" in request);
  peer.receive({ id: request.id, error: { code: -32001, message: "Server overloaded" } });
  await assert.rejects(response, error => {
    const typed = error as { code: string; retryable: boolean };
    return typed.code === "codex.rpc-error" && typed.retryable;
  });
});

test("dispatches notifications and supports unsubscription", () => {
  const transport = new RecordingTransport();
  const peer = new JsonRpcPeer(transport);
  const received: unknown[] = [];
  const unsubscribe = peer.onNotification("turn/started", params => received.push(params));
  peer.receive({ method: "turn/started", params: { id: "turn-1" } });
  unsubscribe();
  peer.receive({ method: "turn/started", params: { id: "turn-2" } });
  assert.deepEqual(received, [{ id: "turn-1" }]);
});

test("isolates notification subscribers from each other", () => {
  const peer = new JsonRpcPeer(new RecordingTransport());
  const received: unknown[] = [];
  peer.onNotification("turn/started", () => { throw new Error("observer failed"); });
  peer.onNotification("turn/started", params => received.push(params));
  peer.receive({ method: "turn/started", params: { id: "turn-1" } });
  assert.deepEqual(received, [{ id: "turn-1" }]);
});

test("answers supported and unsupported server requests", async () => {
  const transport = new RecordingTransport();
  const peer = new JsonRpcPeer(transport);
  peer.handleServerRequest("approval/request", async params => ({ decision: params }));
  peer.receive({ id: 8, method: "approval/request", params: "allow" });
  peer.receive({ id: 9, method: "unknown/request" });
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(transport.messages[0], { id: 9, error: { code: -32601, message: "Unsupported server request: unknown/request" } });
  assert.deepEqual(transport.messages[1], { id: 8, result: { decision: "allow" } });
});

test("rejects pending requests when connection closes", async () => {
  const peer = new JsonRpcPeer(new RecordingTransport());
  const response = peer.request("thread/start");
  peer.close(new Error("gone"));
  await assert.rejects(response, error => (error as { code: string }).code === "codex.connection-lost");
});

test("drops a delayed server response after the connection closes", async () => {
  const transport = new RecordingTransport();
  const peer = new JsonRpcPeer(transport);
  let finish!: (value: unknown) => void;
  peer.handleServerRequest("approval/request", () => new Promise(resolve => { finish = resolve; }));
  peer.receive({ id: 10, method: "approval/request", params: {} });
  peer.close();
  finish({ decision: "accept" });
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(transport.messages, []);
});
