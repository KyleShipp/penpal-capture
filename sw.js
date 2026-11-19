const CACHE = "penpal-capture-fb391dad4c21";
const FILES = ["./", "capture.js", "icon-180.png", "icon-512.png", "index.html", "manifest.webmanifest", "plan.json", "style.css"];
self.addEventListener("install", (e) => {
  // Fetched past the browser's HTTP cache, so a new version never stores the old files.
  const fresh = FILES.map((f) => new Request(f, { cache: "reload" }));
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(fresh)).then(() => self.skipWaiting()));
});
self.addEventListener("activate", (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});
self.addEventListener("fetch", (e) => {
  if (e.request.method !== "GET") return;
  e.respondWith(caches.match(e.request, { ignoreSearch: true }).then((hit) => hit || fetch(e.request)));
});
