// A single bounded queue keeps progress and interruption behavior consistent.
export class TaskQueue {
  constructor(onChange = () => {}) { this.onChange = onChange; this.paused = false; this.stopped = false; }
  pause() { this.paused = true; this.onChange(); }
  resume() { this.paused = false; this.wake?.(); this.onChange(); }
  stop() { this.stopped = true; this.resume(); }
  async run(items, process, onResult) {
    let done = 0;
    for (const item of items) {
      if (this.paused) await new Promise((resolve) => { this.wake = resolve; });
      this.wake = null;
      if (this.stopped) break;
      const result = await process(item, done);
      if (this.stopped && result === undefined) break;
      await onResult(result, item, ++done);
      // Yield to drawing and user input between every question.
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
    return { done, stopped: this.stopped };
  }
}
