export type TerminalCredentials = {
  id: string;
  uuid: string;
  branchId: string;
  terminalName: string;
  terminalSecret: string;
  status: "ACTIVE" | "DISABLED" | "REVOKED";
  appVersion?: string;
};

export type Account = {
  id: string;
  kind: string;
  name: string;
  role?: string;
  branchId: string;
  rights?: string[];
  status?: string;
};

export type Branch = {
  id: string;
  name: string;
  location?: string;
};

export type ExpenseCategory = {
  id: string;
  name: string;
  icon?: string;
  active: boolean;
  order?: number;
  serverTs?: number;
};

export type Product = {
  id: string;
  branchId: string;
  name: string;
  sku?: string;
  size?: string;
  barcode?: string;
  barcodes?: string[];
  barcodeCatalogId?: string | null;
  category?: string;
  categoryId?: string;
  status?: string;
  image?: string;
  priceCents: number;
  costCents: number;
  stockQty: number;
  serverTs?: number;
};

export type Invoice = {
  id: string;
  number: string;
  branchId: string;
  cashierId?: string;
  cashierName?: string;
  customerName?: string;
  note?: string;
  totalCents: number;
  paidCents: number;
  carriedOver?: boolean;
  status?: string;
  voidRequestStatus?: "pending" | "approved" | "rejected";
  voidRequestId?: string;
  voidReason?: string;
  voidDecisionReason?: string;
  ts?: number;
  items?: Array<{ productId?: string; name: string; qty: number; priceCents: number; unitCostCents?: number }>;
};

export type CashierJointDebtShare = {
  cashierId: string;
  cashierName: string;
  amountCents: number;
  paidCents: number;
};

export type CashierJointDebtItem = {
  productId: string;
  productName: string;
  sku?: string;
  missingQty: number;
  unitCostCents: number;
  amountCents: number;
};

export type CashierJointDebt = {
  id: string;
  branchId: string;
  stockCountSessionId?: string;
  stockCountCode: string;
  status?: string;
  shortageUnits: number;
  totalCents: number;
  cashierCount: number;
  items: CashierJointDebtItem[];
  shares: CashierJointDebtShare[];
  source?: string;
  ts: number;
};

export type StockTransferRequestItem = {
  productId: string;
  productName: string;
  sku?: string;
  qty: number;
};

export type StockTransferRequest = {
  id: string;
  fromBranchId: string;
  toBranchId: string;
  cashierId: string;
  cashierName: string;
  note?: string;
  items: StockTransferRequestItem[];
  status: "pending" | "approved" | "rejected";
  decisionReason?: string;
  transferNumber?: string;
  requestedAt: number;
  decidedAt?: number;
};

export type CartLine = {
  product: Product;
  qty: number;
};

export type CashSession = {
  id: string;
  openedAt: number;
  openingFloatCents: number;
  cashierId: string;
  cashierName: string;
};

export type Receipt = {
  number: string;
  branchName: string;
  cashierName: string;
  customerName: string;
  note?: string;
  totalCents: number;
  items: Array<{ productId: string; name: string; qty: number; priceCents: number; unitCostCents?: number }>;
  ts: number;
};

export type MpesaAllocation = {
  id: string;
  invoiceId: string;
  invoiceNumber: string;
  amountCents: number;
  status: string;
  allocatedByName?: string | null;
  allocatedAt?: string | null;
};

export type MpesaTransaction = {
  id: string;
  referenceMasked: string;
  referenceLast4: string;
  amountCents: number;
  allocatedCents: number;
  remainingCents: number;
  currency: string;
  status: string;
  tillNumber?: string | null;
  branchId: string;
  payerName?: string | null;
  payerPhoneLast4?: string | null;
  originationTime?: string | null;
  reversedAt?: string | null;
  createdAt?: string | null;
  providerVerified: boolean;
  allocations: MpesaAllocation[];
};

export type MpesaLedger = {
  enabled: boolean;
  branchId: string;
  providerRequired: boolean;
  transactions: MpesaTransaction[];
  page: { total: number; limit: number; offset: number };
  summary: {
    amountCents: number;
    allocatedCents: number;
    remainingCents: number;
    branches: Array<{
      branchId: string;
      transactionCount: number;
      amountCents: number;
      allocatedCents: number;
      remainingCents: number;
    }>;
  };
};
