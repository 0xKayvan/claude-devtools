# StreamDeck Integration — Design Spec

**Date:** 2026-03-31
**Status:** Draft

## Overview

Connect claude-devtools to Elgato StreamDeck hardware so that each monitored session is represented by a physical key whose background color reflects the session's real-time activity state. Keys are interactive — pressing them triggers configurable actions depending on the current state.

## Goals

1. When a session starts, a StreamDeck key is assigned to that session (bound by project, with overflow for concurrent sessions)
2. Idle sessions show a **green** background
3. Working sessions (Claude actively thinking/executing tools) show a **blue** background
4. Sessions waiting for user input (tool approval, questions) show an **amber blinking** background
5. Key presses trigger configurable per-state actions (open devtools, open terminal, etc.)

## Architecture

### Approach: Decoupled — Standalone StreamDeck plugin + HTTP/SSE bridge

Two independent systems:

- **Electron App**: Existing app gains a new `SessionStateTracker` service and dedicated SSE channel
- **StreamDeck Plugin**: Standalone Node.js package (`@elgato/streamdeck` SDK) that consumes the SSE stream and renders key visuals

Communication flows over HTTP/SSE (localhost only). The plugin uses a `StateTransport` abstraction so WebSocket can replace SSE later without changing plugin logic.

```
FileWatcher → SessionStateTracker → Fastify SSE → StreamDeck Plugin → Hardware
                                  → HTTP REST ↗     ↕
                                  ← HTTP POST ←   @elgato/streamdeck SDK
```

### Why Decoupled Over Monolithic

- Leverages existing Fastify HTTP/SSE infrastructure
- Clean separation — plugin doesn't need to know about Electron, chunks, or JSONL parsing
- Follows StreamDeck ecosystem conventions (plugins are standalone processes)
- Testable in isolation on both sides
- Natural path to WebSocket upgrade

## Session State Machine

### States

| State | Condition | Color | Default Key Press Action |
|-------|-----------|-------|--------------------------|
| `idle` | `isOngoing === false` OR stale (>5min no activity) | Green (`#22c55e`) | Open devtools |
| `working` | `isOngoing === true` AND last activity is thinking/tool_use/tool_result | Blue (`#3b82f6`) | Open devtools |
| `waiting-for-input` | `isOngoing === true` AND pending tool approval or unanswered question | Amber (`#f59e0b`) blinking | Open terminal |
| `disconnected` | Electron app not running or SSE connection lost | Gray (`#71717a`) | None |

### Detection Logic

**idle**: `checkMessagesOngoing()` returns false, or stale timeout exceeded.

**working**: `checkMessagesOngoing()` returns true with active tool/thinking activity after the last ending event.

**waiting-for-input** (new detection):
1. A `tool_use` block in the last assistant message with no corresponding `tool_result` → tool approval pending
2. The last assistant message ends with text output and no subsequent activity → Claude asked a question
3. An `AskUserQuestion` tool_use without a result → explicit question

### SessionStateTracker Service

New file: `src/main/services/infrastructure/SessionStateTracker.ts`

- Listens to FileWatcher `file-change` events
- Maintains `Map<sessionId, SessionState>` in memory
- Debounces at 200ms to avoid emitting on rapid intermediate states
- Emits `state-change` events only when a session's state actually transitions
- Exposes `getStates(): Map<sessionId, SessionState>` for the REST endpoint

```typescript
type SessionActivityState = 'idle' | 'working' | 'waiting-for-input';

interface SessionState {
  sessionId: string;
  projectPath: string;
  projectName: string;
  state: SessionActivityState;
  sessionCount: number;  // active sessions in same project
  updatedAt: number;     // timestamp of last state change
}
```

## HTTP/SSE Endpoints

Three new endpoints on the existing Fastify server:

### `GET /api/streamdeck/events` — SSE stream

- Channel: `session-state-change`
- Pushes full snapshot of all active sessions on every state transition (not deltas)
- Sends immediate snapshot on initial connection
- 30s keep-alive pings (matching existing SSE behavior)

```typescript
interface SessionStateEvent {
  type: 'session-state-change';
  sessions: SessionState[];
}
```

### `GET /api/streamdeck/state` — REST polling fallback

- Returns current `SessionState[]` for all active sessions
- Used on plugin startup or SSE reconnection

### `POST /api/streamdeck/action` — Key press handler

- Body: `{ sessionId: string, action: string }`
- Actions: `open-devtools`, `open-terminal`
- Returns `{ success: boolean, error?: string }`
- `open-devtools`: sends IPC to renderer to navigate to the session
- `open-terminal`: uses existing shell utility to open terminal app

### Transport Abstraction

The plugin consumes a transport interface, not SSE directly:

```typescript
interface StateTransport {
  connect(url: string): void;
  disconnect(): void;
  onStateChange(callback: (sessions: SessionState[]) => void): void;
  sendAction(sessionId: string, action: string): Promise<ActionResult>;
}
```

Ship `SseTransport` implementing this. `WebSocketTransport` can slot in later with zero changes to plugin logic.

## StreamDeck Plugin

### Package Structure

