import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { load } from "js-yaml";
import { prepareMacUpdateManifest } from "../scripts/prepare-release-metadata.mjs";

const execFileAsync = promisify(execFile);

test("packages the updater and publishes macOS update metadata", async () => {
  const packageJson = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"));

  assert.ok(packageJson.dependencies["electron-updater"]);
  assert.ok(!packageJson.build.files.includes("!node_modules{,/**/*}"));
  assert.deepEqual(packageJson.build.mac.target, ["dmg", "zip"]);
  assert.match(packageJson.scripts["desktop:dmg"], /electron-builder --mac dmg zip/);
  assert.match(packageJson.scripts["desktop:dmg"], /notarize-dmg\.mjs/);
  assert.equal(packageJson.build.publish[0].provider, "generic");
  assert.match(packageJson.build.publish[0].url, /public\.blob\.vercel-storage\.com\/updates\/mac$/);
});

test("releases only versioned builds and uploads the manifest last", async () => {
  const workflow = await readFile(
    new URL("../.github/workflows/release-macos.yml", import.meta.url),
    "utf8",
  );
  const { stdout } = await execFileAsync(
    process.execPath,
    [new URL("../scripts/release-version-changed.mjs", import.meta.url).pathname, "", "true"],
  );

  assert.match(stdout, /publish=true/);
  assert.match(workflow, /if: needs\.prepare\.outputs\.publish == 'true'/);
  assert.match(workflow, /branches: \[main, master\]/);
  assert.match(workflow, /fetch-depth: 0/);
  assert.match(workflow, /electron-builder --mac dmg zip --arm64 --publish never/);
  assert.match(workflow, /APPLE_APP_SPECIFIC_PASSWORD/);
  assert.match(workflow, /prepare-release-metadata\.mjs/);
  assert.match(workflow, /BLOB_READ_WRITE_TOKEN/);
  assert.match(workflow, /publish-mac-release\.mjs/);
  assert.match(workflow, /release\/\*\.zip\.blockmap/);
  assert.doesNotMatch(workflow, /release\/\*\.dmg\.blockmap/);

  const publisher = await readFile(
    new URL("../scripts/publish-mac-release.mjs", import.meta.url),
    "utf8",
  );
  assert.match(publisher, /Needle-latest-arm64\.dmg/);
  assert.ok(publisher.lastIndexOf('"latest-mac.yml"') > publisher.indexOf('"zip.blockmap"'));
});

test("publishes ZIP-only updater metadata after the DMG is stapled", () => {
  const source = `version: 0.2.1
files:
  - url: Needle-0.2.1-arm64.zip
    sha512: zip-hash
  - url: Needle-0.2.1-arm64.dmg
    sha512: stale-dmg-hash
path: Needle-0.2.1-arm64.zip
sha512: zip-hash
`;
  const manifest = load(prepareMacUpdateManifest(source));

  assert.deepEqual(manifest.files, [{
    url: "Needle-0.2.1-arm64.zip",
    sha512: "zip-hash",
  }]);
  assert.equal(manifest.path, "Needle-0.2.1-arm64.zip");
});
