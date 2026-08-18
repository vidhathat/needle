/* eslint-disable @typescript-eslint/no-require-imports */
const { contextBridge, ipcRenderer } = require("electron");

const modeArgument = process.argv.find((argument) => argument.startsWith("--needle-mode="));
const mode = modeArgument?.split("=")[1] === "wallpaper" ? "wallpaper" : "controls";

window.addEventListener("DOMContentLoaded", () => {
  document.documentElement.dataset.needleMode = mode;
});

contextBridge.exposeInMainWorld("needleDesktop", Object.freeze({
  platform: "macos",
  mode,
  getNowPlaying: () => ipcRenderer.invoke("needle:get-now-playing"),
  onNowPlaying: (callback) => {
    ipcRenderer.removeAllListeners("needle:now-playing");
    ipcRenderer.on("needle:now-playing", (_event, payload) => callback(payload));
  },
  offNowPlaying: () => ipcRenderer.removeAllListeners("needle:now-playing"),
  setVolume: (source, volume) => ipcRenderer.invoke("needle:set-volume", { source, volume }),
  setPlayback: (source, playing) => ipcRenderer.invoke("needle:set-playback", { source, playing }),
}));
