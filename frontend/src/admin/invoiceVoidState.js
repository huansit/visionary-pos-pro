const text = (value) => String(value ?? "").trim();
const lower = (value) => text(value).toLowerCase();

function recordTimestamp(record) {
  return Number(record?.decidedAt || record?.requestedAt || record?.updatedAt || record?.ts || record?.serverTs || record?._serverTs || 0);
}

function newest(records) {
  return [...records].sort((a, b) => recordTimestamp(b) - recordTimestamp(a))[0] || null;
}

function sameInvoice(record, invoiceId) {
  return text(record?.invoiceId) === text(invoiceId);
}

export function invoiceVoidStateFromData(data, invoiceOrId) {
  const invoice = typeof invoiceOrId === "object"
    ? invoiceOrId
    : (data?.invoices || []).find((entry) => text(entry?.id) === text(invoiceOrId));
  const invoiceId = text(invoice?.id || invoiceOrId);
  if (!invoiceId) return { request: null, decision: null, status: "none" };

  const requests = (data?.invoiceVoidRequests || []).filter((entry) => sameInvoice(entry, invoiceId));
  const decisions = (data?.invoiceVoidDecisions || []).filter((entry) => sameInvoice(entry, invoiceId));
  const approvedDecision = newest(decisions.filter((entry) => lower(entry?.decision) === "approved"));

  if (approvedDecision) {
    const approvedRequest = requests.find((entry) => text(entry?.id) === text(approvedDecision.requestId)) || newest(requests);
    return { request: approvedRequest || null, decision: approvedDecision, status: "approved" };
  }

  const directStatus = lower(invoice?.status);
  const directVoidStatus = lower(invoice?.voidRequestStatus || invoice?.voidStatus);
  if (["void", "voided", "cancelled", "canceled"].includes(directStatus) || directVoidStatus === "approved") {
    return { request: newest(requests), decision: newest(decisions), status: "approved" };
  }

  const request = newest(requests);
  const decision = newest(decisions.filter((entry) => !request?.id || text(entry?.requestId) === text(request.id)));
  const decisionStatus = lower(decision?.decision);
  return {
    request,
    decision,
    status: decisionStatus || (request ? "pending" : "none"),
  };
}

export function invoiceIsVoidedFromData(data, invoiceOrId) {
  return invoiceVoidStateFromData(data, invoiceOrId).status === "approved";
}
