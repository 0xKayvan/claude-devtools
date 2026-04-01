/**
 * Mock for the 'electron' module in Vitest tests.
 * Provides stub implementations of Electron APIs used by main process code.
 */
import { vi } from 'vitest';

export const Menu = {
  buildFromTemplate: vi.fn(() => ({})),
};

export const Tray = vi.fn().mockImplementation(() => ({
  setToolTip: vi.fn(),
  setImage: vi.fn(),
  setContextMenu: vi.fn(),
  destroy: vi.fn(),
}));

export const nativeImage = {
  createFromBuffer: vi.fn(() => ({})),
};

export const app = {
  quit: vi.fn(),
  getPath: vi.fn(() => '/mock/path'),
  on: vi.fn(),
};

export const ipcMain = {
  on: vi.fn(),
  handle: vi.fn(),
};

export const BrowserWindow = vi.fn();
export const shell = { openExternal: vi.fn(), openPath: vi.fn() };
export const dialog = { showOpenDialog: vi.fn(), showSaveDialog: vi.fn() };
export const screen = {
  getPrimaryDisplay: vi.fn(() => ({ workAreaSize: { width: 1920, height: 1080 } })),
};
