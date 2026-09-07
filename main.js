/**
 * Main process: frameless shell (integrated title bar) + BrowserView for chat,
 * with tray, single instance, persisted bounds, and external link handling.
 */

const { app, BrowserWindow, BrowserView, Menu, ipcMain, Tray, nativeImage, shell, dialog, nativeTheme, screen } = require('electron');
const path = require('path');
const fs = require('fs');

const CHAT_URL = 'https://chat.deepseek.com/';
/** Pixels reserved at the top for the local HTML title bar; must match `shell.css` / `shell.html`. */
const TITLEBAR_HEIGHT = 40;

let mainWindow = null;
/** Embedded chat (DeepSeek) — separate from the local shell so the top bar can stay in-page. */
let chatView = null;
let tray = null;
app.isQuiting = false;
let saveWindowStateTimer = null;

const gotTheLock = app.requestSingleInstanceLock();

// -----------------------------------------------------------------------------
// Window state
// -----------------------------------------------------------------------------

function getWindowStateFilePath() {
  return path.join(app.getPath('userData'), 'window-state.json');
}

/** App-level preferences (separate from window geometry) stored in userData. */
function getAppSettingsFilePath() {
  return path.join(app.getPath('userData'), 'app-settings.json');
}

/**
 * @returns {{ collapseThoughtByDefault: boolean }}
 */
function readAppSettings() {
  const defaults = { collapseThoughtByDefault: true };
  try {
    const p = getAppSettingsFilePath();
    if (fs.existsSync(p)) {
      return { ...defaults, ...JSON.parse(fs.readFileSync(p, 'utf8')) };
    }
  } catch {
    // fall through
  }
  return { ...defaults };
}

/**
 * @param {Partial<{ collapseThoughtByDefault: boolean }>} partial
 */
function writeAppSettings(partial) {
  try {
    const next = { ...readAppSettings(), ...partial };
    fs.writeFileSync(getAppSettingsFilePath(), JSON.stringify(next, null, 2), 'utf8');
  } catch {
    // ignore
  }
}

let collapseThoughtSource = null;
function getCollapseThoughtInjectSource() {
  // In development, always re-read the file so injection edits work after View → Reload.
  if (!app.isPackaged) {
    const injectPath = path.join(__dirname, 'injections', 'collapse-thought.js');
    return fs.readFileSync(injectPath, 'utf8');
  }
  if (collapseThoughtSource) {
    return collapseThoughtSource;
  }
  const injectPath = path.join(__dirname, 'injections', 'collapse-thought.js');
  collapseThoughtSource = fs.readFileSync(injectPath, 'utf8');
  return collapseThoughtSource;
}

/**
 * Tries to collapse the thought block: first in-page pointer/mouse chain (React listens
 * on the real element; this often works when sendInputEvent from main does not).
 * Falls back to sendInputEvent + rect from __dsDesktopGetThoughtToggleRect.
 */
function sendNativeThoughtToggleClick(wc) {
  if (!wc || wc.isDestroyed()) {
    return;
  }
  if (readAppSettings().collapseThoughtByDefault === false) {
    return;
  }
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.focus();
  }
  if (typeof wc.focus === 'function') {
    wc.focus();
  }
  return wc
    .executeJavaScript(`(function(){
      if (typeof window.__dsDesktopPerformCollapseClick === 'function') {
        return window.__dsDesktopPerformCollapseClick();
      }
      return false;
    })()`)
    .then((didPerform) => {
      if (didPerform) {
        return;
      }
      return wc
        .executeJavaScript(
          'typeof window.__dsDesktopGetThoughtToggleRect === "function" ? window.__dsDesktopGetThoughtToggleRect() : null',
        )
        .then((rect) => {
          if (!rect || typeof rect.left !== 'number' || !rect.width || rect.width < 1) {
            return;
          }
          const x = Math.round(rect.left + rect.width / 2);
          const y = Math.round(rect.top + rect.height / 2);
          try {
            wc.sendInputEvent({ type: 'mouseDown', x, y, button: 'left', clickCount: 1 });
            wc.sendInputEvent({ type: 'mouseUp', x, y, button: 'left', clickCount: 1 });
          } catch (e) {
            if (!app.isPackaged) {
              console.error('sendNativeThoughtToggleClick sendInputEvent', e);
            }
          }
        });
    })
    .catch((e) => {
      if (!app.isPackaged) {
        console.error('sendNativeThoughtToggleClick', e);
      }
    });
}

/**
 * The thought section often appears after stream delay; try several times.
 */
