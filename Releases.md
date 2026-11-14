## 0.2.0

Follows the remote control protocol up to version 11 (ethos-tools 0.3.0). Older Ethos 26 nightlies keep working.

- Switch positions and function switch states are shown live, and trims update as soon as they change (protocol 11).
- Reset all function switches of the current model (protocol 11).
- Files: create folders (protocol 10), delete empty folders, browse the SD card on radios with two storages, and reload the Lua scripts (protocol 7).
- Flight mode, RF and backlight state in the toolbar, and a Wake button to turn the screen back on.
- An input that only woke the screen is reported as such instead of as an error.
- The firmware version shows its suffix (RC1...), and colour codes are removed from the radio log.
- The channel monitor is no longer marked experimental.

## 0.1.0

First release.

- Live view of the radio screen: click to tap, drag to swipe, hold or right-click to long-press, scroll to turn the rotary encoder.
- Radio keys on screen and from the keyboard, with long press when held.
- Trims with live values, function switches FS1–FS6, and text entry for the on-screen keyboard.
- File browser: download, upload (also by drag and drop), delete, and load models.
- Radio log, experimental channel monitor, and screenshot save or copy.
- Switches the radio's USB mode between Serial and Storage.
- Needs Ethos 26 from the nightly builds of 2026-10-16 or later.
