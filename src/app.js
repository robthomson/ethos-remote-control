import { LONG_TOUCH_MS, RadioClient, STATUS, statusText } from './protocol.js';
import { SerialTransport, findPort, switchUsbMode, waitForPort } from './usb.js';

const $ = (id) => document.getElementById(id);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const ui = {
  connectBtn: $('connectBtn'),
  serialModeBtn: $('serialModeBtn'),
  statusPill: $('statusPill'),
  radioInfo: $('radioInfo'),
  canvas: $('screen'),
  screenWrap: $('screenWrap'),
  overlay: $('overlay'),
  overlayTitle: $('overlayTitle'),
  overlayText: $('overlayText'),
  overlayActions: $('overlayActions'),
  displaySelect: $('displaySelect'),
  liveToggle: $('liveToggle'),
  fps: $('fps'),
  saveShotBtn: $('saveShotBtn'),
  copyShotBtn: $('copyShotBtn'),
  trims: $('trims'),
  fswitches: $('fswitches'),
  log: $('log'),
  fileList: $('fileList'),
  filesPath: $('filesPath'),
  filesProgress: $('filesProgress'),
  channels: $('channels'),
  invertWheel: $('invertWheel'),
  radioState: $('radioState'),
  switches: $('switches'),
  driveSelect: $('driveSelect'),
};
const ctx = ui.canvas.getContext('2d');

let transport = null;
let client = null;
let connectAbort = null;
let loopToken = 0;
let activeTab = 'controls';
let hasFrame = false;

// ---------- Settings ----------

const settings = (() => {
  try { return JSON.parse(localStorage.getItem('settings')) ?? {}; } catch { return {}; }
})();
const saveSettings = () => { try { localStorage.setItem('settings', JSON.stringify(settings)); } catch { /* ignore */ } };
ui.invertWheel.checked = !!settings.invertWheel;
ui.invertWheel.addEventListener('change', () => { settings.invertWheel = ui.invertWheel.checked; saveSettings(); });

// ---------- Messages ----------

function toast(text, kind = '') {
  const el = document.createElement('div');
  el.className = `toast ${kind}`;
  el.textContent = text;
  $('toasts').append(el);
  setTimeout(() => el.remove(), kind === 'err' ? 6000 : 3500);
}

function log(text, kind = '') {
  const line = document.createElement('span');
  if (kind) line.className = kind;
  const time = new Date().toLocaleTimeString([], { hour12: false });
  line.textContent = `${time} ${text.replace(/\x1b\[[0-9;]*[A-Za-z]/g, '').replace(/[\r\n]+$/, '')}\n`;
  const atBottom = ui.log.scrollTop + ui.log.clientHeight >= ui.log.scrollHeight - 4;
  ui.log.append(line);
  while (ui.log.childNodes.length > 2000) ui.log.firstChild.remove();
  if (atBottom) ui.log.scrollTop = ui.log.scrollHeight;
}
$('logClearBtn').addEventListener('click', () => { ui.log.textContent = ''; });

function showOverlay(title, html, actions = [], spinner = false) {
  ui.overlayTitle.innerHTML = (spinner ? '<div class="spinner"></div>' : '') + title;
  ui.overlayText.innerHTML = html;
  ui.overlayActions.replaceChildren(...actions.map(({ label, onClick, primary }) => {
    const button = document.createElement('button');
    button.textContent = label;
    if (primary) button.className = 'primary';
    button.addEventListener('click', onClick);
    return button;
  }));
  ui.overlay.hidden = false;
}
const hideOverlay = () => { ui.overlay.hidden = true; };

function showDisconnectedOverlay() {
  showOverlay('Connect your radio',
    'Plug the radio in by USB with its USB mode set to <b>Serial</b>, then press <b>Connect</b>.<br><br>' +
    'Remote control needs Ethos 26 (nightly from 2026-10-16 or later); a current nightly adds live switches, ' +
    'function switch states, new folders and Lua reload.',
    [{ label: 'Connect', onClick: connect, primary: true }]);
}