```
streamdeck-plugin/
├── package.json
├── tsconfig.json
├── manifest.json              # StreamDeck plugin manifest
├── src/
│   ├── plugin.ts              # Entry point — registers actions with SDK
│   ├── actions/
│   │   └── SessionMonitorAction.ts  # One instance per key on the canvas
│   ├── transport/
│   │   ├── StateTransport.ts        # Interface
│   │   └── SseTransport.ts          # SSE implementation
│   ├── rendering/
│   │   ├── KeyRenderer.ts           # Generates 144x144 PNG key images (Canvas API)
│   │   ├── BlinkController.ts       # Manages blink animation timing
│   │   └── themes.ts                # Color definitions, configurable styles
│   └── config/
│       └── defaults.ts              # Default colors, blink rates, display options
├── property-inspector/
│   └── index.html                   # StreamDeck settings UI for each key
└── assets/
    └── icons/                       # Plugin icon, category icon
```

### Key Assignment Model (Hybrid)

1. User drags `SessionMonitor` action onto a StreamDeck key
2. In the Property Inspector, user selects a **project directory** to bind to
3. When a session starts in that project, the key auto-binds to it
4. Multiple sessions in the same project:
   - Primary key shows the most recent/active session with a count badge
   - Additional keys auto-assign from a configurable "overflow pool" (keys user designates as available)
5. When sessions end, overflow keys are released

### Key Rendering

Using Canvas API (`@napi-rs/canvas`) to generate 144x144 PNG images:

- **Background**: solid color based on state
- **Text**: project name, truncated to fit
- **Badge**: session count in top-right corner when count > 1
- **Blink**: `BlinkController` runs `setInterval` alternating between two image states via `setImage()` on the SDK

### Property Inspector Settings

Per-key configuration via StreamDeck's built-in settings UI:

```typescript
interface KeySettings {
  // Binding
  projectPath: string;
  isOverflowKey: boolean;              // default: false

  // Display
  displayMode: 'name' | 'name-count' | 'name-status';  // default: 'name-count'

  // Colors
  colors: {
    idle: string;                      // default: '#22c55e'
    working: string;                   // default: '#3b82f6'
    waiting: string;                   // default: '#f59e0b'
    disconnected: string;              // default: '#71717a'
  };

  // Blink
  blinkStyle: 'pulse' | 'toggle' | 'icon-overlay';  // default: 'toggle'
  blinkIntervalMs: number;            // default: 500

  // Actions per state
  actions: {
    idle: 'open-devtools' | 'open-terminal' | 'none';      // default: 'open-devtools'
    working: 'open-devtools' | 'open-terminal' | 'none';    // default: 'open-devtools'
    waiting: 'open-devtools' | 'open-terminal' | 'none';    // default: 'open-terminal'
  };

  // Connection
  serverUrl: string;                   // default: 'http://localhost:24462' (well-known port for claude-devtools)
}
```

## Electron App Configuration

New section in existing app config:

```typescript
interface StreamDeckConfig {
  enabled: boolean;                    // default: false
  sseChannel: {
    enabled: boolean;                  // default: true
    staleSessionTimeoutMs: number;     // default: 300000 (5min)
  };
  actions: {
    openTerminalCommand: string;       // default: platform-detected
  };
}
```

## Error Handling & Edge Cases

### Connection Failures

| Scenario | Behavior |
|----------|----------|
| Electron app not running | Key shows gray "offline", plugin retries with exponential backoff (1s → 30s max) |
| SSE stream drops | Plugin falls back to polling `/api/streamdeck/state` every 5s until SSE reconnects |
| StreamDeck software restarts | Plugin re-registers all keys, fetches fresh state snapshot |
| Multiple Electron app instances | Plugin connects to configured `serverUrl` — user manages port uniqueness |

### Session Edge Cases

| Scenario | Behavior |
|----------|----------|
| Session ends while blinking | BlinkController stops, key transitions to idle, releases after stale timeout |
| Two sessions same project, both waiting | Primary key blinks for most recent, count badge shows "2" |
| Overflow pool exhausted | Extra sessions share primary project key (count badge reflects total) |
| Session file deleted | SessionStateTracker removes from state map, emits update, key releases |
| Rapid state changes (< 100ms) | SessionStateTracker debounces at 200ms — emits only settled state |

### Plugin Lifecycle

| Event | Behavior |
|-------|----------|
| Plugin installed | Keys show gray "configure" until project is set in Property Inspector |
| Key added to canvas | Registers with SSE, starts showing state |
| Key removed from canvas | Unsubscribes, stops blink timers, cleans up |
| Plugin update | Graceful shutdown — stops timers, disconnects, re-initializes |

### Security

- HTTP endpoints are localhost-only (matching existing Fastify config)
- No authentication needed for local-only communication
- `open-terminal` action sanitizes project path to prevent command injection
- Property Inspector loads project list from API — no user-typed paths passed to shell

## Testing Strategy

### Electron App Side

- **SessionStateTracker**: Unit tests with mock FileWatcher events — verify state transitions for all scenarios
- **HTTP endpoints**: Integration tests using the existing Fastify test utilities — verify SSE stream, REST responses, action handling
- **Waiting-for-input detection**: Unit tests with fixture JSONL data containing pending tool_use blocks and unanswered questions

### StreamDeck Plugin Side

- **SseTransport**: Unit tests with mock SSE server — verify connection, reconnection, backoff
- **KeyRenderer**: Snapshot tests — verify generated images for each state/config combination
- **BlinkController**: Timer tests — verify start/stop/interval behavior
- **SessionMonitorAction**: Integration tests — verify key assignment, overflow logic, state-to-render mapping

## Out of Scope (Future Work)

- WebSocket transport (interface is ready, implementation deferred)
- `approve-all` key press action (needs Claude Code CLI integration)
- StreamDeck+ dial/touchscreen support
- Multi-device StreamDeck support (single device assumed)
- StreamDeck mobile app support
