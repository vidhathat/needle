import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { dump, load } from "js-yaml";

export function prepareMacUpdateManifest(source) {
  const manifest = load(source);
  const zip = manifest?.files?.find(({ url }) => String(url).endsWith(".zip"));

  if (!zip?.url || !zip?.sha512) {
    throw new Error("latest-mac.yml does not contain a ZIP update artifact");
  }

  return dump({
    ...manifest,
    files: [zip],
    path: zip.url,
    sha512: zip.sha512,
  }, { lineWidth: -1, noRefs: true });
}

async function main() {
  const manifestPath = resolve(process.cwd(), "release/latest-mac.yml");
  const source = await readFile(manifestPath, "utf8");
  await writeFile(manifestPath, prepareMacUpdateManifest(source), "utf8");
  console.log(`Prepared ZIP-only update manifest: ${manifestPath}`);
}

if (process.argv[1] === new URL(import.meta.url).pathname) {
  await main();
}