function showNoRadioOverlay() {
  showOverlay('No radio found in Serial mode',
    'Plug the radio in and choose <b>USB Serial (debug)</b> on its screen, ' +
    'or switch a connected radio to Serial mode from here.',
    [
      { label: 'Switch USB to Serial', onClick: () => changeUsbMode('serial'), primary: true },
      { label: 'Try again', onClick: connect },
    ]);
}

// ---------- Connection ----------

function setState(state) {
  const labels = { disconnected: 'Disconnected', connecting: 'Connecting…', waiting: 'Waiting for radio', connected: 'Connected' };
  ui.statusPill.dataset.state = state;
  ui.statusPill.textContent = labels[state];
  ui.connectBtn.textContent = state === 'disconnected' ? 'Connect' : 'Disconnect';
  ui.connectBtn.classList.toggle('primary', state === 'disconnected');
  ui.serialModeBtn.hidden = state !== 'disconnected';
  const connected = state === 'connected';
  document.querySelectorAll('[data-needs-radio]').forEach((el) => { el.disabled = !connected; });
  ui.saveShotBtn.disabled = ui.copyShotBtn.disabled = !hasFrame;
  if (state === 'disconnected') {
    ui.radioInfo.textContent = 'No radio connected';
    ui.radioState.textContent = '';
    ui.driveSelect.hidden = true;
  }
}

const isConnected = () => ui.statusPill.dataset.state === 'connected';

async function connect() {
  if (client || connectAbort) return disconnect();
  setState('connecting');
  const port = await findPort({ ask: true });
  if (!port) {
    setState('disconnected');
    showNoRadioOverlay();
    return;
  }
  await openPort(port);
}

async function openPort(port) {
  connectAbort = new AbortController();
  setState('connecting');
  transport = new SerialTransport(port);
  try {
    await transport.open();
  } catch (error) {
    transport = null;
    connectAbort = null;
    setState('disconnected');
    showDisconnectedOverlay();
    toast(`Could not open the radio's serial port: ${error.message}. Is another program using it?`, 'err');
    return;
  }

  client = new RadioClient(transport);
  client.addEventListener('log', (e) => log(e.detail));
  client.addEventListener('state', (e) => renderState(e.detail));
  client.addEventListener('controls', (e) => renderControls(e.detail));
  client.addEventListener('hello', (e) => showRadioInfo(e.detail));
  transport.onClose = () => onClosed();

  showOverlay('Accept the connection on the radio',
    'The radio is asking whether to allow remote control. Confirm it on the radio screen.',
    [{ label: 'Cancel', onClick: () => disconnect() }], true);
  setState('waiting');

  try {
    const hello = await client.connect({ signal: connectAbort.signal });
    connectAbort = null;
    log(`Connected to ${hello.board} (Ethos ${hello.firmware}, protocol ${hello.protocol})`, 'app');
    setState('connected');
    hideOverlay();
    toast(`Connected to ${hello.board}`, 'ok');
    startLoops();
  } catch (error) {
    const cancelled = connectAbort?.signal.aborted;
    connectAbort = null;
    if (!cancelled) {
      toast(error.message, 'err');
      log(error.message, 'err');
    }
    await disconnect();
  }
}

let lastState = '';
function renderState({ flightMode, rfActive, backlightOn }) {
  const text = `FM${flightMode}  ·  RF ${rfActive ? 'on' : 'off'}${backlightOn ? '' : '  ·  screen off'}`;
  ui.radioState.textContent = text;
  ui.radioState.classList.toggle('warn', rfActive);
  ui.radioState.title = rfActive ? 'The RF module is transmitting: a bound model reacts to what you do here' : '';
  if (text !== lastState) log(`Radio state: ${text.replace(/\s+·\s+/g, ', ')}`, 'app');
  lastState = text;
}

/** Controls pushed by the radio when they change (protocol version 11). */
function renderControls({ switches, trims, functionSwitches }) {
  renderTrims(trims);
  renderFunctionSwitches(functionSwitches);
  ui.switches.replaceChildren(...switches.map(({ name, position }) => {
    const chip = document.createElement('span');
    chip.className = 'switch';
    chip.dataset.position = position;
    chip.textContent = `${name} ${position < 0 ? '\u2191' : position > 0 ? '\u2193' : '\u2013'}`;
    chip.title = `${name}: ${position < 0 ? 'up' : position > 0 ? 'down' : 'middle'}`;
    return chip;
  }));
  $('switchesSection').hidden = !switches.length;
}

