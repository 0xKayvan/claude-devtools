import type { StateTransport, ActionResult } from './StateTransport.js';
import type { SessionState } from '../config/defaults.js';

const POLL_INTERVAL_MS = 2000;
const RECONNECT_DELAY_MS = 5000;

/**
 * HTTP polling transport. Polls /api/streamdeck/state at a fixed interval.
 * Simple and reliable — works in all Node.js runtimes including StreamDeck's.
 */
export class SseTransport implements StateTransport {
  private connected = false;
  private pollTimer: ReturnType<typeof setInterval> | null = null;
  private baseUrl = '';
  private stateCallbacks: ((sessions: SessionState[]) => void)[] = [];
  private connectionCallbacks: ((connected: boolean) => void)[] = [];

  connect(url: string): void {
    this.baseUrl = url;
    this.startPolling();
  }

  disconnect(): void {
    this.stopPolling();
    this.setConnected(false);
  }

  onStateChange(callback: (sessions: SessionState[]) => void): void {
    this.stateCallbacks.push(callback);
  }

  onConnectionChange(callback: (connected: boolean) => void): void {
    this.connectionCallbacks.push(callback);
  }

  async sendAction(sessionId: string, action: string): Promise<ActionResult> {
    try {
      const response = await fetch(`${this.baseUrl}/api/streamdeck/action`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sessionId, action }),
      });
      return (await response.json()) as ActionResult;
    } catch (error) {
      return { success: false, error: String(error) };
    }
  }

  isConnected(): boolean {
    return this.connected;
  }

  /** Exposed for testing */
  calculateBackoff(attempt: number): number {
    return Math.min(1000 * Math.pow(2, attempt), 30_000);
  }

  private startPolling(): void {
    if (this.pollTimer) return;

    // Immediate first poll
    this.poll();

    this.pollTimer = setInterval(() => {
      this.poll();
    }, POLL_INTERVAL_MS);
  }

  private stopPolling(): void {
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
  }

  private async poll(): Promise<void> {
    try {
      const response = await fetch(`${this.baseUrl}/api/streamdeck/state`);
      if (response.ok) {
        const sessions = (await response.json()) as SessionState[];
        this.setConnected(true);
        for (const cb of this.stateCallbacks) {
          cb(sessions);
        }
      } else {
        this.setConnected(false);
      }
    } catch {
      this.setConnected(false);
    }
  }

  private setConnected(value: boolean): void {
    if (this.connected !== value) {
      this.connected = value;
      for (const cb of this.connectionCallbacks) {
        cb(value);
      }
    }
  }
}
