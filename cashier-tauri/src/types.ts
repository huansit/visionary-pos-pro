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

export type Product = {
  id: string;
  branchId: string;
  name: string;
  sku?: string;
  barcode?: string;
  barcodes?: string[];
  category?: string;
  categoryId?: string;
  image?: string;
  priceCents: number;
  costCents: number;
  stockQty: number;
};

export type Invoice = {
  id: string;
  number: string;
  branchId: string;
  cashierId?: string;
  customerName?: string;
  totalCents: number;
  paidCents: number;
  carriedOver?: boolean;
  status?: string;
  ts?: number;
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
  method: string;
  totalCents: number;
  items: Array<{ productId: string; name: string; qty: number; priceCents: number }>;
  ts: number;
};
