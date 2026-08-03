# Renderer crash: youtube.com/watch playing inside a cross-origin iframe

A minimal reproduction for a renderer crash observed on Chrome 150.0.7871.187 (Windows 11).

## Summary

Loading `https://www.youtube.com/watch?v=<ID>` inside a cross-origin iframe and letting it
start playback kills the renderer process about 3 seconds after `playing` fires. No JavaScript
error, no media error event — the frame simply dies.

Framing the watch page requires stripping `X-Frame-Options`, which the bundled extension does
(and nothing else). The crash does not depend on the extension in any other way: it reproduces
with content scripts fully disabled.

## Reproduction

1. Load `extension/` as an unpacked extension (`chrome://extensions` → Developer mode → Load unpacked).
   It contains a single `declarativeNetRequest` rule that removes `X-Frame-Options` from
   sub-frame responses. No content scripts, no host permissions beyond that.
2. Serve `repro.html` over HTTPS from a host listed in `rules.json` `initiatorDomains`,
   or edit `rules.json` to add your host.
3. Open `repro.html`, put a YouTube video URL in the field and press the button.
4. The frame plays for a moment, then shows the sad-tab crash page.

Observed 6 out of 6 attempts, with and without an `allow` attribute on the iframe.

## Crash signature

Every crash dump in `%LOCALAPPDATA%\Google\Chrome\User Data\Crashpad\reports` shares the same
signature (20+ dumps collected on 2026-08-03):

| Field | Value |
| --- | --- |
| Process type | renderer (the youtube.com process) |
| Exception code | `0x80000003` (breakpoint — an intentional `CHECK`) |
| Crash address | `chrome.dll+0x452452c` — identical across every dump |
| Timing | ~3 s after `HTMLMediaElement` fires `playing` |

Because all `youtube.com` frames share one renderer under site isolation, one crash takes down
every YouTube frame on the page at once.

## What is not involved

Each of these was ruled out by measurement, not by reasoning:

- **Extension content scripts** — reproduced with every content script disabled on youtube.com.
- **Hardware video decoding** — reproduced with hardware acceleration both on and off.
- **Codec** — crashes with VP9 and with AV1; the same codec also plays fine after a reload.
- **The `allow` attribute** — 3/3 crashes with it, 3/3 without it.
- **Page structure of the embedder** — reproduces with a single iframe on an otherwise empty page.
- **Memory pressure** — reproduces with >20 GB of commit headroom.
- **`accounts.youtube.com` being blocked by `frame-ancestors`** — still crashes when that frame
  is prevented from being created.

## Not affected

`https://www.youtube.com/embed/<ID>` (the official embedded player) plays in the same iframe
without crashing. `player.twitch.tv` and other sites are unaffected.

## Environment

- Chrome 150.0.7871.187 (64-bit), Windows 11 Pro 26200
- YouTube web client `2.20260731.00.00`
- First dumps appeared 2026-08-03; the embedder code involved had not changed since June.
