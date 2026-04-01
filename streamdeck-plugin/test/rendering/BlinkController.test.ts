import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { BlinkController } from '../../src/rendering/BlinkController';

describe('BlinkController', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('should not be blinking initially', () => {
    const controller = new BlinkController();
    expect(controller.isBlinking()).toBe(false);
  });

  it('should call the toggle callback at the specified interval', () => {
    const controller = new BlinkController();
    const onToggle = vi.fn();

    controller.start(500, onToggle);
    expect(controller.isBlinking()).toBe(true);

    vi.advanceTimersByTime(500);
    expect(onToggle).toHaveBeenCalledTimes(1);
    expect(onToggle).toHaveBeenCalledWith(true);

    vi.advanceTimersByTime(500);
    expect(onToggle).toHaveBeenCalledTimes(2);
    expect(onToggle).toHaveBeenCalledWith(false);

    vi.advanceTimersByTime(500);
    expect(onToggle).toHaveBeenCalledTimes(3);
    expect(onToggle).toHaveBeenCalledWith(true);

    controller.stop();
  });

  it('should stop blinking when stop is called', () => {
    const controller = new BlinkController();
    const onToggle = vi.fn();

    controller.start(500, onToggle);
    controller.stop();

    expect(controller.isBlinking()).toBe(false);

    vi.advanceTimersByTime(2000);
    expect(onToggle).toHaveBeenCalledTimes(0);
  });

  it('should restart cleanly if start is called while already blinking', () => {
    const controller = new BlinkController();
    const onToggle1 = vi.fn();
    const onToggle2 = vi.fn();

    controller.start(500, onToggle1);
    vi.advanceTimersByTime(500);
    expect(onToggle1).toHaveBeenCalledTimes(1);

    controller.start(250, onToggle2);
    vi.advanceTimersByTime(250);

    expect(onToggle2).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(500);
    expect(onToggle1).toHaveBeenCalledTimes(1); // still 1
  });
});
