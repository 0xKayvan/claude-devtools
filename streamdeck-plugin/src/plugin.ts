import streamDeck, {
  SingletonAction,
  type WillAppearEvent,
  type WillDisappearEvent,
  type KeyDownEvent,
  type DidReceiveSettingsEvent,
} from '@elgato/streamdeck';
import { SessionMonitorAction as SessionMonitor } from './actions/SessionMonitorAction.js';
import { SseTransport } from './transport/SseTransport.js';
import { KeyRenderer } from './rendering/KeyRenderer.js';
import { DEFAULT_KEY_SETTINGS } from './config/defaults.js';
import type { JsonObject } from '@elgato/utils';

const transport = new SseTransport();
const renderer = new KeyRenderer();

// Map of action context IDs to SessionMonitor instances
const monitors = new Map<string, SessionMonitor>();

class SessionMonitorAction extends SingletonAction {
  override onWillAppear(ev: WillAppearEvent<JsonObject>): void {
    const monitor = new SessionMonitor(transport, renderer);
    const settings = { ...DEFAULT_KEY_SETTINGS, ...ev.payload.settings };

    monitor.setContext({
      setImage: (base64: string) => ev.action.setImage(`data:image/png;base64,${base64}`),
      setTitle: (title: string) => ev.action.setTitle(title),
      getSettings: () => settings,
      showAlert: () => ev.action.showAlert(),
    });

    monitor.setSettings(settings);

    if (!transport.isConnected()) {
      transport.connect(settings.serverUrl);
    }

    monitors.set(ev.action.id, monitor);
  }

  override onWillDisappear(ev: WillDisappearEvent<JsonObject>): void {
    const monitor = monitors.get(ev.action.id);
    monitor?.dispose();
    monitors.delete(ev.action.id);
  }

  override async onKeyDown(ev: KeyDownEvent<JsonObject>): Promise<void> {
    const monitor = monitors.get(ev.action.id);
    await monitor?.onKeyDown();
  }

  override onDidReceiveSettings(ev: DidReceiveSettingsEvent<JsonObject>): void {
    const monitor = monitors.get(ev.action.id);
    const settings = { ...DEFAULT_KEY_SETTINGS, ...ev.payload.settings };
    monitor?.setSettings(settings);
  }
}

// Register and connect
const sessionMonitorAction = new SessionMonitorAction();
streamDeck.actions.registerAction(sessionMonitorAction);
streamDeck.connect();
