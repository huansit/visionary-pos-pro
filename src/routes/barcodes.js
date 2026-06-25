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
    categoryId: row.category_id,
    costPrice: Number(row.cost_price || 0),
    sellingPrice: Number(row.selling_price || 0),
    stock: Number(row.stock || 0),
    reorderLevel: Number(row.reorder_level || 0),
    image: row.image || "",
    status: row.status || "active",
  };
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
    const branchId = req.body?.branchId || req.deviceBranchId;
    if (!validBarcode(barcode)) return res.status(400).json({ error: "invalid_barcode" });
    if (!branchId) return res.status(400).json({ error: "branch_required" });

    const catalogResult = await q(
      "SELECT id, barcode, barcode_type, created_at FROM barcode_catalog WHERE lower(barcode) = lower($1) LIMIT 1",
      [barcode]
    );
    const catalog = catalogResult.rows[0] || null;
    if (!catalog) return res.json({ found: false, available: false, reason: "barcode_not_found" });

    const productResult = await q(
      `SELECT id, branch_id, barcode_catalog_id, name, category_id, cost_price, selling_price, stock, reorder_level, image, status
       FROM products
       WHERE branch_id = $1 AND barcode_catalog_id = $2 AND status = 'active'
       LIMIT 1`,
      [branchId, catalog.id]
    );
    const product = toProduct(productResult.rows[0]);
    if (!product) {
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
    const branchId = req.body?.branchId || req.deviceBranchId;
    if (!validBarcode(barcode)) return res.status(400).json({ error: "invalid_barcode" });
    if (!branchId) return res.status(400).json({ error: "branch_required" });
    if (!String(req.body?.name || "").trim()) return res.status(400).json({ error: "name_required" });

    const result = await tx(async (client) => {
      const catalog = await ensureCatalog(client, barcode, req.body?.barcodeType || "code128");
      const existing = await client.query(
        "SELECT id FROM products WHERE branch_id = $1 AND barcode_catalog_id = $2 LIMIT 1",
        [branchId, catalog.id]
      );
      if (existing.rows[0] && existing.rows[0].id !== req.body?.id) {
        const error = new Error("duplicate_branch_product");
        error.statusCode = 409;
        throw error;
      }

      const id = req.body?.id || uid("p");
      const values = [
        id,
        branchId,
        catalog.id,
        String(req.body.name).trim(),
        req.body.categoryId || req.body.category || null,
        Number(req.body.costPrice || 0),
        Number(req.body.sellingPrice || req.body.price || 0),
        Number(req.body.stock || 0),
        Number(req.body.reorderLevel || 0),
        req.body.image || req.body.imageUrl || null,
        req.body.status || "active",
      ];
      const byId = await client.query("SELECT id FROM products WHERE id = $1 LIMIT 1", [id]);
      if (byId.rows[0]) {
        await client.query(
          `UPDATE products SET
             branch_id = $2,
             barcode_catalog_id = $3,
             name = $4,
             category_id = $5,
             cost_price = $6,
             selling_price = $7,
             stock = $8,
             reorder_level = $9,
             image = $10,
             status = $11,
             updated_at = ${isMySql ? "CURRENT_TIMESTAMP" : "now()"}
           WHERE id = $1`,
          values
        );
      } else {
        await client.query(
          `INSERT INTO products (id, branch_id, barcode_catalog_id, name, category_id, cost_price, selling_price, stock, reorder_level, image, status)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
          values
        );
      }
      const product = await client.query(
        `SELECT id, branch_id, barcode_catalog_id, name, category_id, cost_price, selling_price, stock, reorder_level, image, status
         FROM products WHERE id = $1`,
        [id]
      );
      return { catalog, product: toProduct(product.rows[0]) };
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
