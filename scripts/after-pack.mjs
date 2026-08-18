import { execFile } from "node:child_process";
import { join } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const plistBuddy = "/usr/libexec/PlistBuddy";
const unusedPrivacyKeys = [
  "NSAudioCaptureUsageDescription",
  "NSBluetoothAlwaysUsageDescription",
  "NSBluetoothPeripheralUsageDescription",
  "NSCameraUsageDescription",
  "NSMicrophoneUsageDescription",
];

async function runPlistCommand(infoPlist, command, { allowMissing = false } = {}) {
  try {
    await execFileAsync(plistBuddy, ["-c", command, infoPlist]);
  } catch (error) {
    if (!allowMissing) throw error;
  }
}

export default async function hardenMacBundle(context) {
  if (context.electronPlatformName !== "darwin") return;

  const infoPlist = join(
    context.appOutDir,
    `${context.packager.appInfo.productFilename}.app`,
    "Contents",
    "Info.plist",
  );

  for (const key of unusedPrivacyKeys) {
    await runPlistCommand(infoPlist, `Delete :${key}`, { allowMissing: true });
  }

  await runPlistCommand(infoPlist, "Delete :NSAppTransportSecurity", { allowMissing: true });
  await runPlistCommand(infoPlist, "Add :NSAppTransportSecurity dict");
  await runPlistCommand(infoPlist, "Add :NSAppTransportSecurity:NSAllowsLocalNetworking bool true");
}
