# Menu Bar Integration — Design Spec

**Date:** 2026-04-01
**Status:** Draft

## Overview

Add a macOS menu bar (tray) icon to claude-devtools that shows the aggregate state of Claude Code sessions at a glance, with a dropdown listing active sessions and their states.

## Goals

1. Menu bar icon changes color based on most urgent session state (gray/blue/amber)
2. Clicking shows a dropdown with active sessions, each with a colored status indicator
3. Clicking a session triggers a configurable action (default: open Ghostty tab)
4. Configurable via the main app's Settings page (enable/disable, auto-hide, click action)

## Architecture

Reuses the existing `SessionStateTracker` — no new data layer.

```
SessionStateTracker (existing)
       ↓ state-change events
TrayManager (new)
       ├── Updates tray icon color (most urgent state)
       ├── Builds context menu (session list with status dots)
       └── Handles click actions (focus Ghostty tab / open devtools)
```

New file: `src/main/services/infrastructure/TrayManager.ts`

- Subscribes to `SessionStateTracker.state-change` events
- Pre-renders 3 icon images at startup using `@napi-rs/canvas` (22x22 colored circles)
- Rebuilds `Tray.setContextMenu()` on each state change
- Reads config for click behavior and auto-hide preference

## Icon States

| State | Icon | Condition |
|-------|------|-----------|
| Neutral | Gray circle | No active sessions, or all idle |
| Working | Blue circle | At least one session is working |
| Waiting | Amber circle | At least one session needs input |

Priority: waiting > working > idle.

When auto-hide is enabled and no sessions are active, the tray icon is removed entirely.

Icons are 22x22 PNG images (macOS menu bar standard), generated with `@napi-rs/canvas` and converted to `NativeImage`. Cached at startup — swapped via `tray.setImage()`.

## Menu Structure

```
┌─────────────────────────────┐
│  Claude Devtools             │
├─────────────────────────────┤
│  🟢 devtools        idle    │
│  🔵 insify-core     working │
│  🟠 spc-socotra     waiting │
├─────────────────────────────┤
│  Open Devtools App           │
│  ─────────────────           │
│  Hide Menu Bar Icon          │
│  Quit                        │
└─────────────────────────────┘
```

- **Header**: "Claude Devtools" (non-clickable label)
- **Session list**: Status emoji + project display name + state text. Only shows sessions with recent file activity (not all historical sessions). Click triggers configured action.
- **Footer**: "Open Devtools App" (brings main window to front), separator, "Hide Menu Bar Icon" (toggles auto-hide), "Quit" (exits app)

Status indicators use emoji for v1: 🟢 idle, 🔵 working, 🟠 waiting. The indicator rendering is isolated into a helper function so it can be swapped to custom icon images later.

## Click Actions

Clicking a session in the dropdown triggers the configured action:

| Action | Behavior |
|--------|----------|
| `open-terminal` (default) | Activate Ghostty, find and focus the tab matching the session title |
| `open-devtools` | Bring claude-devtools window to front |

The Ghostty tab-focusing logic is shared with the StreamDeck integration (reuse `focusGhosttyTab`).

## Configuration

New section in app Settings: "Menu Bar"

| Setting | Type | Default |
|---------|------|---------|
| Show in menu bar | Toggle | On |
| Auto-hide when idle | Toggle | Off |
| Click action | Dropdown | Open Terminal |

Stored in config under `menuBar`:

```typescript
interface MenuBarConfig {
  enabled: boolean;
  autoHide: boolean;
  clickAction: 'open-terminal' | 'open-devtools';
}
```

Default:

```typescript
const MENUBAR_DEFAULTS: MenuBarConfig = {
  enabled: true,
  autoHide: false,
  clickAction: 'open-terminal',
};
```

## Integration Points

- **SessionStateTracker**: subscribe to `state-change` events (same as StreamDeck WS endpoint)
- **ConfigManager**: read/write `menuBar` config section
- **Ghostty tab focusing**: reuse the `focusGhosttyTab` function from `src/main/http/streamdeck.ts` (extract to shared utility)
- **App lifecycle**: create tray in `initializeServices()`, destroy in `shutdownServices()`

## Testing

- **TrayManager**: Unit test state priority logic (waiting > working > idle)
- **Menu building**: Unit test that sessions are filtered to active-only and sorted by state urgency
- **Config**: Verify settings persist and tray responds to config changes

## Out of Scope

- Custom icon images per state (v2 — emoji for now, rendering isolated for easy swap)
- Windows/Linux support (macOS Tray only for now)
- Session grouping by project in the menu (flat list for v1)
