// Ethos remote control protocol (protocol versions 6 to 11), as spoken by the radio's USB serial port.
// Reference: ethos-tools/simulation/radio_remote.md and radio_remote.py.

import { decodeTiles } from './qoi.js';

export const SYNC = 0xE7;
export const MAX_PAYLOAD = 1024;
// 7: reload, 9: function switches pressed with PRESS and TOUCH takes a duration, 10: createDirectory,
// 11: version suffix in HELLO, EVENT.CONTROLS, resetFunctionSwitches. The radio answers HELLO with its own version.
export const PROTOCOL_VERSION = 11;

export const CMD = {
  HELLO: 0x01,
  PRESS: 0x10,
  PRESS_KEY: 0x10, // its name before version 9
  TOUCH: 0x11,
  SWIPE: 0x12,
  TURN_ROTARY_ENCODER: 0x13,
  ENTER_TEXT: 0x14,
  RESET_BACKLIGHT_TIMER: 0x15,
  PRESS_FUNCTION_SWITCH: 0x16,
  RESET_INACTIVITY_TIMER: 0x1B,
  SCREENSHOT: 0x20,
  LIST_FILES: 0x30,
  READ_FILE: 0x31,
  WRITE_FILE: 0x32,
  DELETE_FILE: 0x33,
  CREATE_DIRECTORY: 0x34,
  LOAD_MODEL: 0x40,
  RELOAD: 0x41,
  CHANNELS_OUTPUTS: 0x50,
  TRIMS: 0x51,
  RESET_FUNCTION_SWITCHES: 0x53,
};

export const EVENT = { STATE: 0xC1, CONNECTION: 0xC2, LOG: 0xC3, CONTROLS: 0xC4 };

export const STATUS = {
  SUCCESS: 0, UNSUPPORTED: -1, REFUSED: -2, INVALID: -3, IO_ERROR: -4, BUSY: -5, TIMEOUT: -6,
  WOKE_UP: -7, // the screen was off: the input only turned it back on
};

const STATUS_TEXT = {
  0: 'success', [-1]: 'unsupported', [-2]: 'refused', [-3]: 'invalid argument',
  [-4]: 'I/O error', [-5]: 'busy', [-6]: 'timeout', [-7]: 'woke up',
};

export const statusText = (status) => STATUS_TEXT[status] ?? `status ${status}`;

export const KEYS = ['SYS', 'MDL', 'DISP', 'PAGE', 'RTN', 'ENTER', 'UP', 'DOWN', 'LEFT', 'RIGHT'];
export const DISPLAYS = { main: 0, top: 1, glasses: 2 };
export const RELOAD = { scripts: 0x01, all: 0xFF };
export const LONG_TOUCH_MS = 1000; // from this duration a touch is a long press
const SWITCH_NOT_INSTALLED = -128;

/** CRC-16/XMODEM: polynomial 0x1021, initial value 0. */
export function crc16(bytes) {
  let crc = 0;
  for (const b of bytes) {
    crc ^= b << 8;
    for (let i = 0; i < 8; i++) crc = crc & 0x8000 ? ((crc << 1) ^ 0x1021) & 0xFFFF : (crc << 1) & 0xFFFF;
  }
  return crc;
}

export function buildFrame(command, seq, payload = new Uint8Array()) {
  if (payload.length > MAX_PAYLOAD) throw new Error(`Payload too large (${payload.length} bytes)`);
  const frame = new Uint8Array(payload.length + 7);
  frame[0] = SYNC;
  frame[1] = command;
  frame[2] = seq;
  frame[3] = payload.length & 0xFF;
  frame[4] = payload.length >> 8;
  frame.set(payload, 5);
  const crc = crc16(frame.subarray(1, 5 + payload.length));
  frame[5 + payload.length] = crc & 0xFF;
  frame[6 + payload.length] = crc >> 8;
  return frame;
}

/** Splits a byte stream into frames; bad CRCs and oversized lengths are skipped. */
export class FrameParser {
  constructor(onFrame) {
    this.onFrame = onFrame;
    this.state = 'sync';
    this.frame = new Uint8Array(MAX_PAYLOAD + 6);
    this.pos = 0;
    this.length = 0;
  }

