import { OutboxEvent } from "../ports/outboxRepository";
import { OutboxService } from "./outboxService";

export interface OutboxDispatcherOptions {
  readonly batchSize?: number;
  readonly intervalMs?: number;
}

export class OutboxDispatcher {
  private timer?: ReturnType<typeof setInterval>;
  private running = false;
  constructor(private readonly service: OutboxService, private readonly handler: (event: OutboxEvent) => Promise<void>, private readonly options: OutboxDispatcherOptions = {}) {}

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => { void this.dispatch(); }, Math.max(250, this.options.intervalMs ?? 2_000));
    void this.dispatch();
  }
  stop(): void { if (this.timer) clearInterval(this.timer); this.timer = undefined; }
  async dispatch(): Promise<number> {
    if (this.running) return 0;
    this.running = true;
    try { const result = await this.service.deliver(this.options.batchSize ?? 25, this.handler); return result.ok ? result.value : 0; }
    finally { this.running = false; }
  }
}
