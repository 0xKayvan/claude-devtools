# Menu Bar Integration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a macOS menu bar tray icon that shows aggregate Claude Code session state and provides a dropdown to jump to active sessions.

**Architecture:** New `TrayManager` service in the Electron main process subscribes to `SessionStateTracker` events. Pre-renders 3 colored icon images at startup. Rebuilds the context menu on each state change. Reuses Ghostty tab-focusing logic from StreamDeck integration.

**Tech Stack:** Electron Tray API, `@napi-rs/canvas` (icon rendering), existing SessionStateTracker

**Spec:** `docs/superpowers/specs/2026-04-01-menubar-integration-design.md`

---

## File Structure

| Action | Path | Responsibility |
|--------|------|----------------|
| Modify | `src/main/services/infrastructure/ConfigManager.ts` | Add `MenuBarConfig` type and defaults |
| Create | `src/main/utils/ghosttyFocuser.ts` | Extract Ghostty tab-focusing logic from streamdeck.ts |
| Modify | `src/main/http/streamdeck.ts` | Use extracted `focusGhosttySession` utility |
| Create | `src/main/services/infrastructure/TrayManager.ts` | Menu bar tray icon + context menu |
| Modify | `src/main/index.ts` | Wire TrayManager into service lifecycle |
| Create | `test/main/services/infrastructure/TrayManager.test.ts` | Unit tests for state priority and menu building |

---

## Task 1: Add MenuBarConfig to ConfigManager

**Files:**
- Modify: `src/main/services/infrastructure/ConfigManager.ts`

- [ ] **Step 1: Add the MenuBarConfig interface**

After the existing `HttpServerConfig` interface (around line 225), add:

```typescript
export interface MenuBarConfig {
  enabled: boolean;
  autoHide: boolean;
  clickAction: 'open-terminal' | 'open-devtools';
}
```

- [ ] **Step 2: Add menuBar to AppConfig interface**

Add `menuBar: MenuBarConfig;` to the `AppConfig` interface (after the `httpServer` field).

- [ ] **Step 3: Add defaults to DEFAULT_CONFIG**

After the `httpServer` defaults (around line 274), add:

```typescript
menuBar: {
  enabled: true,
  autoHide: false,
  clickAction: 'open-terminal',
},
```

- [ ] **Step 4: Add merge logic in mergeWithDefaults**

After the `httpServer` merge (around line 462), add:

```typescript
menuBar: {
  ...DEFAULT_CONFIG.menuBar,
  ...(loaded.menuBar ?? {}),
},
```

- [ ] **Step 5: Run typecheck**

Run: `pnpm typecheck`
Note: There are pre-existing typecheck errors from the reverted ProjectScanner. Only check that no NEW errors were introduced.

- [ ] **Step 6: Commit**

```bash
git add src/main/services/infrastructure/ConfigManager.ts
git commit -m "feat(menubar): add MenuBarConfig to ConfigManager"
```

---

## Task 2: Extract Ghostty Focus Utility

**Files:**
- Create: `src/main/utils/ghosttyFocuser.ts`
- Modify: `src/main/http/streamdeck.ts`

- [ ] **Step 1: Create the shared utility**

```typescript
// src/main/utils/ghosttyFocuser.ts
import { exec } from 'child_process';

/**
 * Focus the Ghostty terminal tab matching the given session title.
 * Searches all Ghostty windows and tabs, raises the correct window,
 * and sends Cmd+N to switch to the matching tab.
 *
 * Falls back to just activating Ghostty if no match is found.
 */
export function focusGhosttySession(sessionTitle: string): void {
  const searchWords = sessionTitle ? sessionTitle.split(/\s+/).slice(0, 4).join(' ') : '';
  const escaped = searchWords.replace(/\\/g, '\\\\').replace(/"/g, '\\"');

  const script = escaped
    ? `
set targetWinName to ""
set targetTabNum to 0

