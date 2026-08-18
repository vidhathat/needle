const MAC_DOWNLOAD_URL =
  process.env.NEXT_PUBLIC_MAC_DOWNLOAD_URL ??
  "https://9rt8zr04msyyegmt.public.blob.vercel-storage.com/updates/mac/Needle-latest-arm64.dmg";

const DOWNLOAD_NAME = "Needle.dmg";
const FORWARDED_HEADERS = [
  "accept-ranges",
  "content-length",
  "content-range",
  "content-type",
  "etag",
  "last-modified",
] as const;

async function download(request: Request, includeBody: boolean) {
  const upstreamHeaders = new Headers();
  const range = request.headers.get("range");

  if (range) upstreamHeaders.set("range", range);

  const upstream = await fetch(MAC_DOWNLOAD_URL, {
    method: includeBody ? "GET" : "HEAD",
    headers: upstreamHeaders,
  });

  if (!upstream.ok) {
    return new Response("Installer unavailable", { status: 502 });
  }

  const headers = new Headers();
  for (const name of FORWARDED_HEADERS) {
    const value = upstream.headers.get(name);
    if (value) headers.set(name, value);
  }

  headers.set("content-disposition", `attachment; filename="${DOWNLOAD_NAME}"`);
  headers.set("cache-control", "public, max-age=3600");

  return new Response(includeBody ? upstream.body : null, {
    status: upstream.status,
    headers,
  });
}

export function GET(request: Request) {
  return download(request, true);
}

export function HEAD(request: Request) {
  return download(request, false);
}
