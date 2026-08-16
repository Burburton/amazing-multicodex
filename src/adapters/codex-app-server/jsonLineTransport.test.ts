import assert from "node:assert/strict";
import test from "node:test";
import { PassThrough } from "node:stream";
import { JsonRpcMessage } from "./jsonRpc";
import { JsonLineTransport } from "./jsonLineTransport";

test("reads and writes newline-delimited protocol messages", async () => {
  const input = new PassThrough();
  const output = new PassThrough();
  const received: JsonRpcMessage[] = [];
  const malformed: string[] = [];
  const transport = new JsonLineTransport(input, output, {
    onMessage: message => received.push(message),
    onMalformedLine: line => malformed.push(line)
  });
  let written = "";
  output.on("data", chunk => { written += chunk.toString(); });

  input.write('{"method":"turn/started","params":{"id":"1"}}\n');
  input.write("not-json\n");
  input.write('{"id":2,"error":{"message":"missing code"}}\n');
  input.write('{"result":"missing id"}\n');
  transport.send({ id: 4, method: "thread/start", params: {} });
  await new Promise(resolve => setImmediate(resolve));

  assert.deepEqual(received, [{ method: "turn/started", params: { id: "1" } }]);
  assert.deepEqual(malformed, [
    "not-json",
    '{"id":2,"error":{"message":"missing code"}}',
    '{"result":"missing id"}'
  ]);
  assert.equal(written, '{"id":4,"method":"thread/start","params":{}}\n');
  transport.dispose();
});
