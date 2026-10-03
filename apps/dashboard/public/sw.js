// Toolbox の Service Worker。サイトのルート（/）に置き、全ツールのページをまとめて扱う。
// - ページ: ネットワーク優先。オフラインのときは最後に開いたものをキャッシュから返す
// - ビルド成果物（/_astro/, /<tool>/_astro/ はファイル名にハッシュが付く）: キャッシュ優先
// 通信先は同じオリジンだけで、入力内容などは保存しない。

const CACHE = "toolbox-v1";
const PRECACHE = [
  "/",
  "/calendar",
  "/em-buttons",
  "/manifest.webmanifest",
  "/icons/icon.svg",
  // ツールごとの favicon（各ツールの public/icon.svg）
  "/calendar/icon.svg",
  "/em-buttons/icon.svg",
];

// 事前キャッシュ。ページの HTML だけでなく、そこから辿れる CSS・JS・フォントも一緒に保存する
// （初回訪問のあとオフラインで開いても、見た目と動作が揃うように）
const ASSET_PATH = /\/(?:[\w-]+\/)?_astro\/[^"'()\s\\>]+/g;
const RELATIVE_IMPORT = /(?:from|import)\s*["'](\.{1,2}\/[^"']+)["']/g;

const crawl = async (cache, url, seen) => {
  if (seen.has(url)) return;
  seen.add(url);
  const response = await fetch(url);
  if (!response.ok) return;
  await cache.put(url, response.clone());
  const type = response.headers.get("content-type") ?? "";
  if (!/html|css|javascript/.test(type)) return;
  const text = await response.text();
  const found = new Set(text.match(ASSET_PATH) ?? []);
  if (/javascript/.test(type))
    for (const [, path] of text.matchAll(RELATIVE_IMPORT))
      found.add(new URL(path, new URL(url, self.location.origin)).pathname);
  await Promise.all(
    [...found].map((path) => crawl(cache, path, seen).catch(() => {})),
  );
};

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches
      .open(CACHE)
      .then((cache) => {
        const seen = new Set();
        // どれかのツールが未デプロイでもインストールを止めない
        return Promise.all(
          PRECACHE.map((url) => crawl(cache, url, seen).catch(() => {})),
        );
      })
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(
          keys.filter((key) => key !== CACHE).map((key) => caches.delete(key)),
        ),
      )
      .then(() => self.clients.claim()),
  );
});

const isHashedAsset = (url) => /^\/(?:[^/]+\/)?_astro\//.test(url.pathname);

// キャッシュへの書き込みは fetch イベントの寿命に含める（応答を返した直後に Service Worker が止まっても書き切れるように）
const store = (event, cache, request, response) =>
  event.waitUntil(cache.put(request, response.clone()).catch(() => {}));

const networkFirst = async (event, request) => {
  const cache = await caches.open(CACHE);
  try {
    const response = await fetch(request);
    if (response.ok) store(event, cache, request, response);
    return response;
  } catch (error) {
    const cached = await cache.match(request, { ignoreSearch: true });
    if (cached) return cached;
    throw error;
  }
};

const cacheFirst = async (event, request) => {
  const cache = await caches.open(CACHE);
  const cached = await cache.match(request);
  if (cached) return cached;
  const response = await fetch(request);
  if (response.ok) store(event, cache, request, response);
  return response;
};

self.addEventListener("fetch", (event) => {
  const { request } = event;
  const url = new URL(request.url);
  if (request.method !== "GET" || url.origin !== self.location.origin) return;
  event.respondWith(
    isHashedAsset(url)
      ? cacheFirst(event, request)
      : networkFirst(event, request),
  );
});