function scheduleNativeThoughtClicks(wc) {
  if (!wc || wc.isDestroyed()) {
    return;
  }
  [180, 600, 1400, 3000, 6000, 10000, 15000].forEach((d) => {
    setTimeout(() => {
      sendNativeThoughtToggleClick(wc);
    }, d);
  });
}

/**
 * Injects the “collapse Thought by default” script into the chat webContents, after
 * setting the opt-out flag. Safe to call on each navigation; the script is idempotent.
 */
function injectCollapseThoughtScript(wc) {
  if (!wc || wc.isDestroyed()) {
    return;
  }
  let body;
  try {
    body = getCollapseThoughtInjectSource();
  } catch {
    return;
  }
  const want = readAppSettings().collapseThoughtByDefault !== false;
  const preamble = 'window.__DS_DESKTOP_COLLAPSE_THOUGHT__=' + JSON.stringify(want) + ';\n';
  const code = preamble + body;
  return wc
    .executeJavaScript(code)
    .then(() => {
      scheduleNativeThoughtClicks(wc);
    })
    .catch((e) => {
      if (!app.isPackaged) {
        console.error('injectCollapseThoughtScript', e);
      }
    });
}

function readWindowState() {
  try {
    const p = getWindowStateFilePath();
    if (fs.existsSync(p)) {
      return JSON.parse(fs.readFileSync(p, 'utf8'));
    }
  } catch {
    // ignore
  }
  return null;
}

function writeWindowState() {
  if (!mainWindow) {
    return;
  }
  const isMaximized = mainWindow.isMaximized();
  const bounds = mainWindow.getNormalBounds();
  const payload = {
    x: bounds.x,
    y: bounds.y,
    width: bounds.width,
    height: bounds.height,
    isMaximized,
  };
  try {
    fs.writeFileSync(getWindowStateFilePath(), JSON.stringify(payload, null, 2), 'utf8');
  } catch {
    // ignore
  }
}

function scheduleWriteWindowState() {
  if (saveWindowStateTimer) {
    clearTimeout(saveWindowStateTimer);
  }
  saveWindowStateTimer = setTimeout(() => {
    saveWindowStateTimer = null;
    writeWindowState();
  }, 400);
}

function getDefaultWindowState() {
  return { width: 1280, height: 800, isMaximized: false, x: undefined, y: undefined };
}

function resolveWindowStateForNewWindow() {
  const minW = 800;
  const minH = 600;
  const defaults = getDefaultWindowState();
  const raw = readWindowState();
  if (!raw) {
    return { ...defaults };
  }
  const width = Math.max(minW, Math.min(12000, Number(raw.width) || defaults.width));
  const height = Math.max(minH, Math.min(12000, Number(raw.height) || defaults.height));
  const x = Number.isFinite(raw.x) ? Math.round(raw.x) : undefined;
  const y = Number.isFinite(raw.y) ? Math.round(raw.y) : undefined;
  const isMaximized = Boolean(raw.isMaximized);
  if (x !== undefined && y !== undefined) {
    const rect = { x, y, width, height };
    const inAny = screen.getAllDisplays().some((d) => {
      const b = d.workArea;
      return rect.x < b.x + b.width - 40 && rect.x + rect.width > b.x + 40 && rect.y < b.y + b.height - 40 && rect.y + 80 > b.y;
    });
    if (!inAny) {
      return { width, height, isMaximized, x: undefined, y: undefined };
    }
  }
  return { width, height, isMaximized, x, y };
}

function getBackgroundForTheme() {
  return nativeTheme.shouldUseDarkColors ? '#1e1e1e' : '#ffffff';
}

function getAppIconPath() {
  return path.join(__dirname, 'build', 'icon.png');
}

// -----------------------------------------------------------------------------
// Chat webContents: explicit reload/zoom/devtools (menu roles can target the wrong view)
// -----------------------------------------------------------------------------

function getChatWebContents() {
  if (!chatView || chatView.webContents.isDestroyed()) {
    return null;
  }
  return chatView.webContents;
}

// -----------------------------------------------------------------------------
// System tray
// -----------------------------------------------------------------------------

