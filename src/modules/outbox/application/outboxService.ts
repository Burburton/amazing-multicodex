import { Clock } from "../../../shared/core/clock";
import { IdGenerator } from "../../../shared/core/idGenerator";
import { Result } from "../../../shared/core/result";
import { OutboxEvent, OutboxRepository } from "../ports/outboxRepository";

export interface PublishOutboxEvent {
  readonly aggregateType: string;
  readonly aggregateId: string;
  readonly eventType: string;
  readonly payload: unknown;
}

export class OutboxService {
  constructor(private readonly repository: OutboxRepository, private readonly clock: Clock, private readonly ids: IdGenerator) {}

  async publish(input: PublishOutboxEvent): Promise<Result<void>> {
    const event: OutboxEvent = { ...input, id: this.ids.next(), createdAt: this.clock.now() };
    return this.repository.append(event);
  }

  async deliver(limit: number, handler: (event: OutboxEvent) => Promise<void>): Promise<Result<number>> {
    const pending = await this.repository.listPending(Math.max(1, Math.min(100, Math.floor(limit))));
    if (!pending.ok) return pending;
    let delivered = 0;
    for (const event of pending.value) {
      try {
        await handler(event);
        const marked = await this.repository.markDelivered(event.id, this.clock.now());
        if (!marked.ok) return marked;
        delivered++;
      } catch {
        break;
      }
    }
    return { ok: true, value: delivered };
  }
}