/** Tells the user when the radio's firmware is too old for a feature. */
function supports(version, what) {
  if (client && client.protocol >= version) return true;
  toast(`${what} needs a newer Ethos nightly (remote protocol ${version}, this radio has ${client?.protocol ?? '?'})`, 'err');
  return false;
}

function showRadioInfo(hello) {
  const parts = [hello.board, `Ethos ${hello.firmware}`];
  if (hello.region) parts.push(hello.region);
  if (hello.gitHash) parts.push(hello.gitHash.slice(0, 8));
  parts.push(`protocol ${hello.protocol}`);
  ui.radioInfo.textContent = parts.filter(Boolean).join('  ·  ');
}

async function disconnect() {
  connectAbort?.abort();
  loopToken++;
  const closing = transport;
  client?.abort();
  client = null;
  transport = null;
  await closing?.close();
  setState('disconnected');
  showDisconnectedOverlay();
}

function onClosed() {
  if (!client) return; // closed by disconnect()
  log('The radio disconnected', 'err');
  toast('The radio disconnected', 'err');
  connectAbort?.abort();
  connectAbort = null;
  loopToken++;
  client.abort();
  client = null;
  transport = null;
  setState('disconnected');
  showDisconnectedOverlay();
}

async function changeUsbMode(mode) {
  try {
    if (mode === 'storage' && client) await disconnect();
    await switchUsbMode(mode);
    log(`Asked the radio to switch USB to ${mode} mode`, 'app');
  } catch (error) {
    toast(`Could not switch the USB mode: ${error.message}`, 'err');
    return;
  }
  if (mode !== 'serial') {
    toast('The radio is switching to USB storage mode', 'ok');
    return;
  }
  setState('connecting');
  showOverlay('Switching to Serial mode', 'Waiting for the radio to come back on USB…', [], true);
  const port = await waitForPort();
  if (port) {
    await openPort(port);
  } else {
    setState('disconnected');
    showDisconnectedOverlay();
    toast('The radio switched modes. Press Connect when it is ready.');
  }
}

ui.connectBtn.addEventListener('click', connect);
ui.serialModeBtn.addEventListener('click', () => changeUsbMode('serial'));
$('usbSerialBtn2').addEventListener('click', () => changeUsbMode('serial'));
$('usbStorageBtn').addEventListener('click', () => {
  if (!client || confirm('Switch the radio to USB storage mode? Remote control will disconnect.')) changeUsbMode('storage');
});

// ---------- Polling loops ----------

function startLoops() {
  const token = ++loopToken;
  screenLoop(token);
  valuesLoop(token);
  loadDrives(token);
  if (activeTab === 'files') listFiles();
}

async function loadDrives(token) {
  const drives = await client.drives();
  if (token !== loopToken) return;
  ui.driveSelect.replaceChildren(...drives.map(({ name, path }) => new Option(name, path)));
  ui.driveSelect.hidden = drives.length < 2;
}

async function screenLoop(token) {
  let frames = 0;
  let since = performance.now();
  let failures = 0;
  while (token === loopToken && client) {
    if (!ui.liveToggle.checked || document.hidden) {
      ui.fps.textContent = ui.liveToggle.checked ? '' : 'Paused';
      await sleep(200);
      continue;
    }
    const display = Number(ui.displaySelect.value);
    const { status, image } = await client.screenshot(display);
    if (token !== loopToken) return;
    if (status) {
      failures++;
      ui.fps.textContent = `Screen: ${statusText(status)}`;
      if (status === STATUS.UNSUPPORTED && display !== 0) {
        toast('This radio has no such display', 'err');
        ui.displaySelect.value = '0';
      }
      await sleep(Math.min(2000, 250 * failures));
      continue;
    }
    failures = 0;
    drawFrame(image);
    frames++;
    const now = performance.now();
    if (now - since >= 1000) {
      ui.fps.textContent = `${(frames * 1000 / (now - since)).toFixed(1)} fps`;
      frames = 0;
      since = now;
    }
    await sleep(30);
  }
}

