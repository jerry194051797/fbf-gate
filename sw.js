/*
 * Service worker for the gate (ADR-0010). The app's files live in the cache
 * "fbf-app-v1", filled by gate.js from the private repo; requests under
 * app/ are answered from there (query strings ignored, byte ranges honoured
 * for audio). Gate files come from the network, with the cache as a
 * fallback when offline. Nothing else is intercepted.
 */
"use strict";

const APP_CACHE = "fbf-app-v1";
const GATE_CACHE = "fbf-gate-v1";
// The gate itself, so it opens offline even if it was never fetched through this worker.
const SHELL = ["./", "gate.js", "sync-core.js", "manifest.webmanifest", "icon.png"];

self.addEventListener("install", (event) => {
  self.skipWaiting();
  event.waitUntil(
    caches
      .open(GATE_CACHE)
      .then((cache) => cache.addAll(SHELL))
      .catch(() => {})
  );
});
self.addEventListener("activate", (event) => event.waitUntil(self.clients.claim()));

function scopePath() {
  return new URL(self.registration.scope).pathname;
}

self.addEventListener("fetch", (event) => {
  const request = event.request;
  if (request.method !== "GET") return;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin || !url.pathname.startsWith(scopePath())) return;
  const inside = url.pathname.slice(scopePath().length);
  if (inside.startsWith("app/")) event.respondWith(fromApp(request, url));
  else event.respondWith(networkFirst(request));
});

async function fromApp(request, url) {
  const cache = await caches.open(APP_CACHE);
  let key = url.origin + url.pathname;
  if (key.endsWith("/")) key += "index.html";
  const response = await cache.match(key);
  if (!response) {
    return new Response("這個檔案還沒下載。請先開入口頁。", {
      status: 404,
      headers: { "Content-Type": "text/plain; charset=utf-8" },
    });
  }
  const range = request.headers.get("Range");
  return range ? partial(response, range) : response;
}

/** A 206 answer for "Range: bytes=a-b" (Safari asks for audio this way). */
async function partial(response, range) {
  const body = await response.arrayBuffer();
  const total = body.byteLength;
  const match = /^bytes=(\d*)-(\d*)$/.exec(range.trim());
  let start = 0;
  let end = total - 1;
  if (match && match[1] !== "") {
    start = Number(match[1]);
    if (match[2] !== "") end = Math.min(Number(match[2]), total - 1);
  } else if (match && match[2] !== "") {
    start = Math.max(0, total - Number(match[2]));
  }
  if (!match || start >= total || start > end) {
    return new Response(null, { status: 416, headers: { "Content-Range": "bytes */" + total } });
  }
  return new Response(body.slice(start, end + 1), {
    status: 206,
    headers: {
      "Content-Type": response.headers.get("Content-Type") || "application/octet-stream",
      "Content-Range": "bytes " + start + "-" + end + "/" + total,
      "Content-Length": String(end - start + 1),
      "Accept-Ranges": "bytes",
    },
  });
}

async function networkFirst(request) {
  try {
    const response = await fetch(request);
    if (response.ok) {
      const cache = await caches.open(GATE_CACHE);
      await cache.put(request, response.clone());
    }
    return response;
  } catch (error) {
    const cached = await caches.match(request, { ignoreSearch: true, cacheName: GATE_CACHE });
    if (cached) return cached;
    throw error;
  }
}
