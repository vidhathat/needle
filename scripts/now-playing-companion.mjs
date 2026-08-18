import { execFile, spawn } from "node:child_process";
import { createServer } from "node:http";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const companionHost = "127.0.0.1";
const companionPort = Number(process.env.NEEDLE_COMPANION_PORT ?? 43117);
const fallbackArtworkCacheDuration = 30_000;
const resolvedArtworkCacheDuration = 6 * 60 * 60_000;
let youtubeMusicConfigurationPromise = null;
const artworkResolutionListeners = new Set();
const browserBundleIdentifiers = [
  "com.apple.safari",
  "com.brave.browser",
  "com.google.chrome",
  "com.microsoft.edgemac",
  "company.thebrowser.browser",
  "org.mozilla.firefox",
];

export function isBrowserPlayer(bundleIdentifier, playerName) {
  const normalizedBundleIdentifier = String(bundleIdentifier ?? "").toLowerCase();
  const normalizedPlayerName = String(playerName ?? "Browser");
  return normalizedPlayerName === "Browser" ||
    browserBundleIdentifiers.some((identifier) =>
      normalizedBundleIdentifier === identifier || normalizedBundleIdentifier.startsWith(`${identifier}.`)
    ) ||
    /arc|brave|chrome|edge|firefox|safari/i.test(normalizedPlayerName);
}

const readNowPlayingScript = String.raw`
function safely(read, fallback) {
  try { return read(); } catch (error) { return fallback; }
}

function readPlayer(configuration) {
  var application;
  try {
    application = Application(configuration.application);
  } catch (error) {
    return null;
  }

  if (!safely(function () { return application.running(); }, false)) return null;

  var state = String(safely(function () { return application.playerState(); }, "stopped")).toLowerCase();
  if (state === "stopped") {
    return { source: configuration.source, player: configuration.application, state: "stopped" };
  }

  var track = application.currentTrack;
  var rawDuration = Number(safely(function () { return track.duration(); }, 0));

  return {
    source: configuration.source,
    player: configuration.application,
    state: state,
    title: String(safely(function () { return track.name(); }, "Unknown track")),
    artist: String(safely(function () { return track.artist(); }, "Unknown artist")),
    album: String(safely(function () { return track.album(); }, "")),
    duration: configuration.durationIsMilliseconds ? rawDuration / 1000 : rawDuration,
    position: Number(safely(function () { return application.playerPosition(); }, 0)),
    volume: Number(safely(function () { return application.soundVolume(); }, 0)),
    artwork: String(safely(function () { return track.artworkUrl(); }, "")),
    itemUrl: String(safely(function () { return track.spotifyUrl(); }, ""))
  };
}

function main() {
  var configurations = [
    { application: "Spotify", source: "spotify", durationIsMilliseconds: true },
    { application: "Music", source: "apple-music", durationIsMilliseconds: false }
  ];
  var idlePlayers = [];
  var pausedPlayers = [];

  for (var index = 0; index < configurations.length; index += 1) {
    var result = readPlayer(configurations[index]);
    if (!result) continue;
    if (result.state === "playing") return result;
    if (result.state === "stopped") idlePlayers.push(result.player);
    else pausedPlayers.push(result);
  }

  if (pausedPlayers.length) return pausedPlayers[0];
  return { state: idlePlayers.length ? "stopped" : "unavailable", players: idlePlayers };
}

JSON.stringify(main());
`;

const setVolumeScript = String.raw`
function run(arguments) {
  var source = arguments[0];
  var requestedVolume = Math.max(0, Math.min(100, Math.round(Number(arguments[1]))));
  var applicationName = source === "spotify" ? "Spotify" : "Music";
  var application = Application(applicationName);

  if (!application.running()) throw new Error(applicationName + " is not running.");
  application.soundVolume = requestedVolume;
  return JSON.stringify({ source: source, volume: requestedVolume });
}
`;

const setPlaybackScript = String.raw`
function run(arguments) {
  var source = arguments[0];
  var shouldPlay = arguments[1] === "play";
  var applicationName = source === "spotify" ? "Spotify" : "Music";
  var application = Application(applicationName);

  if (!application.running()) throw new Error(applicationName + " is not running.");
  if (shouldPlay) application.play();
  else application.pause();
  return JSON.stringify({ source: source, playing: shouldPlay });
}
`;

