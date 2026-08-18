import { cp, mkdir, rm, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { startAppServer } from "../desktop/app-server.mjs";

const projectRoot = resolve(import.meta.dirname, "..");
const distRoot = resolve(projectRoot, "dist");
const outputRoot = resolve(projectRoot, "vercel-output");
const routes = [
  { pathname: "/", destination: "index.html" },
  { pathname: "/landing-player", destination: "landing-player/index.html" },
  { pathname: "/player", destination: "player/index.html" },
];
const configuredSiteUrl = process.env.NEXT_PUBLIC_SITE_URL
  ?? (process.env.VERCEL_PROJECT_PRODUCTION_URL
    ? `https://${process.env.VERCEL_PROJECT_PRODUCTION_URL}`
    : null)
  ?? (process.env.VERCEL_URL ? `https://${process.env.VERCEL_URL}` : null)
  ?? "http://localhost:3000";
const siteOrigin = new URL(configuredSiteUrl);

await rm(outputRoot, { recursive: true, force: true });
await mkdir(outputRoot, { recursive: true });
await cp(resolve(distRoot, "client"), outputRoot, { recursive: true });

const { server, url } = await startAppServer(distRoot);

try {
  for (const route of routes) {
    const response = await fetch(new URL(route.pathname, url), {
      headers: {
        host: siteOrigin.host,
        "x-forwarded-host": siteOrigin.host,
        "x-forwarded-proto": siteOrigin.protocol.slice(0, -1),
      },
    });
    if (!response.ok) {
      throw new Error(`Could not render ${route.pathname}: ${response.status}`);
    }

    const destination = resolve(outputRoot, route.destination);
    await mkdir(dirname(destination), { recursive: true });
    await writeFile(destination, await response.text(), "utf8");
  }
} finally {
  await new Promise((resolveClose, rejectClose) => {
    server.close((error) => error ? rejectClose(error) : resolveClose());
  });
}

console.log(`Rendered ${routes.length} static routes for Vercel.`);
