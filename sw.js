/* Service worker: the whole app is cached on first visit so it keeps working offline.
   Requests go to the network first (so updates arrive when online) and fall back to the cache. */
const CACHE = "pedagog-v1";
const FILES = [
  "./", "index.html", "pedagog.js", "web/app.js", "web/app.css", "web/manifest.json", "web/icon.svg",
  "web/vendor/chessground/chessground.min.js",
  "web/vendor/chessground/chessground.base.css",
  "web/vendor/chessground/chessground.brown.css",
  "web/vendor/chessground/chessground.cburnett.css",
  "web/vendor/cm-chess/src/Chess.js",
  "web/vendor/cm-pgn/src/Pgn.js", "web/vendor/cm-pgn/src/Header.js", "web/vendor/cm-pgn/src/History.js",
  "web/vendor/cm-pgn/src/parser/pgnParser.js",
  "web/vendor/chess.mjs/src/Chess.js",
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
