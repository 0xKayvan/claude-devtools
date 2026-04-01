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
transport.setLogger((msg) => streamDeck.logger.info(msg));
const renderer = new KeyRenderer();

// Map of action context IDs to SessionMonitor instances
const monitors = new Map<string, SessionMonitor>();

function bootstrapAction(act: {
  id: string;
  setImage: (img: string) => Promise<void>;
  setTitle: (t: string) => Promise<void>;
  showAlert: () => Promise<void>;
  getSettings: () => Promise<JsonObject>;
}): void {
  act
    .getSettings()
    .then((settings: JsonObject) => {
      const merged = { ...DEFAULT_KEY_SETTINGS, ...settings };
      const monitor = new SessionMonitor(transport, renderer);
      monitor.setContext({
        setImage: (base64: string) => act.setImage(`data:image/png;base64,${base64}`),
        setTitle: (title: string) => act.setTitle(title),
        getSettings: () => merged,
        showAlert: () => act.showAlert(),
      });
      monitor.setSettings(merged);
      if (!transport.isConnected()) {
        streamDeck.logger.info(`[Plugin] Connecting transport to ${merged.serverUrl}`);
        transport.connect(merged.serverUrl);
      }
      monitors.set(act.id, monitor);
      streamDeck.logger.info(
        `[Plugin] Bootstrapped action ${act.id}, project=${merged.projectPath}`
      );
    })
    .catch((err: unknown) => {
      streamDeck.logger.error(`[Plugin] Bootstrap failed: ${err}`);
    });
}

class SessionMonitorActionSD extends SingletonAction {
  override onWillAppear(ev: WillAppearEvent<JsonObject>): void {
    streamDeck.logger.info(`[Plugin] onWillAppear id=${ev.action.id}`);
    bootstrapAction(ev.action as any);
  }

  override onWillDisappear(ev: WillDisappearEvent<JsonObject>): void {
    streamDeck.logger.info(`[Plugin] onWillDisappear id=${ev.action.id}`);
    const monitor = monitors.get(ev.action.id);
    monitor?.dispose();
    monitors.delete(ev.action.id);
  }

  override async onKeyDown(ev: KeyDownEvent<JsonObject>): Promise<void> {
    streamDeck.logger.info(`[Plugin] onKeyDown id=${ev.action.id}`);
    const monitor = monitors.get(ev.action.id);
    await monitor?.onKeyDown();
  }

  override onDidReceiveSettings(ev: DidReceiveSettingsEvent<JsonObject>): void {
    streamDeck.logger.info(`[Plugin] onDidReceiveSettings id=${ev.action.id}`);
    const monitor = monitors.get(ev.action.id);
    if (monitor) {
      const settings = { ...DEFAULT_KEY_SETTINGS, ...ev.payload.settings };
      monitor.setSettings(settings);
    }
  }
}

// Explicit registration — set manifestId directly instead of using decorator
const sdAction = new SessionMonitorActionSD();
(sdAction as any).manifestId = 'dev.nouri.tools.claude-devtools.session-monitor';
streamDeck.actions.registerAction(sdAction);

streamDeck
  .connect()
  .then(() => {
    streamDeck.logger.info(`[Plugin] Connected to StreamDeck`);

    // Bootstrap any keys that were visible before the plugin connected
    const visible = [...sdAction.actions];
    streamDeck.logger.info(`[Plugin] Visible actions after connect: ${visible.length}`);
    for (const act of visible) {
      if (!monitors.has(act.id)) {
        streamDeck.logger.info(`[Plugin] Late-bootstrapping action ${act.id}`);
        bootstrapAction(act as any);
      }
    }
  })
  .catch((err: unknown) => {
    streamDeck.logger.error(`[Plugin] Connect failed: ${err}`);
  });
