// streamdeck-plugin/src/transport/StateTransport.ts
import type { SessionState } from '../config/defaults.js';

export interface ActionResult {
  success: boolean;
  error?: string;
}

export interface StateTransport {
  connect(url: string): void;
  disconnect(): void;
  onStateChange(callback: (sessions: SessionState[]) => void): void;
  onConnectionChange(callback: (connected: boolean) => void): void;
  sendAction(sessionId: string, action: string): Promise<ActionResult>;
  isConnected(): boolean;
}
