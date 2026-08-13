import test from "node:test";
import assert from "node:assert/strict";
import {
  isPublishedBundleNewer,
  loadedEntryAsset,
  publishedEntryAsset,
} from "../frontend/src/appBundleUpdate.js";

function documentWithAsset(src) {
  return {
    baseURI: "https://visionarypos.cloud/",
    querySelectorAll() {
      return [{ src }];
    },
  };
}

test("extracts the deployed Vite entry asset", () => {
  assert.equal(
    publishedEntryAsset('<script type="module" crossorigin src="/assets/index-New123.js"></script>'),
    "/assets/index-New123.js",
  );
});

test("normalizes the currently loaded Vite entry asset", () => {
  assert.equal(
    loadedEntryAsset(documentWithAsset("https://visionarypos.cloud/assets/index-Old123.js")),
    "/assets/index-Old123.js",
  );
});

test("detects when an installed app is running an older bundle", async () => {
  const requests = [];
  const updateAvailable = await isPublishedBundleNewer({
    documentRef: documentWithAsset("https://visionarypos.cloud/assets/index-Old123.js"),
    now: () => 123,
    fetchImpl: async (url, options) => {
      requests.push({ url, options });
      return {
        ok: true,
        async text() {
          return '<script type="module" src="/assets/index-New123.js"></script>';
        },
      };
    },
  });

  assert.equal(updateAvailable, true);
  assert.equal(requests[0].url, "/?visionpos_bundle_check=123");
  assert.equal(requests[0].options.cache, "no-store");
});

test("does not reload when the deployed bundle matches", async () => {
  const updateAvailable = await isPublishedBundleNewer({
    documentRef: documentWithAsset("https://visionarypos.cloud/assets/index-Same123.js"),
    fetchImpl: async () => ({
      ok: true,
      async text() {
        return '<script type="module" src="/assets/index-Same123.js"></script>';
      },
    }),
  });

  assert.equal(updateAvailable, false);
});