function createTray() {
  if (tray) {
    return;
  }
  if (process.platform === 'darwin') {
    return;
  }
  const iconPath = getAppIconPath();
  if (!fs.existsSync(iconPath)) {
    return;
  }
  const image = nativeImage.createFromPath(iconPath);
  const traySize = 16;
  const trayImage = image.isEmpty() ? image : image.resize({ width: traySize, height: traySize });
  tray = new Tray(trayImage);
  tray.setToolTip('DeepSeek Desktop');

  const showWindow = () => {
    if (mainWindow) {
      mainWindow.show();
    }
  };

  const contextMenu = Menu.buildFromTemplate([
    { label: 'Show', click: showWindow },
    { type: 'separator' },
    {
      label: 'Quit',
      click: () => {
        app.isQuiting = true;
        app.quit();
      },
    },
  ]);
  tray.setContextMenu(contextMenu);
  tray.on('double-click', showWindow);
}

function destroyTray() {
  if (tray) {
    tray.destroy();
    tray = null;
  }
}

// -----------------------------------------------------------------------------
// About
// -----------------------------------------------------------------------------

function showAboutDialog() {
  const detail = `Version ${app.getVersion()}

A native desktop window for the official ${CHAT_URL} experience.

Data is subject to DeepSeek’s terms; this app is a shell around their website.`;
  dialog.showMessageBox(mainWindow && !mainWindow.isDestroyed() ? mainWindow : undefined, {
    type: 'info',
    title: 'About DeepSeek Desktop',
    message: 'DeepSeek Desktop',
    detail,
  });
}

// -----------------------------------------------------------------------------
// Application menu: used only as a popup (no native menubar) for integrated "Fastmail-style" UI
// -----------------------------------------------------------------------------

function buildAppMenu() {
  const isDev = !app.isPackaged;
  const fileMenu = {
    label: 'File',
    submenu: [
      { role: 'quit' },
    ],
  };
  const viewSubmenu = [
    {
      label: 'Reload',
      accelerator: 'CmdOrCtrl+R',
      click: () => {
        getChatWebContents()?.reload();
      },
    },
    {
      label: 'Force reload',
      accelerator: 'CmdOrCtrl+Shift+R',
      click: () => {
        getChatWebContents()?.reloadIgnoringCache();
      },
    },
    { type: 'separator' },
    {
      label: 'Reset zoom',
      click: () => {
        getChatWebContents()?.setZoomLevel(0);
      },
    },
    {
      label: 'Zoom in',
      accelerator: 'CmdOrCtrl+=',
      click: () => {
        const w = getChatWebContents();
        if (w) {
          w.setZoomLevel(w.getZoomLevel() + 0.5);
        }
      },
    },
    {
      label: 'Zoom out',
      accelerator: 'CmdOrCtrl+-',
      click: () => {
        const w = getChatWebContents();
        if (w) {
          w.setZoomLevel(w.getZoomLevel() - 0.5);
        }
      },
    },
    { type: 'separator' },
    {
      label: 'Collapse “Thought” blocks by default (web UI)',
      type: 'checkbox',
      checked: readAppSettings().collapseThoughtByDefault !== false,
      click: (mi) => {
        const on = Boolean(mi.checked);
        writeAppSettings({ collapseThoughtByDefault: on });
        const w = getChatWebContents();
        if (w) {
          w.executeJavaScript(
            'window.__DS_DESKTOP_COLLAPSE_THOUGHT__=' + JSON.stringify(on) + ';' +
              'if (window.__dsDesktopThoughtCollapseRun) window.__dsDesktopThoughtCollapseRun();',
          ).catch(() => {});
        }
      },
    },
  ];
  if (isDev) {
    viewSubmenu.push(
      { type: 'separator' },
      {
        label: 'Toggle developer tools',
        accelerator: 'F12',
        click: () => {
          const w = getChatWebContents();
          if (w) {
            if (w.isDevToolsOpened()) {
              w.closeDevTools();
            } else {
              w.openDevTools({ mode: 'detach' });
            }
          }
        },
      }
    );
  }
  const viewMenu = { label: 'View', submenu: viewSubmenu };
  const windowMenu = {
    label: 'Window',
    submenu: [
      { role: 'minimize' },
      { type: 'separator' },
      { role: 'close' },
    ],
  };
  const helpMenu = {
    label: 'Help',
    submenu: [
      {
        label: 'About DeepSeek Desktop',
        click: () => showAboutDialog(),
      },
      { type: 'separator' },
      {
        label: 'DeepSeek in browser…',
        click: () => shell.openExternal(CHAT_URL),
      },
    ],
  };

  if (process.platform === 'darwin') {
    return Menu.buildFromTemplate([
      {
        label: app.name,
        submenu: [
          { role: 'about' },
          { type: 'separator' },
          { role: 'services' },
          { type: 'separator' },
          { role: 'hide' },
          { role: 'hideOthers' },
          { role: 'unhide' },
          { type: 'separator' },
          { role: 'quit' },
        ],
      },
      { label: 'File', submenu: [{ role: 'close' }] },
      viewMenu,
      windowMenu,
      helpMenu,
    ]);
  }

  return Menu.buildFromTemplate([fileMenu, viewMenu, windowMenu, helpMenu]);
}

