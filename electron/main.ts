// Electron main process: window, menu, app:// protocol, IPC handlers, and all security settings.
import { app, BrowserWindow, clipboard, dialog, ipcMain, Menu, net, protocol, session, shell } from 'electron';
import type { MenuItemConstructorOptions } from 'electron';
import { readFile, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { isAllowedExternalUrl } from './allowlist';
import { resolveAppPath } from './appPath';
import { copyTextRequestSchema, openFileRequestSchema, openExternalRequestSchema, saveFileRequestSchema, windowStateSchema } from '../src/shared/schemas';
import { IPC, MAX_OPEN_FILE_BYTES } from '../src/shared/types';
import type { AppInfo, CopyTextResult, MenuAction, OpenExternalResult, OpenFileKind, OpenFileResult, SaveFileResult } from '../src/shared/types';

const here = path.dirname(fileURLToPath(import.meta.url));
const rendererRoot = path.resolve(here, '../renderer');
const examplesRoot = app.isPackaged ? path.join(process.resourcesPath, 'examples') : path.resolve(here, '../../examples');
const devServerUrl = process.env['ELECTRON_RENDERER_URL']; // set by electron-vite dev only
// Test mode (set only by the e2e suite): the window is never shown and the dock icon is hidden, so test runs
// don't steal focus from whatever the developer is working on. Playwright can still drive a hidden window.
const E2E_HIDDEN = process.env['SEQUENCESCOPE_E2E'] === '1';
const REPO_URL = 'https://github.com/reeper316099/SequenceScope';

// Strict production CSP. Note: no 'unsafe-inline' anywhere, no network sources, workers only from our own origin.
const CSP_PROD =
  "default-src 'self'; script-src 'self'; worker-src 'self'; style-src 'self'; img-src 'self' data:; " +
  "font-src 'self'; connect-src 'self'; object-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'";
// Dev-only relaxation so Vite's hot-reload client (inline styles + websocket) works. Never used when packaged.
const CSP_DEV = CSP_PROD.replace("style-src 'self'", "style-src 'self' 'unsafe-inline'").replace(
  "connect-src 'self'",
  "connect-src 'self' ws://localhost:* http://localhost:*",
);

protocol.registerSchemesAsPrivileged([
  { scheme: 'app', privileges: { standard: true, secure: true, supportFetchAPI: true } },
]);

/** Gets the single main window's webContents safely (undefined if closed). */
function mainContents(): Electron.WebContents | undefined {
  return BrowserWindow.getAllWindows()[0]?.webContents;
}

/** Asks the page to run a menu command; the action string comes from a fixed list, never from user data. */
function sendMenuAction(action: MenuAction): void {
  void mainContents()?.executeJavaScript(`window.dispatchEvent(new CustomEvent('menu-action',{detail:${JSON.stringify(action)}}))`);
}

/** Builds the application menu (File / Edit / View / Help) with the keyboard shortcuts from the brief. */
function buildMenu(): void {
  const act = (action: MenuAction) => () => sendMenuAction(action);
  const views = ['Align', 'Distances', 'Trees', 'MSA', 'Examples', 'Learn', 'About'];
  const template: MenuItemConstructorOptions[] = [
    ...(process.platform === 'darwin' ? [{ role: 'appMenu' } as MenuItemConstructorOptions] : []),
    {
      label: 'File',
      submenu: [
        { label: 'Open FASTA…', accelerator: 'CmdOrCtrl+O', click: act('open-fasta') },
        { label: 'Open Newick…', click: act('open-newick') },
        { label: 'Open Project…', click: act('open-project') },
        { label: 'Save Project…', accelerator: 'CmdOrCtrl+S', click: act('save-project') },
        { label: 'Export…', accelerator: 'CmdOrCtrl+E', click: act('export') },
        { type: 'separator' },
        { role: 'quit' },
      ],
    },
    {
      label: 'Edit',
      submenu: [
        { label: 'Undo', accelerator: 'CmdOrCtrl+Z', click: act('undo') },
        { label: 'Redo', accelerator: 'CmdOrCtrl+Shift+Z', click: act('redo') },
        { type: 'separator' },
        { role: 'cut' }, { role: 'copy' }, { role: 'paste' }, { role: 'selectAll' },
      ],
    },
    {
      label: 'View',
      submenu: [
        ...views.map((v, i): MenuItemConstructorOptions => ({ label: v, accelerator: `CmdOrCtrl+${i + 1}`, click: act(`view-${i + 1}` as MenuAction) })),
        { type: 'separator' },
        { label: 'Toggle Dark Mode', accelerator: 'CmdOrCtrl+D', click: act('toggle-dark') },
        { role: 'reload' }, { type: 'separator' },
        { role: 'zoomIn' }, { role: 'zoomOut' }, { role: 'resetZoom' }, { role: 'togglefullscreen' },
      ],
    },
    {
      label: 'Help',
      submenu: [
        { label: 'About SequenceScope', click: act('view-7') },
        { label: 'GitHub Repository', click: () => void shell.openExternal(REPO_URL) },
        { label: 'Report an Issue', click: () => void shell.openExternal(`${REPO_URL}/issues`) },
        { label: 'Data Sources', click: () => void shell.openExternal(`${REPO_URL}/blob/main/DATA-SOURCES.md`) },
      ],
    },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

const FILE_FILTERS: Record<OpenFileKind, Electron.FileFilter[]> = {
  fasta: [{ name: 'FASTA', extensions: ['fasta', 'fa', 'faa', 'fna', 'fas', 'txt'] }],
  newick: [{ name: 'Newick', extensions: ['nwk', 'newick', 'tree', 'tre', 'txt'] }],
  project: [{ name: 'SequenceScope project', extensions: ['json', 'sscope'] }],
};

/** Native open dialog + size/type enforcement; returns text for the renderer to validate. */
async function handleOpenFile(rawKind: unknown): Promise<OpenFileResult> {
  const parsed = openFileRequestSchema.safeParse(rawKind);
  if (!parsed.success) return { ok: false, reason: 'invalid-request', message: 'Unknown file kind.' };
  const win = BrowserWindow.getAllWindows()[0];
  const options: Electron.OpenDialogOptions = { properties: ['openFile'], filters: FILE_FILTERS[parsed.data] };
  const picked = win ? await dialog.showOpenDialog(win, options) : await dialog.showOpenDialog(options);
  const file = picked.filePaths[0];
  if (picked.canceled || file === undefined) return { ok: false, reason: 'cancelled' };
  try {
    const info = await stat(file);
    if (info.size > MAX_OPEN_FILE_BYTES) {
      return { ok: false, reason: 'too-large', message: `File is ${(info.size / 1048576).toFixed(1)} MB; the limit is ${MAX_OPEN_FILE_BYTES / 1048576} MB.` };
    }
    const buf = await readFile(file);
    return { ok: true, name: path.basename(file), text: new TextDecoder('utf-8').decode(buf) };
  } catch (e) {
    return { ok: false, reason: 'read-error', message: e instanceof Error ? e.message : 'Could not read file.' };
  }
}

/** Native save dialog; content is validated and written only to the path the user chose. */
async function handleSaveFile(raw: unknown): Promise<SaveFileResult> {
  const parsed = saveFileRequestSchema.safeParse(raw);
  if (!parsed.success) return { ok: false, reason: 'invalid-request', message: 'Invalid save request.' };
  const req = parsed.data;
  const win = BrowserWindow.getAllWindows()[0];
  const options: Electron.SaveDialogOptions = { defaultPath: req.suggestedName, filters: [{ name: 'File', extensions: req.extensions }] };
  const picked = win ? await dialog.showSaveDialog(win, options) : await dialog.showSaveDialog(options);
  if (picked.canceled || picked.filePath === '') return { ok: false, reason: 'cancelled' };
  try {
    await writeFile(picked.filePath, req.encoding === 'base64' ? Buffer.from(req.content, 'base64') : req.content, req.encoding === 'base64' ? undefined : 'utf8');
    return { ok: true, path: picked.filePath };
  } catch (e) {
    return { ok: false, reason: 'write-error', message: e instanceof Error ? e.message : 'Could not write file.' };
  }
}

/** Opens a link in the system browser only if it is an allowlisted https URL. */
async function handleOpenExternal(raw: unknown): Promise<OpenExternalResult> {
  const parsed = openExternalRequestSchema.safeParse(raw);
  if (!parsed.success || !isAllowedExternalUrl(parsed.data)) return { ok: false, message: 'That link is not on the allowlist.' };
  await shell.openExternal(parsed.data);
  return { ok: true };
}

/** Copies validated text to the system clipboard (the renderer has no clipboard permission of its own). */
async function handleCopyText(raw: unknown): Promise<CopyTextResult> {
  const parsed = copyTextRequestSchema.safeParse(raw);
  if (!parsed.success) return { ok: false, message: 'Nothing to copy, or the text is larger than 5 MB.' };
  await clipboard.writeText(parsed.data);
  return { ok: true };
}

/** Reads the saved window size/position (validated), falling back to defaults. */
async function loadWindowState(file: string): Promise<{ width: number; height: number; x?: number; y?: number; maximized?: boolean }> {
  try {
    const parsed = windowStateSchema.safeParse(JSON.parse(await readFile(file, 'utf8')));
    if (parsed.success) return parsed.data;
  } catch {
    /* first run or unreadable file: use defaults */
  }
  return { width: 1280, height: 800 };
}

/** Creates the one window with the locked-down web preferences from the security rules. */
async function createWindow(): Promise<void> {
  const stateFile = path.join(app.getPath('userData'), 'window-state.json');
  const state = await loadWindowState(stateFile);
  const win = new BrowserWindow({
    ...state, minWidth: 1100, minHeight: 720, show: false, title: 'SequenceScope',
    webPreferences: {
      preload: path.join(here, '../preload/index.cjs'),
      contextIsolation: true, nodeIntegration: false, sandbox: true, webSecurity: true,
      allowRunningInsecureContent: false, spellcheck: false,
    },
  });
  if (state.maximized === true) win.maximize();
  if (!E2E_HIDDEN) win.once('ready-to-show', () => win.show());
  const save = (): void => {
    const b = win.getNormalBounds();
    void writeFile(stateFile, JSON.stringify({ ...b, maximized: win.isMaximized() }));
  };
  win.on('close', save);

  // Block new windows (allowlisted https links go to the system browser) and any navigation away from the app.
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (isAllowedExternalUrl(url)) void shell.openExternal(url);
    return { action: 'deny' };
  });
  win.webContents.on('will-navigate', (event, url) => {
    const isApp = url.startsWith('app://local/') || (devServerUrl !== undefined && url.startsWith(devServerUrl));
    if (!isApp) event.preventDefault();
  });
  win.webContents.on('will-attach-webview', (event) => event.preventDefault());

  await (devServerUrl !== undefined ? win.loadURL(devServerUrl) : win.loadURL('app://local/index.html'));
}

app.on('web-contents-created', (_e, contents) => {
  contents.on('will-attach-webview', (event) => event.preventDefault());
});

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => {
    const win = BrowserWindow.getAllWindows()[0];
    if (win) {
      if (win.isMinimized()) win.restore();
      win.focus();
    }
  });

  void app.whenReady().then(async () => {
    if (E2E_HIDDEN) app.dock?.hide();
    // Serve the renderer and examples through app://; traversal attempts get 403.
    protocol.handle('app', async (request) => {
      const file = resolveAppPath(new URL(request.url).pathname, rendererRoot, examplesRoot);
      if (file === null) return new Response('Forbidden', { status: 403 });
      let res: Response;
      try {
        res = await net.fetch(pathToFileURL(file).toString());
      } catch {
        return new Response('Not found', { status: 404 }); // missing file: answer cleanly instead of a network error
      }
      const headers = new Headers(res.headers);
      headers.set('Content-Security-Policy', CSP_PROD);
      headers.set('X-Content-Type-Options', 'nosniff');
      return new Response(res.body, { status: res.status, headers });
    });

    // Defense in depth: deny every permission request and cancel any request that is not local.
    session.defaultSession.setPermissionRequestHandler((_wc, _perm, callback) => callback(false));
    session.defaultSession.setPermissionCheckHandler(() => false);
    session.defaultSession.webRequest.onBeforeRequest((details, callback) => {
      const u = new URL(details.url);
      const local = u.protocol === 'app:' || u.protocol === 'devtools:' || u.protocol === 'file:' || u.protocol === 'data:' || u.protocol === 'blob:' ||
        (devServerUrl !== undefined && (u.hostname === 'localhost' || u.hostname === '127.0.0.1'));
      callback({ cancel: !local });
    });
    if (devServerUrl !== undefined) {
      session.defaultSession.webRequest.onHeadersReceived((details, callback) => {
        callback({ responseHeaders: { ...details.responseHeaders, 'Content-Security-Policy': [CSP_DEV] } });
      });
    }

    ipcMain.handle(IPC.openFile, (_e, kind: unknown) => handleOpenFile(kind));
    ipcMain.handle(IPC.saveFile, (_e, req: unknown) => handleSaveFile(req));
    ipcMain.handle(IPC.openExternal, (_e, url: unknown) => handleOpenExternal(url));
    ipcMain.handle(IPC.copyText, (_e, text: unknown) => handleCopyText(text));
    ipcMain.handle(IPC.getAppInfo, (): AppInfo => ({
      name: app.getName(), version: app.getVersion(), electron: process.versions.electron,
      chrome: process.versions.chrome, platform: process.platform,
    }));

    buildMenu();
    await createWindow();
  });

  app.on('window-all-closed', () => app.quit());
}