const systemVolumeScript = "output volume of (get volume settings)";

function mediaRemoteHelperPath() {
  if (process.resourcesPath) {
    return join(process.resourcesPath, "native", "needle_media_remote");
  }
  return fileURLToPath(new URL("../desktop/native/build/Release/needle_media_remote", import.meta.url));
}

function mediaAdapterPaths() {
  const nativeRoot = process.resourcesPath
    ? join(process.resourcesPath, "native")
    : fileURLToPath(new URL("../desktop/native/vendor/mediaremote-adapter", import.meta.url));
  return {
    script: join(nativeRoot, "mediaremote-adapter.pl"),
    framework: join(nativeRoot, "MediaRemoteAdapter.framework"),
  };
}

async function runMediaAdapter(arguments_, timeout = 3500) {
  const paths = mediaAdapterPaths();
  return execFileAsync(
    "/usr/bin/perl",
    [paths.script, paths.framework, ...arguments_],
    { timeout, maxBuffer: 1024 * 1024 * 12 },
  );
}

export function parseMediaRemoteStreamLine(line) {
  try {
    const event = JSON.parse(String(line).trim());
    return event?.type === "data" && event.payload && typeof event.payload === "object"
      ? event.payload
      : null;
  } catch {
    return null;
  }
}

export function startNowPlayingEventStream({
  onChange,
  onError = () => {},
  restartDelay = 2000,
} = {}) {
  let child = null;
  let restartTimer = null;
  let stopped = false;
  let buffer = "";

  const scheduleRestart = () => {
    if (stopped || restartTimer) return;
    restartTimer = setTimeout(() => {
      restartTimer = null;
      launch();
    }, restartDelay);
  };

  const launch = () => {
    if (stopped) return;
    const paths = mediaAdapterPaths();
    buffer = "";
    child = spawn(
      "/usr/bin/perl",
      [paths.script, paths.framework, "stream", "--no-diff", "--debounce=100"],
      { stdio: ["ignore", "pipe", "pipe"] },
    );

    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      buffer += chunk;
      const lines = buffer.split(/\r?\n/);
      buffer = lines.pop() ?? "";
      for (const line of lines) {
        const payload = parseMediaRemoteStreamLine(line);
        if (payload) onChange?.(payload);
      }
    });
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (message) => onError(new Error(message.trim())));
    child.on("error", (error) => {
      onError(error);
      scheduleRestart();
    });
    child.on("exit", (code, signal) => {
      child = null;
      if (!stopped) {
        onError(new Error(`MediaRemote stream exited (${signal || code || "unknown"}).`));
        scheduleRestart();
      }
    });
  };

  launch();
  return {
    stop() {
      stopped = true;
      if (restartTimer) clearTimeout(restartTimer);
      restartTimer = null;
      child?.kill("SIGTERM");
      child = null;
    },
  };
}

export function subscribeToArtworkResolution(listener) {
  artworkResolutionListeners.add(listener);
  return () => artworkResolutionListeners.delete(listener);
}

export function browserPlayerName(bundleIdentifier) {
  const identifier = String(bundleIdentifier ?? "").toLowerCase();
  if (identifier.includes("brave")) return "Brave Browser";
  if (identifier.includes("chrome")) return "Google Chrome";
  if (identifier.includes("edgemac")) return "Microsoft Edge";
  if (identifier.includes("thebrowser")) return "Arc";
  if (identifier.includes("firefox")) return "Firefox";
  if (identifier.includes("safari")) return "Safari";
  return "Browser";
}

function mediaRemoteSource(bundleIdentifier, playerName) {
  const identifier = String(bundleIdentifier ?? "").toLowerCase();
  if (identifier === "com.apple.music") return "apple-music";
  if (identifier.includes("spotify")) return "spotify";
  if (isBrowserPlayer(bundleIdentifier, playerName ?? "")) return "browser";
  return null;
}

