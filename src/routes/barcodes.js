import express from "express";
import { requireDevice } from "../auth.js";
import { isMySql, q, tx } from "../db.js";

const router = express.Router();

function uid(prefix = "bc") {
  return prefix + "_" + Math.random().toString(36).slice(2, 10);
}

function normalizeBarcode(value) {
  return String(value || "").trim().replace(/\s+/g, "");
}

function validBarcode(value) {
  return /^[A-Za-z0-9._-]{4,64}$/.test(normalizeBarcode(value));
}

function toProduct(row) {
  if (!row) return null;
  return {
    id: row.id,
    branchId: row.branch_id,
    barcodeCatalogId: row.barcode_catalog_id,
    name: row.name,
    sku: row.sku || "",
    categoryId: row.category_id,
    brand: row.brand || "",
    unit: row.unit || "",
    costPrice: Number(row.cost_price || 0),
    sellingPrice: Number(row.selling_price || 0),
    stock: Number(row.stock || 0),
    reorderLevel: Number(row.reorder_level || 0),
    shelfLocation: row.shelf_location || "",
    availability: row.availability === undefined || row.availability === null ? true : Boolean(row.availability),
    image: row.image || "",
    description: row.description || "",
    status: row.status || "active",
  };
}

function branchProductId(branchId, productId) {
  return `bp_${branchId}_${productId}`.replace(/[^A-Za-z0-9._-]/g, "_").slice(0, 180);
}

function requestBranchId(req) {
  return req.terminalUuid ? req.deviceBranchId : (req.body?.branchId || req.deviceBranchId);
}

async function findProductByCatalog(client, barcodeCatalogId) {
  const result = await client.query(
    "SELECT id FROM products WHERE barcode_catalog_id = $1 AND status = 'active' ORDER BY created_at ASC, id ASC LIMIT 1",
    [barcodeCatalogId]
  );
  return result.rows[0] || null;
}

async function findProductBySku(client, sku) {
  const normalizedSku = String(sku || "").trim();
  if (!normalizedSku) return null;
  const result = await client.query(
    "SELECT id FROM products WHERE lower(sku) = lower($1) AND status = 'active' ORDER BY updated_at DESC, created_at DESC, id ASC LIMIT 1",
    [normalizedSku]
  );
  return result.rows[0] || null;
}

async function selectBranchProductView(client, productId, branchId) {
  const result = await client.query(
    `SELECT
       p.id,
       bp.branch_id,
       p.barcode_catalog_id,
       p.name,
       p.sku,
       p.category_id,
       p.brand,
       p.unit,
       p.cost_price,
       bp.selling_price,
       bp.stock,
       bp.reorder_level,
       bp.shelf_location,
       bp.availability,
       p.image,
       p.description,
       p.status
     FROM products p
     LEFT JOIN branch_products bp ON bp.product_id = p.id AND bp.branch_id = $2
     WHERE p.id = $1
     LIMIT 1`,
    [productId, branchId]
  );
  return toProduct(result.rows[0]);
}

async function findCatalog(client, barcode) {
  const result = await client.query(
    "SELECT id, barcode, barcode_type, created_at FROM barcode_catalog WHERE lower(barcode) = lower($1) LIMIT 1",
    [barcode]
  );
  return result.rows[0] || null;
}

async function ensureCatalog(client, barcode, barcodeType = "code128") {
  const existing = await findCatalog(client, barcode);
  if (existing) return existing;
  const id = uid("bc");
  try {
    await client.query(
      "INSERT INTO barcode_catalog (id, barcode, barcode_type) VALUES ($1, $2, $3)",
      [id, barcode, barcodeType || "code128"]
    );
  } catch (error) {
    const raced = await findCatalog(client, barcode);
    if (raced) return raced;
    throw error;
  }
  const created = await findCatalog(client, barcode);
  return created || { id, barcode, barcode_type: barcodeType || "code128" };
}

router.use(requireDevice);

router.post("/resolve", async (req, res, next) => {
  try {
    const barcode = normalizeBarcode(req.body?.barcode);
    const branchId = requestBranchId(req);
    if (!validBarcode(barcode)) return res.status(400).json({ error: "invalid_barcode" });
    if (!branchId) return res.status(400).json({ error: "branch_required" });

    const catalogResult = await q(
      "SELECT id, barcode, barcode_type, created_at FROM barcode_catalog WHERE lower(barcode) = lower($1) LIMIT 1",
      [barcode]
    );
    const catalog = catalogResult.rows[0] || null;
    if (!catalog) return res.json({ found: false, available: false, reason: "barcode_not_found" });

    const productResult = await q(
      `SELECT
         p.id,
         bp.branch_id,
         p.barcode_catalog_id,
         p.name,
         p.sku,
         p.category_id,
         p.brand,
         p.unit,
         p.cost_price,
         bp.selling_price,
         bp.stock,
         bp.reorder_level,
         bp.shelf_location,
         bp.availability,
         p.image,
         p.description,
         p.status
       FROM products p
       LEFT JOIN branch_products bp ON bp.product_id = p.id AND bp.branch_id = $1
       WHERE p.barcode_catalog_id = $2 AND p.status = 'active'
       ORDER BY p.created_at ASC, p.id ASC
       LIMIT 1`,
      [branchId, catalog.id]
    );
    const product = toProduct(productResult.rows[0]);
    if (!product || !product.branchId || product.availability === false) {
      return res.json({
        found: true,
        available: false,
        message: "This product is not available in this branch.",
        barcodeCatalog: { id: catalog.id, barcode: catalog.barcode, barcodeType: catalog.barcode_type },
      });
    }
    res.json({
      found: true,
      available: true,
      barcodeCatalog: { id: catalog.id, barcode: catalog.barcode, barcodeType: catalog.barcode_type },
      product,
    });
  } catch (error) {
    next(error);
  }
});

