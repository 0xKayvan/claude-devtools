// streamdeck-plugin/src/rendering/themes.ts

export const KEY_SIZE = 144;
export const FONT_SIZE = 22;
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
  colors: { idle: string; working: string; waiting: string; disconnected: string }
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