  push(chunk) {
    for (const byte of chunk) {
      if (this.state === 'sync') {
        if (byte === SYNC) { this.pos = 0; this.state = 'header'; }
        continue;
      }
      this.frame[this.pos++] = byte;
      if (this.state === 'header') {
        if (this.pos === 4) {
          this.length = this.frame[2] | (this.frame[3] << 8);
          this.state = this.length > MAX_PAYLOAD ? 'sync' : 'body';
        }
      } else if (this.pos === 6 + this.length) {
        this.state = 'sync';
        const end = 4 + this.length;
        const crc = this.frame[end] | (this.frame[end + 1] << 8);
        if (crc === crc16(this.frame.subarray(0, end))) {
          this.onFrame(this.frame[0], this.frame[1], this.frame.slice(4, end));
        }
      }
    }
  }
}

// ---------- Payload helpers ----------

const encoder = new TextEncoder();
const decoder = new TextDecoder();

export function concat(...parts) {
  const total = parts.reduce((n, p) => n + p.length, 0);
  const out = new Uint8Array(total);
  let pos = 0;
  for (const p of parts) { out.set(p, pos); pos += p.length; }
  return out;
}

export const cstr = (text) => concat(encoder.encode(text), new Uint8Array([0]));
export const u8 = (v) => new Uint8Array([v & 0xFF]);
export const u16 = (v) => new Uint8Array([v & 0xFF, (v >> 8) & 0xFF]);
export const i16 = u16;
export const u32 = (v) => new Uint8Array([v & 0xFF, (v >>> 8) & 0xFF, (v >>> 16) & 0xFF, (v >>> 24) & 0xFF]);

export class Reader {
  constructor(data) {
    this.data = data;
    this.view = new DataView(data.buffer, data.byteOffset, data.byteLength);
    this.pos = 0;
  }
  atEnd() { return this.pos >= this.data.length; }
  u8() { return this.view.getUint8(this.pos++); }
  i8() { return this.view.getInt8(this.pos++); }
  i16() { const v = this.view.getInt16(this.pos, true); this.pos += 2; return v; }
  u32() { const v = this.view.getUint32(this.pos, true); this.pos += 4; return v; }
  string() {
    let end = this.data.indexOf(0, this.pos);
    if (end < 0) end = this.data.length;
    const text = decoder.decode(this.data.subarray(this.pos, end));
    this.pos = end + 1;
    return text;
  }
}

// ---------- Client ----------

/**
 * Talks to a radio over a transport: { write(Uint8Array): Promise, onData: (Uint8Array) => void }.
 * Requests run one at a time; `priority` requests (user input) go ahead of queued ones (screenshots).
 *
 * Events: 'log' (detail: text), 'state' (detail: { flightMode, rfActive, backlightOn }),
 * 'controls' (detail: { switches, trims, functionSwitches }), 'hello', 'accepted', 'refused'.
 */
export class RadioClient extends EventTarget {
  constructor(transport) {
    super();
    this.transport = transport;
    this.parser = new FrameParser((command, seq, payload) => this.#onFrame(command, seq, payload));
    transport.onData = (chunk) => this.parser.push(chunk);
    this.seq = 0;
    this.pending = new Map();
    this.high = [];
    this.low = [];
    this.busy = false;
    this.accepted = false;
    this.refused = false;
    this.hello = null;
    this.state = null;
    this.controls = null;
    this.localVolume = null;
    this.screens = new Map();
    this.channels = [];
  }

  #onFrame(command, seq, payload) {
    if (seq === 0) {
      if (command === EVENT.CONNECTION) {
        if (payload[0]) { this.accepted = true; this.dispatchEvent(new Event('accepted')); }
        else { this.refused = true; this.dispatchEvent(new Event('refused')); }
      } else if (command === EVENT.LOG) {
        this.dispatchEvent(new CustomEvent('log', { detail: decoder.decode(payload) }));
      } else if (command === EVENT.STATE) {
        if (payload.length < 3) return;
        this.state = { flightMode: payload[0], rfActive: !!payload[1], backlightOn: !!payload[2] };
        this.dispatchEvent(new CustomEvent('state', { detail: this.state }));
      } else if (command === EVENT.CONTROLS) {
        const controls = parseControls(payload);
        if (!controls) return;
        this.controls = controls;
        this.dispatchEvent(new CustomEvent('controls', { detail: controls }));
      }
      return;
    }
    const request = this.pending.get(seq);
    if (!request || !(command & 0x80) || payload.length < 2) return;
    request.chunks.push(payload.subarray(2));
    if (payload[1] & 0x01) {
      const status = (payload[0] << 24) >> 24; // int8
      request.finish({ status, data: concat(...request.chunks) });
    }
  }

