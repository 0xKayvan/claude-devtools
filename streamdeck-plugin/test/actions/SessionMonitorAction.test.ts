// streamdeck-plugin/test/actions/SessionMonitorAction.test.ts
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { SessionMonitorAction } from '../../src/actions/SessionMonitorAction';
import { DEFAULT_KEY_SETTINGS } from '../../src/config/defaults';
import type { SessionState } from '../../src/config/defaults';

function createMockActionContext() {
  return {
    setImage: vi.fn(),
    setTitle: vi.fn(),
    getSettings: vi.fn(() => DEFAULT_KEY_SETTINGS),
    showAlert: vi.fn(),
  };
}

function createMockTransport() {
  const stateCallbacks: Array<(sessions: SessionState[]) => void> = [];
  const connectionCallbacks: Array<(connected: boolean) => void> = [];
  return {
    connect: vi.fn(),
    disconnect: vi.fn(),
    onStateChange: vi.fn((cb) => stateCallbacks.push(cb)),
    onConnectionChange: vi.fn((cb) => connectionCallbacks.push(cb)),
    sendAction: vi.fn(async () => ({ success: true })),
    isConnected: vi.fn(() => true),
    _emitState: (sessions: SessionState[]) => stateCallbacks.forEach((cb) => cb(sessions)),
    _emitConnection: (connected: boolean) => connectionCallbacks.forEach((cb) => cb(connected)),
  };
}

function createMockRenderer() {
  return {
    render: vi.fn(async () => 'base64-image-data'),
  };
}

describe('SessionMonitorAction', () => {
  it('should bind to a project and show its state', async () => {
    const transport = createMockTransport();
    const renderer = createMockRenderer();
    const context = createMockActionContext();

    const action = new SessionMonitorAction(transport, renderer as any);
    action.setContext(context as any);
    action.setSettings({ ...DEFAULT_KEY_SETTINGS, projectPath: '/test/project' });

    transport._emitState([
      {
        sessionId: 'session-1',
        projectPath: '/test/project',
        projectName: 'test-project',
        state: 'working',
        sessionCount: 1,
        updatedAt: Date.now(),
      },
    ]);

    await vi.waitFor(() => {
      expect(renderer.render).toHaveBeenCalledWith(
        expect.objectContaining({
          projectName: 'test-project',
          state: 'working',
          sessionCount: 1,
        })
      );
    });
  });

  it('should show disconnected state when transport disconnects', async () => {
    const transport = createMockTransport();
    const renderer = createMockRenderer();
    const context = createMockActionContext();

    const action = new SessionMonitorAction(transport, renderer as any);
    action.setContext(context as any);
    action.setSettings({ ...DEFAULT_KEY_SETTINGS, projectPath: '/test/project' });

    transport._emitConnection(false);

    await vi.waitFor(() => {
      expect(renderer.render).toHaveBeenCalledWith(
        expect.objectContaining({
          state: 'disconnected',
        })
      );
    });
  });

  it('should filter sessions by configured project path', async () => {
    const transport = createMockTransport();
    const renderer = createMockRenderer();
    const context = createMockActionContext();

    const action = new SessionMonitorAction(transport, renderer as any);
    action.setContext(context as any);
    action.setSettings({ ...DEFAULT_KEY_SETTINGS, projectPath: '/test/project-a' });

    transport._emitState([
      {
        sessionId: 'session-1',
        projectPath: '/test/project-a',
        projectName: 'project-a',
        state: 'idle',
        sessionCount: 1,
        updatedAt: Date.now(),
      },
      {
        sessionId: 'session-2',
        projectPath: '/test/project-b',
        projectName: 'project-b',
        state: 'working',
        sessionCount: 1,
        updatedAt: Date.now(),
      },
    ]);

    await vi.waitFor(() => {
      expect(renderer.render).toHaveBeenCalledWith(
        expect.objectContaining({
          projectName: 'project-a',
          state: 'idle',
        })
      );
    });
  });

  it('should send configured action on key press', async () => {
    const transport = createMockTransport();
    const renderer = createMockRenderer();
    const context = createMockActionContext();

    const action = new SessionMonitorAction(transport, renderer as any);
    action.setContext(context as any);
    action.setSettings({ ...DEFAULT_KEY_SETTINGS, projectPath: '/test/project' });

    transport._emitState([
      {
        sessionId: 'session-1',
        projectPath: '/test/project',
        projectName: 'test-project',
        state: 'working',
        sessionCount: 1,
        updatedAt: Date.now(),
      },
    ]);

    await action.onKeyDown();

    expect(transport.sendAction).toHaveBeenCalledWith('session-1', 'open-devtools');
  });

  it('should send waiting action when state is waiting-for-input and stable', async () => {
    const transport = createMockTransport();
    const renderer = createMockRenderer();
    const context = createMockActionContext();

    const action = new SessionMonitorAction(transport, renderer as any);
    action.setContext(context as any);
    action.setSettings({ ...DEFAULT_KEY_SETTINGS, projectPath: '/test/project' });

    const stableState = [
      {
        sessionId: 'session-1',
        projectPath: '/test/project',
        projectName: 'test-project',
        state: 'waiting-for-input' as const,
        sessionCount: 1,
        updatedAt: 1000, // fixed timestamp — same across polls
      },
    ];

    // Emit multiple times with same updatedAt to reach stablePolls threshold
    transport._emitState(stableState);
    transport._emitState(stableState);
    transport._emitState(stableState);

    await action.onKeyDown();

    expect(transport.sendAction).toHaveBeenCalledWith('session-1', 'open-terminal');
  });
});