function setMacAboutPanel() {
  if (process.platform !== 'darwin') {
    return;
  }
  app.setAboutPanelOptions({
    applicationName: 'DeepSeek Desktop',
    applicationVersion: app.getVersion(),
    version: app.getVersion(),
    copyright: `Copyright ${new Date().getFullYear()} — Shell for ${CHAT_URL}`,
  });
}

// -----------------------------------------------------------------------------
// Layout chat BrowserView under the in-app title bar
// -----------------------------------------------------------------------------

function layoutChatView() {
  if (!mainWindow || mainWindow.isDestroyed() || !chatView || chatView.webContents.isDestroyed()) {
    return;
  }
  const b = mainWindow.getContentBounds();
  const h = Math.max(0, b.height - TITLEBAR_HEIGHT);
  chatView.setBounds({ x: 0, y: TITLEBAR_HEIGHT, width: b.width, height: h });
}

/**
 * Tells the shell to refresh maximize icon + theme; keeps the in-app title bar in sync.
 */
function broadcastMaximizeToShell() {
  if (mainWindow && !mainWindow.isDestroyed() && mainWindow.webContents && !mainWindow.webContents.isDestroyed()) {
    mainWindow.webContents.send('shell:maximize-changed', mainWindow.isMaximized());
  }
}

function broadcastNativeThemeToShell() {
  if (mainWindow && !mainWindow.isDestroyed() && mainWindow.webContents && !mainWindow.webContents.isDestroyed()) {
    mainWindow.webContents.send('shell:native-theme', nativeTheme.shouldUseDarkColors);
  }
}

// -----------------------------------------------------------------------------
// Main window: frameless + local shell + BrowserView for chat
// -----------------------------------------------------------------------------

function createMainWindow() {
  const s = resolveWindowStateForNewWindow();
  const win = new BrowserWindow({
    width: s.width,
    height: s.height,
    x: s.x,
    y: s.y,
    minWidth: 800,
    minHeight: 600,
    show: false,
    frame: false,
    backgroundColor: getBackgroundForTheme(),
    icon: getAppIconPath(),
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      preload: path.join(__dirname, 'shell-preload.js'),
    },
  });

  mainWindow = win;

  const view = new BrowserView({
    webPreferences: {
      // No preload for the remote chat: a previous preload cleared localStorage on every
      // load, which logged users out and wiped DeepSeek session keys. The site does not
      // need our contextBridge; injections run via executeJavaScript in main.
      nodeIntegration: false,
      contextIsolation: true,
    },
  });
  chatView = view;

  // Best-effort: match the bundled Chromium’s Chrome User-Agent so the site is less
  // likely to show "abnormal usage environment" (not guaranteed; server may fingerprint
  // Electron in other ways). See comment on ToS/fragility in the plan.
  {
    const chromeVer = process.versions.chrome || '131.0.0.0';
    let platformUa;
    if (process.platform === 'win32') {
      platformUa = `Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${chromeVer} Safari/537.36`;
    } else if (process.platform === 'darwin') {
      platformUa = `Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${chromeVer} Safari/537.36`;
    } else {
      platformUa = `Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${chromeVer} Safari/537.36`;
    }
    view.webContents.session.setUserAgent(platformUa);
  }

  view.webContents.setWindowOpenHandler((details) => {
    const u = details.url;
    if (u.startsWith('https:') || u.startsWith('http:')) {
      setImmediate(() => {
        shell.openExternal(u).catch(() => {});
      });
    }
    return { action: 'deny' };
  });

  mainWindow.setBrowserView(view);
  view.webContents.loadURL(CHAT_URL);

  // Collapse auto-expanded “Thought for …” sections on the remote page (injected; see injections/).
  view.webContents.on('dom-ready', () => {
    injectCollapseThoughtScript(view.webContents);
  });
  view.webContents.on('did-finish-load', () => {
    injectCollapseThoughtScript(view.webContents);
    // Re-run after slow React/streaming paint (injection is idempotent; refreshes collapse pass).
    [2000, 5000, 10000].forEach((delay) => {
      setTimeout(() => {
        if (view && view.webContents && !view.webContents.isDestroyed()) {
          injectCollapseThoughtScript(view.webContents);
        }
      }, delay);
    });
  });
  view.webContents.on('did-navigate-in-page', () => {
    injectCollapseThoughtScript(view.webContents);
  });

  mainWindow.loadFile(path.join(__dirname, 'shell.html'));

  // External links: handled on chat view; shell has no setWindowOpenHandler.

  mainWindow.on('resize', () => {
    if (!mainWindow || mainWindow.isDestroyed()) {
      return;
    }
    layoutChatView();
    scheduleWriteWindowState();
  });
  mainWindow.on('move', () => {
    if (!mainWindow || mainWindow.isDestroyed()) {
      return;
    }
    scheduleWriteWindowState();
  });
  mainWindow.on('maximize', () => {
    if (!mainWindow || mainWindow.isDestroyed()) {
      return;
    }
    layoutChatView();
    scheduleWriteWindowState();
    broadcastMaximizeToShell();
  });
  mainWindow.on('unmaximize', () => {
    if (!mainWindow || mainWindow.isDestroyed()) {
      return;
    }
    layoutChatView();
    scheduleWriteWindowState();
    broadcastMaximizeToShell();
  });
  mainWindow.on('enter-full-screen', () => {
    layoutChatView();
  });
  mainWindow.on('leave-full-screen', () => {
    layoutChatView();
  });

  mainWindow.webContents.on('did-finish-load', () => {
    layoutChatView();
    broadcastNativeThemeToShell();
  });

  mainWindow.once('ready-to-show', () => {
    if (!mainWindow) {
      return;
    }
    if (s.isMaximized) {
      mainWindow.maximize();
    }
    layoutChatView();
    mainWindow.show();
  });

  mainWindow.on('close', (event) => {
    if (app.isQuiting) {
      return;
    }
    event.preventDefault();
    writeWindowState();
    mainWindow.hide();
  });

  mainWindow.on('closed', () => {
    // Window is already destroyed here; only clear references (do not call setBrowserView).
    mainWindow = null;
    chatView = null;
  });
}

