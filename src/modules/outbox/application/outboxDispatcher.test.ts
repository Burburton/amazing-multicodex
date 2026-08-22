import assert from "node:assert/strict";
import test from "node:test";
import { Clock } from "../../../shared/core/clock";
import { IdGenerator } from "../../../shared/core/idGenerator";
import { InMemoryOutboxRepository } from "../adapters/inMemoryOutboxRepository";
import { OutboxDispatcher } from "./outboxDispatcher";
import { OutboxService } from "./outboxService";

class ClockStub implements Clock { now(): Date { return new Date("2026-08-21T00:00:00Z"); } }
class IdStub implements IdGenerator { private n = 0; next(): string { return `event-${++this.n}`; } }

test("dispatcher drains persisted events and can be stopped", async () => {
  const service = new OutboxService(new InMemoryOutboxRepository(), new ClockStub(), new IdStub());
  await service.publish({ aggregateType: "task", aggregateId: "task-1", eventType: "changed", payload: {} });
  const received: string[] = [];
  const dispatcher = new OutboxDispatcher(service, async event => { received.push(event.id); }, { intervalMs: 250 });
  assert.equal(await dispatcher.dispatch(), 1);
  assert.deepEqual(received, ["event-1"]);
  dispatcher.start();
  dispatcher.stop();
});
