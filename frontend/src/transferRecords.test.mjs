import test from "node:test";
import assert from "node:assert/strict";
import { rankStockTransferSuggestions } from "./transferRecords.js";

const candidate = (overrides = {}) => ({
  productKey: "sku:test",
  productName: "Test product",
  sourceBranchId: "slow",
  destinationBranchId: "fast",
  sourceStock: 12,
  destinationStock: 0,
  sourceSold: 0,
  destinationSold: 9,
  ...overrides,
});

test("suggests moving stagnant surplus to the selling branch", () => {
  const [suggestion] = rankStockTransferSuggestions([candidate()], { days: 30 });
  assert.equal(suggestion.suggestedQty, 7);
  assert.equal(suggestion.sourceReserve, 1);
  assert.equal(suggestion.destinationTarget, 7);
  assert.equal(suggestion.confidence, "High");
});

test("does not suggest a transfer when both branches are moving similarly", () => {
  const suggestions = rankStockTransferSuggestions([candidate({ sourceSold: 4 })], { days: 30 });
  assert.deepEqual(suggestions, []);
});

test("does not suggest a transfer when destination stock covers current demand", () => {
  const suggestions = rankStockTransferSuggestions([candidate({ destinationStock: 8 })], { days: 30 });
  assert.deepEqual(suggestions, []);
});

test("does not allocate the same source surplus twice", () => {
  const suggestions = rankStockTransferSuggestions([
    candidate({ destinationBranchId: "fast-a", destinationSold: 8, sourceStock: 7 }),
    candidate({ destinationBranchId: "fast-b", destinationSold: 7, sourceStock: 7 }),
  ], { days: 30 });
  assert.equal(suggestions.reduce((sum, item) => sum + item.suggestedQty, 0), 6);
});
