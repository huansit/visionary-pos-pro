export function activeQuickInventoryDraft(sessions, branchId) {
  return (sessions || []).find((session) => (
    session?.kind === "quick"
    && session?.status === "draft"
    && session?.branchId === branchId
  )) || null;
}

export function createQuickInventoryDraft({ id, branchId, operator, timestamp }) {
  return {
    id,
    kind: "quick",
    branchId,
    status: "draft",
    startedBy: operator,
    startedAt: timestamp,
    items: [],
    synced: false,
    updatedAt: timestamp,
  };
}

export function quickInventoryDraftCounts(session) {
  return Object.fromEntries((session?.items || [])
    .filter((item) => item?.productId && Number.isFinite(Number(item.countedQty)))
    .map((item) => [item.productId, String(Math.max(0, Number(item.countedQty)))]));
}

export function updateQuickInventoryDraftCount(session, productId, countedQty, operator, timestamp, expectedQty = null) {
  const items = (session?.items || []).filter((item) => item?.productId !== productId);
  const existing = (session?.items || []).find((item) => item?.productId === productId) || {};
  if (countedQty !== null && countedQty !== undefined && countedQty !== "") {
    items.push({
      productId,
      // The expected quantity is captured the first time a product enters the
      // draft. It must never follow later stock changes while the user is
      // counting, otherwise a retry could silently overwrite real movement.
      expectedQty: Number.isInteger(Number(existing.expectedQty)) ? Number(existing.expectedQty) : Math.max(0, Number(expectedQty) || 0),
      countedQty: Math.max(0, Number(countedQty) || 0),
      countedBy: operator,
      countedAt: timestamp,
    });
  }
  return {
    ...session,
    items,
    synced: false,
    updatedAt: timestamp,
  };
}
