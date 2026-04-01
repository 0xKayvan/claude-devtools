// streamdeck-plugin/src/rendering/KeyRenderer.ts
import { createCanvas } from '@napi-rs/canvas';
import {
  KEY_SIZE,
  FONT_SIZE,
  BADGE_SIZE,
  BADGE_FONT_SIZE,
  PADDING,
  getThemeForState,
} from './themes';
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
      const statusText = state === 'waiting-for-input' ? 'waiting' : state;
      ctx.fillText(statusText, KEY_SIZE / 2, textY + FONT_SIZE + 4);
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
