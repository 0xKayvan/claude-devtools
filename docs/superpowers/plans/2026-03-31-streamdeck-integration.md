# StreamDeck Integration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Connect claude-devtools to Elgato StreamDeck hardware so each session gets a physical key reflecting its real-time state (idle/working/waiting-for-input) with configurable key-press actions.

**Architecture:** Decoupled two-system design. The Electron app gains a `SessionStateTracker` service and dedicated SSE channel. A standalone StreamDeck plugin (`@elgato/streamdeck` SDK) consumes that SSE stream and renders key visuals. Communication is HTTP/SSE over localhost, with a `StateTransport` abstraction for future WebSocket support.

**Tech Stack:** TypeScript, Fastify (existing), `@elgato/streamdeck` SDK, `@napi-rs/canvas` (key image rendering), Vitest (testing)

**Spec:** `docs/superpowers/specs/2026-03-31-streamdeck-integration-design.md`

---

## File Structure

### Electron App Side (existing codebase)

| Action | Path | Responsibility |
|--------|------|----------------|
| Create | `src/shared/types/streamdeck.ts` | Shared types: `SessionActivityState`, `SessionState`, `SessionStateEvent`, `StreamDeckConfig` |
| Create | `src/main/services/infrastructure/SessionStateTracker.ts` | Derives session state from FileWatcher events, emits state-change events |
| Create | `src/main/http/streamdeck.ts` | HTTP/SSE endpoints: `/api/streamdeck/events`, `/api/streamdeck/state`, `/api/streamdeck/action` |
| Modify | `src/main/http/index.ts` | Register StreamDeck routes |
| Modify | `src/main/services/infrastructure/ServiceContext.ts` | Wire SessionStateTracker into service context |
| Modify | `src/shared/types/index.ts` | Re-export streamdeck types |
| Create | `test/main/services/infrastructure/SessionStateTracker.test.ts` | Unit tests for state detection and transitions |
| Create | `test/main/http/streamdeck.test.ts` | Endpoint tests |

### StreamDeck Plugin (new package)

| Action | Path | Responsibility |
|--------|------|----------------|
| Create | `streamdeck-plugin/package.json` | Package config with `@elgato/streamdeck` and `@napi-rs/canvas` deps |
| Create | `streamdeck-plugin/tsconfig.json` | TypeScript config |
| Create | `streamdeck-plugin/manifest.json` | StreamDeck plugin manifest |
| Create | `streamdeck-plugin/src/plugin.ts` | Entry point — registers SessionMonitorAction with SDK |
| Create | `streamdeck-plugin/src/actions/SessionMonitorAction.ts` | Key action — binds project, manages state, delegates to renderer |
| Create | `streamdeck-plugin/src/transport/StateTransport.ts` | Transport interface |
| Create | `streamdeck-plugin/src/transport/SseTransport.ts` | SSE implementation with reconnection/backoff |
| Create | `streamdeck-plugin/src/rendering/KeyRenderer.ts` | Generates 144x144 PNG key images |
| Create | `streamdeck-plugin/src/rendering/BlinkController.ts` | Blink animation timing |
| Create | `streamdeck-plugin/src/rendering/themes.ts` | Color definitions, style configs |
| Create | `streamdeck-plugin/src/config/defaults.ts` | Default settings |
| Create | `streamdeck-plugin/property-inspector/index.html` | Per-key config UI |
| Create | `streamdeck-plugin/test/transport/SseTransport.test.ts` | Transport tests |
| Create | `streamdeck-plugin/test/rendering/KeyRenderer.test.ts` | Rendering tests |
| Create | `streamdeck-plugin/test/rendering/BlinkController.test.ts` | Blink timer tests |
| Create | `streamdeck-plugin/test/actions/SessionMonitorAction.test.ts` | Action integration tests |

---

## Task 1: Shared Types

**Files:**
- Create: `src/shared/types/streamdeck.ts`
- Modify: `src/shared/types/index.ts`

- [ ] **Step 1: Create the shared StreamDeck types file**

```typescript
// src/shared/types/streamdeck.ts

export type SessionActivityState = 'idle' | 'working' | 'waiting-for-input';

export interface SessionState {
  sessionId: string;
  projectPath: string;
  projectName: string;
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
    openTerminalCommand: process.platform === 'darwin' ? 'open -a Terminal' : 'x-terminal-emulator',
  },
};
```

- [ ] **Step 2: Export from shared types index**

Add to `src/shared/types/index.ts`:

```typescript
export * from './streamdeck';
```

- [ ] **Step 3: Run typecheck to verify**

Run: `pnpm typecheck`
Expected: PASS — no type errors

- [ ] **Step 4: Commit**

```bash
git add src/shared/types/streamdeck.ts src/shared/types/index.ts
git commit -m "feat(streamdeck): add shared types for StreamDeck integration"
```

---

## Task 2: SessionStateTracker Service — Waiting-for-Input Detection

The hardest new logic: detecting when a session is waiting for user input. This is the core state machine.

**Files:**
- Create: `test/main/services/infrastructure/SessionStateTracker.test.ts`
- Create: `src/main/services/infrastructure/SessionStateTracker.ts`

- [ ] **Step 1: Write failing tests for state detection**

