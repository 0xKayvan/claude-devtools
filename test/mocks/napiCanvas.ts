/**
 * Mock for the '@napi-rs/canvas' module in Vitest tests.
 * Provides stub canvas implementation for main process code.
 */
import { vi } from 'vitest';

export const createCanvas = vi.fn(() => ({
  getContext: vi.fn(() => ({
    beginPath: vi.fn(),
    arc: vi.fn(),
    fill: vi.fn(),
    fillStyle: '',
  })),
  toBuffer: vi.fn(() => Buffer.alloc(0)),
}));