async function valuesLoop(token) {
  while (token === loopToken && client) {
    if (activeTab === 'controls' && client.controls) {
      // The radio sends the trims itself when they change (protocol version 11)
      await sleep(300);
    } else if (!document.hidden && activeTab === 'controls') {
      const { status, trims } = await client.trims();
      if (token !== loopToken) return;
      if (status === 0) renderTrims(trims);
      await sleep(700);
    } else if (!document.hidden && activeTab === 'channels') {
      const { status, channels } = await client.channelOutputs();
      if (token !== loopToken) return;
      if (status === 0) renderChannels(channels);
      else ui.channels.innerHTML = `<p class="muted">Channel outputs unavailable: ${statusText(status)}</p>`;
      await sleep(status === 0 ? 150 : 2000);
    } else {
      await sleep(300);
    }
  }
}

// ---------- Screen ----------

function drawFrame(image) {
  if (ui.canvas.width !== image.width || ui.canvas.height !== image.height) {
    ui.canvas.width = image.width;
    ui.canvas.height = image.height;
    fitCanvas();
  }
  ctx.putImageData(new ImageData(image.rgba, image.width, image.height), 0, 0);
  if (!hasFrame) {
    hasFrame = true;
    ui.saveShotBtn.disabled = ui.copyShotBtn.disabled = false;
  }
}

function fitCanvas() {
  const pad = 16;
  const width = ui.screenWrap.clientWidth - pad * 2;
  const height = ui.screenWrap.clientHeight - pad * 2;
  const scale = Math.max(0.1, Math.min(width / ui.canvas.width, height / ui.canvas.height));
  ui.canvas.style.width = `${Math.floor(ui.canvas.width * scale)}px`;
  ui.canvas.style.height = `${Math.floor(ui.canvas.height * scale)}px`;
  ui.canvas.classList.toggle('pixelated', scale >= 1.5);
}
new ResizeObserver(fitCanvas).observe(ui.screenWrap);

ctx.fillStyle = '#000';
ctx.fillRect(0, 0, ui.canvas.width, ui.canvas.height);

/** Pointer position in radio screen pixels. */
function radioPoint(event) {
  const rect = ui.canvas.getBoundingClientRect();
  const x = Math.round((event.clientX - rect.left) * ui.canvas.width / rect.width);
  const y = Math.round((event.clientY - rect.top) * ui.canvas.height / rect.height);
  return {
    x: Math.max(0, Math.min(ui.canvas.width - 1, x)),
    y: Math.max(0, Math.min(ui.canvas.height - 1, y)),
  };
}

function ripple(event, long = false) {
  const wrap = ui.screenWrap.getBoundingClientRect();
  const el = document.createElement('div');
  el.className = long ? 'ripple long' : 'ripple';
  el.style.left = `${event.clientX - wrap.left}px`;
  el.style.top = `${event.clientY - wrap.top}px`;
  ui.screenWrap.append(el);
  setTimeout(() => el.remove(), 500);
}

async function send(action) {
  if (!isConnected()) return;
  const status = await action(client);
  if (status === STATUS.WOKE_UP) toast('The radio screen was off: that input turned it back on');
  else if (status && status !== STATUS.SUCCESS) toast(`The radio answered: ${statusText(status)}`, 'err');
}

let pointerStart = null;
ui.canvas.addEventListener('pointerdown', (event) => {
  if (event.button !== 0 || !isConnected()) return;
  ui.canvas.setPointerCapture(event.pointerId);
  ui.canvas.focus();
  pointerStart = { ...radioPoint(event), time: performance.now() };
});
ui.canvas.addEventListener('pointerup', (event) => {
  if (!pointerStart || event.button !== 0) return;
  const start = pointerStart;
  pointerStart = null;
  const end = radioPoint(event);
  const distance = Math.hypot(end.x - start.x, end.y - start.y);
  if (distance > 12) {
    send((c) => c.swipe(start.x, start.y, end.x, end.y));
  } else {
    const long = performance.now() - start.time >= 500;
    ripple(event, long);
    send((c) => c.touch(start.x, start.y, long ? LONG_TOUCH_MS : 20));
  }
});
ui.canvas.addEventListener('pointercancel', () => { pointerStart = null; });
ui.canvas.addEventListener('contextmenu', (event) => {
  event.preventDefault();
  if (!isConnected()) return;
  const { x, y } = radioPoint(event);
  ripple(event, true);
  send((c) => c.touch(x, y, LONG_TOUCH_MS));
});

