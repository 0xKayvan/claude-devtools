import streamDeck, { LogLevel } from '@elgato/streamdeck';
import { SessionMonitorAction } from './actions/SessionMonitorAction';
import { SseTransport } from './transport/SseTransport';
import { KeyRenderer } from './rendering/KeyRenderer';
import { DEFAULT_KEY_SETTINGS } from './config/defaults';

streamDeck.logger.setLevel(LogLevel.DEBUG);

const transport = new SseTransport();
const renderer = new KeyRenderer();

streamDeck.actions.registerAction('com.claude-devtools.session-monitor', {
  onWillAppear: (ev) => {
    const action = new SessionMonitorAction(transport, renderer);
    const settings = { ...DEFAULT_KEY_SETTINGS, ...ev.payload.settings };

    action.setContext({
      setImage: (base64: string) => ev.action.setImage(`data:image/png;base64,${base64}`),
      setTitle: (title: string) => ev.action.setTitle(title),
      getSettings: () => settings,
      showAlert: () => ev.action.showAlert(),
    });

    action.setSettings(settings);

    if (!transport.isConnected()) {
      transport.connect(settings.serverUrl);
    }

    ev.action.__sessionMonitor = action;
  },

  onWillDisappear: (ev) => {
    const action = ev.action.__sessionMonitor as SessionMonitorAction | undefined;
    action?.dispose();
  },

  onKeyDown: async (ev) => {
    const action = ev.action.__sessionMonitor as SessionMonitorAction | undefined;
    await action?.onKeyDown();
  },

  onDidReceiveSettings: (ev) => {
    const action = ev.action.__sessionMonitor as SessionMonitorAction | undefined;
    const settings = { ...DEFAULT_KEY_SETTINGS, ...ev.payload.settings };
    action?.setSettings(settings);
  },
});

streamDeck.connect();
