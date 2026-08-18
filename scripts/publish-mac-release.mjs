import { createReadStream } from "node:fs";
import { access, readFile } from "node:fs/promises";
import { basename, resolve } from "node:path";
import { put } from "@vercel/blob";

const packageJson = JSON.parse(
  await readFile(new URL("../package.json", import.meta.url), "utf8"),
);
const releaseDirectory = resolve(new URL("../release", import.meta.url).pathname);
const architecture = process.arch;
const releaseName = `Needle-${packageJson.version}-${architecture}`;
const token = process.env.BLOB_READ_WRITE_TOKEN;

if (!token) throw new Error("BLOB_READ_WRITE_TOKEN is required");

async function upload(fileName, pathname, cacheControlMaxAge) {
  const filePath = resolve(releaseDirectory, fileName);
  await access(filePath);
  const result = await put(pathname, createReadStream(filePath), {
    access: "public",
    addRandomSuffix: false,
    allowOverwrite: true,
    cacheControlMaxAge,
    multipart: true,
    token,
  });
  console.log(`Published ${basename(filePath)}: ${result.url}`);
}

for (const extension of ["dmg", "zip", "zip.blockmap"]) {
  const fileName = `${releaseName}.${extension}`;
  await upload(fileName, `updates/mac/${fileName}`, 31_536_000);
}

await upload(`${releaseName}.dmg`, "updates/mac/Needle-latest-arm64.dmg", 60);
// Publish the updater manifest last so clients never observe a partial release.
await upload("latest-mac.yml", "updates/mac/latest-mac.yml", 60);