// -----------------------------------------------------------------------------
// IPC: frameless title bar, app menu popup
// -----------------------------------------------------------------------------

function registerIpc() {
  ipcMain.handle('shell:window-control', (_e, action) => {
    if (!mainWindow || mainWindow.isDestroyed()) {
      return;
    }
    if (action === 'minimize') {
      mainWindow.minimize();
    } else if (action === 'maximize') {
      if (mainWindow.isMaximized()) {
        mainWindow.unmaximize();
      } else {
        mainWindow.maximize();
      }
      setImmediate(broadcastMaximizeToShell);
    } else if (action === 'close') {
      writeWindowState();
      mainWindow.hide();
    }
  });

  ipcMain.handle('shell:is-maximized', () => {
    if (!mainWindow || mainWindow.isDestroyed()) {
      return false;
    }
    return mainWindow.isMaximized();
  });

  /**
   * Shows the same app menu that used to be the native bar, at (x, y) in the window’s **client** coordinates.
   * Coordinates are relative to the top-left of the **window content** (the shell, including the in-app title bar).
   */
  ipcMain.handle('shell:show-app-menu', (event, x, y) => {
    if (!mainWindow || mainWindow.isDestroyed()) {
      return;
    }
    const menu = buildAppMenu();
    menu.popup({
      window: mainWindow,
      x: Math.max(0, Math.round(x)),
      y: Math.max(0, Math.round(y)),
    });
  });
}

if (gotTheLock) {
  registerIpc();

  app.on('second-instance', () => {
    if (!mainWindow) {
      return;
    }
    if (mainWindow.isMinimized()) {
      mainWindow.restore();
    }
    mainWindow.show();
    mainWindow.focus();
  });

  app.whenReady().then(() => {
    setMacAboutPanel();
    // Integrated UI: no separate OS menubar; user opens the same menu from the in-app hamburger.
    Menu.setApplicationMenu(null);

    nativeTheme.on('updated', () => {
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.setBackgroundColor(getBackgroundForTheme());
      }
      broadcastNativeThemeToShell();
    });
    createMainWindow();
    createTray();
  });

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') {
      app.quit();
    }
  });

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createMainWindow();
    } else if (mainWindow) {
      mainWindow.show();
    } else {
      createMainWindow();
    }
  });

  app.on('before-quit', () => {
    app.isQuiting = true;
    writeWindowState();
    destroyTray();
  });
} else {
  app.quit();
}
