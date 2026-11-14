import test from 'node:test';
import assert from 'node:assert/strict';
import {
  CMD, EVENT, FrameParser, RadioClient, Reader, STATUS, buildFrame, concat, crc16, cstr, parseChannels, parseControls,
  u16, u8,
} from '../src/protocol.js';
import { decodeQoi, decodeTiles } from '../src/qoi.js';

// ---------- QOI encoder (port of the reference encoder), to produce test data ----------

function encodeQoi(width, height, rgba) {
  const out = [0x71, 0x6F, 0x69, 0x66];
  const be32 = (v) => out.push((v >>> 24) & 255, (v >>> 16) & 255, (v >>> 8) & 255, v & 255);
  be32(width); be32(height); out.push(4, 0);
  const index = new Array(64).fill(null).map(() => [0, 0, 0, 0]);
  let prev = [0, 0, 0, 255];
  let run = 0;
  const count = width * height;
  for (let i = 0; i < count; i++) {
    const px = [rgba[i * 4], rgba[i * 4 + 1], rgba[i * 4 + 2], rgba[i * 4 + 3]];
    const same = px.every((v, k) => v === prev[k]);
    if (same) {
      run++;
      if (run === 62 || i === count - 1) { out.push(0xC0 | (run - 1)); run = 0; }
      continue;
    }
    if (run) { out.push(0xC0 | (run - 1)); run = 0; }
    const h = (px[0] * 3 + px[1] * 5 + px[2] * 7 + px[3] * 11) % 64;
    if (index[h].every((v, k) => v === px[k])) {
      out.push(h);
    } else {
      index[h] = px;
      if (px[3] === prev[3]) {
        const s = (v) => ((v + 128) & 255) - 128; // wrap to int8
        const dr = s(px[0] - prev[0]), dg = s(px[1] - prev[1]), db = s(px[2] - prev[2]);
        const drg = dr - dg, dbg = db - dg;
        if (dr > -3 && dr < 2 && dg > -3 && dg < 2 && db > -3 && db < 2) {
          out.push(0x40 | ((dr + 2) << 4) | ((dg + 2) << 2) | (db + 2));
        } else if (drg > -9 && drg < 8 && dg > -33 && dg < 32 && dbg > -9 && dbg < 8) {
          out.push(0x80 | (dg + 32), ((drg + 8) << 4) | (dbg + 8));
        } else {
          out.push(0xFE, px[0], px[1], px[2]);
        }
      } else {
        out.push(0xFF, ...px);
      }
    }
    prev = px;
  }
  out.push(0, 0, 0, 0, 0, 0, 0, 1);
  return new Uint8Array(out);
}

function randomImage(width, height, seed = 1) {
  const rgba = new Uint8ClampedArray(width * height * 4);
  let s = seed;
  const rnd = () => ((s = (s * 1103515245 + 12345) & 0x7FFFFFFF) >> 16) & 255;
  for (let i = 0; i < width * height; i++) {
    // Mix of flat runs, small deltas and random colors to hit every QOI op
    const mode = (i >> 5) % 4;
    const base = mode === 0 ? 40 : mode === 1 ? (i & 255) : rnd();
    rgba.set([base, mode === 3 ? rnd() : base + 1, base ^ 3, 255], i * 4);
  }
  return rgba;
}

/** Builds a SCREENSHOT payload for the given tiles of `frame`. */
function tilesPayload(width, height, tile, frame, changed) {
  const tilesX = Math.ceil(width / tile);
  const total = tilesX * Math.ceil(height / tile);
  const bitmap = new Uint8Array(Math.ceil(total / 8));
  const stacked = new Uint8ClampedArray(tile * tile * changed.length * 4);
  changed.forEach((i, n) => {
    bitmap[i >> 3] |= 1 << (i & 7);
    const x0 = (i % tilesX) * tile;
    const y0 = Math.floor(i / tilesX) * tile;
    for (let row = 0; row < tile; row++) {
      for (let col = 0; col < tile; col++) {
        const x = Math.min(x0 + col, width - 1);
        const y = Math.min(y0 + row, height - 1);
        stacked.set(frame.subarray((y * width + x) * 4, (y * width + x) * 4 + 4), ((n * tile + row) * tile + col) * 4);
      }
    }
  });
  const qoi = changed.length ? encodeQoi(tile, tile * changed.length, stacked) : new Uint8Array();
  return concat(u16(width), u16(height), u8(tile), bitmap, qoi);
}