let wheelAccumulator = 0;
ui.canvas.addEventListener('wheel', (event) => {
  event.preventDefault();
  if (!isConnected()) return;
  // Mouse wheels give about 100 per notch; touchpads give small deltas that add up
  wheelAccumulator += event.deltaMode === 1 ? event.deltaY * 33 : event.deltaY;
  const steps = Math.trunc(wheelAccumulator / 100);
  if (!steps) return;
  wheelAccumulator -= steps * 100;
  turnWheel(steps);
}, { passive: false });

function turnWheel(steps) {
  send((c) => c.wheel(ui.invertWheel.checked ? -steps : steps));
}

async function screenshotBlob() {
  return new Promise((resolve) => ui.canvas.toBlob(resolve, 'image/png'));
}

ui.saveShotBtn.addEventListener('click', async () => {
  const stamp = new Date().toISOString().replace(/[-:]/g, '').replace('T', '-').slice(0, 15);
  download(await screenshotBlob(), `ethos-${stamp}.png`);
});
ui.copyShotBtn.addEventListener('click', async () => {
  try {
    await navigator.clipboard.write([new ClipboardItem({ 'image/png': await screenshotBlob() })]);
    toast('Screenshot copied', 'ok');
  } catch (error) {
    toast(`Could not copy: ${error.message}`, 'err');
  }
});

function download(blob, name) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 10000);
}

// ---------- Keys ----------

/** Sends a key on release, held for as long as the button or key was down. */
function holdDuration(start) {
  return Math.max(50, Math.min(5000, Math.round(performance.now() - start)));
}

function bindHoldButton(button, onRelease) {
  let start = null;
  button.addEventListener('pointerdown', (event) => {
    if (event.button !== 0) return;
    start = performance.now();
    button.setPointerCapture(event.pointerId);
    button.classList.add('held');
  });
  const release = (fire) => {
    if (start === null) return;
    const hold = holdDuration(start);
    start = null;
    button.classList.remove('held');
    if (fire) onRelease(hold);
  };
  button.addEventListener('pointerup', () => release(true));
  button.addEventListener('pointercancel', () => release(false));
}

document.querySelectorAll('#keypad [data-key]').forEach((button) => {
  button.dataset.needsRadio = '';
  bindHoldButton(button, (hold) => send((c) => c.pressKey(button.dataset.key, hold)));
});
document.querySelectorAll('#keypad [data-wheel]').forEach((button) => {
  button.dataset.needsRadio = '';
  button.addEventListener('click', () => turnWheel(Number(button.dataset.wheel)));
});

const KEYBOARD = {
  Enter: 'ENTER', NumpadEnter: 'ENTER', Escape: 'RTN', Backspace: 'RTN', Tab: 'PAGE', PageDown: 'PAGE',
  F1: 'SYS', F2: 'MDL', F3: 'DISP',
};
const ARROWS = { ArrowUp: ['UP', -1], ArrowDown: ['DOWN', 1], ArrowLeft: ['LEFT', -1], ArrowRight: ['RIGHT', 1] };
const keysDown = new Map();

const typingInField = (event) => event.target.closest?.('input, select, textarea');

window.addEventListener('keydown', (event) => {
  if (typingInField(event) || !isConnected()) return;
  const arrow = ARROWS[event.code];
  if (arrow && !event.shiftKey) {
    event.preventDefault();
    turnWheel(arrow[1]);
    return;
  }
  if (event.key === '+' || event.key === '=') { turnWheel(1); return; }
  if (event.key === '-') { turnWheel(-1); return; }
  const key = (arrow && arrow[0]) || KEYBOARD[event.code];
  if (!key) return;
  event.preventDefault();
  if (!event.repeat && !keysDown.has(event.code)) keysDown.set(event.code, { key, start: performance.now() });
});

