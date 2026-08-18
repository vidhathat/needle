import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const packageJson = JSON.parse(
  readFileSync(new URL("../package.json", import.meta.url), "utf8"),
);
const releaseDirectory = resolve(new URL("../release", import.meta.url).pathname);
const architecture = process.arch;
const appDirectory = architecture === "x64" ? "mac" : `mac-${architecture}`;
const appPath = resolve(releaseDirectory, appDirectory, "Needle.app");
const dmgPath = resolve(
  releaseDirectory,
  `Needle-${packageJson.version}-${architecture}.dmg`,
);

function verify(label, command, args) {
  const result = spawnSync(command, args, { encoding: "utf8" });
  const output = `${result.stdout ?? ""}${result.stderr ?? ""}`.trim();

  if (result.status !== 0) {
    console.error(`\n${label} verification failed:\n${output}`);
    process.exit(result.status ?? 1);
  }

  console.log(`${label}: signed and valid`);
  if (output) console.log(output);
}

function verifyDeveloperId(label, artifactPath) {
  const result = spawnSync(
    "/usr/bin/codesign",
    ["--display", "--verbose=4", artifactPath],
    { encoding: "utf8" },
  );
  const output = `${result.stdout ?? ""}${result.stderr ?? ""}`.trim();

  if (
    result.status !== 0
    || !/^Authority=Developer ID Application:/m.test(output)
    || !/^TeamIdentifier=[A-Z0-9]+$/m.test(output)
  ) {
    console.error(`\n${label} does not have a Developer ID Application signature:\n${output}`);
    process.exit(result.status || 1);
  }

  const authority = output.match(/^Authority=Developer ID Application:.*$/m)?.[0];
  const team = output.match(/^TeamIdentifier=.*$/m)?.[0];
  console.log(`${label}: ${authority}; ${team}`);
}

verify("Needle.app", "/usr/bin/codesign", [
  "--verify",
  "--deep",
  "--strict",
  "--verbose=2",
  appPath,
]);
verify("Needle DMG", "/usr/bin/codesign", [
  "--verify",
  "--strict",
  "--verbose=2",
  dmgPath,
]);
verifyDeveloperId("Needle.app", appPath);
verifyDeveloperId("Needle DMG", dmgPath);
verify("Needle.app notarization", "/usr/bin/xcrun", ["stapler", "validate", appPath]);
verify("Needle DMG notarization", "/usr/bin/xcrun", ["stapler", "validate", dmgPath]);
verify("Needle.app Gatekeeper", "/usr/sbin/spctl", [
  "--assess",
  "--type",
  "execute",
  "--verbose=4",
  appPath,
]);
verify("Needle DMG Gatekeeper", "/usr/sbin/spctl", [
  "--assess",
  "--type",
  "install",
  "--verbose=4",
  dmgPath,
]);

console.log(`Release signature, notarization, and Gatekeeper checks passed: ${dmgPath}`);
