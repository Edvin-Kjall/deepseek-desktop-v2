/**
 * Preload for the local shell (frameless title bar). Exposes only window chrome controls
 * and app-menu + maximize-state so the in-app bar stays isolated from the remote page.
 */
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('shell', {
  /** Minimizes the main window. */
  minimize: () => ipcRenderer.invoke('shell:window-control', 'minimize'),
  /** Toggles between maximized and restored. */
  maximize: () => ipcRenderer.invoke('shell:window-control', 'maximize'),
  /** Closes the window (hides to tray on Windows when configured in main, else quit). */
  close: () => ipcRenderer.invoke('shell:window-control', 'close'),
  /**
   * Returns whether the main window is currently maximized (for restore icon in the bar).
   * @returns {Promise<boolean>}
   */
  isMaximized: () => ipcRenderer.invoke('shell:is-maximized'),
  /**
   * Shows the full application menu as a context popup under the hamburger (integrated UI).
   * @param {number} x client X relative to the shell window (content coordinates)
   * @param {number} y client Y
   */
  showAppMenu: (x, y) => ipcRenderer.invoke('shell:show-app-menu', x, y),
  /**
   * Subscribe to maximize/unmaximize from main (e.g. double-click on title, Win+up).
   * @param {(isMax: boolean) => void} fn
   * @returns {() => void} unsubscribe
   */
  onMaximizeChanged: (fn) => {
    const ch = (_e, isMax) => {
      if (typeof fn === 'function') {
        fn(Boolean(isMax));
      }
    };
    ipcRenderer.on('shell:maximize-changed', ch);
    return () => {
      ipcRenderer.removeListener('shell:maximize-changed', ch);
    };
  },
  /**
   * OS dark/light; shell can tune border contrast (see shell.css).
   * @param {(dark: boolean) => void} fn
   * @returns {() => void}
   */
  onNativeTheme: (fn) => {
    const ch = (_e, dark) => {
      if (typeof fn === 'function') {
        fn(Boolean(dark));
      }
    };
    ipcRenderer.on('shell:native-theme', ch);
    return () => {
      ipcRenderer.removeListener('shell:native-theme', ch);
    };
  },
});