tell application "Ghostty"
  set winCount to count of every window
  repeat with wi from 1 to winCount
    set w to window wi
    set tabCount to count of every tab of w
    repeat with ti from 1 to tabCount
      if name of tab ti of w contains "${escaped}" then
        set targetWinName to name of w
        set targetTabNum to ti
        exit repeat
      end if
    end repeat
    if targetTabNum > 0 then exit repeat
  end repeat
end tell

if targetTabNum > 0 then
  tell application "System Events"
    tell process "ghostty"
      set frontmost to true
      repeat with w in windows
        if name of w contains targetWinName or name of w contains "${escaped}" then
          perform action "AXRaise" of w
          exit repeat
        end if
      end repeat
    end tell
    delay 0.2
    keystroke (targetTabNum as string) using command down
  end tell
else
  tell application "Ghostty" to activate
end if`
    : 'tell application "Ghostty" to activate';

  exec(`osascript -e '${script.replace(/'/g, "'\"'\"'")}'`, { timeout: 5000 }, () => {});
}

/**
 * Focus the claude-devtools Electron window.
 */
export function focusDevtoolsWindow(): void {
  const { app, BrowserWindow } = require('electron');
  const windows = BrowserWindow.getAllWindows();
  if (windows.length > 0) {
    if (process.platform === 'darwin') {
      app.show();
    }
    windows[0].show();
    windows[0].focus();
  }
}
```

- [ ] **Step 2: Update streamdeck.ts to use the shared utility**

Replace the inline Ghostty AppleScript block in the `open-terminal` action (lines 137-195 of streamdeck.ts) with:

```typescript
if (action === 'open-terminal') {
  if (process.platform === 'darwin') {
    const { focusGhosttySession } = require('../utils/ghosttyFocuser');
    const states = services.sessionStateTracker.getStates();
    const session = states.find((s) => s.sessionId === sessionId);
    focusGhosttySession(session?.sessionTitle ?? '');
  }
  return { success: true };
}
```

Also update the `open-devtools` action to use the shared utility:

```typescript
if (action === 'open-devtools') {
  const { focusDevtoolsWindow } = require('../utils/ghosttyFocuser');
  focusDevtoolsWindow();
  return { success: true };
}
```

Remove the old `focusGhosttyTab` function at the bottom of the file (lines 200+) and the `app` import from electron since it's no longer needed directly.

- [ ] **Step 3: Run tests to verify no regressions**

Run: `pnpm test`
Expected: All existing tests pass

- [ ] **Step 4: Commit**

```bash
git add src/main/utils/ghosttyFocuser.ts src/main/http/streamdeck.ts
git commit -m "refactor(streamdeck): extract Ghostty focus logic to shared utility"
```

---

## Task 3: Implement TrayManager

**Files:**
- Create: `src/main/services/infrastructure/TrayManager.ts`
- Create: `test/main/services/infrastructure/TrayManager.test.ts`

- [ ] **Step 1: Write tests for state priority logic**

```typescript
// test/main/services/infrastructure/TrayManager.test.ts
import { describe, expect, it } from 'vitest';
import { getAggregateState, buildSessionMenuItems } from '../../src/main/services/infrastructure/TrayManager';
import type { SessionState } from '../../src/shared/types/streamdeck';

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
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm test test/main/services/infrastructure/TrayManager.test.ts`
Expected: FAIL — module does not exist

- [ ] **Step 3: Implement TrayManager**

```typescript
// src/main/services/infrastructure/TrayManager.ts
import { Menu, Tray, nativeImage, app } from 'electron';
import { createCanvas } from '@napi-rs/canvas';
import type { SessionStateTracker } from './SessionStateTracker';
import type { SessionActivityState, SessionState } from '@shared/types/streamdeck';
import { focusGhosttySession, focusDevtoolsWindow } from '../../utils/ghosttyFocuser';
import { configManager } from '../index';

const ICON_SIZE = 22;

const STATE_COLORS: Record<string, string> = {
  idle: '#71717a',
  working: '#3b82f6',
  'waiting-for-input': '#f59e0b',
};

