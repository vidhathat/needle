import { createHash } from "node:crypto";
import {
  access,
  chmod,
  copyFile,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const repositoryRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const revision = "3ac3d4bdf862c7b5399b4fba4df5689f5c38609a";
const archiveSha256 = "111e285e7a8acfb05b7339883e303a360f8a7a9b7acb4f0f5c01b647deb8ceb5";
const archiveUrl = `https://github.com/ungive/mediaremote-adapter/archive/${revision}.tar.gz`;
// node-gyp rebuild removes desktop/native/build, so keep the verified native
// dependency in a persistent ignored cache instead of downloading it every run.
const outputRoot = join(repositoryRoot, "desktop", "native", "vendor", "mediaremote-adapter");
const frameworkRoot = join(outputRoot, "MediaRemoteAdapter.framework");
const frameworkBinary = join(frameworkRoot, "Versions", "A", "MediaRemoteAdapter");
const stampPath = join(outputRoot, ".source-revision");

const adapterSources = [
  "src/adapter/env.m",
  "src/adapter/get.m",
  "src/adapter/globals.m",
  "src/adapter/keys.m",
  "src/adapter/now_playing.m",
  "src/adapter/repeat.m",
  "src/adapter/seek.m",
  "src/adapter/send.m",
  "src/adapter/shuffle.m",
  "src/adapter/speed.m",
  "src/adapter/stream.m",
  "src/adapter/test.m",
  "src/private/MediaRemote.m",
  "src/utility/Debounce.m",
  "src/utility/helpers.m",
];

const frameworkInfo = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleDevelopmentRegion</key><string>en</string>
  <key>CFBundleExecutable</key><string>MediaRemoteAdapter</string>
  <key>CFBundleIdentifier</key><string>com.vandenbe.MediaRemoteAdapter</string>
  <key>CFBundleInfoDictionaryVersion</key><string>6.0</string>
  <key>CFBundleName</key><string>MediaRemoteAdapter</string>
  <key>CFBundlePackageType</key><string>FMWK</string>
  <key>CFBundleShortVersionString</key><string>0.7.6</string>
  <key>CFBundleVersion</key><string>0.7.6</string>
</dict>
</plist>
`;

async function alreadyBuilt() {
  try {
    await Promise.all([
      access(frameworkBinary),
      access(join(outputRoot, "mediaremote-adapter.pl")),
      access(join(outputRoot, "LICENSE")),
    ]);
    return (await readFile(stampPath, "utf8")).trim() === revision;
  } catch {
    return false;
  }
}

async function run() {
  if (await alreadyBuilt()) {
    console.log("MediaRemote adapter is already built.");
    return;
  }

  const temporaryRoot = await mkdtemp(join(tmpdir(), "needle-mediaremote-adapter-"));
  try {
    const archivePath = join(temporaryRoot, "source.tar.gz");
    const sourceRoot = join(temporaryRoot, "source");
    const response = await fetch(archiveUrl, { redirect: "follow" });
    if (!response.ok) throw new Error(`Download failed with HTTP ${response.status}.`);
    const archive = Buffer.from(await response.arrayBuffer());
    const digest = createHash("sha256").update(archive).digest("hex");
    if (digest !== archiveSha256) throw new Error("MediaRemote adapter checksum did not match.");
    await writeFile(archivePath, archive);
    await mkdir(sourceRoot, { recursive: true });
    await execFileAsync("/usr/bin/tar", ["-xzf", archivePath, "-C", sourceRoot, "--strip-components=1"]);

    await rm(outputRoot, { recursive: true, force: true });
    await mkdir(join(frameworkRoot, "Versions", "A", "Headers"), { recursive: true });
    await mkdir(join(frameworkRoot, "Versions", "A", "Resources"), { recursive: true });

    const architecture = process.arch === "x64" ? "x86_64" : "arm64";
    const compilerArguments = [
      "-dynamiclib",
      "-fobjc-arc",
      "-fvisibility=default",
      "-arch", architecture,
      "-mmacosx-version-min=13.0",
      "-framework", "Foundation",
      "-framework", "AppKit",
      "-framework", "UniformTypeIdentifiers",
      "-I", join(sourceRoot, "include"),
      "-I", join(sourceRoot, "src"),
      ...adapterSources.map((source) => join(sourceRoot, source)),
      "-install_name", "@rpath/MediaRemoteAdapter.framework/Versions/A/MediaRemoteAdapter",
      "-o", frameworkBinary,
    ];
    await execFileAsync("/usr/bin/xcrun", ["clang", ...compilerArguments], { maxBuffer: 1024 * 1024 });

    await copyFile(
      join(sourceRoot, "include", "MediaRemoteAdapter.h"),
      join(frameworkRoot, "Versions", "A", "Headers", "MediaRemoteAdapter.h"),
    );
    await writeFile(join(frameworkRoot, "Versions", "A", "Resources", "Info.plist"), frameworkInfo);
    await symlink("A", join(frameworkRoot, "Versions", "Current"));
    await symlink("Versions/Current/MediaRemoteAdapter", join(frameworkRoot, "MediaRemoteAdapter"));
    await symlink("Versions/Current/Headers", join(frameworkRoot, "Headers"));
    await symlink("Versions/Current/Resources", join(frameworkRoot, "Resources"));

    await copyFile(join(sourceRoot, "bin", "mediaremote-adapter.pl"), join(outputRoot, "mediaremote-adapter.pl"));
    await chmod(join(outputRoot, "mediaremote-adapter.pl"), 0o755);
    await copyFile(join(sourceRoot, "LICENSE"), join(outputRoot, "LICENSE"));
    await writeFile(stampPath, `${revision}\n`);
    await execFileAsync("/usr/bin/codesign", ["--force", "--deep", "--sign", "-", frameworkRoot]);
    console.log(`Built MediaRemote adapter for ${architecture}.`);
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true });
  }
}

await run();
