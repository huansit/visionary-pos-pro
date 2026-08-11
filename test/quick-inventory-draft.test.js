import test from "node:test";
import assert from "node:assert/strict";
import {
  activeQuickInventoryDraft,
  createQuickInventoryDraft,
  quickInventoryDraftCounts,
  updateQuickInventoryDraftCount,
} from "../frontend/src/admin/quickInventoryDraft.js";

test("quick inventory draft saves, restores, updates, and removes branch counts", () => {
  const draft = createQuickInventoryDraft({
    id: "qid-1",
    branchId: "b_cpt",
    operator: "Admin",
    timestamp: 100,
  });
  const first = updateQuickInventoryDraftCount(draft, "product-a", 7, "Admin", 110);
  const second = updateQuickInventoryDraftCount(first, "product-b", 0, "Admin", 120);

  assert.deepEqual(quickInventoryDraftCounts(second), { "product-a": "7", "product-b": "0" });
  assert.equal(activeQuickInventoryDraft([second], "b_cpt")?.id, "qid-1");
  assert.equal(activeQuickInventoryDraft([second], "b_sip"), null);

  const updated = updateQuickInventoryDraftCount(second, "product-a", 9, "Supervisor", 130);
  assert.deepEqual(quickInventoryDraftCounts(updated), { "product-b": "0", "product-a": "9" });
  assert.equal(updated.items.find((item) => item.productId === "product-a").countedBy, "Supervisor");

  const removed = updateQuickInventoryDraftCount(updated, "product-a", null, "Supervisor", 140);
  assert.deepEqual(quickInventoryDraftCounts(removed), { "product-b": "0" });
});
