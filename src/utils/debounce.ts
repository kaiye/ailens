export class SmartEventDebouncer {
  private timer: NodeJS.Timeout | null = null;
  private pendingEvents = new Set<string>();
  private callback: ((sources: string[]) => void) | null = null;
  private firstTriggerTime: number | null = null;

  constructor(private delay = 300, private maxDelay = 2000) {}

  setCallback(callback: (sources: string[]) => void): void {
    this.callback = callback;
  }

  trigger(eventSource: string): void {
    this.pendingEvents.add(eventSource);
    const now = Date.now();
    if (!this.firstTriggerTime) this.firstTriggerTime = now;

    const elapsed = now - this.firstTriggerTime;
    if (elapsed >= this.maxDelay) {
      this.execute();
      return;
    }
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => this.execute(), this.delay);
  }

  private execute(): void {
    if (this.callback && this.pendingEvents.size > 0) {
      const sources = Array.from(this.pendingEvents);
      this.pendingEvents.clear();
      this.firstTriggerTime = null;
      if (this.timer) {
        clearTimeout(this.timer);
        this.timer = null;
      }
      this.callback(sources);
    }
  }

  clear(): void {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    this.pendingEvents.clear();
    this.firstTriggerTime = null;
  }
}