window.addEventListener('keyup', (event) => {
  const down = keysDown.get(event.code);
  if (!down) return;
  keysDown.delete(event.code);
  event.preventDefault();
  send((c) => c.pressKey(down.key, holdDuration(down.start)));
});
window.addEventListener('blur', () => keysDown.clear());

// ---------- Controls panel ----------

let trimCount = 0;
function renderTrims(values) {
  if (values.length !== trimCount) {
    trimCount = values.length;
    ui.trims.replaceChildren(...values.map((_, i) => {
      const row = document.createElement('div');
      row.className = 'trim';
      row.innerHTML = `<span class="label">T${i + 1}</span><button data-needs-radio>&minus;</button>` +
        '<div class="bar"><div></div></div><button data-needs-radio>+</button><span class="value"></span>';
      const [minus, plus] = row.querySelectorAll('button');
      bindHoldButton(minus, (hold) => send((c) => c.pressKey(`T${i + 1}-`, hold)));
      bindHoldButton(plus, (hold) => send((c) => c.pressKey(`T${i + 1}+`, hold)));
      return row;
    }));
  }
  values.forEach((value, i) => {
    const row = ui.trims.children[i];
    const clamped = Math.max(-100, Math.min(100, value));
    const bar = row.querySelector('.bar > div');
    bar.style.left = `${50 + Math.min(0, clamped) / 2}%`;
    bar.style.width = `${Math.abs(clamped) / 2}%`;
    row.querySelector('.value').textContent = `${value > 0 ? '+' : ''}${value}`;
  });
}
ui.trims.innerHTML = '<p class="muted">Shown once a radio is connected.</p>';

/** One button per function switch, lit when the radio reports it on. */
function renderFunctionSwitches(states) {
  if (ui.fswitches.children.length !== states.length) {
    ui.fswitches.replaceChildren(...states.map((_, index) => {
      const button = document.createElement('button');
      button.textContent = `FS${index + 1}`;
      button.dataset.needsRadio = '';
      button.disabled = !isConnected();
      bindHoldButton(button, (hold) => send((c) => c.pressFunctionSwitch(index + 1, hold)));
      return button;
    }));
  }
  states.forEach((on, i) => ui.fswitches.children[i].classList.toggle('on', on));
}
renderFunctionSwitches(new Array(6).fill(false));

$('fsResetBtn').addEventListener('click', () => {
  if (supports(11, 'Resetting the function switches')) send((c) => c.resetFunctionSwitches());
});
$('wakeBtn').addEventListener('click', () => send((c) => c.resetBacklightTimer()));
$('reloadBtn').addEventListener('click', async () => {
  if (!isConnected() || !supports(7, 'Reloading the Lua scripts')) return;
  const status = await client.reload('scripts');
  if (status) toast(`Could not reload the Lua scripts: ${statusText(status)}`, 'err');
  else toast('Lua scripts reloaded', 'ok');
});

$('textForm').addEventListener('submit', (event) => {
  event.preventDefault();
  const input = $('textInput');
  if (!input.value) return;
  const text = input.value;
  send((c) => c.enterText(text)).then(() => { input.value = ''; });
});
$('textForm').querySelector('button').dataset.needsRadio = '';

// ---------- Channels panel ----------

let channelCount = 0;
function renderChannels(values) {
  if (values.length !== channelCount) {
    channelCount = values.length;
    ui.channels.replaceChildren(...values.map((_, i) => {
      const row = document.createElement('div');
      row.className = 'channel';
      row.innerHTML = `<span class="muted">CH${i + 1}</span><div class="bar"><div></div></div><span class="value"></span>`;
      return row;
    }));
  }
  values.forEach((value, i) => {
    const row = ui.channels.children[i];
    const percent = Math.max(-150, Math.min(150, value / 10.24));
    const bar = row.querySelector('.bar > div');
    bar.style.left = `${50 + Math.min(0, percent) / 3}%`;
    bar.style.width = `${Math.abs(percent) / 3}%`;
    row.querySelector('.value').textContent = `${percent.toFixed(1)}%`;
  });
}
ui.channels.innerHTML = '<p class="muted">Shown once a radio is connected.</p>';

