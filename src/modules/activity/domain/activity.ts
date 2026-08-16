import { Brand } from "../../../shared/core/brand";
import { TaskId } from "../../tasks/public";

export type ActivityId = Brand<string, "ActivityId">;
export type ActivityKind = "agentMessage" | "tool" | "approval" | "validation" | "lifecycle" | "error";

export interface ActivityRecord {
  readonly id: ActivityId;
  readonly taskId: TaskId;
  readonly kind: ActivityKind;
  readonly summary: string;
  readonly detail?: string;
  readonly occurredAt: Date;
  readonly sequence: number;
}

export interface NewActivityRecord extends Omit<ActivityRecord, "sequence"> {}

