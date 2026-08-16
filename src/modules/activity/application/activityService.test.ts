import assert from "node:assert/strict";
import test from "node:test";
import { Clock } from "../../../shared/core/clock";
import { IdGenerator } from "../../../shared/core/idGenerator";
import { ok } from "../../../shared/core/result";
import { TaskId } from "../../tasks/public";
import { NewActivityRecord } from "../domain/activity";
import { ActivityRepository } from "../ports/activityRepository";
import { ActivityService } from "./activityService";

class CapturingRepository implements ActivityRepository {
  record?: NewActivityRecord;
  append(record: NewActivityRecord) {
    this.record = record;
    return Promise.resolve(ok({ ...record, sequence: 1 }));
  }
  listByTask() { return Promise.resolve(ok([])); }
}

class FixedClock implements Clock { now(): Date { return new Date("2026-08-16T12:00:00Z"); } }
class FixedIds implements IdGenerator { next(): string { return "activity-1"; } }

test("bounds individual activity fields before repository persistence", async () => {
  const repository = new CapturingRepository();
  const result = await new ActivityService(repository, new FixedClock(), new FixedIds()).record({
    taskId: "task-1" as TaskId,
    kind: "agentMessage",
    summary: "s".repeat(1_000),
    detail: "d".repeat(250_000)
  });
  assert.equal(result.ok, true);
  assert.equal(repository.record?.summary.length, 500);
  assert.equal(repository.record?.detail?.length, 200_000);
  assert.match(repository.record?.detail ?? "", /truncated/);
});
