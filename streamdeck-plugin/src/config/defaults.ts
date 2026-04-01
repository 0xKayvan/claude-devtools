// streamdeck-plugin/src/config/defaults.ts

export interface KeySettings {
  projectPath: string;
  displayName: string;
  isOverflowKey: boolean;
  displayMode: 'name' | 'name-count' | 'name-status';
  colors: {
    idle: string;
    working: string;
    waiting: string;
    disconnected: string;
  };
  blinkStyle: 'pulse' | 'toggle' | 'icon-overlay';
  blinkIntervalMs: number;
  actions: {
    idle: 'open-devtools' | 'open-terminal' | 'none';
    working: 'open-devtools' | 'open-terminal' | 'none';
    waiting: 'open-devtools' | 'open-terminal' | 'none';
  };
  serverUrl: string;
}

export const DEFAULT_KEY_SETTINGS: KeySettings = {
  projectPath: '',
  displayName: '',
  isOverflowKey: false,
  displayMode: 'name-status',
  colors: {
    idle: '#22c55e',
    working: '#3b82f6',
    waiting: '#f59e0b',
    disconnected: '#71717a',
  },
  blinkStyle: 'pulse',
  blinkIntervalMs: 500,
  actions: {
    idle: 'open-devtools',
    working: 'open-devtools',
    waiting: 'open-terminal',
  },
  serverUrl: 'http://localhost:3456',
};

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