```typescript
// test/main/services/infrastructure/SessionStateTracker.test.ts
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { EventEmitter } from 'events';
import { SessionStateTracker } from '../../../../src/main/services/infrastructure/SessionStateTracker';
import type { ParsedMessage, FileChangeEvent } from '../../../../src/main/types';

// Minimal mock for FileWatcher — only needs to be an EventEmitter
function createMockFileWatcher() {
  return new EventEmitter();
}

// Minimal mock for SessionParser — returns messages for a session
function createMockSessionParser(messagesMap: Record<string, ParsedMessage[]>) {
  return {
    parseSessionMessages: vi.fn(async (sessionId: string) => {
      return messagesMap[sessionId] ?? [];
    }),
  };
}

// Minimal mock for ProjectScanner — returns project info
function createMockProjectScanner(projects: Array<{ id: string; path: string; name: string; sessions: string[] }>) {
  return {
    scan: vi.fn(async () => projects),
    getProjectForSession: vi.fn((sessionId: string) => {
      return projects.find((p) => p.sessions.includes(sessionId)) ?? null;
    }),
  };
}

function createMessage(overrides: Partial<ParsedMessage>): ParsedMessage {
  return {
    uuid: `msg-${Math.random().toString(36).slice(2, 11)}`,
    parentUuid: null,
    type: 'user',
    timestamp: new Date(),
    content: '',
    isSidechain: false,
    isMeta: false,
    toolCalls: [],
    toolResults: [],
    ...overrides,
  };
}

describe('SessionStateTracker', () => {
  let fileWatcher: EventEmitter;
  let tracker: SessionStateTracker;

  afterEach(() => {
    tracker?.dispose();
  });

  describe('detectSessionState', () => {
    it('should return idle when session has no ongoing activity', () => {
      const messages: ParsedMessage[] = [
        createMessage({ type: 'user', content: 'hello' }),
        createMessage({
          type: 'assistant',
          content: [{ type: 'text', text: 'Hi there!' }],
        }),
      ];

      fileWatcher = createMockFileWatcher();
      const sessionParser = createMockSessionParser({ 'session-1': messages });
      const projectScanner = createMockProjectScanner([
        { id: 'proj-1', path: '/test/project', name: 'test-project', sessions: ['session-1'] },
      ]);

      tracker = new SessionStateTracker(
        fileWatcher as any,
        sessionParser as any,
        projectScanner as any,
      );

      // detectSessionState is the internal method we're testing
      const state = tracker.detectActivityState(messages);
      expect(state).toBe('idle');
    });

    it('should return working when last activity is thinking', () => {
      const messages: ParsedMessage[] = [
        createMessage({ type: 'user', content: 'help me' }),
        createMessage({
          type: 'assistant',
          content: [{ type: 'thinking', thinking: 'Let me think about this...' }],
        }),
      ];

      fileWatcher = createMockFileWatcher();
      tracker = new SessionStateTracker(
        fileWatcher as any,
        createMockSessionParser({}) as any,
        createMockProjectScanner([]) as any,
      );

      const state = tracker.detectActivityState(messages);
      expect(state).toBe('working');
    });

    it('should return working when last activity is tool_use with matching tool_result', () => {
      const messages: ParsedMessage[] = [
        createMessage({ type: 'user', content: 'read file.ts' }),
        createMessage({
          type: 'assistant',
          content: [{ type: 'tool_use', id: 'tool-1', name: 'Read', input: {} }],
          toolCalls: [{ id: 'tool-1', name: 'Read', input: {}, serverName: undefined }],
        }),
        createMessage({
          type: 'user',
          isMeta: true,
          content: [{ type: 'tool_result', tool_use_id: 'tool-1', content: 'file contents' }],
          toolResults: [{ toolUseId: 'tool-1', content: 'file contents' }],
        }),
      ];

      fileWatcher = createMockFileWatcher();
      tracker = new SessionStateTracker(
        fileWatcher as any,
        createMockSessionParser({}) as any,
        createMockProjectScanner([]) as any,
      );

      const state = tracker.detectActivityState(messages);
      expect(state).toBe('working');
    });

    it('should return waiting-for-input when tool_use has no matching tool_result', () => {
      const messages: ParsedMessage[] = [
        createMessage({ type: 'user', content: 'delete file.ts' }),
        createMessage({
          type: 'assistant',
          content: [{ type: 'tool_use', id: 'tool-1', name: 'Bash', input: { command: 'rm file.ts' } }],
          toolCalls: [{ id: 'tool-1', name: 'Bash', input: { command: 'rm file.ts' }, serverName: undefined }],
        }),
        // No tool_result follows — waiting for approval
      ];

      fileWatcher = createMockFileWatcher();
      tracker = new SessionStateTracker(
        fileWatcher as any,
        createMockSessionParser({}) as any,
        createMockProjectScanner([]) as any,
      );

      const state = tracker.detectActivityState(messages);
      expect(state).toBe('waiting-for-input');
    });

    it('should return waiting-for-input when AskUserQuestion has no result', () => {
      const messages: ParsedMessage[] = [
        createMessage({ type: 'user', content: 'help me pick' }),
        createMessage({
          type: 'assistant',
          content: [
            { type: 'tool_use', id: 'tool-1', name: 'AskUserQuestion', input: { question: 'Which option?' } },
          ],
          toolCalls: [{ id: 'tool-1', name: 'AskUserQuestion', input: { question: 'Which option?' }, serverName: undefined }],
        }),
        // No tool_result — waiting for user answer
      ];

      fileWatcher = createMockFileWatcher();
      tracker = new SessionStateTracker(
        fileWatcher as any,
        createMockSessionParser({}) as any,
        createMockProjectScanner([]) as any,
      );

      const state = tracker.detectActivityState(messages);
      expect(state).toBe('waiting-for-input');
    });

    it('should return idle when last assistant message is plain text with no pending tools', () => {
      const messages: ParsedMessage[] = [
        createMessage({ type: 'user', content: 'what is 2+2?' }),
        createMessage({
          type: 'assistant',
          content: [{ type: 'text', text: 'The answer is 4.' }],
        }),
      ];

      fileWatcher = createMockFileWatcher();
      tracker = new SessionStateTracker(
        fileWatcher as any,
        createMockSessionParser({}) as any,
        createMockProjectScanner([]) as any,
      );

      const state = tracker.detectActivityState(messages);
      expect(state).toBe('idle');
    });
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm test test/main/services/infrastructure/SessionStateTracker.test.ts`
Expected: FAIL — `SessionStateTracker` module does not exist

- [ ] **Step 3: Implement SessionStateTracker**

```typescript
// src/main/services/infrastructure/SessionStateTracker.ts
import { EventEmitter } from 'events';
import type { FileWatcher } from './FileWatcher';
import type { SessionParser } from '../parsing/SessionParser';
import type { ProjectScanner } from '../discovery/ProjectScanner';
import type { FileChangeEvent } from '../../types';
import type { SessionActivityState, SessionState } from '@shared/types/streamdeck';
import type { ParsedMessage } from '../../types';
import { checkMessagesOngoing } from '../../utils/sessionStateDetection';
import { createLogger } from '../../utils/logger';

const logger = createLogger('SessionStateTracker');
const DEBOUNCE_MS = 200;

export class SessionStateTracker extends EventEmitter {
  private states = new Map<string, SessionState>();
  private debounceTimers = new Map<string, NodeJS.Timeout>();
  private disposed = false;

  constructor(
    private readonly fileWatcher: FileWatcher,
    private readonly sessionParser: SessionParser,
    private readonly projectScanner: ProjectScanner,
  ) {
    super();
    this.fileWatcher.on('file-change', this.handleFileChange.bind(this));
  }

  /**
   * Detect the activity state of a session from its messages.
   * Public for testing — the main entry point is the file-change event handler.
   */
  detectActivityState(messages: ParsedMessage[]): SessionActivityState {
    if (messages.length === 0) return 'idle';

    // Check if session has ongoing activity using existing logic
    const isOngoing = checkMessagesOngoing(messages);
    if (!isOngoing) return 'idle';

    // Session is ongoing — determine if working or waiting for input
    // Walk backwards to find the last assistant message
    for (let i = messages.length - 1; i >= 0; i--) {
      const msg = messages[i];

      // Skip non-assistant messages (tool results are user messages with isMeta: true)
      if (msg.type !== 'assistant') continue;

      // Check if this assistant message has tool calls without results
      if (msg.toolCalls && msg.toolCalls.length > 0) {
        const pendingToolCalls = msg.toolCalls.filter((tc) => {
          // Look for a matching tool_result in subsequent messages
          const hasResult = messages.slice(i + 1).some(
            (subsequent) =>
              subsequent.toolResults?.some((tr) => tr.toolUseId === tc.id),
          );
          return !hasResult;
        });

        if (pendingToolCalls.length > 0) {
          return 'waiting-for-input';
        }
      }

      // If the last assistant message is just text with no tool calls,
      // and session is ongoing, it's still working (streaming text)
      break;
    }

    return 'working';
  }

  private async handleFileChange(event: FileChangeEvent): Promise<void> {
    if (this.disposed) return;
    if (event.type === 'unlink') {
      this.removeSession(event.sessionId);
      return;
    }

    // Debounce per session
    const existing = this.debounceTimers.get(event.sessionId);
    if (existing) clearTimeout(existing);

    this.debounceTimers.set(
      event.sessionId,
      setTimeout(() => {
        this.debounceTimers.delete(event.sessionId);
        this.updateSessionState(event.sessionId, event.projectId).catch((err) => {
          logger.error(`Error updating state for session ${event.sessionId}:`, err);
        });
      }, DEBOUNCE_MS),
    );
  }

  private async updateSessionState(sessionId: string, projectId?: string): Promise<void> {
    if (this.disposed) return;

    try {
      const messages = await this.sessionParser.parseSessionMessages(sessionId);
      const state = this.detectActivityState(messages);
      const project = this.projectScanner.getProjectForSession(sessionId);

      const projectPath = project?.path ?? '';
      const projectName = project?.name ?? 'Unknown';

      // Count active sessions in the same project
      const sessionCount = project
        ? [...this.states.values()].filter(
            (s) => s.projectPath === projectPath && s.state !== 'idle',
          ).length + (state !== 'idle' ? 1 : 0)
        : 1;

      const prev = this.states.get(sessionId);
      const next: SessionState = {
        sessionId,
        projectPath,
        projectName,
        state,
        sessionCount,
        updatedAt: Date.now(),
      };

      // Only emit if state actually changed
      if (!prev || prev.state !== next.state) {
        this.states.set(sessionId, next);
        this.emit('state-change', this.getStates());
      } else {
        // Update timestamp even if state didn't change
        this.states.set(sessionId, next);
      }
    } catch (err) {
      logger.error(`Failed to update session state for ${sessionId}:`, err);
    }
  }

  private removeSession(sessionId: string): void {
    const had = this.states.delete(sessionId);
    if (had) {
      this.emit('state-change', this.getStates());
    }
  }

  getStates(): SessionState[] {
    return [...this.states.values()];
  }

  dispose(): void {
    this.disposed = true;
    for (const timer of this.debounceTimers.values()) {
      clearTimeout(timer);
    }
    this.debounceTimers.clear();
    this.states.clear();
    this.removeAllListeners();
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm test test/main/services/infrastructure/SessionStateTracker.test.ts`
Expected: PASS — all 6 tests green

