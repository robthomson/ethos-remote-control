# Ethos Remote Control

A desktop app for Windows, macOS and Linux that controls an FrSky Ethos radio from the PC over USB:

- **Live screen** mirrored from the radio. Click to tap, drag to swipe, hold or right-click to long-press, scroll to turn the rotary encoder.
- **Keys**: SYS, MDL, DISP, PAGE, RTN, ENTER and the arrows, on screen or from the keyboard. Hold a key for a long press.
- **Trims** with live values, **function switches** FS1–FS6, and **text entry** for the on-screen keyboard.
- **Files**: browse the radio's storage, download, upload (button or drag and drop), delete, and load model files.
- **Channels** monitor (experimental) and the radio's **log**.
- Save or copy screenshots as PNG.
- Switch the radio's USB mode between Serial and Storage without touching it.

It uses the Ethos remote control protocol described in [ethos-tools/simulation/radio_remote.md](https://github.com/FrSkyRC/ethos-tools/blob/main/simulation/radio_remote.md), the same one the online simulator uses to drive a radio.

## Requirements

- A radio running **Ethos 26 from the nightly builds of 2026-10-16 or later**, connected by USB.
- Developed against an X20S.

## Using it

1. Plug the radio in and choose **USB Serial (debug)** on its screen, or press **Switch USB to Serial** in the app if the radio is already connected in another mode.
2. Press **Connect**.
3. The radio asks whether to allow remote control: accept it on the radio screen.

Keyboard shortcuts (when no text field has focus):

| Key | Action |
| --- | --- |
| Arrow keys, `+` / `-` | Turn the rotary encoder |
| Shift + arrows | UP / DOWN / LEFT / RIGHT keys |
| Enter | ENTER |
| Esc, Backspace | RTN |
| Tab, Page Down | PAGE |
| F1 / F2 / F3 | SYS / MDL / DISP |

> **Safety:** the radio stays live while it is remote controlled. Remove propellers or disconnect the motor before pressing switches or keys with a model powered.

## Development

```sh
npm install
npm start        # run the app
npm test         # protocol and screen decoding tests
npm run dist     # build an installer for the current platform into dist/
```

Set `ETHOS_DEBUG=1` to print the page's console to the terminal.

### Builds and releases

GitHub Actions builds Windows x64 (installer and portable exe), macOS Intel and Apple Silicon (dmg) and Linux x64 and arm64 (AppImage and tar.gz):

| Trigger | Result |
| --- | --- |
| Push to `main`, pull request | Build artifacts on the workflow run, versioned `0.0.0-commit-<sha>` |
| Tag `snapshot/<version>` | GitHub pre-release |
| Tag `release/<version>` | GitHub release (`1.2.3-rc1` style versions are marked Release Candidate) |

Release notes come from the matching `## <version>` section of [Releases.md](Releases.md), so add that section before tagging:

```sh
git tag release/0.1.0
git push origin release/0.1.0
```

| File | Purpose |
| --- | --- |
| [main.js](main.js) | Electron main process: window, and automatic choice of the radio's serial port and HID interface |
| [src/protocol.js](src/protocol.js) | Protocol framing, CRC, request queue and commands |
| [src/qoi.js](src/qoi.js) | Decoding of the screen tiles the radio sends (QOI images) |
| [src/usb.js](src/usb.js) | Web Serial transport and the USB mode switch over WebHID |
| [src/app.js](src/app.js) | User interface |

The serial port is opened with the Web Serial API built into Electron, so the app needs no native modules.

### Linux

Give your user access to the radio's serial port and HID interface, then plug the radio in again:

```sh
sudo usermod -aG dialout $USER     # serial port (log out and in again)
echo 'KERNEL=="hidraw*", ATTRS{idVendor}=="0483", ATTRS{idProduct}=="5750", MODE="0660", TAG+="uaccess"' \
  | sudo tee /etc/udev/rules.d/70-ethos.rules
sudo udevadm control --reload-rules
```

If ModemManager is installed it may grab the serial port when the radio appears; stop it or add an ignore rule for `0483:5750`.

### macOS

Builds are not signed. On first launch, right-click the app and choose **Open**.
