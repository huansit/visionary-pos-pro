# Product Synchronization Architecture Report

## Root cause

The normalized barcode API stored branch-specific and global product data in the same `products` row. Each branch had its own product row keyed by `(branch_id, barcode_catalog_id)`, so shared fields such as product name, SKU/barcode, category, image, and cost price were copied into every branch.

That meant a product copied into Cape Town could keep an older cost price or product name while SIPCITY had a newer one. Barcode lookup also read directly from the branch product row, so a global catalog update did not automatically appear in all branch views.

## Implemented fix

`products` is now the shared product catalog row. It stores global fields only:

- Product name
- SKU
- Barcode catalog reference
- Cost price
- Category
- Brand
- Unit
- Product image
- Description
- Status

`branch_products` stores branch-local operating fields:

- Selling price
- Current stock
- Reorder level
- Shelf location
- Availability

The barcode API now joins `products` to `branch_products` for the selected branch. Updating a global product field updates one product row, and every branch view resolves through that same shared row. Updating branch price or stock only updates the matching `branch_products` row.

The legacy offline-first `records` sync path also now propagates global product fields across matching product records by barcode catalog or barcode/SKU. It only propagates shared fields such as name, SKU, barcode, category, image, status, and cost. It leaves branch fields such as selling price and branch assignment untouched.

## Migration behavior

`npm run migrate` now includes a PostgreSQL cleanup pass for existing deployments:

1. Adds missing global columns to old `products` tables.
2. Backfills `branch_products` from the old branch-specific product rows.
3. Collapses duplicate product rows by `barcode_catalog_id`.
4. Drops the old branch/barcode uniqueness index.
5. Adds a uniqueness index for one global product per barcode catalog entry.

## Verification

Automated tests cover:

- Barcode lookup resolving to the selected branch.
- Global name and cost price changes appearing in every branch.
- Selling price remaining branch-specific.
- Stock remaining branch-specific.
- A known barcode returning "not available in this branch" when the branch has no branch product row.
- Legacy synced product records inheriting global changes while preserving branch selling price.
