/**
 * StreamDeck HTTP and WebSocket routes.
 *
 * Routes:
 * - GET /api/streamdeck/ws: WebSocket for real-time state push
 * - GET /api/streamdeck/state: REST fallback for current session states
 * - POST /api/streamdeck/action: Handle StreamDeck key-press actions
 */

import { app, type BrowserWindow } from 'electron';

import type { SessionStateTracker } from '../services/infrastructure/SessionStateTracker';
import type { StreamDeckActionRequest } from '@shared/types/streamdeck';
import type { FastifyInstance } from 'fastify';
import type { WebSocket } from 'ws';

const VALID_ACTIONS = new Set(['open-devtools', 'open-terminal']);
const WS_PING_INTERVAL_MS = 30_000;

export interface StreamDeckRouteServices {
  sessionStateTracker: SessionStateTracker;
  getMainWindow: () => BrowserWindow | null;
}

export function registerStreamDeckRoutes(
  app: FastifyInstance,
  services: StreamDeckRouteServices
): void {
  const { sessionStateTracker } = services;
  const wsClients = new Set<WebSocket>();

  // Forward state changes to all connected WebSocket clients
  sessionStateTracker.on('state-change', (sessions: unknown) => {
    const message = JSON.stringify({ type: 'session-state-change', sessions });
    for (const ws of wsClients) {
      try {
        ws.send(message);
      } catch {
        wsClients.delete(ws);
      }
    }
  });

  // WebSocket endpoint — instant push on state changes
  app.get('/api/streamdeck/ws', { websocket: true }, (socket) => {
    const ws = socket as unknown as WebSocket;
    wsClients.add(ws);

    // Send current state immediately on connect
    const snapshot = JSON.stringify({
      type: 'session-state-change',
      sessions: sessionStateTracker.getStates(),
    });
    ws.send(snapshot);

    // Handle incoming messages (actions from plugin)
    ws.on('message', (raw: Buffer | string) => {
      try {
        const msg = JSON.parse(raw.toString());
        if (msg.type === 'action') {
          handleAction(msg, services);
        }
      } catch {
        // Ignore malformed messages
      }
    });

    // Keep-alive ping
    const pingTimer = setInterval(() => {
      try {
        ws.ping();
      } catch {
        clearInterval(pingTimer);
        wsClients.delete(ws);
      }
    }, WS_PING_INTERVAL_MS);

    ws.on('close', () => {
      clearInterval(pingTimer);
      wsClients.delete(ws);
    });

    ws.on('error', () => {
      clearInterval(pingTimer);
      wsClients.delete(ws);
    });
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

  // Action endpoint for key presses (HTTP fallback)
  app.post('/api/streamdeck/action', async (request, reply) => {
    try {
      const body = request.body as StreamDeckActionRequest;
      return handleAction({ sessionId: body.sessionId, action: body.action }, services);
    } catch (error) {
      console.error('Error in POST /api/streamdeck/action:', error);
      reply.status(500);
      return { success: false, error: 'Internal server error' };
    }
  });
}

function handleAction(
  msg: { sessionId: string; action: string },
  services: StreamDeckRouteServices
): { success: boolean; error?: string } {
  const { sessionId, action } = msg;

  if (!sessionId || !action || !VALID_ACTIONS.has(action)) {
    return { success: false, error: `Invalid action: ${action}` };
  }

  if (action === 'open-devtools') {
    const mainWindow = services.getMainWindow();
    if (mainWindow) {
      // On macOS, app.show() activates the app (brings to front) even from background
      if (process.platform === 'darwin') {
        app.show();
      }
      mainWindow.show();
      mainWindow.focus();
    }
    return { success: true };
  }

  if (action === 'open-terminal') {
    if (process.platform === 'darwin') {
      focusGhosttyTab(sessionId, services);
    }
    return { success: true };
  }

  return { success: false, error: 'Unknown action' };
}

/**
 * Focus the Ghostty tab running the Claude Code session for a given project.
 * Matches by finding the claude process CWD, then using AppleScript to
 * focus the Ghostty tab whose name contains the project folder name.
 */
function focusGhosttyTab(sessionId: string, services: StreamDeckRouteServices): void {
  const { exec } = require('child_process') as typeof import('child_process');

  const states = services.sessionStateTracker.getStates();
  const session = states.find((s) => s.sessionId === sessionId);
  const projectPath = session?.projectPath ?? '';
  const projectName = projectPath.split('/').pop() ?? '';

  if (!projectName) {
    exec('open -a Ghostty');
    return;
  }

  // Use AppleScript to find the Ghostty tab matching this project name and focus it
  const escapedName = projectName.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
  const script = [
    'tell application "Ghostty"',
    '  activate',
    '  tell first window',
    '    set tabList to every tab',
    '    repeat with i from 1 to count of tabList',
    '      set t to item i of tabList',
    `      if name of t contains "${escapedName}" then`,
    '        set selected of t to true',
    '        return',
    '      end if',
    '    end repeat',
    '  end tell',
    'end tell',
  ].join('\n');

  exec(`osascript -e '${script.replace(/'/g, "'\"'\"'")}'`, { timeout: 3000 }, () => {});
}
