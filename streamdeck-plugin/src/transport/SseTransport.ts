import WebSocket from 'ws';
import type { StateTransport, ActionResult } from './StateTransport.js';
import type { SessionState } from '../config/defaults.js';

const RECONNECT_BASE_MS = 1000;
const RECONNECT_MAX_MS = 30_000;

/**
 * WebSocket transport. Connects to the Electron app's WS endpoint
 * for instant push of state changes — no polling.
 */
export class SseTransport implements StateTransport {
  private ws: WebSocket | null = null;
  private connected = false;
  private reconnectAttempt = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private baseUrl = '';
  private stateCallbacks: ((sessions: SessionState[]) => void)[] = [];
  private connectionCallbacks: ((connected: boolean) => void)[] = [];
  private log: (msg: string) => void = () => {};

  setLogger(fn: (msg: string) => void): void {
    this.log = fn;
  }

  connect(url: string): void {
    this.baseUrl = url;
    this.reconnectAttempt = 0;
    this.connectWs();
  }

  disconnect(): void {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.ws) {
      this.ws.close();
      this.ws = null;
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
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify({ type: 'action', sessionId, action }));
      return { success: true };
    }
    return { success: false, error: 'Not connected' };
  }

  isConnected(): boolean {
    return this.connected;
  }

  /** Exposed for testing */
  calculateBackoff(attempt: number): number {
    return Math.min(RECONNECT_BASE_MS * Math.pow(2, attempt), RECONNECT_MAX_MS);
  }

  private connectWs(): void {
    const wsUrl = this.baseUrl.replace(/^http/, 'ws') + '/api/streamdeck/ws';

    this.log(`[WS] Attempting connection to ${wsUrl}`);
    try {
      this.ws = new WebSocket(wsUrl);
      this.log('[WS] WebSocket object created');

      this.ws.on('open', () => {
        this.log(`[WS] Connected to ${wsUrl}`);
        this.reconnectAttempt = 0;
        this.setConnected(true);
      });

      this.ws.on('message', (raw: Buffer | string) => {
        try {
          const msg = JSON.parse(raw.toString());
          if (msg.type === 'session-state-change' && Array.isArray(msg.sessions)) {
            this.log(
              `[WS] Received ${msg.sessions.length} sessions, callbacks=${this.stateCallbacks.length}`
            );
            for (const cb of this.stateCallbacks) {
              cb(msg.sessions as SessionState[]);
            }
          }
        } catch {
          // Ignore malformed messages
        }
      });

      this.ws.on('close', () => {
        this.log('[WS] Connection closed');
        this.ws = null;
        this.setConnected(false);
        this.scheduleReconnect();
      });

      this.ws.on('error', (err) => {
        this.log(`[WS] Error: ${err}`);
        this.ws?.close();
        this.ws = null;
        this.setConnected(false);
        this.scheduleReconnect();
      });
    } catch (err) {
      this.log(`[WS] Connection failed: ${err}`);
      this.setConnected(false);
      this.scheduleReconnect();
    }
  }

  private scheduleReconnect(): void {
    if (this.reconnectTimer) return;
    const delay = this.calculateBackoff(this.reconnectAttempt);
    this.reconnectAttempt++;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connectWs();
    }, delay);
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
