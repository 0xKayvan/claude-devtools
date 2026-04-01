// streamdeck-plugin/src/actions/SessionMonitorAction.ts
import type { StateTransport } from '../transport/StateTransport.js';
import type { KeyRenderer, RenderOptions } from '../rendering/KeyRenderer.js';
import { BlinkController } from '../rendering/BlinkController.js';
import type { KeySettings, SessionState, SessionActivityState } from '../config/defaults.js';
import { DEFAULT_KEY_SETTINGS } from '../config/defaults.js';

interface ActionContext {
  setImage(base64: string): void;
  setTitle(title: string): void;
  getSettings(): KeySettings;
  showAlert(): void;
}

export class SessionMonitorAction {
  private context: ActionContext | null = null;
  private settings: KeySettings = DEFAULT_KEY_SETTINGS;
  private currentSessions: SessionState[] = [];
  private boundSession: SessionState | null = null;
  private blinkController = new BlinkController();
  private lastRenderedImage = '';

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

  async onKeyDown(): Promise<void> {
    if (!this.boundSession) return;

    const state = this.boundSession.state;
    const actionMap = this.settings.actions;
    const action = actionMap[state === 'waiting-for-input' ? 'waiting' : state];

    if (action && action !== 'none') {
      const result = await this.transport.sendAction(this.boundSession.sessionId, action);
      if (!result.success) {
        this.context?.showAlert();
      }
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
      this.renderKey('disconnected', 'offline', 0);
    }
  }

  private updateBoundSession(): void {
    const matching = this.currentSessions.filter(
      (s) => s.projectPath === this.settings.projectPath
    );

    if (matching.length === 0) {
      this.boundSession = null;
      return;
    }

    this.boundSession = matching.reduce((latest, s) =>
      s.updatedAt > latest.updatedAt ? s : latest
    );

    this.boundSession = {
      ...this.boundSession,
      sessionCount: matching.length,
    };
  }

  private updateDisplay(): void {
    if (!this.boundSession) {
      this.blinkController.stop();
      this.renderKey('idle', this.settings.projectPath ? 'no session' : 'configure', 0);
      return;
    }

    const { state, projectName, sessionCount } = this.boundSession;

    if (state === 'waiting-for-input') {
      this.startBlinking(projectName, sessionCount);
    } else {
      this.blinkController.stop();
      this.renderKey(state, projectName, sessionCount);
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
