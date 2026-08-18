import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { createServer } from "node:http";
import { extname, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";
import { Readable } from "node:stream";

const CONTENT_TYPES = new Map([
  [".css", "text/css; charset=utf-8"],
  [".html", "text/html; charset=utf-8"],
  [".ico", "image/x-icon"],
  [".jpeg", "image/jpeg"],
  [".jpg", "image/jpeg"],
  [".js", "text/javascript; charset=utf-8"],
  [".json", "application/json; charset=utf-8"],
  [".mp3", "audio/mpeg"],
  [".png", "image/png"],
  [".svg", "image/svg+xml"],
  [".webp", "image/webp"],
  [".woff2", "font/woff2"],
]);

function safeAssetPath(clientRoot, requestUrl) {
  let pathname;
  try {
    pathname = decodeURIComponent(new URL(requestUrl).pathname);
  } catch {
    return null;
  }

  const candidate = resolve(clientRoot, pathname.replace(/^\/+/, ""));
  return candidate === clientRoot || candidate.startsWith(`${clientRoot}${sep}`) ? candidate : null;
}

async function fetchAsset(clientRoot, request) {
  const assetPath = safeAssetPath(clientRoot, request.url);
  if (!assetPath) return new Response("Forbidden", { status: 403 });

  try {
    const metadata = await stat(assetPath);
    if (!metadata.isFile()) throw new Error("Not a file");
    const body = Readable.toWeb(createReadStream(assetPath));
    return new Response(body, {
      headers: {
        "Cache-Control": assetPath.includes(`${sep}_next${sep}static${sep}`)
          ? "public, max-age=31536000, immutable"
          : "public, max-age=3600",
        "Content-Length": String(metadata.size),
        "Content-Type": CONTENT_TYPES.get(extname(assetPath).toLowerCase()) ?? "application/octet-stream",
      },
    });
  } catch {
    return new Response("Not found", { status: 404 });
  }
}

function toWebRequest(request, origin) {
  const method = request.method ?? "GET";
  const hasBody = method !== "GET" && method !== "HEAD";
  return new Request(new URL(request.url ?? "/", origin), {
    method,
    headers: request.headers,
    body: hasBody ? Readable.toWeb(request) : undefined,
    duplex: hasBody ? "half" : undefined,
  });
}

async function writeWebResponse(nodeResponse, webResponse, method) {
  nodeResponse.statusCode = webResponse.status;
  nodeResponse.statusMessage = webResponse.statusText;
  webResponse.headers.forEach((value, name) => nodeResponse.setHeader(name, value));

  if (method === "HEAD" || !webResponse.body) {
    nodeResponse.end();
    return;
  }

  await new Promise((resolveResponse, rejectResponse) => {
    const stream = Readable.fromWeb(webResponse.body);
    stream.on("error", rejectResponse);
    nodeResponse.on("finish", resolveResponse);
    stream.pipe(nodeResponse);
  });
}

export async function startAppServer(distRoot) {
  const clientRoot = resolve(distRoot, "client");
  const serverEntry = resolve(distRoot, "server", "index.js");
  const { default: serverModule } = await import(pathToFileURL(serverEntry).href);
  const handleRequest = resolveAppRequestHandler(serverModule);

  const server = createServer(async (request, response) => {
    const address = server.address();
    const port = typeof address === "object" && address ? address.port : 0;
    const origin = `http://127.0.0.1:${port}`;

    try {
      const webRequest = toWebRequest(request, origin);
      if (request.method === "GET" || request.method === "HEAD") {
        const assetResponse = await fetchAsset(clientRoot, webRequest);
        if (assetResponse.ok) {
          await writeWebResponse(response, assetResponse, request.method);
          return;
        }
      }

      const backgroundTasks = [];
      const webResponse = await handleRequest(
        webRequest,
        { ASSETS: { fetch: (assetRequest) => fetchAsset(clientRoot, assetRequest) } },
        {
          waitUntil(task) { backgroundTasks.push(task); },
          passThroughOnException() {},
        },
      );
      await writeWebResponse(response, webResponse, request.method);
      void Promise.allSettled(backgroundTasks);
    } catch (error) {
      console.error("Needle app server failed:", error);
      if (!response.headersSent) response.writeHead(500, { "Content-Type": "text/plain; charset=utf-8" });
      response.end("Needle could not render this window.");
    }
  });

  await new Promise((resolveServer, rejectServer) => {
    server.once("error", rejectServer);
    server.listen(0, "127.0.0.1", resolveServer);
  });

  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Needle app server did not start.");
  return { server, url: `http://127.0.0.1:${address.port}` };
}

export function resolveAppRequestHandler(serverModule) {
  if (typeof serverModule === "function") return serverModule;
  if (typeof serverModule?.fetch === "function") return serverModule.fetch.bind(serverModule);
  throw new TypeError("Needle renderer build does not export a request handler.");
}
