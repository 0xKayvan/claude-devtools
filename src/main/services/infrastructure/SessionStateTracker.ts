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

    // Initial scan — populate state for all existing sessions
    this.performInitialScan().catch((err) => {
      console.error('SessionStateTracker: initial scan failed:', err);
    });
  }

  /**
   * Scan all projects and sessions to build initial state map.
   */
  private async performInitialScan(): Promise<void> {
    try {
      const projects = await this.projectScanner.scan();
      for (const project of projects) {
        for (const sessionId of project.sessions) {
          await this.updateSessionState(sessionId, project.id);
        }
      }
      if (this.states.size > 0) {
        this.emit('state-change', this.getStates());
      }
    } catch (err) {
      console.error('SessionStateTracker: initial scan error:', err);
    }
  }

  /**
   * Detect the activity state of a session from its messages.
   * Public for testing.
   */
  detectActivityState(messages: ParsedMessage[]): SessionActivityState {
    if (messages.length === 0) return 'idle';

    const isOngoing = checkMessagesOngoing(messages);
    if (!isOngoing) return 'idle';

    // Session is ongoing — determine if working or waiting for input
    for (let i = messages.length - 1; i >= 0; i--) {
      const msg = messages[i];
      if (msg.type !== 'assistant') continue;

      if (msg.toolCalls && msg.toolCalls.length > 0) {
        const pendingToolCalls = msg.toolCalls.filter((tc) => {
          const hasResult = messages
            .slice(i + 1)
            .some((subsequent) => subsequent.toolResults?.some((tr) => tr.toolUseId === tc.id));
          return !hasResult;
        });

        if (pendingToolCalls.length > 0) {
          return 'waiting-for-input';
        }
      }

      break;
    }

    return 'working';
  }

  private async handleFileChange(event: FileChangeEvent): Promise<void> {
    if (this.disposed) return;
    if (!event.sessionId) return;

    if (event.type === 'unlink') {
      this.removeSession(event.sessionId);
      return;
    }

    // Debounce per session
    const existing = this.debounceTimers.get(event.sessionId);
    if (existing) clearTimeout(existing);

    this.debounceTimers.set(
      event.sessionId,
      setTimeout(() => {
        this.debounceTimers.delete(event.sessionId!);
        this.updateSessionState(event.sessionId!, event.projectId).catch((err) => {
          console.error(`Error updating state for session ${event.sessionId}:`, err);
        });
      }, DEBOUNCE_MS)
    );
  }

  private async updateSessionState(sessionId: string, projectId?: string): Promise<void> {
    if (this.disposed) return;

    try {
      // Resolve projectId if not provided
      let resolvedProjectId = projectId;
      if (!resolvedProjectId) {
        const projects = await this.projectScanner.scan();
        const match = projects.find((p) => p.sessions.includes(sessionId));
        resolvedProjectId = match?.id;
      }

      if (!resolvedProjectId) return;

      // Parse the session to get messages
      const parsedSession = await this.sessionParser.parseSession(resolvedProjectId, sessionId);
      const state = this.detectActivityState(parsedSession.messages);

      // Get project info
      const project = await this.projectScanner.getProject(resolvedProjectId);
      const projectPath = project?.path ?? '';
      const projectName = project?.name ?? 'Unknown';

      // Count active sessions in the same project
      const activeInProject = [...this.states.values()].filter(
        (s) => s.projectPath === projectPath && s.sessionId !== sessionId && s.state !== 'idle'
      ).length;
      const sessionCount = activeInProject + (state !== 'idle' ? 1 : 0);

      const prev = this.states.get(sessionId);
      const next: SessionState = {
        sessionId,
        projectPath,
        projectName,
        state,
        sessionCount: Math.max(sessionCount, 1),
        updatedAt: Date.now(),
      };

      if (prev?.state !== next.state) {
        this.states.set(sessionId, next);
        this.emit('state-change', this.getStates());
      } else {
        this.states.set(sessionId, next);
      }
    } catch (err) {
      // Session may have been deleted or be unparseable — skip silently
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
