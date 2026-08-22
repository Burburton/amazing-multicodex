import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

for (const version of ["v1", "v2"]) {
  test(`accepts ${version} protocol fixture shapes`, () => {
    const fixture = JSON.parse(readFileSync(join(__dirname, "..", "..", "..", "src", "adapters", "codex-app-server", "fixtures", `protocol-${version}.json`), "utf8")) as {
      version: string; messages: Array<Record<string, unknown>>;
    };
    assert.equal(fixture.version, version);
    assert.equal(fixture.messages.length, 3);
    const methods = fixture.messages.filter(message => typeof message.method === "string").map(message => message.method);
    assert.deepEqual(methods, ["turn/completed", version === "v1" ? "item/commandExecution/requestApproval" : "item/fileChange/requestApproval"]);
    const response = fixture.messages.find(message => message.id !== undefined);
    assert.ok(response && typeof response.result === "object");
  });
}