export function adapterPayloadToMediaPlayback(media) {
  if (!media?.title) return null;

  const source = mediaRemoteSource(media.bundleIdentifier, media.player);
  if (!source) return null;

  const artworkData = String(media.artworkData ?? "");
  const artwork = artworkData
    ? `data:${String(media.artworkMimeType ?? "image/jpeg")};base64,${artworkData}`
    : String(media.artwork ?? "");
  const status = typeof media.playing === "boolean"
    ? media.playing ? "playing" : "paused"
    : media.status;
  return {
    status,
    source,
    player: source === "browser"
      ? browserPlayerName(media.bundleIdentifier)
      : String(media.player ?? (source === "spotify" ? "Spotify" : "Music")),
    track: {
      title: String(media.title),
      artist: String(media.artist ?? "Unknown artist"),
      album: String(media.album ?? ""),
      duration: Number(media.duration),
      position: Number(media.elapsedTimeNow ?? media.elapsedTime ?? media.position),
      artwork,
    },
  };
}

export function adapterPayloadToBrowserPlayback(media) {
  const playback = adapterPayloadToMediaPlayback(media);
  if (!playback || playback.source !== "browser") return null;
  const { track, ...summary } = playback;
  return { ...summary, ...track };
}

async function readAdapterNowPlaying() {
  try {
    const { stdout } = await runMediaAdapter(["get", "--now"]);
    return adapterPayloadToMediaPlayback(JSON.parse(stdout.trim()));
  } catch {
    return null;
  }
}

async function readMediaRemoteNowPlaying() {
  try {
    let media = await readAdapterNowPlaying();
    if (!media) {
      const { stdout: mediaOutput } = await execFileAsync(
        mediaRemoteHelperPath(),
        [],
        { timeout: 3000, maxBuffer: 1024 * 1024 * 12 },
      );
      media = adapterPayloadToMediaPlayback(JSON.parse(mediaOutput.trim()));
    }
    return media?.status === "playing" || media?.status === "paused" ? media : null;
  } catch {
    return null;
  }
}

async function browserPlaybackWithVolume(media) {
  try {
    if (!media || media.source !== "browser") return null;
    const { stdout: volumeOutput } = await execFileAsync(
      "/usr/bin/osascript",
      ["-e", systemVolumeScript],
      { timeout: 2000, maxBuffer: 1024 * 8 },
    );

    return {
      ...media,
      track: {
        ...media.track,
        album: media.track.album || "Web audio",
        duration: Math.max(1, Number(media.track.duration) || 1),
        position: Math.max(0, Number(media.track.position) || 0),
        volume: Math.max(0, Math.min(100, Number(volumeOutput.trim()) || 0)),
      },
    };
  } catch {
    return null;
  }
}

function isAllowedOrigin(origin) {
  if (!origin) return true;
  try {
    const url = new URL(origin);
    return (url.hostname === "localhost" || url.hostname === "127.0.0.1") &&
      (url.protocol === "http:" || url.protocol === "https:");
  } catch {
    return false;
  }
}

function responseHeaders(origin) {
  return {
    "Access-Control-Allow-Origin": origin || "http://localhost:3000",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Allow-Private-Network": "true",
    "Cache-Control": "no-store",
    "Content-Type": "application/json; charset=utf-8",
    Vary: "Origin",
  };
}

function normalizeTrackText(value) {
  return String(value ?? "")
    .normalize("NFKD")
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
}

const artworkNoiseTokens = new Set([
  "4k",
  "audio",
  "hd",
  "hq",
  "lyric",
  "lyrics",
  "music",
  "official",
  "song",
  "video",
  "visualiser",
  "visualizer",
]);

function artworkTokens(value) {
  return normalizeTrackText(value)
    .split(" ")
    .filter((token) => token && !artworkNoiseTokens.has(token));
}

function tokenCoverage(expected, candidate) {
  const expectedTokens = new Set(artworkTokens(expected));
  const candidateTokens = new Set(artworkTokens(candidate));
  if (!expectedTokens.size) return 1;
  let matches = 0;
  for (const token of expectedTokens) {
    if (candidateTokens.has(token)) matches += 1;
  }
  return matches / expectedTokens.size;
}

function compactTrackText(value) {
  return normalizeTrackText(value).replace(/\s+/g, "");
}

