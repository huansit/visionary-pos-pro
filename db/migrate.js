import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { isMySql, pool } from "../src/db.js";

const here = dirname(fileURLToPath(import.meta.url));

async function main() {
  const sql = readFileSync(join(here, "schema.sql"), "utf8");
  if (!isMySql) await prepareLegacyProductTable();
  await pool.query(sql);
  if (!isMySql) await normalizeProductBranchModel();
  console.log("schema applied");
  await pool.end();
}

async function hasColumn(tableName, columnName) {
  const result = await pool.query(
    `SELECT 1
     FROM information_schema.columns
     WHERE table_schema = current_schema()
       AND table_name = $1
       AND column_name = $2
     LIMIT 1`,
    [tableName, columnName]
  );
  return Boolean(result.rows[0]);
}

async function normalizeProductBranchModel() {
  const productsExist = await pool.query("SELECT to_regclass('public.products') AS table_name");
  if (!productsExist.rows[0]?.table_name) return;

  await ensureProductGlobalColumns();

  if (await hasColumn("products", "branch_id")) {
    await pool.query("ALTER TABLE products ALTER COLUMN branch_id DROP NOT NULL");
    await pool.query(`
      WITH canonical AS (
        SELECT barcode_catalog_id, MIN(id) AS product_id
        FROM products
        WHERE barcode_catalog_id IS NOT NULL
        GROUP BY barcode_catalog_id
      )
      INSERT INTO branch_products (
        id,
        product_id,
        branch_id,
        selling_price,
        stock,
        reorder_level,
        availability,
        created_at,
        updated_at
      )
      SELECT
        LEFT('bp_' || regexp_replace(p.branch_id, '[^A-Za-z0-9._-]', '_', 'g') || '_' || c.product_id, 180),
        c.product_id,
        p.branch_id,
        COALESCE(p.selling_price, 0),
        COALESCE(p.stock, 0),
        COALESCE(p.reorder_level, 0),
        true,
        COALESCE(p.created_at, now()),
        COALESCE(p.updated_at, now())
      FROM products p
      JOIN canonical c ON c.barcode_catalog_id = p.barcode_catalog_id
      WHERE p.branch_id IS NOT NULL
      ON CONFLICT (branch_id, product_id) DO UPDATE SET
        selling_price = EXCLUDED.selling_price,
        stock = EXCLUDED.stock,
        reorder_level = EXCLUDED.reorder_level,
        availability = EXCLUDED.availability,
        updated_at = EXCLUDED.updated_at
    `);
    await pool.query(`
      WITH canonical AS (
        SELECT barcode_catalog_id, MIN(id) AS product_id
        FROM products
        WHERE barcode_catalog_id IS NOT NULL
        GROUP BY barcode_catalog_id
      )
      DELETE FROM products p
      USING canonical c
      WHERE p.barcode_catalog_id = c.barcode_catalog_id
        AND p.id <> c.product_id
    `);
    await pool.query("DROP INDEX IF EXISTS products_branch_barcode_catalog_unique_idx");
  }

  await pool.query(`
    UPDATE products p
    SET sku = COALESCE(NULLIF(p.sku, ''), bc.barcode)
    FROM barcode_catalog bc
    WHERE p.barcode_catalog_id = bc.id
      AND (p.sku IS NULL OR p.sku = '')
  `);
  await pool.query("CREATE UNIQUE INDEX IF NOT EXISTS products_barcode_catalog_unique_idx ON products (barcode_catalog_id)");
}

async function prepareLegacyProductTable() {
  const productsExist = await pool.query("SELECT to_regclass('public.products') AS table_name");
  if (!productsExist.rows[0]?.table_name) return;
  await ensureProductGlobalColumns();
}

async function ensureProductGlobalColumns() {
  for (const [column, type] of [["sku", "text"], ["brand", "text"], ["unit", "text"], ["description", "text"]]) {
    if (!(await hasColumn("products", column))) {
      await pool.query(`ALTER TABLE products ADD COLUMN ${column} ${type}`);
    }
  }
}

main().catch((error) => {
  console.error("migration failed:", error);
  process.exit(1);
});
