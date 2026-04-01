import { exec } from 'child_process';

/**
 * Focus the Ghostty terminal tab matching the given session title.
 * Searches all Ghostty windows and tabs, raises the correct window,
 * and sends Cmd+N to switch to the matching tab.
 * Falls back to just activating Ghostty if no match is found.
 */
export function focusGhosttySession(sessionTitle: string): void {
  const searchWords = sessionTitle ? sessionTitle.split(/\s+/).slice(0, 4).join(' ') : '';
  const escaped = searchWords.replace(/\\/g, '\\\\').replace(/"/g, '\\"');

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
        if name of w contains targetWinName or name of w contains "${escaped}" then
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

  exec(`osascript -e '${script.replace(/'/g, "'\"'\"'")}'`, { timeout: 5000 }, () => {});
}

/**
 * Focus the claude-devtools Electron window.
 */
export function focusDevtoolsWindow(): void {
  const { app, BrowserWindow } = require('electron');
  const windows = BrowserWindow.getAllWindows();
  if (windows.length > 0) {
    if (process.platform === 'darwin') {
      app.show();
    }
    windows[0].show();
    windows[0].focus();
  }
}