function artworkLookupTrack(track) {
  const artist = String(track.artist ?? "")
    .replace(/\s*(?:[-–—]\s*)?(?:vevo|official|topic)\s*$/i, "")
    .trim();
  let title = String(track.title ?? "")
    .replace(/\s*[[(][^\])]*(?:official|music\s+video|lyrics?|audio|visuali[sz]er|\b4k\b|\bhd\b)[^\])]*[\])]\s*$/i, "")
    .trim();
  const titleParts = title.split(/\s+[-–—]\s+/);
  if (titleParts.length > 1) {
    const titleArtist = titleParts[0];
    if (
      artist &&
      (compactTrackText(artist) === compactTrackText(titleArtist) ||
        tokenCoverage(artist, titleArtist) >= 0.75 ||
        tokenCoverage(titleArtist, artist) >= 0.75)
    ) {
      title = titleParts.slice(1).join(" - ").trim();
    }
  }
  return { ...track, artist: artist || String(track.artist ?? ""), title };
}

function artworkCandidateScore(track, candidate) {
  const lookupTrack = artworkLookupTrack(track);
  const expectedTitle = normalizeTrackText(lookupTrack.title);
  const candidateTitle = normalizeTrackText(candidate.title);
  const titleCoverage = tokenCoverage(lookupTrack.title, candidate.title);
  const reverseTitleCoverage = tokenCoverage(candidate.title, lookupTrack.title);
  if (titleCoverage < 0.6 || reverseTitleCoverage < 0.45) return -1;

  const artistCoverage = !lookupTrack.artist
    ? 1
    : compactTrackText(candidate.artist).includes(compactTrackText(lookupTrack.artist))
      ? 1
      : tokenCoverage(lookupTrack.artist, candidate.artist);
  if (lookupTrack.artist && artistCoverage < 0.5) return -1;

  return (expectedTitle === candidateTitle ? 6 : 0) +
    titleCoverage * 4 +
    reverseTitleCoverage * 2 +
    artistCoverage * 3 +
    (candidate.isSong ? 0.5 : 0);
}

function youtubeMusicItems(payload) {
  const items = [];
  const visit = (value) => {
    if (!value || typeof value !== "object") return;
    const renderer = value.musicResponsiveListItemRenderer;
    if (renderer) {
      const columns = renderer.flexColumns?.map((column) =>
        column.musicResponsiveListItemFlexColumnRenderer?.text?.runs
          ?.map((run) => run.text)
          .join("") ?? "",
      ).filter(Boolean) ?? [];
      const thumbnails = renderer.thumbnail?.musicThumbnailRenderer?.thumbnail?.thumbnails ?? [];
      items.push({
        title: columns[0] ?? "",
        byline: columns.slice(1).join(" "),
        artwork: thumbnails.at(-1)?.url ?? "",
      });
    }
    for (const child of Object.values(value)) visit(child);
  };
  visit(payload);
  return items;
}

function highResolutionYouTubeMusicArtwork(url) {
  return String(url ?? "")
    .replace(/=w\d+-h\d+/, "=w1200-h1200");
}

export function selectYouTubeMusicArtwork(track, payload) {
  const match = youtubeMusicItems(payload)
    .map((item) => ({
      ...item,
      score: artworkCandidateScore(track, {
        title: item.title,
        artist: item.byline,
        isSong: /^song\b/i.test(item.byline),
      }),
    }))
    .filter((item) => item.score >= 0)
    .sort((left, right) => right.score - left.score)[0];
  return highResolutionYouTubeMusicArtwork(match?.artwork);
}

async function youtubeMusicConfiguration() {
  if (!youtubeMusicConfigurationPromise) {
    youtubeMusicConfigurationPromise = (async () => {
      const headers = {
        "Accept-Language": "en-US,en;q=0.9",
        Cookie: "CONSENT=YES+cb.20210328-17-p0.en+FX+667",
        "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/124 Safari/537.36",
      };
      const response = await fetch("https://music.youtube.com/", {
        headers,
        signal: AbortSignal.timeout(2500),
      });
      if (!response.ok) throw new Error(`YouTube Music configuration returned ${response.status}`);
      const html = await response.text();
      const read = (key) => html.match(new RegExp(`"${key}":"([^"]+)"`))?.[1] ?? "";
      const key = read("INNERTUBE_API_KEY");
      const clientVersion = read("INNERTUBE_CLIENT_VERSION");
      const visitorData = read("VISITOR_DATA");
      if (!key || !clientVersion) throw new Error("YouTube Music configuration was incomplete");
      return { headers, key, clientVersion, visitorData };
    })().catch((error) => {
      youtubeMusicConfigurationPromise = null;
      throw error;
    });
  }
  return youtubeMusicConfigurationPromise;
}