const STATUS_EMOJI: Record<string, string> = {
  idle: '🟢',
  working: '🔵',
  'waiting-for-input': '🟠',
};

const STATE_PRIORITY: Record<string, number> = {
  'waiting-for-input': 3,
  working: 2,
  idle: 1,
};

/**
 * Determine the most urgent state across all sessions.
 * Exported for testing.
 */
export function getAggregateState(sessions: SessionState[]): SessionActivityState {
  let highest: SessionActivityState = 'idle';
  let highestPriority = 0;
  for (const s of sessions) {
    const p = STATE_PRIORITY[s.state] ?? 0;
    if (p > highestPriority) {
      highestPriority = p;
      highest = s.state;
    }
  }
  return highest;
}

/**
 * Build menu item data for each session, sorted by urgency.
 * Exported for testing.
 */
export function buildSessionMenuItems(
  sessions: SessionState[],
): Array<{ label: string; sessionId: string; sessionTitle: string }> {
  return [...sessions]
    .sort((a, b) => (STATE_PRIORITY[b.state] ?? 0) - (STATE_PRIORITY[a.state] ?? 0))
    .map((s) => ({
      label: `${STATUS_EMOJI[s.state] ?? '⚪'}  ${s.projectName}    ${s.state === 'waiting-for-input' ? 'waiting' : s.state}`,
      sessionId: s.sessionId,
      sessionTitle: s.sessionTitle,
    }));
}

function renderIcon(color: string): Electron.NativeImage {
  const canvas = createCanvas(ICON_SIZE * 2, ICON_SIZE * 2);
  const ctx = canvas.getContext('2d');
  const center = ICON_SIZE;
  const radius = ICON_SIZE * 0.45;

  ctx.beginPath();
  ctx.arc(center, center, radius, 0, Math.PI * 2);
  ctx.fillStyle = color;
  ctx.fill();

  const buffer = canvas.toBuffer('image/png');
  const image = nativeImage.createFromBuffer(buffer, { scaleFactor: 2 });
  return image;
}

export class TrayManager {
  private tray: Tray | null = null;
  private icons: Record<string, Electron.NativeImage> = {};
  private currentState: SessionActivityState = 'idle';
  private disposed = false;

  constructor(private readonly sessionStateTracker: SessionStateTracker) {
    // Pre-render icons
    for (const [state, color] of Object.entries(STATE_COLORS)) {
      this.icons[state] = renderIcon(color);
    }

    // Subscribe to state changes
    this.sessionStateTracker.on('state-change', this.handleStateChange.bind(this));

    // Create tray if enabled
    const config = configManager.getConfig();
    if (config.menuBar?.enabled !== false) {
      this.createTray();
    }
  }

  private createTray(): void {
    if (this.tray) return;
    this.tray = new Tray(this.icons['idle']);
    this.tray.setToolTip('Claude Devtools');
    this.rebuildMenu();
  }

  private destroyTray(): void {
    if (this.tray) {
      this.tray.destroy();
      this.tray = null;
    }
  }

  private handleStateChange(sessions: SessionState[]): void {
    if (this.disposed) return;

    const config = configManager.getConfig();
    const enabled = config.menuBar?.enabled !== false;
    const autoHide = config.menuBar?.autoHide ?? false;

    // Handle auto-hide
    if (autoHide && sessions.length === 0) {
      this.destroyTray();
      return;
    }

    if (enabled && !this.tray) {
      this.createTray();
    }

    if (!this.tray) return;

    // Update icon
    const newState = getAggregateState(sessions);
    if (newState !== this.currentState) {
      this.currentState = newState;
      const icon = this.icons[newState] ?? this.icons['idle'];
      this.tray.setImage(icon);
    }

    // Rebuild menu
    this.rebuildMenu(sessions);
  }

