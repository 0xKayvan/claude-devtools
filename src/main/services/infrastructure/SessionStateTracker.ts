import { EventEmitter } from 'events';

import { checkMessagesOngoing } from '../../utils/sessionStateDetection';

import type { FileChangeEvent } from '../../types';
import type { ParsedMessage } from '../../types';
import type { ProjectScanner } from '../discovery/ProjectScanner';
import type { SessionParser } from '../parsing/SessionParser';
import type { FileWatcher } from './FileWatcher';
import type { SessionActivityState, SessionState } from '@shared/types/streamdeck';

const DEBOUNCE_MS = 200;

export class SessionStateTracker extends EventEmitter {
  private states = new Map<string, SessionState>();
  private debounceTimers = new Map<string, NodeJS.Timeout>();
  private disposed = false;

  constructor(
    private readonly fileWatcher: FileWatcher,
    private readonly sessionParser: SessionParser,
    private readonly projectScanner: ProjectScanner
  ) {
    super();
    this.fileWatcher.on('file-change', this.handleFileChange.bind(this));
  }

  /**
   * Detect the activity state of a session from its messages.
   * Public for testing — the main entry point is the file-change event handler.
   */
  detectActivityState(messages: ParsedMessage[]): SessionActivityState {
    if (messages.length === 0) return 'idle';

    // Check if session has ongoing activity using existing logic
    const isOngoing = checkMessagesOngoing(messages);
    if (!isOngoing) return 'idle';

    // Session is ongoing — determine if working or waiting for input
    // Walk backwards to find the last assistant message
    for (let i = messages.length - 1; i >= 0; i--) {
      const msg = messages[i];

      // Skip non-assistant messages (tool results are user messages with isMeta: true)
      if (msg.type !== 'assistant') continue;

      // Check if this assistant message has tool calls without results
      if (msg.toolCalls && msg.toolCalls.length > 0) {
        const pendingToolCalls = msg.toolCalls.filter((tc) => {
          // Look for a matching tool_result in subsequent messages
          const hasResult = messages
            .slice(i + 1)
            .some((subsequent) => subsequent.toolResults?.some((tr) => tr.toolUseId === tc.id));
          return !hasResult;
        });

        if (pendingToolCalls.length > 0) {
          return 'waiting-for-input';
        }
      }

      // If the last assistant message is just text with no tool calls,
      // and session is ongoing, it's still working (streaming text)
      break;
    }

    return 'working';
  }

  private async handleFileChange(event: FileChangeEvent): Promise<void> {
    if (this.disposed) return;
    if (event.type === 'unlink') {
      if (event.sessionId) this.removeSession(event.sessionId);
      return;
    }

    const sessionId = event.sessionId;
    if (!sessionId) return;

    // Debounce per session
    const existing = this.debounceTimers.get(sessionId);
    if (existing) clearTimeout(existing);

    this.debounceTimers.set(
      sessionId,
      setTimeout(() => {
        this.debounceTimers.delete(sessionId);
        this.updateSessionState(sessionId, event.projectId).catch((err) => {
          console.error(`Error updating state for session ${sessionId}:`, err);
        });
      }, DEBOUNCE_MS)
    );
  }

  private async updateSessionState(sessionId: string, _projectId?: string): Promise<void> {
    if (this.disposed) return;

    try {
      const messages = await (
        this.sessionParser as unknown as {
          parseSessionMessages: (id: string) => Promise<ParsedMessage[]>;
        }
      ).parseSessionMessages(sessionId);
      const state = this.detectActivityState(messages);
      const project = (
        this.projectScanner as unknown as {
          getProjectForSession: (id: string) => { path: string; name: string } | null;
        }
      ).getProjectForSession(sessionId);

      const projectPath = project?.path ?? '';
      const projectName = project?.name ?? 'Unknown';

      // Count active sessions in the same project
      const sessionCount = project
        ? [...this.states.values()].filter(
            (s) => s.projectPath === projectPath && s.state !== 'idle'
          ).length + (state !== 'idle' ? 1 : 0)
        : 1;

      const prev = this.states.get(sessionId);
      const next: SessionState = {
        sessionId,
        projectPath,
        projectName,
        state,
        sessionCount,
        updatedAt: Date.now(),
      };

      // Only emit if state actually changed
      if (prev?.state !== next.state) {
        this.states.set(sessionId, next);
        this.emit('state-change', this.getStates());
      } else {
        // Update timestamp even if state didn't change
        this.states.set(sessionId, next);
      }
    } catch (err) {
      console.error(`Failed to update session state for ${sessionId}:`, err);
    }
  }

  private removeSession(sessionId: string): void {
    const had = this.states.delete(sessionId);
    if (had) {
      this.emit('state-change', this.getStates());
    }
  }

  getStates(): SessionState[] {
    return [...this.states.values()];
  }

  dispose(): void {
    this.disposed = true;
    for (const timer of this.debounceTimers.values()) {
      clearTimeout(timer);
    }
    this.debounceTimers.clear();
    this.states.clear();
    this.removeAllListeners();
  }
}
