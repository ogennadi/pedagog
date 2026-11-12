/* Service worker: the whole app is cached on first visit so it keeps working offline.
   Requests go to the network first (so updates arrive when online) and fall back to the cache. */
const CACHE = "pedagog-v6";
const FILES = [
  "./", "index.html", "engine.js", "app.js", "prefs.js", "book.js", "app.css", "manifest.json",
  "config.html", "config.js", "config.css",
  "icon-32.png", "icon-180.png", "icon-192.png", "icon-512.png",
  "vendor/chessground/chessground.min.js",
  "vendor/chessground/chessground.base.css",
  "vendor/chessground/chessground.brown.css",
  "vendor/chessground/chessground.cburnett.css",
  "vendor/cm-chess/src/Chess.js",
  "vendor/cm-pgn/src/Pgn.js", "vendor/cm-pgn/src/Header.js", "vendor/cm-pgn/src/History.js",
  "vendor/cm-pgn/src/parser/pgnParser.js",
  "vendor/chess.mjs/src/Chess.js",
];
self.addEventListener("install", (e) => e.waitUntil(caches.open(CACHE).then((c) => c.addAll(FILES)).then(() => self.skipWaiting())));
self.addEventListener("activate", (e) => e.waitUntil(caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))).then(() => self.clients.claim())));
self.addEventListener("fetch", (e) => {
  if (e.request.method !== "GET" || new URL(e.request.url).origin !== location.origin) return;
  e.respondWith(fetch(e.request).then((res) => {
    if (res.ok) { const copy = res.clone(); caches.open(CACHE).then((c) => c.put(e.request, copy)); }
    return res;
  }).catch(() => caches.match(e.request, { ignoreSearch: true })));
});
