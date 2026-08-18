const defaultStartupDelayMs = 12_000;
const defaultCheckIntervalMs = 6 * 60 * 60 * 1000;

export function localUpdateFeedOverride(value) {
  if (!value) return null;

  const url = new URL(value);
  if (url.protocol !== "http:" || !["127.0.0.1", "localhost"].includes(url.hostname)) {
    throw new Error("NEEDLE_UPDATE_TEST_URL must use http://localhost or http://127.0.0.1");
  }

  return url.href.replace(/\/$/, "");
}

export function createUpdateManager({
  updater,
  dialog,
  appVersion,
  getWindow = () => null,
  enabled = true,
  autoAccept = false,
  logger = console,
  startupDelayMs = defaultStartupDelayMs,
  checkIntervalMs = defaultCheckIntervalMs,
  setTimeoutFn = setTimeout,
  clearTimeoutFn = clearTimeout,
  setIntervalFn = setInterval,
  clearIntervalFn = clearInterval,
}) {
  let started = false;
  let checking = false;
  let manualCheck = false;
  let downloadRequested = false;
  let startupTimer = null;
  let intervalTimer = null;
  const dismissedVersions = new Set();

  function showMessage(options) {
    const window = getWindow();
    if (window && !window.isDestroyed()) return dialog.showMessageBox(window, options);
    return dialog.showMessageBox(options);
  }

  async function check(userInitiated = false) {
    if (!enabled || checking) return false;

    checking = true;
    manualCheck = userInitiated;
    try {
      await updater.checkForUpdates();
      return true;
    } catch (error) {
      const shouldNotify = manualCheck;
      manualCheck = false;
      logger.error("Needle could not check for updates:", error);
      if (shouldNotify) {
        await showMessage({
          type: "error",
          title: "Unable to Check for Updates",
          message: "Needle couldn’t check for updates right now.",
          detail: "Check your internet connection and try again.",
          buttons: ["OK"],
        });
      }
      return false;
    } finally {
      checking = false;
    }
  }

  async function handleUpdateAvailable(info) {
    const version = String(info?.version || "a newer version");
    logger.info?.(`Needle update ${version} is available.`);
    const wasManual = manualCheck;
    manualCheck = false;
    if (downloadRequested || (dismissedVersions.has(version) && !wasManual)) return;

    const response = autoAccept
      ? 1
      : (await showMessage({
          type: "info",
          title: "Needle Update Available",
          message: `Needle ${version} is available.`,
          detail: "Download it now and keep listening while Needle prepares the update.",
          buttons: ["Later", "Download Update"],
          defaultId: 1,
          cancelId: 0,
          noLink: true,
        })).response;

    if (response === 1) {
      downloadRequested = true;
      try {
        await updater.downloadUpdate();
      } catch (error) {
        downloadRequested = false;
        logger.error("Needle could not download the update:", error);
        await showMessage({
          type: "error",
          title: "Update Download Failed",
          message: "Needle couldn’t download the update.",
          detail: "Please try again later.",
          buttons: ["OK"],
        });
      }
      return;
    }

    dismissedVersions.add(version);
  }

  async function handleUpdateDownloaded(info) {
    const version = String(info?.version || "the latest version");
    logger.info?.(`Needle update ${version} finished downloading.`);
    const response = autoAccept
      ? 1
      : (await showMessage({
          type: "info",
          title: "Needle Is Ready to Update",
          message: `Needle ${version} has been downloaded.`,
          detail: "Restart Needle to finish installing the update.",
          buttons: ["Later", "Restart and Update"],
          defaultId: 1,
          cancelId: 0,
          noLink: true,
        })).response;

    if (response === 1) updater.quitAndInstall(false, true);
  }

  async function handleUpdateNotAvailable() {
    if (!manualCheck) return;
    manualCheck = false;
    await showMessage({
      type: "info",
      title: "Needle Is Up to Date",
      message: `Needle ${appVersion} is the latest version.`,
      buttons: ["OK"],
    });
  }

  function handleError(error) {
    logger.error("Needle updater error:", error);
  }

  function start() {
    if (!enabled || started) return false;
    started = true;
    updater.autoDownload = false;
    updater.autoInstallOnAppQuit = true;
    updater.on("update-available", handleUpdateAvailable);
    updater.on("update-not-available", handleUpdateNotAvailable);
    updater.on("update-downloaded", handleUpdateDownloaded);
    updater.on("error", handleError);
    startupTimer = setTimeoutFn(() => { void check(false); }, startupDelayMs);
    intervalTimer = setIntervalFn(() => { void check(false); }, checkIntervalMs);
    return true;
  }

  function stop() {
    if (!started) return;
    started = false;
    if (startupTimer !== null) clearTimeoutFn(startupTimer);
    if (intervalTimer !== null) clearIntervalFn(intervalTimer);
    startupTimer = null;
    intervalTimer = null;
    updater.removeListener("update-available", handleUpdateAvailable);
    updater.removeListener("update-not-available", handleUpdateNotAvailable);
    updater.removeListener("update-downloaded", handleUpdateDownloaded);
    updater.removeListener("error", handleError);
  }

  return { check, start, stop };
}
