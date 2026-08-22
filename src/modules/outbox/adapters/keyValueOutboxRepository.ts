import { Result, err, ok } from "../../../shared/core/result";
import { KeyValueState } from "../../../shared/ports/keyValueState";
import { OutboxEvent, OutboxRepository } from "../ports/outboxRepository";

interface StoredOutboxEvent extends Omit<OutboxEvent, "createdAt" | "deliveredAt"> {
  readonly createdAt: string;
  readonly deliveredAt?: string;
}

const STORAGE_KEY = "amazingMultiCodex.outbox.v1";

export class KeyValueOutboxRepository implements OutboxRepository {
  constructor(private readonly state: KeyValueState) {}

  async append(event: OutboxEvent): Promise<Result<void>> {
    const records = this.records();
    if (records.some(item => item.id === event.id)) return err({ code: "outbox.duplicate", category: "conflict", message: "Outbox event already exists.", retryable: false });
    records.push(toStored(event));
    await this.state.update(STORAGE_KEY, records);
    return ok(undefined);
  }

  async listPending(limit: number): Promise<Result<readonly OutboxEvent[]>> {
    return ok(this.records().filter(item => !item.deliveredAt).slice(0, Math.max(0, limit)).map(toDomain));
  }

  async markDelivered(id: string, deliveredAt: Date): Promise<Result<void>> {
    const records = this.records();
    const index = records.findIndex(item => item.id === id);
    if (index < 0) return err({ code: "outbox.not-found", category: "validation", message: "Outbox event was not found.", retryable: false });
    records[index] = { ...records[index], deliveredAt: deliveredAt.toISOString() };
    await this.state.update(STORAGE_KEY, records);
    return ok(undefined);
  }

  private records(): StoredOutboxEvent[] {
    const raw = this.state.get<unknown>(STORAGE_KEY, []);
    if (!Array.isArray(raw)) return [];
    return raw.filter(isStored).map(item => ({ ...item }));
  }
}

function isStored(value: unknown): value is StoredOutboxEvent {
  if (!value || typeof value !== "object") return false;
  const item = value as Record<string, unknown>;
  return typeof item.id === "string" && typeof item.aggregateType === "string" && typeof item.aggregateId === "string"
    && typeof item.eventType === "string" && typeof item.createdAt === "string" && !Number.isNaN(Date.parse(item.createdAt));
}
function toStored(event: OutboxEvent): StoredOutboxEvent { return { ...event, createdAt: event.createdAt.toISOString(), deliveredAt: event.deliveredAt?.toISOString() }; }
function toDomain(event: StoredOutboxEvent): OutboxEvent { return { ...event, createdAt: new Date(event.createdAt), deliveredAt: event.deliveredAt ? new Date(event.deliveredAt) : undefined }; }
