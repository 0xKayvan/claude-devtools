/**
 * StreamDeck HTTP/SSE routes.
 *
 * Routes:
 * - GET /api/streamdeck/events: SSE stream for real-time session state updates
 * - GET /api/streamdeck/state: REST polling fallback for current session states
 * - POST /api/streamdeck/action: Handle StreamDeck key-press actions
 */

import type { SessionStateTracker } from '../services/infrastructure/SessionStateTracker';
import type { StreamDeckActionRequest } from '@shared/types/streamdeck';
import type { BrowserWindow } from 'electron';
import type { FastifyInstance } from 'fastify';

const KEEPALIVE_INTERVAL_MS = 30_000;
const VALID_ACTIONS = new Set(['open-devtools', 'open-terminal']);

export interface StreamDeckRouteServices {
  sessionStateTracker: SessionStateTracker;
  mainWindow: BrowserWindow | null;
}

export function registerStreamDeckRoutes(
  app: FastifyInstance,
  services: StreamDeckRouteServices
): void {
  const { sessionStateTracker } = services;

  // SSE endpoint for real-time state updates
  app.get('/api/streamdeck/events', async (request, reply) => {
    reply.raw.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
    });

    // Send initial state snapshot
    const initialPayload = `event: session-state-change\ndata: ${JSON.stringify({
      type: 'session-state-change',
      sessions: sessionStateTracker.getStates(),
    })}\n\n`;
    reply.raw.write(initialPayload);

    // Forward state changes
    const onStateChange = (sessions: unknown) => {
      const payload = `event: session-state-change\ndata: ${JSON.stringify({
        type: 'session-state-change',
        sessions,
      })}\n\n`;
      try {
        reply.raw.write(payload);
      } catch {
        sessionStateTracker.removeListener('state-change', onStateChange);
      }
    };

    sessionStateTracker.on('state-change', onStateChange);

    // Keep-alive
    const timer = setInterval(() => {
      try {
        reply.raw.write(':ping\n\n');
      } catch {
        clearInterval(timer);
      }
    }, KEEPALIVE_INTERVAL_MS);

    // Cleanup on disconnect
    request.raw.on('close', () => {
      clearInterval(timer);
      sessionStateTracker.removeListener('state-change', onStateChange);
    });

    await reply;
  });

  // REST endpoint for polling fallback
  app.get('/api/streamdeck/state', async () => {
    try {
      return sessionStateTracker.getStates();
    } catch (error) {
      console.error('Error in GET /api/streamdeck/state:', error);
      return [];
    }
  });

  // Action endpoint for key presses
  app.post('/api/streamdeck/action', async (request, reply) => {
    try {
      const { sessionId, action } = request.body as StreamDeckActionRequest;

      if (!sessionId || !action || !VALID_ACTIONS.has(action)) {
        reply.status(400);
        return { success: false, error: `Invalid action: ${action}` };
      }

      if (action === 'open-devtools') {
        const mainWindow = services.mainWindow;
        if (mainWindow) {
          mainWindow.webContents.send('navigate-to-session', sessionId);
          mainWindow.focus();
        }
        return { success: true };
      }

      if (action === 'open-terminal') {
        return { success: true };
      }

      return { success: false, error: 'Unknown action' };
    } catch (error) {
      console.error('Error in POST /api/streamdeck/action:', error);
      reply.status(500);
      return { success: false, error: 'Internal server error' };
    }
  });
}
