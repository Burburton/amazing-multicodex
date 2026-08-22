import { Result } from "../../../shared/core/result";

export interface OutboxEvent {
  readonly id: string;
  readonly aggregateType: string;
  readonly aggregateId: string;
  readonly eventType: string;
  readonly payload: unknown;
  readonly createdAt: Date;
  readonly deliveredAt?: Date;
}

export interface OutboxRepository {
  append(event: OutboxEvent): Promise<Result<void>>;
  listPending(limit: number): Promise<Result<readonly OutboxEvent[]>>;
  markDelivered(id: string, deliveredAt: Date): Promise<Result<void>>;
}
