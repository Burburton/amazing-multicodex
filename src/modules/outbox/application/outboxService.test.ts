import assert from "node:assert/strict";
import test from "node:test";
import { Clock } from "../../../shared/core/clock";
import { IdGenerator } from "../../../shared/core/idGenerator";
import { InMemoryOutboxRepository } from "../adapters/inMemoryOutboxRepository";
import { OutboxService } from "./outboxService";

class FixedClock implements Clock { now(): Date { return new Date("2026-08-21T12:00:00Z"); } }
class FixedIds implements IdGenerator { next(): string { return "event-1"; } }

test("publishes and delivers an outbox event exactly once", async () => {
  const service = new OutboxService(new InMemoryOutboxRepository(), new FixedClock(), new FixedIds());
  assert.equal((await service.publish({ aggregateType: "task", aggregateId: "task-1", eventType: "task.changed", payload: { status: "running" } })).ok, true);
  const received: string[] = [];
  const delivered = await service.deliver(10, async event => { received.push(event.id); });
  assert.equal(delivered.ok && delivered.value, 1);
  assert.deepEqual(received, ["event-1"]);
  const again = await service.deliver(10, async event => { received.push(event.id); });
  assert.equal(again.ok && again.value, 0);
});