- [ ] **Step 5: Commit**

```bash
git add test/main/services/infrastructure/SessionStateTracker.test.ts src/main/services/infrastructure/SessionStateTracker.ts
git commit -m "feat(streamdeck): add SessionStateTracker with waiting-for-input detection"
```

---

## Task 3: Wire SessionStateTracker into ServiceContext

**Files:**
- Modify: `src/main/services/infrastructure/ServiceContext.ts`

- [ ] **Step 1: Add SessionStateTracker to ServiceContext**

Add the import at the top of `ServiceContext.ts`:

```typescript
import { SessionStateTracker } from './SessionStateTracker';
```

Add the public property alongside the other service declarations:

```typescript
readonly sessionStateTracker: SessionStateTracker;
```

Add initialization in the constructor, after `this.fileWatcher.setProjectScanner(this.projectScanner)`:

```typescript
this.sessionStateTracker = new SessionStateTracker(
  this.fileWatcher,
  this.sessionParser,
  this.projectScanner,
);
```

Add cleanup in the `dispose()` method:

```typescript
this.sessionStateTracker.dispose();
```

- [ ] **Step 2: Run typecheck**

Run: `pnpm typecheck`
Expected: PASS

- [ ] **Step 3: Run existing tests to verify no regressions**

Run: `pnpm test`
Expected: PASS — all existing tests still green

- [ ] **Step 4: Commit**

```bash
git add src/main/services/infrastructure/ServiceContext.ts
git commit -m "feat(streamdeck): wire SessionStateTracker into ServiceContext"
```

---

## Task 4: StreamDeck HTTP/SSE Endpoints

**Files:**
- Create: `test/main/http/streamdeck.test.ts`
- Create: `src/main/http/streamdeck.ts`
- Modify: `src/main/http/index.ts`

- [ ] **Step 1: Write failing tests for the endpoints**

```typescript
// test/main/http/streamdeck.test.ts
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
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm test test/main/http/streamdeck.test.ts`
Expected: FAIL — module `src/main/http/streamdeck` does not exist

- [ ] **Step 3: Implement the StreamDeck routes**

```typescript
// src/main/http/streamdeck.ts
import type { FastifyInstance } from 'fastify';
import type { SessionStateTracker } from '../services/infrastructure/SessionStateTracker';
import type { BrowserWindow } from 'electron';
import type { StreamDeckActionRequest } from '@shared/types/streamdeck';
import { broadcastEvent } from './events';
import { createLogger } from '../utils/logger';

const logger = createLogger('StreamDeckRoutes');
const KEEPALIVE_INTERVAL_MS = 30_000;
const VALID_ACTIONS = new Set(['open-devtools', 'open-terminal']);

export interface StreamDeckRouteServices {
  sessionStateTracker: SessionStateTracker;
  mainWindow: BrowserWindow | null;
}

export function registerStreamDeckRoutes(
  app: FastifyInstance,
  services: StreamDeckRouteServices,
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
      logger.error('Error in GET /api/streamdeck/state:', error);
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
        // Terminal opening will be handled by existing shell utilities
        // For now, return success — implementation depends on platform detection
        return { success: true };
      }

      return { success: false, error: 'Unknown action' };
    } catch (error) {
      logger.error('Error in POST /api/streamdeck/action:', error);
      reply.status(500);
      return { success: false, error: 'Internal server error' };
    }
  });

  logger.info('StreamDeck routes registered');
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm test test/main/http/streamdeck.test.ts`
Expected: PASS — all 4 tests green

- [ ] **Step 5: Register routes in HTTP index**

Add to `src/main/http/index.ts`:

Import at the top:

```typescript
import { registerStreamDeckRoutes, type StreamDeckRouteServices } from './streamdeck';
```

Add `streamDeckServices: StreamDeckRouteServices` to the function parameters or extract it from the existing services object. Add the registration call inside `registerHttpRoutes`:

```typescript
registerStreamDeckRoutes(app, streamDeckServices);
```

Note: The exact wiring depends on how `HttpServices` is extended. The `sessionStateTracker` comes from `ServiceContext` and `mainWindow` from the Electron app's main window reference. Review `src/main/index.ts` to see where `registerHttpRoutes` is called and pass the additional services there.

- [ ] **Step 6: Run typecheck and full test suite**

Run: `pnpm typecheck && pnpm test`
Expected: PASS

- [ ] **Step 7: Commit**

```bash
git add src/main/http/streamdeck.ts src/main/http/index.ts test/main/http/streamdeck.test.ts
git commit -m "feat(streamdeck): add HTTP/SSE endpoints for StreamDeck integration"
```

---

## Task 5: StreamDeck Plugin — Package Scaffolding

**Files:**
- Create: `streamdeck-plugin/package.json`
- Create: `streamdeck-plugin/tsconfig.json`
- Create: `streamdeck-plugin/manifest.json`
- Create: `streamdeck-plugin/src/config/defaults.ts`

- [ ] **Step 1: Create package.json**

```json
{
  "name": "claude-devtools-streamdeck",
  "version": "0.1.0",
  "description": "StreamDeck plugin for claude-devtools session monitoring",
  "main": "dist/plugin.js",
  "scripts": {
    "build": "tsc",
    "dev": "tsc --watch",
    "test": "vitest run",
    "test:watch": "vitest watch",
    "typecheck": "tsc --noEmit"
  },
  "dependencies": {
    "@elgato/streamdeck": "^2.0.0",
    "@napi-rs/canvas": "^0.1.0",
    "eventsource": "^3.0.0"
  },
  "devDependencies": {
    "typescript": "^5.9.0",
    "vitest": "^3.1.0",
    "@types/node": "^20.0.0",
    "@types/eventsource": "^1.1.0"
  }
}
```

- [ ] **Step 2: Create tsconfig.json**

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "CommonJS",
    "moduleResolution": "node",
    "outDir": "dist",
    "rootDir": "src",
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "declaration": true,
    "sourceMap": true
  },
  "include": ["src/**/*.ts"],
  "exclude": ["node_modules", "dist", "test"]
}
```

- [ ] **Step 3: Create manifest.json**

```json
{
  "Name": "Claude Devtools",
  "Version": "0.1.0",
  "Author": "claude-devtools",
  "Description": "Monitor Claude Code sessions with real-time status on your StreamDeck keys",
  "Category": "Developer Tools",
  "Icon": "assets/icons/plugin-icon",
  "CodePath": "dist/plugin.js",
  "OS": [
    { "Platform": "mac", "MinimumVersion": "10.15" },
    { "Platform": "windows", "MinimumVersion": "10" }
  ],
  "Software": {
    "MinimumVersion": "6.0"
  },
  "SDKVersion": 2,
  "Actions": [
    {
      "Name": "Session Monitor",
      "UUID": "com.claude-devtools.session-monitor",
      "Icon": "assets/icons/action-icon",
      "Tooltip": "Monitor a Claude Code project session",
      "PropertyInspectorPath": "property-inspector/index.html",
      "States": [
        {
          "Image": "assets/icons/state-default"
        }
      ]
    }
  ]
}
```

- [ ] **Step 4: Create defaults config**

```typescript
// streamdeck-plugin/src/config/defaults.ts