// ---------- Tests ----------

test('crc16 is CRC-16/XMODEM', () => {
  assert.equal(crc16(new TextEncoder().encode('123456789')), 0x31C3);
});

test('frames round-trip through the parser, even split and with noise', () => {
  const frames = [];
  const parser = new FrameParser((command, seq, payload) => frames.push({ command, seq, payload: [...payload] }));
  const a = buildFrame(0x81, 7, new Uint8Array([0, 1, 42]));
  const b = buildFrame(0xC3, 0, new TextEncoder().encode('hello'));
  const bad = buildFrame(0x81, 9, new Uint8Array([1]));
  bad[bad.length - 1] ^= 0xFF;
  const stream = concat(new Uint8Array([1, 2, 3]), a, bad, b);
  for (let i = 0; i < stream.length; i += 3) parser.push(stream.subarray(i, i + 3));
  assert.deepEqual(frames, [
    { command: 0x81, seq: 7, payload: [0, 1, 42] },
    { command: 0xC3, seq: 0, payload: [...new TextEncoder().encode('hello')] },
  ]);
});

test('QOI decoder matches the encoder', () => {
  const rgba = randomImage(37, 23);
  const decoded = decodeQoi(encodeQoi(37, 23, rgba));
  assert.equal(decoded.width, 37);
  assert.deepEqual(decoded.rgba, rgba);
});

test('screen tiles: full frame, then only changed tiles', () => {
  const [width, height, tile] = [100, 60, 16]; // edge tiles are partial
  const first = randomImage(width, height, 3);
  const total = Math.ceil(width / tile) * Math.ceil(height / tile);
  const full = decodeTiles(tilesPayload(width, height, tile, first, [...Array(total).keys()]), null);
  assert.deepEqual(full.rgba, first);

  const second = new Uint8ClampedArray(first);
  for (let y = 20; y < 40; y++) for (let x = 90; x < 100; x++) second.set([255, 0, 0, 255], (y * width + x) * 4);
  const tilesX = Math.ceil(width / tile);
  const changed = [1, 2].map((ty) => ty * tilesX + 6).concat([1, 2].map((ty) => ty * tilesX + 5));
  changed.sort((a, b) => a - b);
  const update = decodeTiles(tilesPayload(width, height, tile, second, changed), full);
  assert.equal(update.changed, 4);
  assert.deepEqual(update.rgba, second);

  // A partial update without a previous frame cannot be decoded
  assert.equal(decodeTiles(tilesPayload(width, height, tile, second, changed), null), null);
  // Nothing changed
  assert.equal(decodeTiles(tilesPayload(width, height, tile, second, []), update).changed, 0);
});

test('channel outputs keep unchanged channels', () => {
  const data = concat(u8(10), new Uint8Array([0b101, 0b10]), u16(100), u16(-200 & 0xFFFF), u16(1024));
  assert.deepEqual(parseChannels(data, new Array(10).fill(5)), [100, 5, -200, 5, 5, 5, 5, 5, 5, 1024]);
});

// ---------- Client against a fake radio ----------

class FakeRadio {
  constructor({ prompt = true, version = 6, volumes = false } = {}) {
    this.prompt = prompt;
    this.version = version;
    this.volumes = volumes;
    this.accepted = !prompt;
    this.received = [];
    this.parser = new FrameParser((command, seq, payload) => this.handle(command, seq, payload));
    this.transport = { onData: null, write: async (bytes) => { setTimeout(() => this.parser.push(bytes), 1); } };
  }

  reply(command, seq, status, data = new Uint8Array(), chunk = 1000) {
    let offset = 0;
    do {
      const part = data.subarray(offset, offset + chunk);
      offset += part.length;
      const last = offset >= data.length ? 1 : 0;
      this.transport.onData(buildFrame(command | 0x80, seq, concat(new Uint8Array([status & 255, last]), part)));
    } while (offset < data.length);
  }