router.post("/catalog", async (req, res, next) => {
  try {
    const barcode = normalizeBarcode(req.body?.barcode);
    const barcodeType = req.body?.barcodeType || "code128";
    if (!validBarcode(barcode)) return res.status(400).json({ error: "invalid_barcode" });
    const catalog = await tx((client) => ensureCatalog(client, barcode, barcodeType));
    res.json({ barcodeCatalog: { id: catalog.id, barcode: catalog.barcode, barcodeType: catalog.barcode_type } });
  } catch (error) {
    next(error);
  }
});

router.post("/products", async (req, res, next) => {
  try {
    const barcode = normalizeBarcode(req.body?.barcode);
    const branchId = requestBranchId(req);
    if (!validBarcode(barcode)) return res.status(400).json({ error: "invalid_barcode" });
    if (!branchId) return res.status(400).json({ error: "branch_required" });
    if (!String(req.body?.name || "").trim()) return res.status(400).json({ error: "name_required" });

    const result = await tx(async (client) => {
      const catalog = await ensureCatalog(client, barcode, req.body?.barcodeType || "code128");
      const sku = String(req.body.sku || barcode).trim();
      const existingGlobal = await findProductByCatalog(client, catalog.id) || await findProductBySku(client, sku);
      const id = existingGlobal?.id || req.body?.id || uid("p");
      const productValues = [
        id,
        catalog.id,
        String(req.body.name).trim(),
        sku,
        req.body.categoryId || req.body.category || null,
        req.body.brand || null,
        req.body.unit || null,
        Number(req.body.costPrice || 0),
        req.body.image || req.body.imageUrl || null,
        req.body.description || null,
        req.body.status || "active",
      ];
      const byId = existingGlobal ? { rows: [existingGlobal] } : await client.query("SELECT id FROM products WHERE id = $1 LIMIT 1", [id]);
      if (byId.rows[0]) {
        await client.query(
          `UPDATE products SET
             barcode_catalog_id = $2,
             name = $3,
             sku = $4,
             category_id = $5,
             brand = $6,
             unit = $7,
             cost_price = $8,
             image = $9,
             description = $10,
             status = $11,
             updated_at = ${isMySql ? "CURRENT_TIMESTAMP" : "now()"}
           WHERE id = $1`,
          productValues
        );
      } else {
        await client.query(
          `INSERT INTO products (id, barcode_catalog_id, name, sku, category_id, brand, unit, cost_price, image, description, status)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
          productValues
        );
      }

      const branchValues = [
        branchProductId(branchId, id),
        id,
        branchId,
        Number(req.body.sellingPrice || req.body.price || 0),
        Number(req.body.stock || 0),
        Number(req.body.reorderLevel || 0),
        req.body.shelfLocation || null,
        req.body.availability === undefined ? true : Boolean(req.body.availability),
      ];
      const existingBranch = await client.query(
        "SELECT id FROM branch_products WHERE branch_id = $1 AND product_id = $2 LIMIT 1",
        [branchId, id]
      );
      if (existingBranch.rows[0]) {
        await client.query(
          `UPDATE branch_products SET
             selling_price = $4,
             stock = $5,
             reorder_level = $6,
             shelf_location = $7,
             availability = $8,
             updated_at = ${isMySql ? "CURRENT_TIMESTAMP" : "now()"}
           WHERE branch_id = $3 AND product_id = $2`,
          branchValues
        );
      } else {
        await client.query(
          `INSERT INTO branch_products (id, product_id, branch_id, selling_price, stock, reorder_level, shelf_location, availability)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
          branchValues
        );
      }

      return { catalog, product: await selectBranchProductView(client, id, branchId) };
    });
    res.json({
      barcodeCatalog: { id: result.catalog.id, barcode: result.catalog.barcode, barcodeType: result.catalog.barcode_type },
      product: result.product,
    });
  } catch (error) {
    if (error.message === "duplicate_branch_product") return res.status(409).json({ error: "duplicate_branch_product" });
    next(error);
  }
});

export default router;
