// streamdeck-plugin/src/transport/SseTransport.ts
import EventSourceLib from 'eventsource';
import type { StateTransport, ActionResult } from './StateTransport';
import type { SessionState } from '../config/defaults';

const BASE_BACKOFF_MS = 1000;
const MAX_BACKOFF_MS = 30_000;
const POLL_INTERVAL_MS = 5000;

// Use native EventSource if available (browser/StreamDeck runtime), otherwise fall back to the
// eventsource npm package (Node.js / test environment).
const EventSourceImpl: typeof EventSource =
  typeof EventSource !== 'undefined'
    ? EventSource
    : (EventSourceLib as unknown as typeof EventSource);

export class SseTransport implements StateTransport {
  private eventSource: EventSource | null = null;
  private connected = false;
  private reconnectAttempt = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private pollTimer: ReturnType<typeof setInterval> | null = null;
  private baseUrl = '';
  private stateCallbacks: ((sessions: SessionState[]) => void)[] = [];
  private connectionCallbacks: ((connected: boolean) => void)[] = [];

  connect(url: string): void {
    this.baseUrl = url;
    this.reconnectAttempt = 0;
    this.connectSSE();
  }

  disconnect(): void {
    if (this.eventSource) {
      this.eventSource.close();
      this.eventSource = null;
    }
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
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
    return Math.min(BASE_BACKOFF_MS * Math.pow(2, attempt), MAX_BACKOFF_MS);
  }

  private connectSSE(): void {
    try {
      this.eventSource = new EventSourceImpl(`${this.baseUrl}/api/streamdeck/events`);

      this.eventSource.addEventListener('session-state-change', (event: MessageEvent) => {
        try {
          const data = JSON.parse(event.data);
          const sessions = data.sessions as SessionState[];
          for (const cb of this.stateCallbacks) {
            cb(sessions);
          }
        } catch {
          // Ignore malformed events
        }
      });

      this.eventSource.onopen = () => {
        this.reconnectAttempt = 0;
        this.setConnected(true);
        this.stopPolling();
      };

      this.eventSource.onerror = () => {
        this.eventSource?.close();
        this.eventSource = null;
        this.setConnected(false);
        this.startPolling();
        this.scheduleReconnect();
      };
    } catch {
      this.setConnected(false);
      this.startPolling();
      this.scheduleReconnect();
    }
  }

  private scheduleReconnect(): void {
    if (this.reconnectTimer) return;
    const delay = this.calculateBackoff(this.reconnectAttempt);
    this.reconnectAttempt++;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connectSSE();
    }, delay);
  }

  private startPolling(): void {
    if (this.pollTimer) return;
    this.pollTimer = setInterval(async () => {
      try {
        const response = await fetch(`${this.baseUrl}/api/streamdeck/state`);
        if (response.ok) {
          const sessions = (await response.json()) as SessionState[];
          for (const cb of this.stateCallbacks) {
            cb(sessions);
          }
        }
      } catch {
        // Polling failure — SSE reconnect will handle recovery
      }
    }, POLL_INTERVAL_MS);
  }

  private stopPolling(): void {
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
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
