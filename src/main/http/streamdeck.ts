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
        console.log('[StreamDeck WS] Received message:', msg.type, msg.action ?? '');
        if (msg.type === 'action') {
          const result = handleAction(msg, services);
          console.log('[StreamDeck WS] Action result:', JSON.stringify(result));
        }
      } catch (err) {
        console.error('[StreamDeck WS] Message parse error:', err);
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
      const { exec } = require('child_process') as typeof import('child_process');

      // Match Ghostty tab by session title across ALL windows
      const states = services.sessionStateTracker.getStates();
      const session = states.find((s) => s.sessionId === sessionId);
      const title = session?.sessionTitle ?? '';

      // Extract first few words as search term (tab names are truncated)
      const searchWords = title ? title.split(/\s+/).slice(0, 4).join(' ') : '';
      const escaped = searchWords.replace(/\\/g, '\\\\').replace(/"/g, '\\"');

      const script = escaped
        ? `
tell application "Ghostty"
  activate
  set winCount to count of every window
  repeat with wi from 1 to winCount
    set w to window wi
    set tabCount to count of every tab of w
    repeat with ti from 1 to tabCount
      if name of tab ti of w contains "${escaped}" then
        tell application "System Events"
          tell process "ghostty"
            perform action "AXRaise" of window wi
          end tell
          delay 0.15
          keystroke (ti as string) using command down
        end tell
        return
      end if
    end repeat
  end repeat
end tell`
        : 'tell application "Ghostty" to activate';

      exec(`osascript -e '${script.replace(/'/g, "'\"'\"'")}'`, { timeout: 5000 }, () => {});
    }
    return { success: true };
  }

  return { success: false, error: 'Unknown action' };
}

/**
 * Focus the Ghostty tab running the Claude Code session for a given project.
 *
 * 1. Find the `claude` process whose CWD matches the project path
 * 2. Get its TTY (e.g. ttys004)
 * 3. Find the tab index by matching TTYs to Ghostty tabs in order
 * 4. Focus that tab via AppleScript
 */
function focusGhosttyTab(sessionId: string, services: StreamDeckRouteServices): void {
  const { execSync, exec } = require('child_process') as typeof import('child_process');

  const states = services.sessionStateTracker.getStates();
  const session = states.find((s) => s.sessionId === sessionId);
  const projectPath = session?.projectPath ?? '';

  if (!projectPath) {
    exec('open -a Ghostty');
    return;
  }

  try {
    // Step 1: Find claude processes with TTYs and match by CWD
    const psOut = execSync('ps -eo pid,tty,command | grep -E "[c]laude$|[C]laude$"', {
      encoding: 'utf8',
      timeout: 2000,
    }).trim();

    let targetTty = '';
    for (const line of psOut.split('\n')) {
      const m = /^(\d+)\s+(ttys\d+)/.exec(line.trim());
      if (!m) continue;
      const pid = m[1];
      try {
        const cwd = execSync(`lsof -p ${pid} -Fn 2>/dev/null | grep '^n/' | head -1`, {
          encoding: 'utf8',
          timeout: 2000,
        })
          .trim()
          .replace(/^n/, '');
        if (cwd === projectPath) {
          targetTty = m[2];
          break;
        }
      } catch {
        continue;
      }
    }

    if (!targetTty) {
      exec('open -a Ghostty');
      return;
    }

    // Step 2: Find which Ghostty tab index owns this TTY
    // Get all Ghostty tab TTYs by finding login processes spawned by Ghostty
    const ghosttyPid = execSync('pgrep -x ghostty', { encoding: 'utf8', timeout: 2000 })
      .trim()
      .split('\n')[0];

    // Find the login shells (direct children of Ghostty) and their TTYs — these map 1:1 to tabs
    const loginOut = execSync(
      `ps -eo pid,ppid,tty,command | grep "login.*zsh\\|login.*bash" | grep -v grep`,
      { encoding: 'utf8', timeout: 2000 }
    ).trim();

    // Collect unique TTYs in order — each corresponds to a tab
    const tabTtys: string[] = [];
    for (const line of loginOut.split('\n')) {
      const m = /^\d+\s+\d+\s+(ttys\d+)/.exec(line.trim());
      if (m && !tabTtys.includes(m[1])) {
        tabTtys.push(m[1]);
      }
    }

    const tabIndex = tabTtys.indexOf(targetTty);
    if (tabIndex === -1) {
      exec('open -a Ghostty');
      return;
    }

    // Step 3: Focus the tab via AppleScript (1-indexed)
    const script = `
tell application "Ghostty"
  activate
  tell first window
    set selected of tab ${tabIndex + 1} to true
  end tell
end tell`;

    exec(`osascript -e '${script.replace(/'/g, "'\"'\"'")}'`, { timeout: 3000 }, () => {});
  } catch {
    exec('open -a Ghostty', () => {});
  }
}