export interface KeySettings {
  projectPath: string;
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
  isOverflowKey: false,
  displayMode: 'name-count',
  colors: {
    idle: '#22c55e',
    working: '#3b82f6',
    waiting: '#f59e0b',
    disconnected: '#71717a',
  },
  blinkStyle: 'toggle',
  blinkIntervalMs: 500,
  actions: {
    idle: 'open-devtools',
    working: 'open-devtools',
    waiting: 'open-terminal',
  },
  serverUrl: 'http://localhost:24462',
};

export type SessionActivityState = 'idle' | 'working' | 'waiting-for-input';

export interface SessionState {
  sessionId: string;
  projectPath: string;
  projectName: string;
  state: SessionActivityState;
  sessionCount: number;
  updatedAt: number;
}
```

- [ ] **Step 5: Commit**

```bash
git add streamdeck-plugin/
git commit -m "feat(streamdeck): scaffold StreamDeck plugin package"
```

---

## Task 6: StreamDeck Plugin — Transport Layer

**Files:**
- Create: `streamdeck-plugin/src/transport/StateTransport.ts`
- Create: `streamdeck-plugin/src/transport/SseTransport.ts`
- Create: `streamdeck-plugin/test/transport/SseTransport.test.ts`

- [ ] **Step 1: Write the transport interface**

```typescript
// streamdeck-plugin/src/transport/StateTransport.ts
import type { SessionState } from '../config/defaults';

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
```

- [ ] **Step 2: Write failing tests for SseTransport**

```typescript
// streamdeck-plugin/test/transport/SseTransport.test.ts
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { SseTransport } from '../../src/transport/SseTransport';

// We test the reconnection logic and state management without a real server
describe('SseTransport', () => {
  let transport: SseTransport;

  beforeEach(() => {
    transport = new SseTransport();
  });

  afterEach(() => {
    transport.disconnect();
  });

  it('should start disconnected', () => {
    expect(transport.isConnected()).toBe(false);
  });

  it('should register state change callbacks', () => {
    const callback = vi.fn();
    transport.onStateChange(callback);
    // Internally stored — verified by checking no throw
    expect(() => transport.onStateChange(callback)).not.toThrow();
  });

  it('should register connection change callbacks', () => {
    const callback = vi.fn();
    transport.onConnectionChange(callback);
    expect(() => transport.onConnectionChange(callback)).not.toThrow();
  });

  it('should calculate exponential backoff correctly', () => {
    // Access internal method for testing
    expect(transport.calculateBackoff(0)).toBe(1000);
    expect(transport.calculateBackoff(1)).toBe(2000);
    expect(transport.calculateBackoff(2)).toBe(4000);
    expect(transport.calculateBackoff(3)).toBe(8000);
    expect(transport.calculateBackoff(4)).toBe(16000);
    expect(transport.calculateBackoff(5)).toBe(30000); // capped at max
    expect(transport.calculateBackoff(10)).toBe(30000); // stays capped
  });

  it('should clean up on disconnect', () => {
    transport.connect('http://localhost:99999');
    transport.disconnect();
    expect(transport.isConnected()).toBe(false);
  });
});
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `cd streamdeck-plugin && npx vitest run test/transport/SseTransport.test.ts`
Expected: FAIL — module does not exist

- [ ] **Step 4: Implement SseTransport**

```typescript
// streamdeck-plugin/src/transport/SseTransport.ts
import type { StateTransport, ActionResult } from './StateTransport';
import type { SessionState } from '../config/defaults';

const BASE_BACKOFF_MS = 1000;
const MAX_BACKOFF_MS = 30_000;
const POLL_INTERVAL_MS = 5000;

export class SseTransport implements StateTransport {
  private eventSource: EventSource | null = null;
  private connected = false;
  private reconnectAttempt = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private pollTimer: ReturnType<typeof setInterval> | null = null;
  private baseUrl = '';
  private stateCallbacks: Array<(sessions: SessionState[]) => void> = [];
  private connectionCallbacks: Array<(connected: boolean) => void> = [];

  connect(url: string): void {
    this.baseUrl = url;
    this.reconnectAttempt = 0;
    this.connectSSE();
  }

  disconnect(): void {
    if (this.eventSource) {
      this.eventSource.close();
      this.eventSource = null;
    }
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
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
    try {
      const response = await fetch(`${this.baseUrl}/api/streamdeck/action`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sessionId, action }),
      });
      return (await response.json()) as ActionResult;
    } catch (error) {
      return { success: false, error: String(error) };
    }
  }

  isConnected(): boolean {
    return this.connected;
  }

  /** Exposed for testing */
  calculateBackoff(attempt: number): number {
    return Math.min(BASE_BACKOFF_MS * Math.pow(2, attempt), MAX_BACKOFF_MS);
  }

  private connectSSE(): void {
    try {
      this.eventSource = new EventSource(`${this.baseUrl}/api/streamdeck/events`);

      this.eventSource.addEventListener('session-state-change', (event: MessageEvent) => {
        try {
          const data = JSON.parse(event.data);
          const sessions = data.sessions as SessionState[];
          for (const cb of this.stateCallbacks) {
            cb(sessions);
          }
        } catch {
          // Ignore malformed events
        }
      });

      this.eventSource.onopen = () => {
        this.reconnectAttempt = 0;
        this.setConnected(true);
        this.stopPolling();
      };

      this.eventSource.onerror = () => {
        this.eventSource?.close();
        this.eventSource = null;
        this.setConnected(false);
        this.startPolling();
        this.scheduleReconnect();
      };
    } catch {
      this.setConnected(false);
      this.startPolling();
      this.scheduleReconnect();
    }
  }

  private scheduleReconnect(): void {
    if (this.reconnectTimer) return;
    const delay = this.calculateBackoff(this.reconnectAttempt);
    this.reconnectAttempt++;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connectSSE();
    }, delay);
  }

  private startPolling(): void {
    if (this.pollTimer) return;
    this.pollTimer = setInterval(async () => {
      try {
        const response = await fetch(`${this.baseUrl}/api/streamdeck/state`);
        if (response.ok) {
          const sessions = (await response.json()) as SessionState[];
          for (const cb of this.stateCallbacks) {
            cb(sessions);
          }
        }
      } catch {
        // Polling failure — SSE reconnect will handle recovery
      }
    }, POLL_INTERVAL_MS);
  }

  private stopPolling(): void {
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
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
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `cd streamdeck-plugin && npx vitest run test/transport/SseTransport.test.ts`
Expected: PASS — all 5 tests green

- [ ] **Step 6: Commit**

```bash
git add streamdeck-plugin/src/transport/ streamdeck-plugin/test/transport/
git commit -m "feat(streamdeck): add StateTransport interface and SseTransport implementation"
```

---

## Task 7: StreamDeck Plugin — Key Rendering

**Files:**
- Create: `streamdeck-plugin/src/rendering/themes.ts`
- Create: `streamdeck-plugin/src/rendering/KeyRenderer.ts`
- Create: `streamdeck-plugin/test/rendering/KeyRenderer.test.ts`

- [ ] **Step 1: Create themes**

```typescript
// streamdeck-plugin/src/rendering/themes.ts

export const KEY_SIZE = 144;
export const FONT_SIZE = 16;
export const BADGE_SIZE = 28;
export const BADGE_FONT_SIZE = 14;
export const PADDING = 8;

export interface KeyTheme {
  backgroundColor: string;
  textColor: string;
  badgeColor: string;
  badgeTextColor: string;
}

export function getThemeForState(
  state: string,
  colors: { idle: string; working: string; waiting: string; disconnected: string },
): KeyTheme {
  const colorMap: Record<string, string> = {
    idle: colors.idle,
    working: colors.working,
    'waiting-for-input': colors.waiting,
    disconnected: colors.disconnected,
  };

  return {
    backgroundColor: colorMap[state] ?? colors.disconnected,
    textColor: '#ffffff',
    badgeColor: 'rgba(0, 0, 0, 0.4)',
    badgeTextColor: '#ffffff',
  };
}
```

- [ ] **Step 2: Write failing tests for KeyRenderer**

```typescript
// streamdeck-plugin/test/rendering/KeyRenderer.test.ts
import { describe, expect, it } from 'vitest';
import { KeyRenderer } from '../../src/rendering/KeyRenderer';
import { DEFAULT_KEY_SETTINGS } from '../../src/config/defaults';

