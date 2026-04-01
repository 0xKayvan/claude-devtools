import { describe, expect, it, vi } from 'vitest';

// Mock modules that depend on Electron or native bindings not available in Vitest
vi.mock('../../../../src/main/services/infrastructure/ConfigManager', () => ({
  configManager: {
    getConfig: vi.fn(() => ({})),
    updateConfig: vi.fn(),
  },
}));

vi.mock('../../../../src/main/utils/ghosttyFocuser', () => ({
  focusGhosttySession: vi.fn(),
  focusDevtoolsWindow: vi.fn(),
}));

import {
  getAggregateState,
  buildSessionMenuItems,
} from '../../../../src/main/services/infrastructure/TrayManager';
import type { SessionState } from '../../../../src/shared/types/streamdeck';

function makeSession(overrides: Partial<SessionState>): SessionState {
  return {
    sessionId: 'test-' + Math.random().toString(36).slice(2),
    projectPath: '/test/project',
    projectName: 'test',
    sessionTitle: 'test session',
    state: 'idle',
    sessionCount: 1,
    updatedAt: Date.now(),
    ...overrides,
  };
}

describe('TrayManager', () => {
  describe('getAggregateState', () => {
    it('should return idle when no sessions', () => {
      expect(getAggregateState([])).toBe('idle');
    });

    it('should return idle when all sessions are idle', () => {
      const sessions = [makeSession({ state: 'idle' }), makeSession({ state: 'idle' })];
      expect(getAggregateState(sessions)).toBe('idle');
    });

    it('should return working when at least one session is working', () => {
      const sessions = [makeSession({ state: 'idle' }), makeSession({ state: 'working' })];
      expect(getAggregateState(sessions)).toBe('working');
    });

    it('should return waiting-for-input when any session is waiting (highest priority)', () => {
      const sessions = [
        makeSession({ state: 'idle' }),
        makeSession({ state: 'working' }),
        makeSession({ state: 'waiting-for-input' }),
      ];
      expect(getAggregateState(sessions)).toBe('waiting-for-input');
    });
  });

  describe('buildSessionMenuItems', () => {
    it('should return empty array for no sessions', () => {
      expect(buildSessionMenuItems([])).toEqual([]);
    });

    it('should sort sessions: waiting first, then working, then idle', () => {
      const sessions = [
        makeSession({ projectName: 'idle-proj', state: 'idle' }),
        makeSession({ projectName: 'waiting-proj', state: 'waiting-for-input' }),
        makeSession({ projectName: 'working-proj', state: 'working' }),
      ];
      const items = buildSessionMenuItems(sessions);
      expect(items[0].label).toContain('waiting-proj');
      expect(items[1].label).toContain('working-proj');
      expect(items[2].label).toContain('idle-proj');
    });

    it('should include status emoji and state text in label', () => {
      const sessions = [makeSession({ projectName: 'myproject', state: 'working' })];
      const items = buildSessionMenuItems(sessions);
      expect(items[0].label).toContain('🔵');
      expect(items[0].label).toContain('myproject');
      expect(items[0].label).toContain('working');
    });
  });
});
