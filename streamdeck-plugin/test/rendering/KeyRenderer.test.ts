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
