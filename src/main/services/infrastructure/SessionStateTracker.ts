import { EventEmitter } from 'events';
import * as fs from 'fs';
import * as path from 'path';

import { checkMessagesOngoing } from '../../utils/sessionStateDetection';

import type { FileChangeEvent } from '../../types';
import type { ParsedMessage } from '../../types';
import type { ProjectScanner } from '../discovery/ProjectScanner';
import type { SessionParser } from '../parsing/SessionParser';
import type { FileWatcher } from './FileWatcher';
import type { SessionActivityState, SessionState } from '@shared/types/streamdeck';

const DEBOUNCE_MS = 100;
/** How long a file must be quiet before we consider it "waiting for input" */
const WAITING_SETTLE_MS = 1000;

export class SessionStateTracker extends EventEmitter {
  private states = new Map<string, SessionState>();
  private debounceTimers = new Map<string, NodeJS.Timeout>();
  private waitingTimers = new Map<string, NodeJS.Timeout>();
  private lastFileChange = new Map<string, number>();
  private disposed = false;

  constructor(
    private readonly fileWatcher: FileWatcher,
    private readonly sessionParser: SessionParser,
    private readonly projectScanner: ProjectScanner
  ) {
    super();
    this.fileWatcher.on('file-change', this.handleFileChange.bind(this));
    // No initial scan — states are populated lazily as file-change events arrive.
    // This avoids parsing all session files on startup which blocks the event loop.
  }

  /**
   * Detect the activity state of a session from its messages.
   * Public for testing.
   */
  detectActivityState(messages: ParsedMessage[]): SessionActivityState {
    if (messages.length === 0) return 'idle';

    const isOngoing = checkMessagesOngoing(messages);
    if (!isOngoing) return 'idle';

    for (let i = messages.length - 1; i >= 0; i--) {
      const msg = messages[i];
      if (msg.type !== 'assistant') continue;

      if (msg.toolCalls && msg.toolCalls.length > 0) {
        // Tools that don't require user input — they're internal orchestration
        const INTERNAL_TOOLS = new Set([
          'Task',
          'TaskCreate',
          'TaskUpdate',
          'TaskGet',
          'TaskList',
          'TaskStop',
          'Agent',
          'SendMessage',
          'TeamCreate',
          'TeamDelete',
          'EnterPlanMode',
          'ExitPlanMode',
        ]);

        const pendingUserTools = msg.toolCalls.filter((tc) => {
          // Skip internal tools — they never wait for user input
          if (INTERNAL_TOOLS.has(tc.name)) return false;
          const hasResult = messages
            .slice(i + 1)
            .some((subsequent) => subsequent.toolResults?.some((tr) => tr.toolUseId === tc.id));
          return !hasResult;
        });

        if (pendingUserTools.length > 0) {
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

    // For subagent file changes, trigger a re-evaluation of the parent session
    // so that subagent waiting-for-input propagates to the parent's state
    if (event.isSubagent) {
      // event.sessionId for subagents is the parent session ID
      const parentSessionId = event.sessionId;
      if (this.states.has(parentSessionId)) {
        this.lastFileChange.set(parentSessionId, Date.now());
        const existing = this.debounceTimers.get(parentSessionId);
        if (existing) clearTimeout(existing);
        this.debounceTimers.set(
          parentSessionId,
          setTimeout(() => {
            this.debounceTimers.delete(parentSessionId);
            this.updateSessionState(parentSessionId, event.projectId).catch(() => {});
          }, DEBOUNCE_MS)
        );
      }
      return;
    }

    if (event.type === 'unlink') {
      this.removeSession(event.sessionId);
      return;
    }

    this.lastFileChange.set(event.sessionId, Date.now());

    // Cancel any pending waiting-for-input timer
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
        this.updateSessionState(event.sessionId!, event.projectId).catch(() => {});
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

      // If the main session is "working" (has pending internal tools like Agent/Task),
      // check if any active subagent is waiting for user input
      if (state === 'working') {
        const subagentWaiting = await this.checkSubagentsWaiting(resolvedProjectId, sessionId);
        if (subagentWaiting) {
          state = 'waiting-for-input';
        }
      }

      // If raw state is waiting-for-input but file was recently modified,
      // the tool is still executing — report as working.
      if (state === 'waiting-for-input') {
        const lastChange = this.lastFileChange.get(sessionId) ?? 0;
        const timeSinceChange = Date.now() - lastChange;

        if (timeSinceChange < WAITING_SETTLE_MS) {
          state = 'working';

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

      // Extract session title from first real user message (skip XML/command messages)
      const firstUserMsg = parsedSession.messages.find(
        (m) =>
          m.type === 'user' &&
          !m.isMeta &&
          typeof m.content === 'string' &&
          !m.content.startsWith('<')
      );
      const sessionTitle =
        typeof firstUserMsg?.content === 'string' ? firstUserMsg.content.slice(0, 120) : '';

      const activeInProject = [...this.states.values()].filter(
        (s) => s.projectPath === projectPath && s.sessionId !== sessionId && s.state !== 'idle'
      ).length;
      const sessionCount = activeInProject + (state !== 'idle' ? 1 : 0);

      const prev = this.states.get(sessionId);
      const next: SessionState = {
        sessionId,
        projectPath,
        projectName,
        sessionTitle,
        state,
        sessionCount: Math.max(sessionCount, 1),
        updatedAt: Date.now(),
      };

      this.states.set(sessionId, next);
      // Always emit — plugin uses updatedAt changes to detect activity
      this.emit('state-change', this.getStates());
    } catch {
      // Session may have been deleted or be unparseable
    }
  }

  /**
   * Check if any subagent of the given session is waiting for user input.
   * Reads the most recently modified subagent JSONL files and checks their state.
   */
  private async checkSubagentsWaiting(projectId: string, sessionId: string): Promise<boolean> {
    try {
      const subagentsDir = this.projectScanner.getSubagentsPath(projectId, sessionId);
      if (!fs.existsSync(subagentsDir)) return false;

      const files = fs
        .readdirSync(subagentsDir)
        .filter((f) => f.endsWith('.jsonl'))
        .map((f) => ({
          name: f,
          path: path.join(subagentsDir, f),
          mtime: fs.statSync(path.join(subagentsDir, f)).mtimeMs,
        }))
        // Only check recently modified subagents (last 30 seconds)
        .filter((f) => Date.now() - f.mtime < 30_000)
        .sort((a, b) => b.mtime - a.mtime)
        .slice(0, 5); // Check at most 5 most recent

      for (const file of files) {
        try {
          const parsed = await this.sessionParser.parseSessionFile(file.path);
          const subState = this.detectActivityState(parsed.messages);
          if (subState === 'waiting-for-input') {
            return true;
          }
        } catch {
          // Skip unparseable subagent files
        }
      }
    } catch {
      // Subagent directory doesn't exist or can't be read
    }
    return false;
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
