import { Result, err, ok } from "../../../shared/core/result";
import { OutboxEvent, OutboxRepository } from "../ports/outboxRepository";

export class InMemoryOutboxRepository implements OutboxRepository {
  private readonly events: OutboxEvent[] = [];
  async append(event: OutboxEvent): Promise<Result<void>> {
    if (this.events.some(item => item.id === event.id)) return err({ code: "outbox.duplicate", category: "conflict", message: "Outbox event already exists.", retryable: false });
    this.events.push({ ...event });
    return ok(undefined);
  }
  async listPending(limit: number): Promise<Result<readonly OutboxEvent[]>> {
    return ok(this.events.filter(event => !event.deliveredAt).slice(0, Math.max(0, limit)).map(event => ({ ...event })));
  }
  async markDelivered(id: string, deliveredAt: Date): Promise<Result<void>> {
    const index = this.events.findIndex(event => event.id === id);
    if (index < 0) return err({ code: "outbox.not-found", category: "validation", message: "Outbox event was not found.", retryable: false });
    this.events[index] = { ...this.events[index], deliveredAt };
    return ok(undefined);
  }
}
