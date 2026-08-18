# Needle

[![License: MIT](https://img.shields.io/badge/License-MIT-black.svg)](LICENSE)

Needle is a macOS turntable wallpaper that follows Apple Music, Spotify, and
browser media. It includes tactile playback controls, responsive multi-display
wallpaper windows, daylight/evening scene lighting, and an event-driven local
now-playing bridge. The website includes an original audio preview of the
same interface.

[Download the signed macOS build](https://vinyl-mac.vercel.app/download/) ·
[Try the web preview](https://vinyl-mac.vercel.app)

## Run locally

```bash
npm install
npm run dev
```

Open `http://localhost:3000`.

## Run as a macOS app

The desktop build embeds the music bridge, so there is no companion process to
start. During development, launch the web renderer and native window together:

```bash
npm run desktop:dev
```

On macOS 13 or later, Needle creates a click-through desktop window behind Finder's
icons as soon as the app opens. A separate wallpaper window is maintained for
every connected display. By default, closing the controls quits Needle and
restores the normal desktop. Enable **Needle → Set as Default Wallpaper** to
close the controls while leaving the wallpaper active; click Needle in the Dock
to reopen them. Choosing **Quit Needle** always stops the wallpaper completely.

Create an unpacked local application at `release/mac-arm64/Needle.app`:

```bash
npm run desktop:pack
```

The first native build downloads and checksum-verifies the pinned
[`mediaremote-adapter`](https://github.com/ungive/mediaremote-adapter) source,
then compiles it into the application. Needle bundles the adapter and its BSD
3-Clause license; users do not install or run a separate companion.

For a distributable DMG, run `npm run desktop:dmg`. Public downloads must be
signed with a Developer ID certificate and notarized by Apple; the Electron
Builder configuration already includes the Automation usage description and
entitlements needed for Apple Music and Spotify control.

## Release updates

Needle checks for an update shortly after launch and every six hours while it
is running. Users can also choose **Needle → Check for Updates…**. When an
update is available, Needle asks before downloading it and asks again before
restarting to install it.

To publish a release, increase the stable semantic version in `package.json`
and `package-lock.json`, then merge or push that change to `main` or `master`.
The `release-macos.yml` workflow tests the app, signs and notarizes its DMG and
ZIP, uploads the versioned artifacts to Vercel Blob, and publishes
`latest-mac.yml` last so clients never see a partially uploaded release.

The GitHub repository needs these Actions secrets:

- `MAC_CSC_LINK` and `MAC_CSC_KEY_PASSWORD`
- `APPLE_ID`, `APPLE_APP_SPECIFIC_PASSWORD`, and `APPLE_TEAM_ID`
- `BLOB_READ_WRITE_TOKEN`

Existing builds without the updater need one final manual DMG installation.
Every signed release installed after that can receive later versions through
the in-app update flow.

## Use live music during web development

In a second terminal, start the localhost-only companion:

```bash
npm run companion
```

Then play media on any website that appears in macOS Now Playing, Spotify, or
Apple Music. Needle will switch from its demo records to the real title, artist,
playback state, progress, and cover art. YouTube Music, SoundCloud, Bandcamp,
podcast players, and video sites work when their browser publishes a media
session. No Spotify, Google, or Apple API login is used. macOS may ask once for
permission to control a native music application; approve it under **System
Settings → Privacy & Security → Automation**.

The turntable volume knob controls Spotify or Apple Music directly. For browser
media it controls the Mac's output volume, so it works consistently across
sites. Drag it, scroll over it, or focus it and use the arrow keys. Its quiet tactile ticks use
four bundled mechanical samples (with a Web Audio fallback) and can be disabled
from the playback bar. The knob remains interactive in demo mode, so its motion
and sound can be felt even when no music app is playing.

The tonearm is a playback control too: drag it away from the record to pause,
or place it back over the grooves to resume. It controls the live Spotify,
Apple Music, or browser media session when one is connected and the demo record
otherwise.

The development companion listens only on `127.0.0.1:43117` and accepts
requests only from localhost origins. The macOS application calls the same
bridge directly through isolated Electron IPC and does not open that port.

## Privacy

Playback detection and control stay on the Mac. Needle first displays the
artwork supplied by macOS, then may send the current track title and artist to
YouTube Music and the iTunes Search API to find a sharper cover. It never sends
audio or music-account credentials. Candidate artwork is compared locally with
the macOS artwork before it replaces the initial image.

The macOS build requests Automation access only when it needs to control Apple
Music or Spotify. It does not request camera, microphone, Bluetooth, or audio
capture access.

## Build

```bash
npm run build
```

The artwork in `public/artwork` was created specifically for Needle.
System-wide browser metadata on macOS 15.4 and later is read through
`mediaremote-adapter`, copyright Jonas van den Berg and contributors, under the
BSD 3-Clause License. Its license is included in packaged applications.

## License

Needle is open source under the [MIT License](LICENSE). Original demo and
interface assets in this repository are covered by the same license. See
[NOTICE.md](NOTICE.md) for third-party and trademark notices.
