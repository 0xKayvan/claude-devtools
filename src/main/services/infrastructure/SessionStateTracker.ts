import { EventEmitter } from 'events';

import { checkMessagesOngoing } from '../../utils/sessionStateDetection';

import type { FileChangeEvent } from '../../types';
import type { ParsedMessage } from '../../types';
import type { ProjectScanner } from '../discovery/ProjectScanner';
import type { SessionParser } from '../parsing/SessionParser';
import type { FileWatcher } from './FileWatcher';
import type { SessionActivityState, SessionState } from '@shared/types/streamdeck';

const DEBOUNCE_MS = 200;
/** How long a file must be quiet before we consider it "waiting for input" */
const WAITING_SETTLE_MS = 3000;

export class SessionStateTracker extends EventEmitter {
  private states = new Map<string, SessionState>();
  private debounceTimers = new Map<string, NodeJS.Timeout>();
  private waitingTimers = new Map<string, NodeJS.Timeout>();
  /** Tracks the last time each session's file was modified */
  private lastFileChange = new Map<string, number>();
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

    // Record file modification time
    this.lastFileChange.set(event.sessionId, Date.now());

    // Cancel any pending waiting-for-input timer (file just changed = still active)
    const waitingTimer = this.waitingTimers.get(event.sessionId);
    if (waitingTimer) {
      clearTimeout(waitingTimer);
      this.waitingTimers.delete(event.sessionId);
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
      let resolvedProjectId = projectId;
      if (!resolvedProjectId) {
        const projects = await this.projectScanner.scan();
        const match = projects.find((p) => p.sessions.includes(sessionId));
        resolvedProjectId = match?.id;
      }

      if (!resolvedProjectId) return;

      const parsedSession = await this.sessionParser.parseSession(resolvedProjectId, sessionId);
      let state = this.detectActivityState(parsedSession.messages);

      // If the raw state is waiting-for-input but the file was just modified,
      // the tool is still executing — report as "working" and schedule a
      // delayed re-check to see if it settles into waiting-for-input.
      if (state === 'waiting-for-input') {
        const lastChange = this.lastFileChange.get(sessionId) ?? 0;
        const timeSinceChange = Date.now() - lastChange;

        if (timeSinceChange < WAITING_SETTLE_MS) {
          // File was recently modified — tool is still executing
          state = 'working';

          // Schedule a re-check after the settle period
          if (!this.waitingTimers.has(sessionId)) {
            this.waitingTimers.set(
              sessionId,
              setTimeout(
                () => {
                  this.waitingTimers.delete(sessionId);
                  this.updateSessionState(sessionId, resolvedProjectId).catch(() => {});
                },
                WAITING_SETTLE_MS - timeSinceChange + 100
              )
            );
          }
        }
      }

      const project = await this.projectScanner.getProject(resolvedProjectId);
      const projectPath = project?.path ?? '';
      const projectName = project?.name ?? 'Unknown';

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

      // Always update the state map; only emit when state changes
      this.states.set(sessionId, next);
      if (prev?.state !== next.state) {
        this.emit('state-change', this.getStates());
      }
    } catch {
      // Session may have been deleted or be unparseable — skip silently
    }
  }

  private removeSession(sessionId: string): void {
    const waitingTimer = this.waitingTimers.get(sessionId);
    if (waitingTimer) {
      clearTimeout(waitingTimer);
      this.waitingTimers.delete(sessionId);
    }
    this.lastFileChange.delete(sessionId);
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
    for (const timer of this.waitingTimers.values()) {
      clearTimeout(timer);
    }
    this.debounceTimers.clear();
    this.waitingTimers.clear();
    this.lastFileChange.clear();
    this.states.clear();
    this.removeAllListeners();
  }
}
