import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const packageJson = JSON.parse(
  readFileSync(new URL("../package.json", import.meta.url), "utf8"),
);
const dmgPath = resolve(
  new URL("../release", import.meta.url).pathname,
  `Needle-${packageJson.version}-${process.arch}.dmg`,
);

function run(args) {
  const result = spawnSync("/usr/bin/xcrun", args, { stdio: "inherit" });
  if (result.status !== 0) process.exit(result.status ?? 1);
}

const credentials = process.env.APPLE_NOTARY_KEYCHAIN_PROFILE
  ? ["--keychain-profile", process.env.APPLE_NOTARY_KEYCHAIN_PROFILE]
  : [
      "--apple-id",
      process.env.APPLE_ID || "",
      "--password",
      process.env.APPLE_APP_SPECIFIC_PASSWORD || "",
      "--team-id",
      process.env.APPLE_TEAM_ID || "",
    ];

if (credentials.some((value) => !value)) {
  throw new Error(
    "Set APPLE_NOTARY_KEYCHAIN_PROFILE or APPLE_ID, APPLE_APP_SPECIFIC_PASSWORD, and APPLE_TEAM_ID",
  );
}

run(["notarytool", "submit", dmgPath, "--wait", ...credentials]);
run(["stapler", "staple", dmgPath]);
run(["stapler", "validate", dmgPath]);
console.log(`Notarized and stapled DMG: ${dmgPath}`);
