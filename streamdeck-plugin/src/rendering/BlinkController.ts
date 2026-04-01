const PULSE_STEP_MS = 50; // ~20fps

export class BlinkController {
  private timer: ReturnType<typeof setInterval> | null = null;
  private toggleState = false;
  private phase = 0;

  isBlinking(): boolean {
    return this.timer !== null;
  }

  /**
   * Hard blink: alternates boolean on/off at intervalMs.
   */
  start(intervalMs: number, onToggle: (isOn: boolean) => void): void {
    this.stop();
    this.toggleState = false;

    this.timer = setInterval(() => {
      this.toggleState = !this.toggleState;
      onToggle(this.toggleState);
    }, intervalMs);
  }

  /**
   * Soft pulse: emits a 0-1 brightness value using a sine wave.
   * Full cycle takes `cycleMs` milliseconds.
   */
  startPulse(cycleMs: number, onBrightness: (brightness: number) => void): void {
    this.stop();
    this.phase = 0;
    const step = (PULSE_STEP_MS / cycleMs) * Math.PI * 2;

    this.timer = setInterval(() => {
      this.phase += step;
      if (this.phase > Math.PI * 2) this.phase -= Math.PI * 2;
      // Sine wave mapped from [-1,1] to [0.15, 1] — never fully dark
      const brightness = 0.15 + 0.85 * ((Math.sin(this.phase) + 1) / 2);
      onBrightness(brightness);
    }, PULSE_STEP_MS);
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    this.toggleState = false;
    this.phase = 0;
  }
}
