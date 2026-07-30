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
  items?: Array<{ productId?: string; name: string; qty: number; priceCents: number }>;
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
  items: Array<{ productId: string; name: string; qty: number; priceCents: number }>;
  ts: number;
};
