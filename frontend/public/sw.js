const CACHE_NAME = "visionpos-install-shell-v1";
const INSTALL_ASSETS = [
  "/manifest.webmanifest",
  "/icons/visionpos-180.png",
  "/icons/visionpos-192.png",
  "/icons/visionpos-512.png",
  "/icons/visionpos-maskable-512.png"
];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then((cache) => cache.addAll(INSTALL_ASSETS))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((key) => key !== CACHE_NAME).map((key) => caches.delete(key))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", (event) => {
  const request = event.request;
  const url = new URL(request.url);

  // POS data, updates, navigation, and built assets always come from the server.
  if (
    request.method !== "GET" ||
    url.origin !== self.location.origin ||
    url.pathname.startsWith("/api/") ||
    url.pathname.startsWith("/downloads/") ||
    request.mode === "navigate" ||
    !INSTALL_ASSETS.includes(url.pathname)
  ) {
    return;
  }

  event.respondWith(caches.match(request).then((cached) => cached || fetch(request)));
});
