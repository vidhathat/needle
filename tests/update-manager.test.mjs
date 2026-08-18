import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";
import { createUpdateManager, localUpdateFeedOverride } from "../desktop/update-manager.mjs";

function flushEvents() {
  return new Promise((resolve) => setImmediate(resolve));
}

function createHarness({ responses = [], enabled = true, autoAccept = false } = {}) {
  const updater = new EventEmitter();
  const messages = [];
  const timers = [];
  let downloadCount = 0;
  let installCount = 0;

  updater.checkForUpdates = async () => {};
  updater.downloadUpdate = async () => { downloadCount += 1; };
  updater.quitAndInstall = () => { installCount += 1; };

  const manager = createUpdateManager({
    updater,
    dialog: {
      async showMessageBox(...args) {
        messages.push(args.at(-1));
        return { response: responses.shift() ?? 0 };
      },
    },
    appVersion: "0.2.0",
    getWindow: () => null,
    enabled,
    autoAccept,
    logger: { error() {} },
    setTimeoutFn(callback) {
      timers.push(callback);
      return timers.length;
    },
    clearTimeoutFn() {},
    setIntervalFn(callback) {
      timers.push(callback);
      return timers.length;
    },
    clearIntervalFn() {},
  });

  return {
    manager,
    messages,
    timers,
    updater,
    downloadCount: () => downloadCount,
    installCount: () => installCount,
  };
}

test("does not start update checks in unsupported development builds", () => {
  const harness = createHarness({ enabled: false });

  assert.equal(harness.manager.start(), false);
  assert.equal(harness.timers.length, 0);
});

test("allows update feed overrides only from the local machine", () => {
  assert.equal(
    localUpdateFeedOverride("http://127.0.0.1:43119/updates/mac/"),
    "http://127.0.0.1:43119/updates/mac",
  );
  assert.throws(
    () => localUpdateFeedOverride("https://example.com/updates/mac"),
    /must use http:\/\/localhost/,
  );
});

test("schedules automatic update checks for packaged builds", () => {
  const harness = createHarness();

  assert.equal(harness.manager.start(), true);
  assert.equal(harness.timers.length, 2);
  assert.equal(harness.manager.start(), false);
});

test("reports an up-to-date app after a manual check", async () => {
  const harness = createHarness();
  harness.updater.checkForUpdates = async () => {
    harness.updater.emit("update-not-available", { version: "0.2.0" });
  };
  harness.manager.start();

  await harness.manager.check(true);
  await flushEvents();

  assert.equal(harness.messages.length, 1);
  assert.equal(harness.messages[0].title, "Needle Is Up to Date");
  assert.match(harness.messages[0].message, /0\.2\.0/);
});

test("downloads an accepted update and restarts to install it", async () => {
  const harness = createHarness({ responses: [1, 1] });
  harness.updater.downloadUpdate = async () => {
    harness.updater.emit("update-downloaded", { version: "0.2.1" });
  };
  harness.manager.start();

  harness.updater.emit("update-available", { version: "0.2.1" });
  await flushEvents();
  await flushEvents();

  assert.equal(harness.messages[0].title, "Needle Update Available");
  assert.equal(harness.messages[1].title, "Needle Is Ready to Update");
  assert.equal(harness.installCount(), 1);
});

test("can complete a localhost integration test without prompts", async () => {
  const harness = createHarness({ autoAccept: true });
  harness.updater.downloadUpdate = async () => {
    harness.updater.emit("update-downloaded", { version: "0.2.1" });
  };
  harness.manager.start();

  harness.updater.emit("update-available", { version: "0.2.1" });
  await flushEvents();
  await flushEvents();

  assert.equal(harness.messages.length, 0);
  assert.equal(harness.installCount(), 1);
});
