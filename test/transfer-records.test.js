import assert from "node:assert/strict";
import test from "node:test";
import { normalizedTransferItems, transferUnitCount } from "../frontend/src/transferRecords.js";

test("multi-product transfers retain every product and quantity", () => {
  const transfer = {
    id: "trf-multi",
    productName: "3 products",
    qty: 4,
    items: [
      { productId: "p1", productName: "Cabernet", sku: "CAB", qty: 1 },
      { productId: "p2", productName: "Merlot", sku: "MER", qty: 2 },
      { productId: "p3", productName: "Chardonnay", sku: "CHA", qty: 1 },
    ],
  };

  assert.deepEqual(
    normalizedTransferItems(transfer).map(({ productName, sku, qty }) => ({ productName, sku, qty })),
    [
      { productName: "Cabernet", sku: "CAB", qty: 1 },
      { productName: "Merlot", sku: "MER", qty: 2 },
      { productName: "Chardonnay", sku: "CHA", qty: 1 },
    ]
  );
  assert.equal(transferUnitCount(transfer), 4);
});

test("legacy single-product transfers use current product details when needed", () => {
  const items = normalizedTransferItems(
    { productId: "p1", qty: "3" },
    [{ id: "p1", name: "Cabernet", sku: "CAB" }]
  );

  assert.deepEqual(items.map(({ productId, productName, sku, qty }) => ({ productId, productName, sku, qty })), [
    { productId: "p1", productName: "Cabernet", sku: "CAB", qty: 3 },
  ]);
});
