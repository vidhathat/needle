import { execFileSync } from "node:child_process";
import { readFile } from "node:fs/promises";

const [beforeSha = "", forceRelease = "false"] = process.argv.slice(2);
const currentPackage = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"));
const currentVersion = String(currentPackage.version);

function parseStableVersion(version) {
  if (!/^\d+\.\d+\.\d+$/.test(version)) {
    throw new Error(`Release version must be stable semver (x.y.z), received ${version}`);
  }
  return version.split(".").map(Number);
}

function compareVersions(left, right) {
  const a = parseStableVersion(left);
  const b = parseStableVersion(right);
  for (let index = 0; index < a.length; index += 1) {
    if (a[index] !== b[index]) return a[index] > b[index] ? 1 : -1;
  }
  return 0;
}

function previousVersion() {
  if (!beforeSha || /^0+$/.test(beforeSha)) return null;
  try {
    const previousPackage = execFileSync("git", ["show", `${beforeSha}:package.json`], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    return String(JSON.parse(previousPackage).version);
  } catch {
    return null;
  }
}

parseStableVersion(currentVersion);
const previous = previousVersion();
const forced = forceRelease === "true";

if (previous && compareVersions(currentVersion, previous) < 0) {
  throw new Error(`Release version moved backwards from ${previous} to ${currentVersion}`);
}

const publish = forced || (previous !== null && compareVersions(currentVersion, previous) > 0);
console.log(`publish=${publish}`);
console.log(`version=${currentVersion}`);
console.log(`previous_version=${previous ?? "unknown"}`);
console.log(`reason=${forced ? "manual" : publish ? "version-increased" : "version-unchanged"}`);
