import type { DraftOffClock } from '../../src/draftOffRoomTypes';

/** Native alarms are persisted by the repository, never by in-memory callback registration. */
export class DurableDraftOffClock implements DraftOffClock {
  private task?: { atMs: number; callback: () => void | Promise<void> };
  constructor(private readonly readNow: () => number = Date.now) {}
  nowMs() { return this.readNow(); }
  scheduleAt(atMs: number, callback: () => void | Promise<void>) {
    const task = { atMs, callback };
    this.task = task;
    return { cancel: () => { if (this.task === task) this.task = undefined; } };
  }
  async deliverDue(): Promise<boolean> {
    const task = this.task;
    if (!task || this.nowMs() < task.atMs) return false;
    this.task = undefined;
    await task.callback();
    return true;
  }
}
