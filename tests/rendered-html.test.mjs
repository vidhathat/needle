import assert from "node:assert/strict";
import { readFile, stat } from "node:fs/promises";
import test from "node:test";
import { resolveAppRequestHandler } from "../desktop/app-server.mjs";
import {
  maximumArtworkDifference,
  normalizedArtworkDifference,
} from "../desktop/artwork-validation.mjs";
import {
  adapterPayloadToBrowserPlayback,
  adapterPayloadToMediaPlayback,
  createStagedArtworkResolver,
  isBrowserPlayer,
  parseMediaRemoteStreamLine,
  selectCatalogArtwork,
  selectYouTubeMusicArtwork,
} from "../scripts/now-playing-companion.mjs";
import {
  advanceCircularKnobGesture,
  createCircularKnobGesture,
  shortestAngleDelta,
} from "../app/player/volume-gesture.mjs";
import {
  liveTrackIdentity,
  shouldHoldIncomingTrack,
  transientIdleGracePeriod,
} from "../app/player/live-track-transition.mjs";

async function render(pathname = "/player") {
  const workerUrl = new URL("../dist/server/index.js", import.meta.url);
  workerUrl.searchParams.set("test", `${process.pid}-${Date.now()}`);
  const { default: serverModule } = await import(workerUrl.href);
  const handleRequest = resolveAppRequestHandler(serverModule);

  return handleRequest(
    new Request(`http://localhost${pathname}`, {
      headers: { accept: "text/html", host: "localhost" },
    }),
    {
      ASSETS: {
        fetch: async () => new Response("Not found", { status: 404 }),
      },
    },
    {
      waitUntil() {},
      passThroughOnException() {},
    },
  );
}

test("server-renders the Needle experience", async () => {
  const response = await render();
  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type") ?? "", /^text\/html\b/i);

  const html = await response.text();
  assert.match(html, /<title>Needle — A tactile turntable for your Mac desktop<\/title>/i);
  assert.match(
    html,
    /<link(?=[^>]*\brel="icon")(?=[^>]*\bhref="\/favicon\.png")(?=[^>]*\btype="image\/png")(?=[^>]*\bsizes="64x64")[^>]*>/i,
  );
  assert.match(
    html,
    /<link(?=[^>]*\brel="apple-touch-icon")(?=[^>]*\bhref="\/apple-touch-icon\.png")(?=[^>]*\bsizes="180x180")[^>]*>/i,
  );
  assert.doesNotMatch(html, /class="story-panel"/i);
  assert.doesNotMatch(html, /Finding local player|Demo mode · Companion offline/);
  assert.match(html, /aria-label="Demo volume"/);
  assert.match(html, /Slow Orbit/);
  assert.doesNotMatch(html, /codex-preview|react-loading-skeleton/i);
});

test("links the landing page to the stable signed Needle download", async () => {
  const response = await render("/");
  const html = await response.text();

  assert.match(html, /href="\/download\/"/);
  assert.match(html, /download="Needle\.dmg"/);
  assert.match(html, /Developer ID signed/);
  assert.doesNotMatch(html, /Signed &amp; notarized/);
});

test("targets macOS 13 and hardens packaged privacy metadata", async () => {
  const packageJson = JSON.parse(await readFile(
    new URL("../package.json", import.meta.url),
    "utf8",
  ));
  const afterPack = await readFile(
    new URL("../scripts/after-pack.mjs", import.meta.url),
    "utf8",
  );

  assert.equal(packageJson.build.mac.minimumSystemVersion, "13.0");
  assert.equal(packageJson.build.afterPack, "scripts/after-pack.mjs");
  assert.match(afterPack, /NSAllowsLocalNetworking/);
  assert.match(afterPack, /NSCameraUsageDescription/);
  assert.match(afterPack, /NSMicrophoneUsageDescription/);
  assert.doesNotMatch(afterPack, /NSAllowsArbitraryLoads/);
});

test("requires signed macOS release artifacts", async () => {
  const packageJson = JSON.parse(await readFile(
    new URL("../package.json", import.meta.url),
    "utf8",
  ));
  const verifier = await readFile(
    new URL("../scripts/verify-mac-release.mjs", import.meta.url),
    "utf8",
  );

  assert.equal(packageJson.build.dmg.sign, true);
  assert.match(packageJson.scripts["desktop:dmg"], /verify-mac-release\.mjs/);
  assert.match(verifier, /Needle\.app/);
  assert.match(verifier, /Needle DMG/);
  assert.match(verifier, /--verify/);
  assert.match(verifier, /Authority=Developer ID Application:/);
  assert.match(verifier, /TeamIdentifier/);
});