describe('KeyRenderer', () => {
  const renderer = new KeyRenderer();

  it('should render a key image as base64 PNG string', async () => {
    const image = await renderer.render({
      projectName: 'devtools',
      state: 'idle',
      sessionCount: 1,
      settings: DEFAULT_KEY_SETTINGS,
    });

    // Should be a base64-encoded PNG
    expect(typeof image).toBe('string');
    expect(image.length).toBeGreaterThan(0);
  });

  it('should render different images for different states', async () => {
    const idle = await renderer.render({
      projectName: 'devtools',
      state: 'idle',
      sessionCount: 1,
      settings: DEFAULT_KEY_SETTINGS,
    });

    const working = await renderer.render({
      projectName: 'devtools',
      state: 'working',
      sessionCount: 1,
      settings: DEFAULT_KEY_SETTINGS,
    });

    expect(idle).not.toBe(working);
  });

  it('should include badge when session count > 1', async () => {
    const withBadge = await renderer.render({
      projectName: 'devtools',
      state: 'working',
      sessionCount: 3,
      settings: { ...DEFAULT_KEY_SETTINGS, displayMode: 'name-count' },
    });

    const withoutBadge = await renderer.render({
      projectName: 'devtools',
      state: 'working',
      sessionCount: 1,
      settings: { ...DEFAULT_KEY_SETTINGS, displayMode: 'name-count' },
    });

    // Images should differ when badge is present
    expect(withBadge).not.toBe(withoutBadge);
  });

  it('should render disconnected state', async () => {
    const image = await renderer.render({
      projectName: 'devtools',
      state: 'disconnected',
      sessionCount: 0,
      settings: DEFAULT_KEY_SETTINGS,
    });

    expect(typeof image).toBe('string');
    expect(image.length).toBeGreaterThan(0);
  });
});
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `cd streamdeck-plugin && npx vitest run test/rendering/KeyRenderer.test.ts`
Expected: FAIL — module does not exist

- [ ] **Step 4: Implement KeyRenderer**

```typescript
// streamdeck-plugin/src/rendering/KeyRenderer.ts
import { createCanvas } from '@napi-rs/canvas';
import { KEY_SIZE, FONT_SIZE, BADGE_SIZE, BADGE_FONT_SIZE, PADDING, getThemeForState } from './themes';
import type { KeySettings, SessionActivityState } from '../config/defaults';

export interface RenderOptions {
  projectName: string;
  state: SessionActivityState | 'disconnected';
  sessionCount: number;
  settings: KeySettings;
}

export class KeyRenderer {
  async render(options: RenderOptions): Promise<string> {
    const { projectName, state, sessionCount, settings } = options;
    const theme = getThemeForState(state, settings.colors);

    const canvas = createCanvas(KEY_SIZE, KEY_SIZE);
    const ctx = canvas.getContext('2d');

    // Background
    ctx.fillStyle = theme.backgroundColor;
    ctx.fillRect(0, 0, KEY_SIZE, KEY_SIZE);

    // Project name — truncate to fit
    ctx.fillStyle = theme.textColor;
    ctx.font = `bold ${FONT_SIZE}px sans-serif`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';

    const displayName = this.truncateText(ctx, projectName, KEY_SIZE - PADDING * 2);
    const textY = sessionCount > 1 && settings.displayMode !== 'name'
      ? KEY_SIZE / 2 + 4
      : KEY_SIZE / 2;
    ctx.fillText(displayName, KEY_SIZE / 2, textY);

    // Status text for name-status mode
    if (settings.displayMode === 'name-status') {
      ctx.font = `${FONT_SIZE - 4}px sans-serif`;
      ctx.fillStyle = 'rgba(255, 255, 255, 0.7)';
      const statusText = state === 'waiting-for-input' ? 'waiting' : state;
      ctx.fillText(statusText, KEY_SIZE / 2, textY + FONT_SIZE + 4);
    }

    // Badge for session count (name-count mode, count > 1)
    if (sessionCount > 1 && settings.displayMode !== 'name') {
      const badgeX = KEY_SIZE - BADGE_SIZE / 2 - PADDING;
      const badgeY = BADGE_SIZE / 2 + PADDING;

      ctx.beginPath();
      ctx.arc(badgeX, badgeY, BADGE_SIZE / 2, 0, Math.PI * 2);
      ctx.fillStyle = theme.badgeColor;
      ctx.fill();

      ctx.fillStyle = theme.badgeTextColor;
      ctx.font = `bold ${BADGE_FONT_SIZE}px sans-serif`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(String(sessionCount), badgeX, badgeY);
    }

    // Return as base64 PNG
    const buffer = canvas.toBuffer('image/png');
    return buffer.toString('base64');
  }

  private truncateText(
    ctx: CanvasRenderingContext2D,
    text: string,
    maxWidth: number,
  ): string {
    const metrics = ctx.measureText(text);
    if (metrics.width <= maxWidth) return text;

    let truncated = text;
    while (truncated.length > 0) {
      truncated = truncated.slice(0, -1);
      if (ctx.measureText(truncated + '…').width <= maxWidth) {
        return truncated + '…';
      }
    }
    return '…';
  }
}
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `cd streamdeck-plugin && npx vitest run test/rendering/KeyRenderer.test.ts`
Expected: PASS — all 4 tests green

- [ ] **Step 6: Commit**

```bash
git add streamdeck-plugin/src/rendering/ streamdeck-plugin/test/rendering/KeyRenderer.test.ts
git commit -m "feat(streamdeck): add KeyRenderer with Canvas-based key image generation"
```

---

## Task 8: StreamDeck Plugin — BlinkController

**Files:**
- Create: `streamdeck-plugin/src/rendering/BlinkController.ts`
- Create: `streamdeck-plugin/test/rendering/BlinkController.test.ts`

- [ ] **Step 1: Write failing tests**

```typescript
// streamdeck-plugin/test/rendering/BlinkController.test.ts
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { BlinkController } from '../../src/rendering/BlinkController';

