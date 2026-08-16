export class CoalescingAsyncRunner<T> {
  private running?: Promise<void>;
  private pending!: T;
  private hasPending = false;

  constructor(
    private readonly operation: (value: T) => Promise<void>,
    private readonly merge: (current: T, incoming: T) => T
  ) {}

  run(value: T): Promise<void> {
    this.pending = this.hasPending ? this.merge(this.pending, value) : value;
    this.hasPending = true;
    if (!this.running) this.running = this.drain().finally(() => { this.running = undefined; });
    return this.running;
  }

  private async drain(): Promise<void> {
    try {
      while (this.hasPending) {
        const value = this.pending;
        this.hasPending = false;
        await this.operation(value);
      }
    } catch (cause) {
      this.hasPending = false;
      throw cause;
    }
  }
}
