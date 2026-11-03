// USB access through Web Serial and WebHID (granted by main.js).

export const ETHOS_VID = 0x0483;
export const ETHOS_PID = 0x5750;
const FILTER = [{ usbVendorId: ETHOS_VID, usbProductId: ETHOS_PID }];

// USB mode reports, as sent by the Ethos suite updaters
const HID_USB_MODE_REQUEST = 0x81;
const HID_USB_MODE = { serial: 0x68, storage: 0x69 };

const isEthos = (port) => {
  const info = port.getInfo();
  return info.usbVendorId === ETHOS_VID && info.usbProductId === ETHOS_PID;
};

/** Finds the radio's serial port. `ask` shows the (automatic) port chooser, which needs a user gesture. */
export async function findPort({ ask = false } = {}) {
  const known = (await navigator.serial.getPorts()).find(isEthos);
  if (known || !ask) return known ?? null;
  try {
    return await navigator.serial.requestPort({ filters: FILTER });
  } catch {
    return null; // no radio in Serial mode
  }
}

/** Waits until the radio's serial port shows up, e.g. after switching its USB mode. */
export async function waitForPort(timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const port = await findPort();
    if (port) return port;
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  return null;
}

/** Asks the radio, over USB HID, to switch its USB port to Serial or storage mode. */
export async function switchUsbMode(mode) {
  const devices = await navigator.hid.requestDevice({ filters: [{ vendorId: ETHOS_VID, productId: ETHOS_PID }] });
  if (!devices.length) throw new Error('No Ethos radio found on USB');
  let lastError = null;
  for (const device of devices) {
    try {
      if (!device.opened) await device.open();
      await device.sendReport(0, new Uint8Array([HID_USB_MODE_REQUEST, HID_USB_MODE[mode]]));
      await device.close().catch(() => {});
      return;
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError ?? new Error('The radio did not accept the USB mode request');
}

/** Transport over a Web Serial port, for RadioClient. */
export class SerialTransport {
  constructor(port) {
    this.port = port;
    this.onData = null;
    this.onClose = null;
    this.closing = false;
    this.closed = false;
  }

  async open() {
    await this.port.open({ baudRate: 115200, bufferSize: 65536 }); // USB CDC: the baud rate is ignored
    this.writer = this.port.writable.getWriter();
    this.loop = this.#readLoop();
  }

  async #readLoop() {
    // A read error such as a framing error is not fatal: port.readable is replaced and reading goes on
    while (this.port.readable && !this.closing) {
      this.reader = this.port.readable.getReader();
      try {
        for (;;) {
          const { value, done } = await this.reader.read();
          if (done) break;
          if (value?.length) this.onData?.(value);
        }
      } catch {
        // device lost, or a recoverable read error
      } finally {
        this.reader.releaseLock();
      }
    }
    if (!this.closing) this.close(); // the radio went away; not awaited, close() waits for this loop
  }

  write(bytes) {
    return this.writer.write(bytes);
  }

  async close() {
    if (this.closed) return;
    this.closed = true;
    this.closing = true;
    await this.reader?.cancel().catch(() => {});
    await this.loop;
    try { this.writer?.releaseLock(); } catch { /* already released */ }
    await this.port.close().catch(() => {});
    this.onClose?.();
  }
}
