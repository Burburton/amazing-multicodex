export class ExecutionCapacityGate {
  private reservations = 0;

  tryAcquire(activeExecutions: number, limit: number): (() => void) | undefined {
    if (activeExecutions + this.reservations >= limit) return undefined;
    this.reservations += 1;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.reservations -= 1;
    };
  }
}

