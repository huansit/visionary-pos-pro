const BUILT_ENTRY_PATTERN = /<script\b[^>]*\bsrc=["']([^"']*\/assets\/index-[^"']+\.js)["'][^>]*>/i;

export function publishedEntryAsset(html) {
  return String(html || "").match(BUILT_ENTRY_PATTERN)?.[1] || "";
}

export function loadedEntryAsset(documentRef) {
  const scripts = Array.from(documentRef?.querySelectorAll?.("script[src]") || []);
  const script = scripts.find((entry) => /\/assets\/index-[^/]+\.js(?:[?#].*)?$/i.test(entry.src || ""));
  if (!script?.src) return "";

  try {
    const url = new URL(script.src, documentRef?.baseURI || "http://localhost/");
    return url.pathname;
  } catch {
    return String(script.src).split(/[?#]/, 1)[0];
  }
}

export async function isPublishedBundleNewer({ documentRef, fetchImpl, now = Date.now } = {}) {
  const currentAsset = loadedEntryAsset(documentRef);
  if (!currentAsset || typeof fetchImpl !== "function") return false;

  const response = await fetchImpl(`/?visionpos_bundle_check=${now()}`, {
    cache: "no-store",
    credentials: "same-origin",
    headers: { "Cache-Control": "no-cache" },
  });
  if (!response.ok) return false;

  const nextAsset = publishedEntryAsset(await response.text());
  return Boolean(nextAsset && nextAsset !== currentAsset);
}
