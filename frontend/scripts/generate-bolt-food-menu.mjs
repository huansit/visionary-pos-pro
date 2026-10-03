import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { PRODUCT_IMAGE_BY_SKU } from "../src/productImages.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const frontend = path.resolve(here, "..");
const source = fs.readFileSync(path.join(frontend, "src", "VisionaryPOS.jsx"), "utf8");
const catalogMatch = source.match(/const P = \[(.*?)\r?\n  \];\r?\n  const IMG_BASE/s);
if (!catalogMatch) throw new Error("Unable to read the SIPCITY catalogue.");

// This array is maintained in the POS seed catalogue. Reading it here keeps
// the item names, SKUs, categories, and base prices in step with VisionPOS.
const catalog = Function(`"use strict"; return [${catalogMatch[1]}];`)();
const outputDirectory = path.join(frontend, "public", "bolt-food");
fs.mkdirSync(outputDirectory, { recursive: true });

const csvCell = (value) => `"${String(value ?? "").replaceAll('"', '""')}"`;
const imageUrl = (sku) => {
  const id = PRODUCT_IMAGE_BY_SKU[sku];
  return id ? `https://res.cloudinary.com/drge557ut/image/upload/f_jpg,q_auto,w_1000,h_1000,c_pad/${id}.jpg` : "";
};
const boltCategory = (category) => {
  if (["Whisky", "Gin", "Vodka", "Spirits"].includes(category)) return "Spirits";
  if (category === "Extras") return "Soft drinks & water";
  return category;
};
const menuRows = catalog
  .map(([id, name, sku, size, category, priceCents]) => ({ id, name, sku, size, category, priceCents }))
  .filter((product) => !["SIP0157", "SIP0158", "SIP0159"].includes(product.sku))
  .sort((left, right) => boltCategory(left.category).localeCompare(boltCategory(right.category)) || left.name.localeCompare(right.name));

function renderMenu({ filename, priceMultiplier }) {
  // Availability is deliberately omitted: the CSV is a catalogue import, and
  // a static file must never overwrite live stock availability in VisionPOS.
  const header = ["Item name", "Category", "Price (KES)", "Description", "SKU", "Image URL", "Age restricted"];
  const rows = menuRows.map((product) => [
    product.name,
    boltCategory(product.category),
    Math.round((product.priceCents / 100) * priceMultiplier).toFixed(2),
    [product.name, product.size].filter(Boolean).join(" - "),
    product.sku,
    imageUrl(product.sku),
    "Yes",
  ]);
  const content = [header, ...rows].map((row) => row.map(csvCell).join(",")).join("\n");
  fs.writeFileSync(path.join(outputDirectory, filename), `${content}\n`);
}

renderMenu({ filename: "SIPCITY-Bolt-Food-menu-physical-price.csv", priceMultiplier: 1 });
renderMenu({ filename: "SIPCITY-Bolt-Food-menu-30pct-delivery-price.csv", priceMultiplier: 1.3 });
console.log(`Generated ${menuRows.length} SIPCITY Bolt Food menu items.`);