  request(command, payload = new Uint8Array(), { timeout = 5000, priority = false } = {}) {
    return new Promise((resolve) => {
      (priority ? this.high : this.low).push({ command, payload, timeout, resolve });
      this.#pump();
    });
  }

  async #pump() {
    if (this.busy) return;
    this.busy = true;
    try {
      let job;
      while ((job = this.high.shift() ?? this.low.shift())) job.resolve(await this.#send(job));
    } finally {
      this.busy = false;
    }
  }

  #send({ command, payload, timeout }) {
    this.seq = (this.seq % 255) + 1;
    const seq = this.seq;
    return new Promise((resolve) => {
      const finish = (result) => {
        clearTimeout(timer);
        this.pending.delete(seq);
        resolve(result);
      };
      const timer = setTimeout(() => finish({ status: STATUS.TIMEOUT, data: new Uint8Array() }), timeout);
      this.pending.set(seq, { chunks: [], finish });
      this.transport.write(buildFrame(command, seq, payload))
        .catch(() => finish({ status: STATUS.IO_ERROR, data: new Uint8Array() }));
    });
  }

  /** Drops every queued request, e.g. when the port closes. */
  abort() {
    const empty = { status: STATUS.IO_ERROR, data: new Uint8Array() };
    for (const job of [...this.high, ...this.low]) job.resolve(empty);
    this.high = [];
    this.low = [];
    for (const request of [...this.pending.values()]) request.finish(empty);
  }

  /** HELLO, then wait for the user to accept the connection on the radio screen. */
  async connect({ acceptTimeout = 60000, signal } = {}) {
    const { status, data } = await this.request(CMD.HELLO, u8(PROTOCOL_VERSION), { timeout: 3000 });
    if (status) throw new Error(`No answer from the radio (HELLO ${statusText(status)})`);
    const r = new Reader(data);
    const hello = { protocol: r.u8() };
    hello.firmware = `${r.u8()}.${r.u8()}.${r.u8()}`;
    hello.board = r.atEnd() ? '' : r.string();
    hello.region = r.atEnd() ? '' : r.string();
    hello.gitHash = r.atEnd() ? '' : r.string();
    // Since version 11, the version suffix (RC11...), empty for a release
    const suffix = r.atEnd() ? '' : r.string();
    if (suffix) hello.firmware += `-${suffix}`;
    this.hello = hello;
    this.dispatchEvent(new CustomEvent('hello', { detail: hello }));

    // Already accepted earlier on this connection: the radio shows no prompt
    if ((await this.request(CMD.RESET_INACTIVITY_TIMER)).status === STATUS.SUCCESS) this.accepted = true;
    if (!this.accepted) await this.#waitForAccept(acceptTimeout, signal);
    return hello;
  }

  #waitForAccept(timeout, signal) {
    return new Promise((resolve, reject) => {
      const done = (error) => {
        clearTimeout(timer);
        this.removeEventListener('accepted', onAccept);
        this.removeEventListener('refused', onRefuse);
        signal?.removeEventListener('abort', onAbort);
        error ? reject(error) : resolve();
      };
      const onAccept = () => done();
      const onRefuse = () => done(new Error('The connection was refused on the radio screen'));
      const onAbort = () => done(new Error('Cancelled'));
      const timer = setTimeout(() => done(new Error('The connection was not accepted on the radio screen')), timeout);
      this.addEventListener('accepted', onAccept);
      this.addEventListener('refused', onRefuse);
      signal?.addEventListener('abort', onAbort);
      if (this.accepted) done();
    });
  }

  // ----- Screen -----

  /** Returns { status, image } where image is { width, height, rgba, changed, total }. */
  async screenshot(display = 0) {
    for (let attempt = 0; attempt < 2; attempt++) {
      const previous = this.screens.get(display);
      const { status, data } = await this.request(CMD.SCREENSHOT, new Uint8Array([display, previous ? 0 : 1]), { timeout: 15000 });
      if (status) {
        this.screens.delete(display);
        return { status, image: null };
      }
      const image = decodeTiles(data, previous);
      if (image) {
        this.screens.set(display, image);
        return { status, image };
      }
      this.screens.delete(display); // ask for a full frame again
    }
    return { status: STATUS.IO_ERROR, image: null };
  }

  // ----- Input -----

  get protocol() { return this.hello?.protocol ?? 0; }

  /** Key (SYS...), trim (T1+...) or, since version 9, function switch (FS1...). 540 ms or more is a long press. */
  async pressKey(key, holdMs = 100) {
    return (await this.request(CMD.PRESS, concat(u32(holdMs), cstr(key)), { priority: true })).status;
  }

  async pressFunctionSwitch(index, holdMs = 100) {
    const command = this.protocol >= 9 ? CMD.PRESS : CMD.PRESS_FUNCTION_SWITCH;
    return (await this.request(command, concat(u32(holdMs), cstr(`FS${index}`)), { priority: true })).status;
  }

  /** Since version 9 the touch lasts `ms`; before, it is a tap or a long press (from LONG_TOUCH_MS). */
  async touch(x, y, ms = 20) {
    const tail = this.protocol >= 9 ? u32(ms) : u8(ms >= LONG_TOUCH_MS ? 1 : 0);
    return (await this.request(CMD.TOUCH, concat(u16(x), u16(y), tail), { priority: true })).status;
  }

  async swipe(x1, y1, x2, y2) {
    return (await this.request(CMD.SWIPE, concat(u16(x1), u16(y1), u16(x2), u16(y2)), { priority: true })).status;
  }

  async wheel(steps) {
    return (await this.request(CMD.TURN_ROTARY_ENCODER, i16(steps), { priority: true })).status;
  }

  async enterText(text) {
    return (await this.request(CMD.ENTER_TEXT, cstr(text), { priority: true })).status;
  }

  /** Turns the screen back on. */
  async resetBacklightTimer() {
    return (await this.request(CMD.RESET_BACKLIGHT_TIMER, new Uint8Array(), { priority: true })).status;
  }

  /** All the function switches of the current model off (version 11). */
  async resetFunctionSwitches() {
    if (this.protocol < 11) return STATUS.UNSUPPORTED;
    return (await this.request(CMD.RESET_FUNCTION_SWITCHES, new Uint8Array(), { priority: true })).status;
  }

  /** Reloads the Lua scripts, or everything (version 7). */
  async reload(what = 'scripts') {
    if (this.protocol < 7) return STATUS.UNSUPPORTED;
    return (await this.request(CMD.RELOAD, u8(RELOAD[what]), { timeout: 15000, priority: true })).status;
  }

  // ----- Files -----

  /**
   * Path as the radio wants it: "/x" is on the local storage, "SD:/x" on the SD card. Radios with
   * volumes name the local storage "RADIO:".
   */
  async radioPath(path) {
    if (/^[A-Za-z]+:/.test(path)) return path;
    if (this.localVolume === null) {
      const { status } = await this.request(CMD.LIST_FILES, cstr('RADIO:/'), { timeout: 10000, priority: true });
      this.localVolume = status === STATUS.SUCCESS ? 'RADIO:' : '';
    }
    return `${this.localVolume}/${path.replace(/^\/+/, '')}`;
  }

  /** The storages to browse: the local one, and the SD card on the radios that have both. */
  async drives() {
    const drives = [{ name: 'Radio', path: '/' }];
    await this.radioPath('/');
    if (this.localVolume) {
      const { status } = await this.request(CMD.LIST_FILES, cstr('SD:/'), { timeout: 10000, priority: true });
      if (status === STATUS.SUCCESS) drives.push({ name: 'SD card', path: 'SD:/' });
    }
    return drives;
  }

  async listFiles(path) {
    const { status, data } = await this.request(CMD.LIST_FILES, cstr(await this.radioPath(path)), { timeout: 10000, priority: true });
    const files = [];
    const r = new Reader(data);
    while (status === 0 && !r.atEnd()) {
      const dir = r.u8() !== 0;
      const size = r.u32();
      const name = r.string();
      if (name !== '.' && name !== '..') files.push({ name, dir, size });
    }
    return { status, files };
  }

  async readFile(path) {
    return this.request(CMD.READ_FILE, concat(u32(0), cstr(await this.radioPath(path))), { timeout: 120000, priority: true });
  }

  async writeFile(path, data, onProgress) {
    path = await this.radioPath(path);
    const header = u32(0).length + cstr(path).length;
    const room = MAX_PAYLOAD - header;
    let offset = 0;
    do {
      const part = data.subarray(offset, offset + room);
      const { status } = await this.request(CMD.WRITE_FILE, concat(u32(offset), cstr(path), part), { timeout: 10000, priority: true });
      if (status) return status;
      offset += part.length;
      onProgress?.(offset, data.length);
    } while (offset < data.length);
    return STATUS.SUCCESS;
  }

  /** Deletes a file, or an empty folder. */
  async deleteFile(path) {
    return (await this.request(CMD.DELETE_FILE, cstr(await this.radioPath(path)), { priority: true })).status;
  }

  /** Creates a folder; its parent must exist (version 10). */
  async createDirectory(path) {
    if (this.protocol < 10) return STATUS.UNSUPPORTED;
    return (await this.request(CMD.CREATE_DIRECTORY, cstr(await this.radioPath(path)), { priority: true })).status;
  }

  async loadModel(path) {
    return (await this.request(CMD.LOAD_MODEL, cstr(path), { timeout: 10000, priority: true })).status;
  }

  // ----- Values -----

  /** Trim values in percent (-100 to 100). */
  async trims() {
    const { status, data } = await this.request(CMD.TRIMS);
    if (status) return { status, trims: [] };
    const r = new Reader(data);
    const trims = [];
    while (r.pos + 2 <= data.length) trims.push(Math.round(r.i16() * 100 / 256));
    return { status, trims };
  }

  /** Mixer outputs, -1024 to 1024 for -100% to +100%. */
  async channelOutputs() {
    const { status, data } = await this.request(CMD.CHANNELS_OUTPUTS, u8(this.channels.length ? 0 : 1));
    if (status) return { status, channels: this.channels };
    const channels = parseChannels(data, this.channels);
    if (!channels) { this.channels = []; return { status: STATUS.IO_ERROR, channels: [] }; }
    this.channels = channels;
    return { status, channels };
  }
}