  private rebuildMenu(sessions: SessionState[] = []): void {
    if (!this.tray) return;

    const config = configManager.getConfig();
    const clickAction = config.menuBar?.clickAction ?? 'open-terminal';
    const items = buildSessionMenuItems(sessions);

    const template: Electron.MenuItemConstructorOptions[] = [
      { label: 'Claude Devtools', enabled: false },
      { type: 'separator' },
    ];

    if (items.length === 0) {
      template.push({ label: '  No active sessions', enabled: false });
    } else {
      for (const item of items) {
        template.push({
          label: item.label,
          click: () => {
            if (clickAction === 'open-terminal') {
              focusGhosttySession(item.sessionTitle);
            } else {
              focusDevtoolsWindow();
            }
          },
        });
      }
    }

    template.push(
      { type: 'separator' },
      {
        label: 'Open Devtools App',
        click: () => focusDevtoolsWindow(),
      },
      { type: 'separator' },
      {
        label: 'Hide Menu Bar Icon',
        click: () => {
          configManager.updateConfig('menuBar', { enabled: false });
          this.destroyTray();
        },
      },
      {
        label: 'Quit',
        click: () => app.quit(),
      },
    );

    this.tray.setContextMenu(Menu.buildFromTemplate(template));
  }

  dispose(): void {
    this.disposed = true;
    this.destroyTray();
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm test test/main/services/infrastructure/TrayManager.test.ts`
Expected: PASS — all 6 tests green

- [ ] **Step 5: Commit**

```bash
git add src/main/services/infrastructure/TrayManager.ts test/main/services/infrastructure/TrayManager.test.ts
git commit -m "feat(menubar): add TrayManager with icon state and session menu"
```

---

## Task 4: Wire TrayManager into App Lifecycle

**Files:**
- Modify: `src/main/index.ts`

- [ ] **Step 1: Add TrayManager import and declaration**

Add import near top of file (after the HttpServer import):

```typescript
import { TrayManager } from './services/infrastructure/TrayManager';
```

Add global variable declaration (after `let httpServer: HttpServer;` around line 84):

```typescript
let trayManager: TrayManager;
```

- [ ] **Step 2: Initialize TrayManager in initializeServices()**

After the HTTP server config block (around line 344, after the `configManagerPromise.then(...)` block), add:

```typescript
// Initialize menu bar tray
void configManagerPromise.then(() => {
  const activeContext = contextRegistry.getActive();
  trayManager = new TrayManager(activeContext.sessionStateTracker);
});
```

- [ ] **Step 3: Dispose TrayManager in shutdownServices()**

After the SSH connection manager disposal (around line 407), add:

```typescript
// Dispose tray manager
if (trayManager) {
  trayManager.dispose();
}
```

- [ ] **Step 4: Run full test suite**

Run: `pnpm test`
Expected: All tests pass

- [ ] **Step 5: Build and package**

Run: `mv streamdeck-plugin /tmp/sd-plugin-tmp && pnpm build && npx electron-builder --mac --publish never && mv /tmp/sd-plugin-tmp streamdeck-plugin`
Expected: Build succeeds

- [ ] **Step 6: Commit**

```bash
git add src/main/index.ts
git commit -m "feat(menubar): wire TrayManager into app lifecycle"
```

---

## Task 5: Manual Verification

- [ ] **Step 1: Launch the packaged app**

Replace the app in `/Applications` with the new DMG. Launch it.

- [ ] **Step 2: Verify tray icon appears**

Check macOS menu bar for a gray circle icon.

- [ ] **Step 3: Verify menu dropdown**

Click the tray icon. Verify:
- "Claude Devtools" header
- Session list (if any active) with emoji indicators
- "Open Devtools App", "Hide Menu Bar Icon", "Quit" items

- [ ] **Step 4: Verify icon state changes**

Start a Claude Code session. Verify icon turns blue (working). When Claude asks for input, verify icon turns amber.

- [ ] **Step 5: Verify click action**

Click a session in the dropdown. Verify Ghostty activates and switches to the correct tab.

- [ ] **Step 6: Verify Hide Menu Bar Icon**

Click "Hide Menu Bar Icon". Verify the icon disappears and the config is updated.
