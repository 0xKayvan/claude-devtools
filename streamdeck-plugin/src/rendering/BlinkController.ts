export class BlinkController {
  private timer: ReturnType<typeof setInterval> | null = null;
  private toggleState = false;

  isBlinking(): boolean {
    return this.timer !== null;
  }

  start(intervalMs: number, onToggle: (isOn: boolean) => void): void {
    this.stop();
    this.toggleState = false;

    this.timer = setInterval(() => {
      this.toggleState = !this.toggleState;
      onToggle(this.toggleState);
    }, intervalMs);
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    this.toggleState = false;
  }
}