export async function lookupYouTubeMusicArtwork(track) {
  const lookupTrack = artworkLookupTrack(track);
  const configuration = await youtubeMusicConfiguration();
  const endpoint = new URL("https://music.youtube.com/youtubei/v1/search");
  endpoint.searchParams.set("key", configuration.key);
  const response = await fetch(endpoint, {
    method: "POST",
    headers: {
      ...configuration.headers,
      "Content-Type": "application/json",
      "X-Youtube-Client-Name": "67",
      "X-Youtube-Client-Version": configuration.clientVersion,
    },
    body: JSON.stringify({
      context: {
        client: {
          clientName: "WEB_REMIX",
          clientVersion: configuration.clientVersion,
          gl: "US",
          hl: "en",
          visitorData: configuration.visitorData,
        },
      },
      query: `${lookupTrack.artist} ${lookupTrack.title}`,
    }),
    signal: AbortSignal.timeout(3000),
  });
  if (!response.ok) return "";
  return selectYouTubeMusicArtwork(track, await response.json());
}

export function selectCatalogArtwork(track, results) {
  const match = (results ?? [])
    .map((item) => ({
      ...item,
      score: artworkCandidateScore(track, {
        title: item.trackName,
        artist: item.artistName,
        isSong: true,
      }),
    }))
    .filter((item) => item.score >= 0)
    .sort((left, right) => right.score - left.score)[0];

  return String(match?.artworkUrl100 ?? "")
    .replace(/\d+x\d+bb/, "1200x1200bb");
}

async function lookupArtworkCandidate(track) {
  let artwork = "";
  let resolution = "embedded-fallback";
  if (track.source === "browser") {
    try {
      artwork = await lookupYouTubeMusicArtwork(track);
      if (artwork) resolution = "youtube-music-1200";
    } catch {
      artwork = "";
    }
  }

  if (!artwork) {
    try {
    const endpoint = new URL("https://itunes.apple.com/search");
    endpoint.searchParams.set("term", `${track.artist} ${track.title}`);
    endpoint.searchParams.set("entity", "song");
    endpoint.searchParams.set("limit", "5");
    const response = await fetch(endpoint, { signal: AbortSignal.timeout(2500) });
    if (response.ok) {
      const payload = await response.json();
      artwork = selectCatalogArtwork(track, payload.results);
      if (artwork) resolution = "catalog-1200";
    }
    } catch {
      artwork = "";
    }
  }

  if (!artwork && track.source === "spotify" && track.itemUrl) {
    try {
      const spotifyEndpoint = new URL("https://open.spotify.com/oembed");
      spotifyEndpoint.searchParams.set("url", track.itemUrl);
      const spotifyResponse = await fetch(spotifyEndpoint, { signal: AbortSignal.timeout(2500) });
      if (spotifyResponse.ok) {
        artwork = String((await spotifyResponse.json()).thumbnail_url ?? "");
        if (artwork) resolution = "spotify-oembed";
      }
    } catch {
      artwork = "";
    }
  }

  if (!artwork) artwork = String(track.artwork ?? "");
  return { artwork, resolution };
}

export function createStagedArtworkResolver({
  lookup,
  fallbackDuration = fallbackArtworkCacheDuration,
  resolvedDuration = resolvedArtworkCacheDuration,
  now = Date.now,
  onResolved = () => {},
}) {
  const cache = new Map();
  const inFlight = new Map();

  const beginLookup = (cacheKey, track, artworkReference) => {
    if (inFlight.has(cacheKey)) return;

    const request = Promise.resolve()
      .then(() => lookup(track))
      .catch(() => ({ artwork: artworkReference, resolution: "embedded-fallback" }))
      .then((result) => {
        const resolution = result?.resolution || "embedded-fallback";
        const artwork = String(result?.artwork || artworkReference);
        cache.set(cacheKey, {
          artwork,
          expiresAt: now() + (resolution === "embedded-fallback" ? fallbackDuration : resolvedDuration),
        });
        onResolved({ track, artwork, resolution });
      })
      .finally(() => inFlight.delete(cacheKey));
    inFlight.set(cacheKey, request);
  };

  return {
    resolve(playback) {
      if (!playback?.track) return playback;

      const artworkReference = String(playback.track.artwork ?? "");
      const { itemUrl, ...publicTrack } = playback.track;
      const lookupTrack = { ...playback.track, itemUrl, source: playback.source };
      const cacheKey = `${lookupTrack.artist}\u0000${lookupTrack.album}\u0000${lookupTrack.title}`;
      const cached = cache.get(cacheKey);
      const validCachedArtwork = cached && cached.expiresAt > now() ? cached.artwork : "";
      if (!validCachedArtwork) beginLookup(cacheKey, lookupTrack, artworkReference);

      return {
        ...playback,
        track: {
          ...publicTrack,
          artwork: validCachedArtwork || artworkReference,
          artworkReference,
          artworkPending: !validCachedArtwork,
        },
      };
    },
    async waitForIdle() {
      await Promise.allSettled([...inFlight.values()]);
    },
  };
}