/** CHANNELS_OUTPUTS response: count (1), bitmap of changed channels, int16 value per changed channel. */
export function parseChannels(data, previous = []) {
  if (!data.length) return null;
  const count = data[0];
  const bitmapLength = Math.ceil(count / 8);
  if (data.length < 1 + bitmapLength) return null;
  const channels = previous.length === count ? [...previous] : new Array(count).fill(0);
  const r = new Reader(data);
  r.pos = 1 + bitmapLength;
  for (let i = 0; i < count; i++) {
    if (!(data[1 + (i >> 3)] & (1 << (i & 7)))) continue;
    if (r.pos + 2 > data.length) return null;
    channels[i] = r.i16();
  }
  return channels;
}

/**
 * EVENT.CONTROLS: switches count (1), positions (int8 each: -1 up, 0 middle, 1 down, -128 not installed),
 * trims count (1), trims (int16 each), function switches count (1), states (1, bit i = FS(i + 1) on).
 */
export function parseControls(data) {
  try {
    const r = new Reader(data);
    const switches = [];
    for (let i = 0, count = r.u8(); i < count; i++) {
      const position = r.i8();
      if (position !== SWITCH_NOT_INSTALLED) switches.push({ name: `S${String.fromCharCode(65 + i)}`, position });
    }
    const trims = [];
    for (let i = 0, count = r.u8(); i < count; i++) trims.push(Math.round(r.i16() * 100 / 256));
    const count = r.u8();
    const states = r.u8();
    const functionSwitches = Array.from({ length: count }, (_, i) => !!(states & (1 << i)));
    return { switches, trims, functionSwitches };
  } catch {
    return null; // truncated
  }
}
