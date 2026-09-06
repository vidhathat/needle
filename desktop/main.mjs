import { createHash } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createRequire } from "node:module";
import {
  app,
  BrowserWindow,
  dialog,
  ipcMain,
  Menu,
  nativeImage,
  powerMonitor,
  screen,
  shell,
} from "electron";
import electronUpdater from "electron-updater";
import {
  readNowPlaying,
  setPlayerPlayback,
  setPlayerVolume,
  startNowPlayingEventStream,
  subscribeToArtworkResolution,
} from "../scripts/now-playing-companion.mjs";
import { startAppServer } from "./app-server.mjs";
import {
  maximumArtworkDifference,
  normalizedArtworkDifference,
} from "./artwork-validation.mjs";
import { createUpdateManager, localUpdateFeedOverride } from "./update-manager.mjs";

const { autoUpdater } = electronUpdater;

const isMac = process.platform === "darwin";
const wallpaperWindows = new Map();
let mainWindow = null;
let appServer = null;
let appUrl = process.env.NEEDLE_WEB_URL ?? "";
let isQuitting = false;
let keepWallpaperRunningAfterClose = false;
let wallpaperEnabled = true;
let nowPlayingPromise = null;
let lastNowPlaying = null;
let lastNowPlayingAt = 0;
let desktopLevelBridge = null;
let nowPlayingEventStream = null;
let unsubscribeArtworkResolution = null;
let updateManager = null;
const artworkValidationCache = new Map();

const require = createRequire(import.meta.url);

app.setName("Needle");

function preferencesPath() {
  return join(app.getPath("userData"), "preferences.json");
}

async function loadPreferences() {
  try {
    const preferences = JSON.parse(await readFile(preferencesPath(), "utf8"));
    keepWallpaperRunningAfterClose = preferences.keepWallpaperRunningAfterClose === true;
    wallpaperEnabled = preferences.wallpaperEnabled !== false;
  } catch (error) {
    if (error?.code !== "ENOENT") console.error("Needle could not read its preferences:", error);
  }
}

async function savePreferences() {
  const directory = app.getPath("userData");
  const destination = preferencesPath();
  const temporary = join(directory, "preferences.tmp");
  await mkdir(directory, { recursive: true });
  await writeFile(temporary, JSON.stringify({ keepWallpaperRunningAfterClose, wallpaperEnabled }, null, 2), "utf8");
  await rename(temporary, destination);
}

async function setKeepWallpaperRunningAfterClose(enabled) {
  keepWallpaperRunningAfterClose = Boolean(enabled && isMac);
  try {
    await savePreferences();
  } catch (error) {
    console.error("Needle could not save its preferences:", error);
  }
  installMenu();
}

async function setWallpaperEnabled(enabled) {
  wallpaperEnabled = Boolean(enabled && isMac);
  try {
    await savePreferences();
  } catch (error) {
    console.error("Needle could not save its preferences:", error);
  }
  installMenu();
  await syncWallpaperWindows();
}

function applyWallpaperLevel(window) {
  try {
    if (!desktopLevelBridge) {
      const modulePath = app.isPackaged
        ? join(process.resourcesPath, "native", "needle_desktop_level.node")
        : join(app.getAppPath(), "desktop", "native", "build", "Release", "needle_desktop_level.node");
      desktopLevelBridge = require(modulePath);
    }
    desktopLevelBridge.setDesktopLevel(window.getNativeWindowHandle());
  } catch (error) {
    console.error("Needle could not set the macOS desktop window level:", error);
  }
}

function pageUrl(mode, displayId) {
  const url = new URL("/player", appUrl);
  url.searchParams.set("mode", mode);
  if (displayId !== undefined) url.searchParams.set("display", String(displayId));
  return url.href;
}

function configureNavigation(window) {
  window.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith("https://") || url.startsWith("http://")) void shell.openExternal(url);
    return { action: "deny" };
  });
  window.webContents.on("will-navigate", (event, url) => {
    if (!url.startsWith(appUrl)) {
      event.preventDefault();
      if (url.startsWith("https://") || url.startsWith("http://")) void shell.openExternal(url);
    }
  });
}

function installMenu() {
  Menu.setApplicationMenu(Menu.buildFromTemplate([
    ...(isMac ? [{
      label: "Needle",
      submenu: [
        { role: "about" },
        { type: "separator" },
        {
          label: "Check for Updates…",
          enabled: app.isPackaged,
          click: () => { void updateManager?.check(true); },
        },
        { type: "separator" },
        {
          label: "Enable Wallpaper",
          type: "checkbox",
          checked: wallpaperEnabled,
          click: (item) => { void setWallpaperEnabled(item.checked); },
        },
        {
          label: "Set as Default Wallpaper",
          type: "checkbox",
          checked: keepWallpaperRunningAfterClose,
          click: (item) => { void setKeepWallpaperRunningAfterClose(item.checked); },
        },
        { type: "separator" },
        { role: "hide" },
        { role: "hideOthers" },
        { role: "unhide" },
        { type: "separator" },
        { role: "quit" },
      ],
    }] : []),
    { label: "Edit", submenu: [{ role: "undo" }, { role: "redo" }, { type: "separator" }, { role: "cut" }, { role: "copy" }, { role: "paste" }, { role: "selectAll" }] },
    { label: "View", submenu: [{ role: "reload" }, { role: "togglefullscreen" }] },
    { label: "Window", submenu: [{ role: "minimize" }, { role: "zoom" }, ...(isMac ? [{ type: "separator" }, { role: "front" }] : [{ role: "close" }])] },
  ]));
}