const artworkResolver = createStagedArtworkResolver({
  lookup: lookupArtworkCandidate,
  onResolved: ({ track, artwork, resolution }) => {
    console.info("[needle:artwork] resolved", {
      artist: track.artist,
      title: track.title,
      resolution,
    });
    for (const listener of artworkResolutionListeners) {
      try {
        listener({ track, artwork, resolution });
      } catch (error) {
        console.error("[needle:artwork] resolution listener failed", error);
      }
    }
  },
});

function resolvePlaybackArtwork(playback) {
  return artworkResolver.resolve(playback);
}

export async function readNowPlaying(controllerName = "Terminal") {
  try {
    const [mediaPlayback, { stdout }] = await Promise.all([
      readMediaRemoteNowPlaying(),
      execFileAsync(
        "/usr/bin/osascript",
        ["-l", "JavaScript", "-e", readNowPlayingScript],
        { timeout: 4000, maxBuffer: 1024 * 128 },
      ),
    ]);
    const result = JSON.parse(stdout.trim());
    const browserPlayback = await browserPlaybackWithVolume(mediaPlayback);
    if (browserPlayback?.status === "playing") return resolvePlaybackArtwork(browserPlayback);
    if (result.state !== "playing" && browserPlayback) return resolvePlaybackArtwork(browserPlayback);

    if (result.state === "unavailable") {
      return {
        status: "idle",
        reason: "no-player",
        message: "Play something in a browser, Spotify, or Apple Music.",
      };
    }

    if (result.state === "stopped") {
      return {
        status: "idle",
        reason: "stopped",
        message: `${result.players.join(" or ")} is ready. Play a track to bring it into Needle.`,
      };
    }

    const mediaArtwork = mediaPlayback?.source === result.source &&
      compactTrackText(mediaPlayback.track.title) === compactTrackText(result.title)
      ? mediaPlayback.track.artwork
      : "";
    return resolvePlaybackArtwork({
      status: result.state === "playing" ? "playing" : "paused",
      source: result.source,
      player: result.player,
      track: {
        title: result.title,
        artist: result.artist,
        album: result.album || "Single",
        duration: Math.max(1, Number(result.duration) || 1),
        position: Math.max(0, Number(result.position) || 0),
        volume: Math.max(0, Math.min(100, Number(result.volume) || 0)),
        artwork: String(mediaArtwork || result.artwork || ""),
        itemUrl: String(result.itemUrl ?? ""),
      },
    });
  } catch (error) {
    const details = `${error?.stderr ?? ""} ${error?.message ?? ""}`;
    const permissionDenied = details.includes("-1743") || details.toLowerCase().includes("not authorized");
    return {
      status: "error",
      reason: permissionDenied ? "permission" : "bridge",
      message: permissionDenied
        ? `Allow ${controllerName} to control your music app in System Settings → Privacy & Security → Automation.`
        : `${controllerName} could not read the local music player.`,
    };
  }
}

export async function setPlayerVolume(source, requestedVolume) {
  if (source !== "spotify" && source !== "apple-music" && source !== "browser" && source !== "youtube-music") {
    throw new Error("Unsupported player source.");
  }

  const volume = Number(requestedVolume);
  if (!Number.isFinite(volume) || volume < 0 || volume > 100) {
    throw new Error("Volume must be between 0 and 100.");
  }

  if (source === "browser" || source === "youtube-music") {
    const outputVolume = Math.round(volume);
    await execFileAsync(
      "/usr/bin/osascript",
      ["-e", `set volume output volume ${outputVolume}`],
      { timeout: 2500, maxBuffer: 1024 * 8 },
    );
    return { source, volume: outputVolume };
  }

  const { stdout } = await execFileAsync(
    "/usr/bin/osascript",
    ["-l", "JavaScript", "-e", setVolumeScript, source, String(volume)],
    { timeout: 2500, maxBuffer: 1024 * 32 },
  );
  return JSON.parse(stdout.trim());
}