  event(command, payload) {
    this.transport.onData(buildFrame(command, 0, payload));
  }

  handle(command, seq, payload) {
    this.received.push({ command, payload });
    if (command === CMD.HELLO) {
      const suffix = this.version >= 11 ? cstr('RC2') : new Uint8Array();
      return this.reply(command, seq, 0, concat(u8(this.version), u8(26), u8(1), u8(3), cstr('X20S'), cstr('EU'), cstr('abcdef12'), suffix));
    }
    if (!this.accepted) return this.reply(command, seq, -2);
    if (command === CMD.TRIMS) return this.reply(command, seq, 0, concat(u16(256), u16(-128 & 0xFFFF), u16(0), u16(25600)));
    if (command === CMD.LIST_FILES) {
      const path = new Reader(payload).string();
      if (/^[A-Z]+:/.test(path) !== this.volumes) return this.reply(command, seq, -3);
      return this.reply(command, seq, 0, concat(u8(1), new Uint8Array(4), cstr('models'), u8(0), new Uint8Array([0x10, 0, 0, 0]), cstr('a.txt')));
    }
    if (command === CMD.SCREENSHOT) {
      const frame = randomImage(48, 32, 9);
      return this.reply(command, seq, 0, tilesPayload(48, 32, 16, frame, [...Array(6).keys()]), 200);
    }
    return this.reply(command, seq, 0);
  }

  accept() {
    this.accepted = true;
    this.event(EVENT.CONNECTION, u8(1));
  }
}

test('client connects after the radio accepts, then runs commands', async () => {
  const radio = new FakeRadio();
  const client = new RadioClient(radio.transport);
  const logs = [];
  client.addEventListener('log', (e) => logs.push(e.detail));
  const connecting = client.connect({ acceptTimeout: 2000 });
  setTimeout(() => radio.accept(), 30);
  const hello = await connecting;
  assert.deepEqual(hello, { protocol: 6, firmware: '26.1.3', board: 'X20S', region: 'EU', gitHash: 'abcdef12' });

  radio.event(EVENT.LOG, new TextEncoder().encode('radio says hi'));
  assert.deepEqual(logs, ['radio says hi']);

  assert.deepEqual((await client.trims()).trims, [100, -50, 0, 10000]);
  assert.deepEqual((await client.listFiles('/')).files, [
    { name: 'models', dir: true, size: 0 },
    { name: 'a.txt', dir: false, size: 16 },
  ]);
  const { status, image } = await client.screenshot(0);
  assert.equal(status, 0);
  assert.deepEqual(image.rgba, randomImage(48, 32, 9));

  assert.equal(await client.pressKey('SYS', 120), 0);
  const press = radio.received.at(-1);
  assert.equal(press.command, CMD.PRESS);
  assert.deepEqual([...press.payload], [120, 0, 0, 0, ...new TextEncoder().encode('SYS'), 0]);

  assert.equal(await client.wheel(-2), 0);
  assert.deepEqual([...radio.received.at(-1).payload], [0xFE, 0xFF]);
});

test('client reports a refused connection', async () => {
  const radio = new FakeRadio();
  const client = new RadioClient(radio.transport);
  const connecting = client.connect({ acceptTimeout: 2000 });
  setTimeout(() => radio.event(EVENT.CONNECTION, u8(0)), 30);
  await assert.rejects(connecting, /refused/);
});

test('input requests jump ahead of queued screenshots', async () => {
  const radio = new FakeRadio({ prompt: false });
  const client = new RadioClient(radio.transport);
  const order = [];
  const shots = [client.screenshot(0), client.screenshot(0), client.screenshot(0)].map((p) => p.then(() => order.push('shot')));
  const key = client.pressKey('RTN').then(() => order.push('key'));
  await Promise.all([...shots, key]);
  assert.deepEqual(order, ['shot', 'key', 'shot', 'shot']);
});

