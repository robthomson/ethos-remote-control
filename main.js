import { app, BrowserWindow, Menu, session, shell } from 'electron';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const dirname = path.dirname(fileURLToPath(import.meta.url));
const ETHOS_VID = 0x0483;
const ETHOS_PID = 0x5750;
const isEthos = (d) => Number(d.vendorId) === ETHOS_VID && Number(d.productId) === ETHOS_PID;

function setupDeviceAccess() {
  const ses = session.defaultSession;

  // The page asks for the radio with navigator.serial / navigator.hid; pick it without a chooser dialog
  ses.on('select-serial-port', (event, portList, _webContents, callback) => {
    event.preventDefault();
    callback(portList.find(isEthos)?.portId ?? '');
  });
  ses.on('select-hid-device', (event, details, callback) => {
    event.preventDefault();
    callback(details.deviceList.find(isEthos)?.deviceId);
  });

  // Only the app's own page is loaded, so it may use the serial port and HID interface chosen above.
  // The device passed here has no USB ids for serial ports (only a name and instance id), so it is
  // not filtered again: the choosers above only ever pick the radio.
  const isAppPage = (origin) => !origin || origin.startsWith('file://');
  ses.setPermissionCheckHandler((_wc, permission, origin) =>
    (permission === 'serial' || permission === 'hid') && isAppPage(origin));
  ses.setDevicePermissionHandler((details) =>
    (details.deviceType === 'serial' || details.deviceType === 'hid') && isAppPage(details.origin));
}

function createWindow() {
  const win = new BrowserWindow({
    width: 1320,
    height: 860,
    minWidth: 900,
    minHeight: 600,
    title: 'Ethos Remote Control',
    backgroundColor: '#14161b',
    webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true },
  });
  win.loadFile(path.join(dirname, 'src', 'index.html'));

  // ETHOS_DEBUG=1 prints the page's console to the terminal
  if (process.env.ETHOS_DEBUG) {
    win.webContents.on('console-message', ({ level, message, lineNumber, sourceId }) => {
      console.log(`[renderer:${level}] ${message} (${sourceId}:${lineNumber})`);
    });
  }

  // Links open in the system browser, never inside the app
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
  win.webContents.on('will-navigate', (event) => event.preventDefault());
}

const isMac = process.platform === 'darwin';
Menu.setApplicationMenu(Menu.buildFromTemplate([
  ...(isMac ? [{ role: 'appMenu' }] : []),
  { role: 'fileMenu' },
  { role: 'editMenu' },
  { role: 'viewMenu' },
  { role: 'windowMenu' },
]));

app.whenReady().then(() => {
  setupDeviceAccess();
  createWindow();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (!isMac) app.quit();
});
