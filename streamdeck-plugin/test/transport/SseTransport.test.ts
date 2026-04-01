// streamdeck-plugin/test/transport/SseTransport.test.ts
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { SseTransport } from '../../src/transport/SseTransport';

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
    expect(() => transport.onStateChange(callback)).not.toThrow();
  });

  it('should register connection change callbacks', () => {
    const callback = vi.fn();
    transport.onConnectionChange(callback);
    expect(() => transport.onConnectionChange(callback)).not.toThrow();
  });

  it('should calculate exponential backoff correctly', () => {
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
