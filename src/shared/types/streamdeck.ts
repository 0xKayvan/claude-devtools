export type SessionActivityState = 'idle' | 'working' | 'waiting-for-input';

export interface SessionState {
  sessionId: string;
  projectPath: string;
  projectName: string;
  sessionTitle: string;
  state: SessionActivityState;
  sessionCount: number;
  updatedAt: number;
}

export interface SessionStateEvent {
  type: 'session-state-change';
  sessions: SessionState[];
}

export interface StreamDeckActionRequest {
  sessionId: string;
  action: 'open-devtools' | 'open-terminal';
}

export interface StreamDeckActionResponse {
  success: boolean;
  error?: string;
}

export interface StreamDeckConfig {
  enabled: boolean;
  sseChannel: {
    enabled: boolean;
    staleSessionTimeoutMs: number;
  };
  actions: {
    openTerminalCommand: string;
  };
}

export const STREAMDECK_DEFAULTS: StreamDeckConfig = {
  enabled: false,
  sseChannel: {
    enabled: true,
    staleSessionTimeoutMs: 300_000,
  },
  actions: {
    openTerminalCommand: '',
  },
};
