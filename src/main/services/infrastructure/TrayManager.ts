import { createCanvas } from '@napi-rs/canvas';
import { app, Menu, nativeImage, Tray } from 'electron';

import { focusDevtoolsWindow, focusGhosttySession } from '../../utils/ghosttyFocuser';

import { configManager } from './ConfigManager';

import type { SessionStateTracker } from './SessionStateTracker';
import type { SessionActivityState, SessionState } from '@shared/types/streamdeck';

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
  sessions: SessionState[]
): { label: string; sessionId: string; sessionTitle: string }[] {
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
    this.tray = new Tray(this.icons.idle);
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
      const icon = this.icons[newState] ?? this.icons.idle;
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
      }
    );

    this.tray.setContextMenu(Menu.buildFromTemplate(template));
  }

  dispose(): void {
    this.disposed = true;
    this.destroyTray();
  }
}
