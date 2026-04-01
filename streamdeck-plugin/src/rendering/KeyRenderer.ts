// streamdeck-plugin/src/rendering/KeyRenderer.ts
import { createCanvas } from '@napi-rs/canvas';
import {
  KEY_SIZE,
  FONT_SIZE,
  BADGE_SIZE,
  BADGE_FONT_SIZE,
  PADDING,
  getThemeForState,
} from './themes.js';
import type { KeySettings, SessionActivityState } from '../config/defaults.js';

export interface RenderOptions {
  projectName: string;
  state: SessionActivityState | 'disconnected';
  sessionCount: number;
  settings: KeySettings;
  /** Optional brightness multiplier for pulse effect (0-1). Default 1. */
  brightness?: number;
  /** Override the status text (e.g. show "waiting" even when state is "disconnected" for blink off) */
  statusText?: string;
}

export class KeyRenderer {
  async render(options: RenderOptions): Promise<string> {
    const { projectName, state, sessionCount, settings, brightness = 1, statusText } = options;
    const theme = getThemeForState(state, settings.colors);

    const canvas = createCanvas(KEY_SIZE, KEY_SIZE);
    const ctx = canvas.getContext('2d');

    // Background — apply brightness by darkening the color
    ctx.fillStyle = this.adjustBrightness(theme.backgroundColor, brightness);
    ctx.fillRect(0, 0, KEY_SIZE, KEY_SIZE);

    // Project name
    ctx.fillStyle = theme.textColor;
    ctx.font = `bold ${FONT_SIZE}px sans-serif`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';

    const displayName = this.truncateText(ctx, projectName, KEY_SIZE - PADDING * 2);
    const textY =
      sessionCount > 1 && settings.displayMode !== 'name' ? KEY_SIZE / 2 + 4 : KEY_SIZE / 2;
    ctx.fillText(displayName, KEY_SIZE / 2, textY);

    // Status text for name-status mode
    if (settings.displayMode === 'name-status') {
      ctx.font = `${FONT_SIZE - 4}px sans-serif`;
      ctx.fillStyle = 'rgba(255, 255, 255, 0.7)';
      const displayStatus = statusText ?? (state === 'waiting-for-input' ? 'waiting' : state);
      ctx.fillText(displayStatus, KEY_SIZE / 2, textY + FONT_SIZE + 4);
    }

    // Badge for session count
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

    const buffer = canvas.toBuffer('image/png');
    return buffer.toString('base64');
  }

  private adjustBrightness(hex: string, brightness: number): string {
    // Parse hex color and multiply RGB by brightness
    const m = /^#?([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})/i.exec(hex);
    if (!m) return hex;
    const r = Math.round(parseInt(m[1], 16) * brightness);
    const g = Math.round(parseInt(m[2], 16) * brightness);
    const b = Math.round(parseInt(m[3], 16) * brightness);
    return `rgb(${r},${g},${b})`;
  }

  private truncateText(
    ctx: ReturnType<ReturnType<typeof createCanvas>['getContext']>,
    text: string,
    maxWidth: number
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