test("packages the renderer runtime beside the embedded server", async () => {
  const packageJson = JSON.parse(await readFile(
    new URL("../package.json", import.meta.url),
    "utf8",
  ));
  const packagedResources = packageJson.build.extraResources.map(({ from, to }) => ({ from, to }));

  for (const dependency of ["react", "react-dom", "scheduler"]) {
    assert.deepEqual(
      packagedResources.find(({ from }) => from === `node_modules/${dependency}`),
      {
        from: `node_modules/${dependency}`,
        to: `needle-dist/node_modules/${dependency}`,
      },
    );
  }
});

test("removes the player header everywhere while keeping playback controls app-only", async () => {
  const response = await render("/player");
  const html = await response.text();
  const css = await readFile(new URL("../app/globals.css", import.meta.url), "utf8");

  assert.doesNotMatch(html, /class="topbar"|Switch to evening light|Switch to daylight/);
  assert.match(html, /aria-label="Playback controls"/);
  assert.match(css, /html\[data-needle-mode="wallpaper"\] \.app-shell \{[\s\S]*?grid-template-rows: minmax\(0, 1fr\)/);
  assert.match(css, /html\[data-needle-mode="wallpaper"\] \.transport \{\s*display: none/);
});

test("bundles all four tactile knob sounds", async () => {
  const sounds = ["gear-q1.mp3", "gear-q2.mp3", "gear-q3.mp3", "gear-q4.mp3"];
  const sizes = await Promise.all(
    sounds.map(async (sound) => (await stat(new URL(`../public/audio/knob/${sound}`, import.meta.url))).size),
  );

  sizes.forEach((size) => assert.ok(size > 0));
});

test("ships only the redistributable landing demo", async () => {
  const player = await readFile(new URL("../app/player/page.tsx", import.meta.url), "utf8");
  const demo = await stat(new URL("../public/audio/needle-demo.m4a", import.meta.url));
  const license = await readFile(new URL("../LICENSE", import.meta.url), "utf8");

  assert.ok(demo.size > 0);
  assert.match(player, /Needle Studio/);
  assert.match(player, /needle-demo\.m4a/);
  assert.doesNotMatch(player, /Harry Styles|Sign of the Times/);
  assert.match(license, /^MIT License/);
  await assert.rejects(stat(new URL("../public/audio/sign-of-the-times.m4a", import.meta.url)));
  await assert.rejects(stat(new URL("../public/artwork/sign-of-the-times.png", import.meta.url)));
});

test("lets users keep the wallpaper running after closing the controls", async () => {
  const main = await readFile(new URL("../desktop/main.mjs", import.meta.url), "utf8");

  assert.match(main, /if \(isMac\) \{[\s\S]*?await syncWallpaperWindows\(\)/);
  assert.match(main, /Set as Default Wallpaper/);
  assert.match(main, /keepWallpaperRunningAfterClose = preferences\.keepWallpaperRunningAfterClose === true/);
  assert.match(main, /mainWindow\.on\("closed", \(\) => \{[\s\S]*?if \(!isQuitting && \(!keepWallpaperRunningAfterClose \|\| !wallpaperEnabled\)\) app\.quit\(\)/);
  assert.match(main, /app\.on\("window-all-closed", \(\) => \{[\s\S]*?if \(!isMac \|\| !keepWallpaperRunningAfterClose \|\| !wallpaperEnabled\) app\.quit\(\)/);
  assert.match(main, /app\.on\("before-quit", \(\) => \{[\s\S]*?destroyWallpaperWindows\(\)/);
  assert.doesNotMatch(main, /\bTray\b|setLoginItemSettings|Show as Wallpaper|Show Wallpaper Only While Playing/);
});

test("recognizes macOS media sessions from common browsers", () => {
  assert.equal(isBrowserPlayer("com.brave.Browser", "Brave Browser"), true);
  assert.equal(isBrowserPlayer("com.google.Chrome.app.Profile-1", "Google Chrome"), true);
  assert.equal(isBrowserPlayer("com.apple.Safari", "Safari"), true);
  assert.equal(isBrowserPlayer("com.apple.Music", "Music"), false);
});

test("converts the bundled macOS adapter payload into browser playback", () => {
  assert.deepEqual(adapterPayloadToBrowserPlayback({
    bundleIdentifier: "com.brave.Browser",
    title: "New Amapiano",
    artist: "YT Music",
    album: "",
    duration: 120.021,
    elapsedTime: 31,
    elapsedTimeNow: 33.4,
    playing: true,
    artworkMimeType: "image/jpeg",
    artworkData: "cover-data",
  }), {
    status: "playing",
    source: "browser",
    player: "Brave Browser",
    title: "New Amapiano",
    artist: "YT Music",
    album: "",
    duration: 120.021,
    position: 33.4,
    artwork: "data:image/jpeg;base64,cover-data",
  });
  assert.equal(adapterPayloadToBrowserPlayback({
    bundleIdentifier: "com.apple.Music",
    title: "Not browser media",
  }), null);
});

test("keeps embedded MediaRemote artwork available for native music apps", () => {
  assert.deepEqual(adapterPayloadToMediaPlayback({
    bundleIdentifier: "com.apple.Music",
    player: "Music",
    title: "Ain't Nobody",
    artist: "Anirudh Ravichander",
    album: "Single",
    duration: 180,
    elapsedTimeNow: 12,
    playing: true,
    artworkMimeType: "image/jpeg",
    artworkData: "native-cover",
  }), {
    status: "playing",
    source: "apple-music",
    player: "Music",
    track: {
      title: "Ain't Nobody",
      artist: "Anirudh Ravichander",
      album: "Single",
      duration: 180,
      position: 12,
      artwork: "data:image/jpeg;base64,native-cover",
    },
  });
});

test("parses MediaRemote stream events and ignores non-data output", () => {
  assert.deepEqual(parseMediaRemoteStreamLine(JSON.stringify({
    type: "data",
    diff: false,
    payload: { title: "Instant update", bundleIdentifier: "com.apple.Music" },
  })), {
    title: "Instant update",
    bundleIdentifier: "com.apple.Music",
  });
  assert.equal(parseMediaRemoteStreamLine('{"type":"ready"}'), null);
  assert.equal(parseMediaRemoteStreamLine("not json"), null);
});

test("selects a high-resolution catalog cover for browser playback", () => {
  assert.equal(selectCatalogArtwork({
    title: "Verappa (Urumum Venga) - Female Version",
    artist: "Sai Abhyankkar",
  }, [{
    trackName: "Verappa (Urumum Venga) - Female Version",
    artistName: "Sai Abhyankkar",
    artworkUrl100: "https://example.com/cover/100x100bb.jpg",
  }]), "https://example.com/cover/1200x1200bb.jpg");
});

test("selects the matching high-resolution YouTube Music poster", () => {
  const payload = {
    shelf: {
      musicResponsiveListItemRenderer: {
        flexColumns: [
          { musicResponsiveListItemFlexColumnRenderer: { text: { runs: [{ text: "STAY" }] } } },
          { musicResponsiveListItemFlexColumnRenderer: { text: { runs: [{ text: "Song • The Kid LAROI & Justin Bieber" }] } } },
        ],
        thumbnail: {
          musicThumbnailRenderer: {
            thumbnail: {
              thumbnails: [{
                url: "https://yt3.googleusercontent.com/poster=w120-h120-l90-rj",
                width: 120,
                height: 120,
              }],
            },
          },
        },
      },
    },
  };
  assert.equal(selectYouTubeMusicArtwork({
    title: "STAY",
    artist: "The Kid LAROI and Justin Bieber",
  }, payload), "https://yt3.googleusercontent.com/poster=w1200-h1200-l90-rj");
});

test("cleans YouTube channel metadata before selecting high-resolution artwork", () => {
  const payload = {
    result: {
      musicResponsiveListItemRenderer: {
        flexColumns: [
          { musicResponsiveListItemFlexColumnRenderer: { text: { runs: [{ text: "Counting Stars" }] } } },
          { musicResponsiveListItemFlexColumnRenderer: { text: { runs: [{ text: "Song • OneRepublic • Native • 2013" }] } } },
        ],
        thumbnail: {
          musicThumbnailRenderer: {
            thumbnail: {
              thumbnails: [{
                url: "https://yt3.googleusercontent.com/counting-stars=w120-h120-l90-rj",
                width: 120,
                height: 120,
              }],
            },
          },
        },
      },
    },
  };
  assert.equal(selectYouTubeMusicArtwork({
    title: "OneRepublic - Counting Stars",
    artist: "OneRepublicVEVO",
  }, payload), "https://yt3.googleusercontent.com/counting-stars=w1200-h1200-l90-rj");
});

test("scores noisy browser metadata instead of depending on a specific song", () => {
  const result = (title, byline, url) => ({
    musicResponsiveListItemRenderer: {
      flexColumns: [
        { musicResponsiveListItemFlexColumnRenderer: { text: { runs: [{ text: title }] } } },
        { musicResponsiveListItemFlexColumnRenderer: { text: { runs: [{ text: byline }] } } },
      ],
      thumbnail: {
        musicThumbnailRenderer: {
          thumbnail: { thumbnails: [{ url }] },
        },
      },
    },
  });
  const payload = {
    results: [
      result("A Different Track", "Song • Another Artist", "https://example.com/wrong=w120-h120"),
      result("Golden Hour", "Song • Example Artist", "https://example.com/right=w120-h120"),
    ],
  };
  assert.equal(selectYouTubeMusicArtwork({
    title: "Example Artist — Golden Hour (Official Music Video)",
    artist: "ExampleArtistOfficial",
  }, payload), "https://example.com/right=w1200-h1200");
});

test("accepts visually matching artwork and rejects unrelated replacements", () => {
  const reference = Buffer.from([
    20, 30, 40, 255,
    100, 110, 120, 255,
  ]);
  const matching = Buffer.from([
    22, 29, 43, 255,
    98, 114, 119, 255,
  ]);
  const unrelated = Buffer.from([
    220, 210, 200, 255,
    10, 20, 30, 255,
  ]);
  assert.ok(normalizedArtworkDifference(reference, matching) < maximumArtworkDifference);
  assert.ok(normalizedArtworkDifference(reference, unrelated) > maximumArtworkDifference);
});

test("shows embedded artwork immediately and upgrades it after background resolution", async () => {
  let finishLookup;
  let lookupCount = 0;
  const resolver = createStagedArtworkResolver({
    lookup: () => {
      lookupCount += 1;
      return new Promise((resolve) => { finishLookup = resolve; });
    },
  });
  const playback = {
    status: "playing",
    source: "browser",
    track: {
      title: "Immediate Cover",
      artist: "Needle Test",
      album: "Staged Artwork",
      artwork: "data:image/jpeg;base64,low-resolution-cover",
    },
  };

  const immediate = resolver.resolve(playback);
  assert.equal(immediate.track.artwork, playback.track.artwork);
  assert.equal(immediate.track.artworkReference, playback.track.artwork);
  assert.equal(immediate.track.artworkPending, true);
  assert.equal(lookupCount, 0);

  await Promise.resolve();
  assert.equal(lookupCount, 1);
  assert.equal(resolver.resolve(playback).track.artwork, playback.track.artwork);
  assert.equal(lookupCount, 1);

  finishLookup({ artwork: "https://example.com/high-resolution-cover.jpg", resolution: "catalog-1200" });
  await resolver.waitForIdle();
  const resolved = resolver.resolve(playback);
  assert.equal(resolved.track.artwork, "https://example.com/high-resolution-cover.jpg");
  assert.equal(resolved.track.artworkPending, false);
  assert.equal(lookupCount, 1);
});

test("keeps one sleeve identity while delayed metadata fills in", () => {
  const initialIdentity = liveTrackIdentity("browser", "  Hey There Delilah ");
  const completedIdentity = liveTrackIdentity("browser", "Hey There Delilah");

  assert.equal(initialIdentity, completedIdentity);
  assert.notEqual(initialIdentity, liveTrackIdentity("browser", "Evergreen"));
  assert.ok(transientIdleGracePeriod >= 500);
});

test("holds a new song until its artwork settles but allows the first fallback", () => {
  assert.equal(shouldHoldIncomingTrack(null, "browser:first", true), false);
  assert.equal(shouldHoldIncomingTrack("browser:first", "browser:second", true), true);
  assert.equal(shouldHoldIncomingTrack("browser:first", "browser:first", true), false);
  assert.equal(shouldHoldIncomingTrack("browser:first", "browser:second", false), false);
});

test("tracks volume as circular movement without diagonal jumps", () => {
  assert.equal(shortestAngleDelta(269, -89), 2);

  const initial = createCircularKnobGesture({
    pointerId: 1,
    clientX: 50,
    clientY: 0,
    centerX: 50,
    centerY: 50,
    deadZoneRadius: 12,
    volume: 50,
  });
  const quarterTurn = advanceCircularKnobGesture(initial, 100, 50);
  assert.equal(Math.round(quarterTurn.volume), 83);

  const enteringCenter = advanceCircularKnobGesture(initial, 52, 52);
  assert.equal(enteringCenter.volume, null);
  const leavingAcrossCenter = advanceCircularKnobGesture(enteringCenter.gesture, 50, 100);
  assert.equal(leavingAcrossCenter.volume, null);
  assert.equal(leavingAcrossCenter.gesture.latestVolume, 50);
});