// ---------- Files panel ----------

let cwd = '/';
let currentFiles = [];
const joinPath = (dir, name) => (dir.endsWith('/') ? dir + name : `${dir}/${name}`);
const parentPath = (dir) => {
  const parent = dir.replace(/\/[^/]+\/?$/, '');
  return /^([A-Za-z]+:)?$/.test(parent) ? `${parent}/` : parent;
};

const ICON_DIR = '<svg class="icon" viewBox="0 0 24 24"><path d="M3 6.5A1.5 1.5 0 0 1 4.5 5H9l2 2h8.5A1.5 1.5 0 0 1 21 8.5v9a1.5 1.5 0 0 1-1.5 1.5h-15A1.5 1.5 0 0 1 3 17.5z"/></svg>';
const ICON_FILE = '<svg class="icon" viewBox="0 0 24 24"><path d="M6 3h8l4 4v14H6z"/><path d="M14 3v4h4"/></svg>';

function formatSize(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

async function listFiles(path = cwd) {
  if (!isConnected()) {
    ui.fileList.innerHTML = '<li class="empty">Connect a radio to browse its files</li>';
    return;
  }
  const { status, files } = await client.listFiles(path);
  if (status) {
    toast(`Could not list ${path}: ${statusText(status)}`, 'err');
    return;
  }
  cwd = path;
  currentFiles = files;
  ui.filesPath.textContent = cwd;
  ui.filesPath.title = cwd;
  files.sort((a, b) => (b.dir - a.dir) || a.name.localeCompare(b.name, undefined, { numeric: true }));
  if ([...ui.driveSelect.options].some((o) => o.value === 'SD:/')) ui.driveSelect.value = /^SD:/i.test(cwd) ? 'SD:/' : '/';
  const rows = files.map(fileRow);
  ui.fileList.replaceChildren(...(rows.length ? rows : [Object.assign(document.createElement('li'), { className: 'empty', textContent: 'Empty folder' })]));
}

function fileRow(file) {
  const path = joinPath(cwd, file.name);
  const li = document.createElement('li');
  li.className = file.dir ? 'dir' : 'file';
  li.innerHTML = `${file.dir ? ICON_DIR : ICON_FILE}<span class="name"></span><span class="size"></span><span class="actions"></span>`;
  li.querySelector('.name').textContent = file.name;
  li.querySelector('.name').title = path;
  li.querySelector('.size').textContent = file.dir ? '' : formatSize(file.size);
  const actions = li.querySelector('.actions');
  const action = (label, onClick, className = '') => {
    const button = document.createElement('button');
    button.className = `ghost ${className}`;
    button.textContent = label;
    button.addEventListener('click', (event) => { event.stopPropagation(); onClick(); });
    actions.append(button);
  };
  if (file.dir) {
    li.addEventListener('click', () => listFiles(path));
    action('Delete', () => deleteFile(path, true), 'danger');
  } else {
    if (/^\/models\/.+\.bin$/i.test(path)) action('Load', () => loadModel(path));
    action('Download', () => downloadFile(path, file.name));
    action('Delete', () => deleteFile(path), 'danger');
  }
  return li;
}

async function downloadFile(path, name) {
  if (!isConnected()) return;
  toast(`Downloading ${name}…`);
  const { status, data } = await client.readFile(path);
  if (status) {
    toast(`Could not read ${path}: ${statusText(status)}`, 'err');
    return;
  }
  download(new Blob([data]), name);
}

async function deleteFile(path, isFolder = false) {
  if (!isConnected() || !confirm(`Delete ${isFolder ? 'the folder ' : ''}${path} from the radio?`)) return;
  const status = await client.deleteFile(path);
  if (status) toast(`Could not delete ${path}: ${statusText(status)}${isFolder ? ' (only an empty folder can be deleted)' : ''}`, 'err');
  else toast(`Deleted ${path}`, 'ok');
  listFiles();
}

async function loadModel(path) {
  if (!isConnected()) return;
  const status = await client.loadModel(path);
  if (status) toast(`Could not load ${path}: ${statusText(status)}`, 'err');
  else toast(`Loaded model ${path}`, 'ok');
}

async function uploadFiles(fileList) {
  if (!isConnected()) return;
  const bar = ui.filesProgress.firstElementChild;
  for (const file of fileList) {
    const path = joinPath(cwd, file.name);
    const existing = currentFiles.find((f) => f.name === file.name);
    if (existing) {
      if (existing.dir || !confirm(`${path} already exists on the radio. Replace it?`)) continue;
      await client.deleteFile(path);
    }
    ui.filesProgress.hidden = false;
    bar.style.width = '0';
    const data = new Uint8Array(await file.arrayBuffer());
    const status = await client.writeFile(path, data, (done, total) => {
      bar.style.width = `${(done / total) * 100}%`;
    });
    if (status) toast(`Could not write ${path}: ${statusText(status)}`, 'err');
    else toast(`Uploaded ${path}`, 'ok');
  }
  ui.filesProgress.hidden = true;
  listFiles();
}

async function createFolder(name) {
  if (!isConnected() || !supports(10, 'Creating a folder')) return;
  const path = joinPath(cwd, name);
  const status = await client.createDirectory(path);
  if (status) toast(`Could not create ${path}: ${statusText(status)}`, 'err');
  else toast(`Created ${path}`, 'ok');
  listFiles();
}

// window.prompt() does not exist in Electron: the name is typed in a small form
const folderForm = $('newFolderForm');
$('filesNewFolderBtn').addEventListener('click', () => {
  folderForm.hidden = !folderForm.hidden;
  if (!folderForm.hidden) $('newFolderName').focus();
});
folderForm.addEventListener('submit', (event) => {
  event.preventDefault();
  const name = $('newFolderName').value.trim();
  if (!name || /[\\/:*?"<>|]/.test(name)) {
    toast('Give the folder a name without \\ / : * ? " < > |', 'err');
    return;
  }
  $('newFolderName').value = '';
  folderForm.hidden = true;
  createFolder(name);
});
ui.driveSelect.addEventListener('change', () => listFiles(ui.driveSelect.value));

$('filesUpBtn').addEventListener('click', () => listFiles(parentPath(cwd)));
$('filesRefreshBtn').addEventListener('click', () => listFiles());
$('filesUploadBtn').addEventListener('click', () => $('filesUploadInput').click());
$('filesUploadInput').addEventListener('change', (event) => {
  uploadFiles([...event.target.files]);
  event.target.value = '';
});
['filesUpBtn', 'filesRefreshBtn', 'filesUploadBtn', 'filesNewFolderBtn', 'reloadBtn', 'fsResetBtn', 'wakeBtn'].forEach((id) => { $(id).dataset.needsRadio = ''; });
ui.fileList.innerHTML = '<li class="empty">Connect a radio to browse its files</li>';

// Dropping files on the file list uploads them
ui.fileList.addEventListener('dragover', (event) => { if (isConnected()) event.preventDefault(); });
ui.fileList.addEventListener('drop', (event) => {
  event.preventDefault();
  if (event.dataTransfer.files.length) uploadFiles([...event.dataTransfer.files]);
});

// ---------- Tabs ----------

document.querySelectorAll('.tabs [data-tab]').forEach((tab) => {
  tab.addEventListener('click', () => {
    activeTab = tab.dataset.tab;
    document.querySelectorAll('.tabs [data-tab]').forEach((t) => t.classList.toggle('active', t === tab));
    document.querySelectorAll('.panel').forEach((p) => p.classList.toggle('active', p.dataset.panel === activeTab));
    if (activeTab === 'files' && isConnected()) listFiles();
  });
});

// ---------- Start ----------

navigator.serial.addEventListener('disconnect', (event) => {
  if (transport && event.target === transport.port) onClosed();
});

setState('disconnected');
showDisconnectedOverlay();
log('Ready. Connect a radio in USB Serial mode.', 'app');