test('Reader handles a string without terminator', () => {
  const r = new Reader(new TextEncoder().encode('abc'));
  assert.equal(r.string(), 'abc');
  assert.ok(r.atEnd());
});

const text = (payload, from = 0) => new Reader(payload.subarray(from)).string();

test('protocol version 6: function switches and long touches use the old payloads', async () => {
  const radio = new FakeRadio({ prompt: false });
  const client = new RadioClient(radio.transport);
  await client.connect();

  await client.pressFunctionSwitch(2, 100);
  assert.equal(radio.received.at(-1).command, CMD.PRESS_FUNCTION_SWITCH);
  await client.touch(10, 20, 1000);
  assert.deepEqual([...radio.received.at(-1).payload], [10, 0, 20, 0, 1]);
  await client.touch(10, 20);
  assert.deepEqual([...radio.received.at(-1).payload], [10, 0, 20, 0, 0]);

  const sent = radio.received.length;
  assert.equal(await client.createDirectory('/scripts/new'), STATUS.UNSUPPORTED);
  assert.equal(await client.reload(), STATUS.UNSUPPORTED);
  assert.equal(await client.resetFunctionSwitches(), STATUS.UNSUPPORTED);
  assert.equal(radio.received.length, sent);

  // No volumes: paths are sent as they are
  await client.deleteFile('/scripts/a.lua');
  assert.equal(text(radio.received.at(-1).payload), '/scripts/a.lua');
  assert.deepEqual(await client.drives(), [{ name: 'Radio', path: '/' }]);
});

test('protocol version 11: new payloads, commands, volumes and events', async () => {
  const radio = new FakeRadio({ prompt: false, version: 11, volumes: true });
  const client = new RadioClient(radio.transport);
  const hello = await client.connect();
  assert.equal(radio.received[0].payload[0], 11);
  assert.equal(hello.firmware, '26.1.3-RC2');

  await client.pressFunctionSwitch(2, 100);
  assert.equal(radio.received.at(-1).command, CMD.PRESS);
  assert.equal(text(radio.received.at(-1).payload, 4), 'FS2');
  await client.touch(10, 20, 1000);
  assert.deepEqual([...radio.received.at(-1).payload], [10, 0, 20, 0, 0xE8, 3, 0, 0]);

  assert.equal(await client.createDirectory('/scripts/new'), 0);
  assert.equal(radio.received.at(-1).command, CMD.CREATE_DIRECTORY);
  assert.equal(text(radio.received.at(-1).payload), 'RADIO:/scripts/new');
  await client.deleteFile('SD:/logs/a.csv');
  assert.equal(text(radio.received.at(-1).payload), 'SD:/logs/a.csv');
  assert.deepEqual(await client.drives(), [{ name: 'Radio', path: '/' }, { name: 'SD card', path: 'SD:/' }]);

  assert.equal(await client.reload('scripts'), 0);
  assert.deepEqual([radio.received.at(-1).command, ...radio.received.at(-1).payload], [CMD.RELOAD, 1]);
  assert.equal(await client.resetFunctionSwitches(), 0);
  assert.equal(radio.received.at(-1).command, CMD.RESET_FUNCTION_SWITCHES);

  const events = [];
  client.addEventListener('state', (e) => events.push(e.detail));
  client.addEventListener('controls', (e) => events.push(e.detail));
  radio.event(EVENT.STATE, new Uint8Array([2, 1, 0]));
  radio.event(EVENT.CONTROLS, concat(u8(3), new Uint8Array([0xFF, 0x80, 1]), u8(2), u16(256), u16(-128 & 0xFFFF), u8(6), u8(0b100001)));
  assert.deepEqual(events, [
    { flightMode: 2, rfActive: true, backlightOn: false },
    {
      switches: [{ name: 'SA', position: -1 }, { name: 'SC', position: 1 }],
      trims: [100, -50],
      functionSwitches: [true, false, false, false, false, true],
    },
  ]);
  assert.equal(client.controls, events[1]);
});

test('truncated controls are ignored', () => {
  assert.equal(parseControls(new Uint8Array([2, 0])), null);
});
