import { describe, expect, it, vi } from 'vitest';
import Fastify from 'fastify';
import { registerStreamDeckRoutes } from '../../../src/main/http/streamdeck';
import type { SessionState } from '../../../src/shared/types/streamdeck';

function createMockSessionStateTracker(states: SessionState[]) {
  return {
    getStates: vi.fn(() => states),
    on: vi.fn(),
    removeListener: vi.fn(),
  };
}

describe('StreamDeck HTTP endpoints', () => {
  describe('GET /api/streamdeck/state', () => {
    it('should return current session states', async () => {
      const app = Fastify();
      const states: SessionState[] = [
        {
          sessionId: 'session-1',
          projectPath: '/test/project',
          projectName: 'test-project',
          state: 'working',
          sessionCount: 1,
          updatedAt: Date.now(),
        },
      ];

      registerStreamDeckRoutes(app, {
        sessionStateTracker: createMockSessionStateTracker(states) as any,
        mainWindow: null,
      });

      const response = await app.inject({
        method: 'GET',
        url: '/api/streamdeck/state',
      });

      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.payload);
      expect(body).toHaveLength(1);
      expect(body[0].sessionId).toBe('session-1');
      expect(body[0].state).toBe('working');
    });

    it('should return empty array when no sessions tracked', async () => {
      const app = Fastify();

      registerStreamDeckRoutes(app, {
        sessionStateTracker: createMockSessionStateTracker([]) as any,
        mainWindow: null,
      });

      const response = await app.inject({
        method: 'GET',
        url: '/api/streamdeck/state',
      });

      expect(response.statusCode).toBe(200);
      expect(JSON.parse(response.payload)).toEqual([]);
    });
  });

  describe('POST /api/streamdeck/action', () => {
    it('should reject invalid action', async () => {
      const app = Fastify();

      registerStreamDeckRoutes(app, {
        sessionStateTracker: createMockSessionStateTracker([]) as any,
        mainWindow: null,
      });

      const response = await app.inject({
        method: 'POST',
        url: '/api/streamdeck/action',
        payload: { sessionId: 'session-1', action: 'hack-the-planet' },
      });

      expect(response.statusCode).toBe(400);
      const body = JSON.parse(response.payload);
      expect(body.success).toBe(false);
    });

    it('should accept valid open-devtools action', async () => {
      const app = Fastify();
      const mockWindow = {
        webContents: { send: vi.fn() },
        focus: vi.fn(),
      };

      registerStreamDeckRoutes(app, {
        sessionStateTracker: createMockSessionStateTracker([]) as any,
        mainWindow: mockWindow as any,
      });

      const response = await app.inject({
        method: 'POST',
        url: '/api/streamdeck/action',
        payload: { sessionId: 'session-1', action: 'open-devtools' },
      });

      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.payload);
      expect(body.success).toBe(true);
    });
  });
});
