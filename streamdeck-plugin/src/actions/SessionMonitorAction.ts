import { execSync } from 'node:child_process';
import type { StateTransport } from '../transport/StateTransport.js';
import type { KeyRenderer } from '../rendering/KeyRenderer.js';
import { BlinkController } from '../rendering/BlinkController.js';
import type { KeySettings, SessionState, SessionActivityState } from '../config/defaults.js';
import { DEFAULT_KEY_SETTINGS } from '../config/defaults.js';

interface ActionContext {
  setImage(base64: string): void;
  setTitle(title: string): void;
  getSettings(): KeySettings;
  showAlert(): void;
}

/** Number of consecutive polls with unchanged updatedAt before we trust waiting-for-input */
const WAITING_CONFIRM_POLLS = 2;

export class SessionMonitorAction {
  private context: ActionContext | null = null;
  private settings: KeySettings = DEFAULT_KEY_SETTINGS;
  private currentSessions: SessionState[] = [];
  private boundSession: SessionState | null = null;
  private blinkController = new BlinkController();
  private lastRenderedImage = '';
  /** Track previous updatedAt to detect activity */
  private lastSeenUpdatedAt = 0;
  /** How many consecutive polls the updatedAt has been stable */
  private stablePolls = 0;

  constructor(
    private readonly transport: StateTransport,
    private readonly renderer: KeyRenderer
  ) {
    this.transport.onStateChange(this.handleStateChange.bind(this));
    this.transport.onConnectionChange(this.handleConnectionChange.bind(this));
  }

  setContext(context: ActionContext): void {
    this.context = context;
  }

  setSettings(settings: KeySettings): void {
    this.settings = { ...DEFAULT_KEY_SETTINGS, ...settings };
    this.updateDisplay();
  }

  setLogger(fn: (msg: string) => void): void {
    this.log = fn;
  }

  private log: (msg: string) => void = () => {};

  async onKeyDown(): Promise<void> {
    this.log(
      `[Action] onKeyDown bound=${!!this.boundSession} state=${this.boundSession?.state} project=${this.settings.projectPath}`
    );
    if (!this.boundSession) return;

    const state = this.getEffectiveState();
    const actionMap = this.settings.actions;
    const action = actionMap[state === 'waiting-for-input' ? 'waiting' : state];

    this.log(`[Action] action=${action} session=${this.boundSession.sessionId}`);
    if (!action || action === 'none') return;

    if (action === 'open-terminal') {
      // Run AppleScript directly from the plugin process (has macOS permissions)
      this.focusGhosttyTab();
    } else {
      // Other actions go through the server
      const result = await this.transport.sendAction(this.boundSession.sessionId, action);
      this.log(`[Action] result=${JSON.stringify(result)}`);
      if (!result.success) {
        this.context?.showAlert();
      }
    }
  }

  private focusGhosttyTab(): void {
    const title = this.boundSession?.sessionTitle ?? '';
    const searchWords = title ? title.split(/\s+/).slice(0, 4).join(' ') : '';
    const escaped = searchWords.replace(/\\/g, '\\\\').replace(/"/g, '\\"');

    this.log(`[Action] focusGhosttyTab search="${escaped}"`);

    const script = escaped
      ? `
set targetWinName to ""
set targetTabNum to 0
tell application "Ghostty"
  set winCount to count of every window
  repeat with wi from 1 to winCount
    set w to window wi
    set tabCount to count of every tab of w
    repeat with ti from 1 to tabCount
      if name of tab ti of w contains "${escaped}" then
        set targetWinName to name of w
        set targetTabNum to ti
        exit repeat
      end if
    end repeat
    if targetTabNum > 0 then exit repeat
  end repeat
end tell
if targetTabNum > 0 then
  tell application "System Events"
    tell process "ghostty"
      set frontmost to true
      repeat with w in windows
        if name of w contains "${escaped}" then
          perform action "AXRaise" of w
          exit repeat
        end if
      end repeat
    end tell
    delay 0.2
    keystroke (targetTabNum as string) using command down
  end tell
else
  tell application "Ghostty" to activate
end if`
      : 'tell application "Ghostty" to activate';

    try {
      execSync(`osascript -e '${script.replace(/'/g, "'\"'\"'")}'`, { timeout: 5000 });
    } catch (err) {
      this.log(`[Action] focusGhosttyTab error: ${err}`);
    }
  }

  dispose(): void {
    this.blinkController.stop();
  }

  private handleStateChange(sessions: SessionState[]): void {
    this.currentSessions = sessions;
    this.updateBoundSession();
    this.updateDisplay();
  }

  private handleConnectionChange(connected: boolean): void {
    if (!connected) {
      this.boundSession = null;
      this.blinkController.stop();
      this.renderKey('disconnected', 'offline', 0);
    }
  }

  private updateBoundSession(): void {
    const matching = this.currentSessions.filter(
      (s) => s.projectPath === this.settings.projectPath
    );

    if (matching.length === 0) {
      this.boundSession = null;
      this.lastSeenUpdatedAt = 0;
      this.stablePolls = 0;
      return;
    }

    this.boundSession = matching.reduce((latest, s) =>
      s.updatedAt > latest.updatedAt ? s : latest
    );

    this.boundSession = {
      ...this.boundSession,
      sessionCount: matching.length,
    };

    // Track updatedAt changes to detect activity
    if (this.boundSession.updatedAt !== this.lastSeenUpdatedAt) {
      this.lastSeenUpdatedAt = this.boundSession.updatedAt;
      this.stablePolls = 0;
    } else {
      this.stablePolls++;
    }
  }

  /**
   * Determine the effective display state.
   * Trust the server state directly — the server-side settle timer
   * already handles the waiting-for-input debounce.
   */
  private getEffectiveState(): SessionActivityState {
    if (!this.boundSession) return 'idle';
    return this.boundSession.state;
  }

  private updateDisplay(): void {
    if (!this.boundSession) {
      this.blinkController.stop();
      this.renderKey('idle', this.settings.projectPath ? 'no session' : 'configure', 0);
      return;
    }

    const effectiveState = this.getEffectiveState();
    const { projectName, sessionCount } = this.boundSession;

    if (effectiveState === 'waiting-for-input') {
      this.startBlinking(projectName, sessionCount);
    } else {
      this.blinkController.stop();
      this.renderKey(effectiveState, projectName, sessionCount);
    }
  }

  private startBlinking(projectName: string, sessionCount: number): void {
    if (this.blinkController.isBlinking()) return;

    this.blinkController.start(this.settings.blinkIntervalMs, (isOn: boolean) => {
      if (isOn) {
        this.renderKey('waiting-for-input', projectName, sessionCount);
      } else {
        this.renderKey('disconnected', projectName, sessionCount);
      }
    });

    this.renderKey('waiting-for-input', projectName, sessionCount);
  }

  private async renderKey(
    state: SessionActivityState | 'disconnected',
    projectName: string,
    sessionCount: number
  ): Promise<void> {
    try {
      const image = await this.renderer.render({
        projectName,
        state,
        sessionCount,
        settings: this.settings,
      });

      if (image !== this.lastRenderedImage) {
        this.lastRenderedImage = image;
        this.context?.setImage(image);
      }
    } catch {
      // Render failure — don't crash the plugin
    }
  }
}
