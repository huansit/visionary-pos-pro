import { PRODUCT_IMAGE_BY_SKU } from "./productImages.js";

const IMAGE_BASE = "https://res.cloudinary.com/drge557ut/image/upload/f_jpg,q_auto,w_1000,h_1000,c_pad/";
const escapeHtml = (value) => String(value).replace(/[&<>'"]/g, (character) => ({
  "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", '"': "&quot;",
}[character]));

function itemName(publicId) {
  return publicId
    .replace(/^sip-\d+-/i, "")
    .replace(/_[a-z0-9]+$/i, "")
    .replace(/-candidate-\d+/gi, "")
    .replace(/-web/gi, "")
    .replace(/-/g, " ")
    .replace(/\bml\b/gi, "ML")
    .replace(/\bl\b/gi, "L")
    .replace(/\s+/g, " ")
    .trim()
    .toUpperCase();
}

const products = Object.entries(PRODUCT_IMAGE_BY_SKU)
  .map(([sku, publicId]) => ({ sku, publicId, name: itemName(publicId) }))
  .sort((left, right) => left.name.localeCompare(right.name));

document.title = "SIPCITY | Bolt Food product photos";
document.getElementById("app").innerHTML = `
  <style>
    :root { color-scheme: light; font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; color: #132032; background: #f5f8fb; }
    * { box-sizing: border-box; }
    body { margin: 0; background: radial-gradient(circle at 14% 0%, #d8f1f5 0, transparent 30rem), #f5f8fb; }
    .shell { max-width: 1280px; margin: 0 auto; padding: 44px 24px 64px; }
    .hero { display: flex; justify-content: space-between; gap: 28px; align-items: flex-start; padding: 34px; border-radius: 24px; background: #102039; color: #fff; box-shadow: 0 20px 45px #22355722; }
    .eyebrow { margin: 0 0 9px; color: #76e1d8; font-size: .74rem; font-weight: 800; letter-spacing: .14em; text-transform: uppercase; }
    h1 { margin: 0; font-size: clamp(2rem, 5vw, 3.4rem); letter-spacing: -.05em; }
    .hero p { margin: 12px 0 0; max-width: 690px; color: #c8d5e8; font-size: 1.05rem; line-height: 1.55; }
    .copy { flex: 0 0 auto; border: 0; border-radius: 12px; padding: 13px 17px; background: #70ddd2; color: #102039; cursor: pointer; font: inherit; font-weight: 800; }
    .requirements { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 12px; margin: 24px 0; }
    .rule { min-height: 108px; padding: 18px; border: 1px solid #dbe5eb; border-radius: 16px; background: #fff; box-shadow: 0 8px 18px #1e38560d; }
    .rule b { display: block; margin-bottom: 7px; font-size: .95rem; } .rule span { color: #617087; font-size: .9rem; line-height: 1.4; }
    .bar { display: flex; justify-content: space-between; align-items: center; gap: 16px; margin: 28px 0 16px; }
    h2 { margin: 0; font-size: 1.25rem; } .count { color: #58708d; font-weight: 700; }
    .grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(180px, 1fr)); gap: 16px; }
    .card { overflow: hidden; border: 1px solid #dbe5eb; border-radius: 16px; background: #fff; box-shadow: 0 8px 18px #1e38560d; }
    .card img { display: block; width: 100%; aspect-ratio: 1; object-fit: contain; background: #fff; }
    .meta { padding: 12px; border-top: 1px solid #edf1f5; } .meta b { display: block; min-height: 2.5em; font-size: .84rem; line-height: 1.28; } .meta span { display: block; margin-top: 8px; color: #5d708a; font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: .73rem; }
    .note { margin-top: 28px; color: #5b6d83; font-size: .9rem; line-height: 1.5; }
    @media (max-width: 800px) { .shell { padding: 20px 14px 44px; } .hero { display: block; padding: 25px; } .copy { margin-top: 20px; width: 100%; } .requirements { grid-template-columns: 1fr 1fr; } }
    @media (max-width: 460px) { .requirements { grid-template-columns: 1fr; } .grid { grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 10px; } }
  </style>
  <section class="shell">
    <header class="hero">
      <div>
        <p class="eyebrow">Bolt Food menu submission</p>
        <h1>SIPCITY product photos</h1>
        <p>Public product-photo catalogue for Bolt Food. Each photo is labelled with its SIPCITY SKU and a catalogue reference name.</p>
      </div>
      <button class="copy" id="copy-link" type="button">Copy page link</button>
    </header>
    <section class="requirements" aria-label="Bolt Food photo requirements">
      <article class="rule"><b>File types</b><span>PNG or JPG only.</span></article>
      <article class="rule"><b>File size</b><span>Maximum 30 MB per image.</span></article>
      <article class="rule"><b>Upload limit</b><span>Maximum 150 files per upload batch.</span></article>
      <article class="rule"><b>Matching rule</b><span>For direct upload, the filename must exactly match the menu item it represents.</span></article>
    </section>
    <div class="bar"><h2>Available product images</h2><span class="count">${products.length} images</span></div>
    <section class="grid">
      ${products.map((product) => `<article class="card"><img loading="lazy" src="${IMAGE_BASE}${encodeURIComponent(product.publicId)}.jpg" alt="${escapeHtml(product.name)}" /><div class="meta"><b>${escapeHtml(product.name)}</b><span>${escapeHtml(product.sku)}</span></div></article>`).join("")}
    </section>
    <p class="note">Use the Bolt Food <b>Submit a link with photos</b> option and paste this page address. Review the product labels before publishing the final menu, especially where the Bolt menu uses a different product name or pack size.</p>
  </section>`;

document.getElementById("copy-link").addEventListener("click", async () => {
  await navigator.clipboard?.writeText(window.location.href);
  document.getElementById("copy-link").textContent = "Link copied";
});
