import http from 'node:http';
import type { StateTransport, ActionResult } from './StateTransport.js';
import type { SessionState } from '../config/defaults.js';

const POLL_INTERVAL_MS = 2000;

/**
 * HTTP polling transport using Node's built-in http module.
 * Polls /api/streamdeck/state at a fixed interval.
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
    return new Promise((resolve) => {
      const body = JSON.stringify({ sessionId, action });
      const url = new URL(`${this.baseUrl}/api/streamdeck/action`);
      const req = http.request(
        {
          hostname: url.hostname,
          port: url.port,
          path: url.pathname,
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Content-Length': Buffer.byteLength(body),
          },
        },
        (res) => {
          let data = '';
          res.on('data', (chunk) => {
            data += chunk;
          });
          res.on('end', () => {
            try {
              resolve(JSON.parse(data) as ActionResult);
            } catch {
              resolve({ success: false, error: 'Invalid response' });
            }
          });
        }
      );
      req.on('error', (err) => {
        resolve({ success: false, error: String(err) });
      });
      req.write(body);
      req.end();
    });
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
    this.poll();
    this.pollTimer = setInterval(() => this.poll(), POLL_INTERVAL_MS);
  }

  private stopPolling(): void {
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
  }

  private poll(): void {
    const url = new URL(`${this.baseUrl}/api/streamdeck/state`);
    const req = http.get(
      {
        hostname: url.hostname,
        port: url.port,
        path: url.pathname,
      },
      (res) => {
        let data = '';
        res.on('data', (chunk) => {
          data += chunk;
        });
        res.on('end', () => {
          try {
            const sessions = JSON.parse(data) as SessionState[];
            this.setConnected(true);
            for (const cb of this.stateCallbacks) {
              cb(sessions);
            }
          } catch {
            this.setConnected(false);
          }
        });
      }
    );
    req.on('error', () => {
      this.setConnected(false);
    });
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