export async function setPlayerPlayback(source, requestedPlaying) {
  if (source !== "spotify" && source !== "apple-music" && source !== "browser" && source !== "youtube-music") {
    throw new Error("Unsupported player source.");
  }

  if (typeof requestedPlaying !== "boolean") {
    throw new Error("Playback state must be a boolean.");
  }

  const command = requestedPlaying ? "play" : "pause";
  if (source === "browser" || source === "youtube-music") {
    try {
      await runMediaAdapter(["send", requestedPlaying ? "0" : "1"], 3000);
    } catch {
      const { stdout } = await execFileAsync(
        mediaRemoteHelperPath(),
        [command],
        { timeout: 2500, maxBuffer: 1024 * 32 },
      );
      const result = JSON.parse(stdout.trim());
      if (result.status !== "ok") throw new Error("Could not change browser playback.");
    }
    return { source, playing: requestedPlaying };
  }

  const { stdout } = await execFileAsync(
    "/usr/bin/osascript",
    ["-l", "JavaScript", "-e", setPlaybackScript, source, command],
    { timeout: 2500, maxBuffer: 1024 * 32 },
  );
  return JSON.parse(stdout.trim());
}

async function readJsonBody(request) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > 4096) throw new Error("Request body is too large.");
    chunks.push(chunk);
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

export function startCompanionServer() {
  const server = createServer(async (request, response) => {
    const origin = request.headers.origin ?? "";
    const headers = responseHeaders(origin);

    if (!isAllowedOrigin(origin)) {
      response.writeHead(403, headers);
      response.end(JSON.stringify({ status: "error", reason: "origin", message: "Origin not allowed." }));
      return;
    }

    if (request.method === "OPTIONS") {
      response.writeHead(204, headers);
      response.end();
      return;
    }

    const requestUrl = new URL(request.url ?? "/", `http://${companionHost}:${companionPort}`);
    if (request.method === "GET" && requestUrl.pathname === "/health") {
      response.writeHead(200, headers);
      response.end(JSON.stringify({ status: "ok", name: "Needle Now Playing Companion" }));
      return;
    }

    if (request.method === "GET" && requestUrl.pathname === "/now-playing") {
      const payload = await readNowPlaying();
      response.writeHead(200, headers);
      response.end(JSON.stringify(payload));
      return;
    }

    if (request.method === "POST" && requestUrl.pathname === "/volume") {
      try {
        const body = await readJsonBody(request);
        const payload = await setPlayerVolume(body.source, body.volume);
        response.writeHead(200, headers);
        response.end(JSON.stringify({ status: "ok", ...payload }));
      } catch (error) {
        response.writeHead(400, headers);
        response.end(JSON.stringify({
          status: "error",
          reason: "volume",
          message: error?.message ?? "Could not change player volume.",
        }));
      }
      return;
    }

    if (request.method === "POST" && requestUrl.pathname === "/playback") {
      try {
        const body = await readJsonBody(request);
        const payload = await setPlayerPlayback(body.source, body.playing);
        response.writeHead(200, headers);
        response.end(JSON.stringify({ status: "ok", ...payload }));
      } catch (error) {
        response.writeHead(400, headers);
        response.end(JSON.stringify({
          status: "error",
          reason: "playback",
          message: error?.message ?? "Could not change player playback.",
        }));
      }
      return;
    }

    response.writeHead(404, headers);
    response.end(JSON.stringify({ status: "error", reason: "not-found", message: "Not found." }));
  });

  server.listen(companionPort, companionHost, () => {
    console.log(`Needle companion listening on http://${companionHost}:${companionPort}`);
    console.log("Play something in a browser, Spotify, or Apple Music. Press Ctrl+C to stop.");
  });

  return server;
}

const isDirectRun = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isDirectRun) {
  const server = startCompanionServer();
  const shutdown = () => server.close(() => process.exit(0));
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}