async function createControlWindow() {
  if (mainWindow) {
    if (isMac) app.dock.show();
    mainWindow.show();
    mainWindow.focus();
    return;
  }

  if (isMac) app.dock.show();
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 860,
    minWidth: 920,
    minHeight: 680,
    show: true,
    title: "Needle",
    titleBarStyle: isMac ? "hiddenInset" : "default",
    trafficLightPosition: isMac ? { x: 20, y: 18 } : undefined,
    backgroundColor: "#9a562e",
    webPreferences: {
      preload: join(import.meta.dirname, "preload.cjs"),
      additionalArguments: ["--needle-mode=controls"],
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  configureNavigation(mainWindow);
  mainWindow.on("closed", () => {
    mainWindow = null;
    if (!isQuitting && (!keepWallpaperRunningAfterClose || !wallpaperEnabled)) app.quit();
  });
  await mainWindow.loadURL(pageUrl("controls"));
}

async function createWallpaperWindow(display) {
  const window = new BrowserWindow({
    ...display.bounds,
    type: "desktop",
    frame: false,
    show: false,
    resizable: false,
    movable: false,
    minimizable: false,
    maximizable: false,
    closable: false,
    focusable: false,
    fullscreenable: false,
    enableLargerThanScreen: true,
    hasShadow: false,
    roundedCorners: false,
    skipTaskbar: true,
    backgroundColor: "#9a562e",
    webPreferences: {
      preload: join(import.meta.dirname, "preload.cjs"),
      additionalArguments: ["--needle-mode=wallpaper"],
      backgroundThrottling: false,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  wallpaperWindows.set(display.id, window);
  configureNavigation(window);
  window.setIgnoreMouseEvents(true);
  window.setHiddenInMissionControl(true);
  window.setVisibleOnAllWorkspaces(true, { skipTransformProcessType: true });
  window.on("closed", () => wallpaperWindows.delete(display.id));
  await window.loadURL(pageUrl("wallpaper", display.id));
  window.showInactive();
  applyWallpaperLevel(window);
  setTimeout(() => {
    if (!window.isDestroyed()) applyWallpaperLevel(window);
  }, 150);
}

async function syncWallpaperWindows() {
  if (!wallpaperEnabled) {
    destroyWallpaperWindows();
    return;
  }

  const displays = screen.getAllDisplays();
  const activeDisplayIds = new Set(displays.map((display) => display.id));

  for (const [displayId, window] of wallpaperWindows) {
    if (!activeDisplayIds.has(displayId)) window.destroy();
  }

  await Promise.all(displays.map(async (display) => {
    const existingWindow = wallpaperWindows.get(display.id);
    if (existingWindow && !existingWindow.isDestroyed()) {
      existingWindow.setBounds(display.bounds);
      if (!existingWindow.isVisible()) {
        existingWindow.showInactive();
        applyWallpaperLevel(existingWindow);
      }
      return;
    }
    await createWallpaperWindow(display);
  }));
}

function destroyWallpaperWindows() {
  wallpaperWindows.forEach((window) => {
    if (!window.isDestroyed()) window.destroy();
  });
  wallpaperWindows.clear();
}

function artworkBitmap(image) {
  return image.resize({ width: 32, height: 32, quality: "good" }).toBitmap();
}

function artworkValidationUrl(candidate) {
  return candidate
    .replace(/=w\d+-h\d+/, "=w120-h120")
    .replace(/\d+x\d+bb/, "100x100bb");
}

async function validateResolvedArtwork(result) {
  if (!result?.track) return result;
  const { artworkReference, ...track } = result.track;
  const candidate = String(track.artwork ?? "");
  const reference = String(artworkReference ?? "");
  if (!candidate.startsWith("http") || !reference.startsWith("data:image/")) {
    return { ...result, track };
  }

  const referenceHash = createHash("sha256").update(reference).digest("hex");
  const cacheKey = `${referenceHash}\u0000${candidate}`;
  const cached = artworkValidationCache.get(cacheKey);
  if (cached && cached.expiresAt > Date.now()) {
    return { ...result, track: { ...track, artwork: cached.matches ? candidate : reference } };
  }

  let matches = false;
  let difference = 1;
  try {
    const response = await fetch(artworkValidationUrl(candidate), {
      signal: AbortSignal.timeout(3000),
    });
    if (response.ok) {
      const referenceImage = nativeImage.createFromDataURL(reference);
      const candidateImage = nativeImage.createFromBuffer(Buffer.from(await response.arrayBuffer()));
      if (!referenceImage.isEmpty() && !candidateImage.isEmpty()) {
        difference = normalizedArtworkDifference(
          artworkBitmap(referenceImage),
          artworkBitmap(candidateImage),
        );
        matches = difference <= maximumArtworkDifference;
      }
    }
  } catch {
    matches = false;
  }

  artworkValidationCache.set(cacheKey, {
    matches,
    expiresAt: matches ? Number.POSITIVE_INFINITY : Date.now() + 60_000,
  });
  console.info("[needle:artwork] visual validation", {
    difference: Number(difference.toFixed(4)),
    result: matches ? "accepted" : "rejected",
  });
  return { ...result, track: { ...track, artwork: matches ? candidate : reference } };
}

async function getNowPlayingCached(force = false) {
  const now = Date.now();
  if (!force && lastNowPlaying && now - lastNowPlayingAt < 750) return lastNowPlaying;
  if (nowPlayingPromise) return nowPlayingPromise;

  nowPlayingPromise = readNowPlaying("Needle")
    .then(validateResolvedArtwork)
    .then(async (result) => {
      lastNowPlaying = result;
      lastNowPlayingAt = Date.now();
      return result;
    })
    .finally(() => { nowPlayingPromise = null; });
  return nowPlayingPromise;
}

function broadcastNowPlaying(result) {
  const windows = [mainWindow, ...wallpaperWindows.values()];
  for (const window of windows) {
    if (window && !window.isDestroyed()) {
      window.webContents.send("needle:now-playing", result);
    }
  }
}

function restartNowPlayingEventStream() {
  nowPlayingEventStream?.stop();
  nowPlayingEventStream = startNowPlayingEventStream({
    onChange: () => { void refreshAndBroadcastNowPlaying(); },
    onError: (error) => console.error("Needle MediaRemote stream:", error.message),
  });
}

async function refreshAndBroadcastNowPlaying() {
  try {
    const result = await getNowPlayingCached(true);
    broadcastNowPlaying(result);
  } catch (error) {
    console.error("Needle could not refresh now playing:", error);
  }
}

async function refreshAfterArtworkResolution() {
  const activeRead = nowPlayingPromise;
  if (activeRead) {
    try {
      await activeRead;
    } catch {
      // The follow-up read below can recover from an initial read failure.
    }
  }
  await refreshAndBroadcastNowPlaying();
}

ipcMain.handle("needle:get-now-playing", () => getNowPlayingCached());
ipcMain.handle("needle:set-volume", (_event, payload) => setPlayerVolume(payload?.source, payload?.volume));
ipcMain.handle("needle:set-playback", (_event, payload) => setPlayerPlayback(payload?.source, payload?.playing));

app.whenReady().then(async () => {
  if (!appUrl) {
    const distRoot = join(process.resourcesPath, "needle-dist");
    const runningServer = await startAppServer(distRoot);
    appServer = runningServer.server;
    appUrl = runningServer.url;
  }

  const updateFeedOverride = app.isPackaged
    ? localUpdateFeedOverride(process.env.NEEDLE_UPDATE_TEST_URL)
    : null;
  if (app.isPackaged && updateFeedOverride) {
    autoUpdater.setFeedURL({ provider: "generic", url: updateFeedOverride });
    console.info(`Needle is using the local update feed at ${updateFeedOverride}.`);
  }

  updateManager = createUpdateManager({
    updater: autoUpdater,
    dialog,
    appVersion: app.getVersion(),
    getWindow: () => mainWindow,
    enabled: isMac && app.isPackaged,
    autoAccept: Boolean(
      updateFeedOverride && process.env.NEEDLE_UPDATE_TEST_AUTO_ACCEPT === "1"
    ),
  });
  await loadPreferences();
  installMenu();
  restartNowPlayingEventStream();
  unsubscribeArtworkResolution = subscribeToArtworkResolution(() => {
    void refreshAfterArtworkResolution();
  });
  if (isMac) {
    await syncWallpaperWindows();
    screen.on("display-added", () => { void syncWallpaperWindows(); });
    screen.on("display-removed", () => { void syncWallpaperWindows(); });
    screen.on("display-metrics-changed", () => { void syncWallpaperWindows(); });
  }
  await createControlWindow();
  updateManager.start();

  powerMonitor.on("resume", () => {
    restartNowPlayingEventStream();
    void refreshAndBroadcastNowPlaying();
  });
  powerMonitor.on("unlock-screen", () => { void refreshAndBroadcastNowPlaying(); });
  app.on("activate", () => { void createControlWindow(); });
}).catch((error) => {
  console.error("Needle failed to launch:", error);
  app.quit();
});

app.on("window-all-closed", () => {
  if (!isMac || !keepWallpaperRunningAfterClose || !wallpaperEnabled) app.quit();
});

app.on("before-quit", () => {
  isQuitting = true;
  updateManager?.stop();
  nowPlayingEventStream?.stop();
  unsubscribeArtworkResolution?.();
  destroyWallpaperWindows();
  appServer?.close();
});
