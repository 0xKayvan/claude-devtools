import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { EventEmitter } from 'events';
import { SessionStateTracker } from '../../../../src/main/services/infrastructure/SessionStateTracker';
import type { ParsedMessage } from '../../../../src/main/types';

// Minimal mock for FileWatcher — only needs to be an EventEmitter
function createMockFileWatcher() {
  return new EventEmitter();
}

// Minimal mock for SessionParser — returns messages for a session
function createMockSessionParser(messagesMap: Record<string, ParsedMessage[]>) {
  return {
    parseSessionMessages: vi.fn(async (sessionId: string) => {
      return messagesMap[sessionId] ?? [];
    }),
  };
}

// Minimal mock for ProjectScanner — returns project info
function createMockProjectScanner(
  projects: { id: string; path: string; name: string; sessions: string[] }[]
) {
  return {
    scan: vi.fn(async () => projects),
    getProjectForSession: vi.fn((sessionId: string) => {
      return projects.find((p) => p.sessions.includes(sessionId)) ?? null;
    }),
  };
}

function createMessage(overrides: Partial<ParsedMessage>): ParsedMessage {
  return {
    uuid: `msg-${Math.random().toString(36).slice(2, 11)}`,
    parentUuid: null,
    type: 'user',
    timestamp: new Date(),
    content: '',
    isSidechain: false,
    isMeta: false,
    toolCalls: [],
    toolResults: [],
    ...overrides,
  };
}

describe('SessionStateTracker', () => {
  let fileWatcher: EventEmitter;
  let tracker: SessionStateTracker;

  afterEach(() => {
    tracker?.dispose();
  });

  describe('detectActivityState', () => {
    it('should return idle when session has no ongoing activity', () => {
      const messages: ParsedMessage[] = [
        createMessage({ type: 'user', content: 'hello' }),
        createMessage({
          type: 'assistant',
          content: [{ type: 'text', text: 'Hi there!' }],
        }),
      ];

      fileWatcher = createMockFileWatcher();
      const sessionParser = createMockSessionParser({ 'session-1': messages });
      const projectScanner = createMockProjectScanner([
        { id: 'proj-1', path: '/test/project', name: 'test-project', sessions: ['session-1'] },
      ]);

      tracker = new SessionStateTracker(
        fileWatcher as any,
        sessionParser as any,
        projectScanner as any
      );

      const state = tracker.detectActivityState(messages);
      expect(state).toBe('idle');
    });

    it('should return working when last activity is thinking', () => {
      const messages: ParsedMessage[] = [
        createMessage({ type: 'user', content: 'help me' }),
        createMessage({
          type: 'assistant',
          content: [{ type: 'thinking', thinking: 'Let me think about this...' }],
        }),
      ];

      fileWatcher = createMockFileWatcher();
      tracker = new SessionStateTracker(
        fileWatcher as any,
        createMockSessionParser({}) as any,
        createMockProjectScanner([]) as any
      );

      const state = tracker.detectActivityState(messages);
      expect(state).toBe('working');
    });

    it('should return working when last activity is tool_use with matching tool_result', () => {
      const messages: ParsedMessage[] = [
        createMessage({ type: 'user', content: 'read file.ts' }),
        createMessage({
          type: 'assistant',
          content: [{ type: 'tool_use', id: 'tool-1', name: 'Read', input: {} }],
          toolCalls: [{ id: 'tool-1', name: 'Read', input: {}, serverName: undefined }],
        }),
        createMessage({
          type: 'user',
          isMeta: true,
          content: [{ type: 'tool_result', tool_use_id: 'tool-1', content: 'file contents' }],
          toolResults: [{ toolUseId: 'tool-1', content: 'file contents' }],
        }),
      ];

      fileWatcher = createMockFileWatcher();
      tracker = new SessionStateTracker(
        fileWatcher as any,
        createMockSessionParser({}) as any,
        createMockProjectScanner([]) as any
      );

      const state = tracker.detectActivityState(messages);
      expect(state).toBe('working');
    });

    it('should return waiting-for-input when tool_use has no matching tool_result', () => {
      const messages: ParsedMessage[] = [
        createMessage({ type: 'user', content: 'delete file.ts' }),
        createMessage({
          type: 'assistant',
          content: [
            { type: 'tool_use', id: 'tool-1', name: 'Bash', input: { command: 'rm file.ts' } },
          ],
          toolCalls: [
            { id: 'tool-1', name: 'Bash', input: { command: 'rm file.ts' }, serverName: undefined },
          ],
        }),
        // No tool_result follows — waiting for approval
      ];

      fileWatcher = createMockFileWatcher();
      tracker = new SessionStateTracker(
        fileWatcher as any,
        createMockSessionParser({}) as any,
        createMockProjectScanner([]) as any
      );

      const state = tracker.detectActivityState(messages);
      expect(state).toBe('waiting-for-input');
    });

    it('should return waiting-for-input when AskUserQuestion has no result', () => {
      const messages: ParsedMessage[] = [
        createMessage({ type: 'user', content: 'help me pick' }),
        createMessage({
          type: 'assistant',
          content: [
            {
              type: 'tool_use',
              id: 'tool-1',
              name: 'AskUserQuestion',
              input: { question: 'Which option?' },
            },
          ],
          toolCalls: [
            {
              id: 'tool-1',
              name: 'AskUserQuestion',
              input: { question: 'Which option?' },
              serverName: undefined,
            },
          ],
        }),
        // No tool_result — waiting for user answer
      ];

      fileWatcher = createMockFileWatcher();
      tracker = new SessionStateTracker(
        fileWatcher as any,
        createMockSessionParser({}) as any,
        createMockProjectScanner([]) as any
      );

      const state = tracker.detectActivityState(messages);
      expect(state).toBe('waiting-for-input');
    });

    it('should return idle when last assistant message is plain text with no pending tools', () => {
      const messages: ParsedMessage[] = [
        createMessage({ type: 'user', content: 'what is 2+2?' }),
        createMessage({
          type: 'assistant',
          content: [{ type: 'text', text: 'The answer is 4.' }],
        }),
      ];

      fileWatcher = createMockFileWatcher();
      tracker = new SessionStateTracker(
        fileWatcher as any,
        createMockSessionParser({}) as any,
        createMockProjectScanner([]) as any
      );

      const state = tracker.detectActivityState(messages);
      expect(state).toBe('idle');
    });
  });
});