describe('BlinkController', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('should not be blinking initially', () => {
    const controller = new BlinkController();
    expect(controller.isBlinking()).toBe(false);
  });

  it('should call the toggle callback at the specified interval', () => {
    const controller = new BlinkController();
    const onToggle = vi.fn();

    controller.start(500, onToggle);
    expect(controller.isBlinking()).toBe(true);

    vi.advanceTimersByTime(500);
    expect(onToggle).toHaveBeenCalledTimes(1);
    expect(onToggle).toHaveBeenCalledWith(true); // first toggle = "on"

    vi.advanceTimersByTime(500);
    expect(onToggle).toHaveBeenCalledTimes(2);
    expect(onToggle).toHaveBeenCalledWith(false); // second toggle = "off"

    vi.advanceTimersByTime(500);
    expect(onToggle).toHaveBeenCalledTimes(3);
    expect(onToggle).toHaveBeenCalledWith(true); // alternates

    controller.stop();
  });

  it('should stop blinking when stop is called', () => {
    const controller = new BlinkController();
    const onToggle = vi.fn();

    controller.start(500, onToggle);
    controller.stop();

    expect(controller.isBlinking()).toBe(false);

    vi.advanceTimersByTime(2000);
    expect(onToggle).toHaveBeenCalledTimes(0);
  });

  it('should restart cleanly if start is called while already blinking', () => {
    const controller = new BlinkController();
    const onToggle1 = vi.fn();
    const onToggle2 = vi.fn();

    controller.start(500, onToggle1);
    vi.advanceTimersByTime(500);
    expect(onToggle1).toHaveBeenCalledTimes(1);

    // Restart with new callback
    controller.start(250, onToggle2);
    vi.advanceTimersByTime(250);

    expect(onToggle2).toHaveBeenCalledTimes(1);
    // Old callback should not fire again
    vi.advanceTimersByTime(500);
    expect(onToggle1).toHaveBeenCalledTimes(1); // still 1
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd streamdeck-plugin && npx vitest run test/rendering/BlinkController.test.ts`
Expected: FAIL — module does not exist

- [ ] **Step 3: Implement BlinkController**

```typescript
// streamdeck-plugin/src/rendering/BlinkController.ts

export class BlinkController {
  private timer: ReturnType<typeof setInterval> | null = null;
  private toggleState = false;

  isBlinking(): boolean {
    return this.timer !== null;
  }

  start(intervalMs: number, onToggle: (isOn: boolean) => void): void {
    this.stop();
    this.toggleState = false;

    this.timer = setInterval(() => {
      this.toggleState = !this.toggleState;
      onToggle(this.toggleState);
    }, intervalMs);
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    this.toggleState = false;
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd streamdeck-plugin && npx vitest run test/rendering/BlinkController.test.ts`
Expected: PASS — all 4 tests green

- [ ] **Step 5: Commit**

```bash
git add streamdeck-plugin/src/rendering/BlinkController.ts streamdeck-plugin/test/rendering/BlinkController.test.ts
git commit -m "feat(streamdeck): add BlinkController for key animation timing"
```

---

## Task 9: StreamDeck Plugin — SessionMonitorAction

**Files:**
- Create: `streamdeck-plugin/src/actions/SessionMonitorAction.ts`
- Create: `streamdeck-plugin/test/actions/SessionMonitorAction.test.ts`

- [ ] **Step 1: Write failing tests**

```typescript
// streamdeck-plugin/test/actions/SessionMonitorAction.test.ts
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { SessionMonitorAction } from '../../src/actions/SessionMonitorAction';
import { DEFAULT_KEY_SETTINGS } from '../../src/config/defaults';
import type { SessionState } from '../../src/config/defaults';

// Mock the StreamDeck action context
function createMockActionContext() {
  return {
    setImage: vi.fn(),
    setTitle: vi.fn(),
    getSettings: vi.fn(() => DEFAULT_KEY_SETTINGS),
    showAlert: vi.fn(),
  };
}

function createMockTransport() {
  const stateCallbacks: Array<(sessions: SessionState[]) => void> = [];
  const connectionCallbacks: Array<(connected: boolean) => void> = [];
  return {
    connect: vi.fn(),
    disconnect: vi.fn(),
    onStateChange: vi.fn((cb) => stateCallbacks.push(cb)),
    onConnectionChange: vi.fn((cb) => connectionCallbacks.push(cb)),
    sendAction: vi.fn(async () => ({ success: true })),
    isConnected: vi.fn(() => true),
    // Helpers for testing
    _emitState: (sessions: SessionState[]) => stateCallbacks.forEach((cb) => cb(sessions)),
    _emitConnection: (connected: boolean) => connectionCallbacks.forEach((cb) => cb(connected)),
  };
}

function createMockRenderer() {
  return {
    render: vi.fn(async () => 'base64-image-data'),
  };
}

describe('SessionMonitorAction', () => {
  it('should bind to a project and show its state', async () => {
    const transport = createMockTransport();
    const renderer = createMockRenderer();
    const context = createMockActionContext();

    const action = new SessionMonitorAction(transport, renderer as any);
    action.setContext(context as any);
    action.setSettings({ ...DEFAULT_KEY_SETTINGS, projectPath: '/test/project' });

    // Simulate state update
    transport._emitState([
      {
        sessionId: 'session-1',
        projectPath: '/test/project',
        projectName: 'test-project',
        state: 'working',
        sessionCount: 1,
        updatedAt: Date.now(),
      },
    ]);

    // Wait for async render
    await vi.waitFor(() => {
      expect(renderer.render).toHaveBeenCalledWith(
        expect.objectContaining({
          projectName: 'test-project',
          state: 'working',
          sessionCount: 1,
        }),
      );
    });
  });

  it('should show disconnected state when transport disconnects', async () => {
    const transport = createMockTransport();
    const renderer = createMockRenderer();
    const context = createMockActionContext();

    const action = new SessionMonitorAction(transport, renderer as any);
    action.setContext(context as any);
    action.setSettings({ ...DEFAULT_KEY_SETTINGS, projectPath: '/test/project' });

    transport._emitConnection(false);

    await vi.waitFor(() => {
      expect(renderer.render).toHaveBeenCalledWith(
        expect.objectContaining({
          state: 'disconnected',
        }),
      );
    });
  });

  it('should filter sessions by configured project path', async () => {
    const transport = createMockTransport();
    const renderer = createMockRenderer();
    const context = createMockActionContext();

    const action = new SessionMonitorAction(transport, renderer as any);
    action.setContext(context as any);
    action.setSettings({ ...DEFAULT_KEY_SETTINGS, projectPath: '/test/project-a' });

    transport._emitState([
      {
        sessionId: 'session-1',
        projectPath: '/test/project-a',
        projectName: 'project-a',
        state: 'idle',
        sessionCount: 1,
        updatedAt: Date.now(),
      },
      {
        sessionId: 'session-2',
        projectPath: '/test/project-b',
        projectName: 'project-b',
        state: 'working',
        sessionCount: 1,
        updatedAt: Date.now(),
      },
    ]);

    await vi.waitFor(() => {
      expect(renderer.render).toHaveBeenCalledWith(
        expect.objectContaining({
          projectName: 'project-a',
          state: 'idle',
        }),
      );
    });
  });

  it('should send configured action on key press', async () => {
    const transport = createMockTransport();
    const renderer = createMockRenderer();
    const context = createMockActionContext();

    const action = new SessionMonitorAction(transport, renderer as any);
    action.setContext(context as any);
    action.setSettings({ ...DEFAULT_KEY_SETTINGS, projectPath: '/test/project' });

    // Set current state to working
    transport._emitState([
      {
        sessionId: 'session-1',
        projectPath: '/test/project',
        projectName: 'test-project',
        state: 'working',
        sessionCount: 1,
        updatedAt: Date.now(),
      },
    ]);

    await action.onKeyDown();

    expect(transport.sendAction).toHaveBeenCalledWith('session-1', 'open-devtools');
  });

  it('should send waiting action when state is waiting-for-input', async () => {
    const transport = createMockTransport();
    const renderer = createMockRenderer();
    const context = createMockActionContext();

    const action = new SessionMonitorAction(transport, renderer as any);
    action.setContext(context as any);
    action.setSettings({ ...DEFAULT_KEY_SETTINGS, projectPath: '/test/project' });

    transport._emitState([
      {
        sessionId: 'session-1',
        projectPath: '/test/project',
        projectName: 'test-project',
        state: 'waiting-for-input',
        sessionCount: 1,
        updatedAt: Date.now(),
      },
    ]);

    await action.onKeyDown();

    expect(transport.sendAction).toHaveBeenCalledWith('session-1', 'open-terminal');
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd streamdeck-plugin && npx vitest run test/actions/SessionMonitorAction.test.ts`
Expected: FAIL — module does not exist

- [ ] **Step 3: Implement SessionMonitorAction**

```typescript
// streamdeck-plugin/src/actions/SessionMonitorAction.ts
import type { StateTransport } from '../transport/StateTransport';
import type { KeyRenderer, RenderOptions } from '../rendering/KeyRenderer';
import { BlinkController } from '../rendering/BlinkController';
import type { KeySettings, SessionState, SessionActivityState } from '../config/defaults';
import { DEFAULT_KEY_SETTINGS } from '../config/defaults';

interface ActionContext {
  setImage(base64: string): void;
  setTitle(title: string): void;
  getSettings(): KeySettings;
  showAlert(): void;
}

export class SessionMonitorAction {
  private context: ActionContext | null = null;
  private settings: KeySettings = DEFAULT_KEY_SETTINGS;
  private currentSessions: SessionState[] = [];
  private boundSession: SessionState | null = null;
  private blinkController = new BlinkController();
  private lastRenderedImage = '';

  constructor(
    private readonly transport: StateTransport,
    private readonly renderer: KeyRenderer,
  ) {
    this.transport.onStateChange(this.handleStateChange.bind(this));
    this.transport.onConnectionChange(this.handleConnectionChange.bind(this));
  }

  setContext(context: ActionContext): void {
    this.context = context;
  }

  setSettings(settings: KeySettings): void {
    this.settings = { ...DEFAULT_KEY_SETTINGS, ...settings };
    this.updateDisplay();
  }

  async onKeyDown(): Promise<void> {
    if (!this.boundSession) return;

    const state = this.boundSession.state;
    const actionMap = this.settings.actions;
    const action = actionMap[state === 'waiting-for-input' ? 'waiting' : state];

    if (action && action !== 'none') {
      const result = await this.transport.sendAction(this.boundSession.sessionId, action);
      if (!result.success) {
        this.context?.showAlert();
      }
    }
  }

  dispose(): void {
    this.blinkController.stop();
  }

  private handleStateChange(sessions: SessionState[]): void {
    this.currentSessions = sessions;
    this.updateBoundSession();
    this.updateDisplay();
  }

  private handleConnectionChange(connected: boolean): void {
    if (!connected) {
      this.boundSession = null;
      this.renderKey('disconnected', 'offline', 0);
    }
  }

  private updateBoundSession(): void {
    // Find sessions matching this key's project
    const matching = this.currentSessions.filter(
      (s) => s.projectPath === this.settings.projectPath,
    );

    if (matching.length === 0) {
      this.boundSession = null;
      return;
    }

    // Bind to the most recently updated session
    this.boundSession = matching.reduce((latest, s) =>
      s.updatedAt > latest.updatedAt ? s : latest,
    );

    // Update session count to reflect all matching sessions
    this.boundSession = {
      ...this.boundSession,
      sessionCount: matching.length,
    };
  }

  private updateDisplay(): void {
    if (!this.boundSession) {
      this.blinkController.stop();
      this.renderKey('idle', this.settings.projectPath ? 'no session' : 'configure', 0);
      return;
    }

    const { state, projectName, sessionCount } = this.boundSession;

    if (state === 'waiting-for-input') {
      this.startBlinking(projectName, sessionCount);
    } else {
      this.blinkController.stop();
      this.renderKey(state, projectName, sessionCount);
    }
  }

  private startBlinking(projectName: string, sessionCount: number): void {
    if (this.blinkController.isBlinking()) return;

    this.blinkController.start(this.settings.blinkIntervalMs, (isOn: boolean) => {
      if (isOn) {
        this.renderKey('waiting-for-input', projectName, sessionCount);
      } else {
        // "Off" state — render with dimmed/dark background
        this.renderKey('disconnected', projectName, sessionCount);
      }
    });

    // Render initial "on" state immediately
    this.renderKey('waiting-for-input', projectName, sessionCount);
  }

  private async renderKey(
    state: SessionActivityState | 'disconnected',
    projectName: string,
    sessionCount: number,
  ): Promise<void> {
    try {
      const image = await this.renderer.render({
        projectName,
        state,
        sessionCount,
        settings: this.settings,
      });

      if (image !== this.lastRenderedImage) {
        this.lastRenderedImage = image;
        this.context?.setImage(image);
      }
    } catch {
      // Render failure — don't crash the plugin
    }
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd streamdeck-plugin && npx vitest run test/actions/SessionMonitorAction.test.ts`
Expected: PASS — all 5 tests green

- [ ] **Step 5: Commit**

```bash
git add streamdeck-plugin/src/actions/ streamdeck-plugin/test/actions/
git commit -m "feat(streamdeck): add SessionMonitorAction with project binding and key press handling"
```

---

## Task 10: StreamDeck Plugin — Entry Point and Property Inspector

**Files:**
- Create: `streamdeck-plugin/src/plugin.ts`
- Create: `streamdeck-plugin/property-inspector/index.html`

- [ ] **Step 1: Create the plugin entry point**

```typescript
// streamdeck-plugin/src/plugin.ts
import streamDeck, { LogLevel } from '@elgato/streamdeck';
import { SessionMonitorAction } from './actions/SessionMonitorAction';
import { SseTransport } from './transport/SseTransport';
import { KeyRenderer } from './rendering/KeyRenderer';
import { DEFAULT_KEY_SETTINGS } from './config/defaults';

// Configure logging
streamDeck.logger.setLevel(LogLevel.DEBUG);

// Shared instances — one transport and renderer for all keys
const transport = new SseTransport();
const renderer = new KeyRenderer();

// Register the Session Monitor action
streamDeck.actions.registerAction(
  'com.claude-devtools.session-monitor',
  {
    onWillAppear: (ev) => {
      const action = new SessionMonitorAction(transport, renderer);
      const settings = { ...DEFAULT_KEY_SETTINGS, ...ev.payload.settings };

      action.setContext({
        setImage: (base64: string) => ev.action.setImage(`data:image/png;base64,${base64}`),
        setTitle: (title: string) => ev.action.setTitle(title),
        getSettings: () => settings,
        showAlert: () => ev.action.showAlert(),
      });

      action.setSettings(settings);

      // Connect transport if not already connected
      if (!transport.isConnected()) {
        transport.connect(settings.serverUrl);
      }

      // Store action reference for cleanup
      (ev.action as any).__sessionMonitor = action;
    },

    onWillDisappear: (ev) => {
      const action = (ev.action as any).__sessionMonitor as SessionMonitorAction | undefined;
      action?.dispose();
    },

    onKeyDown: async (ev) => {
      const action = (ev.action as any).__sessionMonitor as SessionMonitorAction | undefined;
      await action?.onKeyDown();
    },

    onDidReceiveSettings: (ev) => {
      const action = (ev.action as any).__sessionMonitor as SessionMonitorAction | undefined;
      const settings = { ...DEFAULT_KEY_SETTINGS, ...ev.payload.settings };
      action?.setSettings(settings);
    },
  },
);

// Connect and run
streamDeck.connect();
```

- [ ] **Step 2: Create the Property Inspector HTML**

```html
<!-- streamdeck-plugin/property-inspector/index.html -->
<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8" />
  <title>Session Monitor Settings</title>
  <link rel="stylesheet" href="https://sdpi-components.dev/css/sdpi.css" />
  <style>
    body { font-family: -apple-system, BlinkMacSystemFont, sans-serif; padding: 8px; }
    .sdpi-wrapper { margin-bottom: 8px; }
    label { font-size: 12px; color: #999; }
    select, input { width: 100%; padding: 4px 8px; margin-top: 4px; }
    h3 { font-size: 13px; margin: 16px 0 8px; color: #ccc; border-bottom: 1px solid #333; padding-bottom: 4px; }
  </style>
</head>
<body>
  <h3>Project Binding</h3>

  <div class="sdpi-wrapper">
    <label for="projectPath">Project</label>
    <select id="projectPath">
      <option value="">Select a project...</option>
    </select>
  </div>

  <div class="sdpi-wrapper">
    <label>
      <input type="checkbox" id="isOverflowKey" />
      Available as overflow key
    </label>
  </div>

  <h3>Display</h3>

  <div class="sdpi-wrapper">
    <label for="displayMode">Display Mode</label>
    <select id="displayMode">
      <option value="name">Project Name Only</option>
      <option value="name-count" selected>Name + Session Count</option>
      <option value="name-status">Name + Status</option>
    </select>
  </div>

  <h3>Colors</h3>

  <div class="sdpi-wrapper">
    <label for="colorIdle">Idle</label>
    <input type="color" id="colorIdle" value="#22c55e" />
  </div>

  <div class="sdpi-wrapper">
    <label for="colorWorking">Working</label>
    <input type="color" id="colorWorking" value="#3b82f6" />
  </div>

  <div class="sdpi-wrapper">
    <label for="colorWaiting">Waiting for Input</label>
    <input type="color" id="colorWaiting" value="#f59e0b" />
  </div>

  <h3>Blink Animation</h3>

  <div class="sdpi-wrapper">
    <label for="blinkStyle">Blink Style</label>
    <select id="blinkStyle">
      <option value="pulse">Color Pulse</option>
      <option value="toggle" selected>Two-State Blink</option>
      <option value="icon-overlay">Icon Overlay</option>
    </select>
  </div>

  <div class="sdpi-wrapper">
    <label for="blinkIntervalMs">Blink Speed (ms)</label>
    <input type="number" id="blinkIntervalMs" value="500" min="100" max="2000" step="50" />
  </div>

  <h3>Key Press Actions</h3>

  <div class="sdpi-wrapper">
    <label for="actionIdle">When Idle</label>
    <select id="actionIdle">
      <option value="open-devtools" selected>Open Devtools</option>
      <option value="open-terminal">Open Terminal</option>
      <option value="none">No Action</option>
    </select>
  </div>

  <div class="sdpi-wrapper">
    <label for="actionWorking">When Working</label>
    <select id="actionWorking">
      <option value="open-devtools" selected>Open Devtools</option>
      <option value="open-terminal">Open Terminal</option>
      <option value="none">No Action</option>
    </select>
  </div>

  <div class="sdpi-wrapper">
    <label for="actionWaiting">When Waiting for Input</label>
    <select id="actionWaiting">
      <option value="open-devtools">Open Devtools</option>
      <option value="open-terminal" selected>Open Terminal</option>
      <option value="none">No Action</option>
    </select>
  </div>

  <h3>Connection</h3>

  <div class="sdpi-wrapper">
    <label for="serverUrl">Server URL</label>
    <input type="text" id="serverUrl" value="http://localhost:24462" />
  </div>

  <script>
    // StreamDeck Property Inspector SDK communication
    let websocket = null;
    let pluginUUID = null;
    let actionInfo = null;
    let settings = {};

    function connectElgatoStreamDeckSocket(inPort, inPluginUUID, inRegisterEvent, inInfo, inActionInfo) {
      pluginUUID = inPluginUUID;
      actionInfo = JSON.parse(inActionInfo);
      settings = actionInfo.payload.settings || {};

      websocket = new WebSocket('ws://127.0.0.1:' + inPort);

      websocket.onopen = function() {
        websocket.send(JSON.stringify({ event: inRegisterEvent, uuid: inPluginUUID }));
        loadSettings();
        loadProjects();
      };

      websocket.onmessage = function(evt) {
        const data = JSON.parse(evt.data);
        if (data.event === 'didReceiveSettings') {
          settings = data.payload.settings || {};
          loadSettings();
        }
      };
    }

    function loadSettings() {
      document.getElementById('projectPath').value = settings.projectPath || '';
      document.getElementById('isOverflowKey').checked = settings.isOverflowKey || false;
      document.getElementById('displayMode').value = settings.displayMode || 'name-count';
      document.getElementById('colorIdle').value = settings.colors?.idle || '#22c55e';
      document.getElementById('colorWorking').value = settings.colors?.working || '#3b82f6';
      document.getElementById('colorWaiting').value = settings.colors?.waiting || '#f59e0b';
      document.getElementById('blinkStyle').value = settings.blinkStyle || 'toggle';
      document.getElementById('blinkIntervalMs').value = settings.blinkIntervalMs || 500;
      document.getElementById('actionIdle').value = settings.actions?.idle || 'open-devtools';
      document.getElementById('actionWorking').value = settings.actions?.working || 'open-devtools';
      document.getElementById('actionWaiting').value = settings.actions?.waiting || 'open-terminal';
      document.getElementById('serverUrl').value = settings.serverUrl || 'http://localhost:24462';
    }

    function saveSettings() {
      settings = {
        projectPath: document.getElementById('projectPath').value,
        isOverflowKey: document.getElementById('isOverflowKey').checked,
        displayMode: document.getElementById('displayMode').value,
        colors: {
          idle: document.getElementById('colorIdle').value,
          working: document.getElementById('colorWorking').value,
          waiting: document.getElementById('colorWaiting').value,
          disconnected: '#71717a',
        },
        blinkStyle: document.getElementById('blinkStyle').value,
        blinkIntervalMs: parseInt(document.getElementById('blinkIntervalMs').value) || 500,
        actions: {
          idle: document.getElementById('actionIdle').value,
          working: document.getElementById('actionWorking').value,
          waiting: document.getElementById('actionWaiting').value,
        },
        serverUrl: document.getElementById('serverUrl').value,
      };

      if (websocket) {
        websocket.send(JSON.stringify({
          event: 'setSettings',
          context: pluginUUID,
          payload: settings,
        }));
      }
    }

    async function loadProjects() {
      const serverUrl = document.getElementById('serverUrl').value || 'http://localhost:24462';
      try {
        const response = await fetch(serverUrl + '/api/projects');
        const projects = await response.json();
        const select = document.getElementById('projectPath');

        // Keep the first "Select..." option
        while (select.options.length > 1) select.remove(1);

        projects.forEach(function(project) {
          const option = document.createElement('option');
          option.value = project.path;
          option.text = project.name;
          select.add(option);
        });

        // Restore saved selection
        if (settings.projectPath) {
          select.value = settings.projectPath;
        }
      } catch (e) {
        console.error('Failed to load projects:', e);
      }
    }

    // Attach change listeners to all inputs
    document.addEventListener('DOMContentLoaded', function() {
      const inputs = document.querySelectorAll('input, select');
      inputs.forEach(function(input) {
        input.addEventListener('change', saveSettings);
      });
    });
  </script>
</body>
</html>
```

- [ ] **Step 3: Run typecheck on the plugin**

Run: `cd streamdeck-plugin && npx tsc --noEmit`
Expected: PASS

- [ ] **Step 4: Commit**

```bash
git add streamdeck-plugin/src/plugin.ts streamdeck-plugin/property-inspector/
git commit -m "feat(streamdeck): add plugin entry point and Property Inspector UI"
```

---

## Task 11: Integration Testing — End-to-End Verification

**Files:**
- Run existing tests + manual verification steps

- [ ] **Step 1: Run full Electron app test suite**

Run: `pnpm test`
Expected: PASS — all existing tests still green, plus new SessionStateTracker and endpoint tests

- [ ] **Step 2: Run typecheck on Electron app**

Run: `pnpm typecheck`
Expected: PASS

- [ ] **Step 3: Run StreamDeck plugin tests**

Run: `cd streamdeck-plugin && npx vitest run`
Expected: PASS — all plugin tests green

- [ ] **Step 4: Run StreamDeck plugin typecheck**

Run: `cd streamdeck-plugin && npx tsc --noEmit`
Expected: PASS

- [ ] **Step 5: Build Electron app**

Run: `pnpm build`
Expected: PASS — successful build with no errors

- [ ] **Step 6: Build StreamDeck plugin**

Run: `cd streamdeck-plugin && npx tsc`
Expected: PASS — compiled JS output in `streamdeck-plugin/dist/`

- [ ] **Step 7: Manual verification checklist**

Verify these by running the app (`pnpm dev`) and testing:

1. Start the Electron app — confirm no console errors related to SessionStateTracker
2. Open a Claude Code session in another terminal — confirm FileWatcher picks it up
3. `curl http://localhost:<port>/api/streamdeck/state` — should return JSON array with session state
4. `curl -N http://localhost:<port>/api/streamdeck/events` — should receive SSE events as session state changes
5. `curl -X POST http://localhost:<port>/api/streamdeck/action -H 'Content-Type: application/json' -d '{"sessionId":"test","action":"open-devtools"}'` — should return `{"success":true}`

- [ ] **Step 8: Final commit**

```bash
git add -A
git commit -m "feat(streamdeck): complete StreamDeck integration v0.1.0"
```
