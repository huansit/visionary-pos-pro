import { useState, useEffect, useLayoutEffect, useRef, useMemo } from "react";
import { buildReportDocument, ReportPreviewDialog } from "./components/reports/ReportEngine.jsx";
import { printReport, downloadPDF } from "./services/PrintService.js";
import { productDisplayImage } from "./productImages.js";
import { nextTransferNumber, normalizedTransferItems, transferUnitCount } from "./transferRecords.js";
import "./styles/print.css";
import {
  Lock, Delete, Mail, Eye, EyeOff, ArrowLeft, ArrowRight, Plus, Trash2, ShieldCheck, LogOut, Check, Edit, KeyRound,
  AlertCircle, Search, Wifi, WifiOff, RefreshCw, X, Package, Users, BarChart3, Tag, Tags,
  Minus, CreditCard, Banknote, Receipt, Printer, ShoppingCart, FileText, LayoutDashboard,
  Boxes, Truck, Building2, ArrowLeftRight, Wallet, TrendingDown, Files, Settings as SettingsIcon,
  Smartphone, ShoppingBag, Wine, Sparkles, Moon, Sun, ArrowUp, MoreVertical, ChevronLeft, ChevronRight, ChevronDown,
  Barcode, ClipboardCheck, Download, Fingerprint, MonitorDown,
  Wrench, Phone, Zap, Home, Circle, Camera,
} from "lucide-react";

/* ================================================================== */
/*  Local-first storage                                               */
/* ================================================================== */
const STORE_KEY = "visionary:pos:full:v11";
const SESSION_KEY = "visionary:pos:session:v1";
const OUTBOX_KEY = "visionary:pos:sync:outbox:v1";
const CURSOR_KEY = "visionary:pos:sync:cursor:v1";
const RESET_EPOCH_KEY = "visionary:pos:sync:reset-epoch:v1";
const API_BASE_KEY = "visionary:sync:apiBaseUrl";
const DEVICE_TOKEN_KEY = "visionary:sync:deviceToken";
const BARCODE_CACHE_KEY = "visionary:pos:barcode-cache:v1";
const BARCODE_LOG_KEY = "visionary:pos:barcode-log:v1";
const MAINTENANCE_META_KEY = "visionary:maintenance:meta:v1";
const MAINTENANCE_LOG_KEY = "visionary:maintenance:audit:v1";
const CACHE_KEY_PREFIXES = ["visionary:cache:", "visionary:api-cache:", "visionary:tmp:", "visionary:image-cache:"];
const SETTINGS_KEYS = [API_BASE_KEY, DEVICE_TOKEN_KEY, "visionary:sync:deviceId"];
const AUTH_KEYS = [SESSION_KEY, DEVICE_TOKEN_KEY];
const SYNC_QUEUE_KEYS = [OUTBOX_KEY, CURSOR_KEY, RESET_EPOCH_KEY];
const PROTECTED_STORAGE_KEYS = new Set([STORE_KEY, SESSION_KEY, OUTBOX_KEY, CURSOR_KEY, RESET_EPOCH_KEY, API_BASE_KEY, DEVICE_TOKEN_KEY, BARCODE_CACHE_KEY, BARCODE_LOG_KEY, MAINTENANCE_META_KEY, MAINTENANCE_LOG_KEY, "visionary:sync:deviceId"]);
const REALTIME_SYNC_MS = 5000;
const REALTIME_RECONNECT_MS = 4000;
const AUTO_LOGOUT_MS = 15 * 60 * 1000;
const SESSION_ACTIVITY_WRITE_MS = 5000;
const LIGHT_MAINTENANCE_MS = 60 * 60 * 1000;
const DEEP_MAINTENANCE_MS = 24 * 60 * 60 * 1000;
let activeSessionToken = "";
const now = () => Date.now();
const uid = (p = "id") => p + "_" + Math.random().toString(36).slice(2, 9);
const todayStr = () => new Date().toISOString().slice(0, 10);
const DEFAULT_EXPENSE_CATEGORIES = [
  { id: "excat_transport", name: "Transport", icon: "truck", active: true, order: 10, synced: true },
  { id: "excat_repairs", name: "Repairs", icon: "wrench", active: true, order: 20, synced: true },
  { id: "excat_supplies", name: "Supplies", icon: "package", active: true, order: 30, synced: true },
  { id: "excat_airtime", name: "Airtime", icon: "phone", active: true, order: 40, synced: true },
  { id: "excat_police", name: "Police", icon: "shield", active: true, order: 50, synced: true },
  { id: "excat_utilities", name: "Utilities", icon: "zap", active: true, order: 60, synced: true },
  { id: "excat_rent", name: "Rent", icon: "home", active: true, order: 70, synced: true },
  { id: "excat_salaries", name: "Salaries", icon: "users", active: true, order: 80, synced: true },
  { id: "excat_stock", name: "Stock", icon: "boxes", active: true, order: 90, synced: true },
  { id: "excat_other", name: "Other", icon: "circle", active: true, order: 999, synced: true },
];
const CASHIER_EXPENSE_CATEGORY_NAMES = new Set(["police", "utilities", "other"]);
const CASHIER_EXPENSE_CATEGORY_IDS = new Set(["excat_police", "excat_utilities", "excat_other"]);
const EXPENSE_CATEGORY_ICON_OPTIONS = [
  ["wallet", "Wallet"],
  ["truck", "Transport"],
  ["wrench", "Repairs"],
  ["package", "Supplies"],
  ["phone", "Airtime"],
  ["zap", "Utilities"],
  ["shield", "Security"],
  ["home", "Rent"],
  ["users", "Staff"],
  ["boxes", "Stock"],
  ["circle", "Other"],
];
const EXPENSE_CATEGORY_ICONS = {
  wallet: Wallet,
  truck: Truck,
  wrench: Wrench,
  package: Package,
  phone: Phone,
  zap: Zap,
  shield: ShieldCheck,
  home: Home,
  users: Users,
  boxes: Boxes,
  circle: Circle,
};
function normalizeExpenseCategory(cat, idx = 0) {
  if (typeof cat === "string") return { id: "excat_" + cat.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_|_$/g, ""), name: cat, icon: "circle", active: true, order: idx * 10, synced: true };
  return {
    id: cat?.id || uid("excat"),
    name: String(cat?.name || "Other").trim() || "Other",
    icon: cat?.icon || "circle",
    active: cat?.active !== false,
    order: Number.isFinite(Number(cat?.order)) ? Number(cat.order) : idx * 10,
    synced: cat?.synced !== false,
    updatedAt: cat?.updatedAt,
  };
}
function expenseCategories(data, { activeOnly = false } = {}) {
  const source = Array.isArray(data?.expenseCategories) && data.expenseCategories.length ? data.expenseCategories : DEFAULT_EXPENSE_CATEGORIES;
  return source
    .map(normalizeExpenseCategory)
    .filter((cat) => !activeOnly || cat.active !== false)
    .sort((a, b) => (a.order ?? 0) - (b.order ?? 0) || a.name.localeCompare(b.name));
}
function cashierExpenseCategories(data) {
  const cats = expenseCategories(data, { activeOnly: true }).filter((cat) => CASHIER_EXPENSE_CATEGORY_IDS.has(cat.id) || CASHIER_EXPENSE_CATEGORY_NAMES.has(cat.name.toLowerCase()));
  return cats.length ? cats : DEFAULT_EXPENSE_CATEGORIES.filter((cat) => CASHIER_EXPENSE_CATEGORY_NAMES.has(cat.name.toLowerCase())).map(normalizeExpenseCategory);
}
function adminExpenseCategories(data) {
  const cats = expenseCategories(data, { activeOnly: true }).filter((cat) => !CASHIER_EXPENSE_CATEGORY_IDS.has(cat.id) && !CASHIER_EXPENSE_CATEGORY_NAMES.has(cat.name.toLowerCase()));
  return cats.length ? cats : DEFAULT_EXPENSE_CATEGORIES.filter((cat) => !CASHIER_EXPENSE_CATEGORY_NAMES.has(cat.name.toLowerCase())).map(normalizeExpenseCategory);
}
function firstExpenseCategoryName(data) {
  return expenseCategories(data, { activeOnly: true })[0]?.name || "Other";
}
function ExpenseCategoryIcon({ icon, style }) {
  const Icon = EXPENSE_CATEGORY_ICONS[icon] || Wallet;
  return <Icon style={{ width: 17, height: 17, ...(style || {}) }} />;
}

const SEED = () => {
  const t = now();
  const branches = [
    { id: "b_sip", name: "SIPCITY", code: "SIP", location: "SIPCITY", managerId: "e1", active: true, mpesaTill: "5204512", synced: true },
    { id: "b_cpt", name: "Cape Town", code: "CPT", location: "Cape Town", managerId: null, active: true, mpesaTill: "5208830", synced: true },
  ];
  const P = [
    ["SIP0001","ALL SEASONS WHISKY 250ML","SIP0001","250 ML","Whisky",50000,39500,6],
    ["SIP0002","ALL SEASONS WHISKY 375ML","SIP0002","375 ML","Whisky",70000,59000,0],
    ["SIP0003","ALL SEASONS WHISKY 750ML","SIP0003","750 ML","Whisky",150000,116000,0],
    ["SIP0004","ASCONI PASTORAL 750ML","SIP0004","750 ML","Wine",200000,165000,3],
    ["SIP0005","ASCONI RED 750ML","SIP0005","750 ML","Wine",200000,0,0],
    ["SIP0006","ASCONI WHITE 750MI","SIP0006","750 ML","Wine",200000,0,0],
    ["SIP0007","BAILEYS CREAM 750ML","SIP0007","750 ML","Spirits",300000,230000,1],
    ["SIP0008","BALLENTINES","SIP0008","","Whisky",280000,185000,0],
    ["SIP0009","BEST GIN 250ML","SIP0009","250 ML","Gin",40000,26000,0],
    ["SIP0010","BEST GIN 750ML","SIP0010","750 ML","Gin",100000,73500,0],
    ["SIP0011","BEST VODKA 250ML","SIP0011","250 ML","Vodka",40000,24500,1],
    ["SIP0012","BEST VODKA 750ML","SIP0012","750 ML","Vodka",95000,69500,4],
    ["SIP0013","BEST WHISKY 250ML","SIP0013","250 ML","Whisky",45000,0,0],
    ["SIP0014","BEST WHISKY 750ML","SIP0014","750 ML","Whisky",140000,109500,7],
    ["SIP0015","BLACK LABEL WHISKY 1L","SIP0015","1 L","Whisky",480000,385000,5],
    ["SIP0016","BLACK LABEL WHISKY 350ML","SIP0016","350 ML","Whisky",220000,174500,0],
    ["SIP0017","BLACK LABEL WHISKY 750ML","SIP0017","750 ML","Whisky",350000,312000,0],
    ["SIP0018","BLACK N WHITE WHISKY 375ML","SIP0018","375 ML","Whisky",75000,58469,7],
    ["SIP0019","BLACK N WHITE WHISKY 750ML","SIP0019","750 ML","Whisky",140000,111000,4],
    ["SIP0020","BLACKBIRD WINE 750ML","SIP0020","750 ML","Wine",120000,93000,0],
    ["SIP0021","BLUE ICE VODKA 250ML","SIP0021","250 ML","Vodka",25000,0,0],
    ["SIP0022","BOND 7 WHISKY 350ML","SIP0022","350 ML","Whisky",75000,57000,2],
    ["SIP0023","BOND 7 WHISKY 250ML","SIP0023","250 ML","Whisky",55000,41300,20],
    ["SIP0024","BOND 7 WHISKY 750ML","SIP0024","750 ML","Whisky",150000,125000,8],
    ["SIP0025","CAPRICE WINE 1L","SIP0025","1 L","Wine",110000,83750,5],
    ["SIP0026","CAPTAIN MORGAN 250ML","SIP0026","250 ML","Spirits",45000,33506,11],
    ["SIP0027","CAPTAIN MORGAN 750ML","SIP0027","750 ML","Spirits",120000,94199,11],
    ["SIP0028","CARIBIA GIN 250ML","SIP0028","250 ML","Gin",35000,24500,11],
    ["SIP0029","CARIBIA GIN 750ML","SIP0029","750 ML","Gin",90000,72000,9],
    ["SIP0030","CASABUENA RED","SIP0030","","Wine",90000,70000,1],
    ["SIP0031","CASABUENA WHITE","SIP0031","","Wine",90000,73500,3],
    ["SIP0032","CELLAR CASK WHITE","SIP0032","","Wine",130000,99500,1],
    ["SIP0033","CELLAR CASK RED","SIP0033","","Wine",130000,89000,4],
    ["SIP0034","CHROME GIN 250ML","SIP0034","250 ML","Gin",35000,21000,0],
    ["SIP0035","CHROME GIN 750ML","SIP0035","750 ML","Gin",80000,57500,0],
    ["SIP0036","CHROME VODKA 250ML","SIP0036","250 ML","Vodka",35000,21000,4],
    ["SIP0037","CHROME VODKA 750ML","SIP0037","750 ML","Vodka",80000,57500,2],
    ["SIP0038","COUNTY BRANDY 250ML","SIP0038","250 ML","Spirits",30000,23500,11],
    ["SIP0039","COUNTY BRANDY 750ML","SIP0039","750 ML","Spirits",90000,65000,2],
    ["SIP0040","DELMONTE 1L","SIP0040","1 L","Extras",35000,24813,33],
    ["SIP0041","FAMOUS GROUSE WHISKY 1L","SIP0041","1 L","Whisky",300000,218000,1],
    ["SIP0042","FAMOUS GROUSE WHISKY 750ML","SIP0042","750 ML","Whisky",250000,185000,1],
    ["SIP0043","FOUR COUSINS WINE 750ML","SIP0043","750 ML","Wine",120000,85000,1],
    ["SIP0044","FOURTH STREET WINE 750ML","SIP0044","750 ML","Wine",110000,0,0],
    ["SIP0045","GENERAL MEAKINS 250ML","SIP0045","250 ML","Spirits",35000,20000,6],
    ["SIP0046","GENERAL MEAKINS 750ML","SIP0046","750 ML","Spirits",90000,65500,2],
    ["SIP0047","GILBEYS GIN 250ML","SIP0047","250 ML","Gin",55000,41150,4],
    ["SIP0048","GILBEYS GIN 350ML","SIP0048","350 ML","Gin",75000,57000,6],
    ["SIP0049","GILBEYS GIN 750ML","SIP0049","750 ML","Gin",150000,123000,1],
    ["SIP0050","GORDONS CAN","SIP0050","","Beer",30000,19500,0],
    ["SIP0051","GORDONS GIN 1L","SIP0051","1 L","Gin",300000,210000,2],
    ["SIP0052","GORDONS GIN 750ML","SIP0052","750 ML","Gin",230000,200000,3],
    ["SIP0053","GRANTS WHISKY 1L","SIP0053","1 L","Whisky",270000,0,0],
    ["SIP0054","GRANTS WHISKY 350ML","SIP0054","350 ML","Whisky",100000,90333,0],
    ["SIP0055","GRANTS WHISKY 750ML","SIP0055","750 ML","Whisky",230000,170000,5],
    ["SIP0056","GUINESS CAN","SIP0056","","Beer",30000,21500,9],
    ["SIP0057","HAMPTONS WHISKY 750ML","SIP0057","750 ML","Whisky",180000,0,0],
    ["SIP0058","HENNESSY VS 1L","SIP0058","1 L","Spirits",900000,716300,0],
    ["SIP0059","HENNESSY VS 750ML","SIP0059","750 ML","Spirits",650000,480000,0],
    ["SIP0060","HUNTERS CHOICE WHISKY 250ML","SIP0060","250 ML","Whisky",40000,30500,6],
    ["SIP0061","HUNTERS CHOICE WHISKY 350ML","SIP0061","350 ML","Whisky",60000,42910,12],
    ["SIP0062","HUNTERS CHOICE WHISKY 750ML","SIP0062","750 ML","Whisky",120000,92968,6],
    ["SIP0063","JACK DANIELS 1LTR","SIP0063","1 L","Whisky",450000,330000,0],
    ["SIP0064","JAGERMEISTER WHISKY 1L","SIP0064","1 L","Whisky",350000,285000,0],
    ["SIP0065","JAGERMEISTER WHISKY 750ML","SIP0065","750 ML","Whisky",300000,226667,1],
    ["SIP0066","JAMESON WHISKY 1L","SIP0066","1 L","Whisky",380000,305000,0],
    ["SIP0067","JAMESON WHISKY 350ML","SIP0067","350 ML","Whisky",150000,0,0],
    ["SIP0068","JAMESON WHISKY 750ML","SIP0068","750 ML","Whisky",300000,249333,4],
    ["SIP0069","JOHN BARR BLACK 750ML","SIP0069","750 ML","Whisky",190000,155000,3],
    ["SIP0070","JOHN BARR RED WHISKY 1L","SIP0070","1 L","Whisky",220000,160000,0],
    ["SIP0071","KC GINGER 250ML","SIP0071","250 ML","Gin",35000,25500,12],
    ["SIP0072","KC GINGER 750ML","SIP0072","750 ML","Gin",90000,67216,14],
    ["SIP0073","KC PINEAPPLE 250ML","SIP0073","250 ML","Spirits",35000,25833,30],
    ["SIP0074","KC PINEAPPLE 750ML","SIP0074","750 ML","Spirits",90000,67636,16],
    ["SIP0075","KC SMOOTH 250ML","SIP0075","250 ML","Spirits",35000,25500,9],
    ["SIP0076","KC SMOOTH 750ML","SIP0076","750 ML","Spirits",90000,67500,0],
    ["SIP0077","KIBAO VODKA 250ML","SIP0077","250 ML","Vodka",30000,22700,2],
    ["SIP0078","KIBAO VODKA 350ML","SIP0078","350 ML","Vodka",40000,35000,3],
    ["SIP0079","KIBAO VODKA 750ML","SIP0079","750 ML","Vodka",90000,63800,2],
    ["SIP0080","KO 330ML","SIP0080","330 ML","Beer",30000,23000,0],
    ["SIP0081","KONYAGI 250ML","SIP0081","250 ML","Spirits",35000,22000,4],
    ["SIP0082","KONYAGI 500ML","SIP0082","500 ML","Spirits",70000,52500,2],
    ["SIP0083","KONYAGI 750ML","SIP0083","750 ML","Spirits",90000,63000,0],
    ["SIP0084","MANYATTA CAN","SIP0084","","Beer",30000,24488,1],
    ["SIP0085","MONSTER","SIP0085","","Extras",30000,21128,17],
    ["SIP0086","OJ CAN","SIP0086","","Beer",40000,35500,8],
    ["SIP0087","ORIJIN SPIRIT 250ML","SIP0087","250 ML","Spirits",35000,23500,3],
    ["SIP0088","ORIJIN SPIRIT 750ML","SIP0088","750 ML","Spirits",80000,62500,2],
    ["SIP0089","PILSNER CAN","SIP0089","","Beer",30000,20200,3],
    ["SIP0090","RED LABEL WHISKY 1L","SIP0090","1 L","Whisky",270000,205000,2],
    ["SIP0091","RED LABEL WHISKY 350L","SIP0091","350 L","Whisky",120000,88000,0],
    ["SIP0092","RED LABEL WHISKY 750ML","SIP0092","750 ML","Whisky",200000,169000,1],
    ["SIP0093","REDBULL CAN","SIP0093","","Extras",30000,18500,34],
    ["SIP0094","RESERVE 7 WHISKY 750ML","SIP0094","750 ML","Whisky",140000,105000,1],
    ["SIP0095","RICHOT BRANDY 250ML","SIP0095","250 ML","Spirits",55000,41500,9],
    ["SIP0096","RICHOT BRANDY 350ML","SIP0096","350 ML","Spirits",80000,57600,2],
    ["SIP0097","RICHOT BRANDY 750ML","SIP0097","750 ML","Spirits",150000,125429,1],
    ["SIP0098","ROBERTSON WINE 750ML","SIP0098","750 ML","Wine",170000,103544,9],
    ["SIP0099","SAVANNAH CAN","SIP0099","","Beer",30000,0,0],
    ["SIP0100","SMIRNOFF BLACK ICE","SIP0100","","Spirits",25000,17760,4],
    ["SIP0101","SMIRNOFF ICE GUARANA","SIP0101","","Beer",25000,17620,10],
    ["SIP0102","SMIRNOFF VODKA 250ML","SIP0102","250 ML","Vodka",55000,41800,4],
    ["SIP0103","SMIRNOFF VODKA 350ML","SIP0103","350 ML","Vodka",80000,57600,6],
    ["SIP0104","SMIRNOFF VODKA 750ML","SIP0104","750 ML","Vodka",150000,124000,13],
    ["SIP0105","TANQUERAY GIN 750ML","SIP0105","750 ML","Gin",300000,248500,1],
    ["SIP0106","TRIPPLE ACE 250ML","SIP0106","250 ML","Spirits",30000,19900,5],
    ["SIP0107","TRIPPLE ACE 750ML","SIP0107","750 ML","Spirits",80000,56000,4],
    ["SIP0108","TUSKER CIDER CAN","SIP0108","","Beer",30000,23500,9],
    ["SIP0109","TUSKER LAGER CAN","SIP0109","","Beer",30000,20363,35],
    ["SIP0110","TUSKER LITE CAN","SIP0110","","Beer",30000,24500,12],
    ["SIP0111","TUSKER MALT CAN","SIP0111","","Beer",30000,24500,0],
    ["SIP0112","V&A WINE 250ML","SIP0112","250 ML","Wine",40000,0,0],
    ["SIP0113","V&A WINE 750ML","SIP0113","750 ML","Wine",110000,78000,0],
    ["SIP0114","VAT 69 SCOTCH WHISKY 350ML","SIP0114","350 ML","Whisky",95000,76417,5],
    ["SIP0115","VAT 69 SCOTCH WHISKY 750ML","SIP0115","750 ML","Whisky",180000,145000,8],
    ["SIP0116","VICEROY BRANDY 250ML","SIP0116","250 ML","Spirits",55000,43726,16],
    ["SIP0117","VICEROY BRANDY 350ML","SIP0117","350 ML","Spirits",80000,64500,9],
    ["SIP0118","VICEROY BRANDY 750ML","SIP0118","750 ML","Spirits",150000,124941,14],
    ["SIP0119","WHITECAP CAN","SIP0119","","Beer",30000,21650,41],
    ["SIP0120","WILLIAM LAWSONS WHISKY 350ML","SIP0120","350 ML","Whisky",110000,0,0],
    ["SIP0121","WILLIAM LAWSONS WHISKY 750ML","SIP0121","750 ML","Whisky",200000,160000,3],
    ["SIP0122","AMARULA 750ML","SIP0122","750 ML","Spirits",280000,0,0],
    ["SIP0123","AMARULA 350ML","SIP0123","350 ML","Spirits",150000,0,0],
    ["SIP0124","DOUBLE BLACK 1L","SIP0124","1 L","Spirits",650000,510000,0],
    ["SIP0125","CAMINO 750ML","SIP0125","750 ML","Spirits",350000,0,0],
    ["SIP0126","JOSE CUERVO 750ML","SIP0126","750 ML","Spirits",350000,0,0],
    ["SIP0127","MARTEL VS 750ML","SIP0127","750 ML","Spirits",650000,480000,0],
    ["SIP0128","MARTEL VS 1L","SIP0128","1 L","Spirits",900000,670000,0],
    ["SIP0129","WATER 1L","SIP0129","1 L","Extras",8000,4200,0],
    ["SIP0130","COKE 1.25 L","SIP0130","1.25 L","Extras",16000,12605,23],
    ["SIP0131","SNAPP","SIP0131","","Beer",25000,17800,0],
    ["SIP0132","HEINEKEN CAN","SIP0132","","Beer",35000,29170,26],
    ["SIP0133","HEINEKEN BOTTLE","SIP0133","","Beer",30000,24429,25],
    ["SIP0134","TUSKER CIDER 300ML","SIP0134","300 ML","Beer",27000,0,0],
    ["SIP0135","TUSKER LAGER 500ML","SIP0135","500 ML","Beer",25000,0,0],
    ["SIP0136","TUSKER LITE BOTTLE 330ML","SIP0136","330 ML","Beer",25000,0,0],
    ["SIP0137","GUINNESS 500ML","SIP0137","500 ML","Beer",27000,0,0],
    ["SIP0138","HUNTERS DRY 500ML","SIP0138","500 ML","Beer",30000,0,0],
    ["SIP0139","MACMOHAN","SIP0139","","Spirits",150000,112000,2],
    ["SIP0140","SMIRNOFF PINEAPPLE PUNCH","SIP0140","","Spirits",25000,17865,40],
    ["SIP0141","SODA 500ML","SIP0141","500 ML","Extras",8000,6146,8],
    ["SIP0142","PREDATOR","SIP0142","","Extras",8000,5417,0],
    ["SIP0143","LEMONADE","SIP0143","","Extras",6000,4000,38],
    ["SIP0144","SAVANNA DRY 330ML","SIP0144","330 ML","Beer",30000,22500,0],
    ["SIP0145","WATER 500ML","SIP0145","500 ML","Extras",6000,2200,0],
    ["SIP0146","JOSE CUEVO  GOLD 750ML","SIP0146","750 ML","Spirits",300000,245000,0],
    ["SIP0147","JOSE  CUEVO SILVER 750ML","SIP0147","750 ML","Spirits",320000,255000,0],
    ["SIP0148","JOHN BARR RED 750ML","SIP0148","750 ML","Whisky",200000,150000,0],
    ["SIP0149","DOUBLE BLACK 750ML","SIP0149","750 ML","Spirits",500000,410000,0],
    ["SIP0150","BALOZI CAN","SIP0150","","Beer",27000,20387,28],
    ["SIP0151","SODA 2L","SIP0151","2 L","Extras",20000,17583,13],
    ["SIP0152","HENNESSY VSOP 1L","SIP0152","1 L","Spirits",1600000,1200000,0],
    ["SIP0153","FAXE CAN","SIP0153","","Beer",35000,28500,7],
    ["SIP0154","DASANI 1L","SIP0154","1 L","Extras",10000,4832,0],
    ["SIP0155","CAPTAIN MELON SPLASH 750ML","SIP0155","750 ML","Spirits",140000,111000,6],
    ["SIP0156","CAPTAIN MELON SPLASH 250ML","SIP0156","250 ML","Spirits",50000,36168,6],
    ["SIP0157","SIPCITY HOODIE","SIP0157","","Extras",250000,34000,0],
    ["SIP0158","SIPCITY TSHIRT","SIP0158","","Extras",100000,21667,0],
    ["SIP0159","SIPCITY CAP","SIP0159","","Extras",50000,26000,0],
    ["SIP0160","AQUA WATER","SIP0160","","Extras",8000,2668,0],
    ["SIP0161","BAILEYS 700ML","SIP0161","700 ML","Spirits",250000,200000,2],
    ["SIP0162","COKE 1L","SIP0162","1 L","Extras",13000,8708,0],
    ["SIP0163","SPRITE","SIP0163","","Extras",20000,17700,0],
    ["SIP0164","SAFARI WATER","SIP0164","","Extras",8000,4200,0],
    ["SIP0165","REMY MARTIN VSOP 750ML","SIP0165","750 ML","Spirits",1000000,695000,0],
    ["SIP0166","REMY MARTIN VSOP 1L","SIP0166","1 L","Spirits",1200000,820000,0],
    ["SIP0167","JOHN BARR BLACK 1L","SIP0167","1 L","Whisky",230000,170000,7],
    ["SIP0168","KC SMOOTH 350ML","SIP0168","350 ML","Spirits",50000,36000,7],
    ["SIP0169","ESSENTIAL WATER","SIP0169","","Extras",10000,4600,51],
    ["SIP0170","ALL SEASONS 1L","SIP0170","1 L","Spirits",170000,116000,0],
    ["SIP0171","8 PM 1L","SIP0171","1 L","Spirits",140000,107571,3],
    ["SIP0172","MANYATTA BOTTLE","SIP0172","","Beer",30000,22400,24],
    ["SIP0173","JINRO GRAPEFRUIT SOJU 330ML","SIP0173","330 ML","Spirits",45000,36000,4],
    ["SIP0174","JINRO LEMON SOJU 330L","SIP0174","330 L","Spirits",45000,36000,7],
    ["SIP0175","JINRO LEMON SOJU 330ML","SIP0175","330 ML","Spirits",45000,36000,7],
    ["SIP0176","MOET & CHANDON","SIP0176","","Spirits",1500000,870000,0],
    ["SIP0177","HENNESSY XO","SIP0177","","Spirits",4800000,3500000,0],
    ["SIP0178","SINGLETON 12YRS","SIP0178","12 YRS","Whisky",900000,560000,0],
    ["SIP0179","DON JULIO 1942","SIP0179","","Spirits",4000000,2800000,0],
    ["SIP0180","JAGERMEISTER 1L CORKED","SIP0180","1 L","Spirits",450000,320000,0],
    ["SIP0181","HUNTERS DRY 330ML","SIP0181","330 ML","Beer",30000,20500,6],
  ];
  const IMG_BASE = "https://res.cloudinary.com/drge557ut/image/upload/";
  const IMAGES = {
    "SIP0001": "sip-001-all-seasons-whisky-250ml_vkfzzf",
    "SIP0002": "sip-002-all-seasons-whisky-375ml-web_ghitij",
    "SIP0003": "sip-003-all-seasons-whisky-750ml_j0mce8",
    "SIP0004": "sip-004-asconi-pastoral-750ml-web_fzfdve",
    "SIP0005": "sip-005-asconi-red-750ml-web_kssi6a",
    "SIP0006": "sip-006-asconi-white-750ml-web_vqpket",
    "SIP0007": "sip-007-baileys-cream-750ml-web_z4ocae",
    "SIP0008": "sip-008-ballentines-web_gpbyov",
    "SIP0009": "sip-009-best-gin-250ml_ghpmlz",
    "SIP0010": "sip-010-best-gin-750ml_bsn2gd",
    "SIP0011": "sip-011-best-vodka-250ml_zq4ixw",
    "SIP0012": "sip-012-best-vodka-750ml-web_oow5xm",
    "SIP0013": "sip-013-best-whisky-250ml_mzss1i",
    "SIP0014": "sip-014-best-whisky-750ml_szrc8p",
    "SIP0015": "sip-015-black-label-whisky-1l_zsr3fi",
    "SIP0016": "sip-016-black-label-whisky-350ml_xzhrhp",
    "SIP0017": "sip-017-black-label-whisky-750ml_bhgpyu",
    "SIP0018": "sip-018-black-n-white-whisky-375ml-web_gdfllk",
    "SIP0019": "sip-019-black-n-white-whisky-750ml-web_rj30yv",
    "SIP0020": "sip-020-blackbird-wine-750ml-web_i8jmog",
    "SIP0021": "sip-021-blue-ice-vodka-250ml_vsv7kc",
    "SIP0022": "sip-022-bond-7-whisky-350ml-web_wvwq3e",
    "SIP0023": "sip-023-bond-7-whisky-250ml-web_ydeppx",
    "SIP0024": "sip-024-bond-7-whisky-750ml-web_hmk6kt",
    "SIP0025": "sip-025-caprice-wine-1l-web_updpya",
    "SIP0026": "sip-026-captain-morgan-250ml_dvllzu",
    "SIP0027": "sip-027-captain-morgan-750ml_gugeed",
    "SIP0028": "sip-028-caribia-gin-250ml-web_qkimg1",
    "SIP0029": "sip-029-caribia-gin-750ml_vlzvxi",
    "SIP0030": "sip-030-casabuena-red-web_x6wqto",
    "SIP0031": "sip-031-casabuena-white_nudc0g",
    "SIP0032": "sip-032-cellar-cask-white-web_cfrme7",
    "SIP0033": "sip-033-cellar-cask-red-web_rjtvxr",
    "SIP0034": "sip-034-chrome-gin-250ml_auo9ma",
    "SIP0035": "sip-035-chrome-gin-750ml_ysqc3n",
    "SIP0036": "sip-036-chrome-vodka-250ml_ctwub2",
    "SIP0037": "sip-037-chrome-vodka-750ml_semlvf",
    "SIP0038": "sip-038-county-brandy-250ml-web_eocpsr",
    "SIP0039": "sip-039-county-brandy-750ml-web_awjjau",
    "SIP0040": "sip-040-delmonte-1l_ggvykt",
    "SIP0041": "sip-041-famous-grouse-whisky-1l-web_mwrnc1",
    "SIP0042": "sip-042-famous-grouse-whisky-750ml-web_yofgbo",
    "SIP0043": "sip-043-four-cousins-wine-750ml-web_tv3jex",
    "SIP0044": "sip-044-fourth-street-wine-750ml-web_compna",
    "SIP0045": "sip-045-general-meakins-250ml-web_m7cvjm",
    "SIP0046": "sip-046-general-meakins-750ml-web_mlnrzd",
    "SIP0047": "sip-047-gilbeys-gin-250ml_oglmxg",
    "SIP0048": "sip-048-gilbeys-gin-350ml_wh4a8r",
    "SIP0049": "sip-049-gilbeys-gin-750ml_galmbu",
    "SIP0050": "sip-050-gordons-can-web_se9yjh",
    "SIP0051": "sip-051-gordons-gin-1l_tijvxf",
    "SIP0052": "sip-052-gordons-gin-750ml_nzg7fe",
    "SIP0053": "sip-053-grants-whisky-1l-web_mcvkz0",
    "SIP0054": "sip-054-grants-whisky-350ml-web_inhsl3",
    "SIP0055": "sip-055-grants-whisky-750ml-web_nchno4",
    "SIP0056": "sip-056-guiness-can-web_yaz9t6",
    "SIP0057": "sip-057-hamptons-whisky-750ml-web_xu3emj",
    "SIP0058": "sip-058-hennessy-vs-1l_th2isz",
    "SIP0059": "sip-059-hennessy-vs-750ml-web_cbhvqn",
    "SIP0060": "sip-060-hunters-choice-whisky-250ml-web_fjnky2",
    "SIP0061": "sip-061-hunters-choice-whisky-350ml-web_ye1vwa",
    "SIP0062": "sip-062-hunters-choice-whisky-750ml-web_nccvps",
    "SIP0063": "sip-063-jack-daniels-1l_j19xup",
    "SIP0064": "sip-064-jagermeister-whisky-1l-web_ee7xfp",
    "SIP0066": "sip-066-jameson-whisky-1l-web_f25nij",
    "SIP0068": "sip-068-jameson-whisky-750ml-web_umpjjv",
    "SIP0069": "sip-069-john-barr-black-750ml-web_m7oxjh",
    "SIP0070": "sip-070-john-barr-red-whisky-1l-web_bm9ynx",
    "SIP0071": "sip-071-kc-ginger-250ml-web_nhhncj",
    "SIP0072": "sip-072-kc-ginger-750ml_drler9",
    "SIP0073": "sip-073-kc-pineapple-250ml_ilkjdc",
    "SIP0074": "sip-074-kc-pineapple-750ml_xn6c4j",
    "SIP0075": "sip-075-kc-smooth-250ml-web_tqhbzg",
    "SIP0076": "sip-076-kc-smooth-750ml-web_wdnogf",
    "SIP0077": "sip-077-kibao-vodka-250ml_m4jotc",
    "SIP0078": "sip-078-kibao-vodka-350ml_ykpkkx",
    "SIP0079": "sip-079-kibao-vodka-750ml_deizre",
    "SIP0080": "sip-080-ko-330ml-web_rvpvrz",
    "SIP0081": "sip-081-konyagi-250ml_cjfgyr",
    "SIP0082": "sip-082-konyagi-500ml_khjomx",
    "SIP0083": "sip-083-konyagi-750ml_neeaq7",
    "SIP0084": "sip-084-manyatta-can_agapxl",
    "SIP0085": "sip-085-monster_zvr0of",
    "SIP0086": "sip-086-oj-can-web_whcrzz",
    "SIP0087": "sip-087-orijin-spirit-250ml-web_r4bwtd",
    "SIP0088": "sip-088-orijin-spirit-750ml-web_dxyfem",
    "SIP0089": "sip-089-pilsner-can-web_yrj6zj",
    "SIP0090": "sip-090-red-label-whisky-1l_oboavj",
    "SIP0091": "sip-091-red-label-whisky-350l-web_gkieza",
    "SIP0092": "sip-092-red-label-whisky-750ml-web_nowxtm",
    "SIP0093": "sip-093-redbull-can-web_vmfof0",
    "SIP0094": "sip-094-reserve-7-whisky-750ml-web_evpayf",
    "SIP0095": "sip-095-richot-brandy-250ml-web_j7bxho",
    "SIP0096": "sip-096-richot-brandy-350ml-web_wrynmj",
    "SIP0097": "sip-097-richot-brandy-750ml-web_clcdy2",
    "SIP0098": "sip-098-robertson-wine-750ml-web_pjj83a",
    "SIP0099": "sip-099-savannah-can-web_m2sojc",
    "SIP0100": "sip-100-smirnoff-black-ice_v9urj6",
    "SIP0101": "sip-101-smirnoff-ice-guarana_omki1r",
    "SIP0102": "sip-102-smirnoff-vodka-250ml_kixuxw",
    "SIP0103": "sip-103-smirnoff-vodka-350ml-web_hcltsb",
    "SIP0104": "sip-104-smirnoff-vodka-750ml_t0qdax",
    "SIP0105": "sip-105-tanqueray-gin-750ml_ihmwlb",
    "SIP0106": "sip-106-tripple-ace-250ml-web_kp88dy",
    "SIP0107": "sip-107-tripple-ace-750ml-web_nqbwoj",
    "SIP0108": "sip-108-tusker-cider-can-web_ssamew",
    "SIP0109": "sip-109-tusker-lager-can_ndhuei",
    "SIP0110": "sip-110-tusker-lite-can_s6qpeh",
    "SIP0111": "sip-111-tusker-malt-can-web_qmyvjv",
    "SIP0112": "sip-112-vanda-wine-250ml-web_epi1po",
    "SIP0114": "sip-114-vat-69-scotch-whisky-350ml-web_qxdpmq",
    "SIP0115": "sip-115-vat-69-scotch-whisky-750ml-web_pcmvuf",
    "SIP0116": "sip-116-viceroy-brandy-250ml-web_pwsvgp",
    "SIP0117": "sip-117-viceroy-brandy-350ml-web_f6pdq8",
    "SIP0118": "sip-118-viceroy-brandy-750ml-web_ah86ze",
    "SIP0119": "sip-119-whitecap-can-web_myumw9",
    "SIP0120": "sip-120-william-lawsons-whisky-350ml-web_xvf97k",
    "SIP0121": "sip-121-william-lawsons-whisky-750ml-web_p0ihzk",
    "SIP0123": "sip-123-amarula-350ml_d5p7cc",
    "SIP0124": "sip-124-double-black-1l_oaxkxf",
    "SIP0125": "sip-125-camino-750ml_fr7zha",
    "SIP0126": "sip-126-jose-cuervo-750ml_wqr8d3",
    "SIP0127": "sip-127-martel-vs-750ml-web_iwkjpk",
    "SIP0128": "sip-128-martel-vs-1l_meadsd",
    "SIP0129": "sip-129-water-1l_hmgzax",
    "SIP0130": "sip-130-coke-1-25-l-web_wpkcve",
    "SIP0131": "sip-131-snapp_hcro5u",
    "SIP0132": "sip-132-heineken-can_ie0sbt",
    "SIP0133": "sip-133-heineken-bottle-candidate-4-web_quga4v",
    "SIP0134": "sip-134-tusker-cider-300ml_nmdip0",
    "SIP0135": "sip-135-tusker-lager-500ml_ah6exm",
    "SIP0136": "sip-136-tusker-lite-bottle-330ml_yzumxz",
    "SIP0137": "sip-137-guinness-500ml_d5vyew",
    "SIP0138": "sip-138-hunters-dry-500ml-web_vso2xz",
    "SIP0139": "sip-139-macmohan_kqtv8i",
    "SIP0140": "sip-140-smirnoff-pineapple-punch-web_vgfczu",
    "SIP0141": "sip-141-soda-500ml_gzuegp",
    "SIP0142": "sip-142-predator-web_uiaevh",
    "SIP0143": "sip-143-lemonade-web_lkvdr1",
    "SIP0144": "sip-144-savanna-dry-330ml-web_sfalyt",
    "SIP0145": "sip-145-water-500ml_ublof7",
    "SIP0146": "sip-146-jose-cuevo-gold-750ml_qdepic",
    "SIP0147": "sip-147-jose-cuevo-silver-750ml_hugugn",
    "SIP0148": "sip-148-john-barr-red-750ml-web_fiqvn8",
    "SIP0149": "sip-149-double-black-750ml-web_kmnoaq",
    "SIP0150": "sip-150-balozi-can_lw3om6",
    "SIP0151": "sip-151-soda-2l_l5mjax",
    "SIP0152": "sip-152-hennessy-vsop-1l_osb3ux",
    "SIP0153": "sip-153-faxe-can-web_kbpqqb",
    "SIP0154": "sip-154-dasani-1l_n4sx1m",
    "SIP0155": "sip-155-captain-melon-splash-750ml-candidate-1-web_akwqdu",
    "SIP0156": "sip-156-captain-melon-splash-250ml_p3j7oo",
    "SIP0157": "sip-157-sipcity-hoodie-web_mzcumr",
    "SIP0159": "sip-159-sipcity-cap_psxx37",
    "SIP0161": "sip-161-baileys-700ml-candidate-4-web_rtwoes",
    "SIP0162": "sip-162-coke-1l_trlrwy",
    "SIP0164": "sip-164-labeled-placeholder_pmtptg",
    "SIP0166": "sip-166-remy-martin-vsop-1l-web_jtn15v",
    "SIP0167": "sip-167-john-barr-black-1l_agtg0k",
    "SIP0168": "sip-168-kc-smooth-350ml-candidate-4-web_dimtqg",
    "SIP0169": "sip-169-essential-water-web_dkgric",
    "SIP0170": "sip-170-all-seasons-1l-web_qxbsob",
    "SIP0171": "sip-171-8-pm-1l-web_yjcooc",
    "SIP0172": "sip-172-manyatta-bottle_qif24y",
    "SIP0173": "sip-173-jinro-grapefruit-soju-330ml-web_tuo6du",
    "SIP0174": "sip-174-jinro-lemon-soju-330l-web_hhixdj",
    "SIP0175": "sip-175-jinro-lemon-soju-330ml-web_i3xls7",
    "SIP0176": "sip-176-moet-and-chandon-web_u6lyi6",
    "SIP0177": "sip-177-hennessy-xo_lxo9n9",
    "SIP0178": "sip-178-singleton-12yrs-web_vtthvq",
    "SIP0179": "sip-179-don-julio-1942_ospepa",
    "SIP0180": "sip-180-jagermeister-1l-corked-web_rshib7",
    "SIP0181": "sip-181-hunters-dry-330ml_tctkfo",
  };
  const products = P.map(([id, name, sku, size, category, priceCents, costCents, stock]) => ({
    id, name, sku, size, category, priceCents, costCents, imageUrl: productDisplayImage({ sku }) || undefined, barcode: sku, barcodeCatalogId: "bc_" + sku.toLowerCase(), branchId: "b_sip", reorderLevel: 4, status: "active", synced: true, _stock: stock,
  }));
  const barcodeCatalog = products.map((p) => ({ id: p.barcodeCatalogId, barcode: p.barcode, barcodeType: "code128", synced: true, updatedAt: t, createdAt: t }));
  const stockMovements = [];
  products.forEach((p) => delete p._stock);
  return {
    settings: { currency: "KES", taxRate: 0, store: "VISIONPOS", reorderLevel: 4, theme: "light", activeBranchId: "b_sip", lastEndDay: t - 86400000 },
    admin: { name: "", email: "", phone: "", password: "", provisioned: false },
    branches,
    employees: [],
    customers: [],
    suppliers: [],
    supplierPrices: [],
    products,
    barcodeCatalog,
    cashierJointDebts: [],
    cashierJointDebtPayments: [],
    stockMovements,
    stockCountSessions: [],
    orders: [],
    payments: [],
    invoices: [],
    invoiceVoidRequests: [],
    invoiceVoidDecisions: [],
    purchases: [],
    expenses: [],
    expenseCategories: DEFAULT_EXPENSE_CATEGORIES,
    cashMovements: [],
    borrowings: [],
    endOfDays: [],
    countLog: [],
    branchPricing: {},
    lastSyncedAt: t,
  };
};

// Empty, unprovisioned state for first-time / clean setup (no branches, products, staff or transactions).
const CLEAN_SETUP = () => {
  const t = now();
  return {
    settings: { currency: "KES", taxRate: 0, store: "VISIONPOS", reorderLevel: 4, theme: "light", activeBranchId: "", lastEndDay: t },
    admin: { name: "", email: "", phone: "", password: "", provisioned: false },
    branches: [],
    employees: [],
    customers: [{ id: "c_walkin", name: "Walk-in", phone: "", synced: false }],
    suppliers: [],
    supplierPrices: [],
    products: [],
    barcodeCatalog: [],
    cashierJointDebts: [],
    cashierJointDebtPayments: [],
    stockMovements: [],
    stockCountSessions: [],
    orders: [],
    payments: [],
    invoices: [],
    invoiceVoidRequests: [],
    invoiceVoidDecisions: [],
    purchases: [],
    expenses: [],
    expenseCategories: DEFAULT_EXPENSE_CATEGORIES,
    cashMovements: [],
    borrowings: [],
    endOfDays: [],
    countLog: [],
    branchPricing: {},
    lastSyncedAt: t,
  };
};

async function kvGet(key) {
  try {
    if (typeof window === "undefined") return null;
    if (window.storage) {
      const r = await window.storage.get(key);
      return r && r.value != null ? r.value : null;
    }
    return window.localStorage ? window.localStorage.getItem(key) : null;
  } catch (_) { return null; }
}
async function kvSet(key, value) {
  try {
    if (typeof window === "undefined") return;
    if (window.storage) await window.storage.set(key, value);
    else if (window.localStorage) window.localStorage.setItem(key, value);
  } catch (_) {}
}
async function kvRemove(key) {
  try {
    if (typeof window === "undefined") return;
    if (window.storage?.remove) await window.storage.remove(key);
    else if (window.localStorage) window.localStorage.removeItem(key);
  } catch (_) {}
}
async function loadJson(key, fallback) {
  const raw = await kvGet(key);
  if (!raw) return fallback;
  try { return JSON.parse(raw); } catch (_) { return fallback; }
}
async function saveJson(key, value) { await kvSet(key, JSON.stringify(value)); }
async function loadSessionState() { return await loadJson(SESSION_KEY, null); }
async function saveSessionState(value) { await saveJson(SESSION_KEY, value); }
async function clearSessionState() { activeSessionToken = ""; await kvSet(SESSION_KEY, ""); }

function storageKeys() {
  try {
    if (typeof window === "undefined" || !window.localStorage) return [];
    return Array.from({ length: window.localStorage.length }, (_, i) => window.localStorage.key(i)).filter(Boolean);
  } catch (_) { return []; }
}
function byteSize(value) {
  try { return new Blob([String(value || "")]).size; } catch (_) { return String(value || "").length * 2; }
}
function storageUsageSnapshot() {
  const keys = storageKeys();
  const groups = { cache: 0, settings: 0, syncQueue: 0, auth: 0, protectedData: 0, maintenance: 0, other: 0, total: 0 };
  try {
    for (const key of keys) {
      const raw = window.localStorage.getItem(key) || "";
      const size = byteSize(key) + byteSize(raw);
      groups.total += size;
      if (key === STORE_KEY) groups.protectedData += size;
      else if (key === MAINTENANCE_META_KEY || key === MAINTENANCE_LOG_KEY) groups.maintenance += size;
      else if (key === BARCODE_CACHE_KEY || key === BARCODE_LOG_KEY || CACHE_KEY_PREFIXES.some((p) => key.startsWith(p))) groups.cache += size;
      else if (SYNC_QUEUE_KEYS.includes(key)) groups.syncQueue += size;
      else if (AUTH_KEYS.includes(key)) groups.auth += size;
      else if (SETTINGS_KEYS.includes(key)) groups.settings += size;
      else groups.other += size;
    }
  } catch (_) {}
  return { keys: keys.length, ...groups };
}
function fmtBytes(bytes) {
  const n = Number(bytes) || 0;
  if (n < 1024) return n + " B";
  if (n < 1024 * 1024) return (n / 1024).toFixed(1) + " KB";
  return (n / 1024 / 1024).toFixed(2) + " MB";
}
async function appendMaintenanceAudit(action, detail = {}) {
  const log = await loadJson(MAINTENANCE_LOG_KEY, []);
  const entry = { id: uid("maint"), ts: now(), action, detail };
  const next = [entry, ...(Array.isArray(log) ? log : [])].slice(0, 200);
  await saveJson(MAINTENANCE_LOG_KEY, next);
  return entry;
}
async function maintenanceSnapshot(data) {
  const meta = await loadJson(MAINTENANCE_META_KEY, {});
  const outbox = await loadOutbox();
  const audit = await loadJson(MAINTENANCE_LOG_KEY, []);
  const usage = storageUsageSnapshot();
  const syncError = outbox.length ? data?._sync?.error || "" : "";
  return {
    ...meta,
    storage: usage,
    audit: Array.isArray(audit) ? audit.slice(0, 12) : [],
    syncStatus: syncError ? "error" : outbox.length ? "pending" : "ok",
    syncError,
    pendingUploads: outbox.length,
    lastSyncedAt: data?.lastSyncedAt || 0,
    deviceId: typeof window !== "undefined" && window.localStorage ? window.localStorage.getItem("visionary:sync:deviceId") || "" : "",
    protectedKeys: { businessData: STORE_KEY, auth: AUTH_KEYS, syncQueue: SYNC_QUEUE_KEYS, settings: SETTINGS_KEYS },
  };
}
async function runMaintenanceService({ data, mode = "light", runSync } = {}) {
  const startedAt = now();
  const actions = [];
  const removed = [];
  const rebuilt = [];
  const usageBefore = storageUsageSnapshot();
  const removeCacheKey = async (key, reason) => {
    if (!key || PROTECTED_STORAGE_KEYS.has(key)) return;
    await kvRemove(key);
    removed.push({ key, reason });
  };
  try {
    const keys = storageKeys();
    const staleCutoff = now() - (mode === "deep" ? 7 : 2) * 24 * 60 * 60 * 1000;
    for (const key of keys) {
      if (PROTECTED_STORAGE_KEYS.has(key)) continue;
      if (key.startsWith("visionary:tmp:")) await removeCacheKey(key, "expired temporary file");
      else if (key.startsWith("visionary:api-cache:") || key.startsWith("visionary:cache:")) {
        const entry = await loadJson(key, null);
        const ts = Number(entry?.ts || entry?.createdAt || entry?.updatedAt || 0);
        if (!ts || ts < staleCutoff) await removeCacheKey(key, "stale cache entry");
      } else if (mode === "deep" && key.startsWith("visionary:image-cache:")) {
        const entry = await loadJson(key, null);
        const ts = Number(entry?.ts || entry?.createdAt || entry?.updatedAt || 0);
        if (!ts || ts < staleCutoff) await removeCacheKey(key, "old cached image");
      }
    }
    const barcodeCache = await loadJson(BARCODE_CACHE_KEY, null);
    if (!barcodeCache || Array.isArray(barcodeCache) || typeof barcodeCache !== "object") {
      await saveBarcodeCache(data || {});
      rebuilt.push(BARCODE_CACHE_KEY);
      actions.push("rebuilt barcode/search cache");
    }
    if (mode === "deep") {
      const scanLog = await loadJson(BARCODE_LOG_KEY, []);
      if (Array.isArray(scanLog) && scanLog.length > 250) {
        await saveJson(BARCODE_LOG_KEY, scanLog.slice(0, 250));
        actions.push("compressed barcode scan log");
      }
      const audit = await loadJson(MAINTENANCE_LOG_KEY, []);
      if (Array.isArray(audit) && audit.length > 200) {
        await saveJson(MAINTENANCE_LOG_KEY, audit.slice(0, 200));
        actions.push("compressed maintenance audit log");
      }
    }
    const outbox = await loadOutbox();
    if (outbox.length && typeof runSync === "function") {
      actions.push("retrying failed sync tasks");
      await runSync({ force: true, source: "maintenance" });
    }
    const usageAfter = storageUsageSnapshot();
    const meta = { lastCleanupAt: now(), lastMode: mode, lastDurationMs: now() - startedAt, lastRemoved: removed.length, lastRebuilt: rebuilt, storage: usageAfter };
    await saveJson(MAINTENANCE_META_KEY, meta);
    await appendMaintenanceAudit("maintenance_" + mode, { removed, rebuilt, actions, beforeBytes: usageBefore.total, afterBytes: usageAfter.total });
    return meta;
  } catch (error) {
    const meta = { lastCleanupAt: now(), lastMode: mode, lastError: error.message, storage: storageUsageSnapshot() };
    await saveJson(MAINTENANCE_META_KEY, meta);
    await appendMaintenanceAudit("maintenance_failed", { mode, error: error.message, removed, rebuilt });
    return meta;
  }
}

function normalizeLoadedData(data) {
  if (!data) return data;
  const clean = CLEAN_SETUP();
  const settings = { ...clean.settings, ...(data.settings || {}) };
  if (["Visionary POS", "VISIONARY POS"].includes(settings.store)) settings.store = "VISIONPOS";
  const normalized = {
    ...clean,
    ...data,
    settings,
    admin: { ...clean.admin, ...(data.admin || {}) },
    branches: Array.isArray(data.branches) ? data.branches : [],
    employees: Array.isArray(data.employees) ? data.employees : [],
    customers: Array.isArray(data.customers) ? data.customers : clean.customers,
    suppliers: Array.isArray(data.suppliers) ? data.suppliers : [],
    supplierPrices: Array.isArray(data.supplierPrices) ? data.supplierPrices : [],
    products: Array.isArray(data.products) ? data.products : [],
    barcodeCatalog: Array.isArray(data.barcodeCatalog) ? data.barcodeCatalog : [],
    cashierJointDebts: Array.isArray(data.cashierJointDebts) ? data.cashierJointDebts : [],
    cashierJointDebtPayments: Array.isArray(data.cashierJointDebtPayments) ? data.cashierJointDebtPayments : [],
    stockMovements: Array.isArray(data.stockMovements) ? data.stockMovements : [],
    stockCountSessions: Array.isArray(data.stockCountSessions) ? data.stockCountSessions : [],
    orders: Array.isArray(data.orders) ? data.orders : [],
    payments: Array.isArray(data.payments) ? data.payments : [],
    invoices: Array.isArray(data.invoices) ? data.invoices : [],
    invoiceVoidRequests: Array.isArray(data.invoiceVoidRequests) ? data.invoiceVoidRequests : [],
    invoiceVoidDecisions: Array.isArray(data.invoiceVoidDecisions) ? data.invoiceVoidDecisions : [],
    purchases: Array.isArray(data.purchases) ? data.purchases : [],
    expenses: Array.isArray(data.expenses) ? data.expenses : [],
    expenseCategories: Array.isArray(data.expenseCategories) ? data.expenseCategories : DEFAULT_EXPENSE_CATEGORIES,
    cashMovements: Array.isArray(data.cashMovements) ? data.cashMovements : [],
    borrowings: Array.isArray(data.borrowings) ? data.borrowings : [],
    endOfDays: Array.isArray(data.endOfDays) ? data.endOfDays : [],
    countLog: Array.isArray(data.countLog) ? data.countLog : [],
    branchPricing: data.branchPricing && typeof data.branchPricing === "object" ? data.branchPricing : {},
  };
  const catalogByCode = new Map((normalized.barcodeCatalog || []).map((entry) => [normalizeBarcode(entry.barcode).toLowerCase(), entry]));
  const barcodeCatalog = [...(normalized.barcodeCatalog || [])];
  const ensureEntry = (code) => {
    const barcode = normalizeBarcode(code);
    if (!barcode) return null;
    const key = barcode.toLowerCase();
    const existing = catalogByCode.get(key);
    if (existing) return existing;
    const entry = { id: "bc_" + key.replace(/[^a-z0-9._-]/g, "_"), barcode, barcodeType: "code128", synced: false, updatedAt: now(), createdAt: now() };
    catalogByCode.set(key, entry);
    barcodeCatalog.push(entry);
    return entry;
  };
  const products = (normalized.products || []).map((product) => {
    const primary = normalizeBarcode(product.barcode || product.sku);
    const entry = product.barcodeCatalogId ? null : ensureEntry(primary);
    const extraIds = [...(product.barcodeCatalogIds || [])];
    (product.barcodes || []).forEach((code) => {
      const extra = ensureEntry(code);
      if (extra && !extraIds.includes(extra.id)) extraIds.push(extra.id);
    });
    return {
      ...product,
      branchId: product.branchId || product.branch_id || "",
      status: product.status || (product.enabled === false || product.active === false ? "disabled" : "active"),
      barcode: primary || product.barcode || product.sku,
      barcodeCatalogId: product.barcodeCatalogId || entry?.id || null,
      barcodeCatalogIds: extraIds,
    };
  });
  return reconcileInvoicePayments({ ...normalized, products, barcodeCatalog });
}

async function loadData() {
  const data = await loadJson(STORE_KEY, null);
  if (data) {
    return { ...normalizeLoadedData(data), _sync: await syncStatus() };
  }
  return null;
}
async function saveData(data) {
  const { _sync, ...cache } = data || {};
  await saveJson(STORE_KEY, cache);
  await saveBarcodeCache(cache);
}

function normalizeBarcode(value) { return String(value || "").trim().replace(/\s+/g, ""); }
function isValidBarcode(value) { return /^[A-Za-z0-9._-]{4,64}$/.test(normalizeBarcode(value)); }
function productIsEnabled(product) {
  if (!product || product.enabled === false || product.active === false) return false;
  return !["disabled", "inactive", "deleted"].includes(String(product.status || "active").trim().toLowerCase());
}
function productBranchId(product) { return product?.branchId || product?.branch_id || ""; }
function productVisibleInBranch(product, data, branchId) {
  if (!branchId) return true;
  const explicitBranch = productBranchId(product);
  if (!explicitBranch || explicitBranch === branchId) return true;
  const key = productDedupeKey(product);
  return !(data?.products || []).some((p) => productBranchId(p) === branchId && productDedupeKey(p) === key);
}
function findBarcodeCatalogEntry(data, code) {
  const normalized = normalizeBarcode(code).toLowerCase();
  if (!normalized) return null;
  return (data?.barcodeCatalog || []).find((entry) => normalizeBarcode(entry.barcode).toLowerCase() === normalized) || null;
}
function barcodeCatalogIdsForProduct(product) {
  return [product?.barcodeCatalogId, ...(product?.barcodeCatalogIds || [])].filter(Boolean);
}
function productMatchesBarcode(product, code) {
  const normalized = normalizeBarcode(code).toLowerCase();
  if (!normalized || !product) return false;
  return [product.barcode, product.sku, ...(product.barcodes || [])].some((value) => normalizeBarcode(value).toLowerCase() === normalized);
}
function productMatchesCatalog(product, catalogEntry) {
  return !!catalogEntry && barcodeCatalogIdsForProduct(product).includes(catalogEntry.id);
}
function productDedupeKey(product) {
  const sku = normalizeBarcode(product?.sku).toLowerCase();
  if (sku) return "sku:" + sku;
  const barcode = normalizeBarcode(product?.barcode).toLowerCase();
  if (barcode) return "barcode:" + barcode;
  const catalogId = barcodeCatalogIdsForProduct(product)[0];
  if (catalogId) return "catalog:" + catalogId;
  const name = String(product?.name || "").trim().toLowerCase();
  const size = String(product?.size || "").trim().toLowerCase();
  if (name) return "name:" + name + "|" + size;
  return "product:" + (product?.id || "");
}
function preferProductRow(current, candidate) {
  if (!current) return candidate;
  const score = (p) => (p?.priceCents > 0 ? 8 : 0) + (p?.costCents > 0 ? 4 : 0) + (p?.imageUrl || p?.image ? 2 : 0) + (normalizeBarcode(p?.barcode) ? 1 : 0);
  const currentScore = score(current);
  const candidateScore = score(candidate);
  if (candidateScore !== currentScore) return candidateScore > currentScore ? candidate : current;
  return (candidate?.updatedAt || 0) > (current?.updatedAt || 0) ? candidate : current;
}
function dedupeProductsByCode(products) {
  const byKey = new Map();
  (products || []).forEach((p) => {
    const key = productDedupeKey(p);
    byKey.set(key, preferProductRow(byKey.get(key), p));
  });
  return Array.from(byKey.values());
}
function branchProductsUnique(data, branchId) {
  return dedupeProductsByCode((data?.products || []).filter((p) => productVisibleInBranch(p, data, branchId)));
}
function duplicateProductIds(data, product, branchId) {
  const key = productDedupeKey(product);
  return (data?.products || [])
    .filter((p) => productVisibleInBranch(p, data, branchId) && productDedupeKey(p) === key)
    .map((p) => p.id);
}
function productOnHand(data, product, branchId) {
  const ids = duplicateProductIds(data, product, branchId);
  if (!ids.length) return onHand(data, product?.id, branchId);
  return ids.reduce((sum, id) => sum + onHand(data, id, branchId), 0);
}
function findProductByBarcode(data, code, branchId, { enabledOnly = false } = {}) {
  const normalized = normalizeBarcode(code);
  if (!normalized) return null;
  const catalogEntry = findBarcodeCatalogEntry(data, normalized);
  const branchProducts = (data?.products || []).filter((p) => productVisibleInBranch(p, data, branchId) && (!enabledOnly || productIsEnabled(p)));
  return branchProducts.find((p) => productMatchesCatalog(p, catalogEntry)) || branchProducts.find((p) => productMatchesBarcode(p, normalized)) || null;
}
function barcodeLookup(data, code, branchId, options) {
  const catalogEntry = findBarcodeCatalogEntry(data, code);
  const product = findProductByBarcode(data, code, branchId, options);
  if (!product) {
    if (catalogEntry) return { product: null, unavailable: true, message: "This product is not available in this branch.", barcodeCatalog: catalogEntry };
    return null;
  }
  return { product, name: product.name, price: product.priceCents, stockQty: onHand(data, product.id, branchId), barcodeCatalog: catalogEntry || null };
}
function buildBarcodeCache(data) {
  const cache = {};
  const catalogById = new Map((data?.barcodeCatalog || []).map((entry) => [entry.id, entry]));
  (data?.products || []).forEach((p) => {
    barcodeCatalogIdsForProduct(p).forEach((id) => {
      const entry = catalogById.get(id);
      const code = normalizeBarcode(entry?.barcode);
      if (code) cache[code.toLowerCase()] = p.id;
    });
    [p.barcode || p.sku, ...(p.barcodes || [])].forEach((value) => {
      const code = normalizeBarcode(value);
      if (code) cache[code.toLowerCase()] = p.id;
    });
  });
  return cache;
}
async function saveBarcodeCache(data) { await saveJson(BARCODE_CACHE_KEY, buildBarcodeCache(data)); }
async function appendBarcodeScanLog(entry) {
  const log = await loadJson(BARCODE_LOG_KEY, []);
  log.unshift({ ...entry, ts: entry.ts || now() });
  await saveJson(BARCODE_LOG_KEY, log.slice(0, 250));
}
function playScanSound(kind = "success") {
  try {
    if (typeof window === "undefined") return;
    const AudioCtx = window.AudioContext || window.webkitAudioContext;
    if (!AudioCtx) return;
    const ctx = new AudioCtx();
    const gain = ctx.createGain();
    const osc = ctx.createOscillator();
    osc.type = "sine";
    osc.frequency.value = kind === "success" ? 880 : 220;
    gain.gain.setValueAtTime(0.0001, ctx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.08, ctx.currentTime + 0.01);
    gain.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + (kind === "success" ? 0.09 : 0.18));
    osc.connect(gain);
    gain.connect(ctx.destination);
    osc.start();
    osc.stop(ctx.currentTime + (kind === "success" ? 0.1 : 0.2));
    window.setTimeout(() => ctx.close?.(), 250);
  } catch (_) {}
}

const SYNC_APPEND = new Map([
  ["invoices", "invoice"],
  ["invoiceVoidRequests", "invoiceVoidRequest"],
  ["invoiceVoidDecisions", "invoiceVoidDecision"],
  ["payments", "payment"],
  ["borrowings", "borrowing"],
  ["stockMovements", "stockMovement"],
  ["endOfDays", "endOfDay"],
  ["cashMovements", "cashMovement"],
  ["orders", "order"],
  ["countLog", "countLog"],
  ["cashierJointDebts", "cashierJointDebt"],
  ["cashierJointDebtPayments", "cashierJointDebtPayment"],
]);
const SYNC_MUTABLE = new Map([
  ["barcodeCatalog", "barcodeCatalog"],
  ["expenses", "expense"],
  ["expenseCategories", "expenseCategory"],
  ["products", "product"],
  ["customers", "customer"],
  ["employees", "user"],
  ["branches", "branch"],
  ["suppliers", "supplier"],
  ["supplierPrices", "supplierPrice"],
  ["purchases", "purchase"],
  ["stockCountSessions", "stockCountSession"],
]);
const AUTH_SYNC_TYPES = new Set([
  "user",
  "users",
  "employee",
  "employees",
  "credential",
  "credentials",
  "staffLogin",
  "staff_login",
  "cashier",
  "cashiers",
  "session",
  "sessions",
  "userSession",
  "user_sessions",
  "passwordReset",
  "password_reset",
  "emailVerification",
  "email_verification",
]);
const AUTH_SYNC_COLLECTIONS = new Set(["employees"]);
const SYNC_ARRAYS = [...SYNC_APPEND.keys(), ...SYNC_MUTABLE.keys()];

function syncConfig() {
  const cfg = (typeof window !== "undefined" && window.VISIONARY_SYNC_CONFIG) || {};
  const ls = typeof window !== "undefined" && window.localStorage ? window.localStorage : null;
  const origin = typeof window !== "undefined" && window.location?.origin ? window.location.origin : "http://127.0.0.1:3000";
  return {
    apiBaseUrl: String(cfg.apiBaseUrl || (ls && ls.getItem(API_BASE_KEY)) || origin).replace(/\/$/, ""),
    deviceToken: cfg.deviceToken || (ls && ls.getItem(DEVICE_TOKEN_KEY)) || "",
  };
}
function envValue(key, fallback = "") {
  try { return (typeof import.meta !== "undefined" && import.meta.env && import.meta.env[key]) || fallback; } catch (_) { return fallback; }
}
function desktopDownloadConfig() {
  const runtime = (typeof window !== "undefined" && (window.VISIONPOS_DOWNLOADS || window.VISIONARY_SYNC_CONFIG?.downloads)) || {};
  const version = runtime.version || envValue("VITE_VISIONPOS_DESKTOP_VERSION", "Checking latest version...");
  const windowsUrl = runtime.windowsUrl || envValue("VITE_VISIONPOS_WINDOWS_DOWNLOAD_URL", "/downloads/VISIONPOS-Cashier-Setup.exe");
  const releaseNotes = runtime.releaseNotes || envValue("VITE_VISIONPOS_DESKTOP_RELEASE_NOTES", [
    "Secure first-run terminal activation with admin-generated codes.",
    "Cashier-only desktop interface connected to the VisionPOS cloud backend.",
    "USB barcode scanner workflow with persistent search focus.",
    "Receipt printing support through installed Windows printers.",
    "Designed for approved shop terminals only; downloading the app alone does not grant access.",
  ].join("|"));
  return {
    version,
    releaseNotes,
    apps: [
      {
        platform: "Windows",
        label: "Windows Installer (.exe)",
        url: windowsUrl,
        available: Boolean(windowsUrl),
        instructions: "Download, run the installer, open VisionPOS, then enter the terminal activation code generated in the admin portal.",
      },
      {
        platform: "Mac",
        label: "macOS App",
        url: runtime.macUrl || envValue("VITE_VISIONPOS_MAC_DOWNLOAD_URL"),
        available: Boolean(runtime.macUrl || envValue("VITE_VISIONPOS_MAC_DOWNLOAD_URL")),
        instructions: "Coming soon. Mac builds will use the same activation-code security flow.",
      },
      {
        platform: "Linux",
        label: "Linux AppImage",
        url: runtime.linuxUrl || envValue("VITE_VISIONPOS_LINUX_DOWNLOAD_URL"),
        available: Boolean(runtime.linuxUrl || envValue("VITE_VISIONPOS_LINUX_DOWNLOAD_URL")),
        instructions: "Coming soon. Linux builds will use the same activation-code security flow.",
      },
    ],
  };
}
function applyDesktopReleaseManifest(current, manifest) {
  if (!manifest || typeof manifest !== "object") return current;
  const version = manifest.version || current.version;
  const windowsUrl = manifest.platforms?.["windows-x86_64"]?.url || manifest.installer || current.apps.find((app) => app.platform === "Windows")?.url || "/downloads/VISIONPOS-Cashier-Setup.exe";
  const releaseNotes = typeof manifest.notes === "string"
    ? manifest.notes.split(/\r?\n/).map((note) => note.trim()).filter(Boolean)
    : Array.isArray(manifest.releaseNotes) && manifest.releaseNotes.length
      ? manifest.releaseNotes
      : current.releaseNotes;
  return {
    ...current,
    version,
    releaseNotes,
    apps: current.apps.map((app) => {
      if (app.platform !== "Windows") return app;
      return {
        ...app,
        url: windowsUrl,
        available: Boolean(windowsUrl),
        version,
      };
    }),
  };
}
function useDesktopDownloads() {
  const [downloads, setDownloads] = useState(() => desktopDownloadConfig());
  useEffect(() => {
    let active = true;
    fetch("/downloads/latest.json?v=" + Date.now(), { cache: "no-store" })
      .then((response) => (response.ok ? response.json() : null))
      .then((manifest) => {
        if (active && manifest) setDownloads((current) => applyDesktopReleaseManifest(current, manifest));
      })
      .catch(() => {});
    return () => { active = false; };
  }, []);
  return downloads;
}
function getOrCreateDeviceId() {
  const ls = typeof window !== "undefined" && window.localStorage ? window.localStorage : null;
  if (!ls) return "device-" + Math.random().toString(36).slice(2);
  let id = ls.getItem("visionary:sync:deviceId");
  if (!id) {
    const random = typeof crypto !== "undefined" && crypto.randomUUID ? crypto.randomUUID() : Math.random().toString(36).slice(2) + Date.now();
    id = "web-" + random;
    ls.setItem("visionary:sync:deviceId", id);
  }
  return id;
}
async function ensureDeviceToken(branchId = null) {
  const cfg = syncConfig();
  if (cfg.deviceToken) return cfg.deviceToken;
  const ls = typeof window !== "undefined" && window.localStorage ? window.localStorage : null;
  const deviceId = getOrCreateDeviceId();
  const response = await fetch(cfg.apiBaseUrl + "/api/auth/device", {
    method: "POST",
    cache: "no-store",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      deviceId,
      branchId,
      name: "VISIONPOS Web " + deviceId.slice(-8)
    })
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok || !data.token) throw new Error(data.error || "device_registration_failed");
  if (ls) {
    ls.setItem(DEVICE_TOKEN_KEY, data.token);
    ls.setItem(API_BASE_KEY, cfg.apiBaseUrl);
  }
  if (typeof window !== "undefined") {
    window.VISIONARY_SYNC_CONFIG = { ...(window.VISIONARY_SYNC_CONFIG || {}), apiBaseUrl: cfg.apiBaseUrl, deviceToken: data.token };
  }
  return data.token;
}
async function hasDesktopTerminalAuth() {
  try {
    if (typeof window === "undefined" || !window.visionposTerminalAuth?.getTerminal) return false;
    const terminal = await window.visionposTerminalAuth.getTerminal();
    return Boolean(terminal?.hasSecret && terminal?.uuid);
  } catch (_) {
    return false;
  }
}
async function deviceAuthHeaders(branchId = null, base = {}) {
  const headers = { ...base };
  if (await hasDesktopTerminalAuth()) return headers;
  const cfg = syncConfig();
  headers.Authorization = "Bearer " + (cfg.deviceToken || await ensureDeviceToken(branchId));
  return headers;
}
function syncSessionToken(tokenOverride = "") {
  return String(tokenOverride || activeSessionToken || storedSessionTokenSync() || "").trim();
}
function sessionAuthHeaders(base = {}, tokenOverride = "") {
  const token = syncSessionToken(tokenOverride);
  return token
    ? { ...base, Authorization: `Bearer ${token}`, "X-Session-Token": token }
    : { ...base };
}
async function authApi(path, body, options = {}) {
  const cfg = syncConfig();
  const headers = options.session
    ? sessionAuthHeaders({ "Content-Type": "application/json" })
    : options.device
      ? await deviceAuthHeaders(body?.branchId || null, { "Content-Type": "application/json" })
      : { "Content-Type": "application/json" };
  const response = await fetch(cfg.apiBaseUrl + path, {
    method: "POST",
    headers,
    cache: "no-store",
    body: JSON.stringify(body)
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || "request_failed");
  return data;
}
async function authGet(path, options = {}) {
  const cfg = syncConfig();
  const headers = options.session ? sessionAuthHeaders() : options.device ? await deviceAuthHeaders(options.branchId || null) : {};
  const response = await fetch(cfg.apiBaseUrl + path, { headers, cache: "no-store" });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(data.error || "request_failed");
    if (data.blockers) error.blockers = data.blockers;
    throw error;
  }
  return data;
}
async function environmentPublic() {
  const cfg = syncConfig();
  const response = await fetch(cfg.apiBaseUrl + "/api/environment/public", { cache: "no-store" });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || "environment_failed");
  return data.environment || data;
}
async function environmentGet() {
  const data = await authGet("/api/environment", { session: true });
  return data.environment || data;
}
async function cloudLogin(payload) {
  return await authApi("/api/auth/login", payload, { device: Boolean(payload?.pin) });
}
async function cloudSession(sessionToken) {
  return await authApi("/api/auth/session", { sessionToken });
}
async function cloudLogout(sessionToken) {
  if (!sessionToken) return;
  try { await authApi("/api/auth/logout", { sessionToken }); } catch (_) {}
}
function rightsList(value) {
  if (Array.isArray(value)) return [...new Set(value.map((item) => String(item || "").trim()).filter(Boolean))];
  if (!value) return [];
  if (typeof value === "string") {
    try { return rightsList(JSON.parse(value)); } catch (_) { return value.split(/[\s,]+/).map((item) => item.trim()).filter(Boolean); }
  }
  if (typeof value === "object") {
    const nested = rightsList(value.rights || value.permissions || value.scopes);
    const flags = Object.entries(value)
      .filter(([key, enabled]) => enabled === true && !["role", "kind", "branchId", "branch_id", "email", "phone"].includes(key))
      .map(([key]) => key);
    return [...new Set([...nested, ...flags])];
  }
  return [];
}
function hasRight(value, right) {
  return rightsList(value).includes(right);
}
function storedSessionStateSync() {
  try {
    if (typeof window === "undefined" || !window.localStorage) return null;
    const raw = window.localStorage.getItem(SESSION_KEY);
    if (!raw) return null;
    return JSON.parse(raw);
  } catch (_) { return null; }
}
function storedSessionTokenSync() {
  return storedSessionStateSync()?.sessionToken || "";
}
function syncUsesSessionAuth(tokenOverride = "") {
  const token = syncSessionToken(tokenOverride);
  const terminalRuntime = typeof window !== "undefined" && Boolean(window.visionposTerminalAuth);
  return Boolean(token && !terminalRuntime);
}
async function syncAuthHeaders(branchId = null, base = {}, tokenOverride = "") {
  return syncUsesSessionAuth(tokenOverride) ? sessionAuthHeaders(base, tokenOverride) : await deviceAuthHeaders(branchId, base);
}
function clearSessionStateSync() {
  activeSessionToken = "";
  try {
    if (typeof window !== "undefined" && window.localStorage) window.localStorage.setItem(SESSION_KEY, "");
  } catch (_) {}
}
async function logoutSessionToken(sessionToken, options = {}) {
  if (!sessionToken) return;
  const cfg = syncConfig();
  const body = JSON.stringify({ sessionToken });
  try {
    await fetch(cfg.apiBaseUrl + "/api/auth/logout", {
      method: "POST",
      headers: sessionAuthHeaders({ "Content-Type": "application/json" }),
      cache: "no-store",
      body,
      keepalive: Boolean(options.keepalive)
    });
  } catch (_) {}
}
// Most current SecuGen WebAPI installations listen on 8443. Keep alternate
// ports as fallbacks and remember the working endpoint after the first call.
const SECUGEN_BASES = [
  "https://localhost:8443",
  "https://127.0.0.1:8443",
  "http://127.0.0.1:8000",
  "http://localhost:8000",
  "https://localhost:8000",
  "https://127.0.0.1:8000",
  "http://localhost:8080",
];
let secugenPreferredBase = "";
const SECUGEN_CAPTURE_PATH = "/SGIFPCapture";
const SECUGEN_MATCH_PATH = "/SGIMatchScore";
const SECUGEN_TEMPLATE_FORMAT = "ISO";
const SECUGEN_MATCH_THRESHOLD = 80;

function secugenMessage(error) {
  const msg = String(error?.message || error || "");
  if (msg.includes("not_connected")) return "Fingerprint reader not detected. Connect the SecuGen Hamster reader and try again.";
  if (msg.includes("low_quality")) return "Fingerprint quality was too low. Wipe the reader, place the finger flat, and scan again.";
  if (msg.includes("match_service")) return "SecuGen match service is not responding. Start the official SecuGen WebAPI Client.";
  if (msg.includes("webapi_unreachable") || msg.includes("Failed to fetch")) return "SecuGen WebAPI Client could not be reached on this computer. Start the installed client and reconnect the fingerprint reader before retrying.";
  return msg || "SecuGen fingerprint service is not available.";
}

async function secugenPost(path, params, timeoutMs = 12000) {
  const body = new URLSearchParams(params);
  let lastError = null;
  const bases = secugenPreferredBase
    ? [secugenPreferredBase, ...SECUGEN_BASES.filter((base) => base !== secugenPreferredBase)]
    : SECUGEN_BASES;
  for (const base of bases) {
    const controller = new AbortController();
    const timeout = window.setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetch(base + path, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body,
        signal: controller.signal,
      });
      const text = await response.text();
      if (!response.ok) throw new Error("webapi_http_" + response.status);
      secugenPreferredBase = base;
      try { return JSON.parse(text); } catch (_) { return Object.fromEntries(new URLSearchParams(text)); }
    } catch (error) {
      if (base === secugenPreferredBase) secugenPreferredBase = "";
      lastError = error;
    } finally {
      window.clearTimeout(timeout);
    }
  }
  throw new Error(lastError?.name === "AbortError" ? "webapi_unreachable_timeout" : "webapi_unreachable");
}

function secugenErrorCode(data) {
  const raw = data?.ErrorCode ?? data?.errorCode ?? data?.error_code ?? 0;
  const n = parseInt(raw, 10);
  return Number.isFinite(n) ? n : 0;
}

async function secugenCapture({ timeout = 10000, quality = 50 } = {}) {
  const data = await secugenPost(SECUGEN_CAPTURE_PATH, {
    Timeout: String(timeout),
    Quality: String(quality),
    licstr: "",
    templateFormat: SECUGEN_TEMPLATE_FORMAT,
  }, timeout + 3000);
  const code = secugenErrorCode(data);
  if (code !== 0) {
    if ([54, 55, 56, 57].includes(code)) throw new Error("not_connected");
    if ([51, 52, 53].includes(code)) throw new Error("low_quality");
    throw new Error("secugen_error_" + code);
  }
  const template = data?.TemplateBase64 || data?.templateBase64 || data?.Template || data?.template || "";
  if (!template) throw new Error("low_quality");
  const bitmap = data?.BMPBase64 || data?.BmpBase64 || data?.bmpBase64 || data?.ImageBase64 || data?.imageBase64 || "";
  const previewUrl = bitmap
    ? (String(bitmap).startsWith("data:") ? String(bitmap) : `data:image/bmp;base64,${bitmap}`)
    : "";
  return {
    template,
    deviceSerial: data?.SerialNumber || data?.DeviceSerial || data?.deviceSerial || data?.DeviceID || "",
    quality: data?.ImageQuality || data?.Quality || "",
    previewUrl,
  };
}

async function secugenMatchScore(templateA, templateB) {
  const data = await secugenPost(SECUGEN_MATCH_PATH, {
    template1: templateA,
    template2: templateB,
    Template1: templateA,
    Template2: templateB,
    templateFormat: SECUGEN_TEMPLATE_FORMAT,
  }, 8000);
  const code = secugenErrorCode(data);
  if (code !== 0) throw new Error("match_service_" + code);
  const raw = data?.MatchingScore ?? data?.Score ?? data?.score ?? data?.matchScore ?? 0;
  const score = parseInt(raw, 10);
  return Number.isFinite(score) ? score : 0;
}

async function secugenVerify(templateA, templateB) {
  const score = await secugenMatchScore(templateA, templateB);
  return { ok: score >= SECUGEN_MATCH_THRESHOLD, score };
}

async function loadFingerprintTemplates(branchId = null) {
  const data = await authApi("/api/auth/fingerprints/templates", { branchId }, { device: true });
  return Array.isArray(data.templates) ? data.templates : [];
}

async function identifyFingerprint(capture, branchId = null, preferredUserId = null) {
  const templates = await loadFingerprintTemplates(branchId);
  const pool = preferredUserId ? templates.filter((t) => t.userId === preferredUserId) : templates;
  if (!pool.length) throw new Error(preferredUserId ? "No fingerprint is enrolled for this user." : "No fingerprints are enrolled yet.");
  let best = null;
  for (const entry of pool) {
    try {
      const match = await secugenVerify(capture.template, entry.template);
      if (!best || match.score > best.score) best = { ...entry, score: match.score };
      if (match.ok) return { ...entry, score: match.score };
    } catch (error) {
      if (!String(error.message || "").startsWith("match_service_")) throw error;
      throw new Error("match_service");
    }
  }
  return best && best.score >= SECUGEN_MATCH_THRESHOLD ? best : null;
}

async function fingerprintLogin(branchId = null, deviceName = "Web POS") {
  const capture = await secugenCapture();
  const match = await identifyFingerprint(capture, branchId);
  if (!match) {
    await authApi("/api/auth/fingerprints/failed", { branchId, deviceSerial: capture.deviceSerial, reason: "login_not_recognized", deviceName }).catch(() => {});
    throw new Error("Fingerprint not recognized.");
  }
  return await authApi("/api/auth/fingerprints/login", { userId: match.userId, branchId, deviceSerial: capture.deviceSerial, deviceName });
}

function accountToSession(account, fallbackBranchId = "") {
  if (!account) return null;
  return {
    id: account.id,
    name: account.name || (account.kind === "admin" ? "Admin" : "User"),
    role: account.role || (account.kind === "admin" ? "Admin" : account.kind === "cashier" ? "Cashier" : "Supervisor"),
    branchId: account.branchId || fallbackBranchId || "",
    rights: account.rights?.rights || account.rights || [],
    kind: account.kind,
    status: account.status || "active",
  };
}
function isActiveEmployee(emp) {
  return !!emp && emp.status !== "deleted" && emp.status !== "inactive";
}
function activeEmployees(data) {
  return (data?.employees || []).filter(isActiveEmployee);
}
function activeCashiers(data) {
  return activeEmployees(data).filter((e) => e.role === "Cashier");
}
function branchCashiers(data, branchId) {
  return activeCashiers(data)
    .filter((cashier) => cashier.branchId === branchId)
    .sort((a, b) => String(a.id || a.name || "").localeCompare(String(b.id || b.name || "")));
}
function cashierJointDebtCapturedCents(data, debtId, cashierId = null) {
  return (data?.cashierJointDebtPayments || []).reduce((sum, payment) => {
    if (payment.debtId !== debtId || (payment.status && payment.status !== "captured")) return sum;
    if (cashierId && payment.cashierId !== cashierId) return sum;
    return sum + Math.max(0, Number(payment.amountCents) || 0);
  }, 0);
}
function cashierJointDebtShareBalance(data, debt, share) {
  const assignedCents = Math.max(0, Number(share?.amountCents) || 0);
  const legacyPaidCents = Math.max(0, Number(share?.paidCents) || 0);
  const ledgerPaidCents = cashierJointDebtCapturedCents(data, debt?.id, share?.cashierId);
  const paidCents = Math.min(assignedCents, legacyPaidCents + ledgerPaidCents);
  return { assignedCents, paidCents, outstandingCents: Math.max(0, assignedCents - paidCents) };
}
function cashierJointDebtTotals(data, debt) {
  const shares = debt?.shares || [];
  if (!shares.length) {
    const assignedCents = Math.max(0, Number(debt?.totalCents) || 0);
    const paidCents = Math.min(assignedCents, cashierJointDebtCapturedCents(data, debt?.id));
    return { assignedCents, paidCents, outstandingCents: Math.max(0, assignedCents - paidCents) };
  }
  return shares.reduce((totals, share) => {
    const balance = cashierJointDebtShareBalance(data, debt, share);
    return {
      assignedCents: totals.assignedCents + balance.assignedCents,
      paidCents: totals.paidCents + balance.paidCents,
      outstandingCents: totals.outstandingCents + balance.outstandingCents,
    };
  }, { assignedCents: 0, paidCents: 0, outstandingCents: 0 });
}
function cashierJointDebtOutstanding(data, debt) {
  return cashierJointDebtTotals(data, debt).outstandingCents;
}
function cashierJointDebtEntries(data, cashierId, branchId = null) {
  return (data?.cashierJointDebts || []).flatMap((debt) => {
    if (branchId && debt.branchId !== branchId) return [];
    const share = (debt.shares || []).find((entry) => entry.cashierId === cashierId);
    if (!share) return [];
    const balance = cashierJointDebtShareBalance(data, debt, share);
    return balance.outstandingCents > 0 ? [{ debt, share, ...balance }] : [];
  });
}
function cashierJointDebtCashierBalances(data, branchId = null) {
  const balances = new Map();
  (data?.cashierJointDebts || []).forEach((debt) => {
    if (branchId && debt.branchId !== branchId) return;
    (debt.shares || []).forEach((share) => {
      if (!share.cashierId) return;
      const balance = cashierJointDebtShareBalance(data, debt, share);
      const current = balances.get(share.cashierId) || {
        cashierId: share.cashierId,
        cashierName: share.cashierName || share.cashierId,
        assignedCents: 0,
        paidCents: 0,
        outstandingCents: 0,
        debtCount: 0,
        allocations: [],
      };
      current.cashierName = share.cashierName || current.cashierName;
      current.assignedCents += balance.assignedCents;
      current.paidCents += balance.paidCents;
      current.outstandingCents += balance.outstandingCents;
      if (balance.assignedCents > 0) current.debtCount += 1;
      current.allocations.push({ debt, share, ...balance });
      balances.set(share.cashierId, current);
    });
  });
  return [...balances.values()].sort((a, b) => b.outstandingCents - a.outstandingCents || a.cashierName.localeCompare(b.cashierName));
}
function nextQuickInventoryNumber(data) {
  const references = [
    ...(data?.countLog || []).map((entry) => entry.quickInventoryCode),
    ...(data?.cashierJointDebts || []).filter((debt) => debt.source === "quick_inventory").map((debt) => debt.stockCountCode),
  ];
  const sequence = references.reduce((highest, reference) => {
    const match = /^QI-(\d{6,9})$/.exec(String(reference || "").trim());
    return match ? Math.max(highest, Number(match[1])) : highest;
  }, 0) + 1;
  return `QI-${String(sequence).padStart(6, "0")}`;
}
function createCashierJointDebt(data, session, rows, operator, ts = now(), source = "stock_count") {
  const branchId = session?.branchId;
  const items = (rows || []).filter((row) => Number(row.varianceQty) < 0).map((row) => {
    const missingQty = Math.abs(Number(row.varianceQty) || 0);
    const unitCostCents = branchInventoryCostCents(data, row.product, branchId);
    return {
      productId: row.productId,
      productName: row.product?.name || row.productId,
      sku: row.product?.sku || "",
      missingQty,
      unitCostCents,
      amountCents: Math.max(0, Math.round(missingQty * unitCostCents)),
    };
  }).filter((item) => item.amountCents > 0);
  const totalCents = items.reduce((sum, item) => sum + item.amountCents, 0);
  if (!branchId || totalCents <= 0) return null;
  const cashiers = branchCashiers(data, branchId);
  const baseShare = cashiers.length ? Math.floor(totalCents / cashiers.length) : 0;
  const remainder = cashiers.length ? totalCents % cashiers.length : 0;
  const shares = cashiers.map((cashier, index) => ({
    cashierId: cashier.id,
    cashierName: cashier.name,
    amountCents: baseShare + (index < remainder ? 1 : 0),
    paidCents: 0,
  }));
  return {
    id: "cjd_" + session.id,
    branchId,
    stockCountSessionId: session.id,
    stockCountCode: session.code,
    status: shares.length ? "open" : "unallocated",
    shortageUnits: items.reduce((sum, item) => sum + item.missingQty, 0),
    totalCents,
    cashierCount: shares.length,
    items,
    shares,
    source,
    createdBy: operator,
    ts,
    synced: false,
  };
}
async function provisionCloudEmployeeCredentials(data) {
  const employees = Array.isArray(data?.employees) ? data.employees : [];
  const admin = data?.admin;
  const owner = admin?.password && (admin?.email || admin?.phone)
    ? [{ id: "admin", name: admin.name || "Owner", role: "Admin", email: admin.email || "", phone: admin.phone || "", password: admin.password, rights: { admin: true } }]
    : [];
  const candidates = employees.filter((emp) => {
    if (!emp?.id || !emp?.name || !emp?.role) return false;
    if (emp.status === "deleted" || emp.status === "inactive") return false;
    if (emp.role === "Cashier") return /^\d{4}$/.test(String(emp.pin || ""));
    return !!emp.email && !!emp.password;
  });
  const allCandidates = [...owner, ...candidates];
  if (!allCandidates.length) return { ok: 0, failed: 0 };

  let ok = 0;
  let failed = 0;
  for (const emp of allCandidates) {
    try {
      const secret = emp.role === "Cashier" ? { pin: String(emp.pin) } : { password: emp.password };
      await authApi("/api/auth/users", { ...emp, ...secret }, { session: true });
      ok += 1;
    } catch (_) {
      failed += 1;
    }
  }
  return { ok, failed };
}
async function aiComplete({ system, messages, maxTokens = 400, sessionToken = "" }) {
  const cfg = syncConfig();
  const token = syncSessionToken(sessionToken);
  const response = await fetch(cfg.apiBaseUrl + "/api/ai/ask", {
    method: "POST",
    headers: sessionAuthHeaders({ "Content-Type": "application/json" }, token),
    cache: "no-store",
    body: JSON.stringify({ system, messages, maxTokens, sessionToken: token }),
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(data.error || "ai_request_failed");
    error.status = response.status;
    throw error;
  }
  return String(data.text || "").trim();
}
function cleanPayload(type, record) {
  const { synced, _sync, _serverTs, serverTs, ...payload } = record || {};
  if (type === "user") {
    delete payload.pin;
    delete payload.password;
    delete payload.plainPin;
    delete payload.plainPassword;
  }
  return payload;
}
function stableJson(v) {
  if (Array.isArray(v)) return "[" + v.map(stableJson).join(",") + "]";
  if (v && typeof v === "object") return "{" + Object.keys(v).sort().map((k) => JSON.stringify(k) + ":" + stableJson(v[k])).join(",") + "}";
  return JSON.stringify(v);
}
function recordChanged(a, b, type) { return stableJson(cleanPayload(type, a)) !== stableJson(cleanPayload(type, b)); }
function branchIdFor(record, data) {
  return record?.branchId || record?.fromBranchId || record?.toBranchId || data?.settings?.activeBranchId || data?.branches?.[0]?.id || null;
}
function eventFromRecord(collection, record, data) {
  const appendType = SYNC_APPEND.get(collection);
  const mutableType = SYNC_MUTABLE.get(collection);
  const type = appendType || mutableType;
  if (!type || !record?.id) return null;
  const ts = Number(record.updatedAt || record.ts || now());
  return {
    id: String(record.id),
    type,
    branchId: branchIdFor(record, data),
    ...(appendType ? { clientTs: ts } : { updatedAt: ts }),
    ...(mutableType && Number(record._serverTs || record.serverTs || 0) > 0
      ? { baseServerTs: Number(record._serverTs || record.serverTs) }
      : {}),
    payload: cleanPayload(type, record),
  };
}
function settingsEvent(data) {
  return {
    id: "settings",
    type: "setting",
    branchId: data?.settings?.activeBranchId || data?.branches?.[0]?.id || null,
    updatedAt: now(),
    payload: { ...(data?.settings || {}), branchPricing: data?.branchPricing || {} },
  };
}
function diffToSyncEvents(prev, next) {
  if (!prev || !next) return [];
  const events = [];
  for (const collection of SYNC_ARRAYS) {
    if (AUTH_SYNC_COLLECTIONS.has(collection)) continue;
    const type = SYNC_APPEND.get(collection) || SYNC_MUTABLE.get(collection);
    const before = new Map((prev[collection] || []).map((x) => [x.id, x]));
    for (const record of next[collection] || []) {
      if (!record?.id) continue;
      const old = before.get(record.id);
      if (!old || recordChanged(old, record, type)) {
        const ev = eventFromRecord(collection, { ...record, updatedAt: record.updatedAt || record.ts || now() }, next);
        if (ev) events.push(ev);
      }
    }
    if (collection === "purchases") {
      const afterIds = new Set((next[collection] || []).map((record) => record?.id).filter(Boolean));
      for (const old of prev[collection] || []) {
        if (!old?.id || afterIds.has(old.id)) continue;
        events.push({
          id: String(old.id),
          type,
          branchId: branchIdFor(old, next),
          updatedAt: now(),
          deleted: true,
          payload: {},
        });
      }
    }
  }
  if (recordChanged({ settings: prev.settings, branchPricing: prev.branchPricing }, { settings: next.settings, branchPricing: next.branchPricing }, "setting")) {
    events.push(settingsEvent(next));
  }
  return events;
}
function mergeById(list, record) {
  const idx = (list || []).findIndex((x) => x.id === record.id);
  if (idx < 0) return [...(list || []), record];
  const next = (list || []).slice();
  next[idx] = { ...next[idx], ...record };
  return next;
}
function paymentInvoiceId(payment) {
  return payment?.orderId || payment?.invoiceId || null;
}
function invoicePaymentTotals(data) {
  const totals = {};
  (data?.payments || []).forEach((payment) => {
    if (payment?.status && payment.status !== "captured") return;
    const id = paymentInvoiceId(payment);
    if (!id) return;
    totals[id] = (totals[id] || 0) + (Number(payment.amountCents) || 0);
  });
  return totals;
}
function reconcileInvoicePayments(data) {
  const totals = invoicePaymentTotals(data);
  return {
    ...data,
    invoices: (data?.invoices || []).map((inv) => {
      const total = Number(inv.totalCents) || 0;
      const paid = Math.min(total, Math.max(Number(inv.paidCents) || 0, totals[inv.id] || 0));
      const reconciled = { ...inv, paidCents: paid };
      return { ...reconciled, carriedOver: invoiceWasCarriedOver(data, reconciled) };
    }),
  };
}
function collectionForType(type) {
  for (const [collection, t] of SYNC_APPEND) if (t === type) return collection;
  for (const [collection, t] of SYNC_MUTABLE) if (t === type) return collection;
  if (type === "setting") return "settings";
  return null;
}
function mergeSyncEvents(data, events) {
  let next = { ...data };
  for (const ev of events || []) {
    const collection = collectionForType(ev.type);
    if (!collection) continue;
    if (collection === "settings") {
      const { branchPricing, ...settings } = ev.payload || {};
      next = { ...next, settings: { ...next.settings, ...settings }, branchPricing: branchPricing || next.branchPricing || {} };
      continue;
    }
    if (ev.deleted) {
      next = { ...next, [collection]: (next[collection] || []).filter((x) => x.id !== ev.id) };
      continue;
    }
    const existing = (next[collection] || []).find((x) => x.id === ev.id);
    if (SYNC_MUTABLE.has(collection) && existing) {
      const incomingServerTs = Number(ev.serverTs || 0);
      const existingServerTs = Number(existing._serverTs || existing.serverTs || 0);
      if (incomingServerTs > 0 && existingServerTs >= incomingServerTs) continue;
      if (existing.synced === false
        && Number(existing.updatedAt || existing.ts || 0) > Number(ev.updatedAt || ev.serverTs || 0)) continue;
    }
    const record = { ...(ev.payload || {}), id: ev.id, branchId: ev.branchId ?? ev.payload?.branchId, synced: true };
    if (SYNC_MUTABLE.has(collection)) {
      record.updatedAt = ev.updatedAt || ev.serverTs || now();
      record._serverTs = Number(ev.serverTs || 0);
    }
    else record.ts = record.ts || ev.clientTs || ev.serverTs || now();
    next = { ...next, [collection]: mergeById(next[collection], record) };
  }
  return reconcileInvoicePayments(next);
}
function markAcceptedSynced(data, acceptedIds) {
  const ids = new Set(acceptedIds || []);
  const mark = (arr) => (arr || []).map((x) => ids.has(x.id) ? { ...x, synced: true } : x);
  const next = { ...data };
  for (const collection of SYNC_ARRAYS) next[collection] = mark(next[collection]);
  return next;
}
async function loadOutbox() { return await loadJson(OUTBOX_KEY, []); }
async function saveOutbox(outbox) { await saveJson(OUTBOX_KEY, outbox || []); }
function hasCredentialLikePayload(ev) {
  const payload = ev?.payload || {};
  if (!payload || typeof payload !== "object") return false;
  return ["pin", "password", "passwordHash", "password_hash", "credential", "credentials", "rights"].some((key) => Object.prototype.hasOwnProperty.call(payload, key));
}
function isAuthSyncEvent(ev) {
  return AUTH_SYNC_TYPES.has(String(ev?.type || "")) || hasCredentialLikePayload(ev);
}
async function pruneAuthSyncEvents(outbox) {
  const list = Array.isArray(outbox) ? outbox : [];
  const next = list.filter((ev) => !isAuthSyncEvent(ev));
  if (next.length !== list.length) await saveOutbox(next);
  return next;
}
async function loadCursor() { return Number(await kvGet(CURSOR_KEY) || 0); }
async function saveCursor(cursor) { await kvSet(CURSOR_KEY, String(cursor || 0)); }
async function loadResetEpoch() { return String(await kvGet(RESET_EPOCH_KEY) || ""); }
async function saveResetEpoch(epoch) { await kvSet(RESET_EPOCH_KEY, String(epoch || "")); }
async function applyOperationalReset(epoch, mode) {
  await saveOutbox([]);
  await saveCursor(0);
  await saveResetEpoch(epoch);
  const clean = applyEnvironmentMode(CLEAN_SETUP(), mode);
  await saveData(clean);
  return clean;
}
async function syncStatus() {
  const outbox = await pruneAuthSyncEvents(await loadOutbox());
  const cursor = await loadCursor();
  return { outboxLength: outbox.length, cursor, error: "" };
}
function applyEnvironmentMode(data, mode) {
  const normalized = normalizeLoadedData(data || CLEAN_SETUP()) || CLEAN_SETUP();
  return {
    ...normalized,
    settings: {
      ...normalized.settings,
      environmentMode: normalizeEnvironmentMode(mode),
    },
  };
}
async function resetEnvironmentSyncState(mode) {
  await saveOutbox([]);
  await saveCursor(0);
  return { ...applyEnvironmentMode(CLEAN_SETUP(), mode), _sync: await syncStatus() };
}
async function loadEnvironmentAwareData(env) {
  const mode = normalizeEnvironmentMode(env?.mode);
  const loaded = await loadData();
  const storedMode = loaded?.settings?.environmentMode;
  const needsEnvironmentReset = !!loaded && (!storedMode || normalizeEnvironmentMode(storedMode) !== mode);
  const base = needsEnvironmentReset ? await resetEnvironmentSyncState(mode) : { ...applyEnvironmentMode(loaded || CLEAN_SETUP(), mode), _sync: await syncStatus() };
  return await cloudBootstrapData(base);
}
async function enqueueChanges(prev, next) {
  const changes = diffToSyncEvents(prev, next).filter((ev) => !isAuthSyncEvent(ev));
  if (!changes.length) return await syncStatus();
  const outbox = await pruneAuthSyncEvents(await loadOutbox());
  const seen = new Set(outbox.map((e) => e.type + ":" + e.id + ":" + (e.updatedAt || e.clientTs || "")));
  for (const ev of changes) {
    const key = ev.type + ":" + ev.id + ":" + (ev.updatedAt || ev.clientTs || "");
    if (!seen.has(key)) { outbox.push(ev); seen.add(key); }
  }
  await saveOutbox(outbox);
  return { outboxLength: outbox.length, cursor: await loadCursor() };
}
async function runSyncClient(currentData, options = {}) {
  const cfg = syncConfig();
  const branchId = currentData?.settings?.activeBranchId || currentData?.branches?.[0]?.id || null;
  let data = currentData;
  const credentialProvision = { ok: 0, failed: 0 };
  let outbox = await pruneAuthSyncEvents(await loadOutbox());
  let cursor = await loadCursor();
  let resetEpoch = await loadResetEpoch();
  if (options.forceFullPull) {
    cursor = 0;
    await saveCursor(0);
  }
  const headers = await syncAuthHeaders(branchId, { "Content-Type": "application/json" }, options.sessionToken || "");
  let rejected = [];
  let pushErrorText = "";
  if (outbox.length) {
    try {
      const pushed = await fetch(cfg.apiBaseUrl + "/api/sync/push", { method: "POST", headers, cache: "no-store", body: JSON.stringify({ events: outbox, resetEpoch }) });
      if (!pushed.ok) {
        const errorBody = await pushed.json().catch(() => ({}));
        if (pushed.status === 409 && errorBody?.error === "operational_reset_required") {
          resetEpoch = String(errorBody.resetEpoch || "");
          data = await applyOperationalReset(resetEpoch, currentData?.settings?.environmentMode);
          outbox = [];
          cursor = 0;
          pushErrorText = "";
          return await runSyncClient(data, { ...options, forceFullPull: true });
        }
        throw new Error(errorBody?.error ? `push_failed_${pushed.status}_${errorBody.error}` : "push_failed_" + pushed.status);
      }
      const body = await pushed.json();
      rejected = Array.isArray(body.rejected) ? body.rejected : [];
      if (body.invoiceNumbers && typeof body.invoiceNumbers === "object") {
        data = {
          ...data,
          invoices: (data.invoices || []).map((invoice) => body.invoiceNumbers[invoice.id]
            ? { ...invoice, number: body.invoiceNumbers[invoice.id], synced: true }
            : invoice),
        };
      }
      if (body.transferNumbers && typeof body.transferNumbers === "object") {
        data = {
          ...data,
          borrowings: (data.borrowings || []).map((transfer) => body.transferNumbers[transfer.id]
            ? { ...transfer, number: body.transferNumbers[transfer.id], synced: true }
            : transfer),
        };
      }
      const done = new Set([...(body.accepted || []), ...rejected.map((item) => item.id).filter(Boolean)]);
      outbox = outbox.filter((ev) => !done.has(ev.id));
      await saveOutbox(outbox);
      data = markAcceptedSynced(data, body.accepted || []);
    } catch (error) {
      pushErrorText = error?.message || "push_failed";
    }
  }
  let hasMore = true;
  while (hasMore) {
    const pulled = await fetch(cfg.apiBaseUrl + "/api/sync/pull?since=" + encodeURIComponent(cursor) + "&t=" + Date.now(), { headers, cache: "no-store" });
    if (!pulled.ok) {
      const errorBody = await pulled.json().catch(() => ({}));
      throw new Error(errorBody?.error ? `pull_failed_${pulled.status}_${errorBody.error}` : "pull_failed_" + pulled.status);
    }
    const body = await pulled.json();
    const serverResetEpoch = String(body.resetEpoch || "");
    if (serverResetEpoch && serverResetEpoch !== resetEpoch) {
      resetEpoch = serverResetEpoch;
      data = await applyOperationalReset(resetEpoch, currentData?.settings?.environmentMode);
      outbox = [];
      cursor = 0;
      await saveCursor(0);
      continue;
    }
    data = mergeSyncEvents(data, body.events || []);
    const nextCursor = Number(body.cursor || cursor || 0);
    hasMore = !!body.hasMore && nextCursor > cursor;
    cursor = nextCursor;
    await saveCursor(cursor);
  }
  const visibleRejected = rejected.filter((item) => item?.reason !== "auth_records_do_not_sync");
  const rejectedText = visibleRejected.length ? `${visibleRejected.length} queued change(s) were rejected by the server: ${visibleRejected.map((item) => item.reason || "unknown").join(", ")}` : "";
  if (credentialProvision.failed) console.warn("staff credential provisioning skipped from sync status", credentialProvision);
  const credentialText = "";
  const nextSyncError = outbox.length ? [pushErrorText, rejectedText, credentialText].filter(Boolean).join(" ") : "";
  data = { ...data, lastSyncedAt: now(), _sync: { outboxLength: outbox.length, cursor, error: nextSyncError } };
  await saveData(data);
  return { data, status: data._sync };
}
async function syncStreamUrl(branchId = null) {
  const cfg = syncConfig();
  if (syncUsesSessionAuth()) {
    const token = activeSessionToken || storedSessionTokenSync();
    return cfg.apiBaseUrl + "/api/sync/stream?sessionToken=" + encodeURIComponent(token) + "&t=" + Date.now();
  }
  const token = cfg.deviceToken || await ensureDeviceToken(branchId);
  return cfg.apiBaseUrl + "/api/sync/stream?token=" + encodeURIComponent(token) + "&t=" + Date.now();
}
async function cloudBootstrapData(localData, options = {}) {
  const base = localData || { ...CLEAN_SETUP(), _sync: await syncStatus() };
  try {
    const localHasBranches = Array.isArray(base.branches) && base.branches.length > 0;
    const localHasProducts = Array.isArray(base.products) && base.products.length > 0;
    const needsFullBootstrap = Boolean(options.forceFullPull || !localHasBranches || !localHasProducts);
    if (needsFullBootstrap) await saveCursor(0);
    const first = (await runSyncClient(base, { ...options, forceFullPull: needsFullBootstrap })).data;
    if (!Array.isArray(first.branches) || first.branches.length === 0 || !Array.isArray(first.products) || first.products.length === 0) {
      await saveCursor(0);
      const retryBase = { ...first, _sync: { ...(first._sync || {}), cursor: 0 } };
      return (await runSyncClient(retryBase, { ...options, forceFullPull: true })).data;
    }
    return first;
  } catch (error) {
    return { ...base, _sync: { ...(base._sync || await syncStatus()), error: error.message } };
  }
}

/* ================================================================== */
/*  Helpers                                                           */
/* ================================================================== */
function fmt(cents, cur = "KES") {
  const v = cents / 100;
  if (cur === "KES") return "KES " + Math.round(v).toLocaleString();
  return (cur || "$") + v.toFixed(2);
}
function fmtExact(cents, cur = "KES", maximumFractionDigits = 2) {
  const value = (Number(cents) || 0) / 100;
  const amount = value.toLocaleString(undefined, {
    minimumFractionDigits: 2,
    maximumFractionDigits,
  });
  return (cur === "KES" ? "KES " : (cur || "$")) + amount;
}
function preciseCents(value, fractionDigits = 6) {
  const numeric = Math.max(0, Number(value) || 0);
  const factor = 10 ** fractionDigits;
  return Math.round(numeric * factor) / factor;
}
function purchaseLineTotalCents(line) {
  const storedTotal = Number(line?.lineTotalCents);
  if (Number.isFinite(storedTotal) && storedTotal >= 0) return Math.round(storedTotal);
  return Math.round(Math.max(0, Number(line?.qty) || 0) * Math.max(0, Number(line?.costCents) || 0));
}
function purchaseUnitCostCents(line) {
  const quantity = Math.max(0, Number(line?.qty) || 0);
  if (quantity > 0 && line?.lineTotalCents !== undefined && line?.lineTotalCents !== null) {
    return purchaseLineTotalCents(line) / quantity;
  }
  return Math.max(0, Number(line?.costCents) || 0);
}
function moneyInputValue(cents) {
  const v = (Number(cents) || 0) / 100;
  return Number.isInteger(v) ? String(v) : v.toFixed(2);
}
function centsFromInput(value) {
  return Math.max(0, Math.round((parseFloat(value) || 0) * 100));
}
function clampPaymentCents(value, balanceCents) {
  return Math.min(Math.max(0, Number(balanceCents) || 0), centsFromInput(value));
}
function onHand(data, productId, branchId) {
  return data.stockMovements.filter((m) => m.productId === productId && (!branchId || m.branchId === branchId)).reduce((s, m) => s + m.qty, 0);
}
function wacCost(prevQty, prevCost, addQty, addCost) {
  const q = Math.max(0, prevQty); const denom = q + addQty;
  if (denom <= 0) return preciseCents(addCost);
  return preciseCents((q * prevCost + addQty * addCost) / denom);
}
const BRANCH_PRICE_MAP_FIELDS = ["branchPrices", "priceByBranch", "sellingPrices", "sellingPriceByBranch", "branchSellingPrices"];
const BRANCH_COST_MAP_FIELDS = ["branchCosts", "costByBranch", "movingAverageCostByBranch", "averageCostByBranch", "branchMovingAverageCosts"];
function branchMappedCentsState(product, branchId, mapFields, valueFields, preserveFraction = false) {
  if (!product || !branchId) return { hasMap: false, value: null };
  const wantedBranch = String(branchId).trim().toLowerCase();
  let hasMap = false;
  for (const mapField of mapFields) {
    const map = product[mapField];
    if (!map || typeof map !== "object" || Array.isArray(map)) continue;
    hasMap = true;
    const branchKey = Object.keys(map).find((key) => String(key).trim().toLowerCase() === wantedBranch);
    if (!branchKey) continue;
    const raw = map[branchKey];
    if (raw && typeof raw === "object" && !Array.isArray(raw)) {
      for (const valueField of valueFields) {
        if (raw[valueField] !== undefined && raw[valueField] !== null && raw[valueField] !== "") {
          const value = Number(raw[valueField]);
          if (Number.isFinite(value)) return { hasMap, value: preserveFraction ? preciseCents(value) : Math.max(0, Math.round(value)) };
        }
      }
      continue;
    }
    const value = Number(raw);
    if (Number.isFinite(value)) return { hasMap, value: preserveFraction ? preciseCents(value) : Math.max(0, Math.round(value)) };
  }
  return { hasMap, value: null };
}
function branchProductPriceCents(product, branchId) {
  const mapped = branchMappedCentsState(product, branchId, BRANCH_PRICE_MAP_FIELDS, ["priceCents", "sellingPriceCents", "price", "sellingPrice"]);
  return mapped.hasMap ? (mapped.value ?? 0) : Math.max(0, Math.round(Number(product?.priceCents) || 0));
}
function branchProductCostCents(product, branchId) {
  const mapped = branchMappedCentsState(product, branchId, BRANCH_COST_MAP_FIELDS, ["costCents", "movingAverageCostCents", "averageCostCents", "cost", "movingAverageCost", "averageCost"], true);
  return mapped.hasMap ? (mapped.value ?? 0) : preciseCents(product?.costCents);
}
function branchInventoryCostCents(data, product, branchId) {
  const directCost = branchProductCostCents(product, branchId);
  if (directCost > 0 || !data || !product || !branchId) return directCost;

  const productKey = productDedupeKey(product);
  const equivalentProducts = (data.products || [])
    .filter((candidate) => productDedupeKey(candidate) === productKey)
    .sort((a, b) => Number(b.updatedAt || 0) - Number(a.updatedAt || 0));
  const equivalentCost = equivalentProducts
    .map((candidate) => branchProductCostCents(candidate, branchId))
    .find((cost) => cost > 0);
  if (equivalentCost) return equivalentCost;

  const equivalentIds = new Set(equivalentProducts.map((candidate) => candidate.id));
  const normalizedSku = normalizeBarcode(product.sku).toLowerCase();
  const normalizedName = String(product.name || "").trim().toLowerCase();
  const matchesProductRecord = (record) => {
    if (!record) return false;
    if (equivalentIds.has(record.productId || record.id)) return true;
    const recordSku = normalizeBarcode(record.sku || record.productSku).toLowerCase();
    if (normalizedSku && recordSku && recordSku === normalizedSku) return true;
    const recordName = String(record.productName || record.name || "").trim().toLowerCase();
    return !!(normalizedName && recordName && recordName === normalizedName);
  };
  const latestCostedReceipt = (data.stockMovements || [])
    .filter((movement) => movement.branchId === branchId
      && matchesProductRecord(movement)
      && Number(movement.qty || 0) > 0
      && Number(movement.costCents || 0) > 0)
    .sort((a, b) => Number(b.ts || 0) - Number(a.ts || 0))[0];
  if (latestCostedReceipt) {
    return preciseCents(latestCostedReceipt.costCents);
  }

  const latestReceivedPurchase = (data.purchases || [])
    .filter((purchase) => purchase.branchId === branchId
      && matchesProductRecord(purchase)
      && String(purchase.status || "").toLowerCase() === "received"
      && Number(purchase.costCents || 0) > 0)
    .sort((a, b) => Number(b.ts || 0) - Number(a.ts || 0))[0];
  if (latestReceivedPurchase) {
    return preciseCents(purchaseUnitCostCents(latestReceivedPurchase));
  }

  const latestInboundTransfer = (data.borrowings || [])
    .filter((transfer) => transfer.toBranchId === branchId)
    .flatMap((transfer) => {
      const items = Array.isArray(transfer.items) && transfer.items.length
        ? transfer.items
        : [{
          productId: transfer.productId,
          sku: transfer.sku,
          costCents: transfer.costCents,
        }];
      return items
        .filter(matchesProductRecord)
        .map((item) => ({ ...item, ts: transfer.ts, fromBranchId: transfer.fromBranchId }));
    })
    .sort((a, b) => Number(b.ts || 0) - Number(a.ts || 0))[0];
  if (Number(latestInboundTransfer?.costCents || 0) > 0) {
    return preciseCents(latestInboundTransfer.costCents);
  }

  const inboundMovement = (data.stockMovements || [])
    .filter((movement) => movement.branchId === branchId
      && matchesProductRecord(movement)
      && Number(movement.qty || 0) > 0
      && /^transfer from /i.test(String(movement.reason || "")))
    .sort((a, b) => Number(b.ts || 0) - Number(a.ts || 0))[0];
  const movementSourceName = String(inboundMovement?.reason || "")
    .replace(/^transfer from /i, "")
    .split(" (")[0]
    .trim()
    .toLowerCase();
  const movementSourceBranchId = (data.branches || [])
    .find((candidate) => String(candidate.name || "").trim().toLowerCase() === movementSourceName)?.id;
  const sourceBranchId = latestInboundTransfer?.fromBranchId || movementSourceBranchId;
  if (sourceBranchId) {
    const sourceMappedCost = equivalentProducts
      .map((candidate) => branchProductCostCents(candidate, sourceBranchId))
      .find((cost) => cost > 0);
    if (sourceMappedCost) return sourceMappedCost;

    const sourceReceipt = (data.stockMovements || [])
      .filter((movement) => movement.branchId === sourceBranchId
        && matchesProductRecord(movement)
        && Number(movement.qty || 0) > 0
        && Number(movement.costCents || 0) > 0)
      .sort((a, b) => Number(b.ts || 0) - Number(a.ts || 0))[0];
    if (sourceReceipt) {
      return preciseCents(sourceReceipt.costCents);
    }

    const sourcePurchase = (data.purchases || [])
      .filter((purchase) => purchase.branchId === sourceBranchId
        && matchesProductRecord(purchase)
        && String(purchase.status || "").toLowerCase() === "received"
        && Number(purchase.costCents || 0) > 0)
      .sort((a, b) => Number(b.ts || 0) - Number(a.ts || 0))[0];
    if (sourcePurchase) {
      return preciseCents(purchaseUnitCostCents(sourcePurchase));
    }
  }

  return preciseCents(product.costCents);
}
function productStockValuation(data, product, branchId) {
  const branchIds = branchId ? [branchId] : (data?.branches || []).map((branch) => branch.id);
  if (!branchIds.length) {
    const quantity = Math.max(0, productOnHand(data, product, undefined));
    return {
      quantity,
      costValue: quantity * Math.max(0, Math.round(Number(product?.costCents) || 0)),
      retailValue: quantity * Math.max(0, Math.round(Number(product?.priceCents) || 0)),
    };
  }
  return branchIds.reduce((totals, id) => {
    const quantity = Math.max(0, productOnHand(data, product, id));
    totals.quantity += quantity;
    totals.costValue += quantity * branchInventoryCostCents(data, product, id);
    totals.retailValue += quantity * branchProductPriceCents(product, id);
    return totals;
  }, { quantity: 0, costValue: 0, retailValue: 0 });
}
function productBranchAverageCents(data, product, branchId, valueForBranch) {
  if (branchId) return valueForBranch(product, branchId);
  const values = (data?.branches || [])
    .map((branch) => valueForBranch(product, branch.id))
    .filter((value) => Number(value) > 0);
  return values.length ? preciseCents(values.reduce((sum, value) => sum + value, 0) / values.length) : 0;
}
function withBranchMappedCents(product, branchId, mapField, valueField, cents, preserveFraction = false) {
  if (!product || !branchId) return product;
  return {
    ...product,
    [mapField]: {
      ...(product[mapField] && typeof product[mapField] === "object" && !Array.isArray(product[mapField]) ? product[mapField] : {}),
      [branchId]: { [valueField]: preserveFraction ? preciseCents(cents) : Math.max(0, Math.round(Number(cents) || 0)) },
    },
    updatedAt: now(),
    synced: false,
  };
}
function withBranchProductPrice(product, branchId, cents) {
  return withBranchMappedCents(product, branchId, "branchPrices", "priceCents", cents);
}
function withBranchProductCost(product, branchId, cents) {
  return withBranchMappedCents(product, branchId, "branchCosts", "costCents", cents, true);
}
function withBranchProductCostForKey(products, product, branchId, cents) {
  if (!product) return products;
  const productKey = productDedupeKey(product);
  return products.map((candidate) => productDedupeKey(candidate) === productKey
    ? withBranchProductCost(candidate, branchId, cents)
    : candidate);
}
function priceFor(data, p, branchId) { return branchProductPriceCents(p, branchId); }
function reorderList(data, branchId) { return branchProductsUnique(data, branchId).filter((p) => productOnHand(data, p, branchId) <= (p.reorderLevel ?? data.settings.reorderLevel)); }
function sortProductsAZ(products) {
  return [...(products || [])].sort((a, b) =>
    String(a?.name || "").localeCompare(String(b?.name || ""), undefined, { sensitivity: "base", numeric: true })
  );
}
function stockCountSessions(data) {
  return data?.stockCountSessions || [];
}
function activeStockCountSession(data, branchId) {
  return stockCountSessions(data).find((s) => s.branchId === branchId && ["open", "paused"].includes(s.status)) || null;
}
function nextStockCountCode(data) {
  const max = stockCountSessions(data).reduce((m, s) => {
    const n = parseInt(String(s.code || "").replace(/\D/g, ""), 10);
    return Number.isFinite(n) ? Math.max(m, n) : m;
  }, 0);
  return "SC-" + String(max + 1).padStart(4, "0");
}
function stockCountOperator(data) {
  return data?.admin?.name || data?.session?.account?.name || data?.session?.name || "Admin";
}
function createStockCountSession(data, branchId, operator) {
  const ts = now();
  const items = branchProductsUnique(data, branchId).map((product) => ({
    productId: product.id,
    expectedQty: productOnHand(data, product, branchId),
    countedQty: null,
    countedAt: null,
    countedBy: "",
  }));
  return {
    id: uid("sc"),
    code: nextStockCountCode(data),
    branchId,
    status: "open",
    startedBy: operator,
    startedAt: ts,
    snapshotAt: ts,
    note: "",
    items,
    synced: false,
    updatedAt: ts,
  };
}
function updateStockCountSessionItem(session, productId, countedQty, countedBy) {
  const ts = now();
  return {
    ...session,
    items: (session.items || []).map((item) => item.productId === productId ? { ...item, countedQty, countedAt: ts, countedBy } : item),
    synced: false,
    updatedAt: ts,
  };
}
function salesSinceStockCount(data, session, productId) {
  const since = Number(session?.snapshotAt || session?.startedAt || 0);
  return (data?.stockMovements || [])
    .filter((m) => m.branchId === session?.branchId && m.productId === productId && Number(m.ts || 0) > since && Number(m.qty || 0) < 0 && /sale|invoice/i.test(String(m.reason || "")))
    .reduce((sum, m) => sum + Math.abs(Number(m.qty) || 0), 0);
}
function stockCountRows(data, session) {
  if (!session) return [];
  const productsById = new Map((data?.products || []).map((p) => [p.id, p]));
  return (session.items || []).map((item) => {
    const product = productsById.get(item.productId);
    const expectedQty = Number(item.expectedQty) || 0;
    const countedRaw = item.countedQty === null || item.countedQty === undefined || item.countedQty === "" ? null : Number(item.countedQty);
    const countedQty = Number.isFinite(countedRaw) ? countedRaw : null;
    const soldSince = salesSinceStockCount(data, session, item.productId);
    const finalQty = countedQty === null ? null : Math.max(0, countedQty - soldSince);
    const liveQty = product ? productOnHand(data, product, session.branchId) : onHand(data, item.productId, session.branchId);
    return {
      ...item,
      product,
      expectedQty,
      countedQty,
      soldSince,
      finalQty,
      liveQty,
      varianceQty: countedQty === null ? null : countedQty - expectedQty,
      commitDelta: finalQty === null ? 0 : finalQty - liveQty,
      valueImpact: countedQty === null ? 0 : (countedQty - expectedQty) * branchInventoryCostCents(data, product, session.branchId),
    };
  }).filter((row) => row.product);
}
function stockCountProgress(session) {
  const items = session?.items || [];
  const counted = items.filter((item) => item.countedQty !== null && item.countedQty !== undefined && item.countedQty !== "").length;
  return { counted, total: items.length, percent: items.length ? Math.round((counted / items.length) * 100) : 0 };
}
function generateBarcodeValue() {
  return "VP" + String(Date.now()).slice(-8) + Math.floor(1000 + Math.random() * 9000);
}
function ensureBarcodeEntries(data, codes, barcodeType = "code128") {
  const catalog = [...(data?.barcodeCatalog || [])];
  const byCode = new Map(catalog.map((entry) => [normalizeBarcode(entry.barcode).toLowerCase(), entry]));
  const entries = [];
  for (const raw of codes || []) {
    const barcode = normalizeBarcode(raw);
    if (!barcode) continue;
    const key = barcode.toLowerCase();
    let entry = byCode.get(key);
    if (!entry) {
      entry = { id: uid("bc"), barcode, barcodeType, createdAt: now(), updatedAt: now(), synced: false };
      byCode.set(key, entry);
      catalog.push(entry);
    }
    entries.push(entry);
  }
  return { barcodeCatalog: catalog, entries };
}
function useBarcodeScanner({ enabled, mode, onScan }) {
  const onScanRef = useRef(onScan);
  const bufferRef = useRef("");
  const lastKeyAtRef = useRef(0);
  const lastScanRef = useRef({ code: "", ts: 0 });

  useEffect(() => { onScanRef.current = onScan; }, [onScan]);
  useEffect(() => {
    if (!enabled) return undefined;
    const resetBuffer = () => { bufferRef.current = ""; lastKeyAtRef.current = 0; };
    const isTextEntry = (target) => {
      if (!target) return false;
      const tag = String(target.tagName || "").toLowerCase();
      return target.isContentEditable || tag === "input" || tag === "textarea" || tag === "select";
    };
    const listener = (e) => {
      if (e.defaultPrevented || e.ctrlKey || e.metaKey || e.altKey || isTextEntry(e.target)) return;
      const t = now();
      if (t - lastKeyAtRef.current > 90) bufferRef.current = "";
      lastKeyAtRef.current = t;
      if (e.key === "Enter" || e.key === "Tab") {
        const code = normalizeBarcode(bufferRef.current);
        resetBuffer();
        if (!code) return;
        e.preventDefault();
        const last = lastScanRef.current;
        if (last.code === code && t - last.ts < 1000) {
          appendBarcodeScanLog({ barcode: code, status: mode + ":duplicate_ignored" });
          return;
        }
        lastScanRef.current = { code, ts: t };
        onScanRef.current?.(code);
        return;
      }
      if (e.key && e.key.length === 1) bufferRef.current += e.key;
    };
    window.addEventListener("keydown", listener, true);
    return () => window.removeEventListener("keydown", listener, true);
  }, [enabled, mode]);
}
function cameraScannerError(error) {
  const name = String(error?.name || "");
  if (name === "NotAllowedError" || name === "PermissionDeniedError") return "Camera access was blocked. Allow camera access for VISIONPOS, then try again.";
  if (name === "NotFoundError" || name === "DevicesNotFoundError") return "No camera was found on this device.";
  if (name === "NotReadableError" || name === "TrackStartError") return "The camera is already in use by another app. Close it there, then try again.";
  if (name === "OverconstrainedError" || name === "ConstraintNotSatisfiedError") return "The available camera cannot use the requested scan mode.";
  if (name === "AbortError") return "Camera startup was interrupted. Try again.";
  if (name === "SecurityError") return "Camera access is unavailable for this connection.";
  return "The camera could not start. You can still type the barcode or use a paired scanner.";
}
let barcodeAudioContext = null;
async function openAutomaticRearCamera() {
  const baseVideo = {
    width: { ideal: 1280 },
    height: { ideal: 720 },
    aspectRatio: { ideal: 16 / 9 },
    frameRate: { ideal: 30 },
  };
  try {
    return await navigator.mediaDevices.getUserMedia({
      audio: false,
      video: { ...baseVideo, facingMode: { exact: "environment" } },
    });
  } catch (error) {
    const name = String(error?.name || "");
    if (!["OverconstrainedError", "ConstraintNotSatisfiedError", "NotFoundError", "DevicesNotFoundError", "TypeError"].includes(name)) throw error;
    return navigator.mediaDevices.getUserMedia({
      audio: false,
      video: { ...baseVideo, facingMode: { ideal: "environment" } },
    });
  }
}
function prepareBarcodeSuccessTone() {
  const AudioContextClass = window.AudioContext || window.webkitAudioContext;
  if (!AudioContextClass) return;
  try {
    if (!barcodeAudioContext) barcodeAudioContext = new AudioContextClass();
    if (barcodeAudioContext.state === "suspended") barcodeAudioContext.resume().catch(() => {});
  } catch (_) {}
}

function playBarcodeSuccessTone() {
  const AudioContextClass = window.AudioContext || window.webkitAudioContext;
  if (!AudioContextClass) return;
  try {
    if (!barcodeAudioContext) barcodeAudioContext = new AudioContextClass();
    const play = () => {
      const startedAt = barcodeAudioContext.currentTime;
      const oscillator = barcodeAudioContext.createOscillator();
      const gain = barcodeAudioContext.createGain();
      oscillator.type = "sine";
      oscillator.frequency.setValueAtTime(880, startedAt);
      oscillator.frequency.exponentialRampToValueAtTime(1174, startedAt + 0.08);
      gain.gain.setValueAtTime(0.0001, startedAt);
      gain.gain.exponentialRampToValueAtTime(0.16, startedAt + 0.01);
      gain.gain.exponentialRampToValueAtTime(0.0001, startedAt + 0.13);
      oscillator.connect(gain);
      gain.connect(barcodeAudioContext.destination);
      oscillator.start(startedAt);
      oscillator.stop(startedAt + 0.14);
    };
    if (barcodeAudioContext.state === "suspended") barcodeAudioContext.resume().then(play).catch(() => {});
    else play();
  } catch (_) {}
}
function CameraBarcodeScanner({ onClose, onScan, continuous = false, eyebrow = "Products", title = "Scan product barcode" }) {
  const videoRef = useRef(null);
  const controlsRef = useRef(null);
  const streamRef = useRef(null);
  const foundRef = useRef(false);
  const scanStateRef = useRef({ code: "", lastDetectedAt: 0, armed: true });
  const onCloseRef = useRef(onClose);
  const onScanRef = useRef(onScan);
  useLayoutEffect(() => { prepareBarcodeSuccessTone(); }, []);
  const [attempt, setAttempt] = useState(0);
  const [status, setStatus] = useState("Starting camera...");
  const [error, setError] = useState("");
  const [torchAvailable, setTorchAvailable] = useState(false);
  const [torchOn, setTorchOn] = useState(false);

  useEffect(() => { onCloseRef.current = onClose; }, [onClose]);
  useEffect(() => { onScanRef.current = onScan; }, [onScan]);
  useEffect(() => {
    const onKeyDown = (event) => { if (event.key === "Escape") onCloseRef.current?.(); };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);
  useEffect(() => {
    let disposed = false;
    foundRef.current = false;
    scanStateRef.current = { code: "", lastDetectedAt: 0, armed: true };
    setError("");
    setStatus("Starting rear camera...");
    setTorchAvailable(false);
    setTorchOn(false);

    const stopCamera = () => {
      try { controlsRef.current?.stop?.(); } catch (_) {}
      controlsRef.current = null;
      const streams = new Set([streamRef.current, videoRef.current?.srcObject].filter(Boolean));
      streams.forEach((stream) => stream?.getTracks?.().forEach((track) => track.stop()));
      streamRef.current = null;
      if (videoRef.current) videoRef.current.srcObject = null;
    };
    const startCamera = async () => {
      if (!window.isSecureContext) {
        setStatus("");
        setError("Camera scanning requires a secure HTTPS connection.");
        return;
      }
      if (!navigator.mediaDevices?.getUserMedia) {
        setStatus("");
        setError("This browser does not support live camera scanning. Use a paired scanner or enter the barcode manually.");
        return;
      }
      try {
        const stream = await openAutomaticRearCamera();
        streamRef.current = stream;
        if (disposed || !videoRef.current) {
          stream.getTracks().forEach((track) => track.stop());
          return;
        }

        const handleDecode = (result, _scanError, activeControls) => {
          if (disposed) return;
          if (!result) {
            const scanState = scanStateRef.current;
            if (continuous && !scanState.armed && Date.now() - scanState.lastDetectedAt > 700) {
              scanState.armed = true;
              scanState.code = "";
            }
            return;
          }
          if (!continuous && foundRef.current) return;
          const barcode = normalizeBarcode(result.getText());
          if (!isValidBarcode(barcode)) {
            setStatus("Keep the product barcode inside the frame.");
            return;
          }
          const detectedAt = Date.now();
          const scanState = scanStateRef.current;
          if (continuous && scanState.code === barcode && !scanState.armed) {
            scanState.lastDetectedAt = detectedAt;
            return;
          }
          scanState.code = barcode;
          scanState.lastDetectedAt = detectedAt;
          scanState.armed = false;
          const accepted = onScanRef.current?.(barcode);
          if (accepted !== false) {
            try { navigator.vibrate?.(45); } catch (_) {}
            playBarcodeSuccessTone();
          }

          if (continuous) {
            setStatus(accepted === false ? "Product was not counted. Check the message and try again." : "Counted " + barcode + ". Move to the next product.");
            return;
          }
          foundRef.current = true;
          try { activeControls.stop(); } catch (_) {}
          setStatus("Barcode captured: " + barcode);
          onCloseRef.current?.();
        };
        const startNativeAndroidScanner = async () => {
          const NativeBarcodeDetector = window.BarcodeDetector;
          if (!/Android/i.test(navigator.userAgent || "") || typeof NativeBarcodeDetector !== "function") return null;
          const video = videoRef.current;
          video.srcObject = stream;
          await video.play();
          const wantedFormats = ["aztec", "codabar", "code_39", "code_93", "code_128", "data_matrix", "ean_8", "ean_13", "itf", "pdf417", "qr_code", "upc_a", "upc_e"];
          let supportedFormats = [];
          try { supportedFormats = await NativeBarcodeDetector.getSupportedFormats?.() || []; } catch (_) {}
          const formats = wantedFormats.filter((format) => supportedFormats.includes(format));
          const detector = formats.length ? new NativeBarcodeDetector({ formats }) : new NativeBarcodeDetector();
          await detector.detect(video);
          let stopped = false;
          let timerId = 0;
          const controls = {
            stop() {
              stopped = true;
              if (timerId) window.clearTimeout(timerId);
            },
          };
          const videoTrack = stream.getVideoTracks()[0];
          let capabilities = {};
          try { capabilities = videoTrack?.getCapabilities?.() || {}; } catch (_) {}
          if (videoTrack?.applyConstraints && Object.prototype.hasOwnProperty.call(capabilities, "torch")) {
            controls.switchTorch = (enabled) => videoTrack.applyConstraints({ advanced: [{ fillLightMode: enabled ? "flash" : "off", torch: enabled }] });
          }
          const detectFrame = async () => {
            if (stopped || disposed || !videoRef.current) return;
            try {
              const barcodes = await detector.detect(videoRef.current);
              const rawValue = String(barcodes?.[0]?.rawValue || "").trim();
              if (rawValue) handleDecode({ getText: () => rawValue }, null, controls);
            } catch (_) {}
            if (!stopped && !disposed) timerId = window.setTimeout(detectFrame, 70);
          };
          timerId = window.setTimeout(detectFrame, 40);
          return controls;
        };
        const startZxingScanner = async () => {
          const [{ BrowserMultiFormatOneDReader }, { DecodeHintType }] = await Promise.all([
            import("@zxing/browser"),
            import("@zxing/library"),
          ]);
          const hints = new Map([[DecodeHintType.TRY_HARDER, true]]);
          const reader = new BrowserMultiFormatOneDReader(hints, { delayBetweenScanAttempts: 75, delayBetweenScanSuccess: 250 });
          return reader.decodeFromStream(stream, videoRef.current, handleDecode);
        };
        let controls = null;
        try { controls = await startNativeAndroidScanner(); } catch (_) {}
        if (!controls) controls = await startZxingScanner();
        if (disposed) {
          controls.stop();
          return;
        }
        controlsRef.current = controls;
        const videoTrack = videoRef.current?.srcObject?.getVideoTracks?.()[0] || stream.getVideoTracks()[0];
        if (videoTrack?.applyConstraints) {
          let capabilities = {};
          try { capabilities = videoTrack.getCapabilities?.() || {}; } catch (_) {}
          let focusMode = "";
          if (Array.isArray(capabilities.focusMode) && capabilities.focusMode.includes("continuous")) {
            focusMode = "continuous";
          } else if (Array.isArray(capabilities.focusMode) && capabilities.focusMode.includes("single-shot")) {
            focusMode = "single-shot";
          }
          if (focusMode) await videoTrack.applyConstraints({ advanced: [{ focusMode }] }).catch(() => {});
          if (!disposed) setTorchAvailable(typeof controls.switchTorch === "function" || Object.prototype.hasOwnProperty.call(capabilities, "torch"));
        }
        setStatus("Point the rear camera at the product barcode.");
      } catch (cameraError) {
        if (disposed) return;
        stopCamera();
        setStatus("");
        setError(cameraScannerError(cameraError));
      }
    };
    startCamera();
    return () => { disposed = true; stopCamera(); };
  }, [attempt, continuous]);

  const toggleTorch = async () => {
    const controls = controlsRef.current;
    const track = streamRef.current?.getVideoTracks?.()[0];
    if (!torchAvailable) return;
    const next = !torchOn;
    try {
      if (typeof controls?.switchTorch === "function") await controls.switchTorch(next);
      else if (track?.applyConstraints) await track.applyConstraints({ advanced: [{ fillLightMode: next ? "flash" : "off", torch: next }] });
      else throw new Error("torch_unavailable");
      setTorchOn(next);
      setStatus(next ? "Flashlight on. Point the rear camera at the barcode." : "Flashlight off. Point the rear camera at the barcode.");
    } catch (_) {
      setTorchAvailable(false);
      setTorchOn(false);
      setStatus("Flashlight control is unavailable on this phone.");
    }
  };

  return (
    <div className="scrim camera-scrim" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
      <div className="modal camera-modal" role="dialog" aria-modal="true" aria-labelledby="camera-scanner-title">
        <div className="camera-head">
          <div><div className="eyebrow">{eyebrow}</div><div className="section-title" id="camera-scanner-title">{title}</div></div>
          <button type="button" className="iconbtn" onClick={onClose} aria-label="Close camera scanner"><X /></button>
        </div>
        <div className="camera-preview">
          <video ref={videoRef} autoPlay muted playsInline aria-label="Live camera barcode preview" />
          {!error && <div className="camera-target" aria-hidden="true"><span /></div>}
          {error && <div className="camera-error" role="alert"><AlertCircle /><span>{error}</span></div>}
        </div>
        <div className="camera-status" aria-live="polite">{error ? "" : status}</div>
        <div className="camera-actions">
          <button type="button" className="btn btn-ghost" onClick={onClose}>{continuous ? "Done" : "Cancel"}</button>
          {!error && <button type="button" className={"btn " + (torchOn ? "btn-primary" : "btn-ghost")} onClick={toggleTorch} disabled={!torchAvailable} title={torchAvailable ? "Toggle the rear-camera flashlight" : "Flashlight control is unavailable on this camera"}><Zap /> {torchAvailable ? (torchOn ? "Flash off" : "Flashlight") : "Flash unavailable"}</button>}
          {error && <button type="button" className="btn btn-primary" onClick={() => setAttempt((value) => value + 1)}><RefreshCw /> Try again</button>}
        </div>
      </div>
    </div>
  );
}
function invOutstanding(inv) { return Math.max(0, inv.totalCents - inv.paidCents); }
function invoiceCashierName(invoice) {
  return String(invoice?.cashier || invoice?.cashierName || invoice?.soldBy || "Cashier").trim() || "Cashier";
}
function invoiceSoldLines(data, invoice, branchId) {
  const items = Array.isArray(invoice?.items) ? invoice.items : [];
  const invoiceTotal = Math.max(0, Math.round(Number(invoice?.totalCents || 0)));
  const captured = items.map((item) => {
    const qty = Math.max(0, Number(item?.qty ?? item?.quantity ?? 0));
    const priceCents = Math.max(0, Math.round(Number(item?.priceCents ?? item?.unitPriceCents ?? 0)));
    const product = (item?.productId ? (data.products || []).find((entry) => entry.id === item.productId) : null)
      || findProductByBarcode(data, item?.barcode || item?.sku, branchId)
      || (data.products || []).find((entry) => productVisibleInBranch(entry, data, branchId)
        && String(entry?.name || "").trim().toLowerCase() === String(item?.name || item?.productName || "").trim().toLowerCase())
      || null;
    return {
      productId: item?.productId || product?.id || "",
      name: String(item?.name || item?.productName || product?.name || "Product").trim() || "Product",
      sku: String(item?.sku || product?.sku || "").trim(),
      barcode: String(item?.barcode || product?.barcode || "").trim(),
      category: String(item?.category || product?.category || "").trim(),
      qty,
      priceCents,
      totalCents: qty * priceCents,
    };
  }).filter((line) => line.qty > 0);
  if (captured.length > 0) {
    const capturedTotal = captured.reduce((sum, line) => sum + line.totalCents, 0);
    if (capturedTotal > 0 || invoiceTotal === 0) return captured;
    const capturedQty = captured.reduce((sum, line) => sum + line.qty, 0);
    const unitPrice = capturedQty > 0 ? Math.floor(invoiceTotal / capturedQty) : 0;
    let allocated = 0;
    return captured.map((line, index) => {
      const totalCents = index === captured.length - 1 ? Math.max(0, invoiceTotal - allocated) : unitPrice * line.qty;
      allocated += totalCents;
      return { ...line, priceCents: line.qty ? Math.round(totalCents / line.qty) : 0, totalCents };
    });
  }

  // Legacy invoices may only have stock movements. Reconcile those lines to
  // the immutable invoice total rather than today's potentially changed price.
  const reason = `Sale ${invoice?.number || ""}`;
  const movementLines = (data.stockMovements || []).filter((move) => move.branchId === branchId
    && move.reason === reason && Number(move.qty || 0) < 0).map((move) => {
    const product = (data.products || []).find((entry) => entry.id === move.productId);
    return { productId: move.productId || "", name: product?.name || "Product", qty: Math.abs(Number(move.qty || 0)) };
  }).filter((line) => line.qty > 0);
  if (movementLines.length === 0) return [];

  const totalQty = movementLines.reduce((sum, line) => sum + line.qty, 0);
  const fallbackUnitPrice = totalQty > 0 ? Math.floor(invoiceTotal / totalQty) : 0;
  let allocated = 0;
  return movementLines.map((line, index) => {
    const totalCents = index === movementLines.length - 1
      ? Math.max(0, invoiceTotal - allocated)
      : fallbackUnitPrice * line.qty;
    allocated += totalCents;
    return { ...line, priceCents: line.qty ? Math.round(totalCents / line.qty) : 0, totalCents };
  });
}
function aggregateInvoiceSoldLines(data, invoices, branchId) {
  const grouped = new Map();
  (invoices || []).forEach((invoice) => {
    invoiceSoldLines(data, invoice, branchId).forEach((line) => {
      const key = `${line.productId || line.name}::${line.priceCents}`;
      const current = grouped.get(key) || { ...line, qty: 0, totalCents: 0 };
      current.qty += line.qty;
      current.totalCents += line.totalCents;
      grouped.set(key, current);
    });
  });
  return Array.from(grouped.values()).sort((a, b) => b.totalCents - a.totalCents || a.name.localeCompare(b.name));
}
function lastEndFor(settings, branchId) { return (settings.lastEndDayByBranch && settings.lastEndDayByBranch[branchId]) || settings.lastEndDay || 0; }
function branchLastEndDay(data, branchId) {
  const mapped = Number(data?.settings?.lastEndDayByBranch?.[branchId] || 0);
  const recorded = (data?.endOfDays || [])
    .filter((entry) => entry.branchId === branchId)
    .reduce((latest, entry) => Math.max(latest, Number(entry.closedAt || entry.ts || 0)), 0);
  return Math.max(mapped, recorded);
}
function invoiceWasCarriedOver(data, inv) {
  if (!inv) return false;
  if (invOutstanding(inv) <= 0) return false;
  if (inv.archived === true) return false;
  if (Number(inv.carriedOverAt || 0) > 0 || inv.closedDayId) return true;
  const invoiceTs = Number(inv.ts || inv.issuedAt || 0);
  return invoiceTs > 0 && branchLastEndDay(data, inv.branchId) >= invoiceTs;
}
// P&L recognition is intentionally conservative: an invoice must be cleared and its
// business day must have been closed. Open invoices stay out of profit/margin.
function invRecognized(inv, settings) { return invOutstanding(inv) <= 0 && inv.ts <= lastEndFor(settings, inv.branchId); }
function invIsDebt(inv) {
  if (invOutstanding(inv) <= 0) return false;
  return Boolean(inv.carriedOver);
}
function invoiceIssuedTimestamp(inv) {
  const value = inv?.ts ?? inv?.issuedAt ?? inv?.createdAt ?? inv?.date;
  const numeric = Number(value);
  if (Number.isFinite(numeric) && numeric > 0) return numeric;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : 0;
}
function invIsOverdue(inv, referenceTs = now()) {
  if (invOutstanding(inv) <= 0 || invIsDebt(inv)) return false;
  const issuedTs = invoiceIssuedTimestamp(inv);
  return issuedTs > 0 && Number(referenceTs) - issuedTs >= 86400000;
}
function saleMoveInvoice(data, move) {
  const reason = String(move?.reason || "");
  if (!reason.startsWith("Sale ")) return null;
  const invoiceNo = reason.slice(5).trim();
  return (data?.invoices || []).find((i) => i.number === invoiceNo) || null;
}
function saleMoveRecognized(data, move) {
  const inv = saleMoveInvoice(data, move);
  if (inv && invoiceIsVoided(data, inv)) return false;
  return inv ? invRecognized(inv, data.settings) : move.ts <= lastEndFor(data.settings, move.branchId);
}
// Identifier validation (format only — no network verification in the offline prototype).
function isValidEmail(v) { return /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test((v || "").trim()); }
function isValidPhone(v) { return /^(?:\+254\d{9}|0\d{9})$/.test((v || "").replace(/[\s-]/g, "")); }
function normPhone(v) { return (v || "").replace(/[\s-]/g, ""); }
function invStatus(inv) {
  if (invOutstanding(inv) <= 0) return "paid";
  if (invIsDebt(inv)) return "debt";
  if (invIsOverdue(inv)) return "overdue";
  return inv.paidCents > 0 ? "partial" : "open";
}
function latestInvoiceVoidRequest(data, invoiceId) {
  return [...(data?.invoiceVoidRequests || [])]
    .filter((entry) => entry.invoiceId === invoiceId)
    .sort((a, b) => Number(b.requestedAt || b.ts || 0) - Number(a.requestedAt || a.ts || 0))[0] || null;
}
function latestInvoiceVoidDecision(data, invoiceId, requestId = "") {
  return [...(data?.invoiceVoidDecisions || [])]
    .filter((entry) => entry.invoiceId === invoiceId && (!requestId || entry.requestId === requestId))
    .sort((a, b) => Number(b.decidedAt || b.ts || 0) - Number(a.decidedAt || a.ts || 0))[0] || null;
}
function invoiceVoidState(data, invoiceId) {
  const request = latestInvoiceVoidRequest(data, invoiceId);
  const decision = latestInvoiceVoidDecision(data, invoiceId, request?.id);
  return { request, decision, status: decision?.decision || (request ? "pending" : "none") };
}
function invoiceIsVoided(data, invoiceOrId) {
  const invoiceId = typeof invoiceOrId === "string" ? invoiceOrId : invoiceOrId?.id;
  return Boolean(invoiceId && invoiceVoidState(data, invoiceId).status === "approved");
}
function operationalInvoices(data) {
  return (data?.invoices || [])
    .filter((invoice) => !invoiceIsVoided(data, invoice))
    .map((invoice) => ({ ...invoice, carriedOver: invoiceWasCarriedOver(data, invoice) }));
}
const isToday = (ts) => new Date(ts).toDateString() === new Date().toDateString();
// Combined date + time stamp for documents (invoices, purchases, expenses, stock moves, etc.)
function dt(ts) { if (ts == null) return "—"; const d = new Date(ts); return d.toLocaleDateString() + " · " + d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }); }
function localDateValue(date) {
  const d = new Date(date);
  return [d.getFullYear(), String(d.getMonth() + 1).padStart(2, "0"), String(d.getDate()).padStart(2, "0")].join("-");
}
function mondayDateValue(value = Date.now()) {
  const parsed = typeof value === "string" ? new Date(value + "T12:00:00") : new Date(value);
  const date = Number.isNaN(parsed.getTime()) ? new Date() : parsed;
  date.setHours(12, 0, 0, 0);
  date.setDate(date.getDate() - ((date.getDay() + 6) % 7));
  return localDateValue(date);
}
function dateValuePlusDays(value, dayCount) {
  const parsed = new Date(String(value) + "T12:00:00");
  const date = Number.isNaN(parsed.getTime()) ? new Date(mondayDateValue() + "T12:00:00") : parsed;
  date.setDate(date.getDate() + dayCount);
  return localDateValue(date);
}
function stockTemplateDateRange(fromValue, toValue) {
  const fallbackFrom = mondayDateValue();
  const from = new Date(String(fromValue || fallbackFrom) + "T12:00:00");
  const safeFrom = Number.isNaN(from.getTime()) ? new Date(fallbackFrom + "T12:00:00") : from;
  const requestedTo = new Date(String(toValue || localDateValue(safeFrom)) + "T12:00:00");
  const maximumTo = new Date(safeFrom);
  maximumTo.setDate(safeFrom.getDate() + 6);
  const safeTo = Number.isNaN(requestedTo.getTime()) || requestedTo < safeFrom
    ? new Date(safeFrom)
    : requestedTo > maximumTo ? maximumTo : requestedTo;
  const format = (date) => [String(date.getDate()).padStart(2, "0"), String(date.getMonth() + 1).padStart(2, "0"), date.getFullYear()].join("/");
  const dayNames = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
  const days = [];
  for (const date = new Date(safeFrom); date <= safeTo; date.setDate(date.getDate() + 1)) {
    const snapshot = new Date(date);
    const day = dayNames[snapshot.getDay()];
    days.push({ day, date: format(snapshot), label: day + " " + format(snapshot) });
  }
  return {
    fromValue: localDateValue(safeFrom),
    toValue: localDateValue(safeTo),
    maximumToValue: localDateValue(maximumTo),
    days,
    label: days[0].label + (days.length > 1 ? " to " + days[days.length - 1].label : ""),
  };
}
function cartLines(data, cart) {
  return Object.entries(cart).filter(([, q]) => q > 0).map(([pid, qty]) => {
    const p = data.products.find((x) => x.id === pid);
    return p ? { productId: pid, name: p.name, qty, priceCents: priceFor(data, p) } : null;
  }).filter(Boolean);
}
function countPending(data) {
  if (data?._sync && Number.isFinite(data._sync.outboxLength)) return data._sync.outboxLength;
  const u = (a) => (a || []).filter((x) => x && x.synced === false).length;
  return u(data.orders) + u(data.payments) + u(data.stockMovements) + u(data.products) + u(data.employees)
    + u(data.invoices) + u(data.customers) + u(data.suppliers) + u(data.supplierPrices) + u(data.expenses) + u(data.purchases)
    + u(data.invoiceVoidRequests) + u(data.invoiceVoidDecisions) + u(data.cashMovements) + u(data.borrowings)
    + u(data.branches) + u(data.endOfDays) + u(data.countLog) + u(data.barcodeCatalog) + u(data.expenseCategories);
}
function markSynced(data) {
  const m = (a) => (a || []).map((x) => (x && x.synced === false ? { ...x, synced: true } : x));
  return { ...data, orders: m(data.orders), payments: m(data.payments), stockMovements: m(data.stockMovements),
    products: m(data.products), employees: m(data.employees), invoices: m(data.invoices),
    invoiceVoidRequests: m(data.invoiceVoidRequests), invoiceVoidDecisions: m(data.invoiceVoidDecisions), customers: m(data.customers),
    suppliers: m(data.suppliers), expenses: m(data.expenses), purchases: m(data.purchases), cashMovements: m(data.cashMovements),
    borrowings: m(data.borrowings), branches: m(data.branches), supplierPrices: m(data.supplierPrices), endOfDays: m(data.endOfDays),
    countLog: m(data.countLog), barcodeCatalog: m(data.barcodeCatalog), expenseCategories: m(data.expenseCategories), lastSyncedAt: now(), _sync: { ...(data._sync || {}), outboxLength: 0, error: "" } };
}

/* ================================================================== */
/*  Styles                                                            */
/* ================================================================== */
const css = `
@import url('https://fonts.googleapis.com/css2?family=Plus+Jakarta+Sans:wght@400;500;600;700;800&family=JetBrains+Mono:wght@500;600;700&display=swap');
html,body,#root{width:100%;height:100%;min-height:0;margin:0;overflow:hidden}
html{-webkit-text-size-adjust:100%;text-size-adjust:100%}
body{overscroll-behavior:none}
#root{isolation:isolate}
.vpos *{box-sizing:border-box;margin:0;padding:0}
.vpos{
  --bg:#F4F7F8;--surface:#FFFFFF;--surface-2:#EEF3F4;--surface-3:#E2EAEC;--border:#DEE7E9;--border-soft:#EBF1F2;
  --text:#10202A;--muted:#53646F;--muted-2:#8B9BA6;--accent:#0EA5B5;--accent-2:#22C7D6;--accent-press:#0C8E9C;
  --danger:#E5484D;--ok:#15A86B;--warn:#D98A1C;
  --font-ui:'Plus Jakarta Sans',system-ui,-apple-system,"Segoe UI",Roboto,Helvetica,Arial,sans-serif;
  --font-mono:'JetBrains Mono',ui-monospace,"SF Mono",Menlo,Consolas,monospace;
  font-family:var(--font-ui);color:var(--text);height:100dvh;min-height:0;max-width:100vw;width:100%;background:var(--bg);
  display:flex;align-items:center;justify-content:center;
  padding:calc(24px + env(safe-area-inset-top)) calc(24px + env(safe-area-inset-right)) calc(24px + env(safe-area-inset-bottom)) calc(24px + env(safe-area-inset-left));
  position:relative;overflow-x:hidden;overflow-y:auto;overscroll-behavior:contain;-webkit-overflow-scrolling:touch}
.vpos.app{align-items:flex-start;padding:0;overflow:hidden}
.vpos.auth-root{padding:0;overflow:hidden}
.vpos.theme-dark{
  --bg:#0B1014;--surface:#131C22;--surface-2:#1A252C;--surface-3:#243038;--border:#2A3741;--border-soft:#212E37;
  --text:#E9F1F3;--muted:#9DAEBA;--muted-2:#6B7C89;--accent:#2DD4DE;--accent-2:#3FE0C8;--accent-press:#1FB8C4;
  --danger:#FF6B6B;--ok:#3FCB95;--warn:#E7B23C;
}
.vpos.theme-dark::before{background:radial-gradient(circle,rgba(45,212,222,.16),transparent 62%)}
.vpos.theme-dark .topbar{background:rgba(20,24,34,.85)}
.vpos::before{content:"";position:absolute;top:-28%;left:50%;transform:translateX(-50%);width:720px;height:720px;border-radius:50%;
  background:radial-gradient(circle,rgba(45,212,222,.10),transparent 62%);pointer-events:none}
.stage{position:relative;width:100%;display:flex;justify-content:center}
.brand{display:flex;align-items:center;gap:13px;justify-content:center;margin-bottom:26px}
.brand.sm{margin:0}
.brand .mark{display:grid;place-items:center;filter:drop-shadow(0 5px 16px rgba(45,212,222,.45))}
.brand .mark svg{width:52px;height:52px}
.brand.sm .mark svg{width:40px;height:40px}
.brand .name{font-size:27px;font-weight:800;letter-spacing:-.025em;line-height:1}
.brand.sm .name{font-size:21px}
.brand .name span{color:var(--muted-2);font-weight:600;letter-spacing:.04em}
.card{width:100%;background:var(--surface);border:1px solid var(--border-soft);border-radius:22px;padding:30px 26px 26px;box-shadow:0 24px 60px -30px rgba(30,42,90,.22)}
.card.narrow{max-width:380px}
.eyebrow{font-size:11px;letter-spacing:.16em;text-transform:uppercase;color:var(--muted-2);font-weight:600}
.title{font-size:23px;font-weight:700;letter-spacing:-.02em;margin-top:6px}
.sub{font-size:14px;color:var(--muted);margin-top:6px;line-height:1.5}
.dots{display:flex;gap:14px;justify-content:center;margin:26px 0 22px}
.dot{width:14px;height:14px;border-radius:50%;border:1.5px solid var(--border);background:transparent;transition:.12s}
.dot.on{background:var(--accent);border-color:var(--accent);transform:scale(1.12)}
.dot.err{background:var(--danger);border-color:var(--danger)}
.shake{animation:shake .42s cubic-bezier(.36,.07,.19,.97)}
@keyframes shake{10%,90%{transform:translateX(-1px)}20%,80%{transform:translateX(2px)}30%,50%,70%{transform:translateX(-5px)}40%,60%{transform:translateX(5px)}}
.pad{display:grid;grid-template-columns:repeat(3,1fr);gap:12px}
.key{height:62px;border-radius:16px;border:1px solid var(--border);background:var(--surface-2);color:var(--text);font-family:var(--font-mono);font-size:24px;font-weight:600;cursor:pointer;transition:.1s;display:grid;place-items:center;user-select:none}
.key:hover{background:var(--surface-3);border-color:#3a445f}
.key:active{transform:scale(.95);background:var(--accent);border-color:var(--accent);color:#fff}
.key.ghost{background:transparent;border-color:transparent;cursor:default}
.key.util{font-size:18px;color:var(--muted)}
.field{margin-top:16px}
.label{font-size:12.5px;color:var(--muted);font-weight:600;margin-bottom:7px;display:block}
.input-wrap{position:relative;display:flex;align-items:center}
.input-wrap > svg.lead{position:absolute;left:14px;width:17px;height:17px;color:var(--muted-2)}
.input{width:100%;height:46px;border-radius:12px;border:1px solid var(--border);background:var(--bg);color:var(--text);font-size:14.5px;padding:0 13px;outline:none;font-family:var(--font-ui);transition:.15s}
.input.lead{padding-left:42px}
.input:focus{border-color:var(--accent);box-shadow:0 0 0 3px rgba(14,165,181,.2)}
.input::placeholder{color:var(--muted-2)}
.input.mono{font-family:var(--font-mono);letter-spacing:.3em}
.toggle-eye{position:absolute;right:10px;background:none;border:none;cursor:pointer;color:var(--muted-2);padding:6px;display:grid;place-items:center}
.select{width:100%;height:46px;border-radius:12px;border:1px solid var(--border);background:var(--bg);color:var(--text);font-size:14.5px;padding:0 12px;outline:none;font-family:var(--font-ui);cursor:pointer}
.select:focus{border-color:var(--accent);box-shadow:0 0 0 3px rgba(14,165,181,.2)}
.btn{width:100%;height:48px;border-radius:12px;border:none;cursor:pointer;font-size:14.5px;font-weight:650;font-family:var(--font-ui);display:flex;align-items:center;justify-content:center;gap:8px;transition:.12s}
.btn:active{transform:scale(.99)}
.btn:disabled{opacity:.45;cursor:not-allowed}
.btn-primary{background:linear-gradient(135deg,var(--accent),var(--accent-2));color:#fff}
.btn-primary:hover:not(:disabled){filter:brightness(1.08)}
.btn-ghost{background:var(--surface-2);color:var(--text);border:1px solid var(--border)}
.btn-ghost:hover{background:var(--surface-3)}
.btn-danger{background:var(--danger);color:#fff}
.btn-danger:hover:not(:disabled){filter:brightness(1.06)}
.btn:disabled{opacity:.5;cursor:not-allowed}
.dangerzone{background:var(--surface);border:1px solid var(--danger);border-radius:16px;padding:16px 18px}
.dangerzone .dz-head{display:flex;align-items:flex-start;justify-content:space-between;gap:16px}
.dangerzone .dz-title{font-weight:700;font-size:14.5px;color:var(--text)}
.dangerzone .dz-sub{font-size:12.5px;color:var(--muted);margin-top:4px;line-height:1.55;max-width:620px}
.dangerzone .dz-confirm{margin-top:14px;padding-top:14px;border-top:1px solid var(--border-soft)}
.btn svg{width:17px;height:17px}
.btn.sm{height:40px;font-size:13px;border-radius:11px;width:auto;padding:0 14px}
.btn.xs{height:34px;font-size:12px;border-radius:9px;width:auto;padding:0 11px;gap:5px}
.btn.xs svg{width:14px;height:14px}
.linkrow{margin-top:20px;text-align:center}
.linkbtn{background:none;border:none;cursor:pointer;color:var(--muted);font-size:13.5px;font-family:var(--font-ui);display:inline-flex;align-items:center;gap:6px;padding:8px 12px;border-radius:9px;transition:.15s}
.linkbtn:hover{color:var(--text);background:var(--surface-2)}
.linkbtn svg{width:15px;height:15px}
.alert{display:flex;align-items:center;gap:9px;margin-top:16px;background:rgba(230,67,104,.1);border:1px solid rgba(230,67,104,.3);color:#B5324E;font-size:13px;padding:11px 13px;border-radius:11px}
.alert svg{width:16px;height:16px;flex-shrink:0}
.hint{margin-top:18px;font-size:12px;color:var(--muted-2);text-align:center;line-height:1.7}
.hint code{font-family:var(--font-mono);color:var(--muted);background:var(--surface-2);padding:1px 6px;border-radius:5px}
.login{width:100%;max-width:946px;display:grid;grid-template-columns:1.04fr .96fr;background:var(--surface);border:1px solid var(--border-soft);border-radius:26px;overflow:hidden;box-shadow:0 34px 90px -40px rgba(30,42,90,.34)}
.loginbrand{position:relative;padding:40px 36px;background:linear-gradient(155deg,var(--accent),var(--accent-2));color:#fff;display:flex;flex-direction:column;justify-content:space-between;overflow:hidden;min-height:560px}
.loginbrand>*{position:relative;z-index:1}
.loginbrand .brand{justify-content:flex-start;margin:0}
.loginbrand .brand .mark{background:rgba(255,255,255,.2);border-radius:13px;padding:6px;filter:none}
.loginbrand .brand .name{color:#fff}
.loginbrand .brand .name span{color:rgba(255,255,255,.82)}
.lb-greet{display:inline-flex;align-items:center;gap:7px;font-size:13px;font-weight:600;letter-spacing:.03em;color:rgba(255,255,255,.9)}
.lb-greet svg{width:15px;height:15px}
.lb-h{font-size:31px;line-height:1.13;font-weight:800;letter-spacing:-.025em;margin:11px 0 12px}
.lb-p{font-size:14px;line-height:1.62;color:rgba(255,255,255,.86);max-width:340px}
.lb-feats{display:flex;flex-direction:column;gap:12px;margin-top:24px}
.lb-feat{display:flex;align-items:center;gap:12px;font-size:13.5px;color:#fff;font-weight:550}
.lb-feat .fi{width:33px;height:33px;border-radius:10px;background:rgba(255,255,255,.17);display:grid;place-items:center;flex:none}
.lb-feat .fi svg{width:16px;height:16px}
.lb-foot{font-size:11px;letter-spacing:.15em;text-transform:uppercase;color:rgba(255,255,255,.72);font-weight:600}
.blob{position:absolute;border-radius:50%;filter:blur(10px);z-index:0;pointer-events:none}
.blob.b1{width:230px;height:230px;background:rgba(255,255,255,.16);right:-78px;top:-66px}
.blob.b2{width:170px;height:170px;background:rgba(255,255,255,.11);left:-56px;bottom:30px}
.loginpanel{padding:38px 34px;display:flex;flex-direction:column;justify-content:center}
.psub{font-size:13.5px;color:var(--muted);margin-top:5px}
.hintchips{margin-top:18px;display:flex;flex-wrap:wrap;gap:7px;justify-content:center}
.hintchip{display:inline-flex;align-items:center;gap:6px;font-size:11.5px;color:var(--muted);background:var(--surface-2);border:1px solid var(--border-soft);padding:5px 9px;border-radius:9px}
.hintchip code{font-family:var(--font-mono);color:var(--accent);font-weight:700}
@media (max-width:860px){.login{grid-template-columns:1fr;max-width:420px}.loginbrand{min-height:0;padding:26px 26px 22px}.lb-feats{display:none}.lb-p{display:none}.lb-h{font-size:24px;margin:10px 0 0}.loginpanel{padding:28px 24px}}

/* ===== login (v4 — Aronium terminal) ===== */
.authstage{width:100%;height:100%;min-height:0;display:flex;align-items:center;justify-content:center;overflow-y:auto;overflow-x:hidden;overscroll-behavior:contain;-webkit-overflow-scrolling:touch;padding:calc(30px + env(safe-area-inset-top)) calc(24px + env(safe-area-inset-right)) calc(30px + env(safe-area-inset-bottom)) calc(24px + env(safe-area-inset-left));background:radial-gradient(circle at 50% 0%,rgba(43,182,196,.18),transparent 34%),linear-gradient(135deg,#20252d 0%,#2b2f36 52%,#1f232a 100%)}
.authwrap{width:100%;max-width:520px;display:flex;flex-direction:column;align-items:center;animation:rise .28s ease}
.authlogo{display:flex;flex-direction:column;align-items:center;margin-bottom:28px}
.authhex{position:relative;width:78px;height:86px;display:grid;place-items:center;margin-bottom:14px}
.authhex svg{width:78px;height:86px}
.authhex .hl{position:absolute;font-size:34px;font-weight:600;color:#2bb6c4}
.authwm{font-size:30px;font-weight:300;letter-spacing:.02em;color:#e8ebef}
.authwm b{font-weight:600}
.authfield-label{text-align:center;font-size:13px;color:#9aa1ab;margin-bottom:8px;font-weight:400}
.authfield{position:relative;width:240px;margin:0 auto}
.authfield .disp{width:100%;height:36px;background:transparent;border:1px solid #4a5059;border-radius:3px;color:#e8ebef;font-size:18px;letter-spacing:.4em;padding:0 40px 0 14px;display:flex;align-items:center;font-family:var(--font-mono)}
.authfield.err .disp{border-color:#e0566f;color:#e0566f}
.authfield.employee-login{margin-bottom:12px}
.authfield.employee-login input{width:100%;height:36px;background:transparent;border:1px solid #4a5059;border-radius:3px;color:#e8ebef;font-size:14px;padding:0 12px;text-align:center}
.authfield.employee-login input:focus{outline:none;border-color:#2bb6c4;box-shadow:0 0 0 2px rgba(43,182,196,.18)}
.authfield.employee-login.err input{border-color:#e0566f}
.authfield .arrow{position:absolute;right:0;top:0;height:36px;width:38px;border:none;background:transparent;color:#2bb6c4;cursor:pointer;display:grid;place-items:center;border-left:1px solid #4a5059}
.authfield .arrow:disabled{color:#5a616b;cursor:default}
.authfield .arrow svg{width:16px;height:16px}
.authforgot{text-align:center;font-size:12px;color:#2bb6c4;cursor:pointer;margin-top:14px}
.authforgot:hover{text-decoration:underline}
.authnote{font-size:13px;line-height:1.6;color:#9aa1ab;background:#363b43;border:1px solid #3a3f47;border-radius:6px;padding:14px 16px}
.authnote strong{color:#e8ebef;font-weight:600}
.authkb{width:100%;max-width:300px;margin-top:30px;display:flex;flex-direction:column;gap:7px}
.authkrow{display:flex;gap:7px;justify-content:center}
.authk{flex:1;height:52px;border-radius:4px;border:1px solid #3a3f47;background:#363b43;color:#cfd4db;font-size:19px;font-family:var(--font-mono);cursor:pointer;display:grid;place-items:center;transition:.08s;min-width:0;user-select:none}
.authk:hover{background:#3f444d}
.authk:active{background:#2bb6c4;color:#fff;border-color:#2bb6c4}
.authk.fn{font-size:12px;color:#9aa1ab;font-family:var(--font-ui)}
.authk.fn svg{width:18px;height:18px}
/* full QWERTY keyboard (admin sign-in) */
.authkb-full{max-width:560px}
.authkb-full .authk{height:46px;font-size:16px;border-radius:5px}
.authkb-full .authk.fn.on{background:#2bb6c4;color:#fff;border-color:#2bb6c4}
.input-wrap.kbfocus .input{border-color:#2bb6c4;box-shadow:0 0 0 3px rgba(43,182,196,.16)}
.authadmin{margin-top:26px;background:none;border:none;color:#9aa1ab;font-size:12.5px;font-weight:500;cursor:pointer;display:flex;align-items:center;justify-content:center;gap:7px;padding:10px 14px;border-radius:4px;font-family:inherit;transition:.12s}
.authadmin:hover{color:#e8ebef;background:#363b43}
.authadmin svg{width:14px;height:14px}
/* admin form, terminal styling */
.authform{width:280px;margin:6px auto 0}
.authform.admin-authform{width:100%;max-width:430px;margin:0 auto;background:rgba(31,36,44,.88);border:1px solid rgba(154,161,171,.18);border-radius:22px;padding:24px;box-shadow:0 28px 90px -34px rgba(0,0,0,.72);backdrop-filter:blur(14px)}
.authpanel-title{font-size:25px;line-height:1.1;font-weight:800;color:#f4f7fb;letter-spacing:-.02em;text-align:left}
.authpanel-sub{font-size:13.5px;color:#9aa1ab;line-height:1.55;margin-top:8px;margin-bottom:18px}
.authform .label{color:#9aa1ab}
.authform .input{background:rgba(15,20,28,.62);border-color:#46505d;color:#e8ebef}
.authform .input::placeholder{color:#717b88}
.authform .input:focus{border-color:#2bb6c4;box-shadow:0 0 0 3px rgba(43,182,196,.16)}
.authform .input-wrap > svg.lead{color:#9aa1ab}
.authform .toggle-eye{color:#9aa1ab}
.authform .btn-primary{background:linear-gradient(135deg,#2bb6c4,#6be1cf);color:#0c1418}
.authform .btn-primary:hover:not(:disabled){filter:brightness(1.08)}
.auth-actions{display:grid;grid-template-columns:1fr 1fr;gap:10px;margin-top:16px}
.auth-actions .field{margin-top:0}
.auth-actions.single{grid-template-columns:1fr}
.authback{margin-top:8px;width:100%;background:none;border:none;color:#9aa1ab;font-size:12.5px;font-weight:500;cursor:pointer;display:flex;align-items:center;justify-content:center;gap:7px;padding:10px;border-radius:4px;font-family:inherit;transition:.12s}
.authback:hover{color:#e8ebef;background:#363b43}
.authback svg{width:14px;height:14px}
.authmake{width:100%;height:48px;background:rgba(255,255,255,.04);border:1px solid #4a5059;color:#cfd4db;font-size:14px;font-weight:750;cursor:pointer;padding:0 13px;border-radius:12px;font-family:inherit;transition:.12s;display:flex;align-items:center;justify-content:center;gap:8px}
.authmake:hover{border-color:#2bb6c4;color:#fff;background:rgba(43,182,196,.1)}
.authdownload-card{margin:18px auto 0;width:100%;max-width:430px;border:1px solid rgba(154,161,171,.16);border-radius:18px;background:rgba(31,36,44,.58);padding:16px;display:grid;grid-template-columns:42px 1fr;gap:12px;color:#cfd4db}
.authdownload-icon{width:42px;height:42px;border-radius:12px;background:rgba(43,182,196,.12);border:1px solid rgba(43,182,196,.28);display:grid;place-items:center;color:#2bb6c4}
.authdownload-icon svg{width:21px;height:21px}
.authdownload-copy{min-width:0}
.authdownload-kicker{font-size:12px;color:#9aa1ab;font-weight:650;margin-bottom:3px}
.authdownload-title{font-size:14px;color:#e8ebef;font-weight:760;line-height:1.3}
.authdownload-version{font-size:12px;color:#8d96a3;margin-top:4px}
.authdownload-btn{grid-column:1 / -1;display:flex;align-items:center;justify-content:center;gap:9px;text-decoration:none;color:#0c1418;background:#2bb6c4;border:1px solid #2bb6c4;border-radius:9px;padding:12px 14px;font-size:13px;font-weight:800;transition:.12s}
.authdownload-btn:hover{filter:brightness(1.08)}
.authdownload-btn svg{width:17px;height:17px}
.authdownload-btn.disabled,.authdownload-btn.disabled:hover{pointer-events:none;filter:none;background:#363b43;border-color:#3a3f47;color:#8d96a3}
.authdownload-more{grid-column:1 / -1;text-align:center;color:#9aa1ab;text-decoration:none;font-size:12.5px;font-weight:650}
.authdownload-more:hover{color:#e8ebef;text-decoration:underline}
@media (max-width:600px){
  .authstage{align-items:flex-start;padding:calc(18px + env(safe-area-inset-top)) calc(14px + env(safe-area-inset-right)) calc(18px + env(safe-area-inset-bottom)) calc(14px + env(safe-area-inset-left))}
  .authwrap{max-width:430px}
  .authlogo{margin-bottom:20px}
  .authhex{width:58px;height:64px;margin-bottom:10px}
  .authhex svg{width:58px;height:64px}
  .authhex .hl{font-size:27px}
  .authwm{font-size:25px}
  .authform.admin-authform{padding:20px;border-radius:17px}
  .authpanel-title{font-size:22px;letter-spacing:0}
  .authdownload-card{margin-top:14px;border-radius:15px}
}
@media (max-height:640px){.authstage{align-items:flex-start}.authlogo{margin-bottom:16px}.authhex{margin-bottom:7px}}
.downloads-page{box-sizing:border-box;width:100%;height:100dvh;min-height:0;overflow-y:auto;overflow-x:hidden;overscroll-behavior-y:contain;-webkit-overflow-scrolling:touch;background:linear-gradient(135deg,#07111f 0%,#0f172a 100%);color:#f8fafc;padding:42px 22px 64px}
.downloads-hero,.downloads-shell{width:min(1060px,100%);margin:0 auto}
.downloads-back{display:inline-flex;align-items:center;gap:8px;color:#94a3b8;text-decoration:none;font-size:13px;font-weight:700;margin-bottom:28px}
.downloads-back:hover{color:#f8fafc}
.downloads-back svg{width:16px;height:16px}
.downloads-brand{display:flex;align-items:center;gap:14px;margin-bottom:26px}
.downloads-name{font-size:25px;font-weight:850;letter-spacing:-.02em}
.downloads-tag{font-size:13px;color:#94a3b8;font-weight:700}
.downloads-eyebrow{color:#60a5fa;text-transform:uppercase;letter-spacing:.18em;font-weight:850;font-size:12px;margin-bottom:12px}
.downloads-hero h1{font-size:clamp(38px,6vw,72px);line-height:.95;margin:0 0 16px;letter-spacing:-.05em}
.downloads-hero p{max-width:720px;color:#cbd5e1;font-size:17px;line-height:1.7;margin:0 0 34px}
.downloads-shell{display:grid;gap:18px}
.downloads-panel{background:rgba(17,24,39,.86);border:1px solid rgba(148,163,184,.18);border-radius:18px;padding:22px;box-shadow:0 28px 90px rgba(0,0,0,.22)}
.downloads-section-head{display:flex;align-items:center;justify-content:space-between;gap:16px;margin-bottom:16px}
.downloads-section-head h2{margin:0;font-size:18px}
.downloads-section-head p{margin:4px 0 0;color:#94a3b8;font-size:13px}
.download-app-grid{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:14px}
.download-app-card{border:1px solid rgba(148,163,184,.18);border-radius:14px;padding:16px;background:rgba(15,23,42,.68);display:flex;flex-direction:column;gap:14px;min-height:190px}
.download-app-icon{width:42px;height:42px;border-radius:12px;background:rgba(59,130,246,.16);display:grid;place-items:center;color:#60a5fa;border:1px solid rgba(96,165,250,.2)}
.download-app-icon svg{width:21px;height:21px}
.download-app-meta h3{margin:0 0 6px;font-size:16px}
.download-app-meta p{margin:0;color:#94a3b8;font-size:13px;line-height:1.5}
.download-app-button{margin-top:auto;border:none;border-radius:10px;background:#3b82f6;color:white;text-decoration:none;font-weight:800;font-size:13px;padding:11px 12px;display:flex;align-items:center;justify-content:center;gap:8px;font-family:inherit}
.download-app-button svg{width:16px;height:16px}
.download-app-button.disabled{background:rgba(148,163,184,.14);color:#94a3b8}
.download-notes{border:1px solid rgba(148,163,184,.16);border-radius:14px;background:rgba(15,23,42,.58);padding:16px;color:#cbd5e1;line-height:1.7;display:grid;gap:10px}
.download-note{display:flex;align-items:flex-start;gap:10px}
.download-note svg{width:17px;height:17px;color:#60a5fa;flex:none;margin-top:4px}
.download-steps{margin:0;padding-left:22px;color:#cbd5e1;line-height:1.8}
.download-steps li{padding-left:6px;margin:7px 0}
@media (max-width: 820px){.download-app-grid{grid-template-columns:1fr}.downloads-page{padding:26px 14px 42px}.downloads-panel{padding:18px}.downloads-hero p{font-size:15px}}
.segrow{display:flex;gap:8px}
.segbtn{flex:1;display:flex;align-items:center;justify-content:center;gap:7px;height:42px;border-radius:5px;border:1px solid #4a5059;background:transparent;color:#9aa1ab;font-size:13px;font-weight:600;cursor:pointer;font-family:inherit;transition:.12s}
.segbtn svg{width:15px;height:15px}
.segbtn:hover{color:#e8ebef;border-color:#5a616b}
.segbtn.on{background:#2bb6c4;color:#0c1418;border-color:#2bb6c4}


.shell{width:100%;max-width:1500px;min-width:0;margin:0 auto;height:100%;min-height:0;display:flex;flex-direction:column;overflow:hidden}
.topbar{display:flex;align-items:center;justify-content:space-between;gap:14px;padding:calc(14px + env(safe-area-inset-top)) calc(22px + env(safe-area-inset-right)) 14px calc(22px + env(safe-area-inset-left));border-bottom:1px solid var(--border-soft);background:rgba(255,255,255,.82);backdrop-filter:blur(8px);position:sticky;top:0;z-index:30}
.envbadge{display:inline-flex;align-items:center;gap:7px;height:34px;padding:0 12px;border-radius:999px;border:1px solid var(--border);font-size:11px;font-weight:850;letter-spacing:.08em;white-space:nowrap}
.envbadge.compact{height:32px;font-size:10.5px}
.envbadge.test{background:rgba(217,138,28,.14);border-color:rgba(217,138,28,.35);color:#b56d00}
.envbadge.live{background:rgba(21,168,107,.14);border-color:rgba(21,168,107,.35);color:var(--ok)}
.envdot{width:8px;height:8px;border-radius:50%;background:currentColor;box-shadow:0 0 0 4px rgba(217,138,28,.12)}
.envbadge.live .envdot{box-shadow:0 0 0 4px rgba(21,168,107,.12)}
.env-banner{position:relative;z-index:3;width:100%;padding:9px 22px;text-align:center;font-size:12px;font-weight:850;letter-spacing:.07em;border-bottom:1px solid var(--border)}
.env-banner.test{background:rgba(217,138,28,.16);color:#9f640b}
.topbar .right{display:flex;align-items:center;gap:10px;flex-wrap:wrap;justify-content:flex-end}
.who{display:flex;flex-direction:column;align-items:flex-end;line-height:1.2}
.who .nm{font-size:13.5px;font-weight:650}
.who .rl{font-size:11.5px;color:var(--muted)}
.iconbtn{background:var(--surface-2);border:1px solid var(--border);border-radius:11px;cursor:pointer;color:var(--muted);width:40px;height:40px;display:grid;place-items:center;transition:.15s}
.iconbtn:hover{color:var(--text);background:var(--surface-3)}
.iconbtn.danger:hover{color:var(--danger);border-color:var(--danger)}
.iconbtn svg{width:18px;height:18px}
.iconbtn.on{color:var(--text);background:var(--surface-3);border-color:var(--accent)}
/* top-right menu (sync/theme/sign out) */
.usermenu-wrap{position:relative}
.menu-scrim{position:fixed;inset:0;z-index:40}
.topmenu{position:absolute;top:48px;right:0;z-index:41;min-width:210px;background:var(--surface);border:1px solid var(--border);border-radius:14px;padding:6px;box-shadow:0 24px 60px -24px rgba(20,30,90,.5);animation:rise .14s ease}
.topmenu-row{display:flex;align-items:center;gap:10px;width:100%;padding:10px 11px;border-radius:9px;border:none;background:none;color:var(--text);font-size:13.5px;font-weight:600;font-family:inherit;cursor:pointer;text-align:left;transition:.12s}
.topmenu-row:hover{background:var(--surface-2)}
.topmenu-row svg{width:16px;height:16px;color:var(--muted)}
.topmenu-row.status{cursor:default;color:var(--muted);font-size:12.5px;font-weight:600}
.topmenu-row.status:hover{background:none}
.topmenu-row.status .led{width:8px;height:8px;border-radius:50%;background:var(--ok);box-shadow:0 0 8px var(--ok);flex:none}
.topmenu-row.status .led.off,.topmenu-row.status .led.warn{background:var(--warn);box-shadow:0 0 8px var(--warn)}
.topmenu-row.status .led.err{background:var(--danger);box-shadow:0 0 8px var(--danger)}
.topmenu-mini{margin-left:auto;font-size:11.5px;font-weight:700;color:var(--accent);background:none;border:none;cursor:pointer;font-family:inherit;padding:2px 4px}
.topmenu-div{height:1px;background:var(--border-soft);margin:5px 4px}
.topmenu-row.signout{color:var(--danger)}
.topmenu-row.signout svg{color:var(--danger)}
.topmenu-row.signout:hover{background:rgba(230,67,104,.1)}
.branchsel{display:flex;align-items:center;gap:8px;height:40px;padding:0 6px 0 12px;border-radius:11px;border:1px solid var(--border);background:linear-gradient(135deg,rgba(14,165,181,.2),rgba(34,199,214,.18));font-size:12.5px;font-weight:650}
.branchsel svg{width:15px;height:15px;color:var(--accent)}
.branchsel select{background:transparent;border:none;color:var(--text);font-weight:650;font-size:12.5px;outline:none;cursor:pointer;font-family:var(--font-ui)}
.branchsel select option{background:var(--surface)}
.branchsel span{color:var(--text);font-weight:650;font-size:12.5px}
.branchsel.locked{cursor:default}
.sync{display:flex;align-items:center;gap:8px;height:40px;padding:0 13px;border-radius:11px;border:1px solid var(--border);background:var(--surface-2);font-size:12.5px;font-weight:600;cursor:default;user-select:none}
.sync .led{width:8px;height:8px;border-radius:50%;background:var(--ok);box-shadow:0 0 8px var(--ok)}
.sync.off .led{background:var(--warn);box-shadow:0 0 8px var(--warn)}
.sync.off{color:var(--warn);border-color:rgba(255,180,84,.4)}
.sync.warn .led{background:var(--warn);box-shadow:0 0 8px var(--warn)}
.sync.warn{color:var(--warn);border-color:rgba(217,136,28,.42)}
.sync.err .led{background:var(--danger);box-shadow:0 0 8px var(--danger)}
.sync.err{color:var(--danger);border-color:rgba(230,67,104,.42)}
.sync.syncing .led{animation:syncpulse 1s ease-in-out infinite}
@keyframes syncpulse{50%{opacity:.3}}
.sync svg{width:15px;height:15px}
.content{position:relative;flex:1;width:100%;min-width:0;min-height:0;padding:18px calc(18px + env(safe-area-inset-right)) calc(18px + env(safe-area-inset-bottom)) calc(18px + env(safe-area-inset-left));overflow-y:auto;overflow-x:hidden;overscroll-behavior:contain;-webkit-overflow-scrolling:touch}
.env-watermark{position:fixed;inset:auto 32px 32px auto;font-size:110px;font-weight:950;letter-spacing:.14em;color:rgba(217,138,28,.08);pointer-events:none;z-index:0}

/* register 3-col */
.regwrap{display:grid;grid-template-columns:224px 1fr 336px;gap:16px;align-items:stretch;height:calc(100dvh - 112px);overflow:hidden}
.side{display:flex;flex-direction:column;gap:14px;height:100%;overflow-y:auto;padding-right:2px}
.catcol{display:flex;flex-direction:column;height:100%;min-height:0}
.panel{background:var(--surface);border:1px solid var(--border-soft);border-radius:18px;padding:18px}
.sideh{font-size:11px;letter-spacing:.16em;text-transform:uppercase;color:var(--muted-2);font-weight:600}
.idgrid{display:grid;grid-template-columns:1fr 1fr;gap:11px 16px}
.idgrid>div{display:flex;flex-direction:column;gap:3px}
.idgrid span{font-size:10.5px;color:var(--muted-2);text-transform:uppercase;letter-spacing:.05em;font-weight:600}
.idgrid b{font-size:14px;font-weight:750}
.linknum{background:none;border:none;padding:0;font:inherit;color:var(--accent);font-weight:700;cursor:pointer;text-decoration:underline;text-underline-offset:2px}
.linknum:hover{filter:brightness(1.1)}
.noteflag{color:var(--accent-2);font-size:18px;line-height:0;margin-left:6px;vertical-align:middle}
/* ===== modern POS ===== */
.pos{display:grid;grid-template-columns:minmax(190px,1.05fr) minmax(320px,2.55fr) minmax(300px,1.45fr);gap:14px;height:calc(100dvh - 124px);min-height:0}
.poscol{display:flex;flex-direction:column;min-height:0;gap:12px}
.poscard{background:var(--surface);border:1px solid var(--border-soft);border-radius:16px;padding:12px}
.sectit{font-size:11px;letter-spacing:.14em;text-transform:uppercase;color:var(--muted-2);font-weight:700;margin-bottom:10px}
.cust-sel{display:flex;align-items:center;gap:10px;padding:10px 12px;border-radius:12px;background:var(--surface-2);margin:2px 0 10px}
.cust-sel .av{width:34px;height:34px;border-radius:10px;display:grid;place-items:center;background:linear-gradient(135deg,var(--accent),var(--accent-2));color:#fff;font-weight:700;flex:none}
.cust-name{font-weight:700;font-size:13.5px}
.cust-meta{font-size:11.5px;color:var(--muted-2)}
.debtbig{display:flex;justify-content:space-between;align-items:center;padding:10px 12px;border-radius:11px;border:1px solid var(--border-soft);font-size:12.5px;margin-bottom:8px}
.debtbig.has{border-color:rgba(230,67,104,.4);background:rgba(230,67,104,.06)}
.debtbig .v{font-family:var(--font-mono);font-weight:800}
.qa{display:flex;flex-direction:column;gap:8px}
.qabtn{display:flex;align-items:center;gap:9px;padding:11px 13px;border-radius:11px;border:1px solid var(--border-soft);background:var(--surface);color:var(--text);font-weight:650;font-size:13px;cursor:pointer;text-align:left;font-family:inherit;transition:.13s}
.qabtn:hover{background:var(--surface-2);border-color:var(--accent)}
.qabtn svg{width:16px;height:16px;color:var(--accent);flex:none}
.possearch{display:flex;align-items:center;gap:10px;background:var(--surface);border:1px solid var(--border);border-radius:14px;padding:0 14px;height:50px;flex:none}
.possearch:focus-within{border-color:var(--accent);box-shadow:0 0 0 4px rgba(14,165,181,.14)}
.possearch svg{width:19px;height:19px;color:var(--muted-2)}
.possearch input{flex:1;border:none;background:none;outline:none;font-size:15px;color:var(--text);font-family:inherit}
.posgridwrap{flex:1;min-height:0;overflow-y:auto;padding-right:4px}
.posgrid{display:grid;grid-template-columns:repeat(auto-fill,minmax(148px,1fr));gap:12px}
.pn2{font-size:12.5px;font-weight:650;line-height:1.25;min-height:31px;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden}
.pp2{font-family:var(--font-mono);font-weight:800;font-size:14px}
.pstk{display:flex;align-items:center;gap:6px;font-size:11px;color:var(--muted)}
.dot{width:8px;height:8px;border-radius:50%;flex:none}
.dot.ok{background:var(--ok)} .dot.low{background:#E8A93B} .dot.out{background:var(--danger)}
.addbtn2{margin-top:2px;width:100%;height:32px;border-radius:9px;border:none;background:linear-gradient(135deg,var(--accent),var(--accent-2));color:#fff;font-weight:700;font-size:12.5px;cursor:pointer;display:flex;align-items:center;justify-content:center;gap:5px;font-family:inherit}
.addbtn2:disabled{background:var(--surface-3);color:var(--muted-2);cursor:not-allowed}
.addbtn2 svg{width:14px;height:14px}
/* search-first minimal product list */
.poslist{display:flex;flex-direction:column;gap:7px}
.prow{display:flex;align-items:center;gap:12px;width:100%;text-align:left;background:var(--surface);border:1px solid var(--border-soft);border-radius:12px;padding:11px 13px;cursor:pointer;font-family:inherit;transition:.12s}
.prow:hover:not(:disabled){border-color:var(--accent);background:var(--surface-2)}
.prow:disabled{opacity:.5;cursor:not-allowed}
.prow-m{flex:1;min-width:0;display:flex;flex-direction:column;gap:2px}
.prow-n{font-size:13.5px;font-weight:650;color:var(--text);line-height:1.25;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.prow-s{font-size:11.5px;color:var(--muted-2);display:flex;align-items:center;gap:5px}
.prow-p{font-family:var(--font-mono);font-weight:800;font-size:14px;color:var(--text);white-space:nowrap}
.prow-add{flex:none;width:30px;height:30px;border-radius:9px;background:linear-gradient(135deg,var(--accent),var(--accent-2));color:#fff;display:grid;place-items:center;font-weight:700}
.prow:disabled .prow-add{background:var(--surface-3);color:var(--muted-2)}
.prow-add svg{width:15px;height:15px}
.prow-more{text-align:center;font-size:11.5px;color:var(--muted-2);padding:8px 4px 2px}
.possearch-empty{height:100%;min-height:240px;display:flex;flex-direction:column;align-items:center;justify-content:center;text-align:center;gap:10px;color:var(--muted-2);padding:30px}
.possearch-empty > svg{width:34px;height:34px;opacity:.5}
.possearch-empty .pse-t{font-size:15px;font-weight:650;color:var(--muted)}
.possearch-empty .pse-s{font-size:13px;line-height:1.5;max-width:280px}
.posright{background:var(--surface);border:1px solid var(--border-soft);border-radius:18px;padding:16px;display:flex;flex-direction:column;min-height:0;height:100%;overflow-y:auto}
.cartlines2{flex:1;min-height:60px;overflow-y:auto;display:flex;flex-direction:column;gap:8px;margin:8px 0;padding-right:2px}
.cline{display:flex;align-items:center;gap:10px}
.cline .nm{flex:1;font-size:13px;font-weight:600;line-height:1.2}
.cline .pr{font-family:var(--font-mono);font-size:11.5px;color:var(--muted)}
.cempty{flex:1;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:8px;color:var(--muted-2);text-align:center;font-size:13px}
.cempty svg{width:28px;height:28px;opacity:.5}
.calc{border-top:1px solid var(--border-soft);padding-top:10px;display:flex;flex-direction:column;gap:5px}
.calcrow{display:flex;justify-content:space-between;font-size:13px;color:var(--muted)}
.calcrow .v{font-family:var(--font-mono);color:var(--text);font-weight:600}
.paymethods{display:grid;grid-template-columns:1fr 1fr;gap:8px;margin:12px 0}
.paybtn{display:flex;align-items:center;gap:8px;padding:10px;border-radius:11px;border:1px solid var(--border-soft);background:var(--surface);color:var(--muted);font-weight:650;font-size:12.5px;cursor:pointer;font-family:inherit}
.paybtn svg{width:16px;height:16px}
.paybtn.on{border-color:var(--accent);background:rgba(14,165,181,.1);color:var(--accent)}
.paytotal{display:flex;justify-content:space-between;align-items:baseline;padding:12px 0;border-top:2px solid var(--border)}
.paytotal .lbl{font-size:11.5px;letter-spacing:.12em;text-transform:uppercase;color:var(--muted-2);font-weight:700}
.paytotal .amt{font-family:var(--font-mono);font-weight:800;font-size:29px;letter-spacing:-.01em}
.complete{width:100%;height:52px;border-radius:13px;border:none;background:linear-gradient(135deg,var(--accent),var(--accent-2));color:#fff;font-weight:800;font-size:16px;cursor:pointer;font-family:inherit;box-shadow:0 10px 24px -10px var(--accent);display:flex;align-items:center;justify-content:center;gap:8px}
.complete:disabled{background:var(--surface-3);color:var(--muted-2);box-shadow:none;cursor:not-allowed}
.complete svg{width:18px;height:18px}
.cust-chip{display:flex;align-items:center;justify-content:space-between;gap:8px;padding:9px 12px;border-radius:11px;background:var(--surface-2);font-size:12.5px;margin-bottom:10px}
.cust-chip b{font-weight:700}
.linkc{background:none;border:none;color:var(--accent);font-weight:700;cursor:pointer;font-size:12px;font-family:inherit}
.fab{position:fixed;right:22px;bottom:22px;z-index:40;display:flex;align-items:center;gap:9px;height:50px;padding:0 18px;border-radius:999px;border:none;background:linear-gradient(135deg,var(--accent),var(--accent-2));color:#fff;font-weight:750;font-size:14px;cursor:pointer;box-shadow:0 12px 30px -8px var(--accent);font-family:inherit}
.fab svg{width:18px;height:18px}
.aifloat{position:fixed;right:22px;bottom:84px;z-index:41;width:370px;max-width:calc(100vw - 32px);height:70vh;max-height:560px;background:var(--surface);border:1px solid var(--border);border-radius:18px;box-shadow:0 24px 60px -20px rgba(20,20,40,.45);display:flex;flex-direction:column;overflow:hidden}
.aifloat .hh{display:flex;align-items:center;justify-content:space-between;padding:13px 15px;border-bottom:1px solid var(--border-soft);font-weight:750}
.aifloat .body{flex:1;overflow-y:auto;padding:13px 15px;display:flex;flex-direction:column;gap:9px}
.aiq{display:flex;flex-direction:column;gap:7px}
.aiq button{text-align:left;padding:9px 11px;border-radius:10px;border:1px solid var(--border-soft);background:var(--surface);color:var(--text);font-size:12.5px;cursor:pointer;font-family:inherit}
.aiq button:hover{background:var(--surface-2)}
.aibub{padding:9px 12px;border-radius:12px;font-size:13px;line-height:1.5;white-space:pre-wrap}
.aibub.user{background:linear-gradient(135deg,var(--accent),var(--accent-2));color:#fff;align-self:flex-end;max-width:88%}
.aibub.bot{background:var(--surface-2);align-self:flex-start;max-width:92%}
.aifoot{display:flex;gap:8px;padding:11px;border-top:1px solid var(--border-soft)}
.aifoot input{flex:1;border:1px solid var(--border);border-radius:10px;padding:0 12px;height:40px;background:var(--surface-2);outline:none;font-family:inherit;font-size:13px;color:var(--text)}
.postabs{display:none}

/* cashier workstation */
.cashier-app{background:#eef5f6}
.cashier-app .shell{max-width:1920px}
.cashier-app .topbar{background:#333840;color:#eef6f7;border-bottom:none;box-shadow:0 18px 42px -30px rgba(4,9,20,.9);border-radius:0}
.cashier-app .brand .name,.cashier-app .who .nm{color:#f8fafc}
.cashier-app .who .rl{color:#9fb2bd}
.cashier-app .branchsel.locked{border-color:rgba(45,212,222,.28);background:rgba(45,212,222,.12);color:#f8fafc}
.cashier-app .iconbtn{background:#1f2937;border-color:#334155;color:#cbd5e1}
.cashier-app .content{padding:14px 22px;background:radial-gradient(circle at 50% 0%,rgba(45,212,222,.17),transparent 34%),linear-gradient(135deg,#f7fafb,#e9f2f4)}
.cashier-workstation .pos{grid-template-columns:350px minmax(0,1fr) 470px;height:calc(100dvh - 104px);gap:18px}
.cashier-workstation .poscol{gap:14px}
.cashier-rail,.cashier-products,.checkout-panel{background:rgba(255,255,255,.94);border:1px solid rgba(15,23,42,.08);border-radius:22px;box-shadow:0 22px 52px -40px rgba(15,23,42,.62)}
.cashier-rail{padding:18px;display:flex;flex-direction:column;gap:13px}
.cashier-rail.dark{background:linear-gradient(180deg,#111a21,#121b22);border-color:rgba(148,163,184,.16);color:#f8fafc;box-shadow:0 24px 54px -34px rgba(2,6,23,.92)}
.cashier-rail.dark .sectit{color:#8da1b2}
.cashier-rail.dark .cust-meta{color:#91a6b8}
.cashier-open-head{display:flex;align-items:center;justify-content:space-between;gap:10px;margin-bottom:4px}
.cashier-open-total{font-family:var(--font-mono);font-size:22px;font-weight:950;color:#f8fafc}
.cashier-open-list{display:flex;flex-direction:column;gap:10px;overflow-y:auto;min-height:0;padding-right:2px}
.cashier-open-card{border:1px solid rgba(148,163,184,.16);background:rgba(255,255,255,.035);border-radius:16px;padding:12px;color:#f8fafc;text-align:left;font-family:inherit;cursor:pointer;transition:.12s}
.cashier-open-card:hover{border-color:rgba(45,212,222,.5);background:rgba(45,212,222,.08)}
.co-top{display:flex;justify-content:space-between;gap:12px;align-items:flex-start}
.co-no{font-size:15px;font-weight:900;letter-spacing:.01em}
.co-amt{font-family:var(--font-mono);font-size:15px;font-weight:950;color:#7dd3fc;white-space:nowrap}
.co-cust{margin-top:5px;font-size:13px;font-weight:750;color:#d7e5eb;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.co-meta{margin-top:8px;display:flex;justify-content:space-between;gap:10px;font-size:11px;color:#8da1b2}
.cashier-open-empty{margin:auto 0;padding:34px 18px;border:1px dashed rgba(148,163,184,.22);border-radius:22px;text-align:center;color:#91a6b8;font-size:18px;line-height:1.35}
.cashier-rail.grow{flex:1;min-height:0}
.rail-head{display:flex;justify-content:space-between;align-items:flex-start;gap:10px}
.rail-title{font-size:19px;font-weight:850;letter-spacing:-.03em}
.scanner-pill{height:34px;display:inline-flex;align-items:center;gap:6px;padding:0 10px;border-radius:999px;background:var(--surface-2);border:1px solid var(--border);font-size:11.5px;font-weight:800;color:var(--muted);cursor:pointer;white-space:nowrap}
.scanner-pill svg{width:14px;height:14px}
.scanner-pill.on{background:rgba(14,165,181,.13);border-color:rgba(14,165,181,.4);color:var(--accent)}
.cashier-metrics{display:grid;grid-template-columns:1fr 1fr;gap:8px}
.cashier-metrics div{background:linear-gradient(160deg,var(--surface-2),var(--surface));border:1px solid var(--border-soft);border-radius:13px;padding:10px}
.cashier-metrics span{display:block;font-size:10px;text-transform:uppercase;letter-spacing:.11em;color:var(--muted-2);font-weight:800}
.cashier-metrics b{display:block;margin-top:4px;font-family:var(--font-mono);font-size:13px}
.cashier-actions{display:flex;flex-direction:column;gap:8px}
.cashier-quick{min-height:46px;border-radius:13px;border:1px solid var(--border-soft);background:var(--surface);color:var(--text);display:grid;grid-template-columns:30px 1fr auto;align-items:center;gap:8px;padding:8px 10px;font-family:inherit;font-weight:750;cursor:pointer;text-align:left;transition:.12s}
.cashier-quick:hover:not(:disabled){border-color:var(--accent);background:rgba(14,165,181,.07)}
.cashier-quick:disabled{opacity:.45;cursor:not-allowed}
.cashier-quick.danger .cq-ic{color:var(--danger);background:rgba(229,72,77,.1)}
.cq-ic{width:30px;height:30px;border-radius:10px;background:rgba(14,165,181,.1);color:var(--accent);display:grid;place-items:center}
.cq-ic svg{width:16px;height:16px}
.cq-label{font-size:13px}
.shortcut{font-size:10.5px;font-weight:850;color:var(--muted-2);background:var(--surface-2);border:1px solid var(--border-soft);border-radius:8px;padding:4px 7px}
.cashier-cats{display:flex;flex-direction:column;gap:7px;overflow-y:auto;padding-right:2px}
.cashier-cat{min-height:42px;border-radius:12px;border:1px solid transparent;background:transparent;color:var(--muted);display:flex;align-items:center;justify-content:space-between;gap:10px;padding:8px 10px;font-family:inherit;font-weight:750;cursor:pointer;text-align:left}
.cashier-cat:hover{background:var(--surface-2);color:var(--text)}
.cashier-cat.on{background:linear-gradient(135deg,var(--accent),var(--accent-2));color:#fff;box-shadow:0 12px 24px -18px var(--accent)}
.cashier-cat b{font-family:var(--font-mono);font-size:12px}
.cashier-flash{font-size:12px;line-height:1.4;color:var(--accent);background:rgba(14,165,181,.09);border:1px solid rgba(14,165,181,.22);border-radius:12px;padding:10px}
.cashier-products{display:flex;flex-direction:column;min-height:0;padding:18px}
.cashier-searchbar{display:grid;grid-template-columns:minmax(0,1fr) 154px;gap:12px;align-items:center}
.cashier-workstation .possearch{height:70px;border-radius:24px;background:#fff;border-color:rgba(14,165,181,.32);box-shadow:0 0 0 5px rgba(14,165,181,.09)}
.cashier-workstation .possearch input{font-size:22px;font-weight:700}
.cashier-workstation .possearch svg{width:24px;height:24px}
.scanner-toggle{height:70px;border-radius:22px;border:none;background:linear-gradient(135deg,#43bdc8,#72dfd1);color:#fff;font-family:inherit;font-weight:900;display:flex;align-items:center;justify-content:center;gap:9px;cursor:pointer;font-size:16px}
.scanner-toggle:not(.on){background:var(--surface-3);color:var(--muted)}
.scanner-toggle svg{width:18px;height:18px}
.product-strip{display:flex;align-items:center;gap:12px;flex-wrap:wrap;margin:14px 4px 16px;color:#72838e;font-size:13px;font-weight:850}
.product-strip b{font-family:var(--font-mono);color:var(--text)}
.desktop-shortcuts{margin-left:auto;color:#6f7f8a;font-size:12px}
.cashier-workstation .posgridwrap{flex:1;min-height:0;overflow-y:auto;padding-right:5px}
.workstation-grid{grid-template-columns:repeat(auto-fill,minmax(196px,1fr));gap:16px;align-content:start}
.cashier-product{min-height:256px;border:1px solid rgba(15,23,42,.07);border-radius:22px;background:linear-gradient(180deg,#fff,#f8fbfc);color:var(--text);padding:14px;display:flex;flex-direction:column;gap:12px;text-align:left;cursor:pointer;font-family:inherit;box-shadow:0 20px 42px -34px rgba(15,23,42,.75);transition:.12s}
.cashier-product:hover:not(:disabled){transform:translateY(-1px);border-color:rgba(14,165,181,.55);box-shadow:0 18px 42px -30px rgba(14,165,181,.7)}
.cashier-product:disabled{opacity:.62;cursor:not-allowed}
.cp-img{height:116px;border-radius:18px;background:linear-gradient(150deg,#eef8fa,#f7fbfc);display:grid;place-items:center;overflow:hidden}
.cp-img svg{width:36px;height:36px;color:var(--accent)}
.cp-body{display:flex;flex-direction:column;gap:5px;min-height:62px}
.cp-name{font-size:19px;font-weight:950;line-height:1.12;letter-spacing:-.01em;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden}
.cp-meta{font-family:var(--font-mono);font-size:13px;font-weight:900;color:#7e8b96;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.cp-foot{margin-top:auto;display:flex;align-items:center;justify-content:space-between;gap:8px}
.cp-price{font-family:var(--font-mono);font-weight:950;font-size:22px;letter-spacing:-.02em;color:#0f172a}
.cp-stock{font-size:10.5px;font-weight:850;border-radius:999px;padding:4px 7px;background:rgba(21,168,107,.1);color:var(--ok);white-space:nowrap}
.cp-stock.low{background:rgba(217,138,28,.12);color:var(--warn)}
.cp-stock.out{background:rgba(229,72,77,.12);color:var(--danger)}
.checkout-panel{padding:18px;border-color:#59616b;background:#fff}
.checkout-panel .sectit{letter-spacing:.18em}
.checkout-panel .cartlines2{margin:12px 0;gap:10px}
.checkout-panel .cline{background:var(--surface-2);border:1px solid var(--border-soft);border-radius:14px;padding:9px}
.checkout-panel .field{margin-top:12px}
.checkout-panel .input{height:62px;border-radius:16px;font-size:17px}
.checkout-panel .paytotal{margin-top:8px;padding:14px 0}
.checkout-panel .paytotal .amt{font-size:40px}
.complete.enterprise{height:76px;border-radius:20px;font-size:22px;letter-spacing:-.01em;box-shadow:0 18px 30px -18px var(--accent)}
.complete.enterprise span{font-size:11px;background:rgba(255,255,255,.2);border-radius:999px;padding:4px 8px}
.cart-actions .btn{height:58px;border-radius:16px;font-size:16px}
.invoice-panel{max-height:230px;overflow:auto}
@media (max-width:1500px) and (min-width:981px){
  .cashier-app .shell{max-width:100%}
  .cashier-workstation .pos{grid-template-columns:280px minmax(0,1fr) 390px;gap:12px}
  .workstation-grid{grid-template-columns:repeat(auto-fill,minmax(150px,1fr));gap:10px}
  .cashier-product{min-height:194px;border-radius:16px;padding:10px}
  .cp-img{height:76px}
  .cp-name{font-size:14.5px}
  .cp-price{font-size:16px}
  .cashier-workstation .possearch,.scanner-toggle{height:52px;border-radius:15px}
  .checkout-panel .paytotal .amt{font-size:29px}
  .complete.enterprise{height:54px;font-size:16px}
}
@media (max-height:820px) and (min-width:981px){
  .topbar{padding:calc(10px + env(safe-area-inset-top)) calc(18px + env(safe-area-inset-right)) 10px calc(18px + env(safe-area-inset-left))}
  .content{padding:14px calc(18px + env(safe-area-inset-right)) calc(14px + env(safe-area-inset-bottom)) calc(18px + env(safe-area-inset-left))}
  .pos{height:calc(100dvh - 96px);gap:12px;grid-template-columns:minmax(180px,.95fr) minmax(300px,2.5fr) minmax(290px,1.35fr)}
  .possearch{height:46px}
  .poscard,.posright{padding:12px}
  .field{margin-top:10px}
  .input,.select{height:42px}
  .complete{height:46px}
  .paytotal{padding:8px 0}
  .paytotal .amt{font-size:25px}
}
@media (max-width:980px){
  .pos{grid-template-columns:1fr;height:auto}
  .poscol{display:none}
  .poscol.active{display:flex}
  .posgridwrap{max-height:none}
  .posright{height:auto}
  .postabs{display:flex;gap:8px;margin-bottom:12px}
  .ptab{flex:1;padding:11px;border-radius:11px;border:1px solid var(--border-soft);background:var(--surface);font-weight:700;font-size:13px;cursor:pointer;font-family:inherit;color:var(--muted)}
  .ptab.on{background:linear-gradient(135deg,var(--accent),var(--accent-2));color:#fff;border-color:transparent}
}
.cashtiles{display:grid;grid-template-columns:repeat(4,1fr);gap:14px;margin-bottom:18px}
@media (max-width:720px){.cashtiles{grid-template-columns:repeat(2,1fr)}}
@media (max-width:460px){.cashtiles{grid-template-columns:1fr}}
.ctile{position:relative;background:var(--surface);border:1px solid var(--border-soft);border-radius:16px;padding:15px 16px;display:flex;flex-direction:column;gap:9px;min-height:104px}
.ctile .ic{width:36px;height:36px;border-radius:11px;display:grid;place-items:center;background:var(--surface-2);color:var(--accent)}
.ctile .ic svg{width:18px;height:18px}
.ctile .cl{font-size:11.5px;color:var(--muted-2);font-weight:600;letter-spacing:.01em}
.ctile .cv{font-size:21px;font-weight:800;font-family:var(--font-mono);letter-spacing:-.01em;line-height:1.1}
.ctile .cs{font-size:11px;color:var(--muted)}
.ctile.primary{background:linear-gradient(150deg,var(--accent),var(--accent-2));border:none;color:#fff;box-shadow:0 10px 26px -12px var(--accent)}
.ctile.primary .cl,.ctile.primary .cs{color:rgba(255,255,255,.86)}
.ctile.primary .cv{color:#fff;font-size:24px}
.ctile.primary .ic{background:rgba(255,255,255,.2);color:#fff}
.ctile.good .cv{color:var(--ok)}
.ctile.warn .cv{color:var(--danger)}
.cash-page{max-width:1180px;margin:0 auto}
.cash-reconcile{display:grid;grid-template-columns:1fr 1fr;gap:10px;margin:-2px 0 18px}
.cash-equation{display:flex;align-items:center;justify-content:space-between;gap:16px;padding:11px 13px;border-top:1px solid var(--border-soft);border-bottom:1px solid var(--border-soft)}
.cash-equation span{color:var(--muted);font-size:12px}
.cash-equation b{font:800 13px var(--font-mono);text-align:right}
.cash-ledger-warning{margin-bottom:18px}
@media (max-width:720px){.cash-reconcile{grid-template-columns:1fr}.cash-equation{align-items:flex-start;flex-direction:column;gap:4px}.cash-equation b{text-align:left}}
.eodrow{display:flex;align-items:center;gap:12px;padding:12px 14px;border:1px solid var(--border-soft);border-radius:13px;background:var(--surface)}
.dash{display:flex;flex-direction:column;gap:16px}
.dash2{display:grid;grid-template-columns:1fr 1fr;gap:16px}
@media (max-width:900px){.dash2{grid-template-columns:1fr}}
.dcard{background:var(--surface);border:1px solid var(--border-soft);border-radius:16px;padding:16px}
.dcard .ht{display:flex;align-items:center;gap:8px;font-weight:750;font-size:14px;margin-bottom:14px}
.dcard .ht svg{width:16px;height:16px;color:var(--accent)}
.dcard .ht .rt{margin-left:auto;font-size:11.5px;color:var(--muted-2);font-weight:600}
.aisum{background:linear-gradient(135deg,rgba(14,165,181,.1),rgba(34,199,214,.08));border:1px solid rgba(14,165,181,.28)}
.aisum .txt{font-size:14px;line-height:1.6;color:var(--text)}
.bars{display:flex;flex-direction:column;gap:10px}
.bar-row{display:flex;align-items:center;gap:10px;font-size:12.5px}
.bar-row .lbl{width:96px;color:var(--muted);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;font-weight:600}
.bar-track{flex:1;height:10px;border-radius:6px;background:var(--surface-2);overflow:hidden}
.bar-fill{height:100%;border-radius:6px;background:linear-gradient(90deg,var(--accent),var(--accent-2))}
.bar-row .val{font-family:var(--font-mono);font-weight:700;font-size:12px;width:78px;text-align:right}
.trend{display:flex;align-items:flex-end;gap:8px;height:140px}
.trend .col{flex:1;display:flex;flex-direction:column;align-items:center;gap:7px;height:100%;justify-content:flex-end}
.trend .colbar{width:78%;border-radius:7px 7px 0 0;background:linear-gradient(180deg,var(--accent),var(--accent-2));min-height:4px;transition:.2s}
.trend .colv{font-size:9.5px;color:var(--muted-2);font-family:var(--font-mono)}
.trend .cold{font-size:10.5px;color:var(--muted-2);font-weight:600}
.drow{display:flex;align-items:center;gap:11px;padding:10px 0;border-bottom:1px solid var(--border-soft)}
.drow:last-child{border-bottom:none}
.drow .av{width:32px;height:32px;border-radius:9px;display:grid;place-items:center;background:var(--surface-2);font-weight:700;font-size:13px;flex:none}
.drow .m{flex:1;min-width:0}
.drow .m .t{font-size:13px;font-weight:650;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.drow .m .s{font-size:11.5px;color:var(--muted-2)}
.drow .amt{font-family:var(--font-mono);font-weight:700;font-size:12.5px;text-align:right;flex:none}
.dempty{color:var(--muted-2);font-size:13px;padding:8px 0}
.insgroups{display:flex;flex-direction:column;gap:18px}
.insgrp .h{display:flex;align-items:center;gap:8px;font-weight:750;font-size:14px;margin-bottom:10px}
.insgrp .h svg{width:16px;height:16px;color:var(--accent)}
.inschips{display:flex;flex-wrap:wrap;gap:8px}
.inschip{display:inline-flex;align-items:center;gap:7px;padding:9px 13px;border-radius:11px;border:1px solid var(--border-soft);background:var(--surface);color:var(--text);font-size:13px;font-weight:600;cursor:pointer;font-family:inherit;transition:.13s}
.inschip:hover{background:var(--surface-2);border-color:var(--accent);color:var(--accent)}
.inschip.on{background:linear-gradient(135deg,var(--accent),var(--accent-2));color:#fff;border-color:transparent}
.insans{background:linear-gradient(135deg,rgba(14,165,181,.09),rgba(34,199,214,.06));border:1px solid rgba(14,165,181,.26);border-radius:16px;padding:16px;white-space:pre-wrap;font-size:14px;line-height:1.62}
.insans .qh{font-weight:750;margin-bottom:9px;display:flex;align-items:center;gap:8px}
.insans .qh svg{width:16px;height:16px;color:var(--accent)}
.branchwrap{display:grid;grid-template-columns:1fr 1fr;gap:20px;align-items:start}
@media (max-width:980px){.branchwrap{grid-template-columns:1fr}}
.checkrow{display:flex;align-items:center;gap:10px;padding:13px 14px;border:1px solid var(--border-soft);border-radius:13px;background:var(--surface);cursor:pointer;font-weight:600;font-size:14px;margin-top:12px}
.checkrow input{width:18px;height:18px;accent-color:var(--accent);cursor:pointer}
.brow{display:flex;align-items:center;gap:12px;padding:14px;border:1px solid var(--border-soft);border-radius:14px;background:var(--surface);margin-bottom:10px}
.brow .bn{font-weight:750}
.brow .bc{color:var(--muted-2);font-size:12px;font-weight:500;margin-left:6px}
.brow .bu{font-family:var(--font-mono);font-weight:700;font-size:13px}
.bpill{font-size:11px;font-weight:700;padding:4px 11px;border-radius:999px;white-space:nowrap}
.bpill.on{background:rgba(22,163,107,.13);color:var(--ok)}
.bpill.off{background:var(--surface-3);color:var(--muted)}
.bcard{background:var(--surface-2);border:1px solid var(--border-soft);border-radius:16px;padding:16px;margin-bottom:12px}
.bcard .bt{font-weight:800;font-size:15px;letter-spacing:.01em}
.bcard .bl{color:var(--muted-2);font-size:12.5px;margin-top:3px}
.bcard .bkv{display:flex;justify-content:space-between;align-items:center;margin-top:12px;font-size:13px;color:var(--muted)}
.bcard .bkv .v{font-family:var(--font-mono);font-weight:800;color:var(--text)}
.ptools{display:flex;gap:10px;align-items:center;flex-wrap:wrap;margin-bottom:14px}
.ptools .possearch{height:42px;flex:1;min-width:200px}
.ptblwrap{overflow:auto;max-height:calc(100dvh - 300px);border:1px solid var(--border-soft);border-radius:16px;background:var(--surface)}
.ptbl{width:100%;border-collapse:collapse;font-size:13px;min-width:720px}
.ptbl thead th{text-align:left;font-size:10.5px;letter-spacing:.08em;text-transform:uppercase;color:var(--muted-2);font-weight:700;padding:12px 14px;border-bottom:1px solid var(--border-soft);background:var(--surface);white-space:nowrap;position:sticky;top:0;z-index:2}
.ptbl thead th.num{text-align:right}
.ptbl tbody td{padding:10px 14px;border-bottom:1px solid var(--border-soft);vertical-align:middle}
.ptbl tbody tr:last-child td{border-bottom:none}
.ptbl tbody tr:hover{background:var(--surface-2)}
.ptbl td.num{text-align:right;font-family:var(--font-mono);font-weight:600}
.ptimg{width:42px;height:42px;border-radius:9px;overflow:hidden;background:var(--surface-2);display:grid;place-items:center}
.ptimg svg{width:18px;height:18px;color:var(--accent);opacity:.8}
.ptname{font-weight:650}
.ptsub{font-size:11.5px;color:var(--muted-2)}
.ptcat{display:inline-block;font-size:11.5px;font-weight:600;color:var(--muted);background:var(--surface-2);padding:3px 9px;border-radius:7px;white-space:nowrap}
.ptstk{display:inline-flex;align-items:center;gap:6px;white-space:nowrap}
.ptact{display:flex;gap:6px;justify-content:flex-end;white-space:nowrap}
.rights-grid{display:grid;grid-template-columns:repeat(3,1fr);gap:8px}
.roletag{display:inline-block;font-size:10.5px;font-weight:700;letter-spacing:.02em;padding:2px 9px;border-radius:999px;vertical-align:1px;margin-left:6px}
.roletag.sup{color:var(--accent);background:rgba(14,165,181,.14)}
@media (max-width:760px){.rights-grid{grid-template-columns:repeat(2,1fr)}}
@media (max-width:480px){.rights-grid{grid-template-columns:1fr}}
.rightchip{display:flex;align-items:center;gap:7px;padding:9px 11px;border-radius:10px;border:1px solid var(--border-soft);background:var(--surface);color:var(--muted);font-size:12.5px;font-weight:600;cursor:pointer;text-align:left;transition:.13s;font-family:inherit}
.rightchip svg{width:14px;height:14px;flex:none}
.rightchip:hover{background:var(--surface-2);color:var(--text)}
.rightchip.on{background:rgba(14,165,181,.12);border-color:var(--accent);color:var(--accent)}
.qexp{display:flex;gap:8px;flex-wrap:wrap}
.qexp button{flex:1;min-width:64px;padding:8px 10px;border-radius:10px;border:1px solid var(--border);background:var(--surface-2);color:var(--text);font-size:12.5px;font-weight:650;cursor:pointer}
.qexp button:hover{background:var(--surface-3)}
.qexp button.on{border-color:var(--accent);color:var(--accent)}
.invdoc{background:linear-gradient(135deg,var(--accent),var(--accent-2));border-radius:14px;padding:14px 16px;color:#fff;display:flex;align-items:center;justify-content:space-between}
.invdoc .l{font-size:12px;opacity:.85}.invdoc .v{font-size:16px;font-weight:750;font-family:var(--font-mono)}
.invdoc .b{font-size:11px;opacity:.85;text-align:right}
.miniinv{display:flex;align-items:center;justify-content:space-between;gap:8px;background:var(--surface-2);border:1px solid var(--border-soft);border-radius:11px;padding:9px 11px;font-size:12px}
.miniinv .mn{font-family:var(--font-mono);font-weight:700;font-size:11px}
.miniinv.clickable{cursor:pointer;transition:.15s}
.miniinv.clickable:hover{border-color:var(--accent);background:var(--surface-3)}
.debtbar{background:rgba(230,67,104,.1);border:1px solid rgba(230,67,104,.3);color:#B5324E;border-radius:11px;padding:10px 12px;font-size:12.5px;font-weight:650;display:flex;align-items:center;gap:8px}
.debtbar svg{width:15px;height:15px}

.cathead{border-radius:18px;padding:20px 22px;background:linear-gradient(110deg,#0b0e16 0%,#171a2b 42%,var(--accent) 130%);display:flex;align-items:center;gap:18px;margin-bottom:16px}
.cathead .ct{font-size:20px;font-weight:800;letter-spacing:-.02em;white-space:nowrap}
.cathead .cs{flex:1;position:relative;display:flex;align-items:center}
.cathead .cs label{position:absolute;top:-16px;left:2px;font-size:11px;color:rgba(255,255,255,.7)}
.cathead .cs input{width:100%;height:50px;border-radius:13px;border:none;background:#fff;color:#111;font-size:15px;padding:0 16px;outline:none}
.fastsell{display:flex;align-items:flex-end;justify-content:space-between;margin-bottom:14px}
.fastsell .e{font-size:11px;letter-spacing:.14em;text-transform:uppercase;color:var(--muted-2);font-weight:600}
.fastsell .h{font-size:17px;font-weight:750}
.fastsell .n{font-size:13px;font-weight:700;color:var(--muted)}
.grid{display:grid;grid-template-columns:repeat(3,1fr);gap:12px}
.catscroll{flex:1;min-height:0;overflow-y:auto;overflow-x:hidden;padding:2px 6px 2px 2px}
.pcard{background:var(--surface);border:1px solid var(--border-soft);border-radius:14px;padding:11px;display:flex;flex-direction:column;gap:6px}
.pimg{height:150px;border-radius:12px;background:linear-gradient(160deg,var(--surface-2),var(--surface-3));display:grid;place-items:center;overflow:hidden}
.pimg svg{width:40px;height:40px;color:var(--accent);opacity:.8}
.pn{font-size:14px;font-weight:700;line-height:1.2}
.psku{font-size:11.5px;color:var(--muted-2);font-family:var(--font-mono)}
.pbadges{display:flex;gap:8px}
.pbadge{flex:1;text-align:center;font-size:11px;font-weight:700;padding:5px 8px;border-radius:8px;background:var(--surface-2);color:var(--muted)}
.pbadge.stk{color:var(--ok)}
.pbadge.stk.low{color:var(--warn)}
.pfoot{display:flex;align-items:center;justify-content:space-between;gap:8px;margin-top:2px}
.pp{font-family:var(--font-mono);font-size:14px;font-weight:750}
.addbtn{height:38px;padding:0 18px;border-radius:11px;border:none;background:linear-gradient(135deg,var(--accent),var(--accent-2));color:#fff;font-weight:700;font-size:13px;cursor:pointer}
.addbtn:hover{filter:brightness(1.08)}
.addbtn:disabled{opacity:.4;cursor:not-allowed}

/* cart */
.cart{height:100%;display:flex;flex-direction:column;overflow:hidden}
.cart .ch{font-size:11px;color:var(--muted-2);font-weight:600}
.cart .ci{font-size:20px;font-weight:800}
.cartbox{border:1px solid var(--border-soft);border-radius:14px;flex:1;min-height:120px;overflow-y:auto;margin:12px 0;padding:12px;display:flex;flex-direction:column;gap:8px}
.cartempty{flex:1;display:flex;flex-direction:column;align-items:center;justify-content:center;text-align:center;color:var(--muted-2);font-size:13px;gap:10px;padding:20px}
.cartempty svg{width:30px;height:30px;opacity:.6}
.rcpno{display:flex;align-items:center;justify-content:space-between;background:var(--surface-2);border:1px dashed var(--border);border-radius:11px;padding:9px 12px;font-size:12px;color:var(--muted);margin-top:10px}
.rcpno .v{font-family:var(--font-mono);font-weight:800;color:var(--text);letter-spacing:.02em}
.input.invalid{border-color:#E64368 !important;box-shadow:0 0 0 3px rgba(230,67,104,.15)}
.line{display:flex;align-items:center;gap:10px}
.line .ln{flex:1;min-width:0}
.line .lnm{font-size:13px;font-weight:650;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.line .lpr{font-size:11.5px;color:var(--muted)}
.qty{display:flex;align-items:center;gap:6px}
.qbtn{width:26px;height:26px;border-radius:7px;border:1px solid var(--border);background:var(--surface-2);color:var(--text);cursor:pointer;display:grid;place-items:center}
.qbtn svg{width:12px;height:12px}
.qn{font-family:var(--font-mono);font-size:13px;min-width:16px;text-align:center}
.totrow{display:flex;justify-content:space-between;font-size:13.5px;color:var(--muted);margin-top:10px}
.totrow.grand{color:var(--text);font-size:20px;font-weight:800;margin-top:8px;padding-top:12px;border-top:1px solid var(--border-soft)}
.totrow.grand .v{font-family:var(--font-mono)}

/* modal */
.scrim{position:fixed;inset:0;background:rgba(6,8,14,.66);backdrop-filter:blur(3px);display:grid;place-items:center;z-index:60;padding:20px;overflow-y:auto}
.modal{width:100%;max-width:420px;background:var(--surface);border:1px solid var(--border);border-radius:20px;padding:24px;box-shadow:0 30px 80px -30px rgba(20,30,70,.4);animation:rise .2s ease;max-height:min(88vh,calc(100dvh - 40px));overflow:auto}
.camera-scrim{z-index:90}
.camera-modal{max-width:560px;padding:18px;overflow:hidden}
.camera-head{display:flex;align-items:flex-start;justify-content:space-between;gap:14px;margin-bottom:14px}
.camera-head .section-title{margin:4px 0 0}
.camera-preview{position:relative;width:100%;aspect-ratio:4/3;max-height:60dvh;overflow:hidden;border:1px solid var(--border);border-radius:12px;background:#071015}
.camera-preview video{display:block;width:100%;height:100%;object-fit:cover}
.camera-target{position:absolute;inset:27% 8%;border:2px solid rgba(255,255,255,.92);border-radius:8px;box-shadow:0 0 0 999px rgba(0,0,0,.28);pointer-events:none}
.camera-target span{position:absolute;left:7%;right:7%;top:50%;height:2px;background:var(--accent-2);box-shadow:0 0 9px rgba(34,199,214,.9)}
.camera-error{position:absolute;inset:0;display:flex;align-items:center;justify-content:center;gap:10px;padding:24px;text-align:center;color:#fff;background:#10191f;font-size:13px;line-height:1.5}
.camera-error svg{width:22px;height:22px;flex:0 0 auto;color:var(--warn)}
.camera-status{min-height:38px;padding:11px 2px 4px;color:var(--muted);font-size:13px;line-height:1.45}
.camera-status.error{color:var(--danger)}
.camera-actions{display:flex;justify-content:flex-end;gap:8px;margin-top:10px}
.camera-actions .btn{width:auto;min-width:112px}
.barcode-input-row{display:grid;grid-template-columns:minmax(0,1fr) auto;gap:8px;align-items:center}
.fp-reader-preview{position:relative;min-height:224px;margin-top:14px;border:1px solid color-mix(in srgb,var(--accent) 65%,var(--border));border-radius:12px;background:color-mix(in srgb,var(--accent) 5%,var(--bg));display:grid;place-items:center;overflow:hidden}
.fp-reader-preview img{display:block;width:100%;height:224px;object-fit:contain;background:#f4f7f8}
.fp-reader-empty{display:grid;place-items:center;gap:8px;color:var(--muted);text-align:center;padding:24px}
.fp-reader-empty svg{width:54px;height:54px;color:var(--accent)}
.fp-reader-preview.scanning::after{content:"";position:absolute;left:8%;right:8%;height:2px;background:var(--accent);box-shadow:0 0 12px var(--accent);animation:fpScan 1.4s ease-in-out infinite}
.fp-reader-meta{display:flex;justify-content:space-between;align-items:center;gap:10px;margin-top:9px;color:var(--muted);font-size:12px}
.fp-enrolled-status{display:inline-flex;align-items:center;gap:5px;color:var(--ok);font-weight:800}
.fp-enrolled-status svg{width:14px;height:14px}
.fp-enrolled-btn{color:var(--ok)!important;border-color:color-mix(in srgb,var(--ok) 45%,var(--border))!important;background:color-mix(in srgb,var(--ok) 8%,var(--surface))!important}
.user-security-row.disabled{background:var(--surface-2)}
.user-security-row.disabled>.avatar{filter:grayscale(1);opacity:.65}
.user-enable-toggle,.product-enable-toggle{height:34px;padding:0 9px;border:1px solid var(--border);border-radius:9px;background:var(--surface);color:var(--muted-2);display:flex;align-items:center;gap:7px;font:inherit;font-size:11px;font-weight:750;cursor:pointer;white-space:nowrap}
.user-enable-toggle:disabled,.product-enable-toggle:disabled{opacity:.55;cursor:not-allowed}
.user-enable-track,.product-enable-track{width:27px;height:16px;border-radius:999px;background:var(--muted-2);padding:2px;display:flex;align-items:center;transition:.15s}
.user-enable-track>span,.product-enable-track>span{width:12px;height:12px;border-radius:50%;background:#fff;transition:transform .15s}
.user-enable-toggle.on,.product-enable-toggle.on{color:var(--ok);border-color:color-mix(in srgb,var(--ok) 38%,var(--border))}
.user-enable-toggle.on .user-enable-track,.product-enable-toggle.on .product-enable-track{background:var(--ok)}
.user-enable-toggle.on .user-enable-track>span,.product-enable-toggle.on .product-enable-track>span{transform:translateX(11px)}
.product-row-disabled{background:var(--surface-2);color:var(--muted)}
.product-row-disabled .ptimg{filter:grayscale(1);opacity:.6}
@keyframes fpScan{0%,100%{top:18%}50%{top:82%}}
.customer-page{max-width:1120px;margin:0 auto}
.customer-toolbar{display:flex;align-items:center;gap:10px;flex-wrap:wrap;margin-bottom:12px}
.customer-toolbar .possearch{flex:1;min-width:260px}
.customer-filter-tabs{display:flex;align-items:center;gap:4px;padding:4px;border:1px solid var(--border-soft);border-radius:10px;background:var(--surface-2)}
.customer-filter{height:34px;padding:0 11px;border:0;border-radius:7px;background:transparent;color:var(--muted);font:700 12px var(--font-ui);cursor:pointer;display:flex;align-items:center;gap:7px;white-space:nowrap}
.customer-filter:hover{color:var(--text)}
.customer-filter.on{background:var(--surface);color:var(--text);box-shadow:0 1px 3px rgba(0,0,0,.1)}
.customer-filter-count{min-width:19px;height:19px;padding:0 5px;border-radius:999px;background:var(--surface-3);display:grid;place-items:center;font:750 10px var(--font-mono)}
.customer-filter.debt.on .customer-filter-count{background:color-mix(in srgb,var(--danger) 16%,transparent);color:var(--danger)}
.customer-row{width:100%;grid-template-columns:auto minmax(0,1fr) minmax(128px,auto) 24px;text-align:left;cursor:pointer;appearance:none;color:inherit}
.customer-row:hover{border-color:color-mix(in srgb,var(--accent) 48%,var(--border));background:color-mix(in srgb,var(--accent) 5%,var(--surface))}
.customer-row:focus-visible{outline:3px solid color-mix(in srgb,var(--accent) 35%,transparent);outline-offset:2px}
.customer-account-balance{text-align:right;display:flex;flex-direction:column;align-items:flex-end;gap:2px}
.customer-account-balance strong{font:800 14px var(--font-mono)}
.customer-account-balance small{font-size:11px;color:var(--muted-2)}
.customer-account-status{display:inline-flex;align-items:center;width:max-content;padding:3px 7px;border-radius:999px;font-size:10px;font-weight:800;text-transform:uppercase}
.customer-account-status.debt{color:var(--danger);background:color-mix(in srgb,var(--danger) 12%,transparent)}
.customer-account-status.pending{color:var(--warn);background:color-mix(in srgb,var(--warn) 12%,transparent)}
.customer-account-status.paid{color:var(--ok);background:color-mix(in srgb,var(--ok) 12%,transparent)}
.customer-account-status.inactive{color:var(--muted);background:var(--surface-2)}
.customer-chevron{width:18px;height:18px;color:var(--muted-2)}
.customer-history-modal{width:min(760px,calc(100vw - 32px));max-width:760px;padding:0;overflow:hidden;display:flex;flex-direction:column;max-height:min(760px,calc(100dvh - 40px))}
.customer-history-head{display:flex;align-items:flex-start;justify-content:space-between;gap:20px;padding:22px 24px;border-bottom:1px solid var(--border)}
.customer-history-head h2{margin:4px 0 2px;font-size:24px}
.customer-history-head p{margin:0;color:var(--muted-2)}
.customer-history-summary{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:10px;padding:16px 24px;background:color-mix(in srgb,var(--bg) 72%,var(--surface))}
.customer-history-summary>div{display:flex;flex-direction:column;gap:4px;min-width:0;padding:12px;border:1px solid var(--border);border-radius:12px;background:var(--surface)}
.customer-history-summary span{color:var(--muted-2);font-size:11px;text-transform:uppercase;font-weight:750}
.customer-history-summary strong{font-size:17px;overflow-wrap:anywhere}
.customer-balance-due{color:var(--warn)}
.customer-invoice-title{display:flex;align-items:center;justify-content:space-between;gap:12px;padding:16px 24px 10px}
.customer-invoice-title>div{display:flex;align-items:center;gap:8px}
.customer-invoice-title svg{width:17px;height:17px;color:var(--accent)}
.customer-invoice-title span{color:var(--muted-2);font-size:12px}
.customer-invoice-list{min-height:0;overflow-y:auto;padding:0 24px 22px}
.customer-invoice-columns,.customer-invoice-row{display:grid;grid-template-columns:minmax(145px,1.35fr) 82px 90px 90px minmax(105px,.9fr);align-items:center;gap:12px}
.customer-invoice-columns{padding:7px 10px;color:var(--muted-2);font-size:10px;font-weight:800;text-transform:uppercase;border-bottom:1px solid var(--border)}
.customer-invoice-row{padding:12px 10px;border-bottom:1px solid var(--border)}
.customer-invoice-row:last-child{border-bottom:0}
.customer-invoice-main{min-width:0}
.customer-invoice-main strong{display:block;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-family:var(--font-mono)}
.customer-invoice-main span{display:block;margin-top:3px;color:var(--muted-2);font-size:11px}
.customer-invoice-status{justify-self:start}
.customer-invoice-status.open{color:var(--warn)}
.customer-invoice-status.partial{color:var(--warn)}
.customer-invoice-status.overdue,.customer-invoice-status.debt{color:var(--danger)}
.customer-invoice-status.paid{color:var(--ok)}
.customer-invoice-amount{text-align:right;font-weight:800}
.customer-invoice-amount small{display:none;color:var(--muted-2);font-weight:700}
@media(max-width:700px){.customer-toolbar{align-items:stretch}.customer-toolbar .possearch{min-width:100%;width:100%}.customer-filter-tabs{width:100%;overflow-x:auto}.customer-filter{flex:1;justify-content:center}.customer-row{grid-template-columns:auto minmax(0,1fr) auto}.customer-account-balance{grid-column:2;align-items:flex-start;text-align:left}.customer-chevron{grid-column:3;grid-row:1/3}.customer-history-modal{max-height:calc(100dvh - 20px)}.customer-history-head{padding:17px}.customer-history-summary{grid-template-columns:1fr;padding:12px 17px;gap:7px}.customer-history-summary>div{display:grid;grid-template-columns:1fr auto;align-items:center;padding:9px 11px}.customer-invoice-title{padding:14px 17px 8px}.customer-invoice-list{padding:0 17px 17px}.customer-invoice-columns{display:none}.customer-invoice-row{grid-template-columns:minmax(0,1fr) auto;gap:7px 12px;padding:11px 5px}.customer-invoice-status{justify-self:end}.customer-invoice-amount{display:flex;justify-content:space-between;grid-column:1/-1;text-align:left}.customer-invoice-amount small{display:block}}
@keyframes rise{from{opacity:0;transform:translateY(10px)}to{opacity:1;transform:none}}
.modal-head{display:flex;align-items:center;justify-content:space-between;margin-bottom:6px}
.rcpt{font-family:var(--font-mono);background:var(--bg);border:1px dashed var(--border);border-radius:14px;padding:18px;margin:16px 0;font-size:12.5px;color:var(--muted)}
.test-receipt-mark{text-align:center;font-family:var(--font-mono);font-weight:900;color:var(--warn);line-height:1.35;margin-bottom:10px}
.rcpt .rc-h{text-align:center;color:var(--text);font-weight:700;font-family:var(--font-ui);margin-bottom:2px}
.rcpt .rc-s{text-align:center;color:var(--muted-2);margin-bottom:12px}
.rcpt .rrow{display:flex;justify-content:space-between;padding:2px 0}
.rcpt .rrow.t{color:var(--text);font-weight:700;border-top:1px solid var(--border);margin-top:8px;padding-top:8px}
.badge{display:inline-flex;align-items:center;gap:6px;font-size:11.5px;font-weight:650;padding:4px 10px;border-radius:999px}
.badge svg{width:13px;height:13px}
.badge.pend{background:rgba(255,180,84,.14);color:var(--warn)}
.env-current{display:flex;align-items:center;justify-content:space-between;gap:18px;margin-bottom:16px}
.env-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:16px;margin:16px 0}
.env-card{background:var(--surface);border:1px solid var(--border);border-radius:18px;padding:18px;display:flex;flex-direction:column;gap:12px}
.env-card.test{border-color:rgba(217,138,28,.35);background:linear-gradient(180deg,rgba(217,138,28,.12),var(--surface))}
.env-card.live{border-color:rgba(21,168,107,.35);background:linear-gradient(180deg,rgba(21,168,107,.10),var(--surface))}
.env-card h3{font-size:18px;font-weight:850}
.env-card p{color:var(--muted);font-size:13.5px;line-height:1.55}
.env-info{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:12px;margin-top:14px}
.env-info .tile{background:var(--surface);border:1px solid var(--border);border-radius:14px;padding:14px}
.env-info .k{font-size:11px;color:var(--muted-2);text-transform:uppercase;letter-spacing:.12em;font-weight:850}
.env-info .v{font-size:14px;color:var(--text);font-weight:750;margin-top:6px;word-break:break-word}
.env-blockers{margin-top:14px;border:1px solid rgba(229,72,77,.35);background:rgba(229,72,77,.10);border-radius:14px;padding:14px;color:var(--danger)}
.env-blockers ul{margin:10px 0 0;padding-left:18px}
@media (max-width:900px){.env-grid,.env-info{grid-template-columns:1fr}.env-current{align-items:flex-start;flex-direction:column}.env-watermark{font-size:72px;right:14px;bottom:14px}}

/* admin */
.kpis{display:grid;grid-template-columns:1fr 1fr 1fr;gap:14px;margin-bottom:18px}
.kpi{background:var(--surface);border:1px solid var(--border-soft);border-radius:16px;padding:16px 18px;display:flex;align-items:center;justify-content:space-between;gap:12px}
.kpi .kl{font-size:12.5px;color:var(--muted)}
.kpi .kv{font-size:22px;font-weight:750;font-family:var(--font-mono);letter-spacing:-.02em}
.kpi .kv.warn{color:var(--warn)}
.wshead{font-size:11px;letter-spacing:.16em;text-transform:uppercase;color:var(--muted-2);font-weight:600;margin-bottom:2px}
.wstitle{font-size:18px;font-weight:750;margin-bottom:14px}
.wtabs{display:flex;gap:8px;flex-wrap:wrap;margin-bottom:22px}
.adminwrap{display:grid;width:100%;min-width:0;grid-template-columns:240px minmax(0,1fr);gap:20px;align-items:start;transition:grid-template-columns .18s ease}
.adminwrap.nav-collapsed{grid-template-columns:66px 1fr}
.navside{position:sticky;top:84px;display:flex;flex-direction:column;gap:3px;background:var(--surface);border:1px solid var(--border-soft);border-radius:16px;padding:11px;max-height:calc(100dvh - 104px);overflow-y:auto;overflow-x:hidden}
.navcollapse{display:flex;align-items:center;gap:10px;width:100%;padding:9px 11px;border-radius:10px;border:none;background:none;color:var(--muted-2);font-size:12px;font-weight:600;cursor:pointer;font-family:inherit;margin-bottom:4px;transition:.13s}
.navcollapse:hover{background:var(--surface-2);color:var(--text)}
.navcollapse svg{width:16px;height:16px;flex:none}
.navitem{position:relative;display:flex;align-items:center;gap:10px;padding:9px 11px;border-radius:10px;color:var(--muted);font-size:13.5px;font-weight:600;cursor:pointer;border:none;background:none;text-align:left;width:100%;transition:.13s;font-family:inherit;white-space:nowrap}
.navitem svg{width:16px;height:16px;flex:none}
.navitem:hover{background:var(--surface-2);color:var(--text)}
.navitem.main{font-weight:800;font-size:14px;color:var(--text)}
.navitem.on{background:linear-gradient(135deg,var(--accent),var(--accent-2));color:#fff;box-shadow:0 6px 16px -8px var(--accent)}
.navbadge{margin-left:auto;min-width:19px;height:19px;border-radius:999px;background:#EF4444;color:#fff;font-size:11px;font-weight:850;display:inline-flex;align-items:center;justify-content:center;padding:0 6px;line-height:1}
.navside.collapsed .navbadge{position:absolute;right:6px;top:4px;min-width:17px;height:17px;font-size:10px;padding:0 5px}
.navgrp{display:flex;flex-direction:column;gap:3px}
.navsec{font-size:11px;letter-spacing:.1em;text-transform:uppercase;color:var(--muted);font-weight:800;padding:13px 11px 5px;display:flex;align-items:center;gap:7px;white-space:nowrap;width:100%;border:none;background:none;cursor:pointer;font-family:inherit;border-radius:8px;transition:.13s}
.navsec:hover{color:var(--text);background:var(--surface-2)}
.navsec svg{width:13px;height:13px;flex:none}
.navsec-chev{margin-left:auto;display:grid;place-items:center;color:var(--muted-2)}
.navsec-chev svg{width:14px;height:14px}
.navdiv{height:1px;background:var(--border-soft);margin:8px 4px}
/* collapsed icon rail */
.navside.collapsed{padding:11px 8px}
.navside.collapsed .navitem{justify-content:center;gap:0;padding:11px 0}
.navside.collapsed .navcollapse{justify-content:center;gap:0}
.navside.collapsed .navsec{justify-content:center;gap:0;padding:13px 0 5px}
.navside.collapsed .navsec svg{width:15px;height:15px}
.navside.collapsed .navlabel{display:none}
.admincontent{min-width:0}
@media (max-width:1100px){
  .adminwrap{grid-template-columns:210px 1fr;gap:16px}
  .adminwrap.nav-collapsed{grid-template-columns:60px 1fr}
  .navside{top:72px;max-height:calc(100dvh - 88px)}
  .kpis{grid-template-columns:repeat(2,minmax(0,1fr))}
  .ptblwrap{max-height:calc(100dvh - 260px)}
}
@media (max-width:900px){
  .adminwrap,.adminwrap.nav-collapsed{grid-template-columns:1fr;gap:14px}
  .navside,.navside.collapsed{position:sticky;top:0;z-index:15;width:100%;max-height:none;min-width:0;flex-direction:row;align-items:center;gap:3px;overflow-x:auto;overflow-y:hidden;padding:8px;border-radius:12px;scrollbar-width:none}
  .navside::-webkit-scrollbar{display:none}
  .navcollapse{display:none}
  .navside .navdiv{width:1px;height:32px;flex:0 0 1px;margin:0 4px}
  .navside .navgrp{display:flex;flex-direction:row;align-items:center;gap:3px;flex:none}
  .navside .navitem,.navside.collapsed .navitem{width:auto;min-height:40px;justify-content:flex-start;gap:8px;padding:9px 11px;flex:none}
  .navside .navsec,.navside.collapsed .navsec{width:auto;min-height:40px;justify-content:flex-start;gap:7px;padding:9px 11px;flex:none}
  .navside .navsec-chev{margin-left:3px}
  .navside.collapsed .navlabel{display:inline}
  .navside.collapsed .navsec-chev{display:grid}
  .admincontent{width:100%;min-width:0}
  .vpos input,.vpos select,.vpos textarea{font-size:16px}
}
.wtab{display:flex;align-items:center;gap:7px;padding:9px 14px;border-radius:11px;border:1px solid var(--border-soft);background:var(--surface);color:var(--muted);font-size:13px;font-weight:650;cursor:pointer;transition:.15s}
.wtab:hover{color:var(--text);background:var(--surface-2)}
.wtab.on{background:linear-gradient(135deg,var(--accent),var(--accent-2));color:#fff;border-color:transparent;box-shadow:0 6px 18px -8px var(--accent)}
.wtab svg{width:15px;height:15px}
.page-h{display:flex;align-items:flex-start;justify-content:space-between;gap:12px;margin-bottom:16px;flex-wrap:wrap}
.list{display:flex;flex-direction:column;gap:10px}
.row{display:flex;align-items:center;gap:13px;background:var(--surface);border:1px solid var(--border-soft);border-radius:14px;padding:12px 14px}
.row.clickable{cursor:pointer;transition:.15s}
.row.clickable:hover{border-color:var(--accent);background:var(--surface-2)}
.avatar{width:40px;height:40px;border-radius:11px;flex-shrink:0;display:grid;place-items:center;font-weight:700;font-size:15px;color:#fff;background:linear-gradient(135deg,var(--accent),var(--accent-2))}
.row .meta{flex:1;min-width:0}
.row .nm{font-size:14.5px;font-weight:650}
.row .mt2{font-size:12px;color:var(--muted);margin-top:1px}
.pill{font-family:var(--font-mono);font-size:13px;color:var(--muted);background:var(--bg);border:1px solid var(--border);padding:6px 10px;border-radius:9px;display:flex;align-items:center;gap:7px;cursor:pointer;user-select:none;white-space:nowrap}
.pill.plain{cursor:default}
.pill:hover{color:var(--text)}
.pill svg{width:14px;height:14px}
.smdel{background:none;border:1px solid var(--border);border-radius:9px;cursor:pointer;color:var(--muted-2);width:34px;height:34px;display:grid;place-items:center;transition:.15s;flex-shrink:0}
.smdel:hover{color:var(--danger);border-color:var(--danger)}
.smdel svg{width:15px;height:15px}
.addpanel{background:var(--surface);border:1px solid var(--border);border-radius:16px;padding:18px;margin-bottom:14px}
.grid2{display:grid;grid-template-columns:1fr 1fr;gap:12px}
.grid3{display:grid;grid-template-columns:1fr 1fr 1fr;gap:12px}
.row-add{width:100%;height:46px;border-radius:12px;cursor:pointer;border:1px dashed var(--border);background:transparent;color:var(--muted);display:flex;align-items:center;justify-content:center;gap:8px;font-size:14px;font-weight:600;transition:.15s;margin-bottom:14px}
.row-add:hover{border-color:var(--accent);color:var(--accent);background:rgba(14,165,181,.07)}
.row-add svg{width:17px;height:17px}
.section-title{font-size:14px;font-weight:700;margin:18px 0 12px}
.stats{display:grid;grid-template-columns:repeat(auto-fit,minmax(190px,1fr));gap:14px;margin-bottom:18px}
.stat{background:var(--surface);border:1px solid var(--border-soft);border-radius:16px;padding:16px}
.stat .sl{font-size:12px;color:var(--muted);font-weight:600}
.stat .sv{font-size:23px;font-weight:750;margin-top:8px;font-family:var(--font-mono);letter-spacing:-.02em}
.stat .sv.warn{color:var(--warn)}
.bars{display:flex;flex-direction:column;gap:10px;margin-top:6px}
.bar-row{display:flex;align-items:center;gap:12px;font-size:13px}
.bar-row .bl{width:130px;color:var(--muted);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.bar-track{flex:1;height:10px;border-radius:6px;background:var(--surface-2);overflow:hidden}
.bar-fill{height:100%;border-radius:6px;background:linear-gradient(90deg,var(--accent),var(--accent-2))}
.bar-row .bv{font-family:var(--font-mono);color:var(--text);width:90px;text-align:right}
.filters{display:grid;grid-template-columns:1fr 1fr 1fr;gap:12px;margin:14px 0}
.tbl{width:100%;border-collapse:collapse;font-size:13px}
.tbl thead th{background:linear-gradient(135deg,var(--accent-press),var(--accent-2));color:#fff;text-align:left;padding:11px 12px;font-size:12px;font-weight:700}
.tbl thead th:first-child{border-radius:11px 0 0 11px}
.tbl thead th:last-child{border-radius:0 11px 11px 0}
.tbl td{padding:12px;border-bottom:1px solid var(--border-soft);vertical-align:middle}
.tbl .innum{font-weight:700;font-family:var(--font-mono);font-size:12px}
.tbl .amt{font-family:var(--font-mono);font-weight:700}
.ist{font-size:11px;font-weight:700;padding:4px 10px;border-radius:999px;text-transform:capitalize}
.ist.open{background:rgba(14,165,181,.16);color:#4F58D6}
.ist.overdue{background:rgba(255,180,84,.16);color:var(--warn)}
.ist.debt{background:rgba(230,67,104,.14);color:#C23A56}
.ist.void-pending{background:rgba(220,38,38,.14);color:#DC2626}
.ist.partial{background:rgba(46,120,199,.14);color:#2E78C7}
.ist.paid{background:rgba(52,211,153,.16);color:var(--ok)}
.paycell{display:flex;align-items:center;gap:6px;flex-wrap:wrap}
.paycell select{height:34px;border-radius:8px;border:1px solid var(--border);background:var(--bg);color:var(--text);font-size:12px;padding:0 6px}
.paycell input{width:90px;height:34px;border-radius:8px;border:1px solid var(--border);background:var(--bg);color:var(--text);font-size:12px;padding:0 8px;font-family:var(--font-mono)}
.settlebar{display:grid;grid-template-columns:auto minmax(240px,1fr) minmax(170px,210px) 150px;gap:10px;align-items:center;margin:14px 0}
.settlebar .seg{display:flex;gap:7px;flex-wrap:wrap}
.settledates{grid-column:1 / -1;display:flex;justify-content:flex-end;align-items:flex-end;gap:8px;flex-wrap:wrap}
.settledates label{display:grid;gap:4px;min-width:155px}
.settledates label span{font-size:10.5px;font-weight:750;color:var(--muted-2);text-transform:uppercase;letter-spacing:.04em}
.settledates .input{height:38px;padding:0 10px}
.settledates .btn{height:38px}
.settlement-heading{display:flex;align-items:center;justify-content:space-between;gap:12px;flex-wrap:wrap}
.settlement-heading .settlement-scope{font-weight:750;margin-left:auto;text-align:right}
.settlesearch{position:relative}
.settlesearch svg{position:absolute;left:13px;top:50%;transform:translateY(-50%);width:17px;height:17px;color:var(--muted-2);z-index:1}
.settlesearch .input{padding-left:40px}
.tbl tr.clickable{cursor:pointer;transition:.15s}
.tbl tr.clickable:hover td{background:var(--surface-2)}
.settlement-modal{max-width:680px}
.settlement-totals{display:grid;grid-template-columns:1fr 1fr 1fr;gap:10px;margin:14px 0}
.settlement-totals>div{border:1px solid var(--border-soft);border-radius:13px;background:var(--surface-2);padding:12px}
.settlement-totals span{display:block;font-size:10.5px;color:var(--muted-2);text-transform:uppercase;letter-spacing:.05em;font-weight:700}
.settlement-totals b{display:block;margin-top:4px;font-size:16px;font-family:var(--font-mono)}
.settlement-totals .due b{color:#C23A56}
.settlement-box{border:1px solid var(--border-soft);border-radius:15px;background:var(--surface);padding:14px;margin:14px 0}
.settlement-box .wtab{justify-content:center}
.payamount{display:grid;grid-template-columns:1fr auto;gap:10px;margin:12px 0}
.void-review-box{border:1px solid rgba(217,153,35,.38);border-radius:15px;background:rgba(217,153,35,.08);padding:14px;margin:14px 0}
.void-review-meta,.void-decision{display:flex;align-items:center;justify-content:space-between;gap:12px}
.void-review-meta{font-size:12px;color:var(--muted-2);margin-bottom:10px}
.void-review-box .notice{margin:0 0 10px}
.void-decision{margin:14px 0;align-items:flex-start;flex-direction:column}
.void-decision.approved{border-color:rgba(41,158,105,.34);background:rgba(41,158,105,.08)}
.void-decision.rejected{border-color:rgba(194,58,86,.34);background:rgba(194,58,86,.08)}
.void-decision span{font-size:12px;color:var(--muted-2)}
.invoice-detail-modal{max-width:640px;padding:20px}
.invoice-detail-head{align-items:flex-start;margin:0;padding-bottom:14px;border-bottom:1px solid var(--border-soft)}
.invoice-detail-heading{min-width:0}
.invoice-detail-heading .sub{margin:0 0 5px}
.invoice-detail-title-row{display:flex;align-items:center;gap:9px;flex-wrap:wrap}
.invoice-detail-title-row .title{font-size:20px;line-height:1.2}
.invoice-carried{color:var(--warn);font-size:11px;font-weight:750;text-transform:uppercase}
.invoice-detail-meta{display:flex;align-items:flex-start;gap:16px;margin-top:10px;flex-wrap:wrap}
.invoice-detail-meta>span{display:grid;gap:2px;min-width:0}
.invoice-detail-meta small{color:var(--muted-2);font-size:9.5px;font-weight:750;text-transform:uppercase}
.invoice-detail-meta b{color:var(--text);font-size:12px;line-height:1.25}
.invoice-detail-meta .invoice-cleared-by b{color:var(--ok)}
.invoice-detail-totals{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));border-bottom:1px solid var(--border-soft);margin-bottom:2px}
.invoice-detail-totals>div{min-width:0;padding:14px 12px;border-right:1px solid var(--border-soft)}
.invoice-detail-totals>div:first-child{padding-left:0}
.invoice-detail-totals>div:last-child{padding-right:0;border-right:0}
.invoice-detail-totals span{display:block;color:var(--muted-2);font-size:10px;font-weight:750;text-transform:uppercase}
.invoice-detail-totals b{display:block;margin-top:3px;font-family:var(--font-mono);font-size:16px;overflow-wrap:anywhere}
.invoice-detail-totals .due b{color:var(--danger)}
.invoice-detail-section{padding:14px 0 4px}
.invoice-detail-section-head{display:flex;align-items:center;justify-content:space-between;margin-bottom:4px;font-size:13px}
.invoice-detail-section-head>span,.invoice-detail-disclosure summary b{min-width:22px;height:20px;padding:0 6px;border-radius:999px;background:var(--surface-2);color:var(--muted-2);display:inline-grid;place-items:center;font-size:10px;font-family:var(--font-mono)}
.invoice-detail-items{display:grid;max-height:184px;overflow:auto}
.invoice-detail-item{display:grid;grid-template-columns:minmax(0,1fr) auto;align-items:center;gap:14px;padding:10px 0;border-bottom:1px solid var(--border-soft)}
.invoice-detail-item:last-child{border-bottom:0}
.invoice-detail-item>div{min-width:0;display:grid;gap:2px}
.invoice-detail-item b{font-size:13px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.invoice-detail-item span{color:var(--muted-2);font-size:11.5px}
.invoice-detail-item strong{font-family:var(--font-mono);font-size:12.5px}
.invoice-detail-empty{padding:10px 0;color:var(--muted-2);font-size:12px}
.invoice-payment-panel{margin:8px 0 0;padding:14px 0;border-width:1px 0 0;border-radius:0;background:transparent}
.invoice-payment-head{display:flex;align-items:center;justify-content:space-between;gap:12px;margin-bottom:10px;font-size:13px}
.invoice-payment-head span{color:var(--danger);font-family:var(--font-mono);font-size:12px;font-weight:750}
.invoice-payment-toolbar{display:flex;align-items:center;justify-content:space-between;gap:10px}
.invoice-payment-methods{display:grid;grid-template-columns:repeat(2,minmax(108px,1fr));gap:5px;padding:3px;border:1px solid var(--border-soft);border-radius:10px;background:var(--surface-2)}
.invoice-method{height:34px;padding:0 12px;border:1px solid transparent;border-radius:7px;background:transparent;color:var(--muted);font:inherit;font-size:12px;font-weight:750;display:flex;align-items:center;justify-content:center;gap:7px;cursor:pointer}
.invoice-method svg{width:15px;height:15px}
.invoice-method:hover{color:var(--text)}
.invoice-method.on{border-color:var(--border);background:var(--surface);color:var(--accent);box-shadow:0 1px 3px rgba(0,0,0,.12)}
.invoice-payment-entry{display:grid;grid-template-columns:minmax(0,1fr) auto;gap:10px;align-items:end;margin-top:10px}
.invoice-payment-amount{display:grid;gap:4px}
.invoice-payment-amount>span{color:var(--muted-2);font-size:10px;font-weight:750;text-transform:uppercase}
.invoice-payment-entry .btn{min-width:180px}
.invoice-detail-sale-note{display:grid;gap:3px;padding:10px 0;border-top:1px solid var(--border-soft);font-size:12px}
.invoice-detail-sale-note span{color:var(--muted-2)}
.invoice-detail-disclosure{border-top:1px solid var(--border-soft)}
.invoice-detail-disclosure summary{display:flex;align-items:center;justify-content:space-between;gap:12px;padding:12px 0;color:var(--text);font-size:12.5px;font-weight:750;cursor:pointer;list-style:none}
.invoice-detail-disclosure summary::-webkit-details-marker{display:none}
.invoice-detail-disclosure summary>span{display:flex;align-items:center;gap:8px}
.invoice-detail-disclosure summary>svg{width:16px;height:16px;color:var(--muted-2);transition:transform .15s ease}
.invoice-detail-disclosure[open] summary>svg{transform:rotate(180deg)}
.invoice-detail-history{display:grid;padding-bottom:8px}
.invoice-detail-history-row{display:grid;grid-template-columns:minmax(0,1fr) auto;gap:12px;align-items:center;padding:8px 0;border-top:1px solid var(--border-soft)}
.invoice-detail-history-row>div{display:grid;gap:2px;min-width:0}
.invoice-detail-history-row b{text-transform:capitalize;font-size:12px}
.invoice-detail-history-row span{color:var(--muted-2);font-size:11px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.invoice-detail-history-row>strong{font-family:var(--font-mono);font-size:12px}
.invoice-detail-note-form{display:grid;grid-template-columns:minmax(0,1fr) auto;gap:10px;align-items:end;padding-bottom:12px}
.invoice-detail-note-form textarea{min-height:58px;padding-top:10px;resize:vertical}
.invoice-detail-footer{display:flex;justify-content:flex-end;padding-top:12px;border-top:1px solid var(--border-soft)}
@media (max-width:1180px){.settlebar{grid-template-columns:1fr 1fr}.settlebar .seg,.settlesearch{grid-column:1 / -1}}
@media (max-width:820px){.settlebar{grid-template-columns:1fr}.settlebar .seg,.settlesearch{grid-column:auto}.settledates{grid-column:auto;justify-content:stretch}.settledates label{flex:1 1 140px;min-width:0}.settlement-heading .settlement-scope{width:100%;margin-left:0;text-align:left}.settlement-totals{grid-template-columns:1fr}.settlement-modal{max-width:min(680px,calc(100vw - 20px))}.invoice-detail-totals{grid-template-columns:repeat(3,minmax(0,1fr))}.invoice-detail-note-form{grid-template-columns:1fr}.invoice-detail-note-form .btn{width:100%}.invoice-payment-toolbar{align-items:stretch;flex-direction:column}.invoice-payment-methods{width:100%}.invoice-payment-toolbar>.btn{width:100%}.invoice-payment-entry{grid-template-columns:1fr}.invoice-payment-entry .btn{width:100%}}
.tablewrap{overflow-x:auto}
.tblscroll{max-height:calc(100dvh - 340px);overflow:auto;border:1px solid var(--border-soft);border-radius:14px}
.tblscroll.lg{max-height:calc(100dvh - 230px)}
/* invoices: credit control gets the room, other sections compact */
.invoice-workspace-tabs{display:flex;align-items:center;gap:4px;border-bottom:1px solid var(--border);margin:2px 0 18px;overflow-x:auto}
.invoice-workspace-tabs button{height:46px;display:flex;align-items:center;gap:8px;padding:0 14px;border:0;border-bottom:2px solid transparent;background:transparent;color:var(--muted);font:inherit;font-size:13px;font-weight:750;white-space:nowrap;cursor:pointer}
.invoice-workspace-tabs button:hover{color:var(--text);background:var(--surface-2)}
.invoice-workspace-tabs button.active{color:var(--accent);border-bottom-color:var(--accent)}
.invoice-workspace-tabs svg{width:17px;height:17px}
.invoice-workspace-tabs span{min-width:22px;height:22px;display:inline-grid;place-items:center;padding:0 6px;border-radius:999px;background:var(--surface-2);color:var(--muted-2);font-size:10px;font-family:var(--font-mono)}
.invoice-workspace-tabs button.active span{background:rgba(14,165,181,.13);color:var(--accent)}
.invoice-workspace-view{min-width:0}
.invoice-summary-strip{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));border:1px solid var(--border-soft);border-left:0;border-right:0;margin-bottom:18px}
.invoice-summary-strip.three{grid-template-columns:repeat(3,minmax(0,1fr))}
.invoice-summary-strip>div{min-width:0;padding:13px 18px;border-right:1px solid var(--border-soft)}
.invoice-summary-strip>div:last-child{border-right:0}
.invoice-summary-strip span{display:block;color:var(--muted-2);font-size:10.5px;font-weight:750;text-transform:uppercase}
.invoice-summary-strip b{display:block;margin-top:5px;font-family:var(--font-mono);font-size:18px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.invoice-summary-strip b.warn{color:var(--warn)}
.invoice-summary-strip b.danger{color:var(--danger)}
.invoice-section-head{display:flex;align-items:center;justify-content:space-between;gap:14px;margin:4px 0 13px}
.invoice-section-head .section-title{font-size:16px;margin:0 0 3px}
.invoice-section-head .muted{color:var(--muted-2);font-size:12px}
.invoice-compact-summary{display:grid;grid-template-columns:auto auto 1fr;align-items:center;gap:22px;padding:0 0 12px;margin-bottom:12px;border-bottom:1px solid var(--border-soft)}
.invoice-compact-summary>div{display:grid;gap:2px}
.invoice-compact-summary b{font-family:var(--font-mono);font-size:16px}
.invoice-compact-summary b.danger{color:var(--danger)}
.invoice-compact-summary span{color:var(--muted-2);font-size:10.5px;text-transform:uppercase;font-weight:700}
.invoice-compact-summary .btn{justify-self:end}
.invoice-filter-grid{display:grid;grid-template-columns:minmax(260px,1fr) minmax(160px,210px) 150px;gap:10px;align-items:center;margin-bottom:8px}
.invoice-more-filters{border-bottom:1px solid var(--border-soft);padding:0 0 9px;margin-bottom:10px}
.invoice-more-filters summary{width:max-content;color:var(--muted-2);font-size:11.5px;font-weight:700;cursor:pointer;list-style-position:inside}
.invoice-more-filter-grid{display:grid;grid-template-columns:150px 155px 155px auto;align-items:end;gap:8px;padding-top:9px}
.invoice-more-filter-grid label{display:grid;gap:4px}
.invoice-more-filter-grid label span{color:var(--muted-2);font-size:10px;font-weight:700;text-transform:uppercase}
.invoice-more-filter-grid .input,.invoice-more-filter-grid .select,.invoice-more-filter-grid .btn{height:38px}
.invoice-selection-bar{display:flex;align-items:center;justify-content:space-between;gap:14px;padding:10px 12px;margin:8px 0 12px;border-left:3px solid var(--accent);background:rgba(14,165,181,.07)}
.invoice-selection-bar>div{display:flex;align-items:center;gap:9px}
.invoice-selection-bar span{font-size:12px;color:var(--muted-2)}
.invoice-table{min-width:820px}
.invoice-table .invoice-ref,.invoice-table .invoice-customer{display:grid;gap:4px;min-width:0}
.invoice-table .invoice-ref span,.invoice-table .invoice-customer span{max-width:300px;color:var(--muted-2);font-size:11px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.invoice-table .invoice-customer b{font-size:13px}
.invoice-table-wrap{max-height:calc(100dvh - 320px);min-height:280px}
.debt-summary{margin-top:0}
.debt-summary>section{min-width:0}
.debt-summary .list.mini{max-height:440px}
.inventory-debt-detail{display:grid;gap:6px;margin:10px 0 0 44px;padding:10px 0 0;border-top:1px solid var(--border-soft)}
.inventory-payment-page{max-width:760px;margin:0 auto}
.inventory-payment-modal{width:min(700px,calc(100vw - 24px));max-width:700px;max-height:calc(100dvh - 24px);overflow:auto;padding:16px}
.inventory-payment-modal .modal-head{margin-bottom:8px;padding-bottom:11px;border-bottom:1px solid var(--border-soft)}
.inventory-payment-modal .inventory-payment-page{max-width:none;margin:0}
.inventory-payment-workspace{padding:14px}
.inventory-payment-toolbar{display:flex;align-items:flex-end;justify-content:space-between;gap:12px;padding-bottom:11px;border-bottom:1px solid var(--border-soft)}
.inventory-payment-toolbar>span{color:var(--muted-2);font-size:11px;white-space:nowrap}
.inventory-payment-cashier{display:grid;gap:4px;width:min(100%,330px)}
.inventory-payment-cashier>span{color:var(--muted-2);font-size:10.5px;font-weight:750;text-transform:uppercase}
.inventory-selected-cashier{display:grid;grid-template-columns:auto minmax(0,1fr) auto;align-items:center;gap:12px;padding:11px 0;border-bottom:1px solid var(--border-soft)}
.inventory-selected-cashier .avatar{width:34px;height:34px;border-radius:8px}
.inventory-selected-cashier .meta{min-width:0}
.inventory-selected-cashier .metric{display:grid;gap:1px;min-width:92px;text-align:right}
.inventory-selected-cashier .metric span{color:var(--muted-2);font-size:9.5px;font-weight:750;text-transform:uppercase}
.inventory-selected-cashier .metric b{font-family:var(--font-mono);font-size:14px}
.inventory-selected-cashier .metric.due b{color:var(--danger)}
.inventory-debt-picker{padding:12px 0 0}
.inventory-debt-picker-head{display:flex;align-items:center;justify-content:space-between;gap:14px;margin-bottom:9px}
.inventory-debt-picker-head>div{display:grid;gap:2px}
.inventory-debt-picker-head b{font-size:13px}
.inventory-debt-picker-head span{color:var(--muted-2);font-size:11.5px}
.inventory-debt-list{max-height:210px;overflow:auto;border:1px solid var(--border-soft);border-radius:8px}
.inventory-debt-choice{display:grid;grid-template-columns:auto minmax(0,1fr) auto;align-items:center;gap:10px;padding:8px 10px;border-bottom:1px solid var(--border-soft);cursor:pointer;transition:.15s}
.inventory-debt-choice:last-child{border-bottom:0}
.inventory-debt-choice:hover{background:var(--surface-2)}
.inventory-debt-choice.selected{background:color-mix(in srgb,var(--accent) 7%,var(--surface))}
.inventory-debt-choice input{width:17px;height:17px;accent-color:var(--accent)}
.inventory-debt-choice .meta{display:grid;gap:3px;min-width:0}
.inventory-debt-choice .meta b{font-family:var(--font-mono);font-size:12px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.inventory-debt-choice .meta span{color:var(--muted-2);font-size:11px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.inventory-debt-choice .amount{display:grid;gap:2px;text-align:right}
.inventory-debt-choice .amount b{font-family:var(--font-mono);font-size:13px}
.inventory-debt-choice .amount span{color:var(--muted-2);font-size:10px}
.inventory-debt-selection{display:flex;align-items:center;justify-content:space-between;gap:12px;padding:8px 10px;background:var(--surface-2);border-radius:0 0 8px 8px;font-size:11.5px}
.inventory-debt-selection b{font-family:var(--font-mono);font-size:14px}
.inventory-payment-form{margin-top:12px;padding-top:12px;border-top:1px solid var(--border-soft)}
.inventory-payment-form-head{display:flex;align-items:center;justify-content:space-between;gap:12px;margin-bottom:10px}
.inventory-payment-form-head b{font-size:13px}
.inventory-payment-form-head span{color:var(--muted-2);font-size:11.5px}
.inventory-payment-methods{display:grid;grid-template-columns:repeat(2,minmax(100px,1fr));gap:5px;padding:3px;border:1px solid var(--border-soft);border-radius:8px;background:var(--surface-2)}
.inventory-payment-methods .invoice-method{height:32px}
.inventory-payment-entry{display:grid;grid-template-columns:minmax(0,1fr) auto;align-items:end;gap:8px;margin-top:8px}
.inventory-payment-entry label{display:grid;gap:5px}
.inventory-payment-entry label span{color:var(--muted-2);font-size:10px;font-weight:750;text-transform:uppercase}
.inventory-payment-options{margin-top:8px;border-bottom:1px solid var(--border-soft)}
.inventory-payment-options .grid2{padding-bottom:12px}
.inventory-payment-action{width:100%;height:44px;margin-top:10px}
.inventory-payment-history{margin-top:12px;padding:0 14px}
.inventory-payment-history>summary{display:flex;align-items:center;justify-content:space-between;gap:12px;padding:15px 0;cursor:pointer;list-style:none;font-size:13px;font-weight:750}
.inventory-payment-history>summary::-webkit-details-marker{display:none}
.inventory-payment-history>summary>span{display:flex;align-items:center;gap:8px}
.inventory-payment-history>summary b{min-width:22px;height:20px;padding:0 6px;border-radius:999px;background:var(--surface-2);color:var(--muted-2);display:inline-grid;place-items:center;font-size:10px;font-family:var(--font-mono)}
.inventory-payment-history>summary svg{width:16px;height:16px;color:var(--muted-2);transition:transform .15s}
.inventory-payment-history[open]>summary svg{transform:rotate(180deg)}
.inventory-payment-history .tablewrap{margin-bottom:16px}
.day-close-list{gap:8px;max-width:920px}
.compact-notice{padding:12px 16px;text-align:left;margin-bottom:12px}
.stats.compact{gap:10px;margin-bottom:12px}
.stats.compact .stat{padding:10px 13px;border-radius:12px}
.stats.compact .stat .sl{font-size:11px}
.stats.compact .stat .sv{font-size:17px;margin-top:3px}
.section-title.lead{font-size:16px;margin-top:22px}
.list.mini{gap:7px;max-height:158px;overflow-y:auto;padding-right:2px}
.list.mini .row{padding:8px 11px;gap:10px;border-radius:11px}
.list.mini .row .avatar{width:30px;height:30px}
.list.mini .row .nm{font-size:13px}
.list.mini .row .mt2{font-size:11px}
.invsummary{display:grid;grid-template-columns:1fr 1fr;gap:20px;margin-top:8px}
@media (max-width:820px){.invsummary{grid-template-columns:1fr}}
@media (max-width:900px){.invoice-summary-strip{grid-template-columns:repeat(2,minmax(0,1fr))}.invoice-summary-strip.three{grid-template-columns:repeat(3,minmax(0,1fr))}.invoice-summary-strip>div:nth-child(2){border-right:0}.invoice-summary-strip>div:nth-child(-n+2){border-bottom:1px solid var(--border-soft)}.invoice-summary-strip.three>div{border-bottom:0}.invoice-summary-strip.three>div:nth-child(2){border-right:1px solid var(--border-soft)}.invoice-filter-grid{grid-template-columns:1fr 1fr}.invoice-filter-grid .settlesearch{grid-column:1/-1}.invoice-more-filter-grid{grid-template-columns:1fr 1fr 1fr}.invoice-more-filter-grid .btn{grid-column:1/-1}.invoice-table-wrap{max-height:calc(100dvh - 350px)}}
@media (max-width:760px){.inventory-payment-toolbar{align-items:stretch;flex-direction:column}.inventory-payment-toolbar>span{white-space:normal}.inventory-payment-cashier{width:100%}.inventory-payment-methods{grid-template-columns:1fr 1fr}.inventory-payment-entry{grid-template-columns:1fr}.inventory-payment-entry .btn{width:100%}}
@media (max-width:620px){.invoice-summary-strip,.invoice-summary-strip.three{grid-template-columns:1fr 1fr}.invoice-summary-strip.three>div:nth-child(2){border-right:0}.invoice-summary-strip.three>div:nth-child(-n+2){border-bottom:1px solid var(--border-soft)}.invoice-summary-strip.three>div:last-child{grid-column:1/-1}.invoice-summary-strip>div{padding:11px 10px}.invoice-summary-strip b{font-size:15px}.invoice-compact-summary{grid-template-columns:1fr 1fr;gap:10px}.invoice-compact-summary .btn{grid-column:1/-1;width:100%}.invoice-section-head{align-items:stretch;flex-direction:column}.invoice-section-head .btn{width:100%}.invoice-filter-grid{grid-template-columns:1fr}.invoice-filter-grid .settlesearch{grid-column:auto}.invoice-more-filter-grid{grid-template-columns:1fr}.invoice-more-filter-grid .btn{grid-column:auto}.invoice-selection-bar{align-items:stretch;flex-direction:column}.invoice-selection-bar>div:last-child{display:grid;grid-template-columns:1fr 1fr}.inventory-debt-detail{margin-left:0}.inventory-payment-workspace{padding:12px}.inventory-selected-cashier{grid-template-columns:auto minmax(0,1fr) auto}.inventory-selected-cashier .metric{min-width:76px}.inventory-debt-picker-head{align-items:flex-start;flex-direction:column}.inventory-debt-picker-head .btn{width:100%}.inventory-debt-choice{grid-template-columns:auto minmax(0,1fr)}.inventory-debt-choice .amount{grid-column:2;text-align:left}.inventory-debt-selection{align-items:flex-start;flex-direction:column}.inventory-payment-options .grid2{grid-template-columns:1fr}.day-close-list .row .btn{width:100%}}
.tblscroll .tbl thead th{position:sticky;top:0;z-index:2}
.notice{border:1px dashed var(--border);border-radius:14px;padding:22px;text-align:center;color:var(--muted);font-size:13.5px;margin-top:6px}

/* cashier redesign */
.cdash{display:flex;flex-direction:column;gap:16px}
.cbar{display:flex;align-items:center;justify-content:space-between;gap:14px;flex-wrap:wrap;background:var(--surface);border:1px solid var(--border-soft);border-radius:18px;padding:14px 18px}
.cbar .hello{display:flex;align-items:center;gap:12px}
.cbar .hav{width:44px;height:44px;border-radius:13px;display:grid;place-items:center;font-weight:800;font-size:18px;color:#fff;background:linear-gradient(135deg,var(--accent),var(--accent-2))}
.cbar .ht{font-size:16px;font-weight:750;line-height:1.1}
.hs{font-size:12px;color:var(--muted)}
.cbar .hs{margin-top:2px}
.ckpis{display:flex;gap:10px;flex-wrap:wrap}
.ckpi{display:flex;flex-direction:column;gap:2px;padding:9px 15px;border-radius:13px;background:var(--surface-2);border:1px solid var(--border-soft);min-width:92px}
.ckpi .l{font-size:10px;letter-spacing:.1em;text-transform:uppercase;color:var(--muted-2);font-weight:700}
.ckpi .v{font-size:15px;font-weight:750;font-family:var(--font-mono)}
.ckpi.debt{border-color:rgba(255,92,119,.4)}
.ckpi.debt .v{color:#C23A56}
.cacts{display:flex;gap:10px}
.cmain{display:grid;grid-template-columns:1fr 392px;gap:16px;align-items:start}
.csearch{position:relative;display:flex;align-items:center;margin-bottom:14px}
.csearch svg{position:absolute;left:18px;width:20px;height:20px;color:var(--muted-2)}
.csearch input{width:100%;height:58px;border-radius:16px;border:1px solid var(--border);background:var(--surface);color:var(--text);font-size:16px;padding:0 18px 0 50px;outline:none;transition:.15s}
.csearch input:focus{border-color:var(--accent);box-shadow:0 0 0 4px rgba(14,165,181,.18)}
.csearch input::placeholder{color:var(--muted-2)}
.ccats{display:flex;gap:8px;flex-wrap:wrap;margin-bottom:18px}
.cchip{padding:8px 15px;border-radius:999px;border:1px solid var(--border);background:var(--surface);color:var(--muted);font-size:13px;font-weight:650;cursor:pointer;transition:.15s}
.cchip:hover{color:var(--text);background:var(--surface-2)}
.cchip.on{background:linear-gradient(135deg,var(--accent),var(--accent-2));color:#fff;border-color:transparent}
.ticket{position:sticky;top:84px;background:var(--surface);border:1px solid var(--border-soft);border-radius:18px;padding:18px;display:flex;flex-direction:column}
.ticket .th{display:flex;align-items:center;justify-content:space-between;margin-bottom:2px}
.ticket .th .tt{font-size:16px;font-weight:750;display:flex;align-items:center;gap:8px}
.ticket .th .tt svg{width:18px;height:18px;color:var(--accent)}
.tclear{background:none;border:none;color:var(--muted-2);font-size:12.5px;cursor:pointer;font-weight:650}
.tclear:hover{color:var(--danger)}
.tlines{display:flex;flex-direction:column;gap:8px;margin:12px 0;max-height:34vh;overflow:auto}
.tempty{display:flex;flex-direction:column;align-items:center;justify-content:center;text-align:center;color:var(--muted-2);font-size:13px;gap:10px;padding:34px 16px;border:1px dashed var(--border);border-radius:14px;margin:12px 0}
.tempty svg{width:34px;height:34px;opacity:.55}
.sheetscrim{position:fixed;inset:0;background:rgba(6,8,14,.55);backdrop-filter:blur(3px);z-index:55;display:flex;justify-content:flex-end}
.sheet{width:100%;max-width:420px;height:100%;background:var(--surface);border-left:1px solid var(--border);padding:22px;overflow:auto;animation:slidein .22s ease;display:flex;flex-direction:column;gap:12px}
@keyframes slidein{from{transform:translateX(24px);opacity:0}to{transform:none;opacity:1}}
.qebtns{display:grid;grid-template-columns:1fr 1fr 1fr;gap:10px}
.qebtn{padding:14px 10px;border-radius:13px;border:1px solid var(--border);background:var(--surface-2);color:var(--text);font-weight:700;font-size:13px;cursor:pointer}
.qebtn:hover{background:var(--surface-3)}
.qebtn.on{border-color:var(--accent);color:var(--accent)}
.pcard{position:relative;overflow:hidden}
.ribbon{position:absolute;top:15px;right:-32px;transform:rotate(45deg);background:linear-gradient(135deg,var(--accent),var(--accent-2));color:#fff;font-size:10px;font-weight:800;letter-spacing:.07em;padding:4px 36px;box-shadow:0 4px 10px -4px var(--accent);z-index:2}
.addbtn.out{background:var(--surface-3);color:var(--muted-2);cursor:not-allowed}
.pbadge.stk.out{color:var(--muted-2)}
.ticket .totrow.grand{background:var(--surface-2);border:1px solid var(--border-soft);border-radius:14px;padding:14px 16px;margin-top:10px}
.xferinfo{background:rgba(14,165,181,.08);border:1px solid var(--border-soft);border-radius:16px;padding:16px 18px;margin-bottom:14px}
.xferinfo strong{font-size:15px}
.searchres{margin-top:8px;display:flex;flex-direction:column;gap:4px;border:1px solid var(--border-soft);border-radius:12px;padding:6px;background:var(--surface);box-shadow:0 12px 30px -18px rgba(20,30,70,.3)}
.sres{display:flex;align-items:center;justify-content:space-between;gap:10px;text-align:left;background:transparent;border:none;padding:9px 11px;border-radius:9px;cursor:pointer;font-size:13.5px;color:var(--text);font-family:var(--font-ui)}
.sres:hover{background:var(--surface-2)}
.chk{display:flex;align-items:center;gap:10px;font-size:13.5px;font-weight:600;margin-top:16px;cursor:pointer}
.chk input{width:18px;height:18px;accent-color:var(--accent);cursor:pointer}
.modgrid{display:grid;grid-template-columns:repeat(auto-fill,minmax(290px,1fr));gap:16px}
.modcard{text-align:left;background:var(--surface);border:1px solid var(--border-soft);border-radius:18px;padding:20px 22px;cursor:pointer;transition:.15s;display:flex;flex-direction:column;gap:10px}
.modcard:hover{border-color:var(--accent);box-shadow:0 16px 40px -26px var(--accent);transform:translateY(-2px)}
.modtop{display:flex;align-items:center;gap:11px}
.modi{width:38px;height:38px;border-radius:11px;display:grid;place-items:center;background:linear-gradient(135deg,var(--accent),var(--accent-2));color:#fff;flex-shrink:0}
.modi svg{width:19px;height:19px}
.modt{font-size:17px;font-weight:750;letter-spacing:-.01em}
.modd{font-size:13.5px;color:var(--muted);line-height:1.55}
.repctrl{display:flex;flex-wrap:wrap;gap:14px;align-items:flex-end;background:var(--surface);border:1px solid var(--border-soft);border-radius:16px;padding:14px 16px;margin-bottom:14px}
.segbtns{display:flex;gap:6px;flex-wrap:wrap}
.seg{padding:9px 15px;border-radius:10px;border:1px solid var(--border);background:var(--surface);color:var(--muted);font-size:13px;font-weight:650;cursor:pointer;transition:.15s}
.seg:hover{color:var(--text);background:var(--surface-2)}
.seg.on{background:linear-gradient(135deg,var(--accent),var(--accent-2));color:#fff;border-color:transparent}
.expense-page{max-width:1180px;margin:0 auto}
.expense-head-actions{display:flex;gap:8px;flex-wrap:wrap}
.expense-head-actions .btn{height:38px}
.expense-tabs{display:flex;gap:4px;padding:4px;background:var(--surface-2);border:1px solid var(--border-soft);border-radius:12px;width:max-content;max-width:100%;margin-bottom:12px}
.expense-tab{height:36px;padding:0 15px;border:0;border-radius:8px;background:transparent;color:var(--muted);font:650 13px var(--font-ui);cursor:pointer;display:flex;align-items:center;gap:7px;white-space:nowrap}
.expense-tab:hover{color:var(--text)}
.expense-tab.on{background:var(--surface);color:var(--text);box-shadow:0 1px 3px rgba(0,0,0,.1)}
.expense-tab .count{min-width:19px;height:19px;padding:0 5px;border-radius:999px;background:rgba(230,67,104,.14);color:var(--danger);display:grid;place-items:center;font:750 10px var(--font-mono)}
.expense-filterbar{display:flex;align-items:center;gap:10px;flex-wrap:wrap;padding:10px 0;border-top:1px solid var(--border-soft);border-bottom:1px solid var(--border-soft);margin-bottom:12px}
.expense-filterbar .segbtns{gap:4px}
.expense-filterbar .seg{padding:7px 11px;border-radius:8px}
.expense-filterbar .select{width:165px;height:36px;margin-left:auto}
.expense-custom-range{display:flex;align-items:center;gap:7px}
.expense-custom-range .input{width:142px;height:36px}
.expense-summary{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));border-top:1px solid var(--border-soft);border-bottom:1px solid var(--border-soft);margin-bottom:14px}
.expense-summary>div{padding:11px 14px;border-right:1px solid var(--border-soft)}
.expense-summary>div:last-child{border-right:0}
.expense-summary span{display:block;color:var(--muted-2);font-size:10.5px;font-weight:750;text-transform:uppercase}
.expense-summary b{display:block;margin-top:3px;font:750 18px var(--font-mono)}
.expense-summary small{display:block;margin-top:2px;color:var(--muted);font-size:11px}
.expense-inline-tool{background:var(--surface);border:1px solid var(--border);border-radius:12px;padding:14px;margin-bottom:14px}
.expense-tool-head{display:flex;align-items:center;justify-content:space-between;gap:12px;margin-bottom:12px}
.expense-tool-head .sideh{margin:0}
.expense-entry-grid{display:grid;grid-template-columns:1.1fr 1fr .8fr 1.4fr auto;gap:9px;align-items:end}
.expense-entry-grid .btn{height:42px}
.expense-category-form{display:grid;grid-template-columns:minmax(180px,1fr) minmax(150px,.7fr) auto;gap:9px;align-items:end;margin-bottom:10px}
.expense-category-list{max-height:340px;overflow:auto}
.expense-category-list .row{padding:9px 10px;gap:8px}
.expense-category-list .btn{padding:0 9px}
.expense-category-list .category-order{display:flex;gap:4px}
.expense-overview-grid{display:grid;grid-template-columns:1fr 1fr;gap:12px}
.expense-overview-grid .dcard{padding:14px}
.expense-more-analysis{margin-top:12px;border-top:1px solid var(--border-soft)}
.expense-more-analysis>summary{padding:11px 2px;cursor:pointer;list-style:none;color:var(--muted);font-size:12.5px;font-weight:700;display:flex;align-items:center;justify-content:space-between}
.expense-more-analysis>summary::-webkit-details-marker{display:none}
.expense-more-analysis[open]>summary svg{transform:rotate(180deg)}
.expense-queue{display:flex;flex-direction:column;gap:7px}
.expense-queue .row,.expense-history-list .row{border:1px solid var(--border-soft);padding:10px 12px}
.expense-queue .row{align-items:flex-start}
.expense-queue-actions{display:flex;gap:6px;align-items:center}
.expense-reject-form{display:grid;grid-template-columns:minmax(180px,1fr) auto auto;gap:7px;margin-top:8px}
.expense-reject-form .input{height:36px}
.expense-history-list{display:flex;flex-direction:column;gap:7px}
.expense-history-status{display:inline-flex;margin-left:7px}
.document-file{border-top:1px solid var(--border-soft);border-bottom:1px solid var(--border-soft);margin-top:12px}
.document-file-head{width:100%;min-height:52px;padding:9px 4px;border:0;background:transparent;color:var(--text);display:flex;align-items:center;gap:10px;text-align:left;cursor:pointer;font-family:var(--font-ui)}
.document-file-head>svg:first-child{width:19px;height:19px;color:var(--accent);flex:0 0 auto}
.document-file-head .meta{flex:1;min-width:0}
.document-file-head .nm{font-size:13.5px;font-weight:750}
.document-file-head .mt2{font-size:11.5px;color:var(--muted)}
.document-file-count{min-width:28px;height:24px;padding:0 7px;border-radius:999px;background:var(--surface-2);color:var(--muted);display:grid;place-items:center;font:750 11px var(--font-mono)}
.document-file-head .chevron{width:17px;height:17px;color:var(--muted);transition:transform .15s}
.document-file.open .document-file-head .chevron{transform:rotate(180deg)}
.document-file-body{padding:4px 0 10px}
.document-file-body>.list{max-height:460px;overflow:auto}
@media (max-width:900px){.expense-entry-grid{grid-template-columns:1fr 1fr}.expense-entry-grid .btn{width:100%}.expense-overview-grid{grid-template-columns:1fr}}
@media (max-width:680px){.expense-head-actions{width:100%}.expense-head-actions .btn{flex:1}.expense-tabs{width:100%;overflow-x:auto}.expense-tab{flex:1;justify-content:center}.expense-filterbar{align-items:stretch}.expense-filterbar .segbtns{width:100%;overflow-x:auto;flex-wrap:nowrap}.expense-filterbar .seg{white-space:nowrap}.expense-filterbar .select{width:100%;margin-left:0}.expense-custom-range{width:100%}.expense-custom-range .input{min-width:0;width:100%}.expense-summary>div{padding:10px 8px}.expense-summary b{font-size:15px}.expense-summary small{font-size:10px}.expense-entry-grid,.expense-category-form{grid-template-columns:1fr}.expense-category-list .row{align-items:flex-start}.expense-category-list .category-order{margin-left:44px}.expense-queue-actions{width:100%;margin-left:44px}.expense-queue-actions .btn{flex:1}.expense-reject-form{grid-template-columns:1fr}.expense-history-list .row>.pill{margin-left:44px}.expense-tool-head{align-items:flex-start}}
.expbtns{display:flex;gap:8px;margin-left:auto;flex-wrap:wrap;align-items:center}
.subtabs{display:flex;gap:8px;flex-wrap:wrap;margin-bottom:18px}
.invwrap{max-width:720px;margin:0 auto;display:flex;flex-direction:column;gap:14px}
.invwrap .wshead{text-align:center}
.invactions{display:flex;gap:10px;justify-content:center;flex-wrap:wrap}
.cfilter{display:flex;gap:8px;align-items:center;flex-wrap:wrap;margin-top:18px;margin-bottom:12px}
.cfilthint{margin-left:auto;font-size:12.5px;color:var(--muted-2);font-weight:600}
.cgrid2{display:flex;flex-direction:column;gap:10px}
.ccard{display:flex;align-items:center;gap:16px;background:var(--surface);border:1px solid var(--border-soft);border-radius:16px;padding:14px 18px;flex-wrap:wrap;transition:.15s}
.ccard:hover{border-color:var(--accent);box-shadow:0 14px 34px -26px var(--accent)}
.ccard .ci{flex:1;min-width:210px}
.ccard .cn{font-weight:750;font-size:14.5px;letter-spacing:-.01em}
.ccard .cmeta{font-size:12px;color:var(--muted-2);margin-top:2px}
.ccard .cstats{display:flex;gap:14px;margin-top:9px;font-size:12.5px;color:var(--muted);flex-wrap:wrap;align-items:center}
.ccard .cstats b{color:var(--text);font-weight:750;font-family:var(--font-mono)}
.cright{display:flex;align-items:center;gap:14px;flex-wrap:wrap}
.stepper{display:flex;align-items:center;border:1px solid var(--border);border-radius:13px;overflow:hidden;background:var(--surface)}
.stepbtn{width:44px;height:46px;border:none;background:var(--surface-2);color:var(--text);font-size:22px;font-weight:700;cursor:pointer;display:grid;place-items:center;line-height:1;transition:.12s}
.stepbtn:hover{background:var(--surface-3);color:var(--accent)}
.stepbtn:active{background:var(--accent);color:#fff}
.stepin{width:66px;height:46px;border:none;border-left:1px solid var(--border);border-right:1px solid var(--border);text-align:center;font-family:var(--font-mono);font-size:17px;font-weight:750;background:var(--surface);color:var(--text);outline:none}
.cvar{font-size:12.5px;font-weight:700;min-width:78px;text-align:center;padding:7px 12px;border-radius:999px}
.cvar.up{background:rgba(22,163,107,.13);color:var(--ok)}
.cvar.down{background:rgba(230,67,104,.13);color:var(--danger)}
.cvar.zero{background:var(--surface-2);color:var(--muted)}
.rowsel{border-color:var(--accent)!important;box-shadow:0 0 0 3px rgba(14,165,181,.14)}
.docview{border:1px solid var(--border-soft);border-radius:14px;padding:18px 20px;background:var(--surface-2)}
.docvh{font-weight:750;font-size:16px;margin-bottom:12px}
.docvkv{display:flex;flex-direction:column;gap:0}
.kv{display:flex;justify-content:space-between;gap:14px;font-size:13.5px;border-bottom:1px dashed var(--border);padding:8px 0}
.kv:last-child{border-bottom:none}
.kv .k{color:var(--muted)}
.kv .v{font-weight:650;text-align:right}
.airesult{white-space:pre-wrap;font-size:14px;line-height:1.65;color:var(--text);background:var(--surface-2);border:1px solid var(--border-soft);border-radius:14px;padding:18px 20px;margin-top:4px}
.askex{display:flex;gap:8px;flex-wrap:wrap;justify-content:center}
.chatwrap{display:flex;flex-direction:column;gap:12px;margin-bottom:14px}
.bubble{border-radius:16px;padding:13px 16px;max-width:86%}
.bubble.user{align-self:flex-end;background:linear-gradient(135deg,var(--accent),var(--accent-2));color:#fff}
.bubble.assistant{align-self:flex-start;background:var(--surface);border:1px solid var(--border-soft);width:86%}
.bubble .brole{font-size:10.5px;letter-spacing:.08em;text-transform:uppercase;font-weight:700;opacity:.7;margin-bottom:4px}
.bubble .btext{white-space:pre-wrap;font-size:14px;line-height:1.6}
.bubble .bacts{display:flex;gap:6px;margin-top:10px;flex-wrap:wrap}
.askbar{display:flex;gap:10px;align-items:stretch;flex-wrap:wrap;position:sticky;bottom:0;background:var(--bg);padding-top:6px}
.askbar .input{flex:1;min-width:260px;height:68px;font-size:17px;border-radius:16px;padding:0 20px}
.askbar .input:focus{border-color:var(--accent);box-shadow:0 0 0 4px rgba(14,165,181,.16)}
.askbar .btn{height:68px;padding:0 28px;font-size:16px}
@media (max-width:620px){.askbar .input{min-width:100%}.askbar .btn{width:100%}}
.eodmodal{max-width:880px}
.eodgrid{display:grid;grid-template-columns:repeat(4,1fr);gap:10px;margin-bottom:14px}
.eodcell{background:var(--surface-2);border:1px solid var(--border-soft);border-radius:12px;padding:11px 13px}
.eodcell .sl{font-size:11px;letter-spacing:.04em;color:var(--muted-2);font-weight:600}
.eodcell .ev{font-size:17px;font-weight:750;margin-top:3px}
.shiftbar{display:flex;align-items:center;justify-content:space-between;gap:12px;background:rgba(14,165,181,.08);border:1px solid var(--border-soft);border-radius:14px;padding:14px 16px;margin-bottom:14px}
.shiftbar .sl{font-size:11px;letter-spacing:.06em;text-transform:uppercase;color:var(--muted-2);font-weight:700}
.eodth{display:flex;align-items:center;gap:10px;background:linear-gradient(135deg,var(--accent),var(--accent-2));color:#fff;border-radius:11px;padding:11px 16px;font-weight:750;font-size:13px;margin-top:4px}
.eodth span:first-child{flex:1}
.eodth span:not(:first-child){width:120px;text-align:right}
.eodrows{display:flex;flex-direction:column}
.eodrow{display:flex;align-items:center;gap:10px;padding:11px 16px;border-bottom:1px solid var(--border-soft);font-size:13.5px}
.eodrow span:first-child{flex:1;font-weight:600}
.eodrow span:not(:first-child){width:120px;text-align:right}
.eodtot{display:flex;align-items:center;gap:10px;background:var(--surface-2);border-radius:11px;padding:12px 16px;font-weight:750;margin-top:2px}
.eodtot span:first-child{flex:1}
.eodtot span:not(:first-child){width:120px;text-align:right}
.eodtot .sub{width:auto;color:var(--muted)}
@media (max-width:760px){.eodgrid{grid-template-columns:repeat(2,1fr)}}
.fade{animation:fade .25s ease}
@keyframes fade{from{opacity:0;transform:translateY(6px)}to{opacity:1;transform:none}}
@media (prefers-reduced-motion:reduce){.vpos *{animation:none!important;transition:none!important}}
@media (max-width:760px){
  .vpos{padding:12px}
  .vpos.app .topbar{display:grid;grid-template-columns:minmax(0,1fr) auto auto;align-items:center;gap:8px;padding:calc(10px + env(safe-area-inset-top)) calc(10px + env(safe-area-inset-right)) 10px calc(10px + env(safe-area-inset-left))}
  .vpos.app .topbar .right{display:contents}
  .vpos.app .topbar .brand{grid-column:1;grid-row:1;justify-self:start;min-width:0}
  .vpos.app .topbar .envbadge{grid-column:2;grid-row:1;justify-self:end;height:32px;padding:0 10px}
  .vpos.app .topbar .usermenu-wrap{grid-column:3;grid-row:1;justify-self:end}
  .vpos.app .topbar .branchsel{grid-column:1 / 3;grid-row:2;width:100%;min-width:0}
  .vpos.app .topbar .branchsel select,.vpos.app .topbar .branchsel span{min-width:0;max-width:100%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
  .vpos.app .topbar .branchsel select{width:100%}
  .vpos.app .topbar .who{grid-column:3;grid-row:2;max-width:116px;min-width:0}
  .vpos.app .topbar .who span{max-width:100%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
  .vpos.app .env-banner{padding:6px calc(10px + env(safe-area-inset-right)) 6px calc(10px + env(safe-area-inset-left));font-size:9.5px;line-height:1.45;letter-spacing:.04em}
  .scrim{place-items:start center;padding:calc(10px + env(safe-area-inset-top)) calc(10px + env(safe-area-inset-right)) calc(10px + env(safe-area-inset-bottom)) calc(10px + env(safe-area-inset-left))}
  .modal{max-height:calc(100dvh - 20px - env(safe-area-inset-top) - env(safe-area-inset-bottom))}
  .admincontent .page-h{align-items:stretch;gap:10px;margin-bottom:12px}
  .admincontent .page-h > div:first-child{display:block;flex:1 1 100%;min-width:0}
  .admincontent .page-h > div:last-child:not(:first-child){width:100%;display:flex;gap:8px;flex-wrap:wrap}
  .admincontent .page-h .btn{flex:1 1 136px;min-height:42px}
  .admincontent .kpis,.admincontent .stats{grid-template-columns:1fr;gap:10px}
  .admincontent .kpi,.admincontent .stat{border-radius:14px;padding:14px}
  .admincontent .grid2,.admincontent .grid3{grid-template-columns:1fr}
  .admincontent .addpanel{padding:14px;border-radius:14px;margin-bottom:12px}
  .admincontent .ptools{align-items:stretch;gap:8px}
  .admincontent .ptools .possearch{min-width:100%;width:100%;height:44px}
  .admincontent .ptools .select{width:100%!important;min-width:100%}
  .admincontent .ptblwrap{max-height:none;border-radius:12px}
  .admincontent .ptbl{min-width:760px}
  .admincontent .row{align-items:flex-start;flex-wrap:wrap;padding:11px;border-radius:12px}
  .admincontent .row .meta{flex:1 1 calc(100% - 58px)}
  .admincontent .pill,.admincontent .smdel{min-height:38px}
  .admincontent .wtabs{gap:7px;margin-bottom:14px;overflow-x:auto;flex-wrap:nowrap;padding-bottom:3px}
  .admincontent .wtab{flex:0 0 auto}
  .admincontent .branchwrap{gap:12px}
  .admincontent .brow{align-items:flex-start;flex-wrap:wrap}
}
@media (max-width:520px){
  .vpos{padding:8px}
  .vpos.app .topbar .who{display:none}
  .vpos.app .topbar .branchsel{grid-column:1 / -1}
  .vpos.app .topbar .brand.sm .mark svg{width:34px;height:34px}
  .vpos.app .topbar .brand.sm .name{font-size:17px;white-space:nowrap}
  .vpos.app .topbar .brand{gap:8px}
  .admincontent .cashtiles{grid-template-columns:repeat(2,minmax(0,1fr));gap:8px}
  .admincontent .ctile{min-width:0;min-height:96px;padding:11px 12px;border-radius:13px;gap:6px}
  .admincontent .ctile .ic{width:30px;height:30px;border-radius:9px}
  .admincontent .ctile .ic svg{width:16px;height:16px}
  .admincontent .ctile .cl{font-size:10.5px}
  .admincontent .ctile .cv{font-size:18px}
  .admincontent .ctile .cs{font-size:10.5px}
  .adminwrap{gap:10px}
  .navside,.navside.collapsed{max-height:none;padding:7px}
  .navitem,.navitem.main{min-height:42px;font-size:13px}
  .navsec{min-height:38px}
  .admincontent .title{font-size:20px!important}
  .admincontent .sub{font-size:13px}
  .admincontent .input,.admincontent .select{height:44px;font-size:16px}
  .admincontent textarea.input{height:auto;min-height:92px}
  .admincontent .btn{min-height:44px}
  .admincontent .btn.sm{min-height:40px}
  .admincontent .row-add{height:44px}
  .admincontent .avatar{width:36px;height:36px;border-radius:10px}
  .admincontent .ptbl{font-size:12px;min-width:700px}
  .admincontent .ptbl thead th,.admincontent .ptbl tbody td{padding:9px 10px}
  .modal{max-width:min(430px,calc(100vw - 20px));padding:18px;border-radius:16px}
}
@media (max-width:340px){.admincontent .cashtiles{grid-template-columns:1fr}}
@media (max-width:760px){.regwrap{grid-template-columns:1fr;height:auto;overflow:visible}.side,.catcol,.cart{height:auto;overflow:visible}.kpis{grid-template-columns:1fr}.filters{grid-template-columns:1fr}.catscroll{flex:none;max-height:none;overflow:visible}.cartbox{flex:none;max-height:360px}}
@media (max-width:430px){.grid{grid-template-columns:repeat(2,1fr)}}
@media (max-width:820px){.cmain{grid-template-columns:1fr}.ticket{position:static}}
@media (max-width:560px){.grid2,.grid3{grid-template-columns:1fr}.cathead{flex-direction:column;align-items:stretch}}
`;

/* ================================================================== */
/*  Logo + Brand                                                      */
/* ================================================================== */
function Logo({ size = 40 }) {
  return (
    <svg width={size} height={size} viewBox="0 0 48 48" fill="none" aria-hidden="true">
      <defs>
        <linearGradient id="vMarkBg" x1="7" y1="6" x2="41" y2="42" gradientUnits="userSpaceOnUse"><stop offset="0" stopColor="#2DD4DE" /><stop offset=".55" stopColor="#6E86FF" /><stop offset="1" stopColor="#A66BFF" /></linearGradient>
        <linearGradient id="vMarkStroke" x1="13" y1="13" x2="35" y2="35" gradientUnits="userSpaceOnUse"><stop offset="0" stopColor="#FFFFFF" /><stop offset="1" stopColor="#DFFBFF" /></linearGradient>
        <filter id="vMarkGlow" x="-45%" y="-45%" width="190%" height="190%"><feGaussianBlur stdDeviation="2.4" result="b" /><feColorMatrix in="b" type="matrix" values="0 0 0 0 0.18 0 0 0 0 0.84 0 0 0 0 0.87 0 0 0 .55 0" /><feMerge><feMergeNode /><feMergeNode in="SourceGraphic" /></feMerge></filter>
      </defs>
      <rect x="5" y="5" width="38" height="38" rx="14" fill="url(#vMarkBg)" filter="url(#vMarkGlow)" />
      <path d="M14 14.5L23.3 34L34 14.5" stroke="url(#vMarkStroke)" strokeWidth="6.4" strokeLinecap="round" strokeLinejoin="round" />
      <path d="M14 14.5L23.3 34L34 14.5" stroke="#071018" strokeOpacity=".14" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}
function Brand({ sm }) { return (<div className={"brand" + (sm ? " sm" : "")}><div className="mark"><Logo size={sm ? 40 : 52} /></div><div className="name">Vision<span> POS</span></div></div>); }
function normalizeEnvironmentMode(mode) {
  return String(mode || "test").trim().toLowerCase() === "live" ? "live" : "test";
}
function normalizeEnvironment(value) {
  const raw = typeof value === "object" && value !== null
    ? (value.mode || value.environment || value.label)
    : value;
  const mode = String(raw || "test").trim().toLowerCase().includes("live") ? "live" : "test";
  return {
    ...(typeof value === "object" && value !== null ? value : {}),
    mode,
    label: mode === "live" ? "LIVE MODE" : "TEST MODE",
  };
}
function EnvironmentBadge({ mode, compact }) {
  const env = normalizeEnvironmentMode(mode);
  return <div className={"envbadge " + env + (compact ? " compact" : "")}><span className="envdot" />{env === "live" ? "LIVE MODE" : "TEST MODE"}</div>;
}

/* ================================================================== */
/*  App                                                               */
/* ================================================================== */
export default function VisionPOS() {
  const [data, setData] = useState(null);
  const dataRef = useRef(null);
  const [view, setView] = useState("adminLogin");
  const [session, setSession] = useState(null);
  const [terminalLoginAvailable, setTerminalLoginAvailable] = useState(false);
  const [online, setOnline] = useState(typeof navigator !== "undefined" ? navigator.onLine : true);
  const [syncing, setSyncing] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const [maintenance, setMaintenance] = useState(null);
  const [environmentInfo, setEnvironmentInfo] = useState(null);
  const didInitialSync = useRef(false);
  const syncRequestRef = useRef(false);
  const cloudRecoveryAttemptRef = useRef("");
  const lastActivityAtRef = useRef(0);
  useEffect(() => { dataRef.current = data; }, [data]);
  useEffect(() => { (async () => {
    const hasRegisteredTerminal = await hasDesktopTerminalAuth();
    setTerminalLoginAvailable(hasRegisteredTerminal);
    const resetToken = (() => { try { return new URLSearchParams(window.location.search).get("resetToken") || ""; } catch (_) { return ""; } })();
    let env = null;
    try {
      env = await environmentPublic();
      setEnvironmentInfo(env);
    } catch (_) {}
    let savedSession = await loadSessionState();
    const restoredAt = now();
    const savedActivityAt = Math.min(restoredAt, Number(savedSession?.lastActivityAt || savedSession?.ts || 0));
    if (savedSession?.sessionToken && (!savedActivityAt || restoredAt - savedActivityAt >= AUTO_LOGOUT_MS)) {
      logoutSessionToken(savedSession.sessionToken, { keepalive: true });
      await clearSessionState();
      savedSession = null;
    }
    if (savedSession?.sessionToken) activeSessionToken = savedSession.sessionToken;
    const loaded = await loadEnvironmentAwareData(env);
    saveData(loaded);
    if (resetToken) {
      await clearSessionState();
      setSession(null);
      setView("adminLogin");
      setData(loaded);
      return;
    }
    if (savedSession?.sessionToken) {
      try {
        const active = await cloudSession(savedSession.sessionToken);
        const restored = accountToSession(active.account, loaded.settings.activeBranchId);
        if (restored?.status === "active") {
          if (restored.kind === "cashier" && !hasRegisteredTerminal) {
            await clearSessionState();
            setView("adminLogin");
            setData(loaded);
            return;
          }
          lastActivityAtRef.current = savedActivityAt;
          setSession({ ...restored, sessionToken: savedSession.sessionToken });
          setView(savedSession.view === "register" && restored.kind === "cashier" ? "register" : "admin");
        } else {
          activeSessionToken = "";
          await clearSessionState();
        }
      } catch (_) {
        activeSessionToken = "";
        await clearSessionState();
      }
    }
    setData(loaded);
  })(); }, []);
  const signInSession = (nextView, emp = null, sessionToken = "") => {
    const signedIn = emp || null;
    const signedInAt = now();
    activeSessionToken = sessionToken || signedIn?.sessionToken || "";
    lastActivityAtRef.current = signedInAt;
    setSession(signedIn);
    setView(nextView);
    saveSessionState({ view: nextView, employeeId: signedIn?.id || null, sessionToken: sessionToken || signedIn?.sessionToken || "", ts: signedInAt, lastActivityAt: signedInAt });
  };
  const signOutSession = (opts = {}) => {
    const options = opts?.type ? {} : opts;
    const token = options.sessionToken || session?.sessionToken || storedSessionTokenSync();
    logoutSessionToken(token, { keepalive: Boolean(options.keepalive) });
    lastActivityAtRef.current = 0;
    setMenuOpen(false);
    setSession(null);
    setView(terminalLoginAvailable ? "pin" : "adminLogin");
    clearSessionState();
  };
  useEffect(() => {
    if (!session) return;
    let idleTimer = null;
    let endingSession = false;
    let lastScheduledAt = 0;
    let lastPersistedAt = lastActivityAtRef.current;
    const expireSession = (reason) => {
      if (endingSession) return;
      endingSession = true;
      clearTimeout(idleTimer);
      signOutSession({ reason });
    };
    const persistActivity = (activityAt) => {
      if (endingSession) return;
      const stored = storedSessionStateSync() || {};
      saveSessionState({
        ...stored,
        view: stored.view || view,
        employeeId: stored.employeeId || session.id || null,
        sessionToken: stored.sessionToken || session.sessionToken || "",
        ts: Number(stored.ts || activityAt),
        lastActivityAt: activityAt,
      });
    };
    const scheduleIdleCheck = () => {
      if (endingSession) return;
      clearTimeout(idleTimer);
      const elapsed = now() - lastActivityAtRef.current;
      if (elapsed >= AUTO_LOGOUT_MS) {
        expireSession("idle");
        return;
      }
      idleTimer = setTimeout(() => checkIdle(), AUTO_LOGOUT_MS - elapsed);
    };
    const checkIdle = () => {
      if (endingSession) return;
      if (!lastActivityAtRef.current || now() - lastActivityAtRef.current >= AUTO_LOGOUT_MS) {
        expireSession("idle");
        return;
      }
      scheduleIdleCheck();
    };
    const recordActivity = (event) => {
      if (endingSession) return;
      if (event?.isTrusted === false) return;
      const activityAt = now();
      if (lastActivityAtRef.current && activityAt - lastActivityAtRef.current >= AUTO_LOGOUT_MS) {
        expireSession("idle");
        return;
      }
      lastActivityAtRef.current = activityAt;
      if (activityAt - lastPersistedAt >= SESSION_ACTIVITY_WRITE_MS) {
        lastPersistedAt = activityAt;
        persistActivity(activityAt);
      }
      if (activityAt - lastScheduledAt >= 1000) {
        lastScheduledAt = activityAt;
        scheduleIdleCheck();
      }
    };
    const verifyActiveSession = () => {
      if (!document.hidden) checkIdle();
    };
    const syncSessionActivity = (event) => {
      if (endingSession) return;
      if (event.key !== SESSION_KEY) return;
      if (!event.newValue) {
        expireSession("session_cleared");
        return;
      }
      try {
        const stored = JSON.parse(event.newValue);
        if (session.sessionToken && stored.sessionToken !== session.sessionToken) {
          expireSession("session_changed");
          return;
        }
        const sharedActivityAt = Number(stored.lastActivityAt || stored.ts || 0);
        if (sharedActivityAt > lastActivityAtRef.current) {
          lastActivityAtRef.current = Math.min(now(), sharedActivityAt);
          scheduleIdleCheck();
        }
      } catch (_) {}
    };
    const activityEvents = ["click", "keydown", "mousemove", "pointerdown", "scroll", "touchstart", "wheel"];
    activityEvents.forEach((name) => window.addEventListener(name, recordActivity, { passive: true }));
    window.addEventListener("focus", verifyActiveSession);
    window.addEventListener("pageshow", verifyActiveSession);
    window.addEventListener("storage", syncSessionActivity);
    document.addEventListener("visibilitychange", verifyActiveSession);
    if (!lastActivityAtRef.current) lastActivityAtRef.current = now();
    checkIdle();
    return () => {
      clearTimeout(idleTimer);
      activityEvents.forEach((name) => window.removeEventListener(name, recordActivity));
      window.removeEventListener("focus", verifyActiveSession);
      window.removeEventListener("pageshow", verifyActiveSession);
      window.removeEventListener("storage", syncSessionActivity);
      document.removeEventListener("visibilitychange", verifyActiveSession);
    };
  }, [session?.id, session?.sessionToken]); // eslint-disable-line
  useEffect(() => {
    if (!session) return;
    const logoutBeforeClose = () => {
      const token = session?.sessionToken || storedSessionTokenSync();
      logoutSessionToken(token, { keepalive: true });
      clearSessionStateSync();
    };
    window.addEventListener("visionpos:desktop-closing", logoutBeforeClose);
    return () => {
      window.removeEventListener("visionpos:desktop-closing", logoutBeforeClose);
    };
  }, [session?.id, session?.sessionToken]);
  const update = (fn) => setData((prev) => {
    const next = { ...fn(prev), _sync: prev?._sync || { outboxLength: 0, cursor: 0 } };
    saveData(next);
    enqueueChanges(prev, next).then((status) => {
      setData((cur) => cur ? { ...cur, _sync: { ...status, error: "" } } : cur);
      syncRequestRef.current = true;
      if (typeof navigator === "undefined" || navigator.onLine) setTimeout(runSync, 250);
    });
    return next;
  });
  const cleanReset = () => {
    const empty = { ...CLEAN_SETUP(), _sync: { outboxLength: 0, cursor: 0 } };
    saveOutbox([]); saveCursor(0); clearSessionState(); setData(empty); saveData(empty); setSession(null); setMenuOpen(false); setView("adminLogin");
  };
  const runSync = async (opts = {}) => {
    if (!navigator.onLine || (!opts.force && syncing) || !dataRef.current) return;
    syncRequestRef.current = false;
    setSyncing(true);
    try {
      const result = await runSyncClient(dataRef.current, opts);
      setData(result.data);
    } catch (error) {
      const message = String(error?.message || "");
      if (session && /(?:pull|push)_failed_(?:401|403)|invalid_or_missing_user_session|session_(?:expired|revoked)/i.test(message)) {
        signOutSession({ sessionToken: session.sessionToken });
        return;
      }
      setData((cur) => cur ? { ...cur, _sync: { ...(cur._sync || {}), error: error.message } } : cur);
    } finally {
      setSyncing(false);
    }
  };
  const recoverCloudData = async () => {
    if (!navigator.onLine || !dataRef.current) return;
    setSyncing(true);
    try {
      const recovered = await cloudBootstrapData({ ...dataRef.current, _sync: await syncStatus() }, { forceFullPull: true });
      setData(recovered);
    } catch (error) {
      setData((cur) => cur ? { ...cur, _sync: { ...(cur._sync || {}), error: error.message } } : cur);
    } finally {
      setSyncing(false);
    }
  };
  const refreshMaintenance = async () => setMaintenance(await maintenanceSnapshot(dataRef.current));
  const runMaintenance = async (mode = "light") => {
    const meta = await runMaintenanceService({ data: dataRef.current, mode, runSync });
    setMaintenance(await maintenanceSnapshot(dataRef.current || { _sync: meta }));
    return meta;
  };
  const refreshEnvironment = async (opts = {}) => {
    try {
      const env = opts.session ? await environmentGet() : await environmentPublic();
      setEnvironmentInfo(env);
      return env;
    } catch (error) {
      if (opts.throwOnError) throw error;
      return null;
    }
  };
  useEffect(() => {
    const goOn = () => { setOnline(true); setTimeout(runSync, 400); };
    const goOff = () => setOnline(false);
    const syncVisible = () => { if (!document.hidden && navigator.onLine) setTimeout(() => runSync({ force: true }), 150); };
    window.addEventListener("online", goOn); window.addEventListener("offline", goOff);
    window.addEventListener("focus", syncVisible);
    document.addEventListener("visibilitychange", syncVisible);
    return () => {
      window.removeEventListener("online", goOn); window.removeEventListener("offline", goOff);
      window.removeEventListener("focus", syncVisible);
      document.removeEventListener("visibilitychange", syncVisible);
    };
  }, []); // eslint-disable-line
  useEffect(() => {
    const id = setInterval(() => { if (navigator.onLine && !document.hidden) runSync(); }, REALTIME_SYNC_MS);
    return () => clearInterval(id);
  }, []); // eslint-disable-line
  useEffect(() => {
    if (!data) return;
    let stopped = false;
    let source = null;
    let reconnectTimer = null;
    let syncTimer = null;

    const scheduleSync = () => {
      if (stopped || !navigator.onLine) return;
      clearTimeout(syncTimer);
      syncTimer = setTimeout(() => runSync({ force: true, source: "realtime" }), 200);
    };

    const connect = async () => {
      if (stopped || !navigator.onLine || typeof EventSource === "undefined") return;
      try {
        const url = await syncStreamUrl(dataRef.current?.settings?.activeBranchId || null);
        if (stopped) return;
        source = new EventSource(url);
        source.addEventListener("connected", scheduleSync);
        source.addEventListener("sync", scheduleSync);
        source.onerror = () => {
          try { source?.close(); } catch (_) {}
          if (!stopped) reconnectTimer = setTimeout(connect, REALTIME_RECONNECT_MS);
        };
      } catch (_) {
        if (!stopped) reconnectTimer = setTimeout(connect, REALTIME_RECONNECT_MS);
      }
    };

    connect();
    return () => {
      stopped = true;
      clearTimeout(reconnectTimer);
      clearTimeout(syncTimer);
      try { source?.close(); } catch (_) {}
    };
  }, [!!data]); // eslint-disable-line
  useEffect(() => {
    if (!data || didInitialSync.current) return;
    didInitialSync.current = true;
    setTimeout(() => runMaintenance("startup"), 150);
    if (navigator.onLine) setTimeout(runSync, 300);
  }, [data]); // eslint-disable-line
  useEffect(() => {
    if (!data) return;
    refreshMaintenance();
    const light = setInterval(() => runMaintenance("light"), LIGHT_MAINTENANCE_MS);
    const deep = setInterval(() => runMaintenance("deep"), DEEP_MAINTENANCE_MS);
    return () => { clearInterval(light); clearInterval(deep); };
  }, [!!data]); // eslint-disable-line
  useEffect(() => {
    if (!data || syncing || !syncRequestRef.current || !navigator.onLine) return;
    const id = setTimeout(runSync, 300);
    return () => clearTimeout(id);
  }, [data, syncing]); // eslint-disable-line
  useEffect(() => {
    if (!data || view !== "register" || !session || syncing || !navigator.onLine) return;
    const branches = Array.isArray(data.branches) ? data.branches : [];
    const products = Array.isArray(data.products) ? data.products : [];
    const hasCashierBranch = branches.some((b) => b.id === session.branchId);
    if (hasCashierBranch && products.length) return;
    const recoveryKey = `register:${session.sessionToken || session.id || ""}`;
    if (cloudRecoveryAttemptRef.current === recoveryKey) return;
    cloudRecoveryAttemptRef.current = recoveryKey;
    const id = setTimeout(recoverCloudData, 500);
    return () => clearTimeout(id);
  }, [data, view, session?.id, session?.branchId, syncing]); // eslint-disable-line
  useEffect(() => {
    if (!data || view !== "admin" || !session || syncing || !navigator.onLine) return;
    const branches = Array.isArray(data.branches) ? data.branches : [];
    if (branches.length) return;
    const recoveryKey = `admin:${session.sessionToken || session.id || ""}`;
    if (cloudRecoveryAttemptRef.current === recoveryKey) return;
    cloudRecoveryAttemptRef.current = recoveryKey;
    const id = setTimeout(recoverCloudData, 500);
    return () => clearTimeout(id);
  }, [data, view, session?.sessionToken, syncing]); // eslint-disable-line
  if (!data) return (<div className="vpos"><style>{css}</style><div className="sub" style={{ color: "var(--muted-2)" }}>Loading…</div></div>);
  const routePath = typeof window !== "undefined" ? window.location.pathname.replace(/\/$/, "") || "/" : "/";
  if (routePath === "/downloads") return <DownloadsPage />;
  const pending = countPending(data);
  const themeCls = data.settings.theme === "dark" ? " theme-dark" : "";
  const syncError = pending > 0 ? (data?._sync?.error || "") : "";
  const syncState = !online || syncError ? "err" : syncing ? "syncing" : pending > 0 ? "pending" : "ok";
  const activeEnvironmentMode = normalizeEnvironmentMode(environmentInfo?.mode || data?.settings?.environmentMode || "test");
  const syncCls = syncState === "ok" ? "" : syncState === "err" ? " err" : " warn";
  const syncLabel = !online ? "Offline" : syncError ? "Sync error" : syncing ? "Syncing…" : pending > 0 ? pending + " to sync" : "Synced";
  const syncTitle = !online ? "Offline — changes are saved locally and will sync when you reconnect" : syncError ? "Sync failed: " + syncError : syncing ? "Syncing your data to the cloud…" : pending > 0 ? pending + " change(s) waiting to sync" : "All data synced to the cloud";

  if (view === "pin" || view === "adminLogin") {
    return (<div className={"vpos auth-root" + themeCls}><style>{css}</style><div className="authstage">
      {view === "pin" && terminalLoginAvailable && <PinScreen employees={data.employees} branchId={data.settings.activeBranchId} onAdmin={() => setView("adminLogin")} onSuccess={(e) => signInSession("register", e)} />}
      {(view === "adminLogin" || (view === "pin" && !terminalLoginAvailable)) && <AdminLogin onBack={terminalLoginAvailable ? () => setView("pin") : null} onSignedIn={(emp) => {
        signInSession("admin", emp || null);
        if (emp) update((d) => ({ ...d, settings: { ...d.settings, activeBranchId: emp.branchId || d.settings.activeBranchId } }));
        setTimeout(() => recoverCloudData(), 100);
      }} />}
    </div></div>);
  }
  const branches = Array.isArray(data.branches) ? data.branches : [];
  const adminBranch = branches.find((b) => b.id === data.settings.activeBranchId) || branches[0] || null;
  const cashierBranch = session ? (branches.find((b) => b.id === session.branchId) || adminBranch) : adminBranch;
  return (
    <div className={"vpos app" + themeCls + (view === "register" ? " cashier-app" : "")}><style>{css}</style>
      <div className="shell">
        <div className="topbar">
          <Brand sm />
          <div className="right">
            <EnvironmentBadge mode={activeEnvironmentMode} compact />
            {view === "register" ? (
              <div className="branchsel locked" title="This cashier is locked to one branch">
                <Building2 /><span>{cashierBranch?.name || session?.branchId || "Loading branch"}</span><Lock style={{ width: 13, height: 13, opacity: .7 }} />
              </div>
            ) : (
              <div className="branchsel"><Building2 />
                <select value={data.settings.activeBranchId || adminBranch?.id || ""} onChange={(e) => update((d) => ({ ...d, settings: { ...d.settings, activeBranchId: e.target.value } }))}>
                  {branches.map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}</select></div>
            )}
            {view === "register" && session && <div className="who"><span className="nm">{session.name}</span><span className="rl">{session.role}</span></div>}
            {view === "admin" && <div className="who"><span className="nm">{session ? session.name : "Admin"}</span><span className="rl">{session ? session.role : data.admin.email}</span></div>}
            <div className="usermenu-wrap">
              <button className={"iconbtn" + (menuOpen ? " on" : "")} title="Menu" onClick={() => setMenuOpen((o) => !o)}><MoreVertical /></button>
              {menuOpen && (<>
                <div className="menu-scrim" onClick={() => setMenuOpen(false)} />
                <div className="topmenu">
                  <div className="topmenu-row status" title={syncTitle}><span className={"led" + syncCls} />{syncLabel}{online && <button className="topmenu-mini" onClick={() => { runSync({ force: true }); }}>Sync now</button>}</div>
                  <button className="topmenu-row" onClick={() => update((d) => ({ ...d, settings: { ...d.settings, theme: d.settings.theme === "dark" ? "light" : "dark" } }))}>{data.settings.theme === "dark" ? <Sun /> : <Moon />}<span>{data.settings.theme === "dark" ? "Light mode" : "Dark mode"}</span></button>
                  <div className="topmenu-div" />
                  <button className="topmenu-row signout" onClick={signOutSession}><LogOut /><span>Sign out</span></button>
                </div>
              </>)}
            </div>
          </div>
        </div>
        {activeEnvironmentMode === "test" && (
          <div className="env-banner test">TEST MODE - sales, inventory changes, reports, terminals, and receipts are isolated from live operations.</div>
        )}
        <div className="content">
          {activeEnvironmentMode === "test" && <div className="env-watermark">TEST</div>}
          {view === "register" && (session && cashierBranch
            ? <Register data={data} update={update} online={online} employee={session} branch={cashierBranch} environmentMode={activeEnvironmentMode} />
            : <CloudDataRecovery title="Restoring cashier workspace" message="This device has a valid login, but its local branch catalog is missing. VISIONPOS is syncing from the cloud automatically; use Sync now if it takes more than a few seconds." syncError={syncError} onSync={recoverCloudData} onSignOut={signOutSession} />)}
          {view === "admin" && (adminBranch
            ? <AdminWorkspace data={data} update={update} branch={adminBranch} user={session ? session.name : "VISIONPOS Admin"} role={session ? session.role : "Admin"} rights={session ? (session.rights || []) : null} sessionToken={session?.sessionToken || ""} online={online} onCleanReset={cleanReset} maintenance={maintenance} onRefreshMaintenance={refreshMaintenance} onRunMaintenance={runMaintenance} environment={environmentInfo} onRefreshEnvironment={() => refreshEnvironment({ session: true })} />
            : <CloudDataRecovery title="Restoring admin workspace" message="Your login worked, but this device has not received any branch records from the cloud database yet. VISIONPOS is syncing automatically; if this remains here, the VPS database may not contain branch/product records." syncError={syncError} onSync={recoverCloudData} onSignOut={signOutSession} />)}
        </div>
      </div>
    </div>
  );
}

/* ================================================================== */
/*  PIN + Admin login                                                 */
/* ================================================================== */
function AuthShell({ children }) {
  const hr = new Date().getHours();
  const greet = hr < 12 ? "Good morning" : hr < 17 ? "Good afternoon" : "Good evening";
  return (
    <div className="login fade">
      <div className="loginbrand">
        <Brand />
        <div>
          <div className="lb-greet"><Sparkles /> {greet}</div>
          <h1 className="lb-h">Let's open<br />the till.</h1>
          <p className="lb-p">Your wines & spirits shop, running smoothly — quick sales, tight stock, and clean books across every branch. Sign in to get going.</p>
          <div className="lb-feats">
            <div className="lb-feat"><span className="fi"><Boxes /></span> Live stock across branches</div>
            <div className="lb-feat"><span className="fi"><FileText /></span> Invoices & credit control</div>
            <div className="lb-feat"><span className="fi"><BarChart3 /></span> Sales & profit at a glance</div>
          </div>
        </div>
        <div className="lb-foot">Wines &amp; Spirits · Point of Sale</div>
        <span className="blob b1" /><span className="blob b2" />
      </div>
      <div className="loginpanel">{children}</div>
    </div>
  );
}
function AuthHexLogo() {
  return (
    <div className="authhex">
      <svg viewBox="0 0 78 86" fill="none"><path d="M39 3 L72 22 L72 64 L39 83 L6 64 L6 22 Z" stroke="#2bb6c4" strokeWidth="3" fill="none" /></svg>
      <span className="hl">V</span>
    </div>
  );
}
function AuthShellV3({ children }) {
  return (
    <div className="authwrap">
      <div className="authlogo"><AuthHexLogo /><div className="authwm">visionary<b>pos</b></div></div>
      {children}
    </div>
  );
}
function DesktopDownloadSection() {
  const downloads = useDesktopDownloads();
  const windows = downloads.apps.find((app) => app.platform === "Windows");
  return (
    <section className="authdownload-card" aria-label="Cashier desktop application download">
      <div className="authdownload-icon"><MonitorDown /></div>
      <div className="authdownload-copy">
        <div className="authdownload-kicker">Need to setup a cashier terminal?</div>
        <div className="authdownload-title">Download the VisionPOS Desktop App</div>
        <div className="authdownload-version">Version {downloads.version}</div>
      </div>
      <a className={"authdownload-btn" + (!windows?.available ? " disabled" : "")} href={windows?.available ? windows.url : "/downloads"} aria-disabled={!windows?.available}>
        <Download /> Download for Windows
      </a>
      <a className="authdownload-more" href="/downloads">View all downloads and instructions</a>
    </section>
  );
}
function DownloadsPage() {
  const downloads = useDesktopDownloads();
  const configuredApps = downloads.apps;
  const notes = Array.isArray(downloads.releaseNotes) ? downloads.releaseNotes : String(downloads.releaseNotes || "").split("|").map((item) => item.trim()).filter(Boolean);
  return (
    <div className="downloads-page">
      <style>{css}</style>
      <header className="downloads-hero">
        <a className="downloads-back" href="/"><ArrowLeft /> Back to admin login</a>
        <div className="downloads-brand"><Logo size={54} /><div><div className="downloads-name">VisionPOS</div><div className="downloads-tag">Business in Focus</div></div></div>
        <div className="downloads-eyebrow">Cashier terminal applications</div>
        <h1>Downloads</h1>
        <p>Install only on approved shop computers. Each desktop app must be activated with a terminal code generated from the admin portal before it can access your POS.</p>
      </header>
      <main className="downloads-shell">
        <section className="downloads-panel">
          <div className="downloads-section-head">
            <div><h2>Available applications</h2><p>Version {downloads.version}</p></div>
          </div>
          <div className="download-app-grid">
            {configuredApps.map((app) => (
              <article className="download-app-card" key={app.platform}>
                <div className="download-app-icon"><MonitorDown /></div>
                <div className="download-app-meta">
                  <h3>{app.label}</h3>
                  <p>{app.available ? "Ready to download" : "Planned for a future release"}</p>
                  <p>{app.instructions}</p>
                </div>
                {app.available ? (
                  <a className="download-app-button" href={app.url}><Download /> Download</a>
                ) : (
                  <button className="download-app-button disabled" disabled>Coming soon</button>
                )}
              </article>
            ))}
          </div>
        </section>
        <section className="downloads-panel">
          <div className="downloads-section-head"><div><h2>Release notes</h2><p>Current desktop release</p></div></div>
          <div className="download-notes">
            {notes.map((note) => <div className="download-note" key={note}><Check /> {note}</div>)}
          </div>
        </section>
        <section className="downloads-panel">
          <div className="downloads-section-head"><div><h2>Installation instructions</h2><p>Secure terminal activation flow</p></div></div>
          <ol className="download-steps">
            <li>Download and install the VisionPOS Desktop App on the cashier computer.</li>
            <li>In the admin portal, generate a terminal activation code for the correct branch.</li>
            <li>Open the desktop app and enter the activation code on the first-run activation screen.</li>
            <li>After activation, cashiers sign in with their employee number and PIN. The web admin portal remains for admins and supervisors only.</li>
          </ol>
        </section>
        <section className="downloads-panel">
          <div className="downloads-section-head"><div><h2>Security notes</h2><p>Why download alone is not enough</p></div></div>
          <div className="download-notes">
            <div className="download-note"><ShieldCheck /> Each installation must be activated before login.</div>
            <div className="download-note"><Lock /> Terminal credentials are stored on the machine after activation.</div>
            <div className="download-note"><Building2 /> Admins can disable or revoke terminals from the admin portal.</div>
          </div>
        </section>
      </main>
    </div>
  );
}
function OnScreenKeyboard({ onKey, onBackspace, onEnter }) {
  const [shift, setShift] = useState(false);
  const [sym, setSym] = useState(false);
  const rows = sym
    ? [["1", "2", "3", "4", "5", "6", "7", "8", "9", "0"], ["@", "#", "$", "_", "&", "-", "+", "(", ")", "/"], ["*", "\"", "'", ":", ";", "!", "?", ".", ","]]
    : [["q", "w", "e", "r", "t", "y", "u", "i", "o", "p"], ["a", "s", "d", "f", "g", "h", "j", "k", "l"], ["z", "x", "c", "v", "b", "n", "m"]];
  const tap = (k) => { onKey(shift && !sym ? k.toUpperCase() : k); if (shift) setShift(false); };
  return (
    <div className="authkb authkb-full">
      <div className="authkrow">{rows[0].map((k) => <button key={k} className="authk" onClick={() => tap(k)}>{shift && !sym ? k.toUpperCase() : k}</button>)}<button className="authk fn" onClick={onBackspace} aria-label="Backspace"><Delete /></button></div>
      <div className="authkrow">{rows[1].map((k) => <button key={k} className="authk" onClick={() => tap(k)}>{shift && !sym ? k.toUpperCase() : k}</button>)}</div>
      <div className="authkrow">
        {!sym && <button className={"authk fn" + (shift ? " on" : "")} onClick={() => setShift((s) => !s)} aria-label="Shift"><ArrowUp /></button>}
        {rows[2].map((k) => <button key={k} className="authk" onClick={() => tap(k)}>{shift && !sym ? k.toUpperCase() : k}</button>)}
        <button className="authk fn" onClick={onEnter} style={{ flex: 1.6 }}>enter</button>
      </div>
      <div className="authkrow">
        <button className="authk fn" onClick={() => { setSym((s) => !s); setShift(false); }} style={{ flex: 1.4 }}>{sym ? "ABC" : "?123"}</button>
        <button className="authk" onClick={() => onKey("@")}>@</button>
        <button className="authk" onClick={() => onKey(" ")} style={{ flex: 4 }}> </button>
        <button className="authk" onClick={() => onKey(".")}>.</button>
        <button className="authk fn" onClick={() => onKey(".com")} style={{ flex: 1.4 }}>.com</button>
      </div>
    </div>
  );
}
function PinScreen({ employees, branchId, onAdmin, onSuccess }) {
  const [employeeId, setEmployeeId] = useState("");
  const [pin, setPin] = useState(""); const [err, setErr] = useState(false);
  const [fpBusy, setFpBusy] = useState(false);
  const [fpErr, setFpErr] = useState("");
  const press = (d) => { if (!err) setPin((p) => (p.length < 4 ? p + d : p)); };
  const back = () => { setErr(false); setPin((p) => p.slice(0, -1)); };
  const employeeIdentifierMatches = (e) => {
    const raw = employeeId.trim();
    const normalized = raw.toLowerCase();
    if (!normalized) return false;
    return [e.id, e.name, e.email, e.phone].some((value) => {
      const current = String(value || "").trim();
      return current && (current.toLowerCase() === normalized || current === raw);
    });
  };
  const submit = async () => {
    if (pin.length !== 4) return;
    const identifier = employeeId.trim();
    if (!identifier) {
      setErr(true); setTimeout(() => setErr(false), 900);
      return;
    }
    try {
      const cloud = await cloudLogin({ identifier, pin, branchId });
      if (cloud?.account) {
        const emp = accountToSession(cloud.account, branchId) || employees.find((e) => e.id === cloud.account.id);
        setTimeout(() => onSuccess({ ...emp, sessionToken: cloud.sessionToken }), 80);
        return;
      }
    } catch (_) {}
    const m = (employees || []).find((e) => isActiveEmployee(e) && e.role === "Cashier" && employeeIdentifierMatches(e) && e.pin === pin && (!branchId || e.branchId === branchId));
    if (m) { setTimeout(() => onSuccess(m), 140); return; }
    setErr(true); setTimeout(() => { setErr(false); setPin(""); }, 600);
  };
  const scanFingerprint = async () => {
    setFpErr("");
    setFpBusy(true);
    try {
      const cloud = await fingerprintLogin(branchId, "VISIONPOS login");
      const emp = accountToSession(cloud.account, branchId) || employees.find((e) => e.id === cloud.account.id);
      setTimeout(() => onSuccess({ ...emp, sessionToken: cloud.sessionToken }), 80);
    } catch (error) {
      setFpErr(error.message === "Fingerprint not recognized." ? error.message : secugenMessage(error));
    } finally {
      setFpBusy(false);
    }
  };
  useEffect(() => { if (pin.length === 4) submit(); }, [pin]); // eslint-disable-line
  useEffect(() => { const k = (e) => { const tag = document.activeElement?.tagName?.toLowerCase(); if (tag === "input" || tag === "textarea") return; if (e.key >= "0" && e.key <= "9") press(e.key); else if (e.key === "Backspace") back(); else if (e.key === "Enter") submit(); };
    window.addEventListener("keydown", k); return () => window.removeEventListener("keydown", k); }); // eslint-disable-line
  return (
    <AuthShellV3>
      <div className="authfield-label">Employee ID</div>
      <div className={"authfield employee-login" + (err && !employeeId.trim() ? " err" : "")}>
        <input
          value={employeeId}
          onChange={(e) => { setErr(false); setEmployeeId(e.target.value); }}
          placeholder="Employee number or username"
          autoFocus
          autoComplete="username"
        />
      </div>
      <div className="authfield-label">PIN</div>
      <div className={"authfield" + (err ? " err" : "")}>
        <div className="disp">{"•".repeat(pin.length)}</div>
        <button className="arrow" onClick={submit} disabled={pin.length !== 4} aria-label="Sign in"><ArrowRight /></button>
      </div>
      <div className="authforgot" onClick={onAdmin}>Admin / Supervisor sign-in</div>
      <div className="field" style={{ margin: "12px 0 0" }}>
        <button className="btn btn-primary" disabled={fpBusy} onClick={scanFingerprint}><Fingerprint /> {fpBusy ? "Scanning..." : "Scan Fingerprint"}</button>
      </div>
      {fpErr && <div className="alert"><AlertCircle />{fpErr}</div>}
      <div className="authkb">
        <div className="authkrow">{["1", "2", "3", "4", "5"].map((n) => <button key={n} className="authk" onClick={() => press(n)}>{n}</button>)}</div>
        <div className="authkrow">{["6", "7", "8", "9", "0"].map((n) => <button key={n} className="authk" onClick={() => press(n)}>{n}</button>)}</div>
        <div className="authkrow">
          <button className="authk fn" onClick={() => setPin("")} style={{ flex: 2 }}>clear</button>
          <button className="authk fn" onClick={back} aria-label="Backspace"><Delete /></button>
          <button className="authk fn" onClick={submit} style={{ flex: 2 }}>enter</button>
        </div>
      </div>
      <DesktopDownloadSection />
    </AuthShellV3>
  );
}
function AdminLogin({ onBack, onSignedIn }) {
  const [email, setEmail] = useState(""), [pw, setPw] = useState(""), [show, setShow] = useState(false), [err, setErr] = useState(""), [forgot, setForgot] = useState(false);
  const initialResetToken = (() => {
    try { return new URLSearchParams(window.location.search).get("resetToken") || ""; } catch (_) { return ""; }
  })();
  const [focusField, setFocusField] = useState("email");
  const [fpBusy, setFpBusy] = useState(false);
  const [busy, setBusy] = useState(false);
  const [codeRequired, setCodeRequired] = useState(false);
  const [codeTarget, setCodeTarget] = useState("");
  const [code, setCode] = useState("");
  const [emailVerifyRequired, setEmailVerifyRequired] = useState(false);
  const [emailVerifyEmail, setEmailVerifyEmail] = useState("");
  const [emailVerifyMasked, setEmailVerifyMasked] = useState("");
  const [emailVerifyCode, setEmailVerifyCode] = useState("");
  const [resendCooldown, setResendCooldown] = useState(0);
  const [resetEmail, setResetEmail] = useState("");
  const [resetToken, setResetToken] = useState(initialResetToken);
  const [resetTarget, setResetTarget] = useState("");
  const [resetPw, setResetPw] = useState("");
  const [resetPw2, setResetPw2] = useState("");
  const [resetSent, setResetSent] = useState(false);
  const [resetDone, setResetDone] = useState(false);
  useEffect(() => {
    if (!initialResetToken) return;
    setForgot(true);
    setResetSent(true);
    setErr("Checking reset link...");
    authApi("/api/auth/validate-password-reset", { token: initialResetToken })
      .then((result) => { setResetTarget(result.target || "your admin email"); setErr(""); })
      .catch(() => setErr("This reset link is invalid or expired. Request a new one."));
  }, []); // eslint-disable-line
  useEffect(() => {
    if (resendCooldown <= 0) return undefined;
    const id = setInterval(() => setResendCooldown((v) => Math.max(0, v - 1)), 1000);
    return () => clearInterval(id);
  }, [resendCooldown]);
  const submit = async () => {
    if (!email.trim() || !pw) return setErr("Enter your email or phone and password.");
    if (codeRequired && !/^\d{6}$/.test(code.trim())) return setErr("Enter the 6-digit email code.");
    const raw = email.trim();
    setErr("");
    setBusy(true);
    try {
      const cloud = await cloudLogin({ identifier: raw, password: pw, code: code.trim() || undefined, deviceName: "VISIONPOS Admin" });
      if (cloud?.emailVerificationRequired) {
        setEmailVerifyRequired(true);
        setEmailVerifyEmail(cloud.target || raw);
        setEmailVerifyMasked(cloud.maskedTarget || cloud.target || raw);
        setEmailVerifyCode("");
        setResendCooldown(cloud.resendAfterSeconds || 60);
        setErr("");
        return;
      }
      if (cloud?.verificationRequired) {
        setCodeRequired(true);
        setCodeTarget(cloud.target || "your admin email");
        setFocusField("code");
        setCode("");
        setErr(`Enter the code sent to ${cloud.target || "your admin email"}.`);
        return;
      }
      if (cloud?.account) {
        const emp = accountToSession(cloud.account, "");
        if (emp) emp.sessionToken = cloud.sessionToken;
        return onSignedIn(emp);
      }
    } catch (error) {
      const message = String(error?.message || "login_failed");
      setErr(message === "invalid_code" ? "That email code is incorrect." :
        message === "code_not_found_or_expired" ? "That email code expired. Sign in again to get a new code." :
        message === "too_many_attempts" ? "Too many incorrect code attempts. Sign in again to get a new code." :
        message === "admin_email_required" ? "This management account needs an email address before email code login can work." :
        message === "email_verification_send_failed" ? "Verification email could not be sent right now. Try again later." :
        message === "Failed to fetch" ? "Cloud login is unreachable. Check your internet connection." :
        "Those credentials don't match.");
      return;
    } finally {
      setBusy(false);
    }
  };
  const scanFingerprint = async () => {
    setErr("");
    setFpBusy(true);
    try {
      const cloud = await fingerprintLogin(null, "VISIONPOS admin login");
      if (cloud?.account) {
        const emp = accountToSession(cloud.account, "");
        if (emp) emp.sessionToken = cloud.sessionToken;
        return onSignedIn(emp);
      }
    } catch (error) {
      setErr(error.message === "Fingerprint not recognized." ? error.message : secugenMessage(error));
    } finally {
      setFpBusy(false);
    }
  };
  const resetCodeStep = () => { setCodeRequired(false); setCodeTarget(""); setCode(""); };
  const resendEmailVerification = async () => {
    if (resendCooldown > 0 || !emailVerifyEmail) return;
    setErr("");
    setBusy(true);
    try {
      const result = await authApi("/api/auth/resend-email-verification", { email: emailVerifyEmail });
      setEmailVerifyMasked(result.target || emailVerifyMasked || emailVerifyEmail);
      setResendCooldown(result.resendAfterSeconds || 60);
      setErr("Verification code sent. Check your email.");
    } catch (error) {
      setErr(error.message === "too_many_attempts" ? "Too many resend attempts. Try again in a few minutes." :
        error.message === "email_provider_not_configured" || error.message === "email_verification_send_failed" ? "Email could not be sent right now. Try again later." :
        error.message === "Failed to fetch" ? "Cloud verification is unreachable. Check your internet connection." : error.message);
    } finally {
      setBusy(false);
    }
  };
  const verifyEmailCode = async () => {
    if (!emailVerifyEmail) return setErr("Start the email verification again from login.");
    if (!/^\d{6}$/.test(emailVerifyCode.trim())) return setErr("Enter the 6-digit verification code.");
    setErr("");
    setBusy(true);
    try {
      await authApi("/api/auth/verify-email", { email: emailVerifyEmail, code: emailVerifyCode.trim() });
      setEmail(emailVerifyEmail);
      setPw("");
      setCode("");
      setCodeRequired(false);
      setEmailVerifyRequired(false);
      setEmailVerifyCode("");
      setResendCooldown(0);
      setFocusField("pw");
      setErr("Email verified. Sign in with your password.");
    } catch (error) {
      setErr(error.message === "invalid_code" ? "That verification code is incorrect." :
        error.message === "code_not_found_or_expired" ? "That verification code expired. Send a new code." :
        error.message === "too_many_attempts" ? "Too many incorrect attempts. Send a new code." :
        error.message === "Failed to fetch" ? "Cloud verification is unreachable. Check your internet connection." : error.message);
    } finally {
      setBusy(false);
    }
  };
  const requestResetCode = async () => {
    const target = resetEmail.trim().toLowerCase();
    if (!isValidEmail(target)) return setErr("Enter the admin email address.");
    setErr("");
    setBusy(true);
    try {
      await authApi("/api/auth/request-password-reset", { email: target });
      setResetSent(true);
      setResetToken("");
      setResetTarget(maskEmailLocal(target));
      setErr("If that admin email exists, a secure reset link has been sent.");
    } catch (error) {
      setErr(error.message === "email_provider_not_configured" ? "Email sending is not configured on the server." :
        error.message === "Failed to fetch" ? "Cloud reset is unreachable. Check your internet connection." : error.message);
    } finally {
      setBusy(false);
    }
  };
  const completeReset = async () => {
    if (!resetToken) return setErr("Open the reset link from your email first.");
    const issue = passwordIssue(resetPw); if (issue) return setErr(issue);
    if (resetPw !== resetPw2) return setErr("Passwords don't match.");
    setErr("");
    setBusy(true);
    try {
      await authApi("/api/auth/reset-password", { token: resetToken, password: resetPw, confirmPassword: resetPw2 });
      try { window.history.replaceState({}, "", window.location.pathname); } catch (_) {}
      setEmail(resetEmail.trim().toLowerCase());
      setPw("");
      setCodeRequired(false);
      setCodeTarget("");
      setCode("");
      setResetToken("");
      setResetPw("");
      setResetPw2("");
      setResetSent(false);
      setResetDone(false);
      setForgot(false);
      setFocusField("pw");
      setErr("Password updated. Sign in with the new password.");
    } catch (error) {
      setErr(error.message === "reset_token_invalid_or_expired" ? "This reset link is invalid or expired. Request a new one." :
        error.message === "password_reused" ? "Choose a password you have not used for this account." :
        resetErrorMessage(error.message));
    } finally {
      setBusy(false);
    }
  };
  const kbKey = (k) => {
    setErr("");
    if (focusField === "email") setEmail((v) => v + k);
    else if (focusField === "code") setCode((v) => (v + k).replace(/\D/g, "").slice(0, 6));
    else setPw((v) => v + k);
  };
  const kbBack = () => {
    setErr("");
    if (focusField === "email") setEmail((v) => v.slice(0, -1));
    else if (focusField === "code") setCode((v) => v.slice(0, -1));
    else setPw((v) => v.slice(0, -1));
  };
  if (emailVerifyRequired) {
    return (
      <AuthShellV3>
        <div className="authform">
          <div className="authfield-label" style={{ marginBottom: 14 }}>Verify your email</div>
          <div className="authnote" style={{ marginTop: 0, marginBottom: 12 }}>
            Enter the verification code sent to <b>{emailVerifyMasked || emailVerifyEmail}</b>.
          </div>
          <div className="field"><label className="label">Verification code</label>
            <input className="input mono" inputMode="numeric" maxLength={6} placeholder="000000" value={emailVerifyCode} onChange={(e) => { setEmailVerifyCode(e.target.value.replace(/\D/g, "").slice(0, 6)); setErr(""); }} onKeyDown={(e) => e.key === "Enter" && verifyEmailCode()} /></div>
          {err && <div className={err.includes("sent") ? "authnote" : "alert"}>{!err.includes("sent") && <AlertCircle />}{err}</div>}
          <div className="field"><button className="btn btn-primary" disabled={busy} onClick={verifyEmailCode}><ShieldCheck /> {busy ? "Please wait..." : "Verify Email"}</button></div>
          <div className="field"><button className="btn btn-ghost" disabled={busy || resendCooldown > 0} onClick={resendEmailVerification}><Mail /> {resendCooldown > 0 ? `Resend in ${resendCooldown}s` : "Resend Code"}</button></div>
          <button className="authback" style={{ marginTop: 16 }} onClick={() => { setEmailVerifyRequired(false); setEmailVerifyCode(""); setErr(""); setFocusField("pw"); }}><ArrowLeft /> Back to sign-in</button>
        </div>
      </AuthShellV3>
    );
  }
  if (forgot) {
    return (
      <AuthShellV3>
        <div className="authform">
          <div className="authfield-label" style={{ marginBottom: 14 }}>Reset your password</div>
          <div className="authnote" style={{ marginTop: 0, marginBottom: 12 }}>
            {resetToken ? `Enter a new password for ${resetTarget || "this admin account"}.` : "Enter the admin email. We'll send a secure reset link if the account exists."}
          </div>
          {!resetToken && <>
            <div className="field" style={{ marginTop: 0 }}><label className="label">Admin email</label>
              <input className="input" type="email" placeholder="admin@visionarypos.cloud" value={resetEmail} onChange={(e) => { setResetEmail(e.target.value); setErr(""); setResetDone(false); }} onKeyDown={(e) => e.key === "Enter" && requestResetCode()} /></div>
            <div className="field"><button className="btn btn-ghost" disabled={busy} onClick={requestResetCode}><Mail /> {resetSent ? "Send reset link again" : "Send reset link"}</button></div>
          </>}
          {resetToken && <>
            <div className="field"><label className="label">New password</label>
              <input className="input" type="password" placeholder="8+ chars, upper, number, symbol" value={resetPw} onChange={(e) => { setResetPw(e.target.value); setErr(""); }} /></div>
            <div className="field"><label className="label">Confirm new password</label>
              <input className="input" type="password" placeholder="Re-enter new password" value={resetPw2} onChange={(e) => { setResetPw2(e.target.value); setErr(""); }} onKeyDown={(e) => e.key === "Enter" && completeReset()} /></div>
            <PasswordRules password={resetPw} confirm={resetPw2} />
            <div className="field"><button className="btn btn-primary" disabled={busy} onClick={completeReset}><ShieldCheck /> {busy ? "Please wait..." : "Update password"}</button></div>
          </>}
          {err && <div className={resetDone ? "authnote" : "alert"}>{!resetDone && <AlertCircle />}{err}</div>}
          <button className="authback" style={{ marginTop: 16 }} onClick={() => { setForgot(false); setErr(""); setResetDone(false); setResetToken(""); try { window.history.replaceState({}, "", window.location.pathname); } catch (_) {} }}><ArrowLeft /> Back to sign-in</button>
        </div>
      </AuthShellV3>
    );
  }
  return (
    <AuthShellV3>
      <div className="authform admin-authform">
        <div className="authpanel-title">Admin / Supervisor sign-in</div>
        <div className="authpanel-sub">Access the web portal for management, reports, inventory, and branch operations.</div>
        <div className="field" style={{ marginTop: 0 }}><label className="label">Email or phone</label><div className={"input-wrap" + (focusField === "email" ? " kbfocus" : "")}><Mail className="lead" />
          <input className="input lead" type="text" placeholder="you@store.com or 0712345678" value={email} onFocus={() => setFocusField("email")} onChange={(e) => { setEmail(e.target.value); setErr(""); resetCodeStep(); }} onKeyDown={(e) => e.key === "Enter" && submit()} /></div></div>
        <div className="field"><label className="label">Password</label><div className={"input-wrap" + (focusField === "pw" ? " kbfocus" : "")}>
          <input className="input" type={show ? "text" : "password"} placeholder="••••••••" value={pw} onFocus={() => setFocusField("pw")} onChange={(e) => { setPw(e.target.value); setErr(""); }} onKeyDown={(e) => e.key === "Enter" && submit()} />
          <button className="toggle-eye" onClick={() => setShow((s) => !s)}>{show ? <EyeOff /> : <Eye />}</button></div></div>
        {codeRequired && <div className="field"><label className="label">Email verification code</label><div className={"input-wrap" + (focusField === "code" ? " kbfocus" : "")}><ShieldCheck className="lead" />
          <input className="input lead mono" inputMode="numeric" maxLength={6} placeholder="000000" value={code} onFocus={() => setFocusField("code")} onChange={(e) => { setCode(e.target.value.replace(/\D/g, "").slice(0, 6)); setErr(""); }} onKeyDown={(e) => e.key === "Enter" && submit()} /></div>
          <div className="authnote" style={{ marginTop: 8 }}>Code sent to {codeTarget || "your admin email"}.</div></div>}
        {err && <div className="alert"><AlertCircle />{err}</div>}
        <div className="auth-actions single">
          <div className="field"><button className="btn btn-primary" disabled={busy} onClick={submit}><ShieldCheck /> {busy ? "Please wait..." : codeRequired ? "Verify code" : "Sign in"}</button></div>
        </div>
        <div className="authforgot" onClick={() => { setResetEmail(email.trim()); setForgot(true); setErr(""); }}>Forgot password?</div>
        {onBack && <button className="authback" onClick={onBack}><ArrowLeft /> Back to staff PIN</button>}
      </div>
      <DesktopDownloadSection />
    </AuthShellV3>
  );
}

/* ================================================================== */
/*  Register (invoice-based cashier)                                  */
/* ================================================================== */
function ProductImage({ src, alt, fit }) {
  const [bad, setBad] = useState(false);
  if (!src || bad) return <Wine />;
  return <img src={src} alt={alt || ""} onError={() => setBad(true)} style={{ width: "100%", height: "100%", objectFit: fit || "contain", borderRadius: 10 }} />;
}
function CashierCategoryButton({ label, count, active, onClick }) {
  return (
    <button className={"cashier-cat" + (active ? " on" : "")} onClick={onClick}>
      <span>{label}</span>
      <b>{count}</b>
    </button>
  );
}
function CashierQuickButton({ icon, label, shortcut, tone, disabled, onClick }) {
  return (
    <button className={"cashier-quick " + (tone || "")} disabled={disabled} onClick={onClick}>
      <span className="cq-ic">{icon}</span>
      <span className="cq-label">{label}</span>
      {shortcut && <span className="shortcut">{shortcut}</span>}
    </button>
  );
}
function CashierProductCard({ product, stock, price, cur, onAdd }) {
  const unavailable = stock.cls === "out";
  return (
    <button className={"cashier-product " + stock.cls} disabled={unavailable} onClick={onAdd}>
      <span className="cp-img"><ProductImage src={productDisplayImage(product)} alt={product.name} /></span>
      <span className="cp-body">
        <span className="cp-name">{product.name}</span>
        <span className="cp-meta">{product.sku}{product.size ? " - " + product.size : ""}</span>
      </span>
      <span className="cp-foot">
        <span className="cp-price">{fmt(price, cur)}</span>
        <span className={"cp-stock " + stock.cls}>{unavailable ? "Out" : stock.left + " left"}</span>
      </span>
    </button>
  );
}
const QEXP = ["Police", "Utilities", "Other"];
const APPROVAL_LIMIT = 50000; // KES 500 — above this a till expense needs admin approval
function Register({ data, update, online, employee, branch, environmentMode = "test" }) {
  const cur = data.settings.currency;
  const reorder = data.settings.reorderLevel || 4;
  const [cart, setCart] = useState({});
  const [q, setQ] = useState("");
  const [ident, setIdent] = useState("");
  const [note, setNote] = useState("");
  const [saleErr, setSaleErr] = useState("");
  const [receipt, setReceipt] = useState(null);
  const [detail, setDetail] = useState(null);
  const [holds, setHolds] = useState([]);
  const [exp, setExp] = useState(null); // {categoryId, amount, note}
  const [debtsOpen, setDebtsOpen] = useState(false);
  const [flash, setFlash] = useState("");
  const [showAll, setShowAll] = useState(false);
  const [ptab, setPtab] = useState("products");
  const [pinPrompt, setPinPrompt] = useState(false);
  const [pinVal, setPinVal] = useState("");
  const [pinErr, setPinErr] = useState(false);
  const [pinBusy, setPinBusy] = useState(false);
  const [fpBusy, setFpBusy] = useState(false);
  const [fpErr, setFpErr] = useState("");
  const [scannerOn, setScannerOn] = useState(true);
  const [catFilter, setCatFilter] = useState("All");
  const [scanProduct, setScanProduct] = useState(null); // { barcode, name, sku, size, category, price, cost }
  const [scanErr, setScanErr] = useState("");
  const lastSearchBarcodeRef = useRef({ code: "", ts: 0 });
  const searchInputRef = useRef(null);
  const lastSearchKeyAtRef = useRef(0);
  const scanFocus = (force = false) => window.setTimeout(() => {
    const active = document.activeElement;
    const tag = String(active?.tagName || "").toLowerCase();
    const isEditing = active?.isContentEditable || tag === "input" || tag === "textarea" || tag === "select";
    if (force || !isEditing || active === searchInputRef.current) searchInputRef.current?.focus();
  }, 0);

  const branchProducts = branchProductsUnique(data, branch.id).filter(productIsEnabled);
  const activeExpenseCategories = cashierExpenseCategories(data);
  const defaultExpenseCategoryId = activeExpenseCategories[0]?.id || "excat_other";
  const categoryCounts = CATS.map((cat) => ({ cat, count: branchProducts.filter((p) => (p.category || "Other") === cat).length })).filter((x) => x.count > 0);
  const qNorm = q.trim().toLowerCase();
  const visible = branchProducts.filter((p) =>
    (catFilter === "All" || (p.category || "Other") === catFilter) &&
    (qNorm === "" || p.name.toLowerCase().includes(qNorm) || p.sku.toLowerCase().includes(qNorm) || productMatchesBarcode(p, q) || productMatchesCatalog(p, findBarcodeCatalogEntry(data, q))));

  const mine = operationalInvoices(data).filter((i) => i.cashierId === employee.id);
  const myDebts = mine.filter((i) => invIsDebt(i));
  const myOpen = mine.filter((i) => !invIsDebt(i) && invOutstanding(i) > 0);
  const myOverdue = myOpen.filter((i) => invIsOverdue(i));
  const myMissingInventoryDebts = cashierJointDebtEntries(data, employee.id, branch.id);
  const myInventoryDebtAccumulator = cashierJointDebtCashierBalances(data, branch.id).find((row) => row.cashierId === employee.id);
  const openOnly = myOpen;
  const openOnlyTotal = openOnly.reduce((s, i) => s + invOutstanding(i), 0);
  const invoiceDebtTotal = myDebts.reduce((s, i) => s + invOutstanding(i), 0);
  const missingInventoryAssignedTotal = myInventoryDebtAccumulator?.assignedCents || 0;
  const missingInventoryPaidTotal = myInventoryDebtAccumulator?.paidCents || 0;
  const missingInventoryDebtTotal = myMissingInventoryDebts.reduce((s, entry) => s + entry.outstandingCents, 0);
  const debtTotal = invoiceDebtTotal + missingInventoryDebtTotal;
  const shownList = openOnly;

  const add = (p) => {
    if (!p) return false;
    if (!productIsEnabled(p)) {
      setSaleErr(p.name + " is disabled and cannot be sold.");
      return false;
    }
    if (onHand(data, p.id, branch.id) - (cart[p.id] || 0) <= 0) return false;
    setCart((c) => ({ ...c, [p.id]: (c[p.id] || 0) + 1 }));
    setSaleErr("");
    scanFocus(true);
    return true;
  };
  const dec = (pid) => setCart((c) => { const n = { ...c }; n[pid] = (n[pid] || 0) - 1; if (n[pid] <= 0) delete n[pid]; return n; });
  const lines = cartLines(data, cart);
  const total = lines.reduce((s, l) => s + l.priceCents * l.qty, 0);
  const itemCount = lines.reduce((s, l) => s + l.qty, 0);
  const belowCostLines = lines.filter((l) => {
    const p = data.products.find((x) => x.id === l.productId);
    return p && l.priceCents < branchInventoryCostCents(data, p, branch.id);
  });
  const disabledSaleLine = lines.find((line) => !productIsEnabled(data.products.find((product) => product.id === line.productId)));
  const saleBlocked = belowCostLines.length > 0 || Boolean(disabledSaleLine);
  const notifyScan = (message, kind = "success") => {
    setFlash(message);
    playScanSound(kind);
  };
  const addScannedProduct = (hit, barcode, status = "sell:added") => {
    const ok = add(hit.product);
    const warn = hit.product.synced === false ? " Product is still unsynced." : "";
    notifyScan(ok ? "Scanned " + hit.name + " - " + hit.stockQty + " in stock." + warn : hit.name + " is out of stock.", ok ? "success" : "error");
    appendBarcodeScanLog({ barcode, status: ok ? status : "sell:out_of_stock", productId: hit.product.id });
    setQ("");
    setPtab("products");
    scanFocus(true);
    return ok;
  };
  const processCashierBarcode = (raw, source = "input") => {
    const barcode = normalizeBarcode(raw);
    if (!barcode) return false;
    if (!isValidBarcode(barcode)) {
      notifyScan("Invalid barcode: " + barcode, "error");
      appendBarcodeScanLog({ barcode, status: "sell:invalid" });
      setQ("");
      scanFocus(true);
      return true;
    }
    const t = now();
    const last = lastSearchBarcodeRef.current;
    if (last.code === barcode && t - last.ts < 180) return true;
    lastSearchBarcodeRef.current = { code: barcode, ts: t };
    const hit = barcodeLookup(data, barcode, branch.id, { enabledOnly: true });
    if (!hit) {
      notifyScan("Product not found: " + barcode, "error");
      appendBarcodeScanLog({ barcode, status: "sell:not_found" });
      setQ("");
      scanFocus(true);
      return true;
    }
    if (hit.unavailable) {
      notifyScan(hit.message || "This product is not available in this branch.", "error");
      appendBarcodeScanLog({ barcode, status: "sell:branch_unavailable", barcodeCatalogId: hit.barcodeCatalog?.id });
      setQ("");
      scanFocus(true);
      return true;
    }
    addScannedProduct(hit, barcode, source === "input" ? "sell:added_from_search" : "sell:added");
    return true;
  };
  const onEnter = (e) => {
    if (e.key !== "Enter" && e.key !== "Tab") return;
    if (e.key === "Tab") e.preventDefault();
    if (processCashierBarcode(e.currentTarget.value, "input")) return;
    const hit = branchProducts.find((p) => p.sku.toLowerCase() === q.trim().toLowerCase() || (p.barcode || "").toLowerCase() === q.trim().toLowerCase()) || visible[0];
    if (hit) { add(hit); setQ(""); scanFocus(true); }
  };
  const openScannedProductForm = (barcode) => {
    setScanProduct({ barcode, name: "", sku: "", size: "750 ML", category: CATS[0], price: "" });
    setScanErr("");
    setPtab("products");
  };
  const handleSellScan = (code) => {
    processCashierBarcode(code, "listener");
    return;
    const barcode = normalizeBarcode(code);
    if (!isValidBarcode(barcode)) {
      setFlash("Invalid barcode: " + barcode);
      appendBarcodeScanLog({ barcode, status: "sell:invalid" });
      return;
    }
    const hit = barcodeLookup(data, barcode, branch.id, { enabledOnly: true });
    if (!hit) {
      setFlash("Barcode not found. Add the product details to register it.");
      appendBarcodeScanLog({ barcode, status: "sell:not_found" });
      openScannedProductForm(barcode);
      return;
    }
    const ok = add(hit.product);
    const warn = hit.product.synced === false ? " Product is still unsynced." : "";
    setFlash(ok ? "Scanned " + hit.name + " · " + hit.stockQty + " in stock." + warn : hit.name + " is out of stock.");
    appendBarcodeScanLog({ barcode, status: ok ? "sell:added" : "sell:out_of_stock", productId: hit.product.id });
    if (ok) setPtab("cart");
  };
  useBarcodeScanner({ enabled: scannerOn && ptab !== "invoices" && !pinPrompt && !scanProduct, mode: "sell", onScan: handleSellScan });
  useEffect(() => {
    if (ptab === "products" && scannerOn && !pinPrompt && !scanProduct) scanFocus();
  }, [ptab, scannerOn, pinPrompt, scanProduct]);
  useEffect(() => {
    if (!scannerOn || ptab !== "products" || pinPrompt || scanProduct) return undefined;
    const barcode = normalizeBarcode(q);
    if (!isValidBarcode(barcode)) return undefined;
    if (now() - lastSearchKeyAtRef.current > 160) return undefined;
    const timer = window.setTimeout(() => {
      processCashierBarcode(barcode, "input");
      return;
      const hit = barcodeLookup(data, barcode, branch.id, { enabledOnly: true });
      if (!hit) return;
      const t = now();
      const last = lastSearchBarcodeRef.current;
      if (last.code === barcode && t - last.ts < 1000) return;
      lastSearchBarcodeRef.current = { code: barcode, ts: t };
      const ok = add(hit.product);
      const warn = hit.product.synced === false ? " Product is still unsynced." : "";
      setFlash(ok ? "Scanned " + hit.name + " · " + hit.stockQty + " in stock." + warn : hit.name + " is out of stock.");
      appendBarcodeScanLog({ barcode, status: ok ? "sell:added_from_search" : "sell:out_of_stock", productId: hit.product.id });
      if (ok) {
        setQ("");
        setPtab("cart");
      }
    }, 120);
    return () => window.clearTimeout(timer);
  }, [q, scannerOn, ptab, pinPrompt, scanProduct, data, branch.id]);
  const saveScannedProduct = () => {
    if (!scanProduct) return;
    const barcode = normalizeBarcode(scanProduct.barcode);
    const price = Math.round(parseFloat(scanProduct.price) * 100);
    if (!isValidBarcode(barcode)) return setScanErr("Scan a valid barcode.");
    if (!scanProduct.name.trim()) return setScanErr("Add a product name.");
    if (!price || price <= 0) return setScanErr("Enter a valid price.");
    const existingInBranch = data.products.some((p) => productVisibleInBranch(p, data, branch.id) && (productMatchesBarcode(p, barcode) || productMatchesCatalog(p, findBarcodeCatalogEntry(data, barcode))));
    if (existingInBranch) return setScanErr("Barcode already exists in this branch.");
    const sku = scanProduct.sku.trim() || barcode;
    if (data.products.some((p) => normalizeBarcode(p.sku).toLowerCase() === normalizeBarcode(sku).toLowerCase())) return setScanErr("SKU already exists.");
    update((d) => {
      const catalogResult = ensureBarcodeEntries(d, [barcode]);
      const catalogEntry = catalogResult.entries[0];
      return { ...d, barcodeCatalog: catalogResult.barcodeCatalog, products: [...d.products, {
      id: uid("p"), name: scanProduct.name.trim(), sku, barcode, size: scanProduct.size || "750 ML",
      category: scanProduct.category || CATS[0], priceCents: price,
      costCents: 0,
      barcodeCatalogId: catalogEntry?.id || null, branchId: branch.id, reorderLevel: d.settings.reorderLevel, status: "active", synced: false, updatedAt: now(),
    }] };
    });
    appendBarcodeScanLog({ barcode, status: "sell:product_created" });
    setFlash("Product registered. Scan again or tap it to sell.");
    setScanProduct(null);
  };

  const branchCode = ((branch.name || "BR").replace(/[^A-Za-z0-9]/g, "").slice(0, 3).toUpperCase()) || "BR";
  const receiptNo = "RCP-" + branchCode + "-" + String(data.invoices.length + 1).padStart(4, "0");

  useEffect(() => {
    if (!pinPrompt) return;
    const k = (e) => { if (e.key === "Escape") { setPinPrompt(false); setPinVal(""); setPinErr(false); setFpErr(""); } };
    window.addEventListener("keydown", k); return () => window.removeEventListener("keydown", k);
  }); // eslint-disable-line
  const startCheckout = () => {
    if (lines.length === 0 || ident.trim() === "") return;
    if (disabledSaleLine) {
      setSaleErr("Cannot complete sale: " + disabledSaleLine.name + " has been disabled by an administrator.");
      notifyScan("Sale blocked: a product is disabled.", "error");
      return;
    }
    if (saleBlocked) {
      const first = belowCostLines[0];
      setSaleErr("Cannot complete sale: " + first.name + " is priced below cost. Edit the selling price first.");
      notifyScan("Sale blocked: selling price is below cost.", "error");
      return;
    }
    setPinVal(""); setPinErr(false); setPinBusy(false); setFpErr(""); setPinPrompt(true);
  };
  const verifyCheckoutPin = async (pin) => {
    setPinBusy(true);
    try {
      if (online) {
        const cloud = await cloudLogin({ identifier: employee.id, pin, branchId: branch.id });
        if (cloud?.account?.id !== employee.id) throw new Error("wrong_cashier_pin");
      } else if (employee.pin !== pin) {
        throw new Error("wrong_cashier_pin");
      }
      setTimeout(() => { setPinPrompt(false); setPinVal(""); setPinErr(false); doComplete(); }, 120);
    } catch (_) {
      setPinErr(true);
      setTimeout(() => { setPinErr(false); setPinVal(""); }, 650);
    } finally {
      setPinBusy(false);
    }
  };
  const pinPush = (d) => {
    if (pinErr || pinBusy) return;
    if (d === "del") { setPinVal((v) => v.slice(0, -1)); return; }
    setPinVal((v) => {
      if (v.length >= 4) return v;
      const nv = v + d;
      if (nv.length === 4) verifyCheckoutPin(nv);
      return nv;
    });
  };
  const verifyCheckoutFingerprint = async () => {
    setFpErr("");
    setFpBusy(true);
    try {
      if (!employee?.sessionToken) throw new Error("Sign in again before completing a fingerprint sale.");
      const capture = await secugenCapture();
      const match = await identifyFingerprint(capture, branch.id, employee.id);
      if (!match) {
        await authApi("/api/auth/fingerprints/failed", { userId: employee.id, branchId: branch.id, deviceSerial: capture.deviceSerial, reason: "checkout_not_recognized" }).catch(() => {});
        throw new Error("Fingerprint verification failed.");
      }
      await authApi("/api/auth/fingerprints/checkout", { sessionToken: employee.sessionToken, userId: employee.id, branchId: branch.id, deviceSerial: capture.deviceSerial });
      setPinPrompt(false);
      doComplete();
    } catch (error) {
      setFpErr(error.message === "Fingerprint verification failed." ? error.message : secugenMessage(error));
    } finally {
      setFpBusy(false);
    }
  };
  const doComplete = () => {
    if (lines.length === 0) return;
    if (ident.trim() === "") return;
    if (saleBlocked) {
      const first = belowCostLines[0];
      setSaleErr("Cannot complete sale: " + first.name + " is priced below cost. Edit the selling price first.");
      return;
    }
    const ts = now(); const synced = online;
    const inv = { id: uid("inv"), number: receiptNo, customerId: null, customerName: ident.trim(), note: note.trim(),
      cashierId: employee.id, cashier: employee.name, branchId: branch.id, date: todayStr(), totalCents: total, paidCents: 0,
      items: lines.map((l) => ({ name: l.name, qty: l.qty, priceCents: l.priceCents })),
      method: "Invoice", carriedOver: false, ts, synced };
    const movements = lines.map((l) => ({ id: uid("mv"), productId: l.productId, branchId: branch.id, qty: -l.qty, reason: "Sale " + inv.number, ts, synced }));
    update((d) => ({ ...d, invoices: [...d.invoices, inv], stockMovements: [...d.stockMovements, ...movements] }));
    setReceipt(inv); setCart({}); setIdent(""); setNote("");
  };
  const holdSale = () => { if (lines.length === 0) return; setHolds((h) => [...h, { id: uid("hold"), cart, ident, ts: now(), count: itemCount, total }]); setCart({}); setIdent(""); setFlash("Sale held."); };
  const resume = (h) => { setCart(h.cart); setIdent(h.ident || ""); setHolds((hs) => hs.filter((x) => x.id !== h.id)); setPtab("cart"); };
  useEffect(() => {
    const onKey = (e) => {
      const tag = String(document.activeElement?.tagName || "").toLowerCase();
      const isEditing = document.activeElement?.isContentEditable || tag === "input" || tag === "textarea" || tag === "select";
      if (pinPrompt || scanProduct || receipt || debtsOpen || exp) return;
      if (e.key === "F2") { e.preventDefault(); setPtab("products"); scanFocus(true); }
      if (e.key === "F4") { e.preventDefault(); startCheckout(); }
      if (e.key === "F6") { e.preventDefault(); holdSale(); scanFocus(true); }
      if (e.key === "Delete" && !isEditing) { e.preventDefault(); setCart({}); scanFocus(true); }
      if (e.key === "Escape" && !isEditing) { e.preventDefault(); setQ(""); setPtab("products"); scanFocus(true); }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [pinPrompt, scanProduct, receipt, debtsOpen, exp, lines.length, ident, cart, total]); // eslint-disable-line
  const saveExp = () => {
    const c = Math.round(parseFloat(exp.amount) * 100); if (!c || c <= 0) return;
    const status = c > APPROVAL_LIMIT ? "pending" : "approved";
    const note = "Quick expense · " + employee.name + (exp.note.trim() ? " · " + exp.note.trim() : "");
    const ts = now();
    update((d) => {
      const currentCategories = cashierExpenseCategories(d);
      const category = currentCategories.find((item) => item.id === exp.categoryId) || currentCategories[0];
      return { ...d, expenses: [...d.expenses, { id: uid("ex"), categoryId: category?.id || exp.categoryId, category: category?.name || "Other", amountCents: c, note, status, enteredBy: employee.name, branchId: branch.id, date: todayStr(), ts, updatedAt: ts, synced: online }] };
    });
    setFlash(status === "pending" ? "Expense sent for admin approval." : "Expense recorded."); setExp(null);
  };
  const stock = (p) => { const left = onHand(data, p.id, branch.id) - (cart[p.id] || 0); return { left, cls: left <= 0 ? "out" : left <= reorder ? "low" : "ok" }; };
  const invRow = (i) => (
    <button className="qabtn" key={i.id} onClick={() => { setDebtsOpen(false); setDetail(i); }} style={{ justifyContent: "space-between" }}>
      <span style={{ display: "flex", flexDirection: "column", alignItems: "flex-start", minWidth: 0 }}>
        <span style={{ fontWeight: 700 }}>{i.number.slice(-8)}</span>
        <span className="cust-meta" style={{ whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis", maxWidth: 200 }}>{i.customerName} · {dt(i.ts)}</span>
      </span>
      <span style={{ textAlign: "right" }}>
        <span style={{ fontFamily: "var(--font-mono)", fontWeight: 700, fontSize: 12, display: "block" }}>{fmt(invOutstanding(i), cur)}</span>
        <span className={"ist " + invStatus(i)} style={{ fontSize: 10 }}>{invStatus(i)}</span>
      </span>
    </button>
  );
  const jointDebtRow = ({ debt, outstandingCents }) => (
    <div className="qabtn" key={debt.id} style={{ justifyContent: "space-between" }}>
      <span style={{ display: "flex", flexDirection: "column", alignItems: "flex-start", minWidth: 0 }}>
        <span style={{ fontWeight: 700 }}>Missing inventory · {debt.stockCountCode}</span>
        <span className="cust-meta">{debt.shortageUnits} missing unit{debt.shortageUnits === 1 ? "" : "s"} · {dt(debt.ts)}</span>
      </span>
      <span style={{ textAlign: "right" }}>
        <span style={{ fontFamily: "var(--font-mono)", fontWeight: 700, fontSize: 12, display: "block" }}>{fmt(outstandingCents, cur)}</span>
        <span className="ist overdue" style={{ fontSize: 10 }}>joint debt</span>
      </span>
    </div>
  );

  return (
    <div className="fade cashier-workstation">
      <div className="postabs">
        {[["products", "Products"], ["cart", "Cart"], ["invoices", "Invoices"]].map(([k, l]) => (
          <button key={k} className={"ptab" + (ptab === k ? " on" : "")} onClick={() => setPtab(k)}>{l}{k === "cart" && itemCount ? " (" + itemCount + ")" : ""}</button>))}
        <button className={"ptab" + (scannerOn ? " on" : "")} title="USB barcode scanner listener" onClick={() => setScannerOn((v) => { const next = !v; if (next) scanFocus(true); return next; })}><Barcode style={{ width: 16, height: 16 }} /> Scanner</button>
      </div>
      <div className="pos">
        {/* LEFT — my invoices & sales */}
        <div className={"poscol" + (ptab === "invoices" ? " active" : "")}>
          <div className="cashier-rail dark grow">
            <div className="cashier-open-head">
              <div><div className="sectit">Open invoices</div><div className="rail-title">{branch.name}</div></div>
              <span className={"scanner-pill" + (scannerOn ? " on" : "")} onClick={() => setScannerOn((v) => { const next = !v; if (next) scanFocus(true); return next; })}><Barcode /> {scannerOn ? "On" : "Off"}</span>
            </div>
            <div className="cashier-open-head">
              <div className="cust-meta">{openOnly.length} unpaid invoice{openOnly.length === 1 ? "" : "s"}{myOverdue.length ? " - " + myOverdue.length + " overdue" : ""}</div>
              <div className="cashier-open-total">{fmt(openOnlyTotal, cur)}</div>
            </div>
            {shownList.length === 0 ? (
              <div className="cashier-open-empty">
                <FileText style={{ width: 28, height: 28, marginBottom: 8, opacity: .75 }} />
                <div style={{ fontWeight: 850, color: "#d7e5eb" }}>No open invoices</div>
                <div style={{ marginTop: 4 }}>Paid and closed invoices stay out of the cashier workspace.</div>
              </div>
            ) : (
              <div className="cashier-open-list">
                {shownList.slice(0, 20).map((i) => (
                  <button className="cashier-open-card" key={i.id} onClick={() => setDetail(i)}>
                    <span style={{ display: "flex", flexDirection: "column", alignItems: "flex-start", minWidth: 0 }}>
                      <span className="co-no">{i.number.slice(-10)}</span>
                      <span className="cust-meta" style={{ whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis", maxWidth: 120 }}>{i.customerName}{i.trackingNote ? " · noted" : ""}</span>
                    </span>
                    <span style={{ textAlign: "right" }}>
                      <span className="co-amt">{fmt(invOutstanding(i), cur)}</span>
                      <span className={"ist " + invStatus(i)} style={{ fontSize: 10 }}>{invStatus(i)}</span>
                    </span>
                  </button>))}
              </div>
            )}
          </div>
          <div className="poscard invoice-panel">
            <div className="sectit" style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
              <span>Debt Tracker</span>
              <button className="linkc" onClick={() => setDebtsOpen(true)}>View</button>
            </div>
            <div className="debtbig"><span>Invoice debt</span><span className="v">{fmt(invoiceDebtTotal, cur)}</span></div>
            <div className="debtbig"><span>Inventory debt</span><span className="v">{fmt(missingInventoryDebtTotal, cur)}</span></div>
            <div className={"debtbig" + (debtTotal > 0 ? " has" : "")}><span>Total cashier debt</span><span className="v">{fmt(debtTotal, cur)}</span></div>
            <div className="cust-meta" style={{ margin: "-4px 2px 8px" }}>Assigned {fmt(missingInventoryAssignedTotal, cur)} · paid {fmt(missingInventoryPaidTotal, cur)}</div>
            <div className="cust-meta" style={{ margin: "2px 2px 8px" }}>{myDebts.length} carried-over invoice debt{myDebts.length === 1 ? "" : "s"} · {myMissingInventoryDebts.length} missing inventory count{myMissingInventoryDebts.length === 1 ? "" : "s"}</div>
            {myDebts.length === 0 && myMissingInventoryDebts.length === 0 ? (
              <div className="cust-meta" style={{ padding: "8px 2px" }}>No cashier debts for your login.</div>
            ) : (
              <div style={{ display: "flex", flexDirection: "column", gap: 7, maxHeight: 160, overflowY: "auto" }}>
                {myMissingInventoryDebts.slice(0, 6).map(jointDebtRow)}
                {myDebts.slice(0, 6).map((i) => invRow(i))}
              </div>
            )}
          </div>
          <div className="poscard">
            <div className="sectit">Quick Actions</div>
            <div className="qa">
              <button className="qabtn" onClick={() => setExp({ categoryId: defaultExpenseCategoryId, amount: "", note: "" })}><Wallet /> Expense</button>
              <button className="qabtn" onClick={holdSale}><Receipt /> Hold Sale</button>
              <button className="qabtn" onClick={() => setDebtsOpen(true)}><AlertCircle /> My Debts{debtTotal > 0 ? " · " + fmt(debtTotal, cur) : ""}</button>
            </div>
            {holds.length > 0 && (
              <div style={{ marginTop: 10 }}>
                <div className="cust-meta" style={{ fontWeight: 600, marginBottom: 6 }}>Held sales ({holds.length})</div>
                {holds.map((h) => <button key={h.id} className="qabtn" onClick={() => resume(h)}><Receipt /> {h.count} items · {fmt(h.total, cur)}</button>)}
              </div>
            )}
            {flash && <div className="notice" style={{ marginTop: 10, fontSize: 12 }}>{flash}</div>}
          </div>
        </div>

        {/* CENTER — products (search-first, minimal) */}
        <div className={"poscol" + (ptab === "products" ? " active" : "")}>
          <div className="cashier-searchbar">
            <div className="possearch"><Search /><input ref={searchInputRef} autoFocus placeholder="Scan barcode or search product, SKU, or barcode..." value={q} onChange={(e) => setQ(e.target.value)} onKeyDown={(e) => { if (e.key.length === 1) lastSearchKeyAtRef.current = now(); onEnter(e); }} /></div>
            <button className={"scanner-toggle" + (scannerOn ? " on" : "")} onClick={() => setScannerOn((v) => { const next = !v; if (next) scanFocus(true); return next; })}><Barcode /> Scanner</button>
          </div>
          <div className="product-strip">
            <div><b>{visible.length}</b> products</div>
            <span>{catFilter === "All" ? "All categories" : catFilter}</span>
            <span className="desktop-shortcuts">F2 Search - F4 Checkout - F6 Hold - Esc Clear search</span>
          </div>
          <div className="posgridwrap">
            {visible.length === 0 ? (
              <div className="possearch-empty"><Search /><div className="pse-t">No products match</div><div className="pse-s">Scan another barcode, change category, or type a product name.</div></div>
            ) : (
              <div className="posgrid workstation-grid">
                {visible.map((p) => { const s = stock(p); return (
                  <CashierProductCard key={p.id} product={p} stock={s} price={priceFor(data, p)} cur={cur} onAdd={() => add(p)} />
                ); })}
              </div>
            )}
          </div>
        </div>

        {/* RIGHT — cart & payment */}
        <div className={"poscol" + (ptab === "cart" ? " active" : "")}>
          <div className="posright checkout-panel">
            <div className="sectit" style={{ marginBottom: 2 }}>Current Sale</div>
            <div className="cust-meta">{itemCount} item{itemCount === 1 ? "" : "s"} · {branch.name}</div>
            <div className="cartlines2">
              {lines.length === 0 ? <div className="cempty"><ShoppingCart /> Scan or tap a product to start.</div> :
                lines.map((l) => (
                  <div className="cline" key={l.productId}>
                    <div className="qty"><button className="qbtn" onClick={() => dec(l.productId)}><Minus /></button><span className="qn">{l.qty}</span>
                      <button className="qbtn" onClick={() => add(data.products.find((x) => x.id === l.productId))}><Plus /></button></div>
                    <div className="nm">{l.name}<div className="pr">{l.qty} × {fmt(l.priceCents, cur)}</div></div>
                    <div className="pr" style={{ fontWeight: 700 }}>{fmt(l.priceCents * l.qty, cur)}</div>
                  </div>))}
            </div>
            <div className="field"><label className="label">Customer name / identifier <span style={{ color: "#E64368" }}>*</span></label>
              <input className={"input" + (ident.trim() === "" && lines.length > 0 ? " invalid" : "")} value={ident} onChange={(e) => setIdent(e.target.value)} placeholder="Required — name, phone or ID" /></div>
            <div className="field"><label className="label">Sale note</label>
              <input className="input" value={note} onChange={(e) => setNote(e.target.value)} placeholder="Optional receipt note" /></div>
            <div className="calc"><div className="calcrow"><span>Subtotal</span><span className="v">{fmt(total, cur)}</span></div></div>
            <div className="paytotal"><span className="lbl">Total</span><span className="amt">{fmt(total, cur)}</span></div>
            <button className="complete enterprise" disabled={lines.length === 0 || ident.trim() === "" || saleBlocked} onClick={startCheckout}><Check /> Complete Sale <span>F4</span></button>
            <div className="cart-actions" style={{ display: "flex", gap: 8, marginTop: 10 }}>
              <button className="btn btn-ghost" style={{ flex: 1 }} disabled={lines.length === 0} onClick={holdSale}>Hold</button>
              <button className="btn btn-ghost" style={{ flex: 1 }} disabled={lines.length === 0} onClick={() => { setCart({}); scanFocus(true); }}>Clear</button>
            </div>
            {(ident.trim() === "" && lines.length > 0) && <div className="cust-meta" style={{ textAlign: "center", marginTop: 6, color: "#E64368" }}>Enter a customer name / identifier to complete.</div>}
            {saleBlocked && <div className="cust-meta" style={{ textAlign: "center", marginTop: 6, color: "#E64368" }}>Selling price is below cost for {belowCostLines[0]?.name}. Edit price before checkout.</div>}
            {saleErr && <div className="alert" style={{ marginTop: 10 }}><AlertCircle />{saleErr}</div>}
            <div className="cust-meta" style={{ textAlign: "center", marginTop: 8 }}>Issues an open invoice ({receiptNo}) cleared by admin or supervisor.</div>
          </div>
        </div>
      </div>

      {scanProduct && (
        <div className="scrim" onClick={() => setScanProduct(null)}>
          <div className="modal" onClick={(e) => e.stopPropagation()} style={{ maxWidth: 560 }}>
            <div className="modal-head"><div><div className="sub" style={{ margin: 0 }}>Barcode not found</div><div className="title" style={{ fontSize: 21 }}>Register scanned product</div></div><button className="iconbtn" onClick={() => setScanProduct(null)}><X /></button></div>
            <div className="field" style={{ marginTop: 12 }}><label className="label">Barcode</label><input className="input" readOnly value={scanProduct.barcode} /></div>
            <div className="grid2">
              <div><label className="label">Name</label><input className="input" value={scanProduct.name} onChange={(e) => { setScanProduct({ ...scanProduct, name: e.target.value }); setScanErr(""); }} placeholder="Product name" /></div>
              <div><label className="label">SKU</label><input className="input" value={scanProduct.sku} onChange={(e) => { setScanProduct({ ...scanProduct, sku: e.target.value }); setScanErr(""); }} placeholder="Leave blank to use barcode" /></div>
            </div>
            <div className="grid3" style={{ marginTop: 12 }}>
              <div><label className="label">Size</label><input className="input" value={scanProduct.size} onChange={(e) => setScanProduct({ ...scanProduct, size: e.target.value })} /></div>
              <div><label className="label">Category</label><select className="select" value={scanProduct.category} onChange={(e) => setScanProduct({ ...scanProduct, category: e.target.value })}>{CATS.map((c) => <option key={c}>{c}</option>)}</select></div>
              <div><label className="label">Price ({cur})</label><input className="input" inputMode="decimal" value={scanProduct.price} onChange={(e) => { setScanProduct({ ...scanProduct, price: e.target.value }); setScanErr(""); }} placeholder="3000" /></div>
            </div>
            <div className="field"><label className="label">Buying cost ({cur})</label><input className="input" value="Calculated from purchases" readOnly disabled title="Buying cost is recalculated from received branch purchases." /></div>
            {scanErr && <div className="alert"><AlertCircle />{scanErr}</div>}
            <div className="grid2" style={{ marginTop: 14 }}><button className="btn btn-ghost" onClick={() => setScanProduct(null)}>Cancel</button><button className="btn btn-primary" onClick={saveScannedProduct}><Check /> Add product</button></div>
          </div>
        </div>
      )}

      {debtsOpen && (
        <div className="scrim" onClick={() => setDebtsOpen(false)}>
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <div className="modal-head"><div><div className="sub" style={{ margin: 0 }}>{employee.name}</div><div className="title" style={{ fontSize: 21 }}>Debts &amp; Open Invoices</div></div><button className="iconbtn" onClick={() => setDebtsOpen(false)}><X /></button></div>
            <div className="cashtiles" style={{ gridTemplateColumns: "repeat(auto-fit,minmax(180px,1fr))", margin: "12px 0 4px" }}>
              <div className="ctile warn"><div className="ic"><AlertCircle /></div><div><div className="cl">Total cashier debt</div><div className="cv">{fmt(debtTotal, cur)}</div><div className="cs">Invoice + inventory debt</div></div></div>
              <div className={"ctile" + (invoiceDebtTotal > 0 ? " warn" : "")}><div className="ic"><FileText /></div><div><div className="cl">Invoice debt</div><div className="cv">{fmt(invoiceDebtTotal, cur)}</div><div className="cs">{myDebts.length} carried over</div></div></div>
              <div className={"ctile" + (missingInventoryDebtTotal > 0 ? " warn" : "")}><div className="ic"><Boxes /></div><div><div className="cl">Missing inventory</div><div className="cv">{fmt(missingInventoryDebtTotal, cur)}</div><div className="cs">Paid {fmt(missingInventoryPaidTotal, cur)} of {fmt(missingInventoryAssignedTotal, cur)}</div></div></div>
              <div className={"ctile" + (openOnlyTotal > 0 ? " warn" : "")}><div className="ic"><FileText /></div><div><div className="cl">Open invoices</div><div className="cv">{fmt(openOnlyTotal, cur)}</div><div className="cs">Not included in cashier debt</div></div></div>
            </div>
            {myOpen.length === 0 && myDebts.length === 0 && myMissingInventoryDebts.length === 0 ? (
              <div className="notice" style={{ marginTop: 10 }}>You have no open invoices or debts. Nicely done.</div>
            ) : (
              <div style={{ marginTop: 12, display: "flex", flexDirection: "column", gap: 14, maxHeight: "48vh", overflowY: "auto" }}>
                {myMissingInventoryDebts.length > 0 && (
                  <div>
                    <div className="cust-meta" style={{ fontWeight: 700, marginBottom: 6, color: "var(--danger)" }}>Missing inventory · joint branch debt ({myMissingInventoryDebts.length})</div>
                    <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>{myMissingInventoryDebts.map(jointDebtRow)}</div>
                    <div className="debtbig" style={{ marginTop: 8 }}><span>Inventory debt total</span><span className="v">{fmt(missingInventoryDebtTotal, cur)}</span></div>
                  </div>
                )}
                {myDebts.length > 0 && (
                  <div>
                    <div className="cust-meta" style={{ fontWeight: 700, marginBottom: 6, color: "var(--danger)" }}>Debts · carried over ({myDebts.length})</div>
                    <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>{myDebts.map(invRow)}</div>
                    <div className="debtbig" style={{ marginTop: 8 }}><span>Invoice debt total</span><span className="v">{fmt(invoiceDebtTotal, cur)}</span></div>
                  </div>
                )}
                {openOnly.length > 0 && (
                  <div>
                    <div className="cust-meta" style={{ fontWeight: 700, marginBottom: 6 }}>Open / overdue invoices ({openOnly.length})</div>
                    <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>{openOnly.map(invRow)}</div>
                    <div className="debtbig" style={{ marginTop: 8 }}><span>Open invoice total</span><span className="v">{fmt(openOnlyTotal, cur)}</span></div>
                  </div>
                )}
              </div>
            )}
            <div className={"debtbig" + (debtTotal > 0 ? " has" : "")} style={{ marginTop: 12 }}><span>Total cashier debt</span><span className="v">{fmt(debtTotal, cur)}</span></div>
            <div className="cust-meta" style={{ marginTop: 12 }}>Missing inventory is valued at branch cost and shared equally among the active branch cashiers when the inventory count is applied.</div>
          </div>
        </div>
      )}
      {pinPrompt && (
        <div className="scrim" onClick={() => { setPinPrompt(false); setPinVal(""); setPinErr(false); setFpErr(""); }}>
          <div className="modal" style={{ maxWidth: 380 }} onClick={(e) => e.stopPropagation()}>
            <div className="modal-head"><div className="title" style={{ fontSize: 18, display: "flex", alignItems: "center", gap: 8 }}><Lock style={{ width: 18, height: 18 }} /> Authorize sale</div>
              <button className="iconbtn" onClick={() => { setPinPrompt(false); setPinVal(""); setPinErr(false); setFpErr(""); }}><X /></button></div>
            <div className="sub" style={{ margin: "2px 0 4px" }}>{employee.name} · enter your PIN to confirm this sale.</div>
            <div style={{ textAlign: "center", fontWeight: 800, fontSize: 20, color: "var(--text)", marginBottom: 6 }}>{fmt(total, cur)}</div>
            <div className={"dots" + (pinErr ? " shake" : "")} style={{ margin: "10px 0 16px" }}>{[0, 1, 2, 3].map((i) => <span key={i} className={"dot" + (i < pinVal.length ? (pinErr ? " err" : " on") : "")} />)}</div>
            {pinErr && <div className="alert" style={{ marginBottom: 12 }}><AlertCircle /> Incorrect PIN — try again.</div>}
            <div className="pad">{["1", "2", "3", "4", "5", "6", "7", "8", "9"].map((n) => <button key={n} className="key" disabled={pinBusy} onClick={() => pinPush(n)}>{n}</button>)}
              <span className="key ghost" /><button className="key" disabled={pinBusy} onClick={() => pinPush("0")}>0</button><button className="key util" disabled={pinBusy} onClick={() => pinPush("del")}><Delete /></button></div>
            {fpErr && <div className="alert" style={{ marginBottom: 12 }}><AlertCircle /> {fpErr}</div>}
            <button className="btn btn-ghost" style={{ width: "100%", marginTop: 14 }} disabled={fpBusy || pinBusy} onClick={verifyCheckoutFingerprint}><Fingerprint /> {fpBusy ? "Scanning..." : "Use fingerprint instead"}</button>
          </div>
        </div>
      )}
      {pinPrompt && false && (
        <div className="scrim" onClick={() => { setPinPrompt(false); setPinVal(""); setPinErr(false); }}>
          <div className="modal" style={{ maxWidth: 360 }} onClick={(e) => e.stopPropagation()}>
            <div className="modal-head"><div className="title" style={{ fontSize: 18, display: "flex", alignItems: "center", gap: 8 }}><Lock style={{ width: 18, height: 18 }} /> Authorize sale</div>
              <button className="iconbtn" onClick={() => { setPinPrompt(false); setPinVal(""); setPinErr(false); }}><X /></button></div>
            <div className="sub" style={{ margin: "2px 0 4px" }}>{employee.name} · enter your PIN to confirm this sale.</div>
            <div style={{ textAlign: "center", fontWeight: 800, fontSize: 20, color: "var(--text)", marginBottom: 6 }}>{fmt(total, cur)}</div>
            <div className={"dots" + (pinErr ? " shake" : "")} style={{ margin: "10px 0 16px" }}>{[0, 1, 2, 3].map((i) => <span key={i} className={"dot" + (i < pinVal.length ? (pinErr ? " err" : " on") : "")} />)}</div>
            {pinErr && <div className="alert" style={{ marginBottom: 12 }}><AlertCircle /> Incorrect PIN — try again.</div>}
            <div className="pad">{["1", "2", "3", "4", "5", "6", "7", "8", "9"].map((n) => <button key={n} className="key" onClick={() => pinPush(n)}>{n}</button>)}
              <span className="key ghost" /><button className="key" onClick={() => pinPush("0")}>0</button><button className="key util" onClick={() => pinPush("del")}><Delete /></button></div>
          </div>
        </div>
      )}
      {receipt && <InvoiceReceipt inv={receipt} cur={cur} store={branch.name} location={branch.location} till={branch.mpesaTill || data.settings.mpesaTill} environmentMode={environmentMode} onClose={() => setReceipt(null)} />}
      {detail && <InvoiceDetailModal inv={detail} data={data} update={update} cur={cur} onClose={() => setDetail(null)} />}
      {exp && (
        <div className="scrim" onClick={() => setExp(null)}>
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <div className="modal-head"><div><div className="sub" style={{ margin: 0 }}>Quick</div><div className="title" style={{ fontSize: 21 }}>Record Expense</div></div><button className="iconbtn" onClick={() => setExp(null)}><X /></button></div>
            <div className="field" style={{ marginTop: 12 }}><label className="label">Category</label><select className="select" value={exp.categoryId} onChange={(e) => setExp({ ...exp, categoryId: e.target.value })}>{activeExpenseCategories.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}</select></div>
            <div className="field"><label className="label">Amount ({cur})</label><input className="input" inputMode="decimal" autoFocus value={exp.amount} onChange={(e) => setExp({ ...exp, amount: e.target.value.replace(/[^\d.]/g, "") })} placeholder="Enter amount" onKeyDown={(e) => { if (e.key === "Enter") saveExp(); }} /></div>
            <div className="field"><label className="label">Description</label><input className="input" value={exp.note} onChange={(e) => setExp({ ...exp, note: e.target.value })} placeholder="Short note" /></div>
            {parseFloat(exp.amount) * 100 > APPROVAL_LIMIT && <div className="notice" style={{ fontSize: 12 }}>Over {fmt(APPROVAL_LIMIT, cur)} — needs admin approval.</div>}
            <button className="btn btn-primary" style={{ width: "100%", marginTop: 14 }} disabled={!exp.amount || parseFloat(exp.amount) <= 0} onClick={saveExp}><Check /> Save Expense</button>
          </div>
        </div>
      )}
    </div>
  );
}

function QuickExpenseModal({ employee, online, update, cur, onClose }) {
  const [catx, setCatx] = useState(QEXP[0]); const [amt, setAmt] = useState("");
  const save = () => { const c = Math.round(parseFloat(amt) * 100); if (!c || c <= 0) return;
    const ts = now();
    update((d) => ({ ...d, expenses: [...d.expenses, { id: uid("ex"), category: catx, amountCents: c, note: "Quick expense · " + employee.name, date: todayStr(), ts, updatedAt: ts, synced: online }] })); onClose(); };
  return (
    <div className="scrim" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal-head"><div className="title" style={{ fontSize: 18, display: "flex", alignItems: "center", gap: 8 }}><Wallet style={{ width: 18, height: 18 }} /> Quick expense</div>
          <button className="iconbtn" onClick={onClose}><X /></button></div>
        <div className="sub" style={{ margin: "4px 0 14px" }}>Record a petty-cash expense for {employee.name}.</div>
        <div className="qebtns">{QEXP.map((c) => <button key={c} className={"qebtn" + (c === catx ? " on" : "")} onClick={() => setCatx(c)}>{c}</button>)}</div>
        <div className="field"><label className="label">Amount ({cur})</label><input className="input" inputMode="decimal" value={amt} onChange={(e) => setAmt(e.target.value.replace(/[^\d.]/g, ""))} placeholder="0" /></div>
        <button className="btn btn-primary" style={{ marginTop: 16 }} onClick={save}><Check /> Record expense</button>
      </div>
    </div>
  );
}

function MyInvoicesSheet({ list, showAll, setShowAll, cur, openTotal, debtTotal, count, onClose }) {
  return (
    <div className="sheetscrim" onClick={onClose}>
      <div className="sheet" onClick={(e) => e.stopPropagation()}>
        <div className="modal-head"><div className="title" style={{ fontSize: 18 }}>My invoices</div><button className="iconbtn" onClick={onClose}><X /></button></div>
        <div className="invdoc"><div><div className="l">Open invoices</div><div className="v">{fmt(openTotal, cur)}</div></div><div className="b">{count} open</div></div>
        {debtTotal > 0 && <div className="debtbar"><AlertCircle /> Carried-over debts: {fmt(debtTotal, cur)}</div>}
        <div style={{ display: "flex", gap: 8 }}>
          <button className={"cchip" + (!showAll ? " on" : "")} onClick={() => setShowAll(false)}>Open</button>
          <button className={"cchip" + (showAll ? " on" : "")} onClick={() => setShowAll(true)}>All</button>
        </div>
        {list.length === 0 ? <div className="notice">No {showAll ? "" : "open "}invoices for your login.</div> : (
          <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
            {list.map((i) => (
              <div className="miniinv" key={i.id}>
                <div><div className="mn">{i.number.slice(-10)}</div><div style={{ color: "var(--muted-2)", fontSize: 11 }}>{i.customerName} · {dt(i.ts)}</div></div>
                <div style={{ textAlign: "right" }}><div style={{ fontFamily: "var(--font-mono)", fontWeight: 700 }}>{fmt(invOutstanding(i) || i.totalCents, cur)}</div>
                  <span className={"ist " + invStatus(i)} style={{ fontSize: 10 }}>{invStatus(i)}</span></div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

/* ---- Offline QR code (byte mode, ECC level M, auto best-mask). Generates locally, no network. Verified against a QR decoder. ---- */
function qrEncode(str) {
  const EXP = new Array(512), LOG = new Array(256);
  for (let i = 0, x = 1; i < 255; i++) { EXP[i] = x; LOG[x] = i; x <<= 1; if (x & 0x100) x ^= 0x11d; }
  for (let i = 255; i < 512; i++) EXP[i] = EXP[i - 255];
  const gmul = (a, b) => (a === 0 || b === 0) ? 0 : EXP[LOG[a] + LOG[b]];
  function genPoly(n) { let p = [1]; for (let i = 0; i < n; i++) { const np = new Array(p.length + 1).fill(0); for (let j = 0; j < p.length; j++) { np[j] ^= gmul(p[j], 1); np[j + 1] ^= gmul(p[j], EXP[i]); } p = np; } return p; }
  function ecc(data, n) { const gen = genPoly(n).slice(1); const res = new Array(n).fill(0); for (let i = 0; i < data.length; i++) { const f = data[i] ^ res[0]; res.shift(); res.push(0); if (f !== 0) for (let j = 0; j < n; j++) res[j] ^= gmul(gen[j], f); } return res; }
  const MB = { 1: [10, [[1, 16]]], 2: [16, [[1, 28]]], 3: [26, [[1, 44]]], 4: [18, [[2, 32]]], 5: [24, [[2, 43]]], 6: [16, [[4, 27]]], 7: [18, [[4, 31]]], 8: [22, [[2, 38], [2, 39]]], 9: [22, [[3, 36], [2, 37]]], 10: [26, [[4, 43], [1, 44]]] };
  const ALIGN = { 1: [], 2: [6, 18], 3: [6, 22], 4: [6, 26], 5: [6, 30], 6: [6, 34], 7: [6, 22, 38], 8: [6, 24, 42], 9: [6, 26, 46], 10: [6, 28, 50] };
  const dataCap = (v) => MB[v][1].reduce((s, [n, d]) => s + n * d, 0);
  const maskFns = [(r, c) => (r + c) % 2 === 0, (r, c) => r % 2 === 0, (r, c) => c % 3 === 0, (r, c) => (r + c) % 3 === 0, (r, c) => (Math.floor(r / 2) + Math.floor(c / 3)) % 2 === 0, (r, c) => ((r * c) % 2 + (r * c) % 3) === 0, (r, c) => (((r * c) % 2 + (r * c) % 3) % 2) === 0, (r, c) => (((r + c) % 2 + (r * c) % 3) % 2) === 0];
  function build(s, MASK) {
    const bytes = Array.from(new TextEncoder().encode(s));
    let v = 1; while (v <= 10) { const cci = v < 10 ? 8 : 16; if (Math.ceil((4 + cci + bytes.length * 8) / 8) <= dataCap(v)) break; v++; }
    if (v > 10) v = 10;
    const cci = v < 10 ? 8 : 16, cap = dataCap(v);
    let bits = []; const push = (val, len) => { for (let i = len - 1; i >= 0; i--) bits.push((val >> i) & 1); };
    push(0b0100, 4); push(bytes.length, cci); for (const b of bytes) push(b, 8);
    push(0, Math.min(4, cap * 8 - bits.length)); while (bits.length % 8) bits.push(0);
    let dcw = []; for (let i = 0; i < bits.length; i += 8) { let b = 0; for (let j = 0; j < 8; j++) b = (b << 1) | bits[i + j]; dcw.push(b); }
    const pads = [0xEC, 0x11]; let pi = 0; while (dcw.length < cap) dcw.push(pads[pi++ % 2]);
    const [ecn, groups] = MB[v]; const blocks = []; let idx = 0;
    for (const [nb, dpb] of groups) for (let i = 0; i < nb; i++) { const d = dcw.slice(idx, idx + dpb); idx += dpb; blocks.push({ d, e: ecc(d, ecn) }); }
    const maxD = Math.max(...blocks.map((b) => b.d.length)); const fc = [];
    for (let i = 0; i < maxD; i++) for (const b of blocks) if (i < b.d.length) fc.push(b.d[i]);
    for (let i = 0; i < ecn; i++) for (const b of blocks) fc.push(b.e[i]);
    const size = 17 + 4 * v; const m = Array.from({ length: size }, () => new Array(size).fill(null)); const fn = Array.from({ length: size }, () => new Array(size).fill(false));
    const place = (r, c, val, f) => { if (r < 0 || c < 0 || r >= size || c >= size) return; m[r][c] = val; if (f) fn[r][c] = true; };
    function finder(r, c) { for (let i = -1; i <= 7; i++) for (let j = -1; j <= 7; j++) { const rr = r + i, cc = c + j; if (rr < 0 || cc < 0 || rr >= size || cc >= size) continue; const inb = (i >= 0 && i <= 6 && (j === 0 || j === 6)) || (j >= 0 && j <= 6 && (i === 0 || i === 6)) || (i >= 2 && i <= 4 && j >= 2 && j <= 4); place(rr, cc, inb ? 1 : 0, true); } }
    finder(0, 0); finder(0, size - 7); finder(size - 7, 0);
    for (let i = 8; i < size - 8; i++) { const b = (i % 2 === 0) ? 1 : 0; if (m[6][i] === null) place(6, i, b, true); if (m[i][6] === null) place(i, 6, b, true); }
    const ap = ALIGN[v]; for (const r of ap) for (const c of ap) { if ((r <= 7 && c <= 7) || (r <= 7 && c >= size - 8) || (r >= size - 8 && c <= 7)) continue; for (let i = -2; i <= 2; i++) for (let j = -2; j <= 2; j++) place(r + i, c + j, (Math.max(Math.abs(i), Math.abs(j)) === 1) ? 0 : 1, true); }
    place(size - 8, 8, 1, true);
    for (let i = 0; i < 9; i++) { if (m[8][i] === null) place(8, i, 0, true); if (m[i][8] === null) place(i, 8, 0, true); }
    for (let i = 0; i < 8; i++) { if (m[8][size - 1 - i] === null) place(8, size - 1 - i, 0, true); if (m[size - 1 - i][8] === null) place(size - 1 - i, 8, 0, true); }
    const mf = maskFns[MASK]; const db = []; for (const cw of fc) for (let i = 7; i >= 0; i--) db.push((cw >> i) & 1);
    let bit = 0, dir = -1;
    for (let col = size - 1; col > 0; col -= 2) { if (col === 6) col--; for (let cnt = 0; cnt < size; cnt++) { const r = (dir < 0) ? (size - 1 - cnt) : cnt; for (const cc of [col, col - 1]) { if (!fn[r][cc] && m[r][cc] === null) { let b = bit < db.length ? db[bit] : 0; bit++; if (mf(r, cc)) b ^= 1; m[r][cc] = b; } } } dir = -dir; }
    let d = (0b00 << 3) | MASK, rem = d; for (let i = 0; i < 10; i++) { rem <<= 1; if (rem & 0b10000000000) rem ^= 0b10100110111; }
    const F = ((d << 10) | rem) ^ 0b101010000010010; const fa = []; for (let i = 14; i >= 0; i--) fa.push((F >> i) & 1);
    const posA = [[8, 0], [8, 1], [8, 2], [8, 3], [8, 4], [8, 5], [8, 7], [8, 8], [7, 8], [5, 8], [4, 8], [3, 8], [2, 8], [1, 8], [0, 8]];
    for (let i = 0; i < 15; i++) { const [r, c] = posA[i]; m[r][c] = fa[i]; }
    const posB = [[size - 1, 8], [size - 2, 8], [size - 3, 8], [size - 4, 8], [size - 5, 8], [size - 6, 8], [size - 7, 8], [8, size - 8], [8, size - 7], [8, size - 6], [8, size - 5], [8, size - 4], [8, size - 3], [8, size - 2], [8, size - 1]];
    for (let i = 0; i < 15; i++) { const [r, c] = posB[i]; m[r][c] = fa[i]; }
    return { size, m };
  }
  function penalty(m, size) { let p = 0; for (let r = 0; r < size; r++) { let rc = 1, cc = 1; for (let c = 1; c < size; c++) { if (m[r][c] === m[r][c - 1]) rc++; else { if (rc >= 5) p += 3 + (rc - 5); rc = 1; } if (m[c][r] === m[c - 1][r]) cc++; else { if (cc >= 5) p += 3 + (cc - 5); cc = 1; } } if (rc >= 5) p += 3 + (rc - 5); if (cc >= 5) p += 3 + (cc - 5); } return p; }
  let best = null, bp = Infinity;
  for (let mk = 0; mk < 8; mk++) { const q = build(String(str || ""), mk); const p = penalty(q.m, q.size); if (p < bp) { bp = p; best = q; } }
  return best;
}
function qrSvg(str, px) {
  try {
    const quiet = 4; const { size, m } = qrEncode(str); const dim = size + quiet * 2;
    let rects = "";
    for (let r = 0; r < size; r++) for (let c = 0; c < size; c++) if (m[r][c] === 1) rects += `<rect x="${c + quiet}" y="${r + quiet}" width="1" height="1"/>`;
    return `<svg xmlns="http://www.w3.org/2000/svg" width="${px}" height="${px}" viewBox="0 0 ${dim} ${dim}" shape-rendering="crispEdges"><rect width="${dim}" height="${dim}" fill="#fff"/><g fill="#000">${rects}</g></svg>`;
  } catch (e) { return ""; }
}
function escapeReceiptHtml(value) {
  return String(value == null ? "" : value).replace(/[&<>"']/g, (char) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  }[char]));
}
function normalizedReceiptItems(inv) {
  return (Array.isArray(inv?.items) ? inv.items : []).map((item) => {
    const qty = Math.max(0, Number(item?.qty ?? item?.quantity ?? 0));
    const priceCents = Math.max(0, Math.round(Number(item?.priceCents ?? item?.unitPriceCents ?? 0)));
    return {
      name: String(item?.name || item?.productName || "Product").trim() || "Product",
      qty,
      priceCents,
      totalCents: Math.max(0, Math.round(Number(item?.totalCents ?? qty * priceCents))),
    };
  }).filter((item) => item.qty > 0);
}
function invoiceReceiptStatus(inv, cur) {
  const status = String(inv?.status || "").toLowerCase();
  if (status.includes("void")) return "Invoice voided.";
  const outstanding = invOutstanding(inv);
  if (outstanding <= 0) return "Paid in full.";
  if (Number(inv?.paidCents || 0) > 0) return `Part paid - balance ${fmt(outstanding, cur)}.`;
  return "Open invoice - not paid at checkout.";
}
function invoiceReceiptPrintHtml(receipts, cur) {
  const sections = receipts.map(({ inv, store }, index) => {
    const items = normalizedReceiptItems(inv);
    const itemRows = items.map((item) => `<div class="line"><strong>${escapeReceiptHtml(item.name)}</strong><div class="line-detail"><span>${escapeReceiptHtml(item.qty)} x ${escapeReceiptHtml(fmt(item.priceCents, cur))}</span><b>${escapeReceiptHtml(fmt(item.totalCents, cur))}</b></div></div>`).join("");
    return `<main class="receipt receipt-${index}"><h1>${escapeReceiptHtml(store)}</h1><p>${escapeReceiptHtml(new Date(inv.ts).toLocaleString())}</p><p>Receipt: ${escapeReceiptHtml(inv.number || inv.receiptNo)}</p><p>Cashier: ${escapeReceiptHtml(invoiceCashierName(inv))}</p><p>Customer: ${escapeReceiptHtml(inv.customerName || "Walk-in")}</p>${inv.note ? `<p>Note: ${escapeReceiptHtml(inv.note)}</p>` : ""}<hr/>${itemRows || '<div class="line"><strong>No items recorded</strong></div>'}<hr/><div class="total"><span>Total</span><b>${escapeReceiptHtml(fmt(inv.totalCents, cur))}</b></div><p>${escapeReceiptHtml(invoiceReceiptStatus(inv, cur))}</p><p>Thank you.</p></main>`;
  }).join("");
  return `<!doctype html><html><head><meta charset="utf-8"/><title>Invoice receipts</title><style id="receipt-page-rules"></style><style>
*{box-sizing:border-box}html,body{margin:0;width:80mm;background:#fff;color:#000}body{font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:11px;line-height:1.35;overflow-wrap:anywhere;writing-mode:horizontal-tb}
.receipt{width:80mm;min-height:1px;padding:3mm 4mm;break-after:page;page-break-after:always}.receipt:last-child{break-after:auto;page-break-after:auto}
${receipts.map((_, index) => `.receipt-${index}{page:receipt-${index}}`).join("")}
h1{margin:0 0 6px;text-align:center;font-size:20px;line-height:1.15;font-weight:900}p{margin:2px 0;text-align:center}hr{border:0;border-top:1px dashed #000;margin:7px 0}.line{display:block;padding:3px 0;break-inside:avoid;page-break-inside:avoid}.line strong{display:block;font-weight:700}.line-detail,.total{display:grid;grid-template-columns:minmax(0,1fr) auto;align-items:start;gap:3mm}.line-detail{margin-top:1px}.line-detail span{min-width:0}.line-detail b,.total b{white-space:nowrap;text-align:right}.total{margin-top:2px;font-size:18px;line-height:1.2;font-weight:900}@media print{html,body{width:80mm}body{-webkit-print-color-adjust:exact;print-color-adjust:exact}}
</style></head><body>${sections}</body></html>`;
}
function printInvoiceReceipts(receipts, cur) {
  if (!receipts.length) return;
  const frame = document.createElement("iframe");
  frame.title = receipts.length === 1 ? "Invoice receipt print" : "Invoice receipts print";
  frame.style.cssText = "position:fixed;left:-10000px;top:0;width:80mm;height:1px;border:0;opacity:0;pointer-events:none;";
  let printed = false;
  let cleanupTimer = 0;
  const cleanup = () => { if (cleanupTimer) window.clearTimeout(cleanupTimer); frame.remove(); };
  frame.onload = async () => {
    if (printed) return;
    printed = true;
    const printWindow = frame.contentWindow;
    const printDocument = frame.contentDocument;
    if (!printWindow || !printDocument) { cleanup(); return; }
    await printDocument.fonts?.ready.catch(() => undefined);
    await new Promise((resolve) => window.requestAnimationFrame(() => window.requestAnimationFrame(resolve)));
    const measuredPageRules = Array.from(printDocument.querySelectorAll(".receipt")).map((receipt, index) => {
      // Keep short 80 mm receipts taller than they are wide so Windows does not rotate them.
      const heightMm = Math.max(82, Math.ceil(receipt.getBoundingClientRect().height * 25.4 / 96 + 1));
      return `@page receipt-${index}{size:80mm ${heightMm}mm;margin:0}`;
    }).join("");
    const pageRuleElement = printDocument.getElementById("receipt-page-rules");
    if (pageRuleElement) pageRuleElement.textContent = measuredPageRules;
    await new Promise((resolve) => window.requestAnimationFrame(resolve));
    printWindow.addEventListener("afterprint", cleanup, { once: true });
    printWindow.focus();
    printWindow.print();
    cleanupTimer = window.setTimeout(cleanup, 30000);
  };
  frame.srcdoc = invoiceReceiptPrintHtml(receipts, cur);
  document.body.appendChild(frame);
}
function InvoiceReceipt({ inv, cur, store, onClose }) {
  const items = normalizedReceiptItems(inv);
  const printReceipt = () => printInvoiceReceipts([{ inv, store }], cur);
  return (
    <div className="scrim" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal-head"><div className="title" style={{ fontSize: 18, display: "flex", alignItems: "center", gap: 8 }}><Receipt style={{ width: 18, height: 18 }} /> Invoice receipt</div>
          <button className="iconbtn" onClick={onClose}><X /></button></div>
        <div style={{ textAlign: "center", marginTop: 8 }}><span className="badge pend"><FileText /> {invoiceReceiptStatus(inv, cur)}</span></div>
        <div className="rcpt">
          <div className="rc-h">{store}</div>
          <div className="rc-s">{new Date(inv.ts).toLocaleString()}</div>
          <div className="rc-s">Receipt: {inv.number || inv.receiptNo}</div>
          <div className="rc-s">Cashier: {invoiceCashierName(inv)}</div>
          <div className="rc-s">Customer: {inv.customerName || "Walk-in"}</div>
          {inv.note && <div className="rc-s">Note: {inv.note}</div>}
          <div style={{ borderTop: "1px dashed var(--text)", borderBottom: "1px dashed var(--text)", margin: "8px 0", padding: "6px 0" }}>
            {items.length === 0 ? <div className="rrow"><span>No items recorded</span><span /></div> : items.map((item, index) => (
              <div key={index} style={{ paddingBottom: 4, marginBottom: 4, borderBottom: index < items.length - 1 ? "1px dotted var(--border)" : "none" }}>
                <div style={{ fontWeight: 700 }}>{item.name}</div>
                <div className="rrow" style={{ borderBottom: "none" }}><span>{item.qty} x {fmt(item.priceCents, cur)}</span><span>{fmt(item.totalCents, cur)}</span></div>
              </div>))}
          </div>
          <div className="rrow t" style={{ fontSize: 16, borderTop: "none", paddingBottom: 8 }}><span>Total</span><span>{fmt(inv.totalCents, cur)}</span></div>
          <div className="rc-s">{invoiceReceiptStatus(inv, cur)}</div>
          <div className="rc-s">Thank you.</div>
        </div>
        <div style={{ display: "flex", gap: 10 }}>
          <button className="btn btn-ghost" onClick={printReceipt}><Printer /> Print</button>
          <button className="btn btn-primary" onClick={onClose}><Check /> Close</button>
        </div>
      </div>
    </div>
  );
}

/* ================================================================== */
/*  Admin Workspace                                                   */
/* ================================================================== */
const TABS = [
  { id: "ai", label: "Ask My Business", icon: Sparkles, desc: "Ask anything — sales, stock, profit, risks, purchase orders" },
  { id: "invoices", label: "Invoices & Clearing", icon: FileText, desc: "Credit control, clearing, and cashier debts" },
  { id: "dashboard", label: "Dashboard", icon: LayoutDashboard, desc: "Today's sales, debts, and low stock at a glance" },
  { id: "products", label: "Products", icon: Tag, desc: "Catalog, prices, cost, margins, images" },
  { id: "stock", label: "Stock", icon: Boxes, desc: "Inventory count, variance, reorder status" },
  { id: "purchases", label: "Purchases", icon: ShoppingBag, desc: "Add stock, invoice verification, moving average cost" },
  { id: "suppliers", label: "Suppliers", icon: Truck, desc: "Supplier records and cost comparison" },
  { id: "branches", label: "Branches", icon: Building2, desc: "Manage shops, branch status, and branch inventory" },
  { id: "borrowing", label: "Stock Borrowing", icon: ArrowLeftRight, desc: "Move bottles between shops without sales, loss, or expense impact" },
  { id: "pricing", label: "Branch Pricing", icon: Tags, desc: "View product pricing and margins (prices set in Products)" },
  { id: "customers", label: "Customers", icon: Users, desc: "Customer records and outstanding balances" },
  { id: "cash", label: "Cash Management", icon: Wallet, desc: "Cash flow, pay-ins, and pay-outs" },
  { id: "payments", label: "Payments", icon: CreditCard, desc: "Settle and audit cashier inventory-debt balances" },
  { id: "expenses", label: "Expenses", icon: TrendingDown, desc: "Daily costs, approvals, receipts, and analytics" },
  { id: "reports", label: "Reports", icon: BarChart3, desc: "Sales, profit and loss, exports" },
  { id: "documents", label: "Documents", icon: Files, desc: "Supplier invoices, damage/loss, inventory count reports" },
  { id: "users", label: "Users & Security", icon: ShieldCheck, desc: "Employees, branch assignment, and access control" },
  { id: "settings", label: "Settings", icon: SettingsIcon, desc: "Store, currency, tax, and reorder settings" },
];
function ModulesOverview({ branches, onOpen }) {
  return (
    <div className="fade">
      <div className="wshead">Management</div>
      <div className="wstitle" style={{ fontSize: 22 }}>Admin Modules</div>
      <div className="modgrid">
        {TABS.map((t) => { const I = t.icon; return (
          <button key={t.id} className="modcard" onClick={() => onOpen(t.id)}>
            <div className="modtop"><span className="modi"><I /></span><span className="modt">{t.label}</span></div>
            <div className="modd">{t.desc}</div>
          </button>
        ); })}
      </div>
    </div>
  );
}
const NAV_TOP = [
  { id: "dashboard", label: "Dashboard", icon: LayoutDashboard },
  { id: "ai", label: "AI Assistant", icon: Sparkles },
];
// Which access right each module requires. Tabs not listed (dashboard, ai) are open to anyone with admin-area access.
const TAB_RIGHT = {
  invoices: "invoices", customers: "customers", pricing: "products",
  products: "products", stock: "stock", purchases: "purchases", borrowing: "transfers", suppliers: "suppliers",
  cash: "cash", payments: "cash", expenses: "expenses",
  branches: "branches", documents: "documents",
  reports: "financials", insights: "financials",
  users: "users", terminals: "__admin_only", settings: "settings", environment: "__admin_only", system: "__admin_only",
};
const NAV_GROUPS = [
  { id: "salesgrp", label: "Sales & Customers", icon: Receipt, items: [
    { id: "invoices", label: "Sales", icon: FileText },
    { id: "customers", label: "Customers", icon: Users },
  ] },
  { id: "invgrp", label: "Inventory", icon: Boxes, items: [
    { id: "products", label: "Products", icon: Tag },
    { id: "pricing", label: "Pricing", icon: Tags },
    { id: "stock", label: "Stock", icon: Boxes },
    { id: "purchases", label: "Purchasing", icon: ShoppingBag },
    { id: "borrowing", label: "Transfers", icon: ArrowLeftRight },
    { id: "suppliers", label: "Suppliers", icon: Truck },
  ] },
  { id: "fingrp", label: "Finance", icon: Banknote, items: [
    { id: "payments", label: "Payments", icon: CreditCard },
    { id: "cash", label: "Cash Management", icon: Wallet },
    { id: "expenses", label: "Expenses", icon: TrendingDown },
  ] },
  { id: "opsgrp", label: "Branch Operations", icon: Building2, items: [
    { id: "branches", label: "Branches", icon: Building2 },
    { id: "documents", label: "Documents", icon: Files },
  ] },
  { id: "anlgrp", label: "Analytics", icon: BarChart3, items: [
    { id: "reports", label: "Reports", icon: BarChart3 },
    { id: "insights", label: "Insights", icon: Sparkles },
  ] },
  { id: "admgrp", label: "Administration", icon: ShieldCheck, items: [
    { id: "users", label: "Users & Security", icon: ShieldCheck },
    { id: "terminals", label: "Terminals", icon: KeyRound },
    { id: "environment", label: "Environment", icon: ShieldCheck },
    { id: "system", label: "System Health", icon: RefreshCw },
    { id: "settings", label: "Settings", icon: SettingsIcon },
  ] },
];
const INSIGHT_GROUPS = [
  { title: "Sales", icon: Receipt, qs: ["Daily sales summary.", "Top 5 products by revenue.", "Average invoice value.", "Sales trend last 7 days."] },
  { title: "Stock", icon: Boxes, qs: ["Low-stock items.", "Fast-moving products.", "Stock discrepancies.", "Reorder alerts."] },
  { title: "Cashiers", icon: Users, qs: ["Invoices cleared per cashier.", "Outstanding debts per cashier.", "Cashier performance summary."] },
  { title: "Customers", icon: FileText, qs: ["Overdue invoices.", "Top customers by spend.", "Credit recovery rate."] },
  { title: "Operations", icon: SettingsIcon, qs: ["End-of-day summary.", "Offline transactions.", "Sync status log."] },
];
function InsightsTab({ data, online }) {
  const cur = data.settings.currency;
  const [q, setQ] = useState(""); const [ans, setAns] = useState("");
  const f = (c) => fmt(c, cur);
  const local = (question) => {
    const Q = question.toLowerCase();
    const activeInvoices = operationalInvoices(data);
    if (Q.includes("low-stock") || Q.includes("reorder")) { const l = reorderList(data); return l.length ? "Items at or below reorder level:\n" + l.slice(0, 12).map((p) => "• " + p.name + " — " + onHand(data, p.id) + " left (reorder " + (p.reorderLevel ?? data.settings.reorderLevel) + ")").join("\n") : "All products are above their reorder level."; }
    if (Q.includes("top 5 products") || Q.includes("top products") || Q.includes("fast-moving")) {
      const by = {};
      data.stockMovements.forEach((movement) => {
        if (typeof movement.reason !== "string" || !movement.reason.startsWith("Sale") || !saleMoveRecognized(data, movement)) return;
        const product = data.products.find((item) => item.id === movement.productId);
        if (!product) return;
        const key = `${product.id}:${movement.branchId || ""}`;
        const row = by[key] || { product, branchId: movement.branchId, qty: 0 };
        row.qty += -movement.qty;
        by[key] = row;
      });
      const rows = Object.values(by).map((row) => ({
        ...row,
        rev: row.qty * branchProductPriceCents(row.product, row.branchId),
      }));
      const byRev = Q.includes("fast") ? rows.sort((a, b) => b.qty - a.qty) : rows.sort((a, b) => b.rev - a.rev);
      return byRev.length ? "Top products:\n" + byRev.slice(0, 5).map((row, index) => (index + 1) + ". " + row.product.name + " — " + row.qty + " sold · " + f(row.rev)).join("\n") : "No cleared sales recorded yet.";
    }
    if (Q.includes("outstanding debts per cashier") || Q.includes("debts per cashier")) { const by = {}; activeInvoices.filter((i) => invIsDebt(i)).forEach((i) => { const o = invOutstanding(i); if (o > 0) by[i.cashier] = (by[i.cashier] || 0) + o; }); const rows = Object.entries(by).sort((a, b) => b[1] - a[1]); return rows.length ? "Overdue debts by cashier:\n" + rows.map(([n, v]) => "• " + n + " — " + f(v)).join("\n") : "No overdue cashier debts."; }
    if (Q.includes("invoices cleared per cashier") || Q.includes("cashier performance")) { const by = {}; activeInvoices.forEach((i) => { const k = i.cashier || "—"; by[k] = by[k] || { n: 0, sales: 0, owed: 0 }; by[k].n++; by[k].sales += i.totalCents; by[k].owed += invOutstanding(i); }); const rows = Object.entries(by).sort((a, b) => b[1].sales - a[1].sales); return rows.length ? "Cashier summary:\n" + rows.map(([n, v]) => "• " + n + " — " + v.n + " invoices · " + f(v.sales) + " sold · " + f(v.owed) + " owed").join("\n") : "No invoices yet."; }
    if (Q.includes("average invoice")) { const inv = activeInvoices; const tot = inv.reduce((s, i) => s + i.totalCents, 0); return inv.length ? "Average invoice value: " + f(Math.round(tot / inv.length)) + " across " + inv.length + " invoices." : "No invoices yet."; }
    if (Q.includes("daily sales") || Q.includes("sales trend")) { const days = []; for (let i = 6; i >= 0; i--) { const d = new Date(); d.setHours(0, 0, 0, 0); d.setDate(d.getDate() - i); const st = d.getTime(); const tot = activeInvoices.filter((x) => x.ts >= st && x.ts < st + 864e5).reduce((s, x) => s + x.totalCents, 0); days.push([d.toLocaleDateString(undefined, { weekday: "short" }), tot]); } return "Sales, last 7 days:\n" + days.map(([l, v]) => "• " + l + " — " + f(v)).join("\n"); }
    if (Q.includes("overdue") || Q.includes("credit recovery")) { const carried = activeInvoices.filter((i) => i.carriedOver); const pend = carried.filter((i) => invIsDebt(i)); const rec = carried.filter((i) => invOutstanding(i) <= 0); const rate = carried.length ? Math.round(rec.length / carried.length * 100) : 0; return carried.length ? "Carried-over invoices: " + carried.length + "\n• Overdue debts: " + pend.length + " · " + f(pend.reduce((s, i) => s + invOutstanding(i), 0)) + "\n• Recovered: " + rec.length + " (" + rate + "% recovery rate)" : "No carried-over invoices yet."; }
    if (Q.includes("top customers")) { const by = {}; activeInvoices.forEach((i) => { const k = i.customerName || "Walk-in"; by[k] = (by[k] || 0) + i.totalCents; }); const rows = Object.entries(by).sort((a, b) => b[1] - a[1]).slice(0, 5); return rows.length ? "Top customers by spend:\n" + rows.map(([n, v], i) => (i + 1) + ". " + n + " — " + f(v)).join("\n") : "No invoices yet."; }
    if (Q.includes("end-of-day") || Q.includes("end of day")) { const e = (data.endOfDays || []).slice(-1)[0]; return e ? "Last end-of-day close:\n• " + e.date + " · " + (e.branchId ? (data.branches.find((b) => b.id === e.branchId)?.name || "") : "") + "\n• Total: " + f(e.totalCents ?? e.totalSalesCents ?? 0) : "No end-of-day closings saved yet."; }
    if (Q.includes("offline transactions") || Q.includes("sync")) { const p = countPending(data); const err = data?._sync?.error; return (online ? "Online. " : "Offline. ") + (err ? "Last sync error: " + err + ". " : "") + (p ? p + " change(s) are queued locally and not yet synced." : "Everything is synced — nothing queued."); }
    if (Q.includes("discrepanc")) return "Stock discrepancies are flagged during inventory counts (Stock module). No automatic variance is recorded outside a count.";
    return online ? "Couldn't generate this insight just now — try again." : "This insight needs an internet connection. Reconnect to generate it.";
  };
  const ask = (question) => {
    setQ(question);
    setAns(local(question));
  };
  return (
    <div>
      <PageHead title="Insights" sub="Tap a question for an instant read on your business." />
      {q && (
        <div className="insans" style={{ marginBottom: 18 }}>
          <div className="qh"><Sparkles /> {q}</div>
          <div>{ans}</div>
        </div>
      )}
      <div className="insgroups">
        {INSIGHT_GROUPS.map((g) => { const I = g.icon; return (
          <div className="insgrp" key={g.title}>
            <div className="h"><I /> {g.title}</div>
            <div className="inschips">{g.qs.map((qq) => <button key={qq} className="inschip" onClick={() => ask(qq)}>{qq}</button>)}</div>
          </div>); })}
      </div>
    </div>
  );
}
function AdminWorkspace({ data, update, branch, user, role, rights, sessionToken, online, environment, onRefreshEnvironment, onCleanReset, maintenance, onRefreshMaintenance, onRunMaintenance }) {
  const [tab, setTab] = useState("dashboard");
  const [invoiceFocus, setInvoiceFocus] = useState(null);
  const [debtPaymentsOpen, setDebtPaymentsOpen] = useState(false);
  const [navCollapsed, setNavCollapsed] = useState(false);
  const accountRole = String(role || user?.role || user?.kind || "").toLowerCase();
  const isAdmin = accountRole === "admin" || accountRole === "owner";
  // Admin (owner) sees everything; everyone else is limited to their granted rights.
  const canAccess = (tabId) => { if (isAdmin) return true; if (tabId === "dashboard" || tabId === "ai") return true; const req = TAB_RIGHT[tabId]; if (req === "__admin_only") return false; return !req || hasRight(rights, req); };
  const visibleGroups = NAV_GROUPS.map((g) => ({ ...g, items: g.items.filter((it) => canAccess(it.id)) })).filter((g) => g.items.length > 0);
  const [openGroups, setOpenGroups] = useState(() => {
    const o = {}; NAV_GROUPS.forEach((g) => { o[g.id] = g.items.some((it) => it.id === "dashboard"); });
    // open the group containing the initial tab; default first group open
    NAV_GROUPS.forEach((g) => { if (g.items.some((it) => it.id === tab)) o[g.id] = true; });
    return o;
  });
  const toggleGroup = (id) => setOpenGroups((o) => ({ ...o, [id]: !o[id] }));
  // If the active tab is not permitted (e.g. after a rights change), fall back to the dashboard.
  useEffect(() => { if (!canAccess(tab)) setTab("dashboard"); }, [tab, rights, isAdmin]); // eslint-disable-line
  const cur = data.settings.currency;
  const todayRevenue = data.payments.filter((p) => isToday(p.ts) && p.status === "captured" && !invoiceIsVoided(data, paymentInvoiceId(p))).reduce((s, p) => s + p.amountCents, 0);
  const txns = operationalInvoices(data).filter((i) => isToday(i.ts)).length;
  const reorders = reorderList(data, branch.id).length;
  const pendingExpenseCount = (data.expenses || []).filter((e) => e.status === "pending").length;
  const pendingVoidCount = operationalInvoices(data)
    .filter((invoice) => invoice.branchId === branch.id && invoiceVoidState(data, invoice.id).status === "pending")
    .length;
  const openCashierCreditInvoices = (cashier) => {
    setInvoiceFocus({ cashier, filter: "debt", key: Date.now() });
    setTab("invoices");
  };
  const openDebtPayments = () => {
    if (canAccess("payments")) setDebtPaymentsOpen(true);
  };
  const NavBtn = ({ item, main }) => {
    const I = item.icon;
    const badgeCount = item.id === "expenses" ? pendingExpenseCount : item.id === "invoices" ? pendingVoidCount : 0;
    const badgeLabel = item.id === "invoices" ? "void requests pending approval" : "expenses pending approval";
    return (
      <button
        className={"navitem" + (main ? " main" : "") + (tab === item.id ? " on" : "")}
        title={badgeCount > 0 ? `${item.label}: ${badgeCount} ${badgeLabel}` : item.label}
        onClick={() => {
          if (item.id === "payments") {
            openDebtPayments();
            return;
          }
          if (item.id === "invoices") {
            setInvoiceFocus(pendingVoidCount > 0 ? { filter: "void_pending", key: Date.now() } : null);
          }
          setTab(item.id);
        }}
      >
        <I />
        <span className="navlabel">{item.label}</span>
        {badgeCount > 0 ? <span className="navbadge" aria-label={`${badgeCount} ${badgeLabel}`}>{badgeCount}</span> : null}
      </button>
    );
  };
  const render = () => {
    if (!canAccess(tab)) return <DashboardTab data={data} update={update} branch={branch} onOpenPayments={openDebtPayments} />;
    switch (tab) {
      case "dashboard": return <DashboardTab data={data} update={update} branch={branch} onOpenPayments={openDebtPayments} />;
      case "ai": return <AIManagerTab data={data} sessionToken={sessionToken} />;
      case "invoices": return <InvoicesTab key={invoiceFocus?.key || "invoices"} data={data} update={update} branch={branch} user={user} initialCashier={invoiceFocus?.cashier || "all"} initialFilter={invoiceFocus?.filter || "open"} environmentMode={normalizeEnvironmentMode(environment?.mode || data?.settings?.environmentMode || "test")} onOpenDebtPayments={openDebtPayments} />;
    case "customers": return <CustomersTab data={data} branch={branch} />;
      case "pricing": return <PricingTab data={data} update={update} branch={branch} />;
      case "products": return <ProductsTab data={data} update={update} branch={branch} isAdmin={isAdmin} />;
      case "stock": return <StockTab data={data} update={update} branch={branch} />;
      case "purchases": return <PurchasesTab data={data} update={update} branch={branch} isAdmin={isAdmin} />;
      case "borrowing": return <BorrowingTab data={data} update={update} />;
      case "suppliers": return <SuppliersTab data={data} update={update} />;
      case "cash": return <CashTab data={data} update={update} branch={branch} />;
      case "expenses": return <ExpensesTab data={data} update={update} branch={branch} user={user} />;
      case "branches": return <BranchesTab data={data} update={update} />;
      case "documents": return <DocumentsTab data={data} />;
      case "reports": return <ReportsTab key="reports" data={data} initialTab="overview" onOpenCashierCredit={openCashierCreditInvoices} />;
      case "insights": return <InsightsTab data={data} online={online} />;
      case "users": return <UsersTab data={data} update={update} isAdmin={isAdmin} />;
      case "terminals": return <TerminalsTab data={data} isAdmin={isAdmin} />;
      case "environment": return <EnvironmentTab data={data} environment={environment} role={role} onRefresh={onRefreshEnvironment} />;
      case "system": return <SystemHealthTab data={data} online={online} maintenance={maintenance} onRefresh={onRefreshMaintenance} onRunMaintenance={onRunMaintenance} />;
      case "settings": return <SettingsTab data={data} update={update} isAdmin={isAdmin} onCleanReset={onCleanReset} />;
      default: return <DashboardTab data={data} update={update} branch={branch} onOpenPayments={openDebtPayments} />;
    }
  };
  return (
    <div className={"fade adminwrap" + (navCollapsed ? " nav-collapsed" : "")}>
      <nav className={"navside" + (navCollapsed ? " collapsed" : "")}>
        <button className="navcollapse" title={navCollapsed ? "Expand menu" : "Collapse menu"} onClick={() => setNavCollapsed((c) => !c)}>{navCollapsed ? <ChevronRight /> : <ChevronLeft />}<span className="navlabel">Collapse</span></button>
        {NAV_TOP.map((item) => <NavBtn key={item.id} item={item} main />)}
        <div className="navdiv" />
        {visibleGroups.map((g) => { const GI = g.icon; const open = navCollapsed || openGroups[g.id]; return (
          <div className="navgrp" key={g.id}>
            <button className={"navsec" + (open ? " open" : "")} onClick={() => toggleGroup(g.id)} title={g.label}>
              <GI /> <span className="navlabel">{g.label}</span>
              <span className="navsec-chev navlabel">{open ? <ChevronDown /> : <ChevronRight />}</span>
            </button>
            {open && g.items.map((it) => <NavBtn key={it.id} item={it} />)}
          </div>); })}
      </nav>
      <div className="admincontent">
        {render()}
      </div>
      {debtPaymentsOpen ? <InventoryDebtPaymentModal data={data} update={update} branch={branch} user={user} onClose={() => setDebtPaymentsOpen(false)} /> : null}
    </div>
  );
}
function PageHead({ title, sub, right }) { return (<div className="page-h"><div><div className="title" style={{ fontSize: 19 }}>{title}</div>{sub && <div className="sub">{sub}</div>}</div>{right}</div>); }
function DocumentFile({ title, count = 0, meta, children, defaultOpen = false }) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <section className={"document-file" + (open ? " open" : "")}>
      <button type="button" className="document-file-head" aria-expanded={open} onClick={() => setOpen((value) => !value)}>
        <Files />
        <span className="meta"><span className="nm">{title}</span>{meta ? <span className="mt2">{meta}</span> : null}</span>
        <span className="document-file-count">{count}</span>
        <ChevronDown className="chevron" />
      </button>
      {open ? <div className="document-file-body">{children}</div> : null}
    </section>
  );
}

function CloudDataRecovery({ title, message, syncError, onSync, onSignOut }) {
  return (
    <div className="fade" style={{ minHeight: "calc(100dvh - 170px)", display: "grid", placeItems: "center", padding: 24 }}>
      <div className="poscard" style={{ maxWidth: 560, padding: 24, textAlign: "center" }}>
        <div className="title" style={{ fontSize: 22 }}>{title}</div>
        <div className="sub" style={{ marginTop: 8 }}>{message}</div>
        {syncError && <div className="alert" style={{ marginTop: 16, textAlign: "left" }}><AlertCircle />{syncError}</div>}
        <div className="grid2" style={{ marginTop: 18 }}>
          <button className="btn btn-primary" onClick={onSync}><RefreshCw />Sync now</button>
          <button className="btn btn-ghost" onClick={onSignOut}><LogOut />Sign out</button>
        </div>
      </div>
    </div>
  );
}

/* ---- Invoices & Clearing (admin/supervisor only) ---- */
function InvoicesTab({ data, update, branch, user, initialCashier = "all", initialFilter = "open", environmentMode = "test", onOpenDebtPayments }) {
  const cur = data.settings.currency;
  const [filter, setFilter] = useState(initialFilter), [query, setQuery] = useState(""), [sortMode, setSortMode] = useState("oldest");
  const [workspaceView, setWorkspaceView] = useState("invoices");
  const [cashierFilter, setCashierFilter] = useState(initialCashier);
  const [dateFrom, setDateFrom] = useState("");
  const [dateTo, setDateTo] = useState("");
  const [eod, setEod] = useState(null); // {mode:"live"} or {mode:"view", doc}
  const [bulkSettlementOpen, setBulkSettlementOpen] = useState(false);
  const [detail, setDetail] = useState(null);
  const [receipt, setReceipt] = useState(null);
  const [selectedInvoiceIds, setSelectedInvoiceIds] = useState(() => new Set());
  const invoices = operationalInvoices(data);
  const activeInvoices = invoices.filter((invoice) => invoice.branchId === branch.id);
  const voidedInvoices = (data.invoices || [])
    .filter((invoice) => invoice.branchId === branch.id && invoiceIsVoided(data, invoice))
    .map((invoice) => ({ ...invoice, carriedOver: false }));
  const displayInvoices = [...activeInvoices, ...voidedInvoices];
  const invoiceIssuedTs = (invoice) => {
    const value = invoice.ts ?? invoice.issuedAt ?? invoice.createdAt;
    const numeric = Number(value);
    if (Number.isFinite(numeric) && numeric > 0) return numeric;
    const parsed = Date.parse(value);
    return Number.isFinite(parsed) ? parsed : 0;
  };
  const dateFromTs = dateFrom ? new Date(`${dateFrom}T00:00:00`).getTime() : null;
  const dateToTs = dateTo ? new Date(`${dateTo}T23:59:59.999`).getTime() : null;
  const hasCustomDateRange = Boolean(dateFrom || dateTo);
  const branchSinceEndDay = branchLastEndDay(data, branch.id);
  const outstanding = activeInvoices.filter((i) => invOutstanding(i) > 0);
  const debtInvoices = outstanding.filter((i) => invIsDebt(i));
  const overdue = outstanding.filter((i) => invIsOverdue(i));
  const open = outstanding.filter((i) => !invIsDebt(i) && !invIsOverdue(i));
  const partialInvoices = activeInvoices.filter((invoice) => invoiceVoidState(data, invoice.id).status !== "pending"
    && Number(invoice.paidCents || 0) > 0 && invOutstanding(invoice) > 0);
  const sinceEndDay = activeInvoices.filter((i) => i.ts > branchSinceEndDay);
  const currentDayOpenInvoices = sinceEndDay.filter((invoice) => {
    const voidStatus = invoiceVoidState(data, invoice.id).status;
    return invOutstanding(invoice) > 0
      && !invIsDebt(invoice)
      && voidStatus !== "approved"
      && voidStatus !== "pending";
  });
  const branchForInvoice = (inv) => data.branches.find((b) => b.id === inv.branchId) || branch;
  const cashierNames = Array.from(new Set(branchCashiers(data, branch.id).map((cashier) => String(cashier.name || "").trim())))
    .filter(Boolean)
    .sort((a, b) => a.localeCompare(b));
  useEffect(() => {
    if (cashierFilter !== "all" && !cashierNames.includes(cashierFilter)) setCashierFilter("all");
  }, [cashierFilter, cashierNames.join("|")]); // eslint-disable-line react-hooks/exhaustive-deps
  const needle = query.trim().toLowerCase();
  const invoiceProductLines = new Map(displayInvoices.map((invoice) => [invoice.id, invoiceSoldLines(data, invoice, invoice.branchId)]));
  const invoiceProductSummary = (invoice) => Array.from(new Set((invoiceProductLines.get(invoice.id) || []).map((line) => line.name).filter(Boolean))).join(", ");
  const filtered = (filter === "voided" ? voidedInvoices : filter === "all" ? displayInvoices : activeInvoices)
    .filter((i) => {
      const voidStatus = invoiceVoidState(data, i.id).status;
      if (filter === "all") return true;
      if (filter === "voided") return voidStatus === "approved";
      if (voidStatus === "approved") return false;
      if (filter === "void_pending") return voidStatus === "pending";
      if (filter === "partial") return voidStatus !== "pending" && Number(i.paidCents || 0) > 0 && invOutstanding(i) > 0;
      if (filter === "debt") return invIsDebt(i);
      if (filter === "overdue") return invIsOverdue(i);
      if (filter === "open") return invOutstanding(i) > 0 && !invIsDebt(i) && !invIsOverdue(i);
      return invOutstanding(i) <= 0;
    })
    .filter((i) => cashierFilter === "all" || invoiceCashierName(i) === cashierFilter)
    .filter((i) => {
      const issuedTs = invoiceIssuedTs(i);
      if (dateFromTs !== null && issuedTs < dateFromTs) return false;
      if (dateToTs !== null && issuedTs > dateToTs) return false;
      return true;
    })
    .filter((i) => {
      if (!needle) return true;
      const invoiceMatch = [i.customerName, i.customerPhone, i.phone, i.number, i.receiptNo, invoiceCashierName(i)]
        .some((value) => String(value || "").toLowerCase().includes(needle));
      const productMatch = (invoiceProductLines.get(i.id) || []).some((line) => [line.name, line.sku, line.barcode, line.category]
        .some((value) => String(value || "").toLowerCase().includes(needle)));
      return invoiceMatch || productMatch;
    })
    .sort((a, b) => sortMode === "oldest" ? (a.ts || 0) - (b.ts || 0) : (b.ts || 0) - (a.ts || 0));
  const filteredBalanceDue = filtered.reduce(
    (sum, invoice) => sum + (invoiceIsVoided(data, invoice) ? 0 : invOutstanding(invoice)),
    0
  );
  const selectedInvoices = filtered.filter((invoice) => selectedInvoiceIds.has(invoice.id));
  const allFilteredSelected = filtered.length > 0 && selectedInvoices.length === filtered.length;
  const toggleInvoiceSelection = (invoiceId) => {
    setSelectedInvoiceIds((current) => {
      const next = new Set(current);
      if (next.has(invoiceId)) next.delete(invoiceId);
      else next.add(invoiceId);
      return next;
    });
  };
  const toggleAllFilteredInvoices = () => {
    setSelectedInvoiceIds((current) => {
      const next = new Set(current);
      filtered.forEach((invoice) => {
        if (allFilteredSelected) next.delete(invoice.id);
        else next.add(invoice.id);
      });
      return next;
    });
  };
  const printSelectedInvoices = () => {
    const receipts = selectedInvoices.map((invoice) => {
      const invoiceBranch = branchForInvoice(invoice);
      return {
        inv: { ...invoice, items: invoiceSoldLines(data, invoice, invoiceBranch.id) },
        store: invoiceBranch.name,
      };
    });
    printInvoiceReceipts(receipts, cur);
  };

  // Cashier debt combines End-of-Day carry-overs with audited inventory-count shortages.
  const debts = debtInvoices;
  const invoiceDebtByCashier = {};
  debts.forEach((i) => {
    const cashier = invoiceCashierName(i);
    invoiceDebtByCashier[cashier] = (invoiceDebtByCashier[cashier] || 0) + invOutstanding(i);
  });
  const branchJointDebts = (data.cashierJointDebts || [])
    .filter((debt) => debt.branchId === branch.id && cashierJointDebtOutstanding(data, debt) > 0)
    .sort((a, b) => Number(b.ts || 0) - Number(a.ts || 0));
  const missingDebtByCashier = {};
  branchJointDebts.forEach((debt) => (debt.shares || []).forEach((share) => {
    const { outstandingCents } = cashierJointDebtShareBalance(data, debt, share);
    if (outstandingCents <= 0) return;
    const name = share.cashierName || share.cashierId || "Unassigned cashier";
    const current = missingDebtByCashier[name] || { amountCents: 0, count: 0 };
    missingDebtByCashier[name] = { amountCents: current.amountCents + outstandingCents, count: current.count + 1 };
  }));
  const debtRows = Array.from(new Set([...Object.keys(invoiceDebtByCashier), ...Object.keys(missingDebtByCashier)]))
    .sort((a, b) => a.localeCompare(b))
    .map((name) => ({
      name,
      invoiceAmountCents: invoiceDebtByCashier[name] || 0,
      invoiceCount: debts.filter((invoice) => invoiceCashierName(invoice) === name).length,
      missingAmountCents: missingDebtByCashier[name]?.amountCents || 0,
      missingCount: missingDebtByCashier[name]?.count || 0,
    }));
  const closes = (data.endOfDays || []).filter((e) => e.branchId === branch.id);
  const invoiceDebtOutstanding = debtInvoices.reduce((sum, invoice) => sum + invOutstanding(invoice), 0);
  const inventoryDebtOutstanding = branchJointDebts.reduce((sum, debt) => sum + cashierJointDebtOutstanding(data, debt), 0);
  const voidPendingCount = activeInvoices.filter((invoice) => invoiceVoidState(data, invoice.id).status === "pending").length;

  return (
    <div>
      <PageHead title="Sales & Invoices" sub={`Review sales, settle balances, and close the day - ${branch.name}`}
        right={<button
          className="btn sm btn-primary"
          disabled={sinceEndDay.length === 0}
          title={sinceEndDay.length === 0 ? `There are no new invoices to close for ${branch.name}.` : "Close this branch's current invoice period"}
          onClick={() => setEod({ mode: "live" })}
        ><Check /> {sinceEndDay.length === 0 ? "Nothing to close" : "Close day"}</button>} />

      <div className="invoice-workspace-tabs" role="tablist" aria-label="Sales and invoicing sections">
        <button type="button" role="tab" aria-selected={workspaceView === "invoices"} className={workspaceView === "invoices" ? "active" : ""} onClick={() => setWorkspaceView("invoices")}><Receipt /> Invoices <span>{displayInvoices.length}</span></button>
        <button type="button" role="tab" aria-selected={workspaceView === "debts"} className={workspaceView === "debts" ? "active" : ""} onClick={() => setWorkspaceView("debts")}><CreditCard /> Debts <span>{debtRows.length}</span></button>
        <button type="button" role="tab" aria-selected={workspaceView === "closes"} className={workspaceView === "closes" ? "active" : ""} onClick={() => setWorkspaceView("closes")}><FileText /> Day closes <span>{closes.length}</span></button>
      </div>

      {workspaceView === "invoices" && <div className="invoice-workspace-view">
        <div className="invoice-compact-summary">
          <div><b>{filtered.length}</b><span>invoices shown</span></div>
          <div><b className={filteredBalanceDue > 0 ? "danger" : ""}>{fmt(filteredBalanceDue, cur)}</b><span>balance due</span></div>
          <button
            className="btn sm btn-ghost"
            disabled={currentDayOpenInvoices.length === 0}
            title={currentDayOpenInvoices.length === 0 ? `There are no unpaid current-day invoices for ${branch.name}.` : `Settle ${currentDayOpenInvoices.length} current-day invoice(s)`}
            onClick={() => setBulkSettlementOpen(true)}
          ><Check /> {currentDayOpenInvoices.length === 0 ? "Day invoices paid" : "Mark day invoices paid"}</button>
        </div>

        <div className="invoice-filter-grid simple">
          <div className="settlesearch"><Search /><input className="input" placeholder="Search customer, product, barcode, phone, or receipt" value={query} onChange={(e) => setQuery(e.target.value)} /></div>
          <select className="select" value={filter} onChange={(e) => setFilter(e.target.value)} aria-label="Filter invoices by status">
            <option value="open">Open ({open.length})</option>
            <option value="partial">Partially paid ({partialInvoices.length})</option>
            <option value="overdue">Overdue ({overdue.length})</option>
            <option value="debt">Debts ({debtInvoices.length})</option>
            <option value="void_pending">Void pending ({voidPendingCount})</option>
            <option value="paid">Paid</option>
            <option value="voided">Voided ({voidedInvoices.length})</option>
            <option value="all">All invoices ({displayInvoices.length})</option>
          </select>
          <select className="select" value={cashierFilter} onChange={(e) => setCashierFilter(e.target.value)} aria-label="Filter invoices by cashier">
            <option value="all">All cashiers</option>
            {cashierNames.map((name) => <option key={name} value={name}>{name}</option>)}
          </select>
        </div>

        <details className="invoice-more-filters">
          <summary>{hasCustomDateRange ? "More filters - custom dates active" : "More filters"}</summary>
          <div className="invoice-more-filter-grid">
            <label><span>Sort</span><select className="select" value={sortMode} onChange={(e) => setSortMode(e.target.value)} aria-label="Sort invoices"><option value="oldest">Oldest first</option><option value="newest">Newest first</option></select></label>
            <label><span>From date</span><input className="input" type="date" value={dateFrom} max={dateTo || undefined} onChange={(e) => setDateFrom(e.target.value)} /></label>
            <label><span>To date</span><input className="input" type="date" value={dateTo} min={dateFrom || undefined} onChange={(e) => setDateTo(e.target.value)} /></label>
            {hasCustomDateRange ? <button className="btn sm btn-ghost" type="button" onClick={() => { setDateFrom(""); setDateTo(""); }}>Clear dates</button> : null}
          </div>
        </details>

        {selectedInvoices.length > 0 && <div className="invoice-selection-bar">
          <div><b>{selectedInvoices.length} selected</b><span>{fmt(selectedInvoices.reduce((sum, invoice) => sum + Number(invoice.totalCents || 0), 0), cur)} total</span></div>
          <div>
            <button type="button" className="btn sm btn-ghost" onClick={() => setSelectedInvoiceIds(new Set())}>Clear selection</button>
            <button type="button" className="btn sm btn-primary" onClick={printSelectedInvoices}><Printer /> Print selected</button>
          </div>
        </div>}

        {filtered.length === 0 ? <div className="notice">No invoices match these filters.</div> : (
          <div className="tablewrap tblscroll lg invoice-table-wrap"><table className="tbl invoice-table">
            <thead><tr><th style={{ width: 44 }}><input type="checkbox" aria-label="Select all visible invoices" checked={allFilteredSelected} onChange={toggleAllFilteredInvoices} /></th><th>Invoice</th><th>Customer & products</th><th>Cashier</th><th className="amt">Total</th><th className="amt">Balance</th><th>Status</th></tr></thead>
            <tbody>{filtered.map((inv) => <InvoiceRow key={inv.id} inv={inv} products={invoiceProductSummary(inv)} cur={cur} voidInfo={invoiceVoidState(data, inv.id)} selected={selectedInvoiceIds.has(inv.id)} onToggle={() => toggleInvoiceSelection(inv.id)} onOpen={() => setDetail(inv)} />)}</tbody>
          </table></div>
        )}
      </div>}

      {workspaceView === "debts" && <div className="invoice-workspace-view">
        <div className="invoice-summary-strip three">
          <div><span>Invoice debts</span><b>{fmt(invoiceDebtOutstanding, cur)}</b></div>
          <div><span>Inventory debts</span><b>{fmt(inventoryDebtOutstanding, cur)}</b></div>
          <div><span>Total cashier debt</span><b className={invoiceDebtOutstanding + inventoryDebtOutstanding > 0 ? "danger" : ""}>{fmt(invoiceDebtOutstanding + inventoryDebtOutstanding, cur)}</b></div>
        </div>
        <div className="invoice-section-head">
          <div><div className="section-title">Cashier debt accounts</div><div className="muted">Carried-over invoices and audited inventory shortages are shown separately.</div></div>
          <button className="btn sm btn-primary" disabled={branchJointDebts.length === 0} onClick={onOpenDebtPayments}><CreditCard /> Settle inventory debts</button>
        </div>
        <div className="invsummary debt-summary">
          <section>
            <div className="section-title">Cashier balances</div>
            {debtRows.length === 0 ? <div className="notice">No cashier invoice or missing inventory debts.</div> : (
              <div className="list mini">{debtRows.map((row) => (
                <div className="row" key={row.name}><div className="avatar" style={{ background: "linear-gradient(135deg,#E64368,#A66BFF)" }}>{row.name.charAt(0)}</div>
                  <div className="meta"><div className="nm">{row.name}</div><div className="mt2">Invoices {fmt(row.invoiceAmountCents, cur)} - inventory {fmt(row.missingAmountCents, cur)}</div></div>
                  <span className="pill plain" style={{ color: "#C23A56" }}>{fmt(row.invoiceAmountCents + row.missingAmountCents, cur)} owed</span></div>))}</div>
            )}
          </section>
          <section>
            <div className="section-title">Inventory count records</div>
            {branchJointDebts.length === 0 ? <div className="notice">No missing inventory debt has been recorded for {branch.name}.</div> : (
              <div className="list mini inventory-debt-list">{branchJointDebts.map((debt) => (
                <details className="row" key={debt.id} style={{ display: "block" }}>
                  <summary style={{ display: "flex", alignItems: "center", gap: 10, cursor: "pointer", listStyle: "none" }}>
                    <div className="avatar"><Boxes style={{ width: 17, height: 17 }} /></div>
                    <div className="meta"><div className="nm">{debt.stockCountCode}</div><div className="mt2">{debt.shortageUnits} missing unit(s) - {debt.cashierCount || 0} cashier(s) - {dt(debt.ts)}</div></div>
                    <span className="pill plain" style={{ color: "#C23A56" }}>{fmt(cashierJointDebtOutstanding(data, debt), cur)}</span>
                  </summary>
                  <div className="inventory-debt-detail">
                    {(debt.items || []).map((item) => <div className="mt2" key={item.productId}>{item.productName} - {item.missingQty} x {fmt(item.unitCostCents, cur)} = {fmt(item.amountCents, cur)}</div>)}
                    {(debt.shares || []).map((share) => {
                      const balance = cashierJointDebtShareBalance(data, debt, share);
                      return <div className="mt2" key={share.cashierId}><b>{share.cashierName}</b> - assigned {fmt(balance.assignedCents, cur)} - paid {fmt(balance.paidCents, cur)} - balance {fmt(balance.outstandingCents, cur)}</div>;
                    })}
                    {debt.cashierCount === 0 && <div className="alert"><AlertCircle />No active cashier was assigned when this count was committed. The debt remains unallocated.</div>}
                  </div>
                </details>
              ))}</div>
            )}
          </section>
        </div>
      </div>}

      {workspaceView === "closes" && <div className="invoice-workspace-view">
        <div className="invoice-summary-strip three">
          <div><span>Invoices since last close</span><b>{sinceEndDay.length}</b></div>
          <div><span>Current period sales</span><b>{fmt(sinceEndDay.reduce((sum, invoice) => sum + Number(invoice.totalCents || 0), 0), cur)}</b></div>
          <div><span>Open before close</span><b className={currentDayOpenInvoices.length > 0 ? "warn" : ""}>{currentDayOpenInvoices.length}</b></div>
        </div>
        <div className="invoice-section-head">
          <div><div className="section-title">End of Day history</div><div className="muted">Saved closing reports for {branch.name}.</div></div>
        </div>
        {sinceEndDay.length === 0 ? <div className="notice compact-notice">No new invoice sales since the last End of Day close.</div> : <div className="notice compact-notice">{sinceEndDay.length} invoice(s) are ready for the next End of Day close.</div>}
        {closes.length === 0 ? <div className="notice">No End of Day closes saved yet for this branch.</div> : (
          <div className="list day-close-list">{closes.map((e) => (
            <div className="row" key={e.id}><div className="avatar"><FileText style={{ width: 17, height: 17 }} /></div>
              <div className="meta"><div className="nm">{e.date} - {e.time}</div><div className="mt2">{e.transactions} sale(s) - closed by {e.closedBy}</div></div>
              <span className="pill plain">{fmt(e.totalSalesCents, cur)}</span>
              <button className="btn xs btn-ghost" onClick={() => setEod({ mode: "view", doc: e })}>View / Print</button></div>))}</div>
        )}
      </div>}

      {eod && <EndOfDayModal data={data} update={update} branch={branch} user={user} doc={eod.doc} onClose={() => setEod(null)} />}
      {bulkSettlementOpen && <BulkSettleDayModal
        invoices={currentDayOpenInvoices}
        activeCashierNames={cashierNames}
        initialCashier={cashierFilter}
        branch={branch}
        update={update}
        cur={cur}
        user={user}
        onClose={() => setBulkSettlementOpen(false)}
      />}
      {detail && <InvoiceDetailModal inv={detail} data={data} update={update} cur={cur} user={user} onReprint={(live) => setReceipt(live)} onClose={() => setDetail(null)} />}
      {receipt && <InvoiceReceipt inv={receipt} cur={cur} store={branchForInvoice(receipt).name} location={branchForInvoice(receipt).location} till={branchForInvoice(receipt).mpesaTill || data.settings.mpesaTill} environmentMode={environmentMode} onClose={() => setReceipt(null)} />}
    </div>
  );
}

function DebtPaymentsTab({ data, update, branch, user, compact = false, onSettled }) {
  const cur = data.settings.currency;
  const balances = cashierJointDebtCashierBalances(data, branch.id);
  const openBalances = balances.filter((row) => row.outstandingCents > 0);
  const [selectedCashierId, setSelectedCashierId] = useState(openBalances[0]?.cashierId || balances[0]?.cashierId || "");
  const selected = balances.find((row) => row.cashierId === selectedCashierId) || null;
  const openDebtAllocations = selected ? [...selected.allocations]
    .filter((allocation) => allocation.outstandingCents > 0)
    .sort((a, b) => Number(a.debt.ts || 0) - Number(b.debt.ts || 0)) : [];
  const openDebtKey = openDebtAllocations.map((allocation) => `${allocation.debt.id}:${allocation.outstandingCents}`).join("|");
  const [selectedDebtIds, setSelectedDebtIds] = useState(() => new Set());
  const selectedAllocations = openDebtAllocations.filter((allocation) => selectedDebtIds.has(allocation.debt.id));
  const selectedDebtTotal = selectedAllocations.reduce((sum, allocation) => sum + allocation.outstandingCents, 0);
  const [amount, setAmount] = useState("");
  const [method, setMethod] = useState("m-pesa");
  const [reference, setReference] = useState("");
  const [note, setNote] = useState("");
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  const actorName = typeof user === "string"
    ? user
    : (user?.name || user?.displayName || user?.email || "Supervisor");
  const paymentCents = clampPaymentCents(amount, selectedDebtTotal);
  const branchPayments = (data.cashierJointDebtPayments || [])
    .filter((payment) => payment.branchId === branch.id && (!payment.status || payment.status === "captured"))
    .sort((a, b) => Number(b.ts || 0) - Number(a.ts || 0));
  useEffect(() => {
    if (selectedCashierId && balances.some((row) => row.cashierId === selectedCashierId)) return;
    setSelectedCashierId(openBalances[0]?.cashierId || balances[0]?.cashierId || "");
  }, [balances, openBalances, selectedCashierId]);
  useEffect(() => {
    setSelectedDebtIds(new Set());
    setAmount("");
    setReference("");
    setNote("");
    setError("");
  }, [selectedCashierId, openDebtKey]);

  const replaceDebtSelection = (nextIds) => {
    const nextTotal = openDebtAllocations
      .filter((allocation) => nextIds.has(allocation.debt.id))
      .reduce((sum, allocation) => sum + allocation.outstandingCents, 0);
    setSelectedDebtIds(nextIds);
    setAmount(moneyInputValue(nextTotal));
    setError("");
  };
  const toggleDebt = (debtId) => {
    const nextIds = new Set(selectedDebtIds);
    if (nextIds.has(debtId)) nextIds.delete(debtId);
    else nextIds.add(debtId);
    replaceDebtSelection(nextIds);
  };
  const selectAllDebts = () => replaceDebtSelection(new Set(openDebtAllocations.map((allocation) => allocation.debt.id)));
  const clearDebtSelection = () => replaceDebtSelection(new Set());

  const recordPayment = () => {
    if (!selected || selected.outstandingCents <= 0) return;
    if (selectedAllocations.length === 0) {
      setError("Select at least one inventory debt to clear.");
      return;
    }
    if (paymentCents <= 0) {
      setError("Enter a payment amount greater than zero.");
      return;
    }
    let remaining = paymentCents;
    const ts = now();
    const paymentBatchId = uid("inventory-debt-payment");
    const allocations = selectedAllocations;
    const payments = [];
    allocations.forEach((allocation) => {
      if (remaining <= 0) return;
      const amountCents = Math.min(remaining, allocation.outstandingCents);
      payments.push({
        id: uid("cjdp"),
        debtId: allocation.debt.id,
        stockCountCode: allocation.debt.stockCountCode,
        branchId: branch.id,
        cashierId: selected.cashierId,
        cashierName: selected.cashierName,
        amountCents,
        method,
        reference: reference.trim(),
        note: note.trim(),
        status: "captured",
        recordedBy: actorName,
        paymentBatchId,
        ts,
        synced: false,
      });
      remaining -= amountCents;
    });
    if (remaining !== 0 || payments.reduce((sum, payment) => sum + payment.amountCents, 0) !== paymentCents) {
      setError("The payment could not be allocated exactly. Refresh the balances and retry.");
      return;
    }
    update((current) => ({
      ...current,
      cashierJointDebtPayments: [...(current.cashierJointDebtPayments || []), ...payments],
    }));
    setMessage(`${fmt(paymentCents, cur)} recorded against ${payments.length} selected inventory debt${payments.length === 1 ? "" : "s"} for ${selected.cashierName}.`);
    setError("");
    onSettled?.();
  };

  const paymentMethods = [
    { id: "m-pesa", label: "M-Pesa", Icon: Smartphone },
    { id: "payroll", label: "Payroll", Icon: Wallet },
  ];

  return (
    <div className="inventory-payment-page">
      {!compact ? <PageHead title="Settle inventory debt" sub={branch.name} /> : null}

      {message ? <div className="notice compact-notice">{message}</div> : null}
      {balances.length === 0 ? <div className="notice">No inventory debt has been assigned at {branch.name}.</div> : (
        <section className={"inventory-payment-workspace" + (compact ? "" : " panel")}>
          <div className="inventory-payment-toolbar">
            <span>{openBalances.length} cashier balance{openBalances.length === 1 ? "" : "s"} outstanding</span>
            <label className="inventory-payment-cashier"><span>Cashier</span>
              <select className="select" value={selectedCashierId} onChange={(event) => { setSelectedCashierId(event.target.value); setMessage(""); }}>
                {balances.map((row) => <option key={row.cashierId} value={row.cashierId}>{row.cashierName} - {row.outstandingCents > 0 ? `${fmt(row.outstandingCents, cur)} due` : "paid"}</option>)}
              </select>
            </label>
          </div>

          {!selected ? <div className="notice">Select a cashier balance to continue.</div> : (
            <>
              <div className="inventory-selected-cashier">
                <div className="avatar" style={{ background: "var(--accent)" }}>{selected.cashierName.charAt(0)}</div>
                <div className="meta"><div className="nm">{selected.cashierName}</div><div className="mt2">{selected.debtCount} inventory debt{selected.debtCount === 1 ? "" : "s"}</div></div>
                <div className="metric due"><span>Balance</span><b>{fmt(selected.outstandingCents, cur)}</b></div>
              </div>

              {selected.outstandingCents <= 0 ? <div className="notice">This cashier's inventory debt is fully paid.</div> : (
                <>
                  <div className="inventory-debt-picker">
                    <div className="inventory-debt-picker-head">
                      <div><b>Choose debts to settle</b><span>{openDebtAllocations.length} unpaid record{openDebtAllocations.length === 1 ? "" : "s"}</span></div>
                      <button type="button" className="btn sm btn-ghost" onClick={selectedAllocations.length === openDebtAllocations.length ? clearDebtSelection : selectAllDebts}>
                        {selectedAllocations.length === openDebtAllocations.length ? "Clear selection" : "Select all"}
                      </button>
                    </div>
                    <div className="inventory-debt-list">
                      {openDebtAllocations.map((allocation) => {
                        const checked = selectedDebtIds.has(allocation.debt.id);
                        const source = allocation.debt.source === "quick_inventory" ? "Quick inventory" : "Stock count";
                        return <label className={"inventory-debt-choice" + (checked ? " selected" : "")} key={allocation.debt.id}>
                          <input type="checkbox" aria-label={`Select ${allocation.debt.stockCountCode || allocation.debt.id}`} checked={checked} onChange={() => toggleDebt(allocation.debt.id)} />
                          <span className="meta"><b>{allocation.debt.stockCountCode || allocation.debt.id}</b><span>{source} - {allocation.debt.shortageUnits || 0} missing unit{Number(allocation.debt.shortageUnits || 0) === 1 ? "" : "s"} - {dt(allocation.debt.ts)}</span></span>
                          <span className="amount"><b>{fmt(allocation.outstandingCents, cur)}</b>{allocation.paidCents > 0 ? <span>{fmt(allocation.paidCents, cur)} paid</span> : null}</span>
                        </label>;
                      })}
                    </div>
                    <div className="inventory-debt-selection"><span>{selectedAllocations.length} of {openDebtAllocations.length} debt{openDebtAllocations.length === 1 ? "" : "s"} selected</span><b>{fmt(selectedDebtTotal, cur)}</b></div>
                  </div>

                  <div className="inventory-payment-form">
                    <div className="inventory-payment-form-head"><b>Record payment</b><span>{selectedAllocations.length} debt{selectedAllocations.length === 1 ? "" : "s"} selected</span></div>
                    <div className="inventory-payment-methods" role="radiogroup" aria-label="Payment method">
                      {paymentMethods.map(({ id, label, Icon }) => <button type="button" key={id} role="radio" aria-checked={method === id} className={"invoice-method" + (method === id ? " on" : "")} onClick={() => setMethod(id)}><Icon />{label}</button>)}
                    </div>
                    <div className="inventory-payment-entry">
                      <label><span>Amount to pay ({cur})</span><input className="input" inputMode="decimal" value={amount} onChange={(event) => { setAmount(event.target.value.replace(/[^\d.]/g, "")); setError(""); }} placeholder="0.00" /></label>
                      <button type="button" className="btn sm btn-ghost" onClick={() => setAmount(moneyInputValue(selectedDebtTotal))} disabled={selectedDebtTotal <= 0}>Full</button>
                    </div>
                    <details className="invoice-detail-disclosure inventory-payment-options">
                      <summary><span>Add reference or note</span><ChevronDown /></summary>
                      <div className="grid2">
                        <div><label className="label">Reference</label><input className="input" value={reference} onChange={(event) => setReference(event.target.value)} placeholder="Receipt or transaction reference" /></div>
                        <div><label className="label">Note</label><input className="input" value={note} onChange={(event) => setNote(event.target.value)} placeholder="Optional settlement note" /></div>
                      </div>
                    </details>
                    {error ? <div className="formerr" style={{ marginTop: 10 }}>{error}</div> : null}
                    <button className="btn btn-primary inventory-payment-action" disabled={selectedAllocations.length === 0 || paymentCents <= 0} onClick={recordPayment}><Check /> Record {fmt(paymentCents, cur)}</button>
                  </div>
                </>
              )}
            </>
          )}
        </section>
      )}

      {!compact ? <details className="panel inventory-payment-history">
        <summary><span>Payment history <b>{branchPayments.length}</b></span><ChevronDown /></summary>
        {branchPayments.length === 0 ? <div className="notice" style={{ marginBottom: 16 }}>No inventory-debt payments have been recorded yet.</div> : (
          <div className="tablewrap tblscroll"><table className="tbl"><thead><tr><th>Date</th><th>Cashier</th><th>Debt</th><th>Method</th><th>Reference</th><th>Recorded by</th><th className="amt">Amount</th></tr></thead>
            <tbody>{branchPayments.map((payment) => <tr key={payment.id}><td>{dt(payment.ts)}</td><td>{payment.cashierName || payment.cashierId}</td><td className="innum">{payment.stockCountCode || payment.debtId}</td><td>{payment.method || "cash"}</td><td>{payment.reference || payment.note || "-"}</td><td>{payment.recordedBy || "Supervisor"}</td><td className="amt">{fmt(payment.amountCents, cur)}</td></tr>)}</tbody>
          </table></div>
        )}
      </details> : null}
    </div>
  );
}

function InventoryDebtPaymentModal({ data, update, branch, user, onClose }) {
  return (
    <div className="scrim" onClick={onClose}>
      <div className="modal inventory-payment-modal" onClick={(event) => event.stopPropagation()}>
        <div className="modal-head">
          <div><div className="title" style={{ fontSize: 18 }}>Settle inventory debt</div><div className="sub">{branch.name}</div></div>
          <button type="button" className="iconbtn" aria-label="Close inventory debt payment" onClick={onClose}><X /></button>
        </div>
        <DebtPaymentsTab data={data} update={update} branch={branch} user={user} compact onSettled={onClose} />
      </div>
    </div>
  );
}

function BulkSettleDayModal({ invoices, activeCashierNames = [], initialCashier = "all", branch, update, cur, user, onClose }) {
  const invoiceCashierNames = new Set(invoices.map(invoiceCashierName).filter(Boolean));
  const cashierNames = activeCashierNames.filter((name) => invoiceCashierNames.has(name));
  const defaultCashier = initialCashier !== "all" && cashierNames.includes(initialCashier) ? initialCashier : "all";
  const initialVisibleInvoices = invoices.filter((invoice) => defaultCashier === "all" || invoiceCashierName(invoice) === defaultCashier);
  const [cashierFilter, setCashierFilter] = useState(defaultCashier);
  const visibleInvoices = invoices.filter((invoice) => cashierFilter === "all" || invoiceCashierName(invoice) === cashierFilter);
  const [selectedIds, setSelectedIds] = useState(() => new Set(initialVisibleInvoices.map((invoice) => invoice.id)));
  const selectedInvoices = visibleInvoices.filter((invoice) => selectedIds.has(invoice.id));
  const totalCents = selectedInvoices.reduce((sum, invoice) => sum + invOutstanding(invoice), 0);
  const [mpesaAmount, setMpesaAmount] = useState(() => moneyInputValue(initialVisibleInvoices.reduce((sum, invoice) => sum + invOutstanding(invoice), 0)));
  const [cashAmount, setCashAmount] = useState("0");
  const [error, setError] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const submittingRef = useRef(false);
  const cashCents = clampPaymentCents(cashAmount, totalCents);
  const mpesaCents = clampPaymentCents(mpesaAmount, totalCents);
  const allocationMatches = cashCents + mpesaCents === totalCents;
  const actorName = typeof user === "string"
    ? user
    : (user?.name || user?.displayName || user?.email || "Supervisor");

  const replaceSelection = (nextIds) => {
    const nextTotal = invoices
      .filter((invoice) => nextIds.has(invoice.id))
      .reduce((sum, invoice) => sum + invOutstanding(invoice), 0);
    setSelectedIds(nextIds);
    setMpesaAmount(moneyInputValue(nextTotal));
    setCashAmount("0");
    setError("");
  };
  const changeCashier = (nextCashier) => {
    const nextInvoices = invoices.filter((invoice) => nextCashier === "all" || invoiceCashierName(invoice) === nextCashier);
    setCashierFilter(nextCashier);
    replaceSelection(new Set(nextInvoices.map((invoice) => invoice.id)));
  };
  const toggleInvoice = (invoiceId) => {
    const nextIds = new Set(selectedIds);
    if (nextIds.has(invoiceId)) nextIds.delete(invoiceId);
    else nextIds.add(invoiceId);
    replaceSelection(nextIds);
  };
  const toggleAll = () => {
    const allVisibleSelected = visibleInvoices.length > 0 && visibleInvoices.every((invoice) => selectedIds.has(invoice.id));
    const nextIds = new Set(selectedIds);
    visibleInvoices.forEach((invoice) => {
      if (allVisibleSelected) nextIds.delete(invoice.id);
      else nextIds.add(invoice.id);
    });
    replaceSelection(nextIds);
  };

  const balanceFromCash = (value) => {
    const nextCash = clampPaymentCents(value, totalCents);
    setCashAmount(moneyInputValue(nextCash));
    setMpesaAmount(moneyInputValue(totalCents - nextCash));
    setError("");
  };
  const balanceFromMpesa = (value) => {
    const nextMpesa = clampPaymentCents(value, totalCents);
    setMpesaAmount(moneyInputValue(nextMpesa));
    setCashAmount(moneyInputValue(totalCents - nextMpesa));
    setError("");
  };

  const settleInvoices = () => {
    if (submittingRef.current || selectedInvoices.length === 0 || totalCents <= 0) return;
    if (!allocationMatches) {
      setError(`Cash and M-Pesa must total exactly ${fmt(totalCents, cur)}.`);
      return;
    }

    submittingRef.current = true;
    setSubmitting(true);
    setError("");
    const ts = now();
    const batchId = uid("day-settlement");
    let cashRemaining = cashCents;
    let mpesaRemaining = mpesaCents;
    const invoiceIds = new Set(selectedInvoices.map((invoice) => invoice.id));
    const paymentRecords = [];
    const invoiceMethods = new Map();

    selectedInvoices.forEach((invoice) => {
      let due = invOutstanding(invoice);
      const methods = [];
      const mpesaPart = Math.min(due, mpesaRemaining);
      if (mpesaPart > 0) {
        paymentRecords.push({
          id: uid("pay"), orderId: invoice.id, invoiceId: invoice.id, branchId: invoice.branchId,
          method: "m-pesa", amountCents: mpesaPart, status: "captured", recordedBy: user,
          settledBy: user, settledByName: actorName, ts, synced: false, bulkSettlementId: batchId,
        });
        methods.push("M-Pesa");
        mpesaRemaining -= mpesaPart;
        due -= mpesaPart;
      }
      const cashPart = Math.min(due, cashRemaining);
      if (cashPart > 0) {
        paymentRecords.push({
          id: uid("pay"), orderId: invoice.id, invoiceId: invoice.id, branchId: invoice.branchId,
          method: "cash", amountCents: cashPart, status: "captured", recordedBy: user,
          settledBy: user, settledByName: actorName, ts, synced: false, bulkSettlementId: batchId,
        });
        methods.push("Cash");
        cashRemaining -= cashPart;
        due -= cashPart;
      }
      invoiceMethods.set(invoice.id, methods.join(" + "));
    });

    const allocatedCents = paymentRecords.reduce((sum, payment) => sum + payment.amountCents, 0);
    if (cashRemaining !== 0 || mpesaRemaining !== 0 || allocatedCents !== totalCents) {
      submittingRef.current = false;
      setSubmitting(false);
      setError("The payment allocation could not be applied exactly. Review the amounts and retry.");
      return;
    }

    update((data) => ({
      ...data,
      invoices: data.invoices.map((invoice) => invoiceIds.has(invoice.id) ? {
        ...invoice,
        paidCents: Number(invoice.totalCents || 0),
        carriedOver: false,
        method: invoiceMethods.get(invoice.id) || invoice.method,
        lastSettledBy: user,
        lastSettledAt: ts,
        settledBy: user,
        settledByName: actorName,
        settledAt: ts,
        status: "paid",
        synced: false,
        bulkSettlementId: batchId,
      } : invoice),
      payments: [...(data.payments || []), ...paymentRecords],
    }));
    onClose();
  };

  return (
    <div className="scrim" onClick={onClose}>
      <div className="modal settlement-modal" onClick={(event) => event.stopPropagation()}>
        <div className="modal-head">
          <div>
            <div className="sub" style={{ margin: 0 }}>Supervisor bulk settlement</div>
            <div className="title" style={{ fontSize: 20 }}>Mark all day invoices paid</div>
          </div>
          <button className="iconbtn" onClick={onClose} aria-label="Close"><X /></button>
        </div>

        <div className="notice">
          Select the paid invoices for {cashierFilter === "all" ? "all cashiers" : cashierFilter} at {branch.name}. The selected balance is <b>{fmt(totalCents, cur)}</b>.
          Carried-over debts and void requests are excluded.
        </div>

        <div style={{ marginTop: 14 }}>
          <label className="label" htmlFor="bulk-settlement-cashier">Cashier to settle</label>
          <select id="bulk-settlement-cashier" className="select" value={cashierFilter} onChange={(event) => changeCashier(event.target.value)}>
            <option value="all">All cashiers</option>
            {cashierNames.map((name) => <option key={name} value={name}>{name}</option>)}
          </select>
        </div>

        <div className="tablewrap" style={{ marginTop: 14, maxHeight: 230, overflowY: "auto" }}>
          <table className="tbl">
            <thead><tr>
              <th style={{ width: 44 }}><input type="checkbox" aria-label="Select all invoices"
                checked={visibleInvoices.length > 0 && visibleInvoices.every((invoice) => selectedIds.has(invoice.id))}
                onChange={toggleAll} /></th>
              <th>Customer</th><th>Receipt</th><th>Cashier</th><th className="amt">Balance</th>
            </tr></thead>
            <tbody>{visibleInvoices.map((invoice) => (
              <tr key={invoice.id} className="clickable" onClick={() => toggleInvoice(invoice.id)}>
                <td><input type="checkbox" aria-label={`Select ${invoice.number || invoice.receiptNo}`}
                  checked={selectedIds.has(invoice.id)}
                  onClick={(event) => event.stopPropagation()}
                  onChange={() => toggleInvoice(invoice.id)} /></td>
                <td>{invoice.customerName || "Walk-in"}</td>
                <td className="innum">{invoice.number || invoice.receiptNo}</td>
                <td>{invoiceCashierName(invoice)}</td>
                <td className="amt">{fmt(invOutstanding(invoice), cur)}</td>
              </tr>
            ))}</tbody>
          </table>
        </div>

        {selectedInvoices.length === 0 ? <div className="formerr" style={{ marginTop: 10 }}>Select at least one invoice to settle.</div> : null}

        <div className="grid2" style={{ marginTop: 14 }}>
          <div>
            <label className="label">M-Pesa paid (primary)</label>
            <input className="input" inputMode="decimal" value={mpesaAmount}
              onChange={(event) => balanceFromMpesa(event.target.value.replace(/[^\d.]/g, ""))} />
          </div>
          <div>
            <label className="label">Cash paid</label>
            <input className="input" inputMode="decimal" value={cashAmount}
              onChange={(event) => balanceFromCash(event.target.value.replace(/[^\d.]/g, ""))} />
          </div>
        </div>

        <div className="settlement-totals" style={{ marginTop: 14 }}>
          <div><span>M-Pesa</span><b>{fmt(mpesaCents, cur)}</b></div>
          <div><span>Cash</span><b>{fmt(cashCents, cur)}</b></div>
          <div className="due"><span>Allocation total</span><b>{fmt(cashCents + mpesaCents, cur)}</b></div>
        </div>

        <div className="alert" style={{ marginTop: 14 }}>
          This records captured payments against every included invoice and marks them paid. The supervisor, time, method, and batch remain in the audit trail.
        </div>
        {error ? <div className="formerr" style={{ marginTop: 10 }}>{error}</div> : null}

        <div className="grid2" style={{ marginTop: 16 }}>
          <button className="btn btn-ghost" onClick={onClose} disabled={submitting}>Cancel</button>
          <button className="btn btn-primary" onClick={settleInvoices}
            disabled={submitting || selectedInvoices.length === 0 || totalCents <= 0 || !allocationMatches}>
            <Check /> {submitting ? "Recording..." : `Mark ${selectedInvoices.length} paid`}
          </button>
        </div>
      </div>
    </div>
  );
}

function EndOfDayModal({ data, update, branch, user, doc, onClose }) {
  const cur = data.settings.currency;
  const [counted, setCounted] = useState("");
  const [note, setNote] = useState("");
  const [bId, setBId] = useState(branch.id);
  const [cashierFilter, setCashierFilter] = useState("all");
  const [closeError, setCloseError] = useState("");
  const [closing, setClosing] = useState(false);
  const closingRef = useRef(false);
  const effBranch = data.branches.find((b) => b.id === bId) || branch;
  const live = !doc;
  const isApprovedExpense = (e) => !e.status || e.status === "approved";
  const activeCartSources = [
    ...(Array.isArray(data.activeCarts) ? data.activeCarts : []),
    ...(Array.isArray(data.terminalCarts) ? data.terminalCarts : []),
    ...(Array.isArray(data.cashierCarts) ? data.cashierCarts : []),
  ];
  const cartItemCount = (cart) => {
    if (Array.isArray(cart.items)) return cart.items.length;
    if (Array.isArray(cart.cart?.items)) return cart.cart.items.length;
    if (Array.isArray(cart.lines)) return cart.lines.length;
    if (Array.isArray(cart.cartLines)) return cart.cartLines.length;
    return Number(cart.itemCount || cart.itemsCount || 0);
  };
  const activeCarts = live ? activeCartSources.filter((cart) => {
    const cartBranchId = cart.branchId || cart.branch_id || cart.branch?.id;
    return (!cartBranchId || cartBranchId === bId) && cartItemCount(cart) > 0;
  }) : [];
  const terminalName = (cart) => cart.terminalName || cart.terminal_name || cart.deviceName || cart.cashierName || cart.cashier || "Unknown terminal";

  let d;
  let reportInvoices = [];
  if (doc) {
    d = doc;
    if (Array.isArray(doc.invoiceSnapshots) && doc.invoiceSnapshots.length > 0) {
      reportInvoices = doc.invoiceSnapshots;
    } else {
      const reportStart = Number(doc.periodStartedAt || 0);
      const reportEnd = Number(doc.periodEndedAt || doc.closedAt || doc.ts || Number.MAX_SAFE_INTEGER);
      reportInvoices = operationalInvoices(data).filter((invoice) => invoice.branchId === doc.branchId
        && Number(invoice.ts || 0) > reportStart && Number(invoice.ts || 0) <= reportEnd);
    }
  } else {
    const since = branchLastEndDay(data, bId);
    const inv = operationalInvoices(data).filter((i) => i.branchId === bId && i.ts > since);
    reportInvoices = inv;
    const paidInv = inv.filter((i) => invOutstanding(i) <= 0);
    const openInv = inv.filter((i) => invOutstanding(i) > 0);
    const invIds = new Set(inv.map((i) => i.id));
    const pays = data.payments.filter((p) => p.status === "captured" && p.ts > since && invIds.has(p.orderId));
    const payBy = (mm) => pays.filter((p) => (p.method || "").toLowerCase().includes(mm)).reduce((s, p) => s + p.amountCents, 0);
    const cashC = payBy("cash"), mpesaC = payBy("pesa"), cardC = payBy("card");
    const invoiceC = inv.reduce((s, i) => s + invOutstanding(i), 0);
    const expenseC = (data.expenses || []).filter((e) => e.branchId === bId && e.ts > since && isApprovedExpense(e)).reduce((s, e) => s + e.amountCents, 0);
    const lines = aggregateInvoiceSoldLines(data, inv, bId);
    const cBy = {}; inv.forEach((i) => { const cashierName = invoiceCashierName(i); const c = cBy[cashierName] || { invoices: 0, totalCents: 0 }; c.invoices++; c.totalCents += i.totalCents; cBy[cashierName] = c; });
    const now0 = new Date();
    d = {
      cashier: user, branchId: bId, branchName: effBranch.name, businessDate: todayStr(), date: todayStr(), time: now0.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }),
      periodStartedAt: since,
      transactions: inv.length, itemsSold: lines.reduce((s, l) => s + l.qty, 0), totalSalesCents: inv.reduce((s, i) => s + i.totalCents, 0),
      cashCents: cashC, mpesaCents: mpesaC, cardCents: cardC, invoiceCents: invoiceC, expenseCents: expenseC,
      paidCount: paidInv.length, openCount: openInv.length, openDebtCents: openInv.reduce((s, i) => s + invOutstanding(i), 0),
      cashierRows: Object.entries(cBy).map(([n, v]) => ({ cashier: n, invoices: v.invoices, totalCents: v.totalCents })),
      invoiceSnapshots: inv.map((invoice) => ({
        id: invoice.id, number: invoice.number, cashier: invoiceCashierName(invoice), branchId: invoice.branchId,
        ts: invoice.ts, totalCents: invoice.totalCents, paidCents: invoice.paidCents,
        items: Array.isArray(invoice.items) ? invoice.items.map((item) => ({ ...item })) : [],
      })),
      lines,
    };
  }
  const reportCashierNames = new Set([
    ...reportInvoices.map(invoiceCashierName),
    ...(d.cashierRows || []).map((row) => String(row.cashier || "").trim()).filter(Boolean),
  ]);
  const cashierNames = Array.from(new Set(branchCashiers(data, bId).map((cashier) => String(cashier.name || "").trim())))
    .filter((name) => name && reportCashierNames.has(name))
    .sort((a, b) => a.localeCompare(b));
  const filteredInvoices = cashierFilter === "all"
    ? reportInvoices
    : reportInvoices.filter((invoice) => invoiceCashierName(invoice) === cashierFilter);
  const canProjectFromInvoices = reportInvoices.length > 0;
  const dayLines = canProjectFromInvoices
    ? aggregateInvoiceSoldLines(data, filteredInvoices, d.branchId)
    : (cashierFilter === "all" ? (d.lines || []) : []);
  const visibleCashierRows = canProjectFromInvoices
    ? Array.from(filteredInvoices.reduce((map, invoice) => {
      const cashierName = invoiceCashierName(invoice);
      const row = map.get(cashierName) || { cashier: cashierName, invoices: 0, totalCents: 0 };
      row.invoices += 1;
      row.totalCents += Number(invoice.totalCents || 0);
      map.set(cashierName, row);
      return map;
    }, new Map()).values())
    : (d.cashierRows || []).filter((row) => cashierFilter === "all" || row.cashier === cashierFilter);
  const visibleTransactions = canProjectFromInvoices ? filteredInvoices.length : Number(d.transactions || 0);
  const visibleSalesCents = canProjectFromInvoices
    ? filteredInvoices.reduce((sum, invoice) => sum + Number(invoice.totalCents || 0), 0)
    : Number(d.totalSalesCents || 0);
  const visiblePaidCount = canProjectFromInvoices ? filteredInvoices.filter((invoice) => invOutstanding(invoice) <= 0).length : Number(d.paidCount || 0);
  const visibleOpenInvoices = canProjectFromInvoices ? filteredInvoices.filter((invoice) => invOutstanding(invoice) > 0) : [];
  const visibleOpenCount = canProjectFromInvoices ? visibleOpenInvoices.length : Number(d.openCount || 0);
  const visibleOpenDebtCents = canProjectFromInvoices
    ? visibleOpenInvoices.reduce((sum, invoice) => sum + invOutstanding(invoice), 0)
    : Number(d.openDebtCents || 0);
  const dayQty = dayLines.reduce((s, l) => s + l.qty, 0);
  const dayValue = dayLines.reduce((s, l) => s + l.totalCents, 0);
  const businessDate = d.businessDate || d.date || todayStr();
  const periodStartedAt = Number(d.periodStartedAt ?? branchLastEndDay(data, d.branchId));
  const periodInvoices = live
    ? operationalInvoices(data).filter((invoice) => invoice.branchId === d.branchId && invoice.ts > periodStartedAt)
    : [];
  const periodLastInvoiceAt = live
    ? periodInvoices.reduce((latest, invoice) => Math.max(latest, Number(invoice.ts || 0)), 0)
    : Number(d.lastInvoiceAt || d.periodEndedAt || d.closedAt || d.ts || 0);
  const closeBatchId = `eod_${d.branchId}_${periodStartedAt}_${periodLastInvoiceAt}`;
  const batchAlreadyClosed = live && (data.endOfDays || []).some((entry) => entry.id === closeBatchId);
  const hasInvoices = Number(d.transactions || 0) > 0;
  const printEndDay = () => {
    const report = buildReportDocument({
      title: "Z-Report",
      companyName: data.settings.store || "VISIONPOS",
      companyDetails: "Supervisor day close summary",
      branchName: d.branchName,
      generatedBy: user || d.cashier || "VISIONPOS",
      dateRange: d.date,
      filters: [
        { label: "Cashier", value: cashierFilter === "all" ? "All cashiers" : cashierFilter },
        { label: "Branch", value: d.branchName },
        { label: "Closed at", value: d.time },
      ],
      headers: ["Item", "Qty", "Price Sold", "Total"],
      rows: dayLines.map((l) => [l.name, l.qty, fmt(l.priceCents, cur), fmt(l.totalCents, cur)]),
      totals: [
        { label: "Transactions", value: visibleTransactions },
        { label: "Items Sold", value: dayQty },
        { label: "Total Sales", value: fmt(visibleSalesCents, cur) },
        { label: "Cash", value: fmt(d.cashCents, cur) },
        { label: "M-Pesa", value: fmt(d.mpesaCents, cur) },
        { label: "Card", value: fmt(d.cardCents, cur) },
        { label: "Invoice", value: fmt(d.invoiceCents, cur) },
        { label: "Expenses", value: fmt(d.expenseCents || 0, cur) },
        { label: "Paid archived", value: visiblePaidCount },
        { label: "Open carried over", value: visibleOpenCount + " · " + fmt(visibleOpenDebtCents, cur) },
      ],
    });
    printReport(report);
  };

  const closeDay = () => {
    if (closingRef.current) return;
    if (activeCarts.length > 0) {
      setCloseError("Close day is blocked while a cashier cart is active for this branch.");
      return;
    }
    if (batchAlreadyClosed) {
      setCloseError("This invoice period has already been closed.");
      return;
    }
    if (!hasInvoices) {
      setCloseError(`There are no new invoices to close for ${d.branchName}.`);
      return;
    }

    closingRef.current = true;
    setClosing(true);
    setCloseError("");
    const ts = now();
    const closeId = closeBatchId;
    const record = {
      id: closeId,
      type: "day_closed",
      eventType: "day_closed",
      ...d,
      businessDate,
      periodStartedAt,
      periodEndedAt: ts,
      lastInvoiceAt: periodLastInvoiceAt,
      invoiceIds: periodInvoices.map((invoice) => invoice.id),
      carriedOverInvoiceIds: periodInvoices
        .filter((invoice) => invOutstanding(invoice) > 0)
        .map((invoice) => invoice.id),
      countedCashCents: counted ? Math.round(parseFloat(counted) * 100) : null,
      note: note.trim(),
      closedBy: user,
      closedAt: ts,
      ts,
      synced: false,
    };
    update((dd) => {
      const current = reconcileInvoicePayments(dd);
      if ((current.endOfDays || []).some((entry) => entry.id === closeId)) return current;
      const since = branchLastEndDay(current, d.branchId);
      const eligibleInvoices = operationalInvoices(current).filter((i) => i.branchId === d.branchId && i.ts > since && i.ts <= ts);
      if (eligibleInvoices.length === 0) return current;
      return { ...current,
        endOfDays: [record, ...(current.endOfDays || [])],
        invoices: current.invoices.map((i) => {
          if (i.branchId !== d.branchId || i.ts <= since || i.ts > ts) return i;
          if (invoiceIsVoided(current, i)) return i;
          if (invOutstanding(i) > 0) return { ...i, carriedOver: true, carriedOverAt: ts, closedDayId: closeId, synced: false };
          return { ...i, archived: true, archivedAt: ts, closedDayId: closeId, activeForCashier: false, synced: false };
        }),
        settings: { ...current.settings, lastEndDayByBranch: { ...(current.settings.lastEndDayByBranch || {}), [d.branchId]: ts } } };
    });
    onClose();
  };

  return (
    <div className="scrim" onClick={onClose}>
      <div className="modal eodmodal" onClick={(e) => e.stopPropagation()}>
        <div className="modal-head"><div><div className="wshead">Supervisor close</div><div className="title" style={{ fontSize: 22 }}>Close day</div></div>
          <button className="iconbtn" onClick={onClose}><X /></button></div>

        <div className="eodgrid">
          <div className="eodcell"><div className="sl">Closed by</div><div className="ev">{live ? user : d.closedBy || d.cashier}</div></div>
          <div className="eodcell"><div className="sl">Branch</div><div className="ev">{d.branchName}</div></div>
          <div className="eodcell"><div className="sl">Date</div><div className="ev">{d.date}</div></div>
          <div className="eodcell"><div className="sl">Time</div><div className="ev">{d.time}</div></div>
          <div className="eodcell"><div className="sl">Total Sales</div><div className="ev">{fmt(visibleSalesCents, cur)}</div></div>
          <div className="eodcell"><div className="sl">Cash</div><div className="ev">{fmt(d.cashCents, cur)}</div></div>
          <div className="eodcell"><div className="sl">M-Pesa</div><div className="ev">{fmt(d.mpesaCents, cur)}</div></div>
          <div className="eodcell"><div className="sl">Expenses</div><div className="ev">{fmt(d.expenseCents || 0, cur)}</div></div>
        </div>

        <div className="grid2" style={{ marginTop: 14 }}>
          <div className="eodcell" style={{ borderColor: "rgba(22,163,74,.28)", background: "rgba(22,163,74,.08)" }}>
            <div className="sl">Paid — clears out</div>
            <div className="ev">{visiblePaidCount} invoice(s)</div>
            <div className="mt2">Archived from active cashier views.</div>
          </div>
          <div className="eodcell" style={{ borderColor: "rgba(245,158,11,.32)", background: "rgba(245,158,11,.08)" }}>
            <div className="sl">Open — carries over</div>
            <div className="ev">{visibleOpenCount} invoice(s) · {fmt(visibleOpenDebtCents, cur)}</div>
            <div className="mt2">Moves to carried-over debt.</div>
          </div>
        </div>

        {live && (
          <div className="alert" style={{ marginTop: 14 }}>
            After closing, paid invoices leave the cashier screen and sales reset to zero. The {d.openCount || 0} open invoices move to carried over. This can't be undone.
          </div>
        )}

        {activeCarts.length > 0 && (
          <div className="alert danger" style={{ marginTop: 14 }}>
            Close day is blocked because {activeCarts.length} terminal(s) still have active carts: {activeCarts.map(terminalName).join(", ")}.
          </div>
        )}

        {batchAlreadyClosed && (
          <div className="alert danger" style={{ marginTop: 14 }}>
            This exact invoice period has already been closed. A duplicate close is blocked.
          </div>
        )}

        {live && !batchAlreadyClosed && !hasInvoices && (
          <div className="alert" style={{ marginTop: 14 }}>
            There are no new invoices to close for {d.branchName}. No Z-report will be generated.
          </div>
        )}

        {closeError && <div className="alert danger" style={{ marginTop: 14 }}>{closeError}</div>}

        <div className="grid2" style={{ marginTop: 14, alignItems: "end" }}>
          <div>
            <label className="label">Cashier report filter</label>
            <select className="input" value={cashierFilter} onChange={(event) => setCashierFilter(event.target.value)}>
              <option value="all">All cashiers</option>
              {cashierNames.map((name) => <option key={name} value={name}>{name}</option>)}
            </select>
          </div>
          <div className="notice" style={{ margin: 0 }}>
            {live ? "This filter changes the report only. Closing still covers every cashier in this branch." : "Filter this saved Z-report by cashier."}
          </div>
        </div>

        <div className="eodth"><span>Cashier</span><span>Invoices</span><span>Total</span></div>
        {!visibleCashierRows.length ? <div className="notice">No cashier invoices in this closing period.</div> : (
          <div className="eodrows">{visibleCashierRows.map((r) => (<div className="eodrow" key={r.cashier}><span>{r.cashier}</span><span>{r.invoices}</span><span className="amt">{fmt(r.totalCents, cur)}</span></div>))}</div>
        )}
        <div className="eodtot"><span>{cashierFilter === "all" ? "Total Sum Of Day" : `${cashierFilter} Total`}</span><span className="sub">{visibleTransactions} sales</span><span className="amt">{fmt(visibleSalesCents, cur)}</span></div>

        <div className="eodth"><span>Item</span><span>Qty</span><span>Price Sold</span><span>Total</span></div>
        {dayLines.length === 0 ? <div className="notice">No new sales since the last End of Day close.</div> : (
          <div className="eodrows">{dayLines.map((l, i) => (<div className="eodrow four" key={i}><span>{l.name}</span><span>{l.qty}</span><span>{fmt(l.priceCents, cur)}</span><span className="amt">{fmt(l.totalCents, cur)}</span></div>))}</div>
        )}
        <div className="eodtot"><span>Day Total</span><span>{dayQty}</span><span className="amt">{fmt(dayValue, cur)}</span></div>

        {live ? (
          <div className="grid2" style={{ marginTop: 14 }}>
            <div><label className="label">Counted cash</label><input className="input" inputMode="decimal" placeholder="Cash counted" value={counted} onChange={(e) => setCounted(e.target.value.replace(/[^\d.]/g, ""))} /></div>
            <div><label className="label">Notes</label><input className="input" placeholder="Short closing note" value={note} onChange={(e) => setNote(e.target.value)} /></div>
          </div>
        ) : (
          (d.countedCashCents != null || d.note) && (
            <div className="grid2" style={{ marginTop: 14 }}>
              <div className="eodcell"><div className="sl">Counted cash</div><div className="ev">{d.countedCashCents != null ? fmt(d.countedCashCents, cur) : "—"}</div></div>
              <div className="eodcell"><div className="sl">Notes</div><div className="ev" style={{ fontSize: 14 }}>{d.note || "—"}</div></div>
            </div>
          )
        )}

        {live ? (
          <div style={{ marginTop: 16, display: "grid", gridTemplateColumns: "repeat(3, minmax(0, 1fr))", gap: 10 }}>
            <button className="btn btn-ghost" onClick={printEndDay} disabled={!hasInvoices}><Printer /> Print Z-report</button>
            <button className="btn btn-ghost" onClick={onClose}>Cancel</button>
            <button
              className="btn btn-primary"
              disabled={activeCarts.length > 0 || batchAlreadyClosed || !hasInvoices || closing}
              onClick={closeDay}
            ><Check /> {closing ? "Closing..." : "Close day"}</button>
          </div>
        ) : (
          <div className="grid2" style={{ marginTop: 16 }}>
            <button className="btn btn-ghost" onClick={printEndDay}><Printer /> Print Z-report</button>
            <button className="btn btn-ghost" onClick={onClose}>Close</button>
          </div>
        )}
      </div>
    </div>
  );
}
function InvoiceRow({ inv, products, cur, voidInfo, selected, onToggle, onOpen }) {
  const status = invStatus(inv);
  const out = voidInfo?.status === "approved" ? 0 : invOutstanding(inv);
  const age = Math.max(0, Math.floor((now() - (inv.ts || now())) / 86400000));
  const voidStatus = voidInfo?.status || "none";
  const displayStatus = voidStatus === "approved" ? "voided"
    : voidStatus === "pending" ? "void pending" : status;
  const displayClass = voidStatus === "approved" ? "debt"
    : voidStatus === "pending" ? "void-pending" : status;
  return (
    <tr className="clickable" onClick={onOpen}>
      <td onClick={(event) => event.stopPropagation()}><input type="checkbox" aria-label={`Select invoice ${inv.number || inv.receiptNo}`} checked={selected} onChange={onToggle} /></td>
      <td><div className="invoice-ref"><b className="innum">{inv.number || inv.receiptNo}{inv.trackingNote ? <span className="noteflag" title={inv.trackingNote}>*</span> : null}</b><span>{dt(inv.ts)} - {age === 0 ? "today" : age + "d old"}</span></div></td>
      <td><div className="invoice-customer"><b>{inv.customerName || "Walk-in"}</b><span title={products || "No product details"}>{products || "No product details"}</span></div></td>
      <td><div className="nm">{invoiceCashierName(inv) || "Unknown cashier"}</div></td>
      <td className="amt">{fmt(Number(inv.totalCents || 0), cur)}</td>
      <td className="amt">{fmt(out, cur)}</td>
      <td>
        <span className={"ist " + displayClass}>{displayStatus}</span>
        {voidStatus === "rejected" ? <div className="mt2">Void request rejected</div> : null}
      </td>
    </tr>
  );
}

function InvoiceDetailModal({ inv, data, update, cur, user, onReprint, onClose }) {
  const live = data.invoices.find((x) => x.id === inv.id) || inv;
  const [tnote, setTnote] = useState(live.trackingNote || "");
  const [saved, setSaved] = useState(false);
  const [method, setMethod] = useState("M-Pesa");
  const voidInfo = invoiceVoidState(data, live.id);
  const voidPending = voidInfo.status === "pending";
  const voidApproved = voidInfo.status === "approved";
  const out = voidApproved ? 0 : invOutstanding(live);
  const status = voidApproved ? "voided" : invStatus(live);
  const [amount, setAmount] = useState(moneyInputValue(out));
  useEffect(() => { setAmount(moneyInputValue(out)); }, [live.id, out]);
  const paymentCents = clampPaymentCents(amount, out);
  const isFullPayment = out > 0 && paymentCents === out;
  const [decisionReason, setDecisionReason] = useState("");
  const [voidError, setVoidError] = useState("");
  const actorName = typeof user === "string"
    ? user
    : (user?.name || user?.displayName || user?.email || "Supervisor");
  const paymentActorName = (payment) => payment.recordedByName || payment.settledByName
    || (typeof payment.recordedBy === "string" ? payment.recordedBy : payment.recordedBy?.name || payment.recordedBy?.displayName || payment.recordedBy?.email)
    || (typeof payment.settledBy === "string" ? payment.settledBy : payment.settledBy?.name || payment.settledBy?.displayName || payment.settledBy?.email)
    || "Supervisor";
  const items = invoiceSoldLines(data, live, live.branchId).map((item, index) => ({
    ...item,
    key: item.productId || `${item.name}-${index}`,
  }));
  const pays = data.payments.filter((p) => p.orderId === live.id || p.invoiceId === live.id);
  const latestPayment = pays.reduce((latest, payment) => !latest || Number(payment.ts || 0) > Number(latest.ts || 0) ? payment : latest, null);
  const clearedByName = live.settledByName || live.lastSettledByName
    || (typeof live.settledBy === "string" ? live.settledBy : live.settledBy?.name || live.settledBy?.displayName || live.settledBy?.email)
    || (typeof live.lastSettledBy === "string" ? live.lastSettledBy : live.lastSettledBy?.name || live.lastSettledBy?.displayName || live.lastSettledBy?.email)
    || (latestPayment ? paymentActorName(latestPayment) : "");
  const recordPayment = () => {
    if (voidPending || voidApproved || paymentCents <= 0 || out <= 0) return;
    const ts = now();
    update((d) => ({ ...d,
      invoices: d.invoices.map((x) => {
        if (x.id !== live.id) return x;
        const paidCents = Math.min(x.totalCents, (Number(x.paidCents) || 0) + paymentCents);
        const cleared = paidCents >= x.totalCents;
        return {
          ...x,
          paidCents,
          carriedOver: cleared ? false : x.carriedOver,
          method,
          lastSettledBy: user,
          lastSettledByName: actorName,
          lastSettledAt: ts,
          settledBy: cleared ? user : x.settledBy,
          settledByName: cleared ? actorName : x.settledByName,
          settledAt: cleared ? ts : x.settledAt,
          status: cleared ? "paid" : "open",
          synced: false,
        };
      }),
      payments: [...(d.payments || []), {
        id: uid("pay"),
        orderId: live.id,
        invoiceId: live.id,
        method: method.toLowerCase(),
        amountCents: paymentCents,
        status: "captured",
        recordedBy: user,
        recordedByName: actorName,
        settledBy: user,
        settledByName: actorName,
        ts,
        synced: false,
      }],
    }));
    setAmount("");
    if (isFullPayment) onClose();
  };
  const decideVoid = (decision) => {
    if (!voidInfo.request || voidInfo.status !== "pending") return;
    const reason = decisionReason.trim();
    if (decision === "rejected" && !reason) {
      setVoidError("Enter a reason before rejecting the void request.");
      return;
    }
    const ts = now();
    const entry = {
      id: uid("void-decision"), invoiceId: live.id, requestId: voidInfo.request.id,
      branchId: live.branchId, decision, reason, decidedBy: actorName,
      decidedByName: actorName, decidedAt: ts, ts, synced: false,
    };
    update((d) => ({
      ...d,
      invoiceVoidDecisions: [entry, ...(d.invoiceVoidDecisions || [])],
    }));
    setVoidError("");
  };
  const saveNote = () => { update((d) => ({ ...d, invoices: d.invoices.map((x) => x.id === live.id ? { ...x, trackingNote: tnote.trim(), synced: false } : x) })); setSaved(true); };
  return (
    <div className="scrim" onClick={onClose}>
      <div className="modal settlement-modal invoice-detail-modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal-head invoice-detail-head">
          <div className="invoice-detail-heading">
            <div className="sub">Invoice settlement</div>
            <div className="invoice-detail-title-row">
              <div className="title">{live.number || live.receiptNo}</div>
              <span className={"ist " + status}>{status}</span>
              {live.carriedOver ? <span className="invoice-carried">Carried over</span> : null}
            </div>
            <div className="invoice-detail-meta">
              <span><small>Customer</small><b>{live.customerName || "Walk-in"}</b></span>
              <span><small>Cashier</small><b>{invoiceCashierName(live) || "Unknown cashier"}</b></span>
              <span><small>Issued</small><b>{dt(live.ts)}</b></span>
              {status === "paid" && clearedByName ? <span className="invoice-cleared-by"><small>Cleared by</small><b>{clearedByName}</b></span> : null}
            </div>
          </div>
          <button className="iconbtn" onClick={onClose} aria-label="Close invoice settlement"><X /></button>
        </div>

        <div className="invoice-detail-totals">
          <div><span>Total</span><b>{fmt(live.totalCents, cur)}</b></div>
          <div><span>Paid</span><b>{fmt(live.paidCents || 0, cur)}</b></div>
          <div className="due"><span>Balance</span><b>{fmt(out, cur)}</b></div>
        </div>

        {voidPending ? (
          <div className="void-review-box">
            <div className="section-title" style={{ marginTop: 0 }}><AlertCircle /> Void approval required</div>
            <div className="void-review-meta">
              <span>Requested by <b>{voidInfo.request.requestedByName || voidInfo.request.cashierName || "Cashier"}</b></span>
              <span>{dt(voidInfo.request.requestedAt || voidInfo.request.ts)}</span>
            </div>
            <div className="notice">Reason: {voidInfo.request.reason || "No reason supplied"}</div>
            <textarea className="input" style={{ minHeight: 66, paddingTop: 10, resize: "vertical" }}
              placeholder="Decision note (required when rejecting)" value={decisionReason}
              onChange={(e) => { setDecisionReason(e.target.value); setVoidError(""); }} />
            {voidError ? <div className="formerr">{voidError}</div> : null}
            <div className="grid2">
              <button className="btn btn-ghost" onClick={() => decideVoid("rejected")}><X /> Reject request</button>
              <button className="btn btn-primary" onClick={() => decideVoid("approved")}><Check /> Approve void</button>
            </div>
            <div className="mt2">Approval voids the invoice and restores its item quantities. It does not create a payment.</div>
          </div>
        ) : voidApproved ? (
          <div className="notice void-decision approved">
            <b>Invoice voided</b>
            <span>Approved by {voidInfo.decision?.decidedByName || voidInfo.decision?.decidedBy || "Supervisor"} on {dt(voidInfo.decision?.decidedAt || voidInfo.decision?.ts)}</span>
          </div>
        ) : voidInfo.status === "rejected" ? (
          <div className="notice void-decision rejected">
            <b>Void request rejected</b>
            <span>{voidInfo.decision?.reason || "No decision note supplied."}</span>
          </div>
        ) : null}
        {!voidPending && !voidApproved && out > 0 ? (
          <div className="settlement-box invoice-payment-panel">
            <div className="invoice-payment-head"><b>Record payment</b><span>{fmt(out, cur)} due</span></div>
            <div className="invoice-payment-toolbar">
              <div className="invoice-payment-methods" role="group" aria-label="Payment method">
                <button type="button" className={"invoice-method" + (method === "M-Pesa" ? " on" : "")} aria-pressed={method === "M-Pesa"} onClick={() => setMethod("M-Pesa")}><Smartphone />M-Pesa</button>
                <button type="button" className={"invoice-method" + (method === "Cash" ? " on" : "")} aria-pressed={method === "Cash"} onClick={() => setMethod("Cash")}><Banknote />Cash</button>
              </div>
              <button type="button" className="btn sm btn-ghost" onClick={() => setAmount(moneyInputValue(out))}>Full balance</button>
            </div>
            <div className="invoice-payment-entry">
              <label className="invoice-payment-amount"><span>Payment amount</span>
                <input className="input" inputMode="decimal" value={amount} onChange={(e) => setAmount(moneyInputValue(clampPaymentCents(e.target.value, out)))} placeholder="0.00" />
              </label>
              <button className="btn btn-primary" disabled={paymentCents <= 0} onClick={recordPayment}>
                <Check /> {isFullPayment ? "Settle full balance" : "Record partial payment"}
              </button>
            </div>
          </div>
        ) : null}

        <details className="invoice-detail-disclosure invoice-items-disclosure">
          <summary><span>Invoice items <b>{items.length}</b></span><ChevronDown /></summary>
          {items.length ? (
            <div className="invoice-detail-items">{items.map((it) => (
              <div className="invoice-detail-item" key={it.key}>
                <div><b>{it.name}</b><span>{it.qty} x {fmt(it.priceCents, cur)}</span></div>
                <strong>{fmt(it.totalCents, cur)}</strong>
              </div>))}</div>
          ) : <div className="invoice-detail-empty">No itemised lines recorded.</div>}
        </details>

        {live.note ? <div className="invoice-detail-sale-note"><b>Sale note</b><span>{live.note}</span></div> : null}

        {pays.length > 0 ? (
          <details className="invoice-detail-disclosure">
            <summary><span>Payment history <b>{pays.length}</b></span><ChevronDown /></summary>
            <div className="invoice-detail-history">{pays.map((p) => (
              <div className="invoice-detail-history-row" key={p.id}>
                <div><b>{p.method}</b><span>{new Date(p.ts).toLocaleString()} by {paymentActorName(p)}</span></div>
                <strong>{fmt(p.amountCents, cur)}</strong>
              </div>))}</div>
          </details>
        ) : null}

        <details className="invoice-detail-disclosure">
          <summary><span>{tnote.trim() ? "Edit employee note" : "Add employee note"}{tnote.trim() ? <b>Added</b> : null}</span><ChevronDown /></summary>
          <div className="invoice-detail-note-form">
            <textarea className="input" placeholder="Who collected, follow-up, reason for credit, etc." value={tnote}
              onChange={(e) => { setTnote(e.target.value); setSaved(false); }} />
            <button className="btn btn-primary" onClick={saveNote}><Check /> {saved ? "Saved" : "Save note"}</button>
          </div>
        </details>

        <div className="invoice-detail-footer">
          <button className="btn btn-ghost" onClick={() => onReprint({ ...live, items })}><Printer /> Reprint receipt</button>
        </div>
      </div>
    </div>
  );
}
/* ---- Dashboard ---- */
function DashboardTab({ data, update, branch, onOpenPayments }) {
  const cur = data.settings.currency;
  const [detail, setDetail] = useState(null);
  const [summary, setSummary] = useState("");

  const activeInvoices = operationalInvoices(data);
  const branchInvoices = activeInvoices.filter((invoice) => invoice.branchId === branch.id);
  const businessPeriodStart = branchLastEndDay(data, branch.id);
  const todayInv = branchInvoices.filter((invoice) => Number(invoice.ts || 0) > businessPeriodStart);
  const todaySales = todayInv.reduce((s, i) => s + i.totalCents, 0);
  const recognizedTodayInv = todayInv.filter((i) => invRecognized(i, data.settings));
  const recognizedTodaySales = recognizedTodayInv.reduce((s, i) => s + i.totalCents, 0);
  const todayCOGS = data.stockMovements.filter((m) => m.branchId === branch.id && Number(m.ts || 0) > businessPeriodStart && typeof m.reason === "string" && m.reason.startsWith("Sale") && saleMoveRecognized(data, m))
    .reduce((s, m) => { const p = data.products.find((x) => x.id === m.productId); return s + (p ? (-m.qty) * branchInventoryCostCents(data, p, m.branchId) : 0); }, 0);
  const todayProfit = recognizedTodaySales - todayCOGS;
  const creditInvoices = branchInvoices.filter((invoice) => invIsDebt(invoice));
  const creditTotal = creditInvoices.reduce((sum, invoice) => sum + invOutstanding(invoice), 0);
  const inventoryDebtBalances = cashierJointDebtCashierBalances(data, branch.id);
  const inventoryDebtAssigned = inventoryDebtBalances.reduce((sum, row) => sum + row.assignedCents, 0);
  const inventoryDebtPaid = inventoryDebtBalances.reduce((sum, row) => sum + row.paidCents, 0);
  const inventoryDebtOutstanding = inventoryDebtBalances.reduce((sum, row) => sum + row.outstandingCents, 0);
  // Fast-moving reorders: products with recent weekly demand that need restocking to cover the next 2 weeks.
  const fastReorders = (() => {
    const WEEKS_LOOKBACK = 8, weekMs = 7 * 864e5, TARGET = 2;
    const start = Date.now() - WEEKS_LOOKBACK * weekMs;
    const moves = data.stockMovements.filter((m) => typeof m.reason === "string" && m.reason.startsWith("Sale") && m.ts >= start && m.branchId === branch.id);
    const sold = {}; let earliest = Date.now();
    moves.forEach((m) => { sold[m.productId] = (sold[m.productId] || 0) + (-m.qty); if (m.ts < earliest) earliest = m.ts; });
    const weeksObs = moves.length ? Math.max(1, Math.min(WEEKS_LOOKBACK, (Date.now() - earliest) / weekMs)) : 1;
    return data.products.filter((p) => {
      const wk = (sold[p.id] || 0) / weeksObs;
      if (wk <= 0) return false; // idle product — excluded
      return Math.max(0, Math.ceil(wk * TARGET - onHand(data, p.id, branch.id))) > 0;
    });
  })();

  const days = [];
  for (let i = 6; i >= 0; i--) { const d = new Date(); d.setHours(0, 0, 0, 0); d.setDate(d.getDate() - i); const start = d.getTime(); const end = start + 864e5;
    days.push({ label: d.toLocaleDateString(undefined, { weekday: "short" }).slice(0, 2), total: branchInvoices.filter((inv) => inv.ts >= start && inv.ts < end).reduce((s, inv) => s + inv.totalCents, 0) }); }
  const maxDay = Math.max(1, ...days.map((d) => d.total));

  const since7 = Date.now() - 7 * 864e5; const catRev = {};
  data.stockMovements.forEach((m) => { if (m.branchId === branch.id && typeof m.reason === "string" && m.reason.startsWith("Sale") && m.ts >= since7 && saleMoveRecognized(data, m)) { const p = data.products.find((x) => x.id === m.productId); if (p) catRev[p.category] = (catRev[p.category] || 0) + (-m.qty) * priceFor(data, p); } });
  const catArr = Object.entries(catRev).sort((a, b) => b[1] - a[1]).slice(0, 6);
  const maxCat = Math.max(1, ...catArr.map((c) => c[1]));

  const localSummary = () => {
    const margin = recognizedTodaySales > 0 ? Math.round((todayProfit / recognizedTodaySales) * 100) : 0;
    let s = "Today's sales are " + fmt(todaySales, cur) + " with recognized profit of " + fmt(todayProfit, cur) + " (" + margin + "% margin after clearing and End of Day). ";
    s += creditTotal > 0 ? "Outstanding credit stands at " + fmt(creditTotal, cur) + ". " : "No outstanding credit. ";
    s += inventoryDebtOutstanding > 0 ? "Cashier inventory debt stands at " + fmt(inventoryDebtOutstanding, cur) + ". " : "Cashier inventory debt is clear. ";
    s += fastReorders.length > 0 ? fastReorders.length + " fast-moving product(s) need reordering — prioritise the lowest cover." : "Fast movers are well stocked.";
    return s;
  };
  const genSummary = () => setSummary(localSummary());
  useEffect(() => {
    setSummary(localSummary());
    // Refresh the summary when End of Day starts a new branch business period.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [businessPeriodStart, branch.id]);

  return (
    <div className="dash">
      <PageHead title="Dashboard" sub={"Overview · " + branch.name} />
      <div className="cashtiles" style={{ marginBottom: 0 }}>
        <div className="ctile"><div className="ic"><Receipt /></div><div><div className="cl">Sales (today)</div><div className="cv">{fmt(todaySales, cur)}</div><div className="cs">{todayInv.length} invoices</div></div></div>
        <div className={"ctile " + (todayProfit >= 0 ? "good" : "warn")}><div className="ic"><BarChart3 /></div><div><div className="cl">Profit (today)</div><div className="cv">{fmt(todayProfit, cur)}</div><div className="cs">{recognizedTodaySales > 0 ? Math.round(todayProfit / recognizedTodaySales * 100) + "% margin" : "after EOD & clearing"}</div></div></div>
        <div className={"ctile " + (creditTotal > 0 ? "warn" : "")}><div className="ic"><FileText /></div><div><div className="cl">Credit outstanding</div><div className="cv">{fmt(creditTotal, cur)}</div><div className="cs">{creditInvoices.length ? creditInvoices.length + " debt invoice" + (creditInvoices.length === 1 ? "" : "s") : "all clear"}</div></div></div>
        <div className={"ctile " + (inventoryDebtOutstanding > 0 ? "warn" : "good")} role="button" tabIndex={0} onClick={onOpenPayments} onKeyDown={(event) => { if (event.key === "Enter" || event.key === " ") onOpenPayments?.(); }} style={{ cursor: "pointer" }}>
          <div className="ic"><CreditCard /></div><div><div className="cl">Inventory joint debt</div><div className="cv">{fmt(inventoryDebtOutstanding, cur)}</div><div className="cs">paid {fmt(inventoryDebtPaid, cur)} of {fmt(inventoryDebtAssigned, cur)}</div></div>
        </div>
        <div className={"ctile " + (fastReorders.length ? "warn" : "")}><div className="ic"><AlertCircle /></div><div><div className="cl">Reorders</div><div className="cv">{fastReorders.length}</div><div className="cs">fast movers low</div></div></div>
      </div>

      <div className="dash2">
        <div className="dcard">
          <div className="ht"><BarChart3 /> Sales Trend <span className="rt">last 7 days</span></div>
          <div className="trend">{days.map((d, i) => (
            <div className="col" key={i}><div className="colv">{d.total ? fmt(d.total, cur).replace(/^KES\s?/, "") : ""}</div>
              <div className="colbar" style={{ height: Math.max(4, Math.round(d.total / maxDay * 100)) + "%" }} /><div className="cold">{d.label}</div></div>))}
          </div>
        </div>
        <div className="dcard">
          <div className="ht"><Tags /> Revenue Breakdown <span className="rt">by category · 7d</span></div>
          {catArr.length === 0 ? <div className="dempty">No sales recorded in the last 7 days yet.</div> : (
            <div className="bars">{catArr.map(([c, v]) => (
              <div className="bar-row" key={c}><span className="lbl">{c}</span><div className="bar-track"><div className="bar-fill" style={{ width: Math.round(v / maxCat * 100) + "%" }} /></div><span className="val">{fmt(v, cur)}</span></div>))}
            </div>
          )}
        </div>
      </div>

      <div className="dcard aisum">
        <div className="ht"><BarChart3 /> Business Summary <button className="rt linkc" onClick={genSummary}>Refresh</button></div>
        <div className="txt">{summary || localSummary()}</div>
      </div>

      {detail && <InvoiceDetailModal inv={detail} data={data} update={update} cur={cur} onClose={() => setDetail(null)} />}
    </div>
  );
}

/* ---- Products ---- */
const CATS = ["Whisky", "Gin", "Vodka", "Rum", "Cognac", "Wine", "Beer", "Spirits", "Other"];
function ProductsTab({ data, update, branch, isAdmin }) {
  const cur = data.settings.currency;
  const [adding, setAdding] = useState(false);
  const blankProductForm = () => ({ name: "", sku: "", barcode: "", extraBarcodes: "", size: "750 ML", category: CATS[0], price: "", tax: "0", supplierId: data.suppliers?.[0]?.id || "", unit: "bottle", initialStock: "0", lowStockAlert: String(data.settings.reorderLevel || 4), imageUrl: "" });
  const [f, setF] = useState(blankProductForm());
  const [err, setErr] = useState("");
  const [q, setQ] = useState("");
  const [scannedProductId, setScannedProductId] = useState("");
  const [catF, setCatF] = useState("All");
  const [statusF, setStatusF] = useState("all");
  const [delMsg, setDelMsg] = useState("");
  const [deleteTarget, setDeleteTarget] = useState(null);
  const [scannerOn, setScannerOn] = useState(true);
  const [cameraOpen, setCameraOpen] = useState(false);
  const [barcodeLocked, setBarcodeLocked] = useState(false);
  const [copyOpen, setCopyOpen] = useState(false);
  const [copyFrom, setCopyFrom] = useState(data.branches.find((b) => b.id !== branch.id)?.id || "");
  const [copyMsg, setCopyMsg] = useState("");
  const barcodeInputRef = useRef(null);
  const editBarcodeInputRef = useRef(null);
  const [editId, setEditId] = useState(null);
  const [ef, setEf] = useState({ name: "", barcode: "", extraBarcodes: "" });
  const cleanCode = (value) => String(value || "").trim().replace(/\s+/g, "");
  const isBranchProduct = (p) => productVisibleInBranch(p, data, branch.id);
  const visibleBranchProducts = branchProductsUnique(data, branch.id);
  const enabledProductCount = visibleBranchProducts.filter(productIsEnabled).length;
  const scannedProduct = visibleBranchProducts.find((p) => p.id === scannedProductId) || null;
  const productCodeMatch = (p, code) => {
    const normalized = cleanCode(code).toLowerCase();
    if (!normalized) return false;
    const catalogEntry = findBarcodeCatalogEntry(data, normalized);
    return productMatchesCatalog(p, catalogEntry) || [p.sku, p.barcode, ...(p.barcodes || [])].some((value) => cleanCode(value).toLowerCase() === normalized);
  };
  const reset = () => { setF(blankProductForm()); setErr(""); setAdding(false); setBarcodeLocked(false); };
  const handleProductScan = (code) => {
    const barcode = cleanCode(code);
    if (!isValidBarcode(barcode)) {
      setErr("Invalid barcode: " + barcode);
      appendBarcodeScanLog({ barcode, status: "products:invalid" });
      return;
    }
    if (editId) {
      const existing = data.products.find((p) => p.id !== editId && isBranchProduct(p) && productCodeMatch(p, barcode));
      if (existing) {
        setErr("Barcode already belongs to " + existing.name + ".");
        appendBarcodeScanLog({ barcode, status: "products:edit_duplicate", productId: existing.id });
        return;
      }
      setEf((prev) => ({ ...prev, barcode }));
      setErr("");
      appendBarcodeScanLog({ barcode, status: "products:edit_prefilled", productId: editId });
      window.setTimeout(() => editBarcodeInputRef.current?.focus(), 0);
      return;
    }
    const existing = visibleBranchProducts.find((p) => productCodeMatch(p, barcode));
    if (existing) {
      reset();
      setEditId(null);
      setQ("");
      setScannedProductId(existing.id);
      setErr("");
      appendBarcodeScanLog({ barcode, status: "products:found_existing", productId: existing.id });
      return true;
    }
    const catalogEntry = findBarcodeCatalogEntry(data, barcode);
    setScannedProductId("");
    setQ("");
    setF((prev) => ({ ...prev, barcode }));
    setAdding(true);
    setBarcodeLocked(true);
    setErr(catalogEntry ? "Barcode exists in the shared catalog. Add this branch's product details to link it." : "");
    appendBarcodeScanLog({ barcode, status: catalogEntry ? "products:catalog_found" : "products:prefilled" });
  };
  useBarcodeScanner({ enabled: scannerOn && !cameraOpen, mode: "products", onScan: handleProductScan });
  useEffect(() => {
    setScannedProductId("");
    setQ("");
  }, [branch.id]);
  useEffect(() => {
    if (!adding || !scannerOn) return;
    const id = window.setTimeout(() => barcodeInputRef.current?.focus(), 0);
    return () => window.clearTimeout(id);
  }, [adding, scannerOn]);
  useEffect(() => {
    if (!editId || !scannerOn) return;
    const id = window.setTimeout(() => editBarcodeInputRef.current?.focus(), 0);
    return () => window.clearTimeout(id);
  }, [editId, scannerOn]);
  useEffect(() => {
    if (copyFrom && copyFrom !== branch.id) return;
    setCopyFrom(data.branches.find((b) => b.id !== branch.id)?.id || "");
  }, [branch.id, copyFrom, data.branches]);
  const printBarcodeLabel = () => {
    const code = cleanCode(f.barcode) || generateBarcodeValue();
    const w = window.open("", "_blank", "width=420,height=320");
    if (!w) return;
    w.document.write("<html><head><title>Barcode label</title><style>body{font-family:Arial,sans-serif;padding:24px}.label{border:1px solid #111;width:260px;padding:14px;text-align:center}.name{font-weight:700;font-size:14px;margin-bottom:8px}.bars{font-family:monospace;font-size:42px;letter-spacing:2px;line-height:1}.code{font-family:monospace;font-weight:700;margin-top:8px}</style></head><body><div class='label'><div class='name'>" + (f.name || "VISIONPOS").replace(/[<>&]/g, "") + "</div><div class='bars'>||||||||||||</div><div class='code'>" + code + "</div></div><script>print()</script></body></html>");
    w.document.close();
  };
  const add = () => {
    const initialStock = parseInt(f.initialStock, 10) || 0;
    const reorderLevel = parseInt(f.lowStockAlert, 10) || data.settings.reorderLevel;
    if (!f.name.trim()) return setErr("Add a product name.");
    if (initialStock < 0) return setErr("Initial stock cannot be negative.");
    const sku = f.sku.trim() || "SIP" + Math.floor(1000 + Math.random() * 9000);
    const barcode = cleanCode(f.barcode) || generateBarcodeValue();
    const extraBarcodes = String(f.extraBarcodes || "").split(",").map(cleanCode).filter(Boolean);
    if (!isValidBarcode(barcode)) return setErr("Barcode is required.");
    if (data.products.some((p) => isBranchProduct(p) && p.sku.toLowerCase() === sku.toLowerCase())) return setErr("SKU already exists in this branch.");
    if (barcode && data.products.some((p) => isBranchProduct(p) && productCodeMatch(p, barcode))) return setErr("Barcode already exists in this branch.");
    const seenCodes = new Set([barcode.toLowerCase(), sku.toLowerCase()]);
    const duplicateExtra = extraBarcodes.find((code) => {
      const normalized = code.toLowerCase();
      if (seenCodes.has(normalized)) return true;
      seenCodes.add(normalized);
      return data.products.some((p) => isBranchProduct(p) && productCodeMatch(p, code));
    });
    if (duplicateExtra) return setErr("Duplicate barcode: " + duplicateExtra);
    const ts = now();
    const productId = uid("p");
    const catalogResult = ensureBarcodeEntries(data, [barcode, ...extraBarcodes]);
    const [primaryCatalog, ...extraCatalogs] = catalogResult.entries;
    const productBase = { id: productId, branchId: branch.id, name: f.name.trim(), sku, size: f.size, category: f.category, priceCents: 0, costCents: 0, barcode, barcodes: extraBarcodes, barcodeCatalogId: primaryCatalog?.id || null, barcodeCatalogIds: extraCatalogs.map((entry) => entry.id), taxRate: parseFloat(f.tax) || 0, supplierId: f.supplierId || null, unit: f.unit || "unit", imageUrl: f.imageUrl.trim(), reorderLevel, status: "active", synced: false, updatedAt: ts };
    const product = withBranchProductCost(productBase, branch.id, 0);
    const movement = initialStock > 0 ? [{ id: uid("mv"), productId, branchId: branch.id, qty: initialStock, reason: "Initial stock", ts, synced: false }] : [];
    update((d) => {
      const result = ensureBarcodeEntries(d, [barcode, ...extraBarcodes]);
      const [primary, ...extras] = result.entries;
      return { ...d, barcodeCatalog: result.barcodeCatalog, products: [...d.products, { ...product, barcodeCatalogId: primary?.id || product.barcodeCatalogId, barcodeCatalogIds: extras.map((entry) => entry.id) }], stockMovements: [...d.stockMovements, ...movement] };
    });
    reset();
  };
  const remove = (id) => {
    const p = data.products.find((x) => x.id === id); if (!p) return;
    const stock = onHand(data, id); // total on hand across all branches
    const sixtyAgo = Date.now() - 60 * 864e5;
    const recentMoves = data.stockMovements.filter((m) => m.productId === id && m.ts >= sixtyAgo);
    const pendInv = operationalInvoices(data).filter((i) => invOutstanding(i) > 0 && (i.items || []).some((it) => it.name === p.name));
    const openPO = data.purchases.filter((po) => po.productId === id && po.status !== "received");
    const parts = [];
    if (stock > 0) parts.push(stock + " unit(s) still in stock");
    if (recentMoves.length) parts.push("used in the last 60 days");
    if (pendInv.length) parts.push(pendInv.length + " pending invoice(s)");
    if (openPO.length) parts.push(openPO.length + " open purchase order(s)");
    if (parts.length) {
      setDeleteTarget(null);
      setDelMsg("“" + p.name + "” can't be deleted — " + parts.join(", ") + ". A product can only be removed once it has zero stock and no activity in the past 60 days.");
      return;
    }
    setDelMsg("");
    update((d) => ({ ...d, products: d.products.filter((x) => x.id !== id) }));
    setDeleteTarget(null);
  };
  function startEdit(p) { setEditId(p.id); setErr(""); setEf({ name: p.name || "", barcode: p.barcode || "", extraBarcodes: (p.barcodes || []).join(", ") }); }
  const saveEdit = (p) => {
    const name = String(ef.name || "").trim();
    const barcode = cleanCode(ef.barcode) || p.barcode || p.sku;
    const extraBarcodes = String(ef.extraBarcodes || "").split(",").map(cleanCode).filter(Boolean);
    if (!name) return setErr("Product name is required.");
    if (!isValidBarcode(barcode)) return setErr("Barcode is required.");
    const otherProducts = data.products.filter((x) => x.id !== p.id);
    if (otherProducts.some((x) => productVisibleInBranch(x, data, branch.id) && productCodeMatch(x, barcode))) return setErr("Barcode already exists in this branch.");
    const seenCodes = new Set([barcode.toLowerCase(), p.sku.toLowerCase()]);
    const duplicateExtra = extraBarcodes.find((code) => {
      const normalized = code.toLowerCase();
      if (seenCodes.has(normalized)) return true;
      seenCodes.add(normalized);
      return otherProducts.some((x) => productVisibleInBranch(x, data, branch.id) && productCodeMatch(x, code));
    });
    if (duplicateExtra) return setErr("Duplicate barcode: " + duplicateExtra);
    update((d) => {
      const result = ensureBarcodeEntries(d, [barcode, ...extraBarcodes]);
      const [primary, ...extras] = result.entries;
      return {
        ...d,
        barcodeCatalog: result.barcodeCatalog,
        products: d.products.map((x) => {
          if (x.id !== p.id) return x;
          return { ...x, name, barcode, barcodes: extraBarcodes, barcodeCatalogId: primary?.id || x.barcodeCatalogId || null, barcodeCatalogIds: extras.map((entry) => entry.id), synced: false, updatedAt: now() };
        }),
      };
    });
    setEditId(null);
    setErr("");
  };
  const setProductEnabled = (product, enabled) => {
    const key = productDedupeKey(product);
    const status = enabled ? "active" : "disabled";
    const updatedAt = now();
    update((d) => ({
      ...d,
      products: d.products.map((item) => productDedupeKey(item) === key
        ? { ...item, status, enabled, active: enabled, synced: false, updatedAt }
        : item),
    }));
  };
  const [impMsg, setImpMsg] = useState("");
  const copyBranches = data.branches.filter((b) => b.id !== branch.id);
  const copySource = data.branches.find((b) => b.id === copyFrom) || copyBranches[0] || null;
  const countMissingFromSource = (sourceId = copyFrom) => {
    const targetKeys = new Set(branchProductsUnique(data, branch.id).map(productDedupeKey));
    return branchProductsUnique(data, sourceId)
      .filter((p) => !targetKeys.has(productDedupeKey(p)))
      .length;
  };
  const copyMissingProducts = () => {
    const sourceId = copyFrom || copyBranches[0]?.id;
    if (!sourceId) return;
    const ts = now();
    let copied = 0;
    update((d) => {
      let barcodeCatalog = d.barcodeCatalog || [];
      const sourceProducts = sortProductsAZ(branchProductsUnique(d, sourceId));
      const targetKeys = new Set(branchProductsUnique(d, branch.id).map(productDedupeKey));
      const targetIds = new Set(branchProductsUnique(d, branch.id).flatMap((p) => barcodeCatalogIdsForProduct(p)));
      const products = [...d.products];
      for (const source of sourceProducts) {
        let primaryId = source.barcodeCatalogId;
        let extraIds = [...(source.barcodeCatalogIds || [])];
        if (!primaryId && (source.barcode || source.sku)) {
          const ensured = ensureBarcodeEntries({ ...d, barcodeCatalog }, [source.barcode || source.sku, ...(source.barcodes || [])]);
          barcodeCatalog = ensured.barcodeCatalog;
          primaryId = ensured.entries[0]?.id || null;
          extraIds = ensured.entries.slice(1).map((entry) => entry.id);
        }
        if (!primaryId || targetIds.has(primaryId) || targetKeys.has(productDedupeKey(source))) continue;
        let copiedProduct = {
          ...source,
          id: uid("p"),
          branchId: branch.id,
          barcodeCatalogId: primaryId,
          barcodeCatalogIds: extraIds,
          synced: false,
          updatedAt: ts,
        };
        copiedProduct = withBranchProductCost(copiedProduct, branch.id, 0);
        products.push(copiedProduct);
        targetIds.add(primaryId);
        targetKeys.add(productDedupeKey(source));
        copied++;
      }
      return { ...d, products, barcodeCatalog };
    });
    setCopyMsg(copied ? copied + " product(s) copied to " + branch.name + ". Buying cost, selling price, margin, and stock start at 0. Buying cost is recalculated from received purchases." : "No missing products to copy.");
  };
  const exportCSV = () => {
    const headers = ["Name", "SKU", "Size", "Category", "Cost", "Price", "On hand", "Image URL"];
    const rows = visibleBranchProducts.map((p) => [p.name, p.sku, p.size, p.category, branchInventoryCostCents(data, p, branch.id) / 100, branchProductPriceCents(p, branch.id) / 100, productOnHand(data, p, branch.id), p.imageUrl || ""]);
    downloadFile("visionary-products.csv", [headers, ...rows].map((r) => r.map(csvEscape).join(",")).join("\n"), "text/csv");
  };
  const downloadJSON = () => downloadFile("visionary-products.json", JSON.stringify(visibleBranchProducts.map((p) => ({ name: p.name, sku: p.sku, size: p.size, category: p.category, costCents: branchInventoryCostCents(data, p, branch.id), priceCents: branchProductPriceCents(p, branch.id), onHand: productOnHand(data, p, branch.id), imageUrl: p.imageUrl || null })), null, 2), "application/json");
  const emailSummary = () => {
    const totalVal = visibleBranchProducts.reduce((s, p) => s + productOnHand(data, p, branch.id) * branchInventoryCostCents(data, p, branch.id), 0);
    const subject = encodeURIComponent("Product catalog · " + branch.name);
    const body = encodeURIComponent("Products: " + visibleBranchProducts.length + "\nStock value (" + branch.name + "): " + fmt(totalVal, cur) + "\nGenerated: " + new Date().toLocaleString());
    try { window.open("mailto:?subject=" + subject + "&body=" + body, "_blank"); } catch (_) {}
  };
  const splitCsv = (line) => { const out = []; let curr = "", q = false; for (let i = 0; i < line.length; i++) { const ch = line[i]; if (ch === '"') { if (q && line[i + 1] === '"') { curr += '"'; i++; } else q = !q; } else if (ch === "," && !q) { out.push(curr); curr = ""; } else curr += ch; } out.push(curr); return out; };
  const importText = (text) => {
    const lines = text.split(/\r?\n/).filter((l) => l.trim() !== "");
    if (!lines.length) { setImpMsg("Nothing to import."); return; }
    const hasHeader = /name|sku|price/i.test(lines[0]);
    const idx = {}; if (hasHeader) splitCsv(lines[0]).forEach((c, i) => { idx[c.trim().toLowerCase()] = i; });
    const rows = hasHeader ? lines.slice(1) : lines;
    const num = (v) => Math.round(parseFloat(String(v || "").replace(/[^\d.]/g, "")) * 100) || 0;
    const parsed = rows.map((line) => { const c = splitCsv(line); const g = (k, pos) => (hasHeader && idx[k] !== undefined ? c[idx[k]] : c[pos]) || "";
      return { name: g("name", 0).trim(), sku: g("sku", 1).trim(), size: g("size", 2).trim() || "750 ML", category: g("category", 3).trim() || CATS[0], cost: num(g("cost", 4)), price: num(g("price", 5)) }; }).filter((r) => r.name || r.sku);
    let added = 0, updated = 0;
    update((d) => {
      const products = d.products.slice();
      let barcodeCatalog = d.barcodeCatalog || [];
      parsed.forEach((r) => {
        const i = r.sku ? products.findIndex((p) => p.sku && p.sku.toLowerCase() === r.sku.toLowerCase()) : -1;
        if (i >= 0) {
          const next = { ...products[i], name: r.name || products[i].name, size: r.size, category: r.category, synced: false, updatedAt: now() };
          products[i] = next;
          updated++;
        }
        else {
          const sku = r.sku || ("SIP" + Math.floor(1000 + Math.random() * 9000));
          const result = ensureBarcodeEntries({ ...d, barcodeCatalog }, [sku]);
          const entry = result.entries[0];
          barcodeCatalog = result.barcodeCatalog;
          const productBase = { id: uid("p"), branchId: branch.id, name: r.name || sku, sku, size: r.size, category: r.category, priceCents: 0, costCents: 0, barcode: sku, barcodeCatalogId: entry?.id || null, reorderLevel: d.settings.reorderLevel, status: "active", synced: false, updatedAt: now() };
          products.push(withBranchProductCost(productBase, branch.id, 0));
          added++;
        }
      });
      return { ...d, products, barcodeCatalog };
    });
    setImpMsg(added + " added · " + updated + " updated.");
  };
  const onImport = (e) => { const file = e.target.files && e.target.files[0]; if (!file) return; const r = new FileReader(); r.onload = () => importText(String(r.result)); r.readAsText(file); e.target.value = ""; };
  return (
    <div>
      <PageHead title="Products" sub={visibleBranchProducts.length + " items · " + enabledProductCount + " enabled"}
        right={<div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
          <button className={"btn sm " + (scannerOn ? "btn-primary" : "btn-ghost")} onClick={() => setScannerOn((v) => { const next = !v; if (next) window.setTimeout(() => (editId ? editBarcodeInputRef.current : barcodeInputRef.current)?.focus(), 0); return next; })}><Barcode /> USB scanner</button>
          <button type="button" className="btn sm btn-ghost" onClick={() => setCameraOpen(true)}><Camera /> Camera scan</button>
          <button className="btn sm btn-ghost" onClick={() => { setCopyOpen((v) => !v); setCopyMsg(""); }}><ArrowLeftRight /> Copy from branch</button>
          <button className="btn sm btn-ghost" onClick={() => document.getElementById("prodimport").click()}>Import</button>
          <button className="btn sm btn-ghost" onClick={exportCSV}>Export</button>
          <button className="btn sm btn-ghost" onClick={downloadJSON}>Download</button>
          <button className="btn sm btn-ghost" onClick={emailSummary}><Mail /> Email</button>
        </div>} />
      <input id="prodimport" type="file" accept=".csv,.txt" style={{ display: "none" }} onChange={onImport} />
      {copyOpen && (
        <div className="addpanel fade">
          <div className="page-h" style={{ marginBottom: 8 }}>
            <div>
              <div className="section-title" style={{ margin: 0 }}>Copy products to {branch.name}</div>
              <div className="sub">Copies missing products only. Barcodes stay shared; buying cost, selling price, margin, and stock start at 0. Buying cost is recalculated from received purchases.</div>
            </div>
            <button className="iconbtn" onClick={() => setCopyOpen(false)}><X /></button>
          </div>
          {copyBranches.length === 0 ? (
            <div className="notice">Create another branch first.</div>
          ) : (
            <>
              <div className="grid2">
                <div><label className="label">Source branch</label><select className="select" value={copyFrom} onChange={(e) => { setCopyFrom(e.target.value); setCopyMsg(""); }}>{copyBranches.map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}</select></div>
                <div><label className="label">Missing in {branch.name}</label><div className="input" style={{ display: "flex", alignItems: "center" }}>{countMissingFromSource(copyFrom)} product(s)</div></div>
              </div>
              <div style={{ display: "flex", gap: 10, marginTop: 14 }}>
                <button className="btn btn-primary" disabled={!copySource || countMissingFromSource(copyFrom) === 0} onClick={copyMissingProducts}><Check /> Copy missing products</button>
                <button className="btn btn-ghost" onClick={() => setCopyOpen(false)}>Cancel</button>
              </div>
              {copyMsg && <div className="notice" style={{ marginTop: 12 }}>{copyMsg}</div>}
            </>
          )}
        </div>
      )}
      {impMsg && <div className="notice" style={{ marginBottom: 12 }}>{impMsg} <button className="linknum" onClick={() => setImpMsg("")} style={{ marginLeft: 8 }}>dismiss</button></div>}
      {err && !adding && <div className="notice" style={{ marginBottom: 12 }}>{err} <button className="linknum" onClick={() => setErr("")} style={{ marginLeft: 8 }}>dismiss</button></div>}
      {delMsg && <div className="notice" style={{ marginBottom: 12, borderColor: "var(--danger)" }}><AlertCircle style={{ width: 14, height: 14, verticalAlign: "-2px", color: "var(--danger)" }} /> {delMsg} <button className="linknum" onClick={() => setDelMsg("")} style={{ marginLeft: 8 }}>dismiss</button></div>}
      {deleteTarget && <div className="notice" style={{ marginBottom: 12, borderColor: "var(--danger)", display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
        <AlertCircle style={{ width: 16, height: 16, color: "var(--danger)" }} />
        <span>Delete "{deleteTarget.name}"? This cannot be undone.</span>
        <div style={{ display: "inline-flex", gap: 8, marginLeft: "auto" }}>
          <button className="btn xs btn-ghost" onClick={() => setDeleteTarget(null)}>No</button>
          <button className="btn xs" style={{ background: "var(--danger)", color: "#fff" }} onClick={() => remove(deleteTarget.id)}>Yes, delete</button>
        </div>
      </div>}
      {!adding ? <button className="row-add" onClick={() => { setScannedProductId(""); setAdding(true); }}><Plus /> Add product</button> : (
        <div className="addpanel fade"><div className="section-title" style={{ margin: "0 0 12px" }}>New product</div>
          <div className="grid2"><div><label className="label">Name</label><input className="input" value={f.name} onChange={(e) => { setF({ ...f, name: e.target.value }); setErr(""); }} placeholder="e.g. Jameson Whisky 750ML" /></div>
            <div><label className="label">SKU</label><input className="input" value={f.sku} onChange={(e) => { setF({ ...f, sku: e.target.value }); setErr(""); }} placeholder="SIP0068" /></div></div>
          <div className="field" style={{ marginTop: 12 }}>
            <label className="label">Barcode scan</label>
            <div className="barcode-input-row"><input ref={barcodeInputRef} className="input" inputMode="numeric" autoComplete="off" readOnly={barcodeLocked} value={f.barcode} onChange={(e) => { setF({ ...f, barcode: cleanCode(e.target.value) }); setErr(""); }} onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); const code = cleanCode(f.barcode); if (code && data.products.some((p) => isBranchProduct(p) && productCodeMatch(p, code))) setErr("Barcode already exists in this branch."); else if (code && !f.name.trim()) e.currentTarget.closest(".addpanel")?.querySelector("input")?.focus(); } }} placeholder="Scan or enter barcode" /><button type="button" className="iconbtn" onClick={() => setCameraOpen(true)} aria-label="Scan barcode with camera" title="Scan barcode with camera"><Camera /></button></div>
          </div>
          <div className="grid2" style={{ marginTop: 12 }}>
            <div><label className="label">Additional barcodes</label><input className="input" value={f.extraBarcodes} onChange={(e) => setF({ ...f, extraBarcodes: e.target.value })} placeholder="Comma separated" /></div>
            <div><label className="label">Barcode preview</label><div className="input" style={{ display: "flex", alignItems: "center", justifyContent: "space-between", fontFamily: "var(--font-mono)", fontWeight: 800 }}><span>{cleanCode(f.barcode) || "Auto-generate"}</span><button className="btn xs btn-ghost" onClick={printBarcodeLabel}><Printer /> Print</button></div></div>
          </div>
          <div className="grid3" style={{ marginTop: 12 }}>
            <div><label className="label">Size</label><input className="input" value={f.size} onChange={(e) => setF({ ...f, size: e.target.value })} placeholder="750 ML" /></div>
            <div><label className="label">Category</label><select className="select" value={f.category} onChange={(e) => setF({ ...f, category: e.target.value })}>{CATS.map((c) => <option key={c}>{c}</option>)}</select></div>
            <div><label className="label">Selling price ({cur})</label><input className="input" value="Set in Pricing" readOnly disabled title="Selling prices are branch-specific and managed from Inventory > Pricing." /></div></div>
          <div className="grid3" style={{ marginTop: 12 }}>
            <div><label className="label">Buying cost ({cur})</label><input className="input" value="Calculated from purchases" readOnly disabled title="Buying cost is recalculated from received branch purchases." /></div>
            <div><label className="label">Tax (%)</label><input className="input" inputMode="decimal" value={f.tax} onChange={(e) => setF({ ...f, tax: e.target.value.replace(/[^\d.]/g, "") })} placeholder="0" /></div>
            <div><label className="label">Unit</label><input className="input" value={f.unit} onChange={(e) => setF({ ...f, unit: e.target.value })} placeholder="bottle" /></div>
          </div>
          <div className="grid3" style={{ marginTop: 12 }}>
            <div><label className="label">Supplier</label><select className="select" value={f.supplierId} onChange={(e) => setF({ ...f, supplierId: e.target.value })}><option value="">No supplier</option>{(data.suppliers || []).map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}</select></div>
            <div><label className="label">Initial stock</label><input className="input" inputMode="numeric" value={f.initialStock} onChange={(e) => setF({ ...f, initialStock: e.target.value.replace(/\D/g, "") })} placeholder="0" /></div>
            <div><label className="label">Low stock alert</label><input className="input" inputMode="numeric" value={f.lowStockAlert} onChange={(e) => setF({ ...f, lowStockAlert: e.target.value.replace(/\D/g, "") })} placeholder="4" /></div>
          </div>
          <div className="field"><label className="label">Product image</label><input className="input" value={f.imageUrl} onChange={(e) => setF({ ...f, imageUrl: e.target.value })} placeholder="Image URL" /></div>
          {err && <div className="alert"><AlertCircle />{err}</div>}
          <div style={{ display: "flex", gap: 10, marginTop: 16 }}><button className="btn btn-ghost" onClick={reset}>Cancel</button><button className="btn btn-primary" onClick={add}><Check /> Add product</button></div>
        </div>
      )}
      <div className="ptools">
        <div className="possearch"><Search /><input placeholder="Search products by name or SKU…" value={q} onChange={(e) => { setQ(e.target.value); setScannedProductId(""); }} /></div>
        <select className="select" style={{ width: 170 }} value={catF} onChange={(e) => { setCatF(e.target.value); setScannedProductId(""); }}>
          {["All", ...Array.from(new Set(visibleBranchProducts.map((p) => p.category)))].map((c) => <option key={c} value={c}>{c === "All" ? "All categories" : c}</option>)}</select>
        <select className="select" style={{ width: 145 }} value={statusF} onChange={(e) => { setStatusF(e.target.value); setScannedProductId(""); }} aria-label="Product status">
          <option value="all">All statuses</option><option value="enabled">Enabled</option><option value="disabled">Disabled</option>
        </select>
      </div>
      {scannedProduct && (() => {
        const quantity = productOnHand(data, scannedProduct, branch.id);
        const cost = branchInventoryCostCents(data, scannedProduct, branch.id);
        const price = branchProductPriceCents(scannedProduct, branch.id);
        const margin = price > 0 ? Math.round((price - cost) / price * 100) : 0;
        const supplier = data.suppliers.find((item) => item.id === scannedProduct.supplierId)?.name || "No supplier";
        const codes = [scannedProduct.barcode, ...(scannedProduct.barcodes || [])].filter(Boolean).join(", ") || "No barcode";
        return (
          <div className="xferinfo fade" role="status" style={{ marginBottom: 14 }}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: 12, flexWrap: "wrap" }}>
              <div><div className="nm" style={{ fontSize: 16 }}>{scannedProduct.name}</div><div className="sub" style={{ marginTop: 3 }}>{branch.name} product details</div></div>
              <div style={{ display: "flex", gap: 8 }}>
                <button className="btn xs btn-ghost" onClick={() => startEdit(scannedProduct)}>Edit product</button>
                <button className="iconbtn" onClick={() => setScannedProductId("")} aria-label="Clear scanned product" title="Clear scanned product"><X /></button>
              </div>
            </div>
            <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit,minmax(120px,1fr))", gap: 12, marginTop: 12, paddingTop: 12, borderTop: "1px solid var(--border-soft)" }}>
              <div><div className="sub">Quantity on hand</div><div className="nm" style={{ fontSize: 18 }}>{quantity} {scannedProduct.unit || "unit"}{quantity === 1 ? "" : "s"}</div></div>
              <div><div className="sub">Selling price</div><div className="nm">{fmt(price, cur)}</div></div>
              <div><div className="sub">Moving avg cost</div><div className="nm">{fmtExact(cost, cur, 6)}</div></div>
              <div><div className="sub">Margin</div><div className="nm">{margin}%</div></div>
              <div><div className="sub">Low stock alert</div><div className="nm">{scannedProduct.reorderLevel ?? data.settings.reorderLevel}</div></div>
            </div>
            <div className="sub" style={{ marginTop: 12, lineHeight: 1.65, overflowWrap: "anywhere" }}>
              SKU: <b>{scannedProduct.sku}</b> · Barcode: <b>{codes}</b> · Size: <b>{scannedProduct.size || "Not set"}</b> · Category: <b>{scannedProduct.category || "Other"}</b> · Supplier: <b>{supplier}</b>
            </div>
          </div>
        );
      })()}
      {(() => {
        const reorder = data.settings.reorderLevel || 4;
        const query = q.trim();
        const list = sortProductsAZ(visibleBranchProducts.filter((p) => scannedProductId
          ? p.id === scannedProductId
          : (statusF === "all" || (statusF === "enabled" ? productIsEnabled(p) : !productIsEnabled(p)))
            && (catF === "All" || p.category === catF)
            && (query === "" || p.name.toLowerCase().includes(query.toLowerCase()) || p.sku.toLowerCase().includes(query.toLowerCase()) || productCodeMatch(p, query) || [p.barcode, ...(p.barcodes || [])].some((code) => cleanCode(code).toLowerCase().includes(cleanCode(query).toLowerCase())))));
        return (
          <div className="ptblwrap">
            <table className="ptbl">
              <thead><tr><th></th><th>Product</th><th>Category</th><th className="num">Stock</th><th className="num">Moving avg cost</th><th className="num">Selling price</th><th className="num">Margin</th><th>Status</th><th></th></tr></thead>
              <tbody>
                {list.length === 0 && <tr><td colSpan={9} style={{ color: "var(--muted-2)", textAlign: "center", padding: 22 }}>No products match.</td></tr>}
                {list.map((p) => {
                  const left = productOnHand(data, p, branch.id);
                  const cls = left <= 0 ? "out" : left <= (p.reorderLevel ?? reorder) ? "low" : "ok";
                  const branchCost = branchInventoryCostCents(data, p, branch.id);
                  const branchPrice = branchProductPriceCents(p, branch.id);
                  const marg = branchPrice > 0 ? Math.round((branchPrice - branchCost) / branchPrice * 100) : 0;
                  if (editId === p.id) return (
                    <tr key={p.id}>
                      <td colSpan={9}>
                        <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
                          <input className="input" style={{ width: 220, height: 38 }} value={ef.name} onChange={(e) => { setEf({ ...ef, name: e.target.value }); setErr(""); }} placeholder="Product name" aria-label="Product name" />
                          <input ref={editBarcodeInputRef} className="input" style={{ width: 180, height: 38, fontFamily: "var(--font-mono)" }} inputMode="numeric" value={ef.barcode} onChange={(e) => { setEf({ ...ef, barcode: cleanCode(e.target.value) }); setErr(""); }} onKeyDown={(e) => { if (e.key === "Enter" || e.key === "Tab") { e.preventDefault(); handleProductScan(e.currentTarget.value); } }} placeholder="Scan barcode" />
                          <button type="button" className="iconbtn" onClick={() => setCameraOpen(true)} aria-label="Replace barcode using camera" title="Replace barcode using camera"><Camera /></button>
                          <input className="input" style={{ width: 220, height: 38, fontFamily: "var(--font-mono)" }} value={ef.extraBarcodes} onChange={(e) => setEf({ ...ef, extraBarcodes: e.target.value })} placeholder="Extra barcodes" />
                          <input className="input" style={{ width: 100, height: 38, fontFamily: "var(--font-mono)" }} value={(branchPrice / 100).toString()} readOnly disabled title="Selling price is managed from Inventory > Pricing." />
                          <input className="input" style={{ width: 100, height: 38, fontFamily: "var(--font-mono)" }} value={(branchCost / 100).toString()} readOnly disabled title="Buying cost is calculated from branch purchases." />
                          <button className="btn xs btn-primary" onClick={() => saveEdit(p)}><Check /> Save</button>
                          <button className="btn xs btn-ghost" onClick={() => setEditId(null)}>Cancel</button>
                        </div>
                      </td>
                    </tr>
                  );
                  return (
                    <tr key={p.id} className={productIsEnabled(p) ? "" : "product-row-disabled"}>
                      <td><div className="ptimg"><ProductImage src={productDisplayImage(p)} alt="" fit="cover" /></div></td>
                      <td><div className="ptname">{p.name}</div><div className="ptsub">{p.sku} · {p.size}</div></td>
                      <td><span className="ptcat">{p.category}</span></td>
                      <td className="num"><span className="ptstk"><span className={"dot " + cls} /> {left}</span></td>
                      <td className="num">{fmtExact(branchCost, cur, 6)}</td>
                      <td className="num">{fmt(branchPrice, cur)}</td>
                      <td className="num">{marg}%</td>
                      <td><button type="button" role="switch" aria-checked={productIsEnabled(p)} className={"product-enable-toggle" + (productIsEnabled(p) ? " on" : "")} onClick={() => setProductEnabled(p, !productIsEnabled(p))}>
                        <span className="product-enable-track"><span /></span><span>{productIsEnabled(p) ? "Enabled" : "Disabled"}</span>
                      </button></td>
                      <td><div className="ptact"><button className="btn xs btn-ghost" onClick={() => startEdit(p)}>Edit</button><button className="smdel" onClick={() => { setDelMsg(""); setDeleteTarget(p); }} aria-label={`Delete ${p.name}`}><Trash2 /></button></div></td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        );
      })()}
      {cameraOpen && <CameraBarcodeScanner onClose={() => setCameraOpen(false)} onScan={(barcode) => { setCameraOpen(false); handleProductScan(barcode); }} />}
    </div>
  );
}

/* ---- Stock ---- */
function StockTab({ data, update, branch }) {
  const cur = data.settings.currency;
  const countInputRefs = useRef(new Map());
  const [bId, setBId] = useState(branch.id);
  const [inventoryMode, setInventoryMode] = useState("full");
  const [q, setQ] = useState("");
  const [filter, setFilter] = useState("all");
  const [report, setReport] = useState(null);
  const [lossOpen, setLossOpen] = useState(false);
  const [lossCameraOpen, setLossCameraOpen] = useState(false);
  const [lossError, setLossError] = useState("");
  const [correctionOpen, setCorrectionOpen] = useState(false);
  const [correctionCameraOpen, setCorrectionCameraOpen] = useState(false);
  const [correctionError, setCorrectionError] = useState("");
  const [scannerOn, setScannerOn] = useState(true);
  const [cameraOpen, setCameraOpen] = useState(false);
  const [scanMsg, setScanMsg] = useState("");
  const [templateOpen, setTemplateOpen] = useState(false);
  const [templateSearch, setTemplateSearch] = useState("");
  const [templateSelectedIds, setTemplateSelectedIds] = useState([]);
  const [templateDateFrom, setTemplateDateFrom] = useState(() => mondayDateValue());
  const [templateDateTo, setTemplateDateTo] = useState(() => dateValuePlusDays(mondayDateValue(), 6));
  const [lf, setLf] = useState({ q: "", productId: "", qty: "", reason: "Theft", note: "" });
  const [cf, setCf] = useState({ q: "", productId: "", correctedQty: "", reason: "Incorrect quantity entered", note: "" });
  const LOSS_REASONS = ["Theft", "Breakage", "Expiry", "Spillage", "Other"];
  const CORRECTION_REASONS = ["Incorrect quantity entered", "Wrong purchase quantity", "Duplicate stock entry", "Wrong opening stock", "Wrong stock count", "Other"];
  const bname = data.branches.find((b) => b.id === bId)?.name || "branch";
  const session = activeStockCountSession(data, bId);
  const operator = stockCountOperator(data);
  const rows = stockCountRows(data, session);
  const progress = stockCountProgress(session);
  const uniqueProducts = branchProductsUnique(data, bId);
  const templateProducts = sortProductsAZ(uniqueProducts.filter((product) => productIsEnabled(product) || productOnHand(data, product, bId) > 0));
  const templateTerm = templateSearch.trim().toLowerCase();
  const filteredTemplateProducts = templateProducts.filter((product) => !templateTerm || product.name.toLowerCase().includes(templateTerm));
  const selectedTemplateProducts = templateProducts.filter((product) => templateSelectedIds.includes(product.id));
  const templateRange = stockTemplateDateRange(templateDateFrom, templateDateTo);
  const allFilteredTemplateProductsSelected = filteredTemplateProducts.length > 0 && filteredTemplateProducts.every((product) => templateSelectedIds.includes(product.id));
  const salesDuringCount = session ? rows.reduce((sum, row) => sum + row.soldSince, 0) : 0;
  const visibleRows = rows.filter((row) => {
    const term = q.trim().toLowerCase();
    const p = row.product;
    const matches = !term || p.name.toLowerCase().includes(term) || p.sku.toLowerCase().includes(term) || productMatchesBarcode(p, term) || productMatchesCatalog(p, findBarcodeCatalogEntry(data, term));
    if (!matches) return false;
    if (filter === "uncounted") return row.countedQty === null;
    if (filter === "counted") return row.countedQty !== null;
    if (filter === "variance") return row.countedQty !== null && row.varianceQty !== 0;
    return true;
  }).sort((a, b) => a.product.name.localeCompare(b.product.name));
  const varianceRows = rows.filter((row) => row.countedQty !== null && row.varianceQty !== 0);
  const countedRows = rows.filter((row) => row.countedQty !== null);
  const totalProducts = uniqueProducts.length;
  const totalUnits = uniqueProducts.reduce((s, p) => s + productOnHand(data, p, bId), 0);
  const stockValue = uniqueProducts.reduce((s, p) => s + productOnHand(data, p, bId) * branchInventoryCostCents(data, p, bId), 0);
  const lossList = data.stockMovements.filter((m) => typeof m.reason === "string" && m.reason.startsWith("Loss/Damage") && m.branchId === bId).sort((a, b) => b.ts - a.ts);
  const lossValue = lossList.reduce((s, m) => {
    const product = data.products.find((p) => p.id === m.productId);
    return s + Math.abs(m.qty) * (product ? branchInventoryCostCents(data, product, bId) : 0);
  }, 0);
  const lossTerm = lf.q.trim().toLowerCase();
  const lossProdMatches = lossTerm === "" || lf.productId ? [] : sortProductsAZ(uniqueProducts.filter((p) => p.name.toLowerCase().includes(lossTerm)
    || p.sku.toLowerCase().includes(lossTerm)
    || productMatchesBarcode(p, lossTerm)
    || productMatchesCatalog(p, findBarcodeCatalogEntry(data, lossTerm)))).slice(0, 8);
  const lossProd = data.products.find((p) => p.id === lf.productId);
  const correctionTerm = cf.q.trim().toLowerCase();
  const correctionMatches = correctionTerm === "" || cf.productId ? [] : sortProductsAZ(uniqueProducts.filter((p) => p.name.toLowerCase().includes(correctionTerm)
    || p.sku.toLowerCase().includes(correctionTerm)
    || productMatchesBarcode(p, correctionTerm)
    || productMatchesCatalog(p, findBarcodeCatalogEntry(data, correctionTerm)))).slice(0, 8);
  const correctionProduct = data.products.find((p) => p.id === cf.productId);
  const correctionCurrentQty = correctionProduct ? productOnHand(data, correctionProduct, bId) : null;
  const correctionQty = cf.correctedQty === "" ? null : parseInt(cf.correctedQty, 10);
  const correctionDelta = correctionQty === null || correctionCurrentQty === null ? null : correctionQty - correctionCurrentQty;
  const correctionList = (data.stockMovements || []).filter((movement) => movement.branchId === bId
    && (movement.mode === "correction" || String(movement.reason || "").startsWith("Stock correction")))
    .sort((a, b) => Number(b.ts || 0) - Number(a.ts || 0));

  const upsertSession = (nextSession) => update((d) => {
    const existing = d.stockCountSessions || [];
    const found = existing.some((s) => s.id === nextSession.id);
    return { ...d, stockCountSessions: found ? existing.map((s) => s.id === nextSession.id ? nextSession : s) : [...existing, nextSession] };
  });
  const startSession = () => {
    const existing = activeStockCountSession(data, bId);
    if (existing) {
      setScanMsg(existing.code + " is already " + existing.status + " for " + bname + ".");
      return;
    }
    const next = createStockCountSession(data, bId, operator);
    upsertSession(next);
    setReport(null);
    setScanMsg(next.code + " started. Expected quantities are now frozen.");
  };
  const setSessionStatus = (status) => {
    if (!session) return;
    const ts = now();
    const next = { ...session, status, synced: false, updatedAt: ts };
    if (status === "paused") Object.assign(next, { pausedBy: operator, pausedAt: ts });
    if (status === "open") Object.assign(next, { resumedBy: operator, resumedAt: ts });
    if (status === "cancelled") Object.assign(next, { cancelledBy: operator, cancelledAt: ts });
    upsertSession(next);
    setScanMsg(status === "cancelled" ? session.code + " cancelled." : session.code + " is now " + status + ".");
  };
  const setCount = (productId, raw) => {
    if (!session || session.status !== "open") return;
    const cleaned = String(raw || "").replace(/\D/g, "");
    const countedQty = cleaned === "" ? null : parseInt(cleaned, 10);
    upsertSession(updateStockCountSessionItem(session, productId, countedQty, operator));
  };
  const commitSession = () => {
    if (!session || session.status !== "open") return;
    if (progress.counted !== progress.total) {
      setScanMsg("Count every product before committing. " + (progress.total - progress.counted) + " item(s) remain.");
      return;
    }
    const ts = now();
    const movements = rows.filter((row) => row.commitDelta !== 0).map((row) => ({
      id: uid("mv"),
      productId: row.productId,
      branchId: bId,
      qty: row.commitDelta,
      mode: "count",
      reason: "Stock count " + session.code,
      stockCountSessionId: session.id,
      expectedQty: row.expectedQty,
      countedQty: row.countedQty,
      soldSince: row.soldSince,
      finalQty: row.finalQty,
      ts,
      synced: false,
    }));
    const logs = rows.map((row) => ({
      id: uid("cl"),
      productId: row.productId,
      branchId: bId,
      qty: row.countedQty,
      mode: "count",
      stockCountSessionId: session.id,
      system: row.expectedQty,
      counted: row.countedQty,
      soldSince: row.soldSince,
      finalQty: row.finalQty,
      variance: row.varianceQty,
      kind: "session",
      ts,
      synced: false,
    }));
    const jointDebt = createCashierJointDebt(data, session, rows, operator, ts);
    const committed = {
      ...session,
      status: "committed",
      committedBy: operator,
      committedAt: ts,
      summary: {
        counted: progress.counted,
        total: progress.total,
        variances: varianceRows.length,
        salesDuringCount,
        adjustments: movements.length,
        valueImpact: rows.reduce((s, row) => s + row.valueImpact, 0),
        missingInventoryDebtCents: jointDebt?.totalCents || 0,
        jointDebtCashiers: jointDebt?.cashierCount || 0,
      },
      synced: false,
      updatedAt: ts,
    };
    update((d) => {
      const existingJointDebts = d.cashierJointDebts || [];
      const cashierJointDebts = jointDebt && !existingJointDebts.some((debt) => debt.stockCountSessionId === session.id)
        ? [...existingJointDebts, jointDebt]
        : existingJointDebts;
      return { ...d, stockCountSessions: (d.stockCountSessions || []).map((s) => s.id === session.id ? committed : s), stockMovements: [...d.stockMovements, ...movements], countLog: [...(d.countLog || []), ...logs], cashierJointDebts };
    });
    setReport(buildStockCountReport(committed, rows, movements, data, bname));
    const debtMessage = jointDebt
      ? jointDebt.cashierCount > 0
        ? " Missing stock of " + fmt(jointDebt.totalCents, data.settings.currency) + " was shared across " + jointDebt.cashierCount + " cashier(s)."
        : " Missing stock of " + fmt(jointDebt.totalCents, data.settings.currency) + " is unallocated because this branch has no active cashiers."
      : "";
    setScanMsg(committed.code + " committed. " + movements.length + " adjustment(s) applied." + debtMessage);
  };
  const handleStockScan = (code) => {
    const barcode = normalizeBarcode(code);
    if (!isValidBarcode(barcode)) {
      setScanMsg("Invalid barcode: " + barcode);
      appendBarcodeScanLog({ barcode, status: "stock:invalid" });
      return false;
    }
    if (!session || session.status !== "open") {
      setScanMsg("Start or resume a stock count session before scanning.");
      appendBarcodeScanLog({ barcode, status: "stock:no_session" });
      return false;
    }
    const hit = barcodeLookup(data, barcode, bId);
    if (!hit || hit.unavailable) {
      setScanMsg(hit?.message || "Barcode not found: " + barcode);
      appendBarcodeScanLog({ barcode, status: hit?.unavailable ? "stock:branch_unavailable" : "stock:not_found" });
      return false;
    }
    const item = (session.items || []).find((x) => x.productId === hit.product.id);
    if (!item) {
      setScanMsg(hit.name + " is not part of this session snapshot.");
      appendBarcodeScanLog({ barcode, status: "stock:not_in_session", productId: hit.product.id });
      return false;
    }
    const nextQty = (Number(item.countedQty) || 0) + 1;
    upsertSession(updateStockCountSessionItem(session, hit.product.id, nextQty, operator));
    setScanMsg("Counted " + hit.name + " - running count " + nextQty + ".");
    appendBarcodeScanLog({ barcode, status: "stock:counted_session", productId: hit.product.id, sessionId: session.id });
    return true;
  };
  const focusCountInput = (productId) => {
    window.setTimeout(() => {
      const input = countInputRefs.current.get(productId);
      input?.focus();
      input?.select();
    }, 120);
  };
  const handleStockCameraScan = (code) => {
    const barcode = normalizeBarcode(code);
    if (!isValidBarcode(barcode)) {
      setScanMsg("Invalid barcode: " + barcode);
      appendBarcodeScanLog({ barcode, status: "stock_camera:invalid" });
      return false;
    }
    if (!session || session.status !== "open") {
      setScanMsg("Start or resume a stock count session before scanning.");
      appendBarcodeScanLog({ barcode, status: "stock_camera:no_session" });
      return false;
    }
    const hit = barcodeLookup(data, barcode, bId);
    if (!hit || hit.unavailable) {
      setScanMsg(hit?.message || "Barcode not found: " + barcode);
      appendBarcodeScanLog({ barcode, status: hit?.unavailable ? "stock_camera:branch_unavailable" : "stock_camera:not_found" });
      return false;
    }
    const item = (session.items || []).find((entry) => entry.productId === hit.product.id);
    if (!item) {
      setScanMsg(hit.name + " is not part of this session snapshot.");
      appendBarcodeScanLog({ barcode, status: "stock_camera:not_in_session", productId: hit.product.id });
      return false;
    }
    setFilter("all");
    setQ(hit.name);
    setScanMsg("Selected " + hit.name + ". Enter its physical count manually.");
    appendBarcodeScanLog({ barcode, status: "stock_camera:selected", productId: hit.product.id, sessionId: session.id });
    focusCountInput(hit.product.id);
    return true;
  };
  const resetLoss = () => {
    setLf({ q: "", productId: "", qty: "", reason: "Theft", note: "" });
    setLossError("");
  };
  const openLoss = () => {
    resetLoss();
    setLossOpen(true);
  };
  const closeLoss = () => {
    setLossCameraOpen(false);
    setLossOpen(false);
    resetLoss();
  };
  const selectLossProduct = (product) => {
    if (!product) return false;
    setLf((current) => ({ ...current, q: product.name, productId: product.id, qty: "" }));
    setLossError("");
    return true;
  };
  const handleLossScan = (code) => {
    const barcode = normalizeBarcode(code);
    if (!isValidBarcode(barcode)) {
      setLossError("Invalid barcode: " + barcode);
      appendBarcodeScanLog({ barcode, status: "loss_damage:invalid" });
      return false;
    }
    const hit = barcodeLookup(data, barcode, bId);
    if (!hit || hit.unavailable) {
      setLossError(hit?.message || "Barcode not found: " + barcode);
      appendBarcodeScanLog({ barcode, status: hit?.unavailable ? "loss_damage:branch_unavailable" : "loss_damage:not_found", barcodeCatalogId: hit?.barcodeCatalog?.id });
      return false;
    }
    const available = productOnHand(data, hit.product, bId);
    if (available <= 0) {
      setLossError(hit.name + " has no stock on hand at " + bname + ".");
      appendBarcodeScanLog({ barcode, status: "loss_damage:out_of_stock", productId: hit.product.id });
      return false;
    }
    selectLossProduct(hit.product);
    appendBarcodeScanLog({ barcode, status: "loss_damage:selected", productId: hit.product.id });
    return true;
  };
  const resetCorrection = () => {
    setCf({ q: "", productId: "", correctedQty: "", reason: "Incorrect quantity entered", note: "" });
    setCorrectionError("");
  };
  const openCorrection = () => {
    if (session) {
      setScanMsg("Finish or cancel " + session.code + " before correcting individual stock quantities.");
      return;
    }
    resetCorrection();
    setCorrectionOpen(true);
  };
  const closeCorrection = () => {
    setCorrectionCameraOpen(false);
    setCorrectionOpen(false);
    resetCorrection();
  };
  const selectCorrectionProduct = (product) => {
    if (!product) return false;
    setCf((current) => ({ ...current, q: product.name, productId: product.id, correctedQty: "" }));
    setCorrectionError("");
    return true;
  };
  const handleCorrectionScan = (code) => {
    const barcode = normalizeBarcode(code);
    if (!isValidBarcode(barcode)) {
      setCorrectionError("Invalid barcode: " + barcode);
      appendBarcodeScanLog({ barcode, status: "stock_correction:invalid" });
      return false;
    }
    const hit = barcodeLookup(data, barcode, bId);
    if (!hit || hit.unavailable) {
      setCorrectionError(hit?.message || "Barcode not found: " + barcode);
      appendBarcodeScanLog({ barcode, status: hit?.unavailable ? "stock_correction:branch_unavailable" : "stock_correction:not_found" });
      return false;
    }
    selectCorrectionProduct(hit.product);
    appendBarcodeScanLog({ barcode, status: "stock_correction:selected", productId: hit.product.id });
    return true;
  };
  const selectCorrectionSearch = () => {
    const exact = barcodeLookup(data, cf.q, bId);
    if (exact && !exact.unavailable) return selectCorrectionProduct(exact.product);
    if (correctionMatches.length === 1) return selectCorrectionProduct(correctionMatches[0]);
    setCorrectionError(correctionMatches.length ? "Select the correct product from the matches below." : "No matching product was found in " + bname + ".");
    return false;
  };
  const recordCorrection = () => {
    if (session) {
      setCorrectionError("Finish or cancel " + session.code + " before correcting stock.");
      return;
    }
    if (!correctionProduct || correctionCurrentQty === null) {
      setCorrectionError("Select a product to correct.");
      return;
    }
    if (!Number.isInteger(correctionQty) || correctionQty < 0) {
      setCorrectionError("Enter the correct non-negative quantity on hand.");
      return;
    }
    if (correctionDelta === 0) {
      setCorrectionError("The corrected quantity is already the current quantity.");
      return;
    }
    const ts = now();
    const reason = "Stock correction - " + cf.reason + (cf.note.trim() ? " - " + cf.note.trim() : "");
    const movement = {
      id: uid("mv"),
      productId: correctionProduct.id,
      branchId: bId,
      qty: correctionDelta,
      mode: "correction",
      reason,
      correctionReason: cf.reason,
      correctionNote: cf.note.trim(),
      previousQty: correctionCurrentQty,
      correctedQty: correctionQty,
      correctedBy: operator,
      ts,
      synced: false,
    };
    update((d) => ({ ...d, stockMovements: [...(d.stockMovements || []), movement] }));
    setScanMsg(correctionProduct.name + " corrected from " + correctionCurrentQty + " to " + correctionQty + " (" + (correctionDelta > 0 ? "+" : "") + correctionDelta + ").");
    closeCorrection();
  };
  useBarcodeScanner({ enabled: inventoryMode === "full" && scannerOn && !lossOpen && !lossCameraOpen && !correctionOpen && !correctionCameraOpen && !cameraOpen, mode: "stock", onScan: handleStockScan });
  const recordLoss = () => {
    const qty = parseInt(lf.qty, 10);
    if (!lossProd) {
      setLossError("Select a product to record as loss or damage.");
      return;
    }
    if (!qty || qty <= 0) {
      setLossError("Enter the quantity lost or damaged.");
      return;
    }
    const oh = onHand(data, lf.productId, bId);
    const dq = Math.min(qty, Math.max(0, oh));
    if (dq <= 0) {
      setLossError(lossProd.name + " has no stock on hand at " + bname + ".");
      return;
    }
    const reason = "Loss/Damage - " + lf.reason + (lf.note.trim() ? " - " + lf.note.trim() : "");
    update((d) => ({ ...d, stockMovements: [...d.stockMovements, { id: uid("mv"), productId: lf.productId, branchId: bId, qty: -dq, reason, ts: now(), synced: false }] }));
    setScanMsg(dq + " x " + lossProd.name + " recorded as " + lf.reason.toLowerCase() + " at " + bname + ".");
    setLossError("");
    setLf({ q: "", productId: "", qty: "", reason: lf.reason, note: "" });
  };
  const exportReport = (kind) => report && exportDiscrepancy(report, cur, kind);
  const openStockTemplate = () => {
    const monday = mondayDateValue();
    setTemplateSearch("");
    setTemplateSelectedIds([]);
    setTemplateDateFrom(monday);
    setTemplateDateTo(dateValuePlusDays(monday, 6));
    setTemplateOpen(true);
  };
  const toggleTemplateProduct = (productId) => setTemplateSelectedIds((current) => current.includes(productId)
    ? current.filter((id) => id !== productId)
    : [...current, productId]);
  const toggleAllFilteredTemplateProducts = () => setTemplateSelectedIds((current) => {
    const visibleIds = filteredTemplateProducts.map((product) => product.id);
    if (visibleIds.length && visibleIds.every((id) => current.includes(id))) return current.filter((id) => !visibleIds.includes(id));
    return Array.from(new Set([...current, ...visibleIds]));
  });
  const stockTemplateHeaders = () => ["Product name", ...templateRange.days.map((day) => day.label)];
  const stockTemplateRows = () => selectedTemplateProducts.map((product) => [product.name, ...templateRange.days.map(() => "")]);
  const stockTakingTemplateDocument = () => buildReportDocument({
    title: "Stock Taking Template",
    companyName: data.settings.store || "VISIONPOS",
    branchName: bname,
    generatedBy: operator || "VISIONPOS",
    dateRange: templateRange.label,
    filters: [{ label: "Shop", value: bname }, { label: "Selected products", value: selectedTemplateProducts.length }],
    headers: stockTemplateHeaders(),
    rows: stockTemplateRows(),
    totals: [],
    orientation: "landscape",
  });
  const exportStockTakingTemplate = (kind) => {
    if (!selectedTemplateProducts.length) return;
    const templateDocument = stockTakingTemplateDocument();
    if (kind === "print") printReport(templateDocument);
    else if (kind === "pdf") downloadPDF(templateDocument);
    else {
      const metadata = [["Shop", bname], ["Date range", templateRange.label], [], stockTemplateHeaders()];
      const branchSlug = String(bname).trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "shop";
      downloadFile("stock-taking-" + branchSlug + "-" + templateRange.fromValue + ".csv", [...metadata, ...stockTemplateRows()].map((row) => row.map(csvEscape).join(",")).join("\n"), "text/csv");
    }
  };

  if (inventoryMode === "quick") {
    return <QuickInventoryTab data={data} update={update} branch={branch} initialBranchId={bId} onBack={(nextBranchId) => { setBId(nextBranchId || bId); setInventoryMode("full"); }} />;
  }

  return (
    <div>
      <PageHead title="Stock" sub={"Locked stock count sessions & levels - " + bname} />
      <div className="ptools">
        <select className="select" style={{ width: 180 }} value={bId} onChange={(e) => { setBId(e.target.value); setReport(null); setTemplateOpen(false); setTemplateSelectedIds([]); }}>
          {data.branches.map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}
        </select>
        <div className="possearch"><Search /><input placeholder="Search product name, SKU, or barcode..." value={q} onChange={(e) => setQ(e.target.value)} /></div>
        <button className="btn sm btn-primary" onClick={() => setInventoryMode("quick")}><ClipboardCheck /> Quick inventory</button>
        <button className="btn sm btn-ghost" disabled={!!session} onClick={openCorrection} title={session ? "Finish or cancel the active stock count first" : "Correct a wrongly entered stock quantity"}><Wrench /> Correct stock</button>
        <button className={"btn sm " + (scannerOn ? "btn-primary" : "btn-ghost")} onClick={() => setScannerOn((v) => !v)}><Barcode /> USB scanner</button>
        <button className="btn sm btn-ghost" disabled={session?.status !== "open"} onClick={() => setCameraOpen(true)}><Camera /> Camera scan</button>
        <button className="btn sm btn-ghost" onClick={openLoss}><TrendingDown /> Record loss / damage</button>
        <button className="btn sm btn-ghost" onClick={openStockTemplate}><Download /> Stock template</button>
      </div>
      {scanMsg && <div className="notice" style={{ marginBottom: 12 }}>{scanMsg} <button className="linknum" onClick={() => setScanMsg("")} style={{ marginLeft: 8 }}>dismiss</button></div>}
      <div className="cashtiles" style={{ gridTemplateColumns: "repeat(4,1fr)", marginBottom: 16 }}>
        <div className="ctile"><div className="ic"><Boxes /></div><div><div className="cl">Total products</div><div className="cv">{totalProducts}</div></div></div>
        <div className="ctile"><div className="ic"><Package /></div><div><div className="cl">Live units</div><div className="cv">{totalUnits}</div></div></div>
        <div className="ctile"><div className="ic"><Wallet /></div><div><div className="cl">Stock value</div><div className="cv">{fmt(stockValue, cur)}</div></div></div>
        <div className={"ctile" + (lossValue > 0 ? " warn" : "")}><div className="ic"><TrendingDown /></div><div><div className="cl">Loss &amp; damage</div><div className="cv">{fmt(lossValue, cur)}</div><div className="cs">{lossList.length} write-off{lossList.length === 1 ? "" : "s"}</div></div></div>
      </div>

      {!session ? (
        <div className="panel fade" style={{ padding: 22 }}>
          <div className="page-h" style={{ marginBottom: 10 }}>
            <div><div className="title" style={{ fontSize: 20 }}>No active stock count</div><div className="sub">Starting a count locks {bname} to one resumable session. Expected quantities are frozen at start.</div></div>
            <button className="btn btn-primary" onClick={startSession}><ClipboardCheck /> Start stock count</button>
          </div>
          <div className="notice">Sales can continue during a count. On commit, VisionPOS reconciles counted stock against sales made after the snapshot.</div>
        </div>
      ) : (
        <div className="panel fade" style={{ padding: 18 }}>
          <div className="page-h" style={{ marginBottom: 12 }}>
            <div>
              <div className="title" style={{ fontSize: 19 }}>{session.code} <span className={"ist " + (session.status === "open" ? "paid" : "open")}>{session.status}</span></div>
              <div className="sub">Started by {session.startedBy || "Unknown"} - {dt(session.startedAt)} - {bname}</div>
            </div>
            <div className="expbtns">
              {session.status === "open" ? <button className="btn xs btn-ghost" onClick={() => setSessionStatus("paused")}><RefreshCw /> Pause</button> : <button className="btn xs btn-primary" onClick={() => setSessionStatus("open")}><RefreshCw /> Resume</button>}
              <button className="btn xs btn-primary" disabled={session.status !== "open" || progress.counted !== progress.total} onClick={commitSession}><Check /> Review &amp; commit</button>
              <button className="btn xs btn-ghost" onClick={() => setSessionStatus("cancelled")}><X /> Cancel</button>
            </div>
          </div>
          <div className="stats" style={{ marginBottom: 12 }}>
            <div className="stat"><div className="sl">Progress</div><div className="sv">{progress.counted}/{progress.total}</div></div>
            <div className="stat"><div className="sl">Variances</div><div className={"sv" + (varianceRows.length ? " warn" : "")}>{varianceRows.length}</div></div>
            <div className="stat"><div className="sl">Sales during count</div><div className={"sv" + (salesDuringCount ? " warn" : "")}>{salesDuringCount}</div></div>
            <div className="stat"><div className="sl">Value impact</div><div className="sv">{fmt(rows.reduce((s, row) => s + row.valueImpact, 0), cur)}</div></div>
          </div>
          <div style={{ height: 8, borderRadius: 99, background: "var(--line)", overflow: "hidden", marginBottom: 12 }}><div style={{ width: progress.percent + "%", height: "100%", background: "var(--accent)" }} /></div>
          {salesDuringCount > 0 && <div className="notice" style={{ marginBottom: 12 }}>Sales happened after the snapshot. Commit will reconcile final stock as counted minus sold since start.</div>}
          <div className="cfilter">
            {[["all", "All"], ["uncounted", "Uncounted"], ["counted", "Counted"], ["variance", "Variances"]].map(([k, l]) => <button key={k} className={"seg" + (filter === k ? " on" : "")} onClick={() => setFilter(k)}>{l}</button>)}
            <span className="cfilthint">{visibleRows.length} shown</span>
          </div>
          <div className="tablewrap tblscroll" style={{ marginTop: 12 }}>
            <table className="tbl"><thead><tr><th>Product</th><th>Expected</th><th>Counted</th><th>Variance</th><th>Value</th><th>Final</th></tr></thead>
              <tbody>{visibleRows.map((row) => (
                <tr key={row.productId} className={row.countedQty !== null ? "rowsel" : ""}>
                  <td><div className="nm">{row.product.name}</div><div className="mt2">{row.product.sku} / {row.product.size}</div></td>
                  <td style={{ fontWeight: 700 }}>{row.expectedQty}</td>
                  <td><input ref={(node) => { if (node) countInputRefs.current.set(row.productId, node); else countInputRefs.current.delete(row.productId); }} className="input" disabled={session.status !== "open"} style={{ width: 92, height: 38, fontFamily: "var(--font-mono)" }} inputMode="numeric" placeholder="Count" value={row.countedQty ?? ""} onChange={(e) => setCount(row.productId, e.target.value)} /></td>
                  <td style={{ fontWeight: 700, color: row.varianceQty < 0 ? "var(--danger)" : row.varianceQty > 0 ? "var(--ok)" : "var(--muted-2)" }}>{row.countedQty === null ? "-" : (row.varianceQty > 0 ? "+" : "") + row.varianceQty}</td>
                  <td className="amt">{fmt(row.valueImpact, cur)}</td>
                  <td><div className="nm">{row.finalQty === null ? "-" : row.finalQty}</div>{row.soldSince > 0 && <div className="mt2">{row.soldSince} sold after snapshot</div>}</td>
                </tr>
              ))}
              {visibleRows.length === 0 && <tr><td colSpan="6"><div className="notice">No products match.</div></td></tr>}</tbody></table>
          </div>
        </div>
      )}

      {report && (
        <div className="panel fade" style={{ marginTop: 18 }}>
          <div className="page-h" style={{ marginBottom: 4 }}>
            <div><div className="title" style={{ fontSize: 17 }}>Stock Count Report</div><div className="sub">{report.branchName} - {report.code} - {dt(report.ts)} - {report.discrepancies.length} variance(s)</div></div>
            <div className="expbtns"><button className="btn xs btn-primary" onClick={() => exportReport("pdf")}><FileText /> Download PDF</button><button className="btn xs btn-ghost" onClick={() => exportReport("print")}><Printer /> Print</button><button className="btn xs btn-ghost" onClick={() => exportReport("csv")}>CSV</button><button className="btn xs btn-ghost" onClick={() => exportReport("json")}>JSON</button><button className="iconbtn" onClick={() => setReport(null)}><X /></button></div>
          </div>
          <div className="stats">
            <div className="stat"><div className="sl">Discrepancies</div><div className={"sv" + (report.discrepancies.length ? " warn" : "")}>{report.discrepancies.length}</div></div>
            <div className="stat"><div className="sl">Shortage total</div><div className={"sv" + (report.shortCost ? " warn" : "")}>{fmt(report.shortCost, cur)}</div></div>
            <div className="stat"><div className="sl">Overage total</div><div className="sv">{fmt(report.overCost, cur)}</div></div>
            <div className="stat"><div className="sl">Net variance value</div><div className={"sv" + (report.varianceCost < 0 ? " warn" : "")}>{fmt(report.varianceCost, cur)}</div></div>
          </div>
        </div>
      )}
      <DocumentFile title="Stock correction records" count={correctionList.length} meta={`Audited quantity corrections for ${bname}`}>
          {correctionList.length > 0 ? <div className="list">{correctionList.slice(0, 10).map((movement) => {
            const product = data.products.find((p) => p.id === movement.productId);
            const delta = Number(movement.qty || 0);
            const previous = Number.isFinite(Number(movement.previousQty)) ? Number(movement.previousQty) : null;
            const corrected = Number.isFinite(Number(movement.correctedQty)) ? Number(movement.correctedQty) : null;
            return <div className="row" key={movement.id}>
              <div className="meta"><div className="nm">{product?.name || "Product"}</div><div className="mt2">{previous === null || corrected === null ? "Quantity adjusted" : previous + " to " + corrected} - {movement.correctionReason || movement.reason} - {movement.correctedBy || "Admin"} - {dt(movement.ts)}</div></div>
              <span className="pill plain" style={{ color: delta < 0 ? "var(--danger)" : "var(--ok)" }}>{delta > 0 ? "+" : ""}{delta}</span>
            </div>;
          })}</div> : <div className="notice">No stock corrections recorded for this branch.</div>}
      </DocumentFile>
      {templateOpen && (
        <div className="scrim" onClick={() => setTemplateOpen(false)}>
          <div className="modal" style={{ maxWidth: 720 }} onClick={(event) => event.stopPropagation()}>
            <div className="modal-head">
              <div><div className="sub" style={{ margin: 0 }}>{bname}</div><div className="title" style={{ fontSize: 21 }}>Stock taking template</div></div>
              <button className="iconbtn" onClick={() => setTemplateOpen(false)} aria-label="Close stock taking template"><X /></button>
            </div>
            <div className="grid2" style={{ marginTop: 14 }}>
              <div><label className="label">From date</label><input className="input" type="date" value={templateRange.fromValue} onChange={(event) => {
                const nextFrom = event.target.value;
                const nextMaximum = dateValuePlusDays(nextFrom, 6);
                setTemplateDateFrom(nextFrom);
                if (templateDateTo < nextFrom || templateDateTo > nextMaximum) setTemplateDateTo(nextMaximum);
              }} /></div>
              <div><label className="label">To date</label><input className="input" type="date" min={templateRange.fromValue} max={templateRange.maximumToValue} value={templateRange.toValue} onChange={(event) => setTemplateDateTo(event.target.value)} /></div>
            </div>
            <div className="notice" style={{ marginTop: 12 }}>{templateRange.label} · Choose any range of up to seven days.</div>
            <div className="possearch" style={{ marginTop: 14 }}><Search /><input placeholder="Find product by name..." value={templateSearch} onChange={(event) => setTemplateSearch(event.target.value)} /></div>
            <div className="tablewrap" style={{ marginTop: 12, maxHeight: 340, overflow: "auto" }}>
              <table className="tbl">
                <thead><tr><th style={{ width: 44 }}><input type="checkbox" aria-label="Select all matching products" checked={allFilteredTemplateProductsSelected} onChange={toggleAllFilteredTemplateProducts} /></th><th>Product name</th></tr></thead>
                <tbody>
                  {filteredTemplateProducts.map((product) => <tr key={product.id} className={templateSelectedIds.includes(product.id) ? "rowsel" : ""}>
                    <td><input type="checkbox" aria-label={`Select ${product.name}`} checked={templateSelectedIds.includes(product.id)} onChange={() => toggleTemplateProduct(product.id)} /></td>
                    <td><div className="nm">{product.name}</div>{!productIsEnabled(product) && <div className="mt2">Disabled product with stock on hand</div>}</td>
                  </tr>)}
                  {!filteredTemplateProducts.length && <tr><td colSpan="2"><div className="notice">No products match this search.</div></td></tr>}
                </tbody>
              </table>
            </div>
            <div className="page-h" style={{ marginTop: 14, marginBottom: 0 }}>
              <div><div className="nm">{selectedTemplateProducts.length} selected</div><div className="mt2">Products run vertically; the selected dates are headers with blank count cells.</div></div>
              <div className="expbtns">
                {selectedTemplateProducts.length > 0 && <button className="btn sm btn-ghost" onClick={() => setTemplateSelectedIds([])}>Clear</button>}
                <button className="btn sm btn-ghost" disabled={!selectedTemplateProducts.length} onClick={() => exportStockTakingTemplate("csv")}><Download /> CSV</button>
                <button className="btn sm btn-ghost" disabled={!selectedTemplateProducts.length} onClick={() => exportStockTakingTemplate("pdf")}><FileText /> PDF</button>
                <button className="btn sm btn-primary" disabled={!selectedTemplateProducts.length} onClick={() => exportStockTakingTemplate("print")}><Printer /> Print</button>
              </div>
            </div>
          </div>
        </div>
      )}
      {cameraOpen && (
        <CameraBarcodeScanner
          eyebrow="Inventory count"
          title={"Scan product - " + bname}
          onClose={() => setCameraOpen(false)}
          onScan={handleStockCameraScan}
        />
      )}
      {correctionOpen && (
        <div className="scrim" onClick={closeCorrection}>
          <div className="modal" style={{ maxWidth: 620 }} onClick={(event) => event.stopPropagation()}>
            <div className="modal-head"><div><div className="sub" style={{ margin: 0 }}>{bname}</div><div className="title" style={{ fontSize: 21 }}>Correct stock quantity</div></div><button className="iconbtn" onClick={closeCorrection}><X /></button></div>
            <div className="notice" style={{ marginTop: 12 }}>Use this only to repair an incorrect entry. VisionPOS will preserve the old quantity, correction reason, operator, and time in the stock ledger.</div>
            {correctionError && <div className="alert error" style={{ marginTop: 12 }}><AlertCircle />{correctionError}</div>}
            <label className="label" style={{ marginTop: 14 }}>Find product</label>
            <div className="barcode-input-row">
              <div className="possearch" style={{ height: 44 }}><Search /><input autoFocus placeholder="Search name, SKU, or scan barcode..." value={cf.q} onChange={(event) => { setCf({ ...cf, q: event.target.value, productId: "", correctedQty: "" }); setCorrectionError(""); }} onKeyDown={(event) => { if (event.key === "Enter" || event.key === "Tab") { event.preventDefault(); selectCorrectionSearch(); } }} /></div>
              <button type="button" className="iconbtn" onClick={() => setCorrectionCameraOpen(true)} aria-label="Scan product barcode with camera" title="Scan product barcode with camera"><Camera /></button>
            </div>
            {correctionTerm !== "" && !correctionProduct && <div style={{ display: "flex", flexWrap: "wrap", gap: 8, marginTop: 10 }}>{correctionMatches.length === 0 ? <span className="cust-meta">No match.</span> : correctionMatches.map((product) => <button key={product.id} className="inschip" onClick={() => selectCorrectionProduct(product)}>{product.name} - {productOnHand(data, product, bId)} on hand</button>)}</div>}
            {correctionProduct && <>
              <div className="notice" style={{ marginTop: 12 }}><b>{correctionProduct.name}</b> - {correctionProduct.sku} - currently <b>{correctionCurrentQty}</b> on hand</div>
              <div className="grid2" style={{ marginTop: 12 }}>
                <div><label className="label">Current quantity</label><input className="input" value={correctionCurrentQty} readOnly /></div>
                <div><label className="label">Correct quantity</label><input className="input" inputMode="numeric" value={cf.correctedQty} onChange={(event) => { setCf({ ...cf, correctedQty: event.target.value.replace(/\D/g, "") }); setCorrectionError(""); }} placeholder="Enter physical quantity" /></div>
              </div>
              <div className="field" style={{ marginTop: 12 }}><label className="label">Correction reason</label><select className="select" value={cf.reason} onChange={(event) => setCf({ ...cf, reason: event.target.value })}>{CORRECTION_REASONS.map((reasonOption) => <option key={reasonOption}>{reasonOption}</option>)}</select></div>
              <div className="field" style={{ marginTop: 12 }}><label className="label">Note (optional)</label><input className="input" value={cf.note} onChange={(event) => setCf({ ...cf, note: event.target.value })} placeholder="e.g. purchase quantity entered twice" /></div>
              {correctionDelta !== null && correctionDelta !== 0 && <div className="notice" style={{ marginTop: 12 }}>This correction will {correctionDelta > 0 ? "add " + correctionDelta : "remove " + Math.abs(correctionDelta)} unit{Math.abs(correctionDelta) === 1 ? "" : "s"}.</div>}
              <button className="btn btn-primary" style={{ marginTop: 14 }} disabled={correctionQty === null || correctionDelta === 0} onClick={recordCorrection}><Check /> Apply stock correction</button>
            </>}
          </div>
        </div>
      )}
      {correctionCameraOpen && (
        <CameraBarcodeScanner
          eyebrow="Stock correction"
          title={"Select product - " + bname}
          onClose={() => setCorrectionCameraOpen(false)}
          onScan={(barcode) => { const accepted = handleCorrectionScan(barcode); if (accepted) setCorrectionCameraOpen(false); return accepted; }}
        />
      )}
      {lossOpen && (
        <div className="scrim" onClick={closeLoss}>
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <div className="modal-head"><div><div className="sub" style={{ margin: 0 }}>{bname}</div><div className="title" style={{ fontSize: 21 }}>Record loss / damage</div></div><button className="iconbtn" onClick={closeLoss}><X /></button></div>
            <label className="label" style={{ marginTop: 12 }}>Find product</label>
            <div className="barcode-input-row">
              <div className="possearch" style={{ height: 44 }}><Search /><input autoFocus placeholder="Search name, SKU, or barcode..." value={lf.q} onChange={(e) => { setLf({ ...lf, q: e.target.value, productId: "", qty: "" }); setLossError(""); }} /></div>
              <button type="button" className="iconbtn" onClick={() => { setLossError(""); setLossCameraOpen(true); }} aria-label="Scan product barcode with camera" title="Scan product barcode with camera"><Camera /></button>
            </div>
            {lossError && <div className="alert error" style={{ marginTop: 12 }}><AlertCircle />{lossError}</div>}
            {lossTerm !== "" && !lossProd && <div style={{ display: "flex", flexWrap: "wrap", gap: 8, marginTop: 10 }}>{lossProdMatches.length === 0 ? <span className="cust-meta">No match.</span> : lossProdMatches.map((p) => <button key={p.id} className="inschip" onClick={() => selectLossProduct(p)}>{p.name} - {productOnHand(data, p, bId)} on hand</button>)}</div>}
            {lossProd && <>
              <div className="notice" style={{ marginTop: 10 }}>{lossProd.name} - <b>{onHand(data, lossProd.id, bId)}</b> on hand at {bname}</div>
              <div className="grid2" style={{ marginTop: 12 }}><div><label className="label">Quantity lost</label><input className="input" inputMode="numeric" value={lf.qty} onChange={(e) => setLf({ ...lf, qty: e.target.value.replace(/\D/g, "") })} placeholder="1" /></div><div><label className="label">Reason</label><select className="select" value={lf.reason} onChange={(e) => setLf({ ...lf, reason: e.target.value })}>{LOSS_REASONS.map((r) => <option key={r}>{r}</option>)}</select></div></div>
              <div className="field" style={{ marginTop: 12 }}><label className="label">Note (optional)</label><input className="input" value={lf.note} onChange={(e) => setLf({ ...lf, note: e.target.value })} placeholder="e.g. broken in transit" /></div>
              <button className="btn btn-primary" style={{ marginTop: 14 }} disabled={!(parseInt(lf.qty, 10) > 0)} onClick={recordLoss}><Check /> Record write-off</button>
            </>}
          </div>
        </div>
      )}
      {lossCameraOpen && (
        <CameraBarcodeScanner
          eyebrow="Loss & damage"
          title={"Select product - " + bname}
          onClose={() => setLossCameraOpen(false)}
          onScan={(barcode) => { const accepted = handleLossScan(barcode); if (accepted) setLossCameraOpen(false); return accepted; }}
        />
      )}
    </div>
  );
}

function QuickInventoryTab({ data, update, branch, initialBranchId, onBack }) {
  const cur = data.settings.currency;
  const operator = stockCountOperator(data);
  const countInputRefs = useRef(new Map());
  const applyingRef = useRef(false);
  const [bId, setBId] = useState(initialBranchId || branch.id);
  const [q, setQ] = useState("");
  const [counts, setCounts] = useState({});
  const [scannerOn, setScannerOn] = useState(true);
  const [cameraOpen, setCameraOpen] = useState(false);
  const [message, setMessage] = useState("");
  const [report, setReport] = useState(null);
  const bname = data.branches.find((b) => b.id === bId)?.name || "branch";
  const lockedSession = activeStockCountSession(data, bId);
  const products = sortProductsAZ(branchProductsUnique(data, bId));
  const term = q.trim().toLowerCase();
  const matches = term ? products.filter((p) => (
    p.name.toLowerCase().includes(term)
    || p.sku.toLowerCase().includes(term)
    || productMatchesBarcode(p, term)
    || productMatchesCatalog(p, findBarcodeCatalogEntry(data, term))
  )).slice(0, 60) : [];
  const selectedProducts = products.filter((p) => Object.prototype.hasOwnProperty.call(counts, p.id));
  const displayedProducts = term
    ? [...selectedProducts, ...matches.filter((p) => !Object.prototype.hasOwnProperty.call(counts, p.id))]
    : selectedProducts;
  const selectedRows = selectedProducts.map((product) => {
    const current = productOnHand(data, product, bId);
    const counted = Number(counts[product.id]);
    return { product, current, counted, variance: counted - current };
  });
  const currentUnits = selectedRows.reduce((sum, row) => sum + row.current, 0);
  const countedUnits = selectedRows.reduce((sum, row) => sum + row.counted, 0);
  const varianceUnits = selectedRows.reduce((sum, row) => sum + row.variance, 0);
  const adjustmentCount = selectedRows.filter((row) => row.variance !== 0).length;

  const setCount = (productId, raw) => {
    if (lockedSession) return;
    const cleaned = String(raw ?? "").replace(/\D/g, "");
    setCounts((existing) => {
      const next = { ...existing };
      if (cleaned === "") delete next[productId];
      else next[productId] = String(Math.max(0, parseInt(cleaned, 10) || 0));
      return next;
    });
  };
  const clearSelection = (productId) => setCounts((existing) => {
    const next = { ...existing };
    delete next[productId];
    return next;
  });
  const changeBranch = (nextBranchId) => {
    setBId(nextBranchId);
    setCounts({});
    setQ("");
    setMessage("");
    setReport(null);
  };
  const handleQuickScan = (code) => {
    const barcode = normalizeBarcode(code);
    if (lockedSession) {
      setMessage("Quick inventory is unavailable while " + lockedSession.code + " is active for " + bname + ".");
      return false;
    }
    if (!isValidBarcode(barcode)) {
      setMessage("Invalid barcode: " + barcode);
      appendBarcodeScanLog({ barcode, status: "quick_inventory:invalid" });
      return false;
    }
    const hit = barcodeLookup(data, barcode, bId);
    if (!hit || hit.unavailable) {
      setMessage(hit?.message || "Barcode not found: " + barcode);
      appendBarcodeScanLog({ barcode, status: hit?.unavailable ? "quick_inventory:branch_unavailable" : "quick_inventory:not_found" });
      return false;
    }
    setCounts((existing) => ({ ...existing, [hit.product.id]: String((parseInt(existing[hit.product.id], 10) || 0) + 1) }));
    setMessage("Counted " + hit.name + ". Scan again to increase its physical count.");
    appendBarcodeScanLog({ barcode, status: "quick_inventory:counted", productId: hit.product.id });
    return true;
  };
  const focusCountInput = (productId) => {
    window.setTimeout(() => {
      const input = countInputRefs.current.get(productId);
      input?.focus();
      input?.select();
    }, 120);
  };
  const handleQuickCameraScan = (code) => {
    const barcode = normalizeBarcode(code);
    if (lockedSession) {
      setMessage("Quick inventory is unavailable while " + lockedSession.code + " is active for " + bname + ".");
      return false;
    }
    if (!isValidBarcode(barcode)) {
      setMessage("Invalid barcode: " + barcode);
      appendBarcodeScanLog({ barcode, status: "quick_inventory_camera:invalid" });
      return false;
    }
    const hit = barcodeLookup(data, barcode, bId);
    if (!hit || hit.unavailable) {
      setMessage(hit?.message || "Barcode not found: " + barcode);
      appendBarcodeScanLog({ barcode, status: hit?.unavailable ? "quick_inventory_camera:branch_unavailable" : "quick_inventory_camera:not_found" });
      return false;
    }
    setQ(hit.name);
    setMessage("Selected " + hit.name + ". Enter its physical count manually.");
    appendBarcodeScanLog({ barcode, status: "quick_inventory_camera:selected", productId: hit.product.id });
    focusCountInput(hit.product.id);
    return true;
  };
  useBarcodeScanner({ enabled: scannerOn && !lockedSession && !cameraOpen, mode: "stock", onScan: handleQuickScan });

  const applyCounts = () => {
    if (applyingRef.current) return;
    if (lockedSession) {
      setMessage("Finish or cancel " + lockedSession.code + " before using Quick inventory.");
      return;
    }
    if (!selectedRows.length) {
      setMessage("Search or scan at least one product and enter its physical count.");
      return;
    }
    applyingRef.current = true;
    try {
      const ts = now();
      const quickInventoryId = uid("qi");
      const quickInventoryBatch = {
        id: quickInventoryId,
        code: nextQuickInventoryNumber(data),
        branchId: bId,
      };
      const adjustments = selectedRows.filter((row) => row.variance !== 0).map((row) => ({
        id: uid("mv"),
        productId: row.product.id,
        branchId: bId,
        qty: row.variance,
        mode: "count",
        reason: "Quick inventory",
        quickInventoryId,
        quickInventoryCode: quickInventoryBatch.code,
        expectedQty: row.current,
        countedQty: row.counted,
        ts,
        synced: false,
      }));
      const logs = selectedRows.map((row) => ({
        id: uid("cl"),
        productId: row.product.id,
        branchId: bId,
        qty: row.counted,
        mode: "quick_count",
        system: row.current,
        counted: row.counted,
        variance: row.variance,
        kind: "quick",
        quickInventoryId,
        quickInventoryCode: quickInventoryBatch.code,
        ts,
        synced: false,
      }));
      const debtRows = selectedRows.map((row) => ({
        ...row,
        productId: row.product.id,
        varianceQty: row.variance,
      }));
      const jointDebt = createCashierJointDebt(data, quickInventoryBatch, debtRows, operator, ts, "quick_inventory");
      update((d) => {
        const existingJointDebts = d.cashierJointDebts || [];
        const cashierJointDebts = jointDebt && !existingJointDebts.some((debt) => debt.stockCountSessionId === quickInventoryId)
          ? [...existingJointDebts, jointDebt]
          : existingJointDebts;
        return {
          ...d,
          stockMovements: [...(d.stockMovements || []), ...adjustments],
          countLog: [...(d.countLog || []), ...logs],
          cashierJointDebts,
        };
      });
      setReport({ ts, branchName: bname, code: quickInventoryBatch.code, rows: selectedRows, adjustments: adjustments.length, jointDebt });
      setCounts({});
      setQ("");
      const debtMessage = jointDebt
        ? jointDebt.cashierCount > 0
          ? " " + fmt(jointDebt.totalCents, cur) + " was added to the joint cashier inventory account."
          : " Missing stock worth " + fmt(jointDebt.totalCents, cur) + " is awaiting cashier allocation."
        : " No missing-stock cashier credit was created.";
      setMessage(quickInventoryBatch.code + " applied. " + adjustments.length + " stock correction(s)." + debtMessage);
    } catch (error) {
      console.error("Quick inventory apply failed", error);
      setMessage("Quick inventory could not be applied. No selected counts were cleared; please retry.");
    } finally {
      applyingRef.current = false;
    }
  };

  return (
    <div>
      <PageHead title="Quick inventory" sub={"Count selected products only - " + bname} />
      <div className="ptools">
        <button className="btn sm btn-ghost" onClick={() => onBack(bId)}><ArrowLeft /> Full stock count</button>
        <select className="select" style={{ width: 180 }} value={bId} onChange={(e) => changeBranch(e.target.value)}>
          {data.branches.map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}
        </select>
        <div className="possearch"><Search /><input placeholder="Search product name, SKU, or barcode..." value={q} onChange={(e) => setQ(e.target.value)} /></div>
        <button className={"btn sm " + (scannerOn ? "btn-primary" : "btn-ghost")} disabled={!!lockedSession} onClick={() => setScannerOn((value) => !value)}><Barcode /> USB scanner</button>
        <button className="btn sm btn-ghost" disabled={!!lockedSession} onClick={() => setCameraOpen(true)}><Camera /> Camera scan</button>
      </div>

      {lockedSession ? (
        <div className="alert" style={{ marginBottom: 14 }}><AlertTriangle /> <div><b>Quick inventory is locked.</b><div>{lockedSession.code} is already {lockedSession.status} for {bname}. Finish or cancel that formal count first.</div></div></div>
      ) : (
        <div className="notice" style={{ marginBottom: 14 }}>Only products with a counted quantity will be adjusted. Missing stock creates joint cashier inventory credit; positive corrections and blank products do not.</div>
      )}
      {message && <div className="notice" style={{ marginBottom: 14 }}>{message} <button className="linknum" onClick={() => setMessage("")} style={{ marginLeft: 8 }}>dismiss</button></div>}

      <div className="cashtiles" style={{ gridTemplateColumns: "repeat(4,1fr)", marginBottom: 16 }}>
        <div className="ctile"><div className="ic"><ClipboardCheck /></div><div><div className="cl">Selected products</div><div className="cv">{selectedRows.length}</div></div></div>
        <div className="ctile"><div className="ic"><Package /></div><div><div className="cl">Current units</div><div className="cv">{currentUnits}</div></div></div>
        <div className="ctile"><div className="ic"><Boxes /></div><div><div className="cl">Counted units</div><div className="cv">{countedUnits}</div></div></div>
        <div className={"ctile" + (varianceUnits !== 0 ? " warn" : "")}><div className="ic"><TrendingDown /></div><div><div className="cl">Net difference</div><div className="cv">{varianceUnits > 0 ? "+" : ""}{varianceUnits}</div><div className="cs">{adjustmentCount} adjustment{adjustmentCount === 1 ? "" : "s"}</div></div></div>
      </div>

      <div className="panel fade" style={{ padding: 0, overflow: "hidden" }}>
        <div className="page-h" style={{ padding: "16px 18px", margin: 0 }}>
          <div><div className="title" style={{ fontSize: 18 }}>Selected product counts</div><div className="sub">Search to find a product, then enter the physical quantity on hand.</div></div>
          <button className="btn sm btn-primary" disabled={!!lockedSession || !selectedRows.length} onClick={applyCounts}><Check /> Apply selected counts</button>
        </div>
        <div className="tablewrap">
          <table className="table">
            <thead><tr><th>Product</th><th>Current</th><th style={{ width: 170 }}>Physical count</th><th>Difference</th><th style={{ width: 70 }}></th></tr></thead>
            <tbody>
              {!displayedProducts.length && <tr><td colSpan="5"><div className="empty"><Search /><b>{term ? "No matching products" : "Search or scan a product to begin"}</b><span>Quick inventory changes only the products you count.</span></div></td></tr>}
              {displayedProducts.map((p) => {
                const selected = Object.prototype.hasOwnProperty.call(counts, p.id);
                const current = productOnHand(data, p, bId);
                const counted = selected ? Number(counts[p.id]) : null;
                const difference = selected ? counted - current : null;
                return <tr key={p.id}>
                  <td><div className="prodname"><b>{p.name}</b><span>{p.sku}{p.size ? " - " + p.size : ""}</span></div></td>
                  <td><b>{current}</b></td>
                  <td><input ref={(node) => { if (node) countInputRefs.current.set(p.id, node); else countInputRefs.current.delete(p.id); }} className="input" style={{ height: 40, width: 130 }} inputMode="numeric" placeholder="Count" value={selected ? counts[p.id] : ""} disabled={!!lockedSession} onChange={(e) => setCount(p.id, e.target.value)} /></td>
                  <td><b className={difference === null ? "" : difference < 0 ? "bad" : difference > 0 ? "good" : ""}>{difference === null ? "-" : (difference > 0 ? "+" : "") + difference}</b></td>
                  <td>{selected && <button className="iconbtn" title="Remove from quick inventory" onClick={() => clearSelection(p.id)}><Trash2 /></button>}</td>
                </tr>;
              })}
            </tbody>
          </table>
        </div>
      </div>

      {cameraOpen && (
        <CameraBarcodeScanner
          eyebrow="Quick inventory"
          title={"Scan product - " + bname}
          onClose={() => setCameraOpen(false)}
          onScan={handleQuickCameraScan}
        />
      )}
      {report && <div className="panel fade" style={{ marginTop: 16 }}>
        <div className="page-h" style={{ marginBottom: 10 }}><div><div className="title" style={{ fontSize: 18 }}>Quick inventory applied</div><div className="sub">{report.code} - {report.branchName} - {dt(report.ts)}</div></div><button className="iconbtn" onClick={() => setReport(null)}><X /></button></div>
        <div className="notice">{report.rows.length} product(s) checked. {report.adjustments} product(s) were adjusted; every unselected product was left unchanged.</div>
        {report.jointDebt && <div className="alert" style={{ marginTop: 10 }}><Boxes /><div><b>{fmt(report.jointDebt.totalCents, cur)} added to cashier inventory credit</b><div>{report.jointDebt.cashierCount > 0 ? "Shared equally across " + report.jointDebt.cashierCount + " active branch cashier(s)." : "No active branch cashier is available, so this credit is awaiting allocation."}</div></div></div>}
      </div>}
    </div>
  );
}

function buildStockCountReport(session, rows, movements, data, branchName) {
  const discrepancies = rows.filter((row) => row.varianceQty !== 0).map((row) => ({
    id: row.productId,
    name: row.product.name,
    sku: row.product.sku,
    system: row.expectedQty,
    counted: row.countedQty,
    variance: row.varianceQty,
    costCents: branchInventoryCostCents(data, row.product, session.branchId),
    kind: "session",
  }));
  return {
    branchName,
    branchId: session.branchId,
    code: session.code,
    ts: session.committedAt || now(),
    lines: rows.map((row) => ({ id: row.productId, name: row.product.name, sku: row.product.sku, system: row.expectedQty, counted: row.countedQty, variance: row.varianceQty, costCents: branchInventoryCostCents(data, row.product, session.branchId), kind: "session" })),
    discrepancies,
    varianceUnits: rows.reduce((s, row) => s + (row.varianceQty || 0), 0),
    varianceCost: rows.reduce((s, row) => s + row.valueImpact, 0),
    shortUnits: discrepancies.filter((l) => l.variance < 0).reduce((s, l) => s - l.variance, 0),
    overUnits: discrepancies.filter((l) => l.variance > 0).reduce((s, l) => s + l.variance, 0),
    shortCost: discrepancies.filter((l) => l.variance < 0).reduce((s, l) => s + Math.abs(l.variance * l.costCents), 0),
    overCost: discrepancies.filter((l) => l.variance > 0).reduce((s, l) => s + l.variance * l.costCents, 0),
    invUnits: rows.reduce((s, row) => s + (row.finalQty || 0), 0),
    invCost: rows.reduce((s, row) => s + (row.finalQty || 0) * branchInventoryCostCents(data, row.product, session.branchId), 0),
    invRetail: rows.reduce((s, row) => s + (row.finalQty || 0) * branchProductPriceCents(row.product, session.branchId), 0),
    applied: movements.length,
    amendments: 0,
    store: data.settings.store,
  };
}

function StockTabLegacy({ data, update, branch }) {
  const cur = data.settings.currency;
  const [bId, setBId] = useState(branch.id);
  const [q, setQ] = useState("");
  const [counts, setCounts] = useState({});
  const [amending, setAmending] = useState({}); // pid -> true when re-opening an already-counted product
  const [report, setReport] = useState(null);
  const [filter, setFilter] = useState("all");
  const [lossOpen, setLossOpen] = useState(false);
  const [scannerOn, setScannerOn] = useState(true);
  const [scanMsg, setScanMsg] = useState("");
  const [lf, setLf] = useState({ q: "", productId: "", qty: "", reason: "Theft", note: "" });
  const LOSS_REASONS = ["Theft", "Breakage", "Expiry", "Spillage", "Other"];
  const cts = () => now();
  const cycleSince = lastEndFor(data.settings, bId); // count cycle resets at end-of-day
  const lastCount = (pid) => (data.countLog || []).filter((c) => c.branchId === bId && c.productId === pid && c.ts > cycleSince).sort((a, b) => b.ts - a.ts)[0] || null;
  const isCountedCycle = (pid) => !!lastCount(pid);
  const bname = data.branches.find((b) => b.id === bId)?.name || "branch";
  const slug = bname.replace(/\s+/g, "");
  const uniqueProducts = branchProductsUnique(data, bId);
  const isLow = (p) => productOnHand(data, p, bId) <= (p.reorderLevel ?? data.settings.reorderLevel);
  const list = sortProductsAZ(uniqueProducts.filter((p) => (q.trim() === "" || p.name.toLowerCase().includes(q.toLowerCase()) || p.sku.toLowerCase().includes(q.toLowerCase()) || productMatchesBarcode(p, q) || productMatchesCatalog(p, findBarcodeCatalogEntry(data, q))) && (filter === "all" || (filter === "reorder" ? isLow(p) : !isLow(p)))));
  const countVar = (p) => { const raw = counts[p.id]; if (raw === undefined || raw === "") return null; const c = parseInt(raw, 10); if (Number.isNaN(c)) return null; return c - productOnHand(data, p, bId); };
  const entered = Object.keys(counts).filter((k) => counts[k] !== "" && counts[k] !== undefined).length;
  const countedRows = Object.keys(counts).filter((id) => counts[id] !== "" && counts[id] !== undefined).map((id) => {
    const p = data.products.find((x) => x.id === id); if (!p) return null;
    const oh = productOnHand(data, p, bId); const c = parseInt(counts[id], 10); const change = Number.isNaN(c) ? 0 : c - oh;
    return { p, oh, c: Number.isNaN(c) ? 0 : c, change };
  }).filter(Boolean).sort((a, b) => a.p.name.localeCompare(b.p.name));

  const totalProducts = uniqueProducts.length;
  const totalUnits = uniqueProducts.reduce((s, p) => s + productOnHand(data, p, bId), 0);
  const stockValue = uniqueProducts.reduce((s, p) => s + productOnHand(data, p, bId) * branchInventoryCostCents(data, p, bId), 0);
  const lossList = data.stockMovements.filter((m) => typeof m.reason === "string" && m.reason.startsWith("Loss/Damage") && m.branchId === bId).sort((a, b) => b.ts - a.ts);
  const lossValue = lossList.reduce((s, m) => {
    const product = data.products.find((p) => p.id === m.productId);
    return s + Math.abs(m.qty) * (product ? branchInventoryCostCents(data, product, bId) : 0);
  }, 0);
  const lossProdMatches = lf.q.trim() === "" ? [] : sortProductsAZ(uniqueProducts.filter((p) => p.name.toLowerCase().includes(lf.q.toLowerCase()) || p.sku.toLowerCase().includes(lf.q.toLowerCase()))).slice(0, 8);
  const lossProd = data.products.find((p) => p.id === lf.productId);
  const recordLoss = () => {
    const qty = parseInt(lf.qty, 10); if (!lf.productId || !qty || qty <= 0) return;
    const oh = onHand(data, lf.productId, bId); const dq = Math.min(qty, Math.max(0, oh)); if (dq <= 0) return;
    const reason = "Loss/Damage · " + lf.reason + (lf.note.trim() ? " — " + lf.note.trim() : "");
    update((d) => ({ ...d, stockMovements: [...d.stockMovements, { id: uid("mv"), productId: lf.productId, branchId: bId, qty: -dq, reason, ts: now(), synced: false }] }));
    setLf({ q: "", productId: "", qty: "", reason: lf.reason, note: "" });
  };
  const handleStockScan = (code) => {
    const barcode = normalizeBarcode(code);
    if (!isValidBarcode(barcode)) {
      setScanMsg("Invalid barcode: " + barcode);
      appendBarcodeScanLog({ barcode, status: "stock:invalid" });
      return;
    }
    const hit = barcodeLookup(data, barcode, bId);
    if (!hit) {
      setScanMsg("Barcode not found: " + barcode);
      appendBarcodeScanLog({ barcode, status: "stock:not_found" });
      return;
    }
    if (hit.unavailable) {
      setScanMsg(hit.message || "This product is not available in this branch.");
      appendBarcodeScanLog({ barcode, status: "stock:branch_unavailable", barcodeCatalogId: hit.barcodeCatalog?.id });
      return;
    }
    if (hit.product.synced === false) setScanMsg("Counted " + hit.name + ". Product is still unsynced.");
    else setScanMsg("Counted " + hit.name + " · running count " + ((parseInt(counts[hit.product.id], 10) || 0) + 1) + ".");
    if (isCountedCycle(hit.product.id) && !amending[hit.product.id]) setAmending((s) => ({ ...s, [hit.product.id]: true }));
    setCounts((s) => ({ ...s, [hit.product.id]: String((parseInt(s[hit.product.id], 10) || 0) + 1) }));
    appendBarcodeScanLog({ barcode, status: "stock:counted_pending", productId: hit.product.id });
  };
  useBarcodeScanner({ enabled: scannerOn && !lossOpen, mode: "stock", onScan: handleStockScan });

  const saveRow = (p) => {
    const raw = counts[p.id] !== undefined && counts[p.id] !== "" ? counts[p.id] : String(productOnHand(data, p, bId));
    const c = parseInt(raw, 10); if (Number.isNaN(c) || c < 0) return;
    const oh = productOnHand(data, p, bId); const delta = c - oh;
    if (delta !== 0) update((d) => ({ ...d, stockMovements: [...d.stockMovements, { id: uid("mv"), productId: p.id, branchId: bId, qty: delta, mode: "count", reason: "Inventory count", ts: cts(), synced: false }] }));
    setCounts((s) => { const n = { ...s }; delete n[p.id]; return n; });
  };
  const rowAction = (p, val) => { if (val === "save") saveRow(p); else if (val === "reset") setCounts((s) => { const n = { ...s }; delete n[p.id]; return n; }); };

  const generate = () => {
    const ts = cts(); const lines = []; const movements = []; const logs = [];
    uniqueProducts.forEach((p) => {
      const raw = counts[p.id]; if (raw === undefined || raw === "") return;
      const counted = parseInt(raw, 10); if (Number.isNaN(counted) || counted < 0) return;
      const already = isCountedCycle(p.id);
      // A product can't be freshly counted twice — a second entry in the same cycle is recorded as an amendment.
      if (already && !amending[p.id]) return;
      const system = productOnHand(data, p, bId); const variance = counted - system;
      const kind = already ? "amendment" : "count";
      lines.push({ id: p.id, name: p.name, sku: p.sku, system, counted, variance, costCents: branchInventoryCostCents(data, p, bId), kind });
      if (variance !== 0) movements.push({ id: uid("mv"), productId: p.id, branchId: bId, qty: variance, mode: "count", reason: kind === "amendment" ? "Count amendment" : "Inventory count", ts, synced: false });
      logs.push({ id: uid("cl"), productId: p.id, branchId: bId, qty: counted, mode: "count", system, counted, variance, kind, ts, synced: false });
    });
    if (lines.length === 0) return;
    const countedMap = {}; lines.forEach((l) => { countedMap[l.id] = l.counted; });
    let invUnits = 0, invCost = 0, invRetail = 0;
    uniqueProducts.forEach((p) => { const qv = countedMap[p.id] !== undefined ? countedMap[p.id] : productOnHand(data, p, bId); invUnits += qv; invCost += qv * branchInventoryCostCents(data, p, bId); invRetail += qv * branchProductPriceCents(p, bId); });
    update((d) => ({ ...d, stockMovements: movements.length ? [...d.stockMovements, ...movements] : d.stockMovements, countLog: [...(d.countLog || []), ...logs] }));
    const discrepancies = lines.filter((l) => l.variance !== 0);
    setReport({ branchName: bname, branchId: bId, ts, lines, discrepancies,
      varianceUnits: lines.reduce((s, l) => s + l.variance, 0), varianceCost: lines.reduce((s, l) => s + l.variance * l.costCents, 0),
      shortUnits: discrepancies.filter((l) => l.variance < 0).reduce((s, l) => s - l.variance, 0),
      overUnits: discrepancies.filter((l) => l.variance > 0).reduce((s, l) => s + l.variance, 0),
      shortCost: discrepancies.filter((l) => l.variance < 0).reduce((s, l) => s + Math.abs(l.variance * l.costCents), 0),
      overCost: discrepancies.filter((l) => l.variance > 0).reduce((s, l) => s + l.variance * l.costCents, 0),
      invUnits, invCost, invRetail, applied: movements.length, amendments: lines.filter((l) => l.kind === "amendment").length, store: data.settings.store });
    setCounts({}); setAmending({}); setScanMsg("");
  };
  const exportReport = (kind) => exportDiscrepancy(report, cur, kind);

  return (
    <div>
      <PageHead title="Stock" sub={"Inventory count & levels · " + bname} />
      <div className="ptools">
        <select className="select" style={{ width: 180 }} value={bId} onChange={(e) => { setBId(e.target.value); setCounts({}); setReport(null); }}>{data.branches.map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}</select>
        <div className="possearch"><Search /><input placeholder="Search product name or SKU…" value={q} onChange={(e) => setQ(e.target.value)} /></div>
        <button className={"btn sm " + (scannerOn ? "btn-primary" : "btn-ghost")} onClick={() => setScannerOn((v) => !v)}><ClipboardCheck /> Scan count</button>
        <button className="btn sm btn-ghost" onClick={() => setLossOpen(true)}><TrendingDown /> Record loss / damage</button>
      </div>
      {scanMsg && <div className="notice" style={{ marginBottom: 12 }}>{scanMsg} <button className="linknum" onClick={() => setScanMsg("")} style={{ marginLeft: 8 }}>dismiss</button></div>}
      <div className="cashtiles" style={{ gridTemplateColumns: "repeat(4,1fr)", marginBottom: 16 }}>
        <div className="ctile"><div className="ic"><Boxes /></div><div><div className="cl">Total products</div><div className="cv">{totalProducts}</div></div></div>
        <div className="ctile"><div className="ic"><Package /></div><div><div className="cl">Total units</div><div className="cv">{totalUnits}</div></div></div>
        <div className="ctile"><div className="ic"><Wallet /></div><div><div className="cl">Stock value</div><div className="cv">{fmt(stockValue, cur)}</div></div></div>
        <div className={"ctile" + (lossValue > 0 ? " warn" : "")}><div className="ic"><TrendingDown /></div><div><div className="cl">Loss &amp; damage</div><div className="cv">{fmt(lossValue, cur)}</div><div className="cs">{lossList.length} write-off{lossList.length === 1 ? "" : "s"}</div></div></div>
      </div>

      <div className="cfilter">
        {[["all", "All"], ["instock", "In stock"], ["reorder", "Reorder"]].map(([k, l]) => (
          <button key={k} className={"seg" + (filter === k ? " on" : "")} onClick={() => setFilter(k)}>{l}</button>))}
        <span className="cfilthint">{list.length} product{list.length === 1 ? "" : "s"}{entered > 0 ? " · " + entered + " counted" : ""}</span>
        <button className="btn xs btn-primary" style={{ marginLeft: "auto" }} disabled={entered === 0} onClick={generate}><Check /> Save &amp; close ({entered})</button>
      </div>
      {countedRows.length > 0 && (
        <div className="panel fade" style={{ marginTop: 14, padding: "14px 16px" }}>
          <div className="page-h" style={{ marginBottom: 8 }}>
            <div className="title" style={{ fontSize: 15, display: "flex", alignItems: "center", gap: 8 }}><Check style={{ width: 15, height: 15, color: "var(--ok)" }} /> Counted so far · {countedRows.length}</div>
            <button className="btn xs btn-ghost" onClick={() => setCounts({})}><X /> Clear all</button>
          </div>
          <div className="tablewrap" style={{ maxHeight: 220, overflow: "auto" }}>
            <table className="tbl"><thead><tr><th>Product</th><th style={{ textAlign: "right" }}>Expected</th><th style={{ textAlign: "right" }}>Counted</th><th style={{ textAlign: "right" }}>Change</th><th /></tr></thead>
              <tbody>{countedRows.map(({ p, oh, c, change }) => (
                <tr key={p.id}>
                  <td><div className="nm">{p.name}</div><div className="mt2">{p.sku}</div></td>
                  <td style={{ textAlign: "right", fontWeight: 700 }}>{oh}</td>
                  <td style={{ textAlign: "right", fontWeight: 700 }}>{c}</td>
                  <td style={{ textAlign: "right", fontWeight: 700, color: change < 0 ? "var(--danger)" : change > 0 ? "var(--ok)" : "var(--muted-2)" }}>{change === 0 ? "0" : (change > 0 ? "+" : "") + change}</td>
                  <td><button className="smdel" onClick={() => setCounts((s) => { const n = { ...s }; delete n[p.id]; return n; })}><Trash2 /></button></td>
                </tr>))}</tbody></table>
          </div>
        </div>
      )}
      <div className="tablewrap tblscroll" style={{ marginTop: 18 }}><table className="tbl"><thead><tr><th>Product</th><th>Expected</th><th>Counted</th><th>Change</th><th>Value</th><th>Status</th><th>Action</th></tr></thead>
        <tbody>{list.map((p) => {
          const oh = productOnHand(data, p, bId); const low = oh <= (p.reorderLevel ?? data.settings.reorderLevel);
          const value = oh * branchInventoryCostCents(data, p, bId);
          const prevCount = lastCount(p.id); const locked = !!prevCount && !amending[p.id];
          const isCounted = counts[p.id] !== undefined && counts[p.id] !== "";
          const counted = isCounted && !Number.isNaN(parseInt(counts[p.id], 10)) ? parseInt(counts[p.id], 10) : oh;
          const change = counted - oh;
          return (<tr key={p.id} className={isCounted ? "rowsel" : ""}>
            <td><div className="nm">{p.name}</div><div className="mt2">{p.sku} / {p.size}</div></td>
            <td style={{ fontWeight: 700 }}>{oh}</td>
            <td>{locked
              ? <span style={{ fontFamily: "var(--font-mono)", color: "var(--muted)" }}>{prevCount.counted} <span style={{ fontSize: 10.5 }}>counted</span></span>
              : <input className="input" style={{ width: 92, height: 38, fontFamily: "var(--font-mono)" }} inputMode="numeric" placeholder={String(oh)} value={counts[p.id] ?? ""} onChange={(e) => setCounts((s) => ({ ...s, [p.id]: e.target.value.replace(/\D/g, "") }))} />}</td>
            <td style={{ fontWeight: 700, color: change < 0 ? "var(--danger)" : change > 0 ? "var(--ok)" : "var(--muted-2)" }}>{locked ? (prevCount.variance === 0 ? "0" : (prevCount.variance > 0 ? "+" : "") + prevCount.variance) : (!isCounted ? "—" : (change === 0 ? "0" : (change > 0 ? "+" : "") + change))}</td>
            <td className="amt">{fmt(value, cur)}</td>
            <td>{prevCount ? <span className="ist paid" title={"Counted " + dt(prevCount.ts)}><Check style={{ width: 12, height: 12 }} /> Counted</span> : (low ? <span className="ist open">Reorder</span> : <span className="ist paid">In stock</span>)}</td>
            <td>{locked
              ? <button className="btn xs btn-ghost" onClick={() => { setAmending((s) => ({ ...s, [p.id]: true })); setCounts((s) => ({ ...s, [p.id]: String(prevCount.counted) })); }}><RefreshCw style={{ width: 12, height: 12 }} /> Amend</button>
              : (isCounted ? <button className="btn xs btn-ghost" onClick={() => { setCounts((s) => { const n = { ...s }; delete n[p.id]; return n; }); setAmending((s) => { const n = { ...s }; delete n[p.id]; return n; }); }}><X /> {amending[p.id] ? "Cancel" : "Clear"}</button> : <span style={{ color: "var(--muted-2)" }}>—</span>)}</td>
          </tr>);
        })}
        {list.length === 0 && <tr><td colSpan="7"><div className="notice">No products match.</div></td></tr>}</tbody></table></div>

      {report && (
        <div className="panel fade" style={{ marginTop: 18 }}>
          <div className="page-h" style={{ marginBottom: 4 }}>
            <div><div className="title" style={{ fontSize: 17 }}>Inventory Discrepancy Report</div>
              <div className="sub">{report.branchName} · {dt(report.ts)} · {report.discrepancies.length} discrepancy(ies){report.amendments ? " · " + report.amendments + " amendment(s)" : ""} · {report.applied} adjustment(s) applied</div></div>
            <div className="expbtns"><button className="btn xs btn-primary" onClick={() => exportReport("pdf")}><FileText /> Download PDF (read-only)</button>
              <button className="btn xs btn-ghost" onClick={() => exportReport("print")}><Printer /> Print</button>
              <button className="btn xs btn-ghost" onClick={() => exportReport("csv")}>CSV</button>
              <button className="btn xs btn-ghost" onClick={() => exportReport("json")}>JSON</button>
              <button className="iconbtn" onClick={() => setReport(null)}><X /></button></div>
          </div>
          <div className="stats">
            <div className="stat"><div className="sl">Discrepancies</div><div className={"sv" + (report.discrepancies.length ? " warn" : "")}>{report.discrepancies.length}</div></div>
            <div className="stat"><div className="sl">Shortage total</div><div className={"sv" + (report.shortCost ? " warn" : "")}>{fmt(report.shortCost, cur)}</div></div>
            <div className="stat"><div className="sl">Overage total</div><div className="sv">{fmt(report.overCost, cur)}</div></div>
            <div className="stat"><div className="sl">Net variance value</div><div className={"sv" + (report.varianceCost < 0 ? " warn" : "")}>{fmt(report.varianceCost, cur)}</div></div>
            <div className="stat"><div className="sl">Items counted</div><div className="sv">{report.lines.length}</div></div>
            <div className="stat"><div className="sl">Inventory value (cost)</div><div className="sv">{fmt(report.invCost, cur)}</div></div>
          </div>
          {report.discrepancies.length === 0
            ? <div className="notice" style={{ marginTop: 4 }}>No discrepancies — every counted item matched the system.</div>
            : <div className="tablewrap tblscroll" style={{ marginTop: 4 }}><table className="tbl"><thead><tr><th>Product</th><th>System</th><th>Counted</th><th>Variance</th><th>Value impact</th><th>Type</th></tr></thead>
            <tbody>{report.discrepancies.map((l) => (<tr key={l.id}><td>{l.name}<div className="mt2">{l.sku}</div></td><td>{l.system}</td><td>{l.counted}</td>
              <td style={{ fontWeight: 700, color: l.variance < 0 ? "var(--danger)" : l.variance > 0 ? "var(--ok)" : "var(--muted)" }}>{(l.variance > 0 ? "+" : "") + l.variance}</td>
              <td className="amt" style={{ color: l.variance < 0 ? "var(--danger)" : "var(--text)" }}>{fmt(l.variance * l.costCents, cur)}</td>
              <td>{l.kind === "amendment" ? <span className="ist open">amendment</span> : <span className="ist paid">count</span>}</td></tr>))}</tbody></table></div>}
        </div>
      )}
      {lossOpen && (
        <div className="scrim" onClick={() => setLossOpen(false)}>
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <div className="modal-head"><div><div className="sub" style={{ margin: 0 }}>{bname}</div><div className="title" style={{ fontSize: 21 }}>Record loss / damage</div></div><button className="iconbtn" onClick={() => setLossOpen(false)}><X /></button></div>
            <label className="label" style={{ marginTop: 12 }}>Find product</label>
            <div className="possearch" style={{ height: 44 }}><Search /><input placeholder="Search name or SKU…" value={lf.q} onChange={(e) => setLf({ ...lf, q: e.target.value, productId: "" })} /></div>
            {lf.q.trim() !== "" && !lossProd && (
              <div style={{ display: "flex", flexWrap: "wrap", gap: 8, marginTop: 10 }}>
                {lossProdMatches.length === 0 ? <span className="cust-meta">No match.</span> : lossProdMatches.map((p) => <button key={p.id} className="inschip" onClick={() => setLf({ ...lf, productId: p.id, q: p.name })}>{p.name} · {productOnHand(data, p, bId)} on hand</button>)}
              </div>
            )}
            {lossProd && (
              <>
                <div className="notice" style={{ marginTop: 10 }}>{lossProd.name} · <b>{onHand(data, lossProd.id, bId)}</b> on hand at {bname}</div>
                <div className="grid2" style={{ marginTop: 12 }}>
                  <div><label className="label">Quantity lost</label><input className="input" inputMode="numeric" value={lf.qty} onChange={(e) => setLf({ ...lf, qty: e.target.value.replace(/\D/g, "") })} placeholder="1" /></div>
                  <div><label className="label">Reason</label><select className="select" value={lf.reason} onChange={(e) => setLf({ ...lf, reason: e.target.value })}>{LOSS_REASONS.map((r) => <option key={r}>{r}</option>)}</select></div>
                </div>
                <div className="field" style={{ marginTop: 12 }}><label className="label">Note (optional)</label><input className="input" value={lf.note} onChange={(e) => setLf({ ...lf, note: e.target.value })} placeholder="e.g. broken in transit, shoplifting incident" /></div>
                {parseInt(lf.qty, 10) > 0 && <div className="cust-meta" style={{ marginTop: 8 }}>Removes {Math.min(parseInt(lf.qty, 10), Math.max(0, onHand(data, lossProd.id, bId)))} unit(s) · cost impact {fmt(Math.min(parseInt(lf.qty, 10), Math.max(0, onHand(data, lossProd.id, bId))) * branchInventoryCostCents(data, lossProd, bId), cur)}</div>}
                <button className="btn btn-primary" style={{ marginTop: 14 }} disabled={!(parseInt(lf.qty, 10) > 0)} onClick={recordLoss}><Check /> Record write-off</button>
              </>
            )}
            {lossList.length > 0 && (
              <>
                <div className="section-title" style={{ margin: "18px 0 8px" }}>Recent loss &amp; damage</div>
                <div className="list" style={{ maxHeight: 220, overflow: "auto" }}>{lossList.slice(0, 30).map((m) => { const p = data.products.find((x) => x.id === m.productId); return (
                  <div className="row" key={m.id}><div className="avatar"><TrendingDown style={{ width: 16, height: 16 }} /></div>
                    <div className="meta"><div className="nm">{Math.abs(m.qty)}× {p ? p.name : m.productId}</div><div className="mt2">{m.reason.replace("Loss/Damage · ", "")} · {dt(m.ts)}</div></div>
                    <span className="pill plain">{fmt(Math.abs(m.qty) * (p ? branchInventoryCostCents(data, p, m.branchId) : 0), cur)}</span></div>); })}</div>
              </>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
function PurchasesTab({ data, update, branch, isAdmin }) {
  const cur = data.settings.currency;
  const [delConfirm, setDelConfirm] = useState(null); // { mode:"line"|"file", po?, key?, label }
  const [receiptCorrection, setReceiptCorrection] = useState(null);
  const sp = data.supplierPrices || [];
  const quotesFor = (pid) => sp.filter((x) => x.productId === pid).map((x) => ({ ...x, supplier: data.suppliers.find((s) => s.id === x.supplierId) })).filter((x) => x.supplier).sort((a, b) => a.costCents - b.costCents);
  const recommend = (pid) => quotesFor(pid)[0] || null;
  const initProd = branchProductsUnique(data, branch.id)[0]?.id || data.products[0]?.id || "";
  const rec0 = recommend(initProd);
  const [adding, setAdding] = useState(false);
  const [list, setList] = useState([]); // batch of purchase lines to save at once
  const [f, setF] = useState({ supplierId: rec0 ? rec0.supplierId : (data.suppliers[0]?.id || ""), productId: initProd, branchId: branch.id, qty: "", cost: rec0 ? String(rec0.costCents / 100) : "", lineTotal: "", amountMode: "unit", received: true });
  const [scannerOn, setScannerOn] = useState(true);
  const [scanCode, setScanCode] = useState("");
  const [cameraOpen, setCameraOpen] = useState(false);
  const [scanMsg, setScanMsg] = useState("");
  const scanInputRef = useRef(null);
  const qtyInputRef = useRef(null);
  const cleanDecimalInput = (raw, decimals = 6) => {
    const cleaned = String(raw ?? "").replace(/,/g, "").replace(/[^\d.]/g, "");
    const dot = cleaned.indexOf(".");
    if (dot < 0) return cleaned;
    return cleaned.slice(0, dot + 1) + cleaned.slice(dot + 1).replace(/\./g, "").slice(0, decimals);
  };
  const decimalText = (value, decimals = 6) => {
    if (!Number.isFinite(value)) return "";
    return value.toFixed(decimals).replace(/\.?0+$/, "");
  };
  const purchaseDraftAmounts = (draft) => {
    const qty = parseInt(draft.qty, 10) || 0;
    const enteredCost = Math.max(0, Number.parseFloat(draft.cost) || 0);
    const enteredTotal = Math.max(0, Number.parseFloat(draft.lineTotal) || 0);
    const lineTotalCents = draft.amountMode === "total"
      ? Math.round(enteredTotal * 100)
      : Math.round(qty * enteredCost * 100);
    const unitCostCents = qty > 0 ? lineTotalCents / qty : enteredCost * 100;
    return { qty, lineTotalCents, unitCostCents };
  };
  const setPurchaseQty = (raw) => setF((s) => {
    const qty = raw.replace(/\D/g, "");
    const quantity = parseInt(qty, 10) || 0;
    if (s.amountMode === "total") {
      const total = Number.parseFloat(s.lineTotal) || 0;
      return { ...s, qty, cost: quantity > 0 ? decimalText(total / quantity) : "" };
    }
    const cost = Number.parseFloat(s.cost) || 0;
    return { ...s, qty, lineTotal: quantity > 0 && cost > 0 ? decimalText(quantity * cost, 2) : "" };
  });
  const setPurchaseUnitCost = (raw) => setF((s) => {
    const cost = cleanDecimalInput(raw);
    const quantity = parseInt(s.qty, 10) || 0;
    const numericCost = Number.parseFloat(cost) || 0;
    return { ...s, cost, amountMode: "unit", lineTotal: quantity > 0 && numericCost > 0 ? decimalText(quantity * numericCost, 2) : "" };
  });
  const setPurchaseLineTotal = (raw) => setF((s) => {
    const lineTotal = cleanDecimalInput(raw, 2);
    const quantity = parseInt(s.qty, 10) || 0;
    const total = Number.parseFloat(lineTotal) || 0;
    return { ...s, lineTotal, amountMode: "total", cost: quantity > 0 && total > 0 ? decimalText(total / quantity) : "" };
  });
  const applyQuotedCost = (draft, costCents) => {
    const cost = String((Number(costCents) || 0) / 100);
    const quantity = parseInt(draft.qty, 10) || 0;
    return { ...draft, cost, amountMode: "unit", lineTotal: quantity > 0 ? decimalText(quantity * (Number(costCents) || 0) / 100, 2) : "" };
  };
  const onProduct = (pid) => { const r = recommend(pid); setF((s) => applyQuotedCost({ ...s, productId: pid, supplierId: r ? r.supplierId : s.supplierId }, r ? r.costCents : Number.parseFloat(s.cost) * 100)); };
  const onSupplier = (sid) => { const e = sp.find((x) => x.supplierId === sid && x.productId === f.productId); setF((s) => e ? applyQuotedCost({ ...s, supplierId: sid }, e.costCents) : ({ ...s, supplierId: sid })); };
  const rec = recommend(f.productId);
  const qlist = quotesFor(f.productId);
  const purchaseProducts = sortProductsAZ(branchProductsUnique(data, f.branchId || branch.id));
  const focusPurchaseScan = () => window.setTimeout(() => scanInputRef.current?.focus(), 0);
  const handlePurchaseScan = (raw) => {
    const barcode = normalizeBarcode(raw);
    if (!barcode) return;
    if (!isValidBarcode(barcode)) {
      setScanMsg("Invalid barcode: " + barcode);
      playScanSound("error");
      appendBarcodeScanLog({ barcode, status: "purchase:invalid" });
      setScanCode("");
      focusPurchaseScan();
      return;
    }
    const hit = barcodeLookup(data, barcode, f.branchId || branch.id);
    if (!hit) {
      setScanMsg("Product not found: " + barcode);
      playScanSound("error");
      appendBarcodeScanLog({ barcode, status: "purchase:not_found" });
      setScanCode("");
      focusPurchaseScan();
      return;
    }
    if (hit.unavailable) {
      setScanMsg(hit.message || "This product is not available in this branch.");
      playScanSound("error");
      appendBarcodeScanLog({ barcode, status: "purchase:branch_unavailable", barcodeCatalogId: hit.barcodeCatalog?.id });
      setScanCode("");
      focusPurchaseScan();
      return;
    }
    onProduct(hit.product.id);
    setScanMsg("Selected " + hit.name + " for purchase.");
    playScanSound("success");
    appendBarcodeScanLog({ barcode, status: "purchase:selected", productId: hit.product.id });
    setScanCode("");
    window.setTimeout(() => qtyInputRef.current?.focus(), 0);
  };
  useBarcodeScanner({ enabled: adding && scannerOn && !cameraOpen, mode: "purchase", onScan: handlePurchaseScan });
  useEffect(() => {
    if (adding && scannerOn) focusPurchaseScan();
  }, [adding, scannerOn]);
  const create = () => { const { qty, lineTotalCents, unitCostCents: cost } = purchaseDraftAmounts(f); if (!qty || qty <= 0 || lineTotalCents <= 0) return;
    const sup = data.suppliers.find((s) => s.id === f.supplierId); const prod = data.products.find((p) => p.id === f.productId);
    const lbr = f.branchId || branch.id; const ts = now(); const received = f.received;
    update((d) => {
      const po = { id: uid("po"), supplierId: f.supplierId, supplierName: sup?.name || "", productId: f.productId, productName: prod?.name || "", qty, costCents: cost, lineTotalCents, status: received ? "received" : "ordered", branchId: lbr, date: todayStr(), ts, updatedAt: ts, receivedAt: received ? ts : null, synced: false };
      if (!received) return { ...d, purchases: [po, ...d.purchases] };
      const cur = d.products.find((p) => p.id === f.productId);
      const newCost = wacCost(onHand(d, f.productId, lbr), cur ? branchInventoryCostCents(d, cur, lbr) : cost, qty, cost);
      return { ...d,
        purchases: [po, ...d.purchases],
        stockMovements: [...d.stockMovements, { id: uid("mv"), purchaseId: po.id, productId: f.productId, branchId: lbr, qty, costCents: cost, valueCents: lineTotalCents, reason: "Purchase " + (sup?.name || ""), ts, synced: false }],
        products: withBranchProductCostForKey(d.products, cur, lbr, newCost),
      };
    });
    setF({ ...f, qty: "", cost: "", lineTotal: "", amountMode: "unit" }); setAdding(false); };
  const addToList = () => {
    const { qty, lineTotalCents, unitCostCents: cost } = purchaseDraftAmounts(f);
    if (!qty || qty <= 0 || lineTotalCents <= 0) return;
    const sup = data.suppliers.find((s) => s.id === f.supplierId); const prod = data.products.find((p) => p.id === f.productId);
    const br = data.branches.find((b) => b.id === f.branchId);
    setList((ls) => [...ls, { key: uid("pl"), productId: f.productId, productName: prod?.name || "", supplierId: f.supplierId, supplierName: sup?.name || "", branchId: f.branchId, branchName: br?.name || "", qty, costCents: cost, lineTotalCents, received: f.received }]);
    setF({ ...f, qty: "", cost: "", lineTotal: "", amountMode: "unit" });
  };
  const removeFromList = (key) => setList((ls) => ls.filter((l) => l.key !== key));
  const listTotal = list.reduce((s, l) => s + purchaseLineTotalCents(l), 0);
  const saveAll = () => {
    if (!list.length) return; const ts = now();
    update((d) => {
      let products = [...d.products]; const purchases = []; const movements = []; const ohCache = {};
      const batchId = uid("pb");
      const bn = new Set(d.purchases.filter((p) => p.batchNo).map((p) => p.batchNo)).size + 1;
      const batchNo = "PO-" + String(bn).padStart(4, "0");
      const getOH = (pid, bid) => {
        const key = bid + ":" + pid;
        if (ohCache[key] === undefined) ohCache[key] = onHand(d, pid, bid);
        return ohCache[key];
      };
      for (const l of list) {
        const lbr = l.branchId || branch.id;
        const po = { id: uid("po"), batchId, batchNo, supplierId: l.supplierId, supplierName: l.supplierName, productId: l.productId, productName: l.productName, qty: l.qty, costCents: l.costCents, lineTotalCents: purchaseLineTotalCents(l), status: l.received ? "received" : "ordered", branchId: lbr, date: todayStr(), ts, updatedAt: ts, receivedAt: l.received ? ts : null, synced: false };
        purchases.push(po);
        if (l.received) {
          const idx = products.findIndex((p) => p.id === l.productId);
          const curCost = idx >= 0 ? branchInventoryCostCents({ ...d, products }, products[idx], lbr) : l.costCents;
          const oh = getOH(l.productId, lbr);
          const newCost = wacCost(oh, curCost, l.qty, l.costCents);
          if (idx >= 0) products = withBranchProductCostForKey(products, products[idx], lbr, newCost);
          ohCache[lbr + ":" + l.productId] = oh + l.qty;
          movements.push({ id: uid("mv"), purchaseId: po.id, purchaseBatchId: batchId, productId: l.productId, branchId: lbr, qty: l.qty, costCents: l.costCents, valueCents: purchaseLineTotalCents(l), reason: "Purchase " + l.supplierName, ts, synced: false });
        }
      }
      return { ...d, purchases: [...purchases, ...d.purchases], stockMovements: [...d.stockMovements, ...movements], products };
    });
    setList([]); setAdding(false);
  };
  const receivePurchases = (d, purchaseIds) => {
    const requested = new Set(purchaseIds);
    const pending = d.purchases.filter((po) => requested.has(po.id) && po.status !== "received");
    if (pending.length === 0) return d;
    const receivedAt = now();
    const receivedIds = new Set(pending.map((po) => po.id));
    const onHandByProduct = {};
    const movements = [];
    let products = [...d.products];

    for (const po of pending) {
      const targetBranchId = po.branchId || branch.id;
      const stockKey = targetBranchId + ":" + po.productId;
      const currentOnHand = onHandByProduct[stockKey] ?? onHand(d, po.productId, targetBranchId);
      const currentProduct = products.find((product) => product.id === po.productId);
      const receivedUnitCost = purchaseUnitCostCents(po);
      const workingData = { ...d, products };
      const currentCost = currentProduct ? branchInventoryCostCents(workingData, currentProduct, targetBranchId) : receivedUnitCost;
      const newCost = wacCost(currentOnHand, currentCost, po.qty, receivedUnitCost);
      if (currentProduct) products = withBranchProductCostForKey(products, currentProduct, targetBranchId, newCost);
      onHandByProduct[stockKey] = currentOnHand + Number(po.qty || 0);
      movements.push({
        id: uid("mv"), purchaseId: po.id, purchaseBatchId: po.batchId || null,
        productId: po.productId, branchId: targetBranchId, qty: po.qty,
        costCents: receivedUnitCost, valueCents: purchaseLineTotalCents(po),
        reason: "Purchase " + po.supplierName, ts: receivedAt, synced: false,
      });
    }

    return {
      ...d,
      purchases: d.purchases.map((po) => receivedIds.has(po.id)
        ? { ...po, status: "received", receivedAt, updatedAt: receivedAt, synced: false }
        : po),
      products,
      stockMovements: [...d.stockMovements, ...movements],
    };
  };
  const receive = (po) => update((d) => receivePurchases(d, [po.id]));
  const correctReceiptStatus = (purchaseIds) => {
    const correctedAt = now();
    const ids = new Set(purchaseIds);
    update((d) => ({
      ...d,
      purchases: d.purchases.map((po) => ids.has(po.id) && po.status !== "received"
        ? { ...po, status: "received", receivedAt: correctedAt, receiptStatusCorrectedAt: correctedAt, updatedAt: correctedAt, synced: false }
        : po),
    }));
    setReceiptCorrection(null);
  };
  const remove = (id) => update((d) => ({ ...d, purchases: d.purchases.filter((p) => p.id !== id) }));
  const removeBatch = (key) => update((d) => ({ ...d, purchases: d.purchases.filter((p) => (p.batchId || p.id) !== key) }));
  const [plan, setPlan] = useState(null);
  const [planBranch, setPlanBranch] = useState(branch.id);
  const [planNote, setPlanNote] = useState("");
  const reorderLvl = (p) => p.reorderLevel ?? data.settings.reorderLevel;
  const suggestQty = (p, bid) => { const oh = productOnHand(data, p, bid); const lvl = reorderLvl(p); return Math.max(lvl * 2 - oh, lvl); };
  const buildLines = (bid) => reorderList(data, bid).map((p) => {
    const qs = quotesFor(p.id); const r = qs[0] || null;
    return { productId: p.id, name: p.name, sku: p.sku, onHand: productOnHand(data, p, bid), reorder: reorderLvl(p), qty: suggestQty(p, bid), supplierId: r ? r.supplierId : (data.suppliers[0]?.id || ""), costCents: r ? r.costCents : branchInventoryCostCents(data, p, bid), hasQuote: !!r, quotes: qs };
  });
  const localNote = (lines) => { const named = lines.filter((l) => l.hasQuote).length; const total = lines.reduce((s, l) => s + l.qty * l.costCents, 0); return named + " of " + lines.length + " item(s) have supplier quotes — each matched to its cheapest supplier. Estimated order value " + fmt(total, cur) + (named < lines.length ? ". Items without quotes need a supplier chosen manually." : "."); };
  const prepare = (bid) => {
    const useBid = bid || branch.id; setPlanBranch(useBid);
    const lines = buildLines(useBid); setPlan(lines); setPlanNote("");
    if (lines.length === 0) return;
    setPlanNote(localNote(lines));
  };
  const setLine = (pid, patch) => setPlan((ls) => ls.map((l) => l.productId === pid ? { ...l, ...patch } : l));
  const lineSupplier = (l, sid) => { const e = sp.find((x) => x.supplierId === sid && x.productId === l.productId); setLine(l.productId, { supplierId: sid, costCents: e ? e.costCents : l.costCents }); };
  const poFromLine = (l, ts, batch) => { const sup = data.suppliers.find((s) => s.id === l.supplierId); return { id: uid("po"), batchId: batch?.id, batchNo: batch?.no, supplierId: l.supplierId, supplierName: sup?.name || "", productId: l.productId, productName: l.name, qty: l.qty, costCents: l.costCents, lineTotalCents: purchaseLineTotalCents(l), status: "ordered", branchId: planBranch || branch.id, date: todayStr(), ts, updatedAt: ts, receivedAt: null, synced: false }; };
  const createLine = (l) => { if (!l.qty || l.qty <= 0) return; update((d) => { const bn = new Set(d.purchases.filter((p) => p.batchNo).map((p) => p.batchNo)).size + 1; return { ...d, purchases: [poFromLine(l, now(), { id: uid("pb"), no: "PO-" + String(bn).padStart(4, "0") }), ...d.purchases] }; }); setPlan((ls) => ls.filter((x) => x.productId !== l.productId)); };
  const createAll = () => { const ts = now(); const valid = plan.filter((l) => l.qty > 0); if (!valid.length) return; update((d) => { const bn = new Set(d.purchases.filter((p) => p.batchNo).map((p) => p.batchNo)).size + 1; const batch = { id: uid("pb"), no: "PO-" + String(bn).padStart(4, "0") }; const pos = valid.map((l) => poFromLine(l, ts, batch)); return { ...d, purchases: [...pos, ...d.purchases] }; }); setPlan(null); setPlanNote(""); };
  const receiveBatch = (items) => update((d) => receivePurchases(d, items.map((po) => po.id)));
  const [poView, setPoView] = useState(null); // batch key being viewed
  return (
    <div>
      <PageHead title="Purchases" sub="Receiving a purchase order adds stock to the branch." />
      {!adding ? (
        <div style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
          <button className="btn btn-primary" onClick={() => setAdding(true)}><Plus /> New purchase order</button>
          <button className="btn btn-ghost" onClick={() => prepare()}><RefreshCw /> Prepare reorder</button>
        </div>
      ) : (
        <div className="addpanel fade"><div className="grid2">
          <div><label className="label">Supplier</label><select className="select" value={f.supplierId} onChange={(e) => onSupplier(e.target.value)}>{data.suppliers.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}</select></div>
          <div><label className="label">Product</label><select className="select" value={f.productId} onChange={(e) => onProduct(e.target.value)}>{purchaseProducts.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}</select></div></div>
          <div className="field" style={{ marginTop: 12 }}>
            <label className="label">Scan product barcode</label>
            <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
              <input ref={scanInputRef} className="input" style={{ flex: "1 1 220px", minWidth: 0 }} inputMode="numeric" autoComplete="off" value={scanCode} onChange={(e) => setScanCode(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter" || e.key === "Tab") { e.preventDefault(); handlePurchaseScan(e.currentTarget.value); } }} placeholder="Scan barcode to select product" />
              <button className={"btn sm " + (scannerOn ? "btn-primary" : "btn-ghost")} onClick={() => setScannerOn((v) => { const next = !v; if (next) focusPurchaseScan(); return next; })}><Barcode /> USB scanner</button>
              <button type="button" className="btn sm btn-ghost" onClick={() => setCameraOpen(true)}><Camera /> Camera scan</button>
            </div>
          </div>
          {scanMsg && <div className="notice" style={{ marginTop: 10 }}>{scanMsg} <button className="linknum" onClick={() => setScanMsg("")} style={{ marginLeft: 8 }}>dismiss</button></div>}
          <div className="field" style={{ marginTop: 12 }}><label className="label">Branch (stock goes here)</label><select className="select" value={f.branchId} onChange={(e) => { const nextBranch = e.target.value; const nextProduct = branchProductsUnique(data, nextBranch)[0]?.id || ""; setF({ ...f, branchId: nextBranch, productId: nextProduct }); }}>{data.branches.map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}</select></div>
          {rec && (
            <div className="notice" style={{ marginTop: 12 }}>
              Recommended: <b>{rec.supplier.name}</b> at {fmt(rec.costCents, cur)}{qlist.length > 1 ? " · cheapest of " + qlist.length + " quotes" : ""}.{" "}
              {(f.supplierId !== rec.supplierId) && <button className="linknum" onClick={() => setF((s) => applyQuotedCost({ ...s, supplierId: rec.supplierId }, rec.costCents))}>Use this supplier</button>}
            </div>
          )}
          {qlist.length > 0 && (
            <div style={{ display: "flex", flexWrap: "wrap", gap: 8, marginTop: 10 }}>
              {qlist.map((qq) => <span key={qq.id} className="ist" style={{ background: qq.supplierId === rec.supplierId ? "rgba(22,163,107,.12)" : "var(--surface-2)", color: qq.supplierId === rec.supplierId ? "var(--ok)" : "var(--muted)" }}>{qq.supplier.name}: {fmt(qq.costCents, cur)}{qq.supplierId === rec.supplierId ? " ✓" : ""}</span>)}
            </div>
          )}
          <div className="grid3" style={{ marginTop: 12 }}>
            <div><label className="label">Quantity</label><input ref={qtyInputRef} className="input" inputMode="numeric" value={f.qty} onChange={(e) => setPurchaseQty(e.target.value)} placeholder="24" /></div>
            <div><label className="label">Unit cost ({cur})</label><input className="input" inputMode="decimal" value={f.cost} onChange={(e) => setPurchaseUnitCost(e.target.value)} placeholder="83.333333" /></div>
            <div><label className="label">Item total ({cur})</label><input className="input" inputMode="decimal" value={f.lineTotal} onChange={(e) => setPurchaseLineTotal(e.target.value)} placeholder="2000.00" /></div>
          </div>
          {(() => {
            const amounts = purchaseDraftAmounts(f);
            if (amounts.qty <= 0 || amounts.lineTotalCents <= 0) return null;
            return (
              <div className="notice" style={{ marginTop: 10, display: "flex", justifyContent: "space-between", gap: 12, flexWrap: "wrap" }}>
                <span>{amounts.qty} unit(s) at <b>{fmtExact(amounts.unitCostCents, cur, 6)}</b> each</span>
                <span>Item total <b>{fmtExact(amounts.lineTotalCents, cur)}</b></span>
              </div>
            );
          })()}
          {(() => {
            const prodSel = data.products.find((p) => p.id === f.productId); const { qty: projQty, unitCostCents: projCost } = purchaseDraftAmounts(f);
            if (!f.received || !prodSel || projQty <= 0 || projCost <= 0) return null;
            const pricingBranchId = f.branchId || branch.id;
            const currentCost = branchInventoryCostCents(data, prodSel, pricingBranchId);
            const sellingPrice = branchProductPriceCents(prodSel, pricingBranchId);
            const avg = wacCost(onHand(data, f.productId, pricingBranchId), currentCost, projQty, projCost);
            const m = sellingPrice > 0 ? Math.round((sellingPrice - avg) / sellingPrice * 100) : 0;
            return <div className="notice" style={{ marginTop: 10 }}>New average cost ≈ <b>{fmt(avg, cur)}</b> (was {fmt(currentCost, cur)}) · margin becomes <b>{m}%</b> at the {fmt(sellingPrice, cur)} selling price. Selling price is unchanged.</div>;
          })()}
          <label className="checkrow"><input type="checkbox" checked={f.received} onChange={(e) => setF({ ...f, received: e.target.checked })} /> Items already received — add to stock now</label>
          <div style={{ display: "flex", gap: 10, marginTop: 16 }}>
            <button className="btn btn-ghost" onClick={() => { setAdding(false); setList([]); }}>Cancel</button>
            <button className="btn btn-primary" onClick={addToList}><Plus /> Add to list</button>
          </div>
          {list.length > 0 && (
            <div style={{ marginTop: 18, borderTop: "1px solid var(--border)", paddingTop: 14 }}>
              <div className="sideh" style={{ marginBottom: 10 }}>Items to save ({list.length})</div>
              <div className="tablewrap">
                <table className="tbl"><thead><tr><th>Product</th><th>Supplier</th><th>Branch</th><th style={{ textAlign: "right" }}>Qty</th><th style={{ textAlign: "right" }}>Unit cost</th><th style={{ textAlign: "right" }}>Line total</th><th>Status</th><th /></tr></thead>
                  <tbody>{list.map((l) => (<tr key={l.key}>
                    <td>{l.productName}</td><td>{l.supplierName}</td><td>{l.branchName}</td>
                    <td style={{ textAlign: "right" }}>{l.qty}</td>
                    <td style={{ textAlign: "right" }}>{fmtExact(purchaseUnitCostCents(l), cur, 6)}</td>
                    <td style={{ textAlign: "right", fontWeight: 800 }}>{fmtExact(purchaseLineTotalCents(l), cur)}</td>
                    <td><span className="ist">{l.received ? "Receive now" : "Order"}</span></td>
                    <td><button className="smdel" onClick={() => removeFromList(l.key)}><Trash2 /></button></td>
                  </tr>))}</tbody></table>
              </div>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginTop: 14 }}>
                <div className="sub">Total <b style={{ color: "var(--text)", fontSize: 16 }}>{fmtExact(listTotal, cur)}</b> · {list.length} item(s)</div>
                <button className="btn btn-primary" onClick={saveAll}><Check /> Save all ({list.length})</button>
              </div>
            </div>
          )}</div>
      )}
      {plan && (
        <div className="addpanel fade" style={{ marginTop: 14 }}>
          <div className="page-h" style={{ marginBottom: 6 }}>
            <div><div className="title" style={{ fontSize: 17, display: "flex", alignItems: "center", gap: 8 }}><Sparkles style={{ width: 16, height: 16, color: "var(--accent)" }} /> AI reorder plan</div>
              <div className="sub">{data.branches.find((b) => b.id === planBranch)?.name || branch.name} · {plan.length} item(s) at or below reorder level</div></div>
            <div style={{ display: "flex", alignItems: "flex-end", gap: 10 }}>
              <div><label className="label">Order for branch</label>
                <select className="select" style={{ minWidth: 150, height: 36 }} value={planBranch} onChange={(e) => prepare(e.target.value)}>{data.branches.map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}</select></div>
              <button className="iconbtn" onClick={() => { setPlan(null); setPlanNote(""); }}><X /></button>
            </div>
          </div>
          {planNote && <div className="insans" style={{ marginBottom: 12 }}>{planNote}</div>}
          {plan.length === 0 ? <div className="notice">Nothing is below reorder level at {data.branches.find((b) => b.id === planBranch)?.name || branch.name} right now.</div> : (
            <>
              <div className="tablewrap tblscroll"><table className="tbl"><thead><tr><th>Product</th><th>On hand</th><th>Qty</th><th>Recommended supplier</th><th>Unit cost</th><th>Line total</th><th></th></tr></thead>
                <tbody>{plan.map((l) => { const r = l.quotes[0]; const isRec = r && l.supplierId === r.supplierId; return (
                  <tr key={l.productId}>
                    <td><div className="nm">{l.name}</div><div className="mt2">{l.sku} · reorder {l.reorder}</div></td>
                    <td style={{ fontWeight: 700 }}>{l.onHand}</td>
                    <td><input className="input" style={{ width: 72, height: 36, fontFamily: "var(--font-mono)" }} inputMode="numeric" value={l.qty} onChange={(e) => setLine(l.productId, { qty: parseInt(e.target.value.replace(/\D/g, ""), 10) || 0 })} /></td>
                    <td>
                      <select className="select" style={{ minWidth: 150, height: 36 }} value={l.supplierId} onChange={(e) => lineSupplier(l, e.target.value)}>{data.suppliers.map((s) => <option key={s.id} value={s.id}>{s.name}{r && s.id === r.supplierId ? " ★" : ""}</option>)}</select>
                      {l.hasQuote ? <div className="mt2" style={{ color: isRec ? "var(--ok)" : "var(--warn)" }}>{isRec ? ("Cheapest" + (l.quotes.length > 1 ? " of " + l.quotes.length : "")) : "Not the cheapest quote"}</div> : <div className="mt2" style={{ color: "var(--muted-2)" }}>No quotes — choose a supplier</div>}
                    </td>
                    <td className="amt">{fmt(l.costCents, cur)}</td>
                    <td className="amt">{fmt(l.costCents * l.qty, cur)}</td>
                    <td><button className="btn xs btn-primary" onClick={() => createLine(l)}><Check /> Order</button></td>
                  </tr>); })}</tbody></table></div>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginTop: 12, gap: 10, flexWrap: "wrap" }}>
                <div className="cust-meta">Estimated total: <b>{fmt(plan.reduce((s, l) => s + l.costCents * l.qty, 0), cur)}</b></div>
                <button className="btn btn-primary" onClick={createAll}><Check /> Create all orders</button>
              </div>
            </>
          )}
        </div>
      )}
      <DocumentFile
        title="Purchase order files"
        count={new Set((data.purchases || []).map((purchase) => purchase.batchId || purchase.id)).size}
        meta="Received and outstanding purchase documents"
      >
      {(() => {
        const groups = {};
        data.purchases.forEach((po) => { const k = po.batchId || po.id; (groups[k] = groups[k] || []).push(po); });
        const rows = Object.entries(groups).map(([key, items]) => {
          const ts = Math.max(...items.map((i) => i.ts));
          const total = items.reduce((s, i) => s + purchaseLineTotalCents(i), 0);
          const units = items.reduce((s, i) => s + i.qty, 0);
          const recd = items.filter((i) => i.status === "received").length;
          const suppliers = Array.from(new Set(items.map((i) => i.supplierName).filter(Boolean)));
          const branches = Array.from(new Set(items.map((i) => data.branches.find((b) => b.id === i.branchId)?.name).filter(Boolean)));
          return { key, items, ts, total, units, recd, suppliers, branches, no: items[0].batchNo, date: items[0].date };
        }).sort((a, b) => b.ts - a.ts);
        return (
          <div className="list">{rows.map((g) => (
            <div className="row clickable" key={g.key} onClick={() => setPoView(g.key)}>
              <div className="avatar"><ShoppingBag style={{ width: 17, height: 17 }} /></div>
              <div className="meta"><div className="nm">{g.no ? g.no + " · " : ""}{g.items.length} item{g.items.length > 1 ? "s" : ""} · {g.units} unit{g.units > 1 ? "s" : ""}</div>
                <div className="mt2">{g.suppliers.join(", ") || "—"} · {g.branches.join(", ")} · {dt(g.ts)} · {fmt(g.total, cur)}</div></div>
              {g.recd === g.items.length ? <span className="ist paid">received</span> : <span className="ist">{g.recd}/{g.items.length} received</span>}
              <button className="btn xs btn-ghost" onClick={(e) => { e.stopPropagation(); setPoView(g.key); }}>View</button>
            </div>))}
            {rows.length === 0 && <div className="notice">No purchase orders yet.</div>}</div>
        );
      })()}
      </DocumentFile>
      {poView && (() => {
        const items = data.purchases.filter((po) => (po.batchId || po.id) === poView);
        if (items.length === 0) { setPoView(null); return null; }
        const total = items.reduce((s, i) => s + purchaseLineTotalCents(i), 0);
        const anyOrdered = items.some((i) => i.status !== "received");
        const head = items[0];
        return (
          <div className="scrim" onClick={() => setPoView(null)}>
            <div className="modal" style={{ maxWidth: 640 }} onClick={(e) => e.stopPropagation()}>
              <div className="modal-head"><div><div className="sub" style={{ margin: 0 }}>Purchase order</div><div className="title" style={{ fontSize: 19, display: "flex", alignItems: "center", gap: 8 }}><ShoppingBag style={{ width: 18, height: 18 }} /> {head.batchNo || "Purchase"} · {dt(head.ts)}</div></div>
                <button className="iconbtn" onClick={() => setPoView(null)}><X /></button></div>
              <div className="tablewrap" style={{ marginTop: 8 }}>
                <table className="tbl"><thead><tr><th>Product</th><th>Supplier</th><th>Branch</th><th style={{ textAlign: "right" }}>Qty</th><th style={{ textAlign: "right" }}>Unit cost</th><th style={{ textAlign: "right" }}>Line total</th><th>Status</th>{isAdmin && <th />}</tr></thead>
                  <tbody>{items.map((po) => (<tr key={po.id}>
                    <td>{po.productName}</td><td>{po.supplierName}</td><td>{data.branches.find((b) => b.id === po.branchId)?.name || "—"}</td>
                    <td style={{ textAlign: "right" }}>{po.qty}</td><td style={{ textAlign: "right" }}>{fmtExact(purchaseUnitCostCents(po), cur, 6)}</td><td style={{ textAlign: "right" }}>{fmtExact(purchaseLineTotalCents(po), cur)}</td>
                    <td>{po.status === "received" ? <span className="ist paid">received</span> : <button className="btn xs btn-primary" onClick={() => receive(po)}><Check /> Receive</button>}</td>
                    {isAdmin && <td><button className="smdel" onClick={() => setDelConfirm({ mode: "line", po, label: po.qty + "× " + po.productName })}><Trash2 /></button></td>}
                  </tr>))}</tbody></table>
              </div>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginTop: 14, gap: 10, flexWrap: "wrap" }}>
                <div className="sub">Total <b style={{ color: "var(--text)", fontSize: 16 }}>{fmtExact(total, cur)}</b> · {items.length} line(s){!isAdmin && <span style={{ display: "block", marginTop: 4 }}>Read-only · only an admin can delete a purchase record.</span>}</div>
                <div style={{ display: "flex", gap: 8 }}>
                  {anyOrdered && isAdmin && <button className="btn btn-ghost" onClick={() => setReceiptCorrection({ ids: items.filter((po) => po.status !== "received").map((po) => po.id), label: head.batchNo || "this purchase" })}><Wrench /> Fix stale status</button>}
                  {anyOrdered && <button className="btn btn-primary" onClick={() => receiveBatch(items)}><Check /> Receive stock</button>}
                  {isAdmin && <button className="btn btn-ghost" style={{ color: "var(--danger)" }} onClick={() => setDelConfirm({ mode: "file", key: poView, label: head.batchNo || "this purchase" })}><Trash2 /> Delete order</button>}
                </div>
              </div>
            </div>
          </div>
        );
      })()}
      {cameraOpen && (
        <CameraBarcodeScanner
          eyebrow="Purchases"
          title="Scan product for purchase"
          onClose={() => setCameraOpen(false)}
          onScan={handlePurchaseScan}
        />
      )}
      {receiptCorrection && (
        <div className="scrim" onClick={() => setReceiptCorrection(null)}>
          <div className="modal" style={{ maxWidth: 440 }} onClick={(e) => e.stopPropagation()}>
            <div className="modal-head"><div className="title" style={{ fontSize: 18, display: "flex", alignItems: "center", gap: 8 }}><Wrench style={{ width: 18, height: 18, color: "var(--warn)" }} /> Fix stale receipt status?</div>
              <button className="iconbtn" onClick={() => setReceiptCorrection(null)}><X /></button></div>
            <div className="sub" style={{ margin: "4px 0" }}>Use this only when stock for <b>{receiptCorrection.label}</b> was already added previously.</div>
            <div className="notice" style={{ marginTop: 8 }}>The purchase document will be marked received. Inventory quantities and purchase costs will not be changed.</div>
            <div style={{ display: "flex", gap: 10, marginTop: 16 }}>
              <button className="btn btn-ghost" onClick={() => setReceiptCorrection(null)}>Cancel</button>
              <button className="btn btn-primary" onClick={() => correctReceiptStatus(receiptCorrection.ids)}><Check /> Mark received</button>
            </div>
          </div>
        </div>
      )}
      {delConfirm && (
        <div className="scrim" onClick={() => setDelConfirm(null)}>
          <div className="modal" style={{ maxWidth: 420 }} onClick={(e) => e.stopPropagation()}>
            <div className="modal-head"><div className="title" style={{ fontSize: 18, display: "flex", alignItems: "center", gap: 8 }}><AlertCircle style={{ width: 18, height: 18, color: "var(--danger)" }} /> Delete purchase record?</div>
              <button className="iconbtn" onClick={() => setDelConfirm(null)}><X /></button></div>
            <div className="sub" style={{ margin: "4px 0 4px" }}>You're about to permanently delete <b>{delConfirm.label}</b>{delConfirm.mode === "file" ? " and all its line items" : ""}.</div>
            <div className="notice" style={{ marginTop: 8 }}>This removes the purchase record only. Stock already received from it is not reversed. This can't be undone.</div>
            <div style={{ display: "flex", gap: 10, marginTop: 16 }}>
              <button className="btn btn-ghost" onClick={() => setDelConfirm(null)}>Cancel</button>
              <button className="btn btn-primary" style={{ background: "var(--danger)" }} onClick={() => { if (delConfirm.mode === "file") { removeBatch(delConfirm.key); setPoView(null); } else { remove(delConfirm.po.id); } setDelConfirm(null); }}><Trash2 /> Delete</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

/* ---- Suppliers / Customers / Branches ---- */
function SuppliersTab({ data, update }) {
  const cur = data.settings.currency;
  const [adding, setAdding] = useState(false); const [f, setF] = useState({ name: "", contact: "", phone: "" });
  const [q, setQ] = useState(""); const [cmpProd, setCmpProd] = useState("");
  const sp = data.supplierPrices || [];
  const add = () => { if (!f.name.trim()) return; update((d) => ({ ...d, suppliers: [...d.suppliers, { id: uid("s"), ...f, name: f.name.trim(), synced: false }] })); setF({ name: "", contact: "", phone: "" }); setAdding(false); };
  const remove = (id) => update((d) => ({ ...d, suppliers: d.suppliers.filter((s) => s.id !== id) }));
  const quotesFor = (pid) => sp.filter((x) => x.productId === pid).map((x) => ({ ...x, supplier: data.suppliers.find((s) => s.id === x.supplierId) })).filter((x) => x.supplier).sort((a, b) => a.costCents - b.costCents);
  const uniqueProducts = sortProductsAZ(dedupeProductsByCode(data.products));
  const prodMatches = q.trim() === "" ? uniqueProducts.slice(0, 8) : uniqueProducts.filter((p) => p.name.toLowerCase().includes(q.toLowerCase()) || p.sku.toLowerCase().includes(q.toLowerCase())).slice(0, 12);
  const prod = data.products.find((p) => p.id === cmpProd);
  const best = cmpProd ? quotesFor(cmpProd)[0] : null;
  const setSupQuote = (supplierId, valCents) => update((d) => {
    const list = (d.supplierPrices || []).slice();
    const i = list.findIndex((x) => x.supplierId === supplierId && x.productId === cmpProd);
    if (i >= 0) list[i] = { ...list[i], costCents: valCents, synced: false };
    else list.push({ id: uid("sp"), supplierId, productId: cmpProd, costCents: valCents, synced: false });
    return { ...d, supplierPrices: list };
  });
  const removeQuote = (supplierId) => update((d) => ({ ...d, supplierPrices: (d.supplierPrices || []).filter((x) => !(x.supplierId === supplierId && x.productId === cmpProd)) }));
  return (
    <div><PageHead title="Suppliers" sub={data.suppliers.length + " suppliers · compare prices per product"} />
      {!adding ? <button className="row-add" onClick={() => setAdding(true)}><Plus /> Add supplier</button> : (
        <div className="addpanel fade"><div className="grid3">
          <div><label className="label">Name</label><input className="input" value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} placeholder="Supplier" /></div>
          <div><label className="label">Contact</label><input className="input" value={f.contact} onChange={(e) => setF({ ...f, contact: e.target.value })} placeholder="Person" /></div>
          <div><label className="label">Phone</label><input className="input" value={f.phone} onChange={(e) => setF({ ...f, phone: e.target.value })} placeholder="07.." /></div></div>
          <div style={{ display: "flex", gap: 10, marginTop: 16 }}><button className="btn btn-ghost" onClick={() => setAdding(false)}>Cancel</button><button className="btn btn-primary" onClick={add}><Check /> Add supplier</button></div></div>)}
      <div className="list" style={{ maxHeight: 280, overflow: "auto" }}>{data.suppliers.map((s) => { const n = sp.filter((x) => x.supplierId === s.id).length; return (<div className="row" key={s.id}><div className="avatar">{s.name.charAt(0)}</div>
        <div className="meta"><div className="nm">{s.name}</div><div className="mt2">{s.contact} · {s.phone} · {n} price{n === 1 ? "" : "s"} quoted</div></div><button className="smdel" onClick={() => remove(s.id)}><Trash2 /></button></div>); })}</div>

      <div className="section-title" style={{ margin: "20px 0 10px" }}>Price comparison</div>
      <div className="addpanel">
        <label className="label">Find a product</label>
        <div className="possearch" style={{ height: 44 }}><Search /><input placeholder="Search product name or SKU…" value={q} onChange={(e) => setQ(e.target.value)} /></div>
        <div style={{ display: "flex", flexWrap: "wrap", gap: 8, marginTop: 10 }}>
          {prodMatches.map((p) => <button key={p.id} className={"inschip" + (cmpProd === p.id ? " on" : "")} onClick={() => setCmpProd(p.id)}>{p.name}</button>)}
        </div>
        {prod && (
          <div style={{ marginTop: 16 }}>
            <div className="cust-meta" style={{ marginBottom: 8 }}>Quotes for <b>{prod.name}</b> ({prod.sku}) · sells at {fmt(prod.priceCents, cur)}</div>
            <div className="tablewrap"><table className="tbl"><thead><tr><th>Supplier</th><th>Quoted cost</th><th>Margin if sold</th><th>Set / update</th><th></th></tr></thead>
              <tbody>{data.suppliers.map((s) => {
                const existing = sp.find((x) => x.supplierId === s.id && x.productId === cmpProd);
                const isBest = best && existing && existing.costCents === best.costCents;
                const marg = existing && prod.priceCents > 0 ? Math.round((prod.priceCents - existing.costCents) / prod.priceCents * 100) : null;
                return (<tr key={cmpProd + s.id} style={isBest ? { background: "rgba(22,163,107,.08)" } : undefined}>
                  <td><div className="nm">{s.name}{isBest && <span className="ist paid" style={{ marginLeft: 8 }}>Best price</span>}</div><div className="mt2">{s.contact || ""}</div></td>
                  <td className="amt">{existing ? fmt(existing.costCents, cur) : "—"}</td>
                  <td style={{ fontWeight: 650, color: marg != null && marg < 0 ? "var(--danger)" : "var(--text)" }}>{marg == null ? "—" : marg + "%"}</td>
                  <td><input className="input" key={cmpProd + s.id + "i"} style={{ width: 120, height: 36, fontFamily: "var(--font-mono)" }} inputMode="decimal" placeholder="Cost" defaultValue={existing ? String(existing.costCents / 100) : ""} onBlur={(e) => { if (e.target.value !== "") { const c = Math.round(parseFloat(e.target.value) * 100); if (c > 0) setSupQuote(s.id, c); } }} onKeyDown={(e) => { if (e.key === "Enter") e.target.blur(); }} /></td>
                  <td>{existing && <button className="smdel" onClick={() => removeQuote(s.id)}><Trash2 /></button>}</td>
                </tr>);
              })}</tbody></table></div>
            {best ? <div className="notice" style={{ marginTop: 10 }}>Cheapest: <b>{best.supplier.name}</b> at {fmt(best.costCents, cur)}. Type a cost and press Enter (or tab out) to save a quote.</div>
              : <div className="notice" style={{ marginTop: 10 }}>No quotes yet — enter a cost for any supplier to start comparing.</div>}
          </div>
        )}
      </div>
    </div>
  );
}
function customerSource(value) {
  return value?.payload && typeof value.payload === "object" ? { ...value, ...value.payload } : (value || {});
}
function customerBranchId(value) {
  const source = customerSource(value);
  const branchValue = source.branch && typeof source.branch === "object" ? source.branch.id : source.branch;
  return String(source.branchId ?? source.branch_id ?? branchValue ?? "").trim();
}
function customerIdentity(value, linkedCustomer = null) {
  const source = customerSource(value);
  const embedded = source.customer && typeof source.customer === "object" ? customerSource(source.customer) : {};
  const linked = customerSource(linkedCustomer);
  const customerText = typeof source.customer === "string" ? source.customer : "";
  const id = String(source.customerId ?? source.customer_id ?? embedded.id ?? linked.id ?? source.id ?? "").trim();
  const name = String(
    source.customerName ?? source.customer_name ?? source.customerIdentifier ?? source.customer_identifier
      ?? embedded.name ?? embedded.displayName ?? embedded.display_name
      ?? linked.name ?? linked.displayName ?? linked.display_name ?? linked.identifier
      ?? source.name ?? source.displayName ?? source.display_name ?? source.identifier ?? customerText ?? ""
  ).trim();
  const phone = String(
    source.customerPhone ?? source.customer_phone ?? source.phone
      ?? embedded.phone ?? embedded.phoneNumber ?? embedded.phone_number
      ?? linked.phone ?? linked.phoneNumber ?? linked.phone_number ?? ""
  ).trim();
  return { id, name, phone };
}
function customerGroupKey(customer) {
  const phone = customer.phone.replace(/[^0-9+]/g, "").toLowerCase();
  return phone ? `phone:${phone}` : `name:${customer.name.toLowerCase()}`;
}
function customerInvoiceCents(invoice, field) {
  const source = customerSource(invoice);
  const value = field === "total"
    ? (source.totalCents ?? source.total_cents)
    : (source.paidCents ?? source.paid_cents);
  const parsed = Number(value ?? 0);
  return Number.isFinite(parsed) ? parsed : 0;
}
function CustomersTab({ data, branch }) {
  const [query, setQuery] = useState("");
  const [statusFilter, setStatusFilter] = useState("debt");
  const [selectedCustomerKey, setSelectedCustomerKey] = useState(null);
  const customers = useMemo(() => {
    const grouped = new Map();
    const customerById = new Map();
    const selectedBranchId = String(branch?.id || "");
    const isVisibleAtBranch = (value) => {
      const recordBranchId = customerBranchId(value);
      return !selectedBranchId || !recordBranchId || recordBranchId === selectedBranchId;
    };
    const isRealCustomer = (name) => name && !/^walk[- ]?in$/i.test(name);
    const ensureCustomer = (identity) => {
      if (!isRealCustomer(identity.name)) return null;
      const key = customerGroupKey(identity);
      const current = grouped.get(key) || {
        id: identity.id || key,
        groupKey: key,
        name: identity.name,
        phone: identity.phone,
        invoiceCount: 0,
        totalCents: 0,
        outstandingCents: 0,
        debtCents: 0,
        pendingCents: 0,
        paidInvoiceCount: 0,
        debtInvoiceCount: 0,
        pendingInvoiceCount: 0,
        lastInvoiceAt: 0,
        lastReceipt: "",
        invoices: [],
      };
      if (!current.phone && identity.phone) current.phone = identity.phone;
      if ((!current.name || current.name === current.id) && identity.name) current.name = identity.name;
      grouped.set(key, current);
      return current;
    };

    (data.customers || []).forEach((rawCustomer) => {
      const identity = customerIdentity(rawCustomer);
      if (identity.id) customerById.set(identity.id, rawCustomer);
      if (isVisibleAtBranch(rawCustomer)) ensureCustomer(identity);
    });

    operationalInvoices(data).filter(isVisibleAtBranch).forEach((invoice) => {
      const source = customerSource(invoice);
      const rawCustomerId = String(source.customerId ?? source.customer_id ?? source.customer?.id ?? "").trim();
      const identity = customerIdentity(source, customerById.get(rawCustomerId));
      const current = ensureCustomer(identity);
      if (!current) return;
      const rawTs = source.ts ?? source.createdAt ?? source.created_at ?? source.issuedAt ?? source.issued_at ?? source.openedAt ?? 0;
      const invoiceTs = typeof rawTs === "number" ? rawTs : Date.parse(rawTs) || 0;
      const totalCents = customerInvoiceCents(source, "total");
      const paidCents = customerInvoiceCents(source, "paid");
      const receiptNo = String(source.number ?? source.receiptNo ?? source.receipt_no ?? "Invoice");
      const normalizedInvoice = {
        ...source,
        id: String(source.id ?? source.invoiceId ?? source.invoice_id ?? receiptNo),
        number: receiptNo,
        ts: invoiceTs,
        totalCents,
        paidCents: Math.max(0, Math.min(totalCents, paidCents)),
      };
      const outstandingCents = invOutstanding(normalizedInvoice);
      current.invoices.push(normalizedInvoice);
      current.invoiceCount += 1;
      current.totalCents += totalCents;
      current.outstandingCents += outstandingCents;
      if (outstandingCents <= 0) {
        current.paidInvoiceCount += 1;
      } else if (invIsDebt(normalizedInvoice)) {
        current.debtCents += outstandingCents;
        current.debtInvoiceCount += 1;
      } else {
        current.pendingCents += outstandingCents;
        current.pendingInvoiceCount += 1;
      }
      if (invoiceTs >= current.lastInvoiceAt) {
        current.lastInvoiceAt = invoiceTs;
        current.lastReceipt = receiptNo;
      }
    });
    return [...grouped.values()]
      .map((customer) => ({
        ...customer,
        accountStatus: customer.debtCents > 0 ? "debt" : customer.pendingCents > 0 ? "pending" : customer.invoiceCount > 0 ? "paid" : "inactive",
        invoices: customer.invoices.sort((a, b) => b.ts - a.ts),
      }))
      .sort((a, b) => a.name.localeCompare(b.name));
  }, [data.customers, data.invoices, data.invoiceVoidRequests, data.invoiceVoidDecisions, branch?.id]);
  const selectedCustomer = customers.find((customer) => customer.groupKey === selectedCustomerKey) || null;
  useEffect(() => {
    if (!selectedCustomer) return undefined;
    const closeOnEscape = (event) => {
      if (event.key === "Escape") setSelectedCustomerKey(null);
    };
    window.addEventListener("keydown", closeOnEscape);
    return () => window.removeEventListener("keydown", closeOnEscape);
  }, [selectedCustomer]);
  const search = query.trim().toLowerCase();
  const statusCounts = customers.reduce((counts, customer) => {
    counts.all += 1;
    if (customer.accountStatus !== "inactive") counts[customer.accountStatus] += 1;
    return counts;
  }, { debt: 0, pending: 0, paid: 0, all: 0 });
  const visible = customers
    .filter((customer) => statusFilter === "all" || customer.accountStatus === statusFilter)
    .filter((customer) => !search
      || customer.name.toLowerCase().includes(search)
      || customer.phone.toLowerCase().includes(search)
      || customer.lastReceipt.toLowerCase().includes(search))
    .sort((a, b) => statusFilter === "paid"
      ? b.lastInvoiceAt - a.lastInvoiceAt
      : statusFilter === "all"
        ? a.name.localeCompare(b.name)
        : b.outstandingCents - a.outstandingCents || a.name.localeCompare(b.name));
  const filterLabels = { debt: "customers with debts", pending: "customers with pending balances", paid: "fully paid customers", all: "customers" };
  const emptyMessages = {
    debt: "No customers currently have invoice debts.",
    pending: "No customers currently have pending invoice balances.",
    paid: "No fully paid customers match this search.",
    all: "Customers appear here after a cashier issues an invoice.",
  };
  return (
    <div className="customer-page"><PageHead title="Customers" sub={`${statusCounts[statusFilter]} ${filterLabels[statusFilter]} for ${branch?.name || "all branches"}`} />
      <div className="customer-toolbar">
        <div className="possearch"><Search /><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search name, phone, or receipt" /></div>
        <div className="customer-filter-tabs" role="tablist" aria-label="Filter customer accounts">
          {[["debt", "Debts"], ["pending", "Pending"], ["paid", "Paid"], ["all", "All"]].map(([key, label]) => (
            <button type="button" role="tab" aria-selected={statusFilter === key} className={`customer-filter ${key}${statusFilter === key ? " on" : ""}`} key={key} onClick={() => { setStatusFilter(key); setSelectedCustomerKey(null); }}>
              {label}<span className="customer-filter-count">{statusCounts[key]}</span>
            </button>
          ))}
        </div>
      </div>
      <div className="list">
        {visible.length === 0 && <div className="notice">{search ? `No ${filterLabels[statusFilter]} match “${query.trim()}”.` : emptyMessages[statusFilter]}</div>}
        {visible.map((customer) => <button type="button" className="row clickable customer-row" key={customer.id} onClick={() => setSelectedCustomerKey(customer.groupKey)}>
          <div className="avatar">{customer.name.charAt(0).toUpperCase()}</div>
          <div className="meta"><div className="nm">{customer.name}</div><div className="mt2">{customer.phone || "No phone"} · {customer.invoiceCount} invoice(s){customer.lastReceipt ? ` · Last ${customer.lastReceipt}` : ""}{customer.lastInvoiceAt ? ` · ${new Date(customer.lastInvoiceAt).toLocaleDateString()}` : ""}</div></div>
          <div className="customer-account-balance">
            <span className={`customer-account-status ${customer.accountStatus}`}>{customer.accountStatus === "inactive" ? "No invoices" : customer.accountStatus}</span>
            <strong>{fmt(customer.accountStatus === "paid" ? customer.totalCents : customer.outstandingCents, data.settings.currency)}</strong>
            <small>{customer.accountStatus === "paid" ? "total sales" : "outstanding"}</small>
          </div>
          <ChevronRight className="customer-chevron" aria-hidden="true" />
        </button>)}
      </div>
      {selectedCustomer && <div className="scrim" onMouseDown={(event) => { if (event.target === event.currentTarget) setSelectedCustomerKey(null); }}>
        <section className="modal customer-history-modal" role="dialog" aria-modal="true" aria-labelledby="customer-history-title">
          <header className="customer-history-head">
            <div>
              <span className="eyebrow">Customer account</span>
              <h2 id="customer-history-title">{selectedCustomer.name}</h2>
              <p>{selectedCustomer.phone || "No phone recorded"} · <span className={`customer-account-status ${selectedCustomer.accountStatus}`}>{selectedCustomer.accountStatus === "inactive" ? "No invoices" : selectedCustomer.accountStatus}</span></p>
            </div>
            <button type="button" className="icon-btn" aria-label="Close customer invoices" onClick={() => setSelectedCustomerKey(null)}><X /></button>
          </header>
          <div className="customer-history-summary">
            <div><span>Invoices</span><strong>{selectedCustomer.invoiceCount}</strong></div>
            <div><span>Total sales</span><strong>{fmt(selectedCustomer.totalCents, data.settings.currency)}</strong></div>
            <div><span>Outstanding</span><strong className={selectedCustomer.outstandingCents > 0 ? "customer-balance-due" : ""}>{fmt(selectedCustomer.outstandingCents, data.settings.currency)}</strong></div>
          </div>
          <div className="customer-invoice-title"><div><Receipt /><b>Invoice history</b></div><span>{selectedCustomer.invoiceCount} invoice(s)</span></div>
          <div className="customer-invoice-list">
            <div className="customer-invoice-row customer-invoice-columns"><span>Invoice</span><span>Status</span><span>Total</span><span>Paid</span><span>Outstanding</span></div>
            {selectedCustomer.invoices.map((invoice) => {
              const outstanding = invOutstanding(invoice);
              const status = invStatus(invoice);
              return <div className="customer-invoice-row" key={invoice.id}>
                <div className="customer-invoice-main"><strong>{invoice.number}</strong><span>{dt(invoice.ts)}</span></div>
                <span className={`customer-invoice-status ${status}`}>{status}</span>
                <div className="customer-invoice-amount"><small>Total</small><strong>{fmt(invoice.totalCents, data.settings.currency)}</strong></div>
                <div className="customer-invoice-amount"><small>Paid</small><strong>{fmt(invoice.paidCents, data.settings.currency)}</strong></div>
                <div className="customer-invoice-amount due"><small>Outstanding</small><strong>{fmt(outstanding, data.settings.currency)}</strong></div>
              </div>;
            })}
          </div>
        </section>
      </div>}
    </div>
  );
}
function BranchesTab({ data, update }) {
  const cur = data.settings.currency;
  const blank = { name: "", code: "", location: "", managerId: "", active: true, mpesaTill: "" };
  const [editId, setEditId] = useState(null);
  const [f, setF] = useState(blank);
  const prod = (id) => data.products.find((p) => p.id === id);
  const stats = (b) => {
    let units = 0, value = 0;
    branchProductsUnique(data, b.id).forEach((p) => {
      const valuation = productStockValuation(data, p, b.id);
      units += valuation.quantity;
      value += valuation.costValue;
    });
    // Profit (recognized in P&L): gross sales − COGS − expenses for this branch
    const recInvs = operationalInvoices(data).filter((i) => i.branchId === b.id && invRecognized(i, data.settings));
    const grossSales = recInvs.reduce((s, i) => s + i.totalCents, 0);
    const saleMoves = data.stockMovements.filter((m) => typeof m.reason === "string" && m.reason.startsWith("Sale") && m.branchId === b.id && saleMoveRecognized(data, m));
    const cogs = saleMoves.reduce((s, m) => { const p = prod(m.productId); return s + (-m.qty) * (p ? branchInventoryCostCents(data, p, b.id) : 0); }, 0);
    const expenses = data.expenses.filter((e) => (!e.status || e.status === "approved") && e.branchId === b.id).reduce((s, e) => s + e.amountCents, 0);
    const grossProfit = grossSales - cogs;
    const netProfit = grossProfit - expenses;
    const margin = grossSales > 0 ? Math.round((grossProfit / grossSales) * 100) : 0;
    return { units, value, reorders: reorderList(data, b.id).length, grossSales, grossProfit, netProfit, margin };
  };
  const reset = () => { setEditId(null); setF(blank); };
  const save = () => {
    if (!f.name.trim()) return;
    const code = (f.code.trim() || f.name.trim().replace(/[^A-Za-z0-9]/g, "").slice(0, 3)).toUpperCase();
    update((d) => {
      const patch = { name: f.name.trim(), code, location: f.location.trim(), managerId: f.managerId || null, active: f.active, mpesaTill: f.mpesaTill.trim(), synced: false };
      if (editId) return { ...d, branches: d.branches.map((b) => b.id === editId ? { ...b, ...patch } : b) };
      return { ...d, branches: [...d.branches, { id: uid("b"), ...patch }] };
    });
    reset();
  };
  const startEdit = (b) => { setEditId(b.id); setF({ name: b.name || "", code: b.code || "", location: b.location || "", managerId: b.managerId || "", active: b.active !== false, mpesaTill: b.mpesaTill || "" }); };
  const remove = (id) => update((d) => ({ ...d, branches: d.branches.length > 1 ? d.branches.filter((b) => b.id !== id) : d.branches }));
  return (
    <div className="branchwrap">
      <div>
        <PageHead title="Branches" sub="Set up shops, managers and status." />
        <div className="addpanel">
          <div className="grid2">
            <div><label className="label">Branch name</label><input className="input" value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} placeholder="e.g. Mombasa" /></div>
            <div><label className="label">Branch code</label><input className="input" value={f.code} onChange={(e) => setF({ ...f, code: e.target.value })} placeholder="Auto from name" /></div>
          </div>
          <div className="grid2" style={{ marginTop: 12 }}>
            <div><label className="label">Location</label><input className="input" value={f.location} onChange={(e) => setF({ ...f, location: e.target.value })} placeholder="Shop location" /></div>
            <div><label className="label">Manager</label><select className="select" value={f.managerId} onChange={(e) => setF({ ...f, managerId: e.target.value })}>
              <option value="">No manager</option>{activeEmployees(data).map((e) => <option key={e.id} value={e.id}>{e.name}</option>)}</select></div>
          </div>
          <div className="field" style={{ marginTop: 12 }}><label className="label">M-Pesa Buy Goods Till (this branch)</label><input className="input" inputMode="numeric" value={f.mpesaTill} onChange={(e) => setF({ ...f, mpesaTill: e.target.value })} placeholder="e.g. 5204512" /></div>
          <label className="checkrow"><input type="checkbox" checked={f.active} onChange={(e) => setF({ ...f, active: e.target.checked })} /> Branch active</label>
          <button className="btn btn-primary" style={{ marginTop: 14 }} onClick={save}>{editId ? <><Check /> Update Branch</> : <><Plus /> Save Branch</>}</button>
          {editId && <button className="btn btn-ghost" style={{ marginTop: 8 }} onClick={reset}>Cancel edit</button>}
        </div>
        {data.branches.map((b) => { const s = stats(b); const active = b.active !== false; return (
          <div className="brow" key={b.id}>
            <div className="meta" style={{ flex: 1 }}><div className="nm"><span className="bn">{b.name}</span><span className="bc">{(b.code || "—") + " / " + (b.location || b.name)}</span></div></div>
            <span className={"bpill " + (active ? "on" : "off")}>{active ? "Active" : "Inactive"}</span>
            <span className="bu">{s.units} units</span>
            <span className="bu">{fmt(s.value, cur)}</span>
            <button className="btn xs btn-ghost" onClick={() => startEdit(b)}>Edit</button>
            {data.branches.length > 1 && <button className="smdel" onClick={() => remove(b.id)}><Trash2 /></button>}
          </div>); })}
      </div>
      <div>
        <PageHead title="Branch Inventory Summary" sub="Stock value and reorder pressure per shop." />
        {data.branches.map((b) => { const s = stats(b); return (
          <div className="bcard" key={b.id}>
            <div className="bt">{b.name}</div>
            <div className="bl">{b.location || b.name}</div>
            <div className="bkv"><span>Units on hand</span><span className="v">{s.units}</span></div>
            <div className="bkv"><span>Inventory value</span><span className="v">{fmt(s.value, cur)}</span></div>
            <div className="bkv"><span>Sales (recognized)</span><span className="v">{fmt(s.grossSales, cur)}</span></div>
            <div className="bkv"><span>Gross profit</span><span className="v" style={{ color: s.grossProfit >= 0 ? "var(--ok)" : "var(--danger)" }}>{fmt(s.grossProfit, cur)} · {s.margin}%</span></div>
            <div className="bkv"><span>Net profit</span><span className="v" style={{ color: s.netProfit >= 0 ? "var(--ok)" : "var(--danger)" }}>{fmt(s.netProfit, cur)}</span></div>
            <div className="bkv"><span>Reorder alerts</span><span className="v" style={{ color: s.reorders ? "var(--danger)" : "var(--text)" }}>{s.reorders}</span></div>
            <div className="bkv"><span>M-Pesa till</span><span className="v">{b.mpesaTill || "—"}</span></div>
          </div>); })}
      </div>
    </div>
  );
}

/* ---- Branch Transfer (Stock Borrowing) ---- */
function BorrowingTab({ data, update }) {
  const [fromB, setFromB] = useState(data.branches[1]?.id || data.branches[0]?.id || "");
  const [toB, setToB] = useState(data.branches[0]?.id || "");
  const [q, setQ] = useState("");
  const [productId, setProductId] = useState("");
  const [qty, setQty] = useState("");
  const [note, setNote] = useState("");
  const [err, setErr] = useState("");
  const [transferScannerOn, setTransferScannerOn] = useState(false);
  const [cameraOpen, setCameraOpen] = useState(false);
  const [transferScanMessage, setTransferScanMessage] = useState("");
  const transferSearchRef = useRef(null);
  const transferQtyRef = useRef(null);
  const [repairTransfer, setRepairTransfer] = useState(null);
  const [lines, setLines] = useState([]); // [{productId, productName, sku, qty, costCents}]
  const bn = (id) => data.branches.find((b) => b.id === id)?.name || "—";
  const product = data.products.find((p) => p.id === productId);
  // available accounts for quantities already added to the pending list for this product at this source
  const pendingQty = (pid) => lines.filter((l) => l.productId === pid).reduce((s, l) => s + l.qty, 0);
  const available = product ? productOnHand(data, product, fromB) - pendingQty(product.id) : 0;
  const sourceProducts = branchProductsUnique(data, fromB);
  const matches = q.trim() === "" ? [] : sortProductsAZ(sourceProducts.filter((p) =>
    p.name.toLowerCase().includes(q.toLowerCase())
    || p.sku.toLowerCase().includes(q.toLowerCase())
    || productMatchesBarcode(p, q)
    || productMatchesCatalog(p, findBarcodeCatalogEntry(data, q))
  )).slice(0, 6);

  const selectScannedTransferProduct = (value) => {
    const barcode = normalizeBarcode(value);
    if (!barcode) return false;
    const direct = findProductByBarcode(data, barcode, fromB);
    const directKey = direct ? productDedupeKey(direct) : "";
    const catalogEntry = findBarcodeCatalogEntry(data, barcode);
    const match = sourceProducts.find((candidate) =>
      (directKey && productDedupeKey(candidate) === directKey)
      || productMatchesBarcode(candidate, barcode)
      || productMatchesCatalog(candidate, catalogEntry)
    );
    if (!match) {
      setProductId("");
      setQ(barcode);
      setTransferScanMessage("Barcode not found at " + bn(fromB) + ": " + barcode + ".");
      appendBarcodeScanLog({ barcode, status: "transfer:not_found", branchId: fromB });
      return false;
    }
    setProductId(match.id);
    setQ("");
    setErr("");
    setTransferScanMessage("Selected " + match.name + " from " + bn(fromB) + ".");
    appendBarcodeScanLog({ barcode, status: "transfer:found", productId: match.id, branchId: fromB });
    window.setTimeout(() => transferQtyRef.current?.focus(), 0);
    return true;
  };

  useBarcodeScanner({
    enabled: transferScannerOn && !cameraOpen,
    mode: "stock-transfer",
    onScan: selectScannedTransferProduct,
  });

  const addLine = () => {
    setErr("");
    if (!product) return setErr("Search and select a product to add.");
    if (fromB === toB) return setErr("Source and destination branches must be different.");
    const n = parseInt(qty, 10);
    if (!n || n <= 0) return setErr("Enter a quantity greater than zero.");
    if (n > available) return setErr("Insufficient stock at " + bn(fromB) + " — only " + available + " available (after items already added).");
    const sourceCostCents = branchInventoryCostCents(data, product, fromB);
    if (sourceCostCents <= 0) return setErr("This product has no purchase cost at " + bn(fromB) + ". Receive or correct its purchase before transferring it.");
    setLines((ls) => { const i = ls.findIndex((l) => l.productId === product.id); if (i >= 0) { const cp = ls.slice(); cp[i] = { ...cp[i], qty: cp[i].qty + n, costCents: sourceCostCents }; return cp; } return [...ls, { productId: product.id, productName: product.name, sku: product.sku, qty: n, costCents: sourceCostCents }]; });
    setQty(""); setProductId(""); setQ("");
  };
  const removeLine = (pid) => setLines((ls) => ls.filter((l) => l.productId !== pid));

  const transferNeedsCostRepair = (transfer) => normalizedTransferItems(transfer, data.products).some((item) => !(Number(item.costCents) > 0));
  const repairPreview = repairTransfer ? normalizedTransferItems(repairTransfer, data.products).map((item) => {
    const currentProduct = data.products.find((p) => p.id === item.productId);
    return {
      ...item,
      productName: item.productName || currentProduct?.name || "Unknown product",
      sourceCostCents: currentProduct ? branchInventoryCostCents(data, currentProduct, repairTransfer.fromBranchId) : 0,
    };
  }) : [];
  const repairBlocked = repairPreview.some((item) => !(item.sourceCostCents > 0));
  const applyLegacyCostRepair = () => {
    if (!repairTransfer || repairBlocked) return;
    const repairedAt = now();
    update((d) => {
      let products = [...d.products];
      const repairedItems = normalizedTransferItems(repairTransfer, d.products).map((item) => {
        const productIndex = products.findIndex((p) => p.id === item.productId);
        const currentProduct = productIndex >= 0 ? products[productIndex] : null;
        const workingData = { ...d, products };
        const sourceCostCents = currentProduct ? branchInventoryCostCents(workingData, currentProduct, repairTransfer.fromBranchId) : 0;
        const destinationCostCents = currentProduct ? branchInventoryCostCents(workingData, currentProduct, repairTransfer.toBranchId) : 0;
        if (currentProduct && sourceCostCents > 0) {
          products = withBranchProductCostForKey(
            products,
            currentProduct,
            repairTransfer.toBranchId,
            destinationCostCents || sourceCostCents
          );
        }
        const costCents = Number(item.costCents) > 0 ? Number(item.costCents) : sourceCostCents;
        return { ...item, costCents, valueCents: Math.max(0, Number(item.qty) || 0) * costCents };
      });
      const repairedValue = repairedItems.reduce((sum, item) => sum + (Number(item.valueCents) || 0), 0);
      return {
        ...d,
        products,
        borrowings: d.borrowings.map((transfer) => transfer.id === repairTransfer.id ? {
          ...transfer,
          items: repairedItems,
          valueCents: repairedValue,
          costRepairedAt: repairedAt,
          synced: false,
        } : transfer),
        auditLogs: [...(d.auditLogs || []), {
          id: uid("audit"), action: "legacy_transfer_cost_repaired",
          transferId: repairTransfer.id, transferNumber: repairTransfer.number,
          fromBranchId: repairTransfer.fromBranchId, toBranchId: repairTransfer.toBranchId,
          valueCents: repairedValue, ts: repairedAt,
        }],
      };
    });
    setRepairTransfer(null);
  };

  const saveAll = () => {
    setErr("");
    if (fromB === toB) return setErr("Source and destination branches must be different.");
    if (lines.length === 0) return setErr("Add at least one product to the transfer.");
    const ts = now();
    update((d) => {
      const number = nextTransferNumber(d.borrowings);
      const transferId = uid("trf");
      let products = [...d.products];
      const movements = [];
      const transferItems = lines.map((l) => {
        const productIndex = products.findIndex((p) => p.id === l.productId);
        const currentProduct = productIndex >= 0 ? products[productIndex] : null;
        const workingData = { ...d, products };
        const sourceCostCents = currentProduct ? branchInventoryCostCents(workingData, currentProduct, fromB) : Math.max(0, Number(l.costCents) || 0);
        const destinationQty = currentProduct ? Math.max(0, productOnHand(workingData, currentProduct, toB)) : Math.max(0, onHand(workingData, l.productId, toB));
        const destinationCostCents = currentProduct ? branchInventoryCostCents(workingData, currentProduct, toB) : 0;
        const destinationMovingAverageCents = sourceCostCents > 0
          ? wacCost(destinationQty, destinationCostCents || sourceCostCents, l.qty, sourceCostCents)
          : destinationCostCents;

        if (currentProduct && sourceCostCents > 0) {
          products = withBranchProductCostForKey(products, currentProduct, toB, destinationMovingAverageCents);
        }

        movements.push({ id: uid("mv"), transferId, productId: l.productId, branchId: fromB, qty: -l.qty, costCents: sourceCostCents, transferNumber: number, reason: "Transfer to " + bn(toB) + " (" + number + ")", ts, synced: false });
        movements.push({ id: uid("mv"), transferId, productId: l.productId, branchId: toB, qty: l.qty, costCents: sourceCostCents, transferNumber: number, reason: "Transfer from " + bn(fromB) + " (" + number + ")", ts, synced: false });
        return { productId: l.productId, productName: l.productName, sku: l.sku, qty: l.qty, costCents: sourceCostCents, valueCents: l.qty * sourceCostCents };
      });
      const tr = {
        id: transferId, number, fromBranchId: fromB, toBranchId: toB, note: note.trim(), status: "completed", ts, synced: false,
        items: transferItems,
        productName: lines.length === 1 ? lines[0].productName : lines.length + " products",
        qty: lines.reduce((s, l) => s + l.qty, 0),
        valueCents: transferItems.reduce((sum, item) => sum + item.valueCents, 0),
      };
      return { ...d, products, borrowings: [tr, ...d.borrowings], stockMovements: [...d.stockMovements, ...movements] };
    });
    setLines([]); setQty(""); setNote(""); setProductId(""); setQ("");
  };

  const totalUnits = lines.reduce((s, l) => s + l.qty, 0);

  return (
    <div>
      <PageHead title="Move Stock Between Shops" sub="Stock Borrowing / Branch Transfer" />
      <div className="xferinfo">
        <strong>This is a branch transfer, not a sale.</strong>
        <div className="sub" style={{ marginTop: 4 }}>It reduces stock at the source branch and adds it to the destination branch.</div>
        <div className="sub" style={{ marginTop: 2 }}>Add as many products as you need, then save them as one transfer.</div>
      </div>
      <div className="addpanel">
        <div className="grid2">
          <div><label className="label">From branch</label>
            <select className="select" value={fromB} onChange={(e) => { setFromB(e.target.value); setProductId(""); setQ(""); setTransferScanMessage(""); setErr(""); }}>{data.branches.map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}</select></div>
          <div><label className="label">To branch</label>
            <select className="select" value={toB} onChange={(e) => { setToB(e.target.value); setErr(""); }}>{data.branches.map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}</select></div>
        </div>
        <div className="field"><label className="label">Product search</label>
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
            <input ref={transferSearchRef} className="input" placeholder="Search name, SKU, or scan barcode" value={product ? product.name + " · " + product.sku : q}
              onChange={(e) => { setProductId(""); setQ(e.target.value); setTransferScanMessage(""); setErr(""); }}
              onKeyDown={(event) => {
                if (event.key !== "Enter" && event.key !== "Tab") return;
                const value = event.currentTarget.value;
                if (!isValidBarcode(normalizeBarcode(value))) return;
                event.preventDefault();
                selectScannedTransferProduct(value);
              }} />
            <button
              type="button"
              className={"btn sm " + (transferScannerOn ? "primary" : "btn-ghost")}
              onClick={() => {
                const next = !transferScannerOn;
                setTransferScannerOn(next);
                setTransferScanMessage(next ? "Scanner ready for " + bn(fromB) + "." : "Scanner off.");
                if (next) window.setTimeout(() => transferSearchRef.current?.focus(), 0);
              }}
              aria-pressed={transferScannerOn}
              title="Scan a product barcode for this stock transfer"
            >
              <Barcode size={17} /> {transferScannerOn ? "USB on" : "USB scanner"}
            </button>
            <button type="button" className="btn sm btn-ghost" onClick={() => setCameraOpen(true)}><Camera size={17} /> Camera scan</button>
          </div>
          {transferScanMessage ? <div className="sub" role="status" style={{ marginTop: 6, color: transferScannerOn ? "var(--ok)" : "var(--muted)" }}>{transferScanMessage}</div> : null}
          {!productId && matches.length > 0 && (
            <div className="searchres">{matches.map((p) => (
              <button key={p.id} className="sres" onClick={() => { setProductId(p.id); setQ(""); }}>
                <span>{p.name} <span style={{ color: "var(--muted-2)" }}>· {p.sku}</span></span>
                <span style={{ color: "var(--muted)", fontFamily: "var(--font-mono)", fontSize: 12 }}>{productOnHand(data, p, fromB) - pendingQty(p.id)} @ {bn(fromB)}</span>
              </button>))}
            </div>
          )}
        </div>
        <div className="grid2">
          <div><label className="label">Available stock</label>
            <input className="input" readOnly value={product ? available : ""} placeholder="—" style={{ fontFamily: "var(--font-mono)", color: product && available <= 0 ? "var(--danger)" : "var(--text)" }} /></div>
          <div><label className="label">Quantity to transfer</label>
            <input ref={transferQtyRef} className="input" inputMode="numeric" value={qty} onChange={(e) => { setQty(e.target.value.replace(/\D/g, "")); setErr(""); }} placeholder="0" /></div>
        </div>
        {err && <div className="alert"><AlertCircle />{err}</div>}
        <button className="btn btn-ghost" style={{ marginTop: 14 }} onClick={addLine}><Plus /> Add to transfer</button>

        {lines.length > 0 && (
          <div className="tablewrap" style={{ marginTop: 14 }}>
            <table className="tbl"><thead><tr><th>Product</th><th style={{ textAlign: "right" }}>Purchase cost</th><th style={{ textAlign: "right" }}>Qty</th><th /></tr></thead>
              <tbody>{lines.map((l) => (<tr key={l.productId}>
                <td><div className="nm">{l.productName}</div><div className="mt2">{l.sku}</div></td>
                <td style={{ textAlign: "right", fontFamily: "var(--font-mono)" }}>{fmt(l.costCents, data.settings.currency)}</td>
                <td style={{ textAlign: "right", fontWeight: 700 }}>{l.qty}</td>
                <td><button className="smdel" onClick={() => removeLine(l.productId)}><Trash2 /></button></td>
              </tr>))}</tbody></table>
          </div>
        )}
        <div className="field" style={{ marginTop: 14 }}><label className="label">Transfer notes</label>
          <input className="input" placeholder="Reason or reference (applies to whole transfer)" value={note} onChange={(e) => setNote(e.target.value)} /></div>
        <button className="btn btn-primary" style={{ marginTop: 6 }} disabled={lines.length === 0} onClick={saveAll}><ArrowLeftRight /> Save transfer ({lines.length} item{lines.length === 1 ? "" : "s"}{totalUnits ? " · " + totalUnits + " units" : ""})</button>
      </div>

      <DocumentFile title="Transfer records" count={data.borrowings.length} meta="Completed branch stock movements">
      <div className="list">{data.borrowings.map((t) => { const items = normalizedTransferItems(t, data.products); const units = transferUnitCount(t, data.products);
        return (
        <div className="row" key={t.id}>
          <div className="meta"><div className="nm" style={{ fontFamily: "var(--font-mono)", fontSize: 13 }}>{t.number}</div>
            <div className="mt2">{bn(t.fromBranchId)} → {bn(t.toBranchId)} · {items.map((item) => item.productName + " × " + item.qty).join(", ")}{items.length > 1 ? " · " + units + " units total" : ""}{t.note ? " · " + t.note : ""}</div></div>
          {transferNeedsCostRepair(t) && <button className="btn xs btn-ghost" onClick={() => setRepairTransfer(t)}><Wrench /> Repair cost</button>}
          <span className="ist paid">{t.status || "completed"}</span>
          <span className="pill plain">{dt(t.ts)}</span>
        </div>); })}
        {data.borrowings.length === 0 && <div className="notice">No transfers yet.</div>}</div>
      </DocumentFile>

      {cameraOpen && (
        <CameraBarcodeScanner
          eyebrow="Stock transfer"
          title={"Select product from " + bn(fromB)}
          onClose={() => setCameraOpen(false)}
          onScan={selectScannedTransferProduct}
        />
      )}
      {repairTransfer && (
        <div className="scrim" onClick={() => setRepairTransfer(null)}>
          <div className="modal" style={{ maxWidth: 520 }} onClick={(e) => e.stopPropagation()}>
            <div className="modal-head">
              <div><div className="sub" style={{ margin: 0 }}>Legacy transfer</div><div className="title" style={{ fontSize: 19 }}>Repair purchase cost</div></div>
              <button className="iconbtn" onClick={() => setRepairTransfer(null)}><X /></button>
            </div>
            <div className="notice" style={{ marginTop: 8 }}>This copies the current purchase cost from {bn(repairTransfer.fromBranchId)} to missing cost fields in {bn(repairTransfer.toBranchId)}. Stock quantities and selling prices will not change.</div>
            <div className="list" style={{ marginTop: 12 }}>{repairPreview.map((item, index) => (
              <div className="row" key={item.productId || index}>
                <div className="meta"><div className="nm">{item.productName}</div><div className="mt2">{item.qty || 0} unit(s)</div></div>
                <span className="pill plain" style={{ color: item.sourceCostCents > 0 ? "var(--text)" : "var(--danger)" }}>{item.sourceCostCents > 0 ? fmt(item.sourceCostCents, data.settings.currency) : "Missing source cost"}</span>
              </div>
            ))}</div>
            {repairBlocked && <div className="alert" style={{ marginTop: 12 }}><AlertCircle />Receive or correct the source purchase cost before repairing this transfer.</div>}
            <div style={{ display: "flex", gap: 10, marginTop: 16 }}>
              <button className="btn btn-ghost" onClick={() => setRepairTransfer(null)}>Cancel</button>
              <button className="btn btn-primary" disabled={repairBlocked} onClick={applyLegacyCostRepair}><Wrench /> Apply purchase cost</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
function PricingTab({ data, update, branch }) {
  const cur = data.settings.currency;
  const [bId, setBId] = useState(branch.id);
  const [q, setQ] = useState("");
  const [priceDrafts, setPriceDrafts] = useState({});
  const [priceErr, setPriceErr] = useState("");
  const [cameraOpen, setCameraOpen] = useState(false);
  const [scannerOn, setScannerOn] = useState(false);
  const [scanMessage, setScanMessage] = useState("");
  const [scannedPricingKey, setScannedPricingKey] = useState("");
  const priceInputRefs = useRef(new Map());
  useEffect(() => {
    setBId(branch.id);
    setQ("");
    setScannedPricingKey("");
    setScanMessage("");
  }, [branch.id]);
  const bname = data.branches.find((b) => b.id === bId)?.name || "branch";
  const query = q.trim().toLowerCase();
  const pricingKey = (p) => {
    const catalogId = barcodeCatalogIdsForProduct(p)[0];
    if (catalogId) return "catalog:" + catalogId;
    const sku = normalizeBarcode(p.sku).toLowerCase();
    if (sku) return "sku:" + sku;
    const barcode = normalizeBarcode(p.barcode).toLowerCase();
    if (barcode) return "barcode:" + barcode;
    return "product:" + p.id;
  };
  const preferPricingRow = (current, candidate) => {
    if (!current) return candidate;
    const currentPrice = branchProductPriceCents(current, bId);
    const candidatePrice = branchProductPriceCents(candidate, bId);
    if (candidatePrice > 0 && !currentPrice) return candidate;
    if (!candidatePrice && currentPrice > 0) return current;
    if ((candidate.updatedAt || 0) > (current.updatedAt || 0)) return candidate;
    return current;
  };
  const dedupePricingProducts = (products) => {
    const byKey = new Map();
    products.forEach((p) => byKey.set(pricingKey(p), preferPricingRow(byKey.get(pricingKey(p)), p)));
    return sortProductsAZ(Array.from(byKey.values()));
  };
  const allPricingProducts = dedupePricingProducts(data.products.filter((p) => productVisibleInBranch(p, data, bId)));
  const list = allPricingProducts.filter((p) => scannedPricingKey
    ? pricingKey(p) === scannedPricingKey
    : query === "" || p.name.toLowerCase().includes(query) || p.sku.toLowerCase().includes(query) || productMatchesBarcode(p, query) || productMatchesCatalog(p, findBarcodeCatalogEntry(data, query))
  );
  const selectScannedPricingProduct = (value) => {
    const barcode = normalizeBarcode(value);
    if (!isValidBarcode(barcode)) {
      setScanMessage("Invalid barcode. Try again or type the product name.");
      appendBarcodeScanLog({ barcode, status: "pricing:invalid" });
      return false;
    }
    const direct = findProductByBarcode(data, barcode, bId);
    const catalogEntry = findBarcodeCatalogEntry(data, barcode);
    const match = allPricingProducts.find((candidate) =>
      (direct && productDedupeKey(candidate) === productDedupeKey(direct)) ||
      productMatchesBarcode(candidate, barcode) ||
      productMatchesCatalog(candidate, catalogEntry)
    );
    if (!match) {
      setScannedPricingKey("");
      setQ(barcode);
      setScanMessage("Barcode not found for " + bname + ".");
      appendBarcodeScanLog({ barcode, status: "pricing:not_found" });
      return false;
    }
    setQ("");
    setScannedPricingKey(pricingKey(match));
    setPriceErr("");
    setScanMessage("Selected " + match.name + " for pricing.");
    appendBarcodeScanLog({ barcode, productId: match.id, status: "pricing:matched" });
    window.setTimeout(() => {
      const input = priceInputRefs.current.get(match.id);
      input?.focus();
      input?.select();
    }, 0);
    return true;
  };
  useBarcodeScanner({ enabled: scannerOn && !cameraOpen, mode: "pricing", onScan: selectScannedPricingProduct });
  const draftFor = (p) => {
    const price = branchProductPriceCents(p, bId);
    return priceDrafts[p.id] ?? (price > 0 ? String(price / 100) : "");
  };
  const savePrice = (p) => {
    const raw = draftFor(p).trim();
    const price = Math.round((parseFloat(raw) || 0) * 100);
    if (!price || price <= 0) return setPriceErr("Enter a valid selling price for " + p.name + ".");
    const cost = branchInventoryCostCents(data, p, bId);
    if (price < cost) return setPriceErr("Selling price for " + p.name + " cannot be below cost.");
    setPriceErr("");
    setPriceDrafts((drafts) => {
      const { [p.id]: _saved, ...rest } = drafts;
      return rest;
    });
    update((d) => ({
      ...d,
      products: d.products.map((x) => pricingKey(x) === pricingKey(p) ? withBranchProductPrice(x, bId, price) : x)
    }));
  };
  return (
    <div>
      <PageHead title="Branch Pricing" sub="Edit selling prices by branch." />
      <div className="xferinfo" style={{ marginBottom: 14 }}>
        <strong>Selling prices are editable here.</strong>
        <div className="sub" style={{ marginTop: 4 }}>Type a new selling price and press Enter, or leave the field to save. Prices below cost are blocked.</div>
      </div>
      {priceErr && <div className="alert error" style={{ marginBottom: 12 }}>{priceErr}</div>}
      <div className="repctrl" style={{ marginBottom: 16 }}>
        <div><label className="label">Select branch</label>
          <select className="select" style={{ minWidth: 220 }} value={bId} onChange={(e) => { setBId(e.target.value); setQ(""); setScannedPricingKey(""); setScanMessage(""); }}>{data.branches.map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}</select></div>
        <div style={{ flex: 1, minWidth: 220 }}><label className="label">Search products</label>
          <input className="input" placeholder="Filter product name or SKU" value={q} onChange={(e) => { setQ(e.target.value); setScannedPricingKey(""); setScanMessage(""); }} /></div>
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignSelf: "end" }}>
          <button type="button" className={"btn sm " + (scannerOn ? "primary" : "btn-ghost")} onClick={() => { const next = !scannerOn; setScannerOn(next); setScanMessage(next ? "USB scanner ready for " + bname + "." : "Scanner off."); }} aria-pressed={scannerOn} title="Use a USB barcode scanner to select a product"><Barcode size={17} /> {scannerOn ? "USB on" : "USB scanner"}</button>
          <button type="button" className="btn sm btn-ghost" onClick={() => setCameraOpen(true)}><Camera size={17} /> Camera scan</button>
        </div>
      </div>
      {scanMessage ? <div className="sub" role="status" style={{ margin: "-8px 0 12px", color: scanMessage.startsWith("Selected") || scannerOn ? "var(--ok)" : "var(--muted)" }}>{scanMessage}</div> : null}
      <div className="tablewrap tblscroll"><table className="tbl"><thead><tr><th>Product</th><th>Cost</th><th>Selling Price</th><th>Margin</th><th>Markup</th></tr></thead>
        <tbody>{list.map((p) => {
          const price = branchProductPriceCents(p, bId); const cost = branchInventoryCostCents(data, p, bId);
          const margin = price > 0 ? Math.round((price - cost) / price * 100) : null;
          const markup = cost > 0 ? Math.round((price - cost) / cost * 100) : null;
          return (<tr key={p.id}>
            <td><div className="nm">{p.name}</div><div className="mt2">{p.sku}</div></td>
            <td className="amt">{fmt(cost, cur)}</td>
            <td className="amt">
              <input
                ref={(node) => { if (node) priceInputRefs.current.set(p.id, node); else priceInputRefs.current.delete(p.id); }}
                className="input"
                style={{ width: 130, height: 38, textAlign: "right", fontFamily: "var(--font-mono)" }}
                inputMode="decimal"
                value={draftFor(p)}
                onChange={(e) => { setPriceErr(""); setPriceDrafts((drafts) => ({ ...drafts, [p.id]: e.target.value.replace(/[^\d.]/g, "") })); }}
                onBlur={() => savePrice(p)}
                onKeyDown={(e) => { if (e.key === "Enter") e.currentTarget.blur(); }}
                aria-label={"Selling price for " + p.name}
              />
            </td>
            <td style={{ color: margin != null && margin < 0 ? "var(--danger)" : "var(--text)", fontWeight: 650 }}>{margin == null ? "—" : margin + "%"}</td>
            <td style={{ color: markup != null && markup < 0 ? "var(--danger)" : "var(--text)", fontWeight: 650 }}>{markup == null ? "—" : markup + "%"}</td>
          </tr>);
        })}
        {list.length === 0 && <tr><td colSpan="5"><div className="notice">No products match for {bname}.</div></td></tr>}</tbody></table></div>
      {cameraOpen && (
        <CameraBarcodeScanner
          eyebrow="Pricing"
          title={"Select product - " + bname}
          onClose={() => setCameraOpen(false)}
          onScan={selectScannedPricingProduct}
        />
      )}
    </div>
  );
}

/* ---- Cash / Expenses ---- */
function CashTab({ data, update, branch }) {
  const cur = data.settings.currency;
  const [branchFilter, setBranchFilter] = useState(branch?.id || "all");
  const [dateFrom, setDateFrom] = useState(todayStr());
  const [dateTo, setDateTo] = useState(todayStr());
  useEffect(() => {
    if (branch?.id) setBranchFilter(branch.id);
  }, [branch?.id]);
  const invoiceById = Object.fromEntries((data.invoices || []).map((invoice) => [invoice.id, invoice]));
  const matchesBranch = (branchId) => branchFilter === "all" || branchId === branchFilter;
  const rangeStart = new Date(`${dateFrom}T00:00:00`).getTime();
  const rangeEnd = new Date(`${dateTo}T23:59:59.999`).getTime();
  const recordTs = (...values) => {
    for (const value of values) {
      if (value == null || value === "") continue;
      const text = String(value).trim();
      const numeric = Number(text);
      if (Number.isFinite(numeric)) {
        if (numeric > 0) return numeric;
        continue;
      }
      const parsed = Date.parse(text);
      if (Number.isFinite(parsed)) return parsed;
    }
    return 0;
  };
  const inDateRange = (ts) => {
    const value = recordTs(ts);
    return value >= rangeStart && value <= rangeEnd;
  };
  const paymentBranchId = (payment) => payment.branchId || invoiceById[paymentInvoiceId(payment)]?.branchId;
  const paymentTs = (payment) => recordTs(payment?.ts, payment?.createdAt, payment?.updatedAt, payment?.serverTs);
  const allCapturedInvoicePayments = (data.payments || []).filter((payment) => {
    const invoiceId = paymentInvoiceId(payment);
    const status = String(payment?.status || "captured").toLowerCase();
    const amountCents = Number(payment?.amountCents || 0);
    return Boolean(invoiceId && invoiceById[invoiceId])
      && status === "captured"
      && Number.isFinite(amountCents)
      && amountCents > 0
      && !invoiceIsVoided(data, invoiceId);
  });
  const rangePays = allCapturedInvoicePayments.filter((payment) => inDateRange(paymentTs(payment)) && matchesBranch(paymentBranchId(payment)));
  const sumM = (re) => rangePays.filter((p) => re.test(p.method || "")).reduce((s, p) => s + Number(p.amountCents || 0), 0);
  const mpesa = sumM(/mpesa|m-?pesa|mobile/i);
  const cash = sumM(/cash/i);
  const paymentsReceived = rangePays.reduce((sum, payment) => sum + Number(payment.amountCents || 0), 0);
  const otherPayments = Math.max(0, paymentsReceived - cash - mpesa);
  const rangeInvoices = operationalInvoices(data).filter((i) => inDateRange(i.ts) && matchesBranch(i.branchId));
  const periodSales = rangeInvoices.reduce((s, i) => s + Number(i.totalCents || 0), 0);
  const outstanding = rangeInvoices.reduce((s, i) => s + invOutstanding(i), 0);
  const settledSales = Math.max(0, periodSales - outstanding);
  const rangeInvoiceIds = new Set(rangeInvoices.map((invoice) => invoice.id));
  const recordedSettlements = allCapturedInvoicePayments
    .filter((payment) => rangeInvoiceIds.has(paymentInvoiceId(payment)))
    .reduce((sum, payment) => sum + Number(payment.amountCents || 0), 0);
  const settlementRecordGap = Math.max(0, settledSales - recordedSettlements);
  const periodExpenses = data.expenses.filter((e) => (!e.status || e.status === "approved") && inDateRange(e.ts) && matchesBranch(e.branchId)).reduce((s, e) => s + Number(e.amountCents || 0), 0);
  const netRecordedInflow = paymentsReceived - periodExpenses;
  const bname = (id) => data.branches.find((b) => b.id === id)?.name || "—";
  const tile = (cls, icon, label, value, sub) => (
    <div className={"ctile" + (cls ? " " + cls : "")}><div className="ic">{icon}</div>
      <div><div className="cl">{label}</div><div className="cv">{value}</div>{sub && <div className="cs">{sub}</div>}</div></div>
  );
  const eodTs = (entry) => recordTs(entry?.ts, entry?.closedAt, entry?.periodEndedAt);
  const eods = [...(data.endOfDays || [])].filter((entry) => matchesBranch(entry.branchId) && inDateRange(eodTs(entry))).sort((a, b) => eodTs(b) - eodTs(a)).slice(0, 6);
  const selectedBranchName = branchFilter === "all" ? "All branches" : bname(branchFilter);
  const rangeLabel = dateFrom === dateTo
    ? (dateFrom === todayStr() ? "Today" : new Date(`${dateFrom}T00:00:00`).toLocaleDateString())
    : `${new Date(`${dateFrom}T00:00:00`).toLocaleDateString()} - ${new Date(`${dateTo}T00:00:00`).toLocaleDateString()}`;
  return (
    <div className="cash-page"><PageHead
      title="Cash Management"
      sub={`${rangeLabel} money flow and closings · ${selectedBranchName}`}
    />
      <div className="repctrl" style={{ marginBottom: 16 }}>
        <div>
          <label className="label" htmlFor="cash-branch-filter">Branch</label>
          <select id="cash-branch-filter" className="select" style={{ width: 190 }} value={branchFilter} onChange={(event) => setBranchFilter(event.target.value)}>
            <option value="all">All branches</option>
            {(data.branches || []).map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}
          </select>
        </div>
        <div>
          <label className="label" htmlFor="cash-date-from">From</label>
          <input id="cash-date-from" className="input" type="date" style={{ width: 160, height: 38 }} value={dateFrom} max={dateTo} onChange={(event) => setDateFrom(event.target.value)} />
        </div>
        <div>
          <label className="label" htmlFor="cash-date-to">To</label>
          <input id="cash-date-to" className="input" type="date" style={{ width: 160, height: 38 }} value={dateTo} min={dateFrom} max={todayStr()} onChange={(event) => setDateTo(event.target.value)} />
        </div>
        {(dateFrom !== todayStr() || dateTo !== todayStr()) ? <button className="btn sm" type="button" onClick={() => { setDateFrom(todayStr()); setDateTo(todayStr()); }}>Today</button> : null}
      </div>
      <div className="cashtiles">
        {tile("primary", <Wallet />, "Invoice payments received", fmt(paymentsReceived, cur), rangePays.length + " payment record" + (rangePays.length === 1 ? "" : "s"))}
        {tile("", <Banknote />, "Cash received", fmt(cash, cur), "Captured cash payments")}
        {tile("", <Smartphone />, "M-Pesa received", fmt(mpesa, cur), "Captured M-Pesa payments")}
        {tile("", <CreditCard />, "Other received", fmt(otherPayments, cur), "Other recorded methods")}
        {tile("warn", <TrendingDown />, "Approved expenses", fmt(periodExpenses, cur), rangeLabel)}
        {tile(netRecordedInflow >= 0 ? "good" : "warn", <BarChart3 />, "Net recorded inflow", fmt(netRecordedInflow, cur), "Invoice payments − approved expenses")}
        {tile("", <Receipt />, "Invoice sales issued", fmt(periodSales, cur), rangeInvoices.length + " invoice" + (rangeInvoices.length === 1 ? "" : "s"))}
        {tile(outstanding > 0 ? "warn" : "", <FileText />, "Current outstanding", fmt(outstanding, cur), "Balance on invoices issued in range")}
      </div>
      <div className="cash-reconcile">
        <div className="cash-equation"><span>Recorded invoice money flow</span><b>{fmt(paymentsReceived, cur)} − {fmt(periodExpenses, cur)} = {fmt(netRecordedInflow, cur)}</b></div>
        <div className="cash-equation"><span>Invoice balance</span><b>{fmt(periodSales, cur)} − {fmt(outstanding, cur)} = {fmt(settledSales, cur)} settled</b></div>
      </div>
      {settlementRecordGap > 0 ? (
        <div className="notice cash-ledger-warning"><AlertCircle /> {fmt(settlementRecordGap, cur)} of settled invoice value has no matching payment-method record. It remains settled on the invoices but cannot be assigned reliably to Cash or M-Pesa.</div>
      ) : null}

      <div className="section-title" style={{ margin: "4px 0 10px" }}>Recent end-of-day closings</div>
      {eods.length === 0 ? <div className="notice">No end-of-day closings saved yet.</div> : (
        <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>{eods.map((e) => (
          <div className="eodrow" key={e.id}><div className="avatar"><Wallet style={{ width: 17, height: 17 }} /></div>
            <div className="meta"><div className="nm">{dt(eodTs(e))} · {bname(e.branchId)}</div><div className="mt2">{e.cashier || e.closedBy || "—"} · {(e.transactions ?? e.txns ?? e.invoiceCount ?? "—")} txns</div></div>
            <span className="pill plain">{fmt(e.totalCents ?? e.totalSalesCents ?? 0, cur)}</span></div>))}
        </div>
      )}
    </div>
  );
}
function ExpensesTab({ data, update, branch, user }) {
  const cur = data.settings.currency;
  const allExpenseCategories = expenseCategories(data);
  const recordExpenseCategories = adminExpenseCategories(data);
  const defaultCategoryId = recordExpenseCategories[0]?.id || "excat_other";
  const [f, setF] = useState({ categoryId: defaultCategoryId, amount: "", note: "", branchId: branch.id });
  const [period, setPeriod] = useState("30d");
  const [rb, setRb] = useState("all");
  const [rejecting, setRejecting] = useState(null);
  const [rejectReason, setRejectReason] = useState("");
  const [catForm, setCatForm] = useState({ name: "", icon: "wallet" });
  const [editingCat, setEditingCat] = useState(null);
  const [view, setView] = useState("overview");
  const [showRecordExpense, setShowRecordExpense] = useState(false);
  const [showCategoryManager, setShowCategoryManager] = useState(false);
  const [fromD, setFromD] = useState(todayStr()); const [toD, setToD] = useState(todayStr());
  const bname = (id) => data.branches.find((b) => b.id === id)?.name || "—";
  const dayStart = (s) => new Date(s + "T00:00:00").getTime(); const dayEnd = (s) => new Date(s + "T23:59:59.999").getTime();
  const sinceFor = period === "custom" ? dayStart(fromD) : { today: new Date().setHours(0, 0, 0, 0), "7d": Date.now() - 7 * 864e5, "30d": Date.now() - 30 * 864e5, all: 0 }[period];
  const untilFor = period === "custom" ? dayEnd(toD) : Infinity;
  const inRange = (ts) => ts >= sinceFor && ts <= untilFor;
  const inBranch = (bid) => rb === "all" || bid === rb;
  const isPending = (e) => e.status === "pending";
  const isApproved = (e) => !e.status || e.status === "approved";
  const isRejected = (e) => e.status === "rejected";
  const actor = () => user?.name || data.admin?.name || "Admin";
  const cashierOf = (e) => e.cashierName || e.enteredBy || e.cashier || "Cashier";
  const sourceOf = (e) => e.source || e.paymentSource || e.method || "Cash till";
  const categoryAudit = (action, category, extra = {}) => ({ id: uid("audit"), action, categoryId: category.id, categoryName: category.name, actor: actor(), ts: now(), ...extra });
  const saveCategoryList = (categories, auditEntry) => update((d) => ({
    ...d,
    expenseCategories: categories.map((cat, idx) => ({ ...normalizeExpenseCategory(cat, idx), order: idx * 10, updatedAt: now(), synced: false })),
    auditLogs: auditEntry ? [...(d.auditLogs || []), auditEntry] : (d.auditLogs || []),
  }));
  const addCategory = () => {
    const name = catForm.name.trim();
    if (!name) return;
    if (allExpenseCategories.some((cat) => cat.name.toLowerCase() === name.toLowerCase())) return;
    const nextCat = { id: uid("excat"), name, icon: catForm.icon || "wallet", active: true, order: allExpenseCategories.length * 10, updatedAt: now(), synced: false };
    saveCategoryList([...allExpenseCategories, nextCat], categoryAudit("expense_category_added", nextCat));
    setCatForm({ name: "", icon: "wallet" });
  };
  const startEditCategory = (cat) => {
    setEditingCat({ id: cat.id, name: cat.name, icon: cat.icon || "wallet" });
    setCatForm({ name: "", icon: "wallet" });
  };
  const saveCategoryEdit = () => {
    const name = editingCat?.name?.trim();
    if (!editingCat || !name) return;
    if (allExpenseCategories.some((cat) => cat.id !== editingCat.id && cat.name.toLowerCase() === name.toLowerCase())) return;
    const categories = allExpenseCategories.map((cat) => cat.id === editingCat.id ? { ...cat, name, icon: editingCat.icon || "wallet", updatedAt: now(), synced: false } : cat);
    const changed = categories.find((cat) => cat.id === editingCat.id);
    saveCategoryList(categories, categoryAudit("expense_category_renamed", changed));
    setEditingCat(null);
  };
  const toggleCategory = (cat) => {
    const categories = allExpenseCategories.map((item) => item.id === cat.id ? { ...item, active: item.active === false, updatedAt: now(), synced: false } : item);
    saveCategoryList(categories, categoryAudit(cat.active === false ? "expense_category_activated" : "expense_category_deactivated", { ...cat, active: cat.active === false }));
  };
  const moveCategory = (cat, direction) => {
    const idx = allExpenseCategories.findIndex((item) => item.id === cat.id);
    const target = idx + direction;
    if (idx < 0 || target < 0 || target >= allExpenseCategories.length) return;
    const categories = [...allExpenseCategories];
    [categories[idx], categories[target]] = [categories[target], categories[idx]];
    saveCategoryList(categories, categoryAudit("expense_category_reordered", cat, { direction }));
  };
  const approved = data.expenses.filter(isApproved);
  const pending = data.expenses.filter(isPending);
  const visiblePending = pending.filter((e) => inBranch(e.branchId));
  const periodApproved = approved.filter((e) => inRange(e.ts) && inBranch(e.branchId));
  const history = data.expenses.filter((e) => !isPending(e) && inRange(e.decidedAt || e.approvedAt || e.rejectedAt || e.ts) && inBranch(e.branchId))
    .sort((a, b) => (b.decidedAt || b.approvedAt || b.rejectedAt || b.ts || 0) - (a.decidedAt || a.approvedAt || a.rejectedAt || a.ts || 0));
  const total = periodApproved.reduce((s, e) => s + e.amountCents, 0);
  const pendingTotal = visiblePending.reduce((s, e) => s + e.amountCents, 0);
  const add = () => { const amt = Math.round(parseFloat(f.amount) * 100); if (!amt || amt <= 0) return;
    const ts = now();
    update((d) => {
      const categories = adminExpenseCategories(d);
      const category = categories.find((item) => item.id === f.categoryId) || categories[0];
      return { ...d, expenses: [...d.expenses, { id: uid("ex"), categoryId: category?.id || f.categoryId, category: category?.name || "Other", amountCents: amt, note: f.note, status: "approved", enteredBy: data.admin?.name || "Admin", branchId: f.branchId || branch.id, date: todayStr(), ts, updatedAt: ts, synced: false }] };
    });
    setF({ categoryId: defaultCategoryId, amount: "", note: "", branchId: f.branchId });
    setShowRecordExpense(false);
  };
  const approve = (id) => { const ts = now(); const by = actor(); update((d) => ({ ...d, expenses: d.expenses.map((e) => e.id === id ? { ...e, status: "approved", decidedBy: by, decidedAt: ts, approvedBy: by, approvedAt: ts, rejectReason: "", updatedAt: ts, synced: false } : e) })); };
  const reject = (id) => {
    const reason = rejectReason.trim(); if (reason.length < 3) return;
    const ts = now(); const by = actor();
    update((d) => ({ ...d, expenses: d.expenses.map((e) => e.id === id ? { ...e, status: "rejected", rejectReason: reason, decidedBy: by, decidedAt: ts, rejectedBy: by, rejectedAt: ts, updatedAt: ts, synced: false } : e) }));
    setRejecting(null); setRejectReason("");
  };
  const groupBars = (keyFn) => { const g = {}; periodApproved.forEach((e) => { const k = keyFn(e); g[k] = (g[k] || 0) + e.amountCents; }); const rows = Object.entries(g).sort((a, b) => b[1] - a[1]); const max = Math.max(1, ...rows.map(([, v]) => v)); return { rows, max }; };
  const byCat = groupBars((e) => e.category || "Other");
  const byCashier = groupBars((e) => e.enteredBy || "Admin");
  const byBranch = groupBars((e) => bname(e.branchId));
  const byMonth = (() => { const g = {}; periodApproved.forEach((e) => { const k = (e.date || new Date(e.ts).toISOString().slice(0, 10)).slice(0, 7); g[k] = (g[k] || 0) + e.amountCents; }); const rows = Object.entries(g).sort((a, b) => (a[0] < b[0] ? -1 : 1)); const max = Math.max(1, ...rows.map(([, v]) => v)); return { rows, max }; })();
  const Bars = ({ data: bd, empty }) => bd.rows.length === 0 ? <div className="dempty">{empty}</div> : (
    <div className="bars">{bd.rows.map(([label, val]) => (<div className="bar-row" key={label}><span className="bl">{label}</span>
      <div className="bar-track"><div className="bar-fill" style={{ width: (val / bd.max * 100) + "%" }} /></div><span className="bv">{fmt(val, cur)}</span></div>))}</div>
  );
  return (
    <div className="expense-page"><PageHead
      title="Expenses"
      sub={`${fmt(total, cur)} approved in the selected period`}
      right={<div className="expense-head-actions">
        <button className={"btn sm " + (showRecordExpense ? "btn-primary" : "btn-ghost")} onClick={() => { setShowRecordExpense((open) => !open); setShowCategoryManager(false); }}><Plus /> Record expense</button>
        <button className={"btn sm " + (showCategoryManager ? "btn-primary" : "btn-ghost")} onClick={() => { setShowCategoryManager((open) => !open); setShowRecordExpense(false); }}><Tags /> Categories</button>
      </div>}
    />
      <div className="expense-tabs" role="tablist" aria-label="Expense views">
        <button type="button" role="tab" aria-selected={view === "overview"} className={"expense-tab" + (view === "overview" ? " on" : "")} onClick={() => setView("overview")}><BarChart3 /> Overview</button>
        <button type="button" role="tab" aria-selected={view === "approvals"} className={"expense-tab" + (view === "approvals" ? " on" : "")} onClick={() => setView("approvals")}><AlertCircle /> Approvals {visiblePending.length > 0 ? <span className="count">{visiblePending.length}</span> : null}</button>
        <button type="button" role="tab" aria-selected={view === "history"} className={"expense-tab" + (view === "history" ? " on" : "")} onClick={() => setView("history")}><Receipt /> History</button>
      </div>
      <div className="expense-filterbar">
        <div className="segbtns">{[["today", "Today"], ["7d", "7 days"], ["30d", "30 days"], ["all", "All time"], ["custom", "Custom"]].map(([k, lbl]) => (
          <button type="button" key={k} className={"seg" + (period === k ? " on" : "")} onClick={() => setPeriod(k)}>{lbl}</button>))}</div>
        {period === "custom" && (
          <div className="expense-custom-range">
            <input aria-label="Expense start date" title="Start date" className="input" type="date" value={fromD} max={toD} onChange={(e) => setFromD(e.target.value)} />
            <input aria-label="Expense end date" title="End date" className="input" type="date" value={toD} min={fromD} max={todayStr()} onChange={(e) => setToD(e.target.value)} />
          </div>
        )}
        <select aria-label="Expense branch" className="select" value={rb} onChange={(e) => setRb(e.target.value)}>
          <option value="all">All branches</option>{data.branches.map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}
        </select>
      </div>
      <div className="expense-summary">
        <div><span>Approved</span><b>{fmt(total, cur)}</b><small>{periodApproved.length} record{periodApproved.length === 1 ? "" : "s"}</small></div>
        <div><span>Categories used</span><b>{byCat.rows.length}</b><small>Selected period</small></div>
        <div><span>Awaiting approval</span><b style={{ color: visiblePending.length ? "var(--danger)" : undefined }}>{fmt(pendingTotal, cur)}</b><small>{visiblePending.length} pending</small></div>
      </div>

      {showRecordExpense && <div className="expense-inline-tool">
        <div className="expense-tool-head"><div><div className="sideh">Record expense</div><div className="muted">Add an approved operational expense.</div></div><button type="button" className="iconbtn" title="Close" aria-label="Close expense form" onClick={() => setShowRecordExpense(false)}><X /></button></div>
        <div className="expense-entry-grid">
          <div><label className="label">Category</label><select className="select" value={f.categoryId} onChange={(e) => setF({ ...f, categoryId: e.target.value })}>{recordExpenseCategories.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}</select></div>
          <div><label className="label">Branch</label><select className="select" value={f.branchId} onChange={(e) => setF({ ...f, branchId: e.target.value })}>{data.branches.map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}</select></div>
          <div><label className="label">Amount ({cur})</label><input className="input" inputMode="decimal" value={f.amount} onChange={(e) => setF({ ...f, amount: e.target.value })} placeholder="2000" /></div>
          <div><label className="label">Note</label><input className="input" value={f.note} onChange={(e) => setF({ ...f, note: e.target.value })} placeholder="Optional" /></div>
          <button type="button" className="btn btn-primary" disabled={!recordExpenseCategories.length || Number(f.amount) <= 0} onClick={add}><Check /> Save</button>
        </div>
      </div>}

      {showCategoryManager && <div className="expense-inline-tool">
        <div className="expense-tool-head">
          <div><div className="sideh">Expense categories</div><div className="muted">Manage the categories available when expenses are recorded.</div></div>
          <button type="button" className="iconbtn" title="Close" aria-label="Close category manager" onClick={() => setShowCategoryManager(false)}><X /></button>
        </div>
        <div className="expense-category-form">
          <div><label className="label">{editingCat ? "Rename category" : "New category"}</label>
            <input className="input" value={editingCat ? editingCat.name : catForm.name} onChange={(e) => editingCat ? setEditingCat({ ...editingCat, name: e.target.value }) : setCatForm({ ...catForm, name: e.target.value })} placeholder="e.g. Repairs" /></div>
          <div><label className="label">Icon</label>
            <select className="select" value={editingCat ? editingCat.icon : catForm.icon} onChange={(e) => editingCat ? setEditingCat({ ...editingCat, icon: e.target.value }) : setCatForm({ ...catForm, icon: e.target.value })}>
              {EXPENSE_CATEGORY_ICON_OPTIONS.map(([value, label]) => <option key={value} value={value}>{label}</option>)}
            </select></div>
          <div style={{ display: "flex", gap: 8 }}>
            {editingCat ? <>
              <button type="button" className="btn btn-primary" onClick={saveCategoryEdit}><Check /> Save</button>
              <button type="button" className="btn btn-ghost" onClick={() => setEditingCat(null)}>Cancel</button>
            </> : <button type="button" className="btn btn-primary" onClick={addCategory}><Plus /> Add</button>}
          </div>
        </div>
        <div className="list expense-category-list">{allExpenseCategories.map((cat, idx) => (
          <div className="row" key={cat.id}>
            <div className="avatar"><ExpenseCategoryIcon icon={cat.icon} /></div>
            <div className="meta">
              <div className="nm">{cat.name}</div>
              <div className="mt2">{cat.active === false ? "Hidden from cashier expense sheet" : "Available to cashier terminals"}</div>
            </div>
            <span className="pill plain" style={{ color: cat.active === false ? "var(--muted)" : "var(--ok)" }}>{cat.active === false ? "Inactive" : "Active"}</span>
            <div className="category-order">
              <button type="button" className="iconbtn" title="Move up" aria-label={`Move ${cat.name} up`} disabled={idx === 0} onClick={() => moveCategory(cat, -1)}><ArrowUp /></button>
              <button type="button" className="iconbtn" title="Move down" aria-label={`Move ${cat.name} down`} disabled={idx === allExpenseCategories.length - 1} onClick={() => moveCategory(cat, 1)}><ChevronDown /></button>
              <button type="button" className="iconbtn" title="Rename" aria-label={`Rename ${cat.name}`} onClick={() => startEditCategory(cat)}><Edit /></button>
            </div>
            <button type="button" className={"btn xs " + (cat.active === false ? "btn-primary" : "btn-ghost")} onClick={() => toggleCategory(cat)}>{cat.active === false ? "Enable" : "Disable"}</button>
          </div>
        ))}</div>
      </div>}

      {view === "overview" && <>
      <div className="expense-overview-grid">
        <div className="dcard"><div className="sub" style={{ marginBottom: 2 }}>Analytics</div><div className="section-title" style={{ marginTop: 0 }}>Expenses by category</div><Bars data={byCat} empty="No expenses in this timeframe." /></div>
        <div className="dcard"><div className="sub" style={{ marginBottom: 2 }}>Analytics</div><div className="section-title" style={{ marginTop: 0 }}>Expenses by cashier</div><Bars data={byCashier} empty="No expenses in this timeframe." /></div>
      </div>
      <details className="expense-more-analysis">
        <summary><span>More analysis</span><ChevronDown /></summary>
      <div className="expense-overview-grid">
        <div className="dcard"><div className="sub" style={{ marginBottom: 2 }}>Analytics</div><div className="section-title" style={{ marginTop: 0 }}>Expenses by branch</div><Bars data={byBranch} empty="No expenses in this timeframe." /></div>
        <div className="dcard"><div className="sub" style={{ marginBottom: 2 }}>Analytics</div><div className="section-title" style={{ marginTop: 0 }}>Monthly operational cost</div><Bars data={byMonth} empty="No expenses in this timeframe." /></div>
      </div>
      </details>
      </>}

      {view === "approvals" && visiblePending.length > 0 && (
        <div>
          <div className="section-title">Pending approval queue · over {fmt(APPROVAL_LIMIT, cur)}</div>
          <div className="expense-queue">{[...visiblePending].reverse().map((e) => (
            <div className="row" key={e.id}>
              <div className="avatar"><AlertCircle style={{ width: 17, height: 17 }} /></div>
              <div className="meta">
                <div className="nm">{fmt(e.amountCents, cur)} · {e.category || "Other"}</div>
                <div className="mt2">{sourceOf(e)} · {cashierOf(e)} · {bname(e.branchId)} · {dt(e.ts)}</div>
                <div className="mt2">{e.note || "No note supplied."}</div>
                {rejecting === e.id && (
                  <div className="expense-reject-form">
                    <input className="input" value={rejectReason} onChange={(ev) => setRejectReason(ev.target.value)} placeholder="Reason for rejection" autoFocus />
                    <button type="button" className="btn sm btn-primary" disabled={rejectReason.trim().length < 3} onClick={() => reject(e.id)}><X /> Reject</button>
                    <button type="button" className="btn sm btn-ghost" onClick={() => { setRejecting(null); setRejectReason(""); }}>Cancel</button>
                  </div>
                )}
              </div>
              {rejecting === e.id ? null : (
                <div className="expense-queue-actions">
                  <button type="button" className="btn sm btn-primary" onClick={() => approve(e.id)}><Check /> Approve</button>
                  <button type="button" className="btn sm btn-ghost" onClick={() => { setRejecting(e.id); setRejectReason(""); }}><X /> Reject</button>
                </div>
              )}
            </div>))}
          </div>
        </div>
      )}
      {view === "approvals" && visiblePending.length === 0 ? <div className="notice">No expenses are waiting for approval.</div> : null}
      {view === "history" && <DocumentFile title="Expense records" count={history.length} meta={`${periodApproved.length} approved in the selected period`}>
      <div className="expense-history-list">{history.map((e) => {
        const rejected = isRejected(e);
        const decidedAt = e.decidedAt || e.approvedAt || e.rejectedAt;
        const decidedBy = e.decidedBy || e.approvedBy || e.rejectedBy;
        return (
          <div className="row" key={e.id}><div className="avatar"><TrendingDown style={{ width: 17, height: 17 }} /></div>
            <div className="meta">
              <div className="nm">{e.category || "Other"} · {sourceOf(e)} <span className="pill plain expense-history-status" style={{ color: rejected ? "#C23A56" : "var(--ok)" }}>{rejected ? "Rejected" : "Approved"}</span></div>
              <div className="mt2">{e.note || "No note supplied."} · {bname(e.branchId)} · {cashierOf(e)} · {dt(e.ts)}</div>
              <div className="mt2">{decidedAt ? (rejected ? "Rejected" : "Approved") + " by " + (decidedBy || "Supervisor") + " · " + dt(decidedAt) : "Auto-approved at entry"}</div>
              {rejected && e.rejectReason ? <div className="mt2">Reason: {e.rejectReason}</div> : null}
            </div>
            <span className="pill plain">{fmt(e.amountCents, cur)}</span>
          </div>
        );
      })}
        {history.length === 0 && <div className="notice">No expense approval history in this timeframe.</div>}</div>
      </DocumentFile>}
    </div>
  );
}

/* ---- AI Manager ---- */
const ASK_EXAMPLES = [
  "How much did we make today?",
  "Which branch needs stock?",
  "Why were profits lower this week?",
  "Show suspicious transactions.",
  "Prepare tomorrow's purchase orders.",
];
function aiDigest(data) {
  const cur = data.settings.currency; const k = (c) => Math.round(c / 100);
  const startToday = new Date().setHours(0, 0, 0, 0); const startYest = startToday - 864e5; const start7 = Date.now() - 7 * 864e5;
  const activeInvoices = operationalInvoices(data);
  const prod = (id) => data.products.find((p) => p.id === id);
  const bname = (id) => data.branches.find((b) => b.id === id)?.name || "—";
  const saleMv = (pred) => data.stockMovements.filter((m) => typeof m.reason === "string" && m.reason.startsWith("Sale") && pred(m));
  const branches = data.branches.map((b) => {
    const it = activeInvoices.filter((i) => i.branchId === b.id && i.ts >= startToday);
    const iy = activeInvoices.filter((i) => i.branchId === b.id && i.ts >= startYest && i.ts < startToday);
    const i7 = activeInvoices.filter((i) => i.branchId === b.id && i.ts >= start7);
    const salesToday = it.reduce((s, i) => s + i.totalCents, 0);
    const recognizedSalesToday = it.filter((i) => invRecognized(i, data.settings)).reduce((s, i) => s + i.totalCents, 0);
    const mv = saleMv((m) => m.branchId === b.id && m.ts >= startToday && saleMoveRecognized(data, m));
    const cogs = mv.reduce((s, m) => { const p = prod(m.productId); return s + (-m.qty) * (p ? branchInventoryCostCents(data, p, m.branchId) : 0); }, 0);
    return { branch: b.name, salesTodayKES: k(salesToday), recognizedSalesTodayKES: k(recognizedSalesToday), salesYesterdayKES: k(iy.reduce((s, i) => s + i.totalCents, 0)), transactionsToday: it.length, transactionsYesterday: iy.length, itemsSoldToday: mv.reduce((s, m) => s + (-m.qty), 0), cogsKES: k(cogs), grossProfitKES: k(recognizedSalesToday - cogs), marginPct: recognizedSalesToday > 0 ? Math.round((recognizedSalesToday - cogs) / recognizedSalesToday * 100) : 0, last7SalesKES: k(i7.reduce((s, i) => s + i.totalCents, 0)) };
  });
  const byProd = {}; saleMv((m) => m.ts >= startToday && saleMoveRecognized(data, m)).forEach((m) => { byProd[m.productId] = (byProd[m.productId] || 0) + (-m.qty); });
  const topProducts = Object.entries(byProd).map(([id, u]) => {
    const p = prod(id);
    if (!p) return null;
    const revenue = saleMv((m) => m.productId === id && m.ts >= startToday && saleMoveRecognized(data, m))
      .reduce((sum, movement) => sum + (-movement.qty) * branchProductPriceCents(p, movement.branchId), 0);
    return { product: p.name, sku: p.sku, units: u, revenueKES: k(revenue) };
  }).filter(Boolean).sort((a, b) => b.revenueKES - a.revenueKES).slice(0, 10);
  const payT = {}, pay7 = {}; data.payments.filter((p) => p.status === "captured" && !invoiceIsVoided(data, paymentInvoiceId(p))).forEach((p) => { if (p.ts >= startToday) payT[p.method] = (payT[p.method] || 0) + p.amountCents; if (p.ts >= start7) pay7[p.method] = (pay7[p.method] || 0) + p.amountCents; });
  const lowStock = []; data.branches.forEach((b) => { reorderList(data, b.id).forEach((p) => { lowStock.push({ branch: b.name, product: p.name, sku: p.sku, onHand: onHand(data, p.id, b.id), reorderLevel: p.reorderLevel ?? data.settings.reorderLevel }); }); });
  const cBy = {}; activeInvoices.filter((i) => i.ts >= startToday).forEach((i) => { const c = cBy[i.cashier] || { transactions: 0, sales: 0 }; c.transactions++; c.sales += i.totalCents; cBy[i.cashier] = c; });
  const cashiers = Object.entries(cBy).map(([name, v]) => ({ cashier: name, transactions: v.transactions, salesKES: k(v.sales), avgBasketKES: v.transactions ? k(v.sales / v.transactions) : 0 }));
  const debt = {};
  activeInvoices.filter((i) => invIsDebt(i)).forEach((i) => {
    const cashier = invoiceCashierName(i);
    debt[cashier] = (debt[cashier] || 0) + invOutstanding(i);
  });
  const expT = data.expenses.filter((e) => (!e.status || e.status === "approved") && e.ts >= startToday); const expCat = {}; expT.forEach((e) => { expCat[e.category] = (expCat[e.category] || 0) + e.amountCents; });
  const shrink = data.stockMovements.filter((m) => m.ts >= startToday && (m.reason === "Adjustment" || (m.reason === "Inventory count" && m.qty < 0))).map((m) => { const p = prod(m.productId); return { branch: bname(m.branchId), product: p ? p.name : "?", unitsLost: Math.abs(m.qty) }; });
  const transfers = data.borrowings.filter((t) => t.ts >= startToday).map((t) => ({
    from: bname(t.fromBranchId),
    to: bname(t.toBranchId),
    items: normalizedTransferItems(t, data.products).map((item) => ({ product: item.productName, sku: item.sku, qty: item.qty })),
    totalUnits: transferUnitCount(t, data.products),
  }));
  const totalToday = branches.reduce((s, b) => s + b.salesTodayKES, 0); const totalProfit = branches.reduce((s, b) => s + b.grossProfitKES, 0); const totalExp = k(expT.reduce((s, e) => s + e.amountCents, 0));
  return {
    currency: cur, date: new Date().toLocaleString(), company: data.settings.store || "VISIONPOS",
    totals: { salesTodayKES: totalToday, salesYesterdayKES: branches.reduce((s, b) => s + b.salesYesterdayKES, 0), transactionsToday: branches.reduce((s, b) => s + b.transactionsToday, 0), grossProfitKES: totalProfit, expensesTodayKES: totalExp, netProfitKES: totalProfit - totalExp },
    branches, topProducts,
    paymentMixTodayKES: Object.fromEntries(Object.entries(payT).map(([m, v]) => [m, k(v)])),
    paymentMix7dKES: Object.fromEntries(Object.entries(pay7).map(([m, v]) => [m, k(v)])),
    lowStock: lowStock.slice(0, 40), cashiers, cashierDebtsKES: Object.fromEntries(Object.entries(debt).map(([n, v]) => [n, k(v)])),
    expensesTodayByCategoryKES: Object.fromEntries(Object.entries(expCat).map(([c, v]) => [c, k(v)])), transfersToday: transfers, shrinkageToday: shrink,
    dataNotes: "Values are in " + cur + " whole units. This system has NO discount, refund, void, loyalty, or customer-demographic data — do not invent any; state when something cannot be assessed from the data.",
  };
}
function AIManagerTab({ data, sessionToken }) {
  const [messages, setMessages] = useState([]);
  const [input, setInput] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  const ask = async (question) => {
    const q = (question || "").trim(); if (!q || loading) return;
    setError(""); setInput("");
    const history = [...messages, { role: "user", content: q }];
    setMessages(history); setLoading(true);
    const system = "You are 'Ask My Business', the analyst for a multi-branch wines & spirits retailer in Kenya (currency KES). Answer using ONLY the JSON business data below. Be very brief: reply in 1-3 short sentences and lead with the direct answer/number. Do NOT add long explanations, methodology, or breakdowns unless the user explicitly asks for detail. For list requests (e.g. purchase orders, which branches), give a short bulleted list only — no preamble. Use KES. If something is not in the data (discounts, refunds, loyalty, demographics, hourly data), say briefly that it is not tracked rather than inventing it.\n\nBUSINESS DATA (JSON):\n" + JSON.stringify(aiDigest(data));
    try {
      const text = await aiComplete({ system, messages: history.map((m) => ({ role: m.role, content: m.content })), maxTokens: 400, sessionToken });
      setMessages((m) => [...m, { role: "assistant", content: text || "I couldn't generate an answer. Please try again." }]);
    } catch (e) {
      setError(
        e.status === 401 || e.message === "invalid_or_missing_user_session"
          ? "Your admin session has expired. Sign out, sign in again, then retry."
          : e.status === 403 || e.message === "insufficient_role"
            ? "Your account is not authorized to use the AI Assistant."
            : e.message === "ai_not_configured"
              ? "AI is not configured on the server. Add ANTHROPIC_API_KEY to the VPS environment and restart VISIONPOS."
              : "The AI provider request failed. Check the server logs for the exact response."
      );
      setMessages((m) => m.slice(0, -1));
    }
    setLoading(false);
  };
  const copy = (t) => { try { navigator.clipboard.writeText(t); } catch (_) {} };

  return (
    <div>
      <PageHead title="Ask My Business" sub="Ask anything about your sales, stock, profit, risks or planning — answered from your live data."
        right={messages.length > 0 ? <button className="btn sm btn-ghost" onClick={() => { setMessages([]); setError(""); }}>New chat</button> : null} />

      <div className="askbar" style={{ position: "static" }}>
        <input className="input" autoFocus placeholder="Ask anything… e.g. How much did we make today?" value={input}
          onChange={(e) => setInput(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter") ask(input); }} />
        <button className="btn btn-primary" disabled={loading || !input.trim()} onClick={() => ask(input)}><Sparkles /> Ask</button>
      </div>
      <div className="askex" style={{ justifyContent: "flex-start", marginTop: 10 }}>
        <span style={{ fontSize: 12.5, color: "var(--muted-2)", fontWeight: 600, alignSelf: "center" }}>Try:</span>
        {ASK_EXAMPLES.map((ex) => <button key={ex} className="seg" onClick={() => ask(ex)}>{ex}</button>)}
      </div>

      {error && <div className="alert" style={{ marginTop: 14 }}><AlertCircle />{error}</div>}

      {messages.length > 0 ? (
        <div className="chatwrap" style={{ marginTop: 16 }}>
          {messages.map((m, i) => (
            <div key={i} className={"bubble " + m.role}>
              <div className="brole">{m.role === "user" ? "You" : "Ask My Business"}</div>
              <div className="btext">{m.content}</div>
              {m.role === "assistant" && (
                <div className="bacts">
                  <button className="btn xs btn-ghost" onClick={() => copy(m.content)}>Copy</button>
                  <button className="btn xs btn-ghost" onClick={() => openWhatsApp(m.content)}>WhatsApp</button>
                  <button className="btn xs btn-ghost" onClick={() => openMail("Ask My Business", m.content)}>Email</button>
                </div>
              )}
            </div>
          ))}
          {loading && <div className="bubble assistant"><div className="brole">Ask My Business</div><div className="btext" style={{ color: "var(--muted)" }}>Looking through your data…</div></div>}
        </div>
      ) : (
        !loading && <div className="notice" style={{ marginTop: 16 }}>Type your question above and tap <strong>Ask</strong> — or pick an example. I read your live POS data across all branches and won't invent numbers I can't see.</div>
      )}
      {messages.length === 0 && loading && <div className="bubble assistant" style={{ marginTop: 16 }}><div className="brole">Ask My Business</div><div className="btext" style={{ color: "var(--muted)" }}>Looking through your data…</div></div>}
    </div>
  );
}

/* ---- Reports ---- */
const RSUBS = [
  ["overview", "Overview"], ["products", "Product Reports"], ["pnl", "Profit & Loss"],
  ["inventory", "Inventory Analytics"], ["reorder", "Reorder Forecast"], ["cashier", "Debts"],
  ["open", "Open Invoices"], ["overdue", "Overdue Invoices"], ["voided", "Voided Invoices"],
  ["credit", "Debt Recovery"], ["expenses", "Expense Reports"], ["loss", "Loss & Damage"], ["transfers", "Transfer History"],
];
function downloadFile(name, content, type) {
  try {
    const blob = new Blob([content], { type });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a"); a.href = url; a.download = name;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  } catch (_) {}
}
const csvEscape = (c) => '"' + String(c).replace(/"/g, '""') + '"';

// ---- Self-contained read-only PDF generator (MD5 + RC4 + Standard 40-bit encryption) ----
function pdfMd5(bytes) {
  const rl = (x, c) => ((x << c) | (x >>> (32 - c))) >>> 0;
  const add = (...a) => { let r = 0; for (let i = 0; i < a.length; i++) r = (r + a[i]) >>> 0; return r; };
  const s = [7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22, 5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20, 4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23, 6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21];
  const K = []; for (let i = 0; i < 64; i++) K[i] = (Math.floor(Math.abs(Math.sin(i + 1)) * 4294967296)) >>> 0;
  const msg = bytes.slice(); const ol = msg.length * 8;
  msg.push(0x80); while (msg.length % 64 !== 56) msg.push(0);
  for (let i = 0; i < 8; i++) msg.push((Math.floor(ol / Math.pow(2, 8 * i))) & 0xff);
  let a0 = 0x67452301 >>> 0, b0 = 0xefcdab89 >>> 0, c0 = 0x98badcfe >>> 0, d0 = 0x10325476 >>> 0;
  for (let off = 0; off < msg.length; off += 64) {
    const M = []; for (let i = 0; i < 16; i++) M[i] = ((msg[off + i * 4]) | (msg[off + i * 4 + 1] << 8) | (msg[off + i * 4 + 2] << 16) | (msg[off + i * 4 + 3] << 24)) >>> 0;
    let A = a0, B = b0, C = c0, D = d0;
    for (let i = 0; i < 64; i++) { let F, g;
      if (i < 16) { F = ((B & C) | ((~B >>> 0) & D)) >>> 0; g = i; }
      else if (i < 32) { F = ((D & B) | ((~D >>> 0) & C)) >>> 0; g = (5 * i + 1) % 16; }
      else if (i < 48) { F = (B ^ C ^ D) >>> 0; g = (3 * i + 5) % 16; }
      else { F = (C ^ (B | (~D >>> 0))) >>> 0; g = (7 * i) % 16; }
      F = add(F, A, K[i], M[g]); A = D; D = C; C = B; B = add(B, rl(F, s[i]));
    }
    a0 = add(a0, A); b0 = add(b0, B); c0 = add(c0, C); d0 = add(d0, D);
  }
  const out = []; [a0, b0, c0, d0].forEach((v) => { for (let i = 0; i < 4; i++) out.push((v >>> (8 * i)) & 0xff); });
  return out;
}
function pdfRc4(key, data) {
  const S = []; for (let i = 0; i < 256; i++) S[i] = i; let j = 0;
  for (let i = 0; i < 256; i++) { j = (j + S[i] + key[i % key.length]) & 255; const t = S[i]; S[i] = S[j]; S[j] = t; }
  const out = new Array(data.length); let i = 0; j = 0;
  for (let k = 0; k < data.length; k++) { i = (i + 1) & 255; j = (j + S[i]) & 255; const t = S[i]; S[i] = S[j]; S[j] = t; out[k] = data[k] ^ S[(S[i] + S[j]) & 255]; }
  return out;
}
const PDF_PAD = [0x28, 0xBF, 0x4E, 0x5E, 0x4E, 0x75, 0x8A, 0x41, 0x64, 0x00, 0x4E, 0x56, 0xFF, 0xFA, 0x01, 0x08, 0x2E, 0x2E, 0x00, 0xB6, 0xD0, 0x68, 0x3E, 0x80, 0x2F, 0x0C, 0xA9, 0xFE, 0x64, 0x53, 0x69, 0x7A];
// Build a read-only (encrypted: modify/copy/annotate disabled, print allowed, empty user password) PDF from text lines.
function readOnlyPDF(lines) {
  const SB = (s) => { const a = []; for (let i = 0; i < s.length; i++) a.push(s.charCodeAt(i) & 0xff); return a; };
  const idBytes = pdfMd5(SB("VPOS" + Date.now() + Math.random()));
  const P = -60;
  const padOwner = SB("vpos-owner-" + Math.random()).concat(PDF_PAD).slice(0, 32);
  const oKey = pdfMd5(padOwner).slice(0, 5);
  const padUser = PDF_PAD.slice(0, 32);
  const O = pdfRc4(oKey, padUser);
  const pBytes = [P & 0xff, (P >> 8) & 0xff, (P >> 16) & 0xff, (P >> 24) & 0xff];
  const encKey = pdfMd5(padUser.concat(O).concat(pBytes).concat(idBytes)).slice(0, 5);
  const U = pdfRc4(encKey, PDF_PAD.slice(0, 32));
  const objKey = (num) => pdfMd5(encKey.concat([num & 0xff, (num >> 8) & 0xff, (num >> 16) & 0xff, 0, 0])).slice(0, Math.min(encKey.length + 5, 16));
  const pageW = 612, pageH = 792, margin = 48, lineH = 15; const maxL = Math.floor((pageH - 2 * margin) / lineH);
  const pages = []; for (let i = 0; i < lines.length; i += maxL) pages.push(lines.slice(i, i + maxL));
  if (pages.length === 0) pages.push([{ text: "(no data)", size: 11 }]);
  const fontObj = 3, encObj = 4, pagesObj = 2, catObj = 1; let n = 5; const pageNums = [], contentNums = [];
  pages.forEach(() => { contentNums.push(n++); pageNums.push(n++); });
  const esc = (t) => t.replace(/\\/g, "\\\\").replace(/\(/g, "\\(").replace(/\)/g, "\\)");
  const contentFor = (pg) => { let y = pageH - margin; let s = "BT\n"; pg.forEach((ln) => { const sz = ln.size || 11; const g = ln.gray != null ? ln.gray : 0; s += "/F1 " + sz + " Tf\n" + g + " g\n1 0 0 1 " + margin + " " + y + " Tm\n(" + esc(ln.text || "") + ") Tj\n"; y -= lineH; }); return s + "ET"; };
  const hexstr = (b) => "<" + b.map((x) => x.toString(16).padStart(2, "0")).join("") + ">";
  const objData = {};
  objData[catObj] = SB("<< /Type /Catalog /Pages " + pagesObj + " 0 R >>");
  objData[pagesObj] = SB("<< /Type /Pages /Count " + pages.length + " /Kids [" + pageNums.map((x) => x + " 0 R").join(" ") + "] >>");
  objData[fontObj] = SB("<< /Type /Font /Subtype /Type1 /BaseFont /Courier >>");
  objData[encObj] = SB("<< /Filter /Standard /V 1 /R 2 /O " + hexstr(O) + " /U " + hexstr(U) + " /P " + P + " >>");
  pages.forEach((pg, idx) => {
    const cnum = contentNums[idx], pnum = pageNums[idx];
    const enc = pdfRc4(objKey(cnum), SB(contentFor(pg)));
    objData[cnum] = SB("<< /Length " + enc.length + " >>\nstream\n").concat(enc).concat(SB("\nendstream"));
    objData[pnum] = SB("<< /Type /Page /Parent " + pagesObj + " 0 R /MediaBox [0 0 " + pageW + " " + pageH + "] /Resources << /Font << /F1 " + fontObj + " 0 R >> >> /Contents " + cnum + " 0 R >>");
  });
  const maxNum = Math.max(catObj, pagesObj, fontObj, encObj, ...contentNums, ...pageNums);
  let out = []; const push = (a) => { for (let i = 0; i < a.length; i++) out.push(a[i]); };
  push(SB("%PDF-1.4\n%\u00e2\u00e3\u00cf\u00d3\n")); const offsets = {};
  for (let num = 1; num <= maxNum; num++) { if (!objData[num]) continue; offsets[num] = out.length; push(SB(num + " 0 obj\n")); push(objData[num]); push(SB("\nendobj\n")); }
  const xrefStart = out.length;
  push(SB("xref\n0 " + (maxNum + 1) + "\n0000000000 65535 f \n"));
  for (let num = 1; num <= maxNum; num++) push(SB((offsets[num] != null ? String(offsets[num]).padStart(10, "0") + " 00000 n \n" : "0000000000 65535 f \n")));
  push(SB("trailer\n<< /Size " + (maxNum + 1) + " /Root " + catObj + " 0 R /Encrypt " + encObj + " 0 R /ID [" + hexstr(idBytes) + " " + hexstr(idBytes) + "] >>\nstartxref\n" + xrefStart + "\n%%EOF"));
  return new Uint8Array(out);
}
// Build the text lines for an inventory discrepancy report PDF.
function discrepancyPdfLines(report, cur) {
  if (!report) return [];
  const pad = (s, w) => { s = String(s); return s.length >= w ? s.slice(0, w) : s + " ".repeat(w - s.length); };
  const padL = (s, w) => { s = String(s); return s.length >= w ? s : " ".repeat(w - s.length) + s; };
  const L = [];
  L.push({ text: report.store || "VISIONPOS", size: 16 });
  L.push({ text: "INVENTORY DISCREPANCY REPORT — READ-ONLY", size: 11, gray: 0.35 });
  L.push({ text: "Branch: " + report.branchName + "    " + new Date(report.ts).toLocaleString(), size: 9.5, gray: 0.35 });
  L.push({ text: "", size: 6 });
  L.push({ text: "Discrepancies: " + report.discrepancies.length + "   Amendments: " + report.amendments + "   Adjustments applied: " + report.applied, size: 10 });
  L.push({ text: "Shortage total: " + fmt(report.shortCost, cur) + "    Overage total: " + fmt(report.overCost, cur), size: 10 });
  L.push({ text: "Net variance value: " + fmt(report.varianceCost, cur), size: 10 });
  L.push({ text: "", size: 6 });
  L.push({ text: pad("PRODUCT", 26) + pad("SKU", 12) + padL("SYS", 5) + padL("CNT", 6) + padL("VAR", 6) + padL("VALUE", 13) + "  TYPE", size: 9.5 });
  L.push({ text: "-".repeat(74), size: 9.5, gray: 0.4 });
  const rows = report.lines && report.lines.length ? report.lines : report.discrepancies;
  rows.forEach((l) => { L.push({ text: pad(l.name, 26) + pad(l.sku, 12) + padL(l.system, 5) + padL(l.counted, 6) + padL((l.variance > 0 ? "+" : "") + l.variance, 6) + padL(fmt(l.variance * l.costCents, cur), 13) + "  " + (l.kind === "amendment" ? "amend" : "count"), size: 9.5 }); });
  if (rows.length === 0) L.push({ text: "No items counted.", size: 10, gray: 0.4 });
  L.push({ text: "", size: 8 });
  L.push({ text: "Generated by VISIONPOS · This document is read-only.", size: 8, gray: 0.5 });
  return L;
}
// Download / print / export an inventory discrepancy report. kind: "pdf" | "print" | "csv" | "json".
function exportDiscrepancy(report, cur, kind) {
  if (!report) return;
  const stamp = "visionary-discrepancy-" + String(report.branchName).replace(/\s+/g, "") + "-" + new Date(report.ts).toISOString().slice(0, 10);
  const reportLines = report.lines && report.lines.length ? report.lines : report.discrepancies;
  if (kind === "pdf" || kind === "print") {
    const printable = buildReportDocument({
      title: "Inventory Discrepancy Report",
      reportName: "Inventory Discrepancy Report",
      branchName: report.branchName,
      generatedBy: "VISIONPOS",
      dateRange: new Date(report.ts).toLocaleString(),
      orientation: "landscape",
      filters: [
        { label: "Discrepancies", value: report.discrepancies.length },
        { label: "Amendments", value: report.amendments },
        { label: "Mode", value: "Read-only" },
      ],
      columns: [
        { key: "product", label: "Product" },
        { key: "sku", label: "SKU" },
        { key: "system", label: "System", align: "right" },
        { key: "counted", label: "Counted", align: "right" },
        { key: "variance", label: "Variance", align: "right" },
        { key: "value", label: "Value", align: "right" },
        { key: "type", label: "Type" },
      ],
      rows: reportLines.map((l) => ({
        id: l.id || l.productId || l.sku,
        product: l.name,
        sku: l.sku,
        system: l.system,
        counted: l.counted,
        variance: (l.variance > 0 ? "+" : "") + l.variance,
        value: fmt(l.variance * l.costCents, cur),
        type: l.kind === "amendment" ? "amendment" : "count",
      })),
      totals: [
        { label: "Shortage", value: fmt(report.shortCost, cur) },
        { label: "Overage", value: fmt(report.overCost, cur) },
        { label: "Net value", value: fmt(report.varianceCost, cur) },
      ],
      footer: "Generated by VISIONPOS. This document is read-only.",
    });
    if (kind === "pdf") downloadPDF(printable);
    else printReport(printable);
    return;
  }
  if (kind === "pdf") { try { downloadFile(stamp + ".pdf", readOnlyPDF(discrepancyPdfLines(report, cur)), "application/pdf"); } catch (_) {} return; }
  if (kind === "print") {
    const esc = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;");
    const rowsArr = report.lines && report.lines.length ? report.lines : report.discrepancies;
    const rows = rowsArr.map((l) => "<tr><td>" + esc(l.name) + "<br><small>" + esc(l.sku) + "</small></td><td class='r'>" + l.system + "</td><td class='r'>" + l.counted + "</td><td class='r' style='font-weight:700;color:" + (l.variance < 0 ? "#b00" : l.variance > 0 ? "#070" : "#666") + "'>" + (l.variance > 0 ? "+" : "") + l.variance + "</td><td class='r'>" + fmt(l.variance * l.costCents, cur) + "</td><td>" + (l.kind === "amendment" ? "amendment" : "count") + "</td></tr>").join("");
    const html = "<html><head><title>Discrepancy Report</title><style>body{font-family:monospace;padding:24px;color:#111}h1{font-size:18px;margin:0}h2{font-size:12px;color:#555;font-weight:400;margin:2px 0 14px}table{width:100%;border-collapse:collapse;font-size:12px}th,td{border-bottom:1px solid #ddd;padding:5px 6px;text-align:left}td.r,th.r{text-align:right}small{color:#888}.s{margin:10px 0;font-size:12px}</style></head><body><h1>" + esc(report.store || "VISIONPOS") + "</h1><h2>Inventory Discrepancy Report — READ-ONLY · " + esc(report.branchName) + " · " + new Date(report.ts).toLocaleString() + "</h2><div class='s'>Discrepancies: <b>" + report.discrepancies.length + "</b> · Amendments: <b>" + report.amendments + "</b> · Shortage: <b>" + fmt(report.shortCost, cur) + "</b> · Overage: <b>" + fmt(report.overCost, cur) + "</b> · Net value: <b>" + fmt(report.varianceCost, cur) + "</b></div><table><thead><tr><th>Product</th><th class='r'>System</th><th class='r'>Counted</th><th class='r'>Variance</th><th class='r'>Value</th><th>Type</th></tr></thead><tbody>" + rows + "</tbody></table></body></html>";
    try {
      const fr = document.createElement("iframe"); fr.style.cssText = "position:fixed;right:0;bottom:0;width:0;height:0;border:0;";
      document.body.appendChild(fr); const d = fr.contentWindow.document; d.open(); d.write(html); d.close();
      setTimeout(() => { try { fr.contentWindow.focus(); fr.contentWindow.print(); } catch (_) { window.print(); } setTimeout(() => fr.remove(), 1000); }, 250);
    } catch (_) { window.print(); }
    return;
  }
  const lines = report.lines && report.lines.length ? report.lines : report.discrepancies;
  if (kind === "csv") {
    const headers = ["Product", "SKU", "System", "Counted", "Variance", "Variance value", "Type"];
    const rows = lines.map((l) => [l.name, l.sku, l.system, l.counted, l.variance, (l.variance * l.costCents) / 100, l.kind || "count"]);
    downloadFile(stamp + ".csv", [headers, ...rows].map((r) => r.map(csvEscape).join(",")).join("\n"), "text/csv");
  } else downloadFile(stamp + ".json", JSON.stringify({ branch: report.branchName, at: new Date(report.ts).toISOString(), discrepancies: report.discrepancies.length, amendments: report.amendments, lines: lines.map((l) => ({ product: l.name, sku: l.sku, system: l.system, counted: l.counted, variance: l.variance, type: l.kind || "count" })) }, null, 2), "application/json");
}

function ReportsTab({ data, initialTab, onOpenCashierCredit }) {
  const cur = data.settings.currency;
  const [period, setPeriod] = useState("today");
  const [rb, setRb] = useState("all");
  const [sub, setSub] = useState(initialTab === "unpaid" ? "open" : (initialTab || "overview"));
  const [fromD, setFromD] = useState(todayStr());
  const [toD, setToD] = useState(todayStr());
  const [vel, setVel] = useState("all");
  const [prodSel, setProdSel] = useState(null);
  const [productSearch, setProductSearch] = useState("");
  const [pnlProductSearch, setPnlProductSearch] = useState("");
  const [scannedPnlProductKey, setScannedPnlProductKey] = useState("");
  const [productScannerOn, setProductScannerOn] = useState(false);
  const [productScanMessage, setProductScanMessage] = useState("");
  const [reportCameraOpen, setReportCameraOpen] = useState(false);
  const productSearchRef = useRef(null);
  const pnlProductSearchRef = useRef(null);
  const [reorderWeeks, setReorderWeeks] = useState(2); // weeks of demand to cover in the reorder forecast
  const [printPreview, setPrintPreview] = useState(null);

  const reportProducts = useMemo(
    () => rb === "all" ? dedupeProductsByCode(data.products) : branchProductsUnique(data, rb),
    [data.products, data.stockMovements, rb]
  );

  const findReportProductByCode = (value) => {
    const barcode = normalizeBarcode(value);
    if (!barcode) return null;
    const branchId = rb === "all" ? undefined : rb;
    const direct = findProductByBarcode(data, barcode, branchId);
    if (direct) {
      const key = productDedupeKey(direct);
      return reportProducts.find((product) => productDedupeKey(product) === key) || direct;
    }
    const catalogEntry = findBarcodeCatalogEntry(data, barcode);
    return reportProducts.find((product) =>
      productMatchesBarcode(product, barcode) || productMatchesCatalog(product, catalogEntry)
    ) || null;
  };

  const openScannedReportProduct = (value) => {
    const barcode = normalizeBarcode(value);
    if (!barcode) return false;
    const match = findReportProductByCode(barcode);
    if (match) {
      if (sub === "pnl") {
        setScannedPnlProductKey(productDedupeKey(match));
        setPnlProductSearch("");
      } else setProductSearch("");
      setProductScanMessage("Scanned " + match.name + ".");
      if (sub === "products") setProdSel(match.id);
      appendBarcodeScanLog({ barcode, status: "reports:found", productId: match.id });
      return true;
    }
    if (sub === "pnl") {
      setScannedPnlProductKey("");
      setPnlProductSearch(barcode);
    }
    else setProductSearch(barcode);
    setProductScanMessage("Barcode not found: " + barcode + ".");
    appendBarcodeScanLog({ barcode, status: "reports:not_found" });
    return false;
  };

  useBarcodeScanner({
    enabled: productScannerOn && !reportCameraOpen && ((sub === "products" && !prodSel) || sub === "pnl"),
    mode: "reports",
    onScan: openScannedReportProduct,
  });

  const dayStart = (s) => new Date(s + "T00:00:00").getTime();
  const dayEnd = (s) => new Date(s + "T23:59:59.999").getTime();
  const sinceFor = period === "custom" ? dayStart(fromD) : { today: new Date().setHours(0, 0, 0, 0), "7d": Date.now() - 7 * 864e5, "30d": Date.now() - 30 * 864e5, all: 0 }[period];
  const untilFor = period === "custom" ? dayEnd(toD) : Infinity;
  const inRange = (ts) => ts >= sinceFor && ts <= untilFor;
  const inBranch = (bid) => rb === "all" || bid === rb;
  const bId = rb === "all" ? undefined : rb;
  const bname = (id) => data.branches.find((b) => b.id === id)?.name || "—";
  const prod = (id) => data.products.find((p) => p.id === id);
  const activeInvoices = operationalInvoices(data);

  const invs = activeInvoices.filter((i) => inRange(i.ts) && inBranch(i.branchId));
  const recInvs = invs.filter((i) => invRecognized(i, data.settings)); // counted in P&L only after payment and end-of-day
  const saleMoves = data.stockMovements.filter((m) => typeof m.reason === "string" && m.reason.startsWith("Sale") && inRange(m.ts) && inBranch(m.branchId) && saleMoveRecognized(data, m));
  const invById = {}; data.invoices.forEach((i) => { invById[i.id] = i; });
  const paymentTs = (payment) => Number(
    payment?.ts || payment?.createdAt || payment?.updatedAt || payment?.serverTs || 0
  );
  const paymentBranchId = (payment) => {
    const invoice = invById[paymentInvoiceId(payment)];
    return payment?.branchId || invoice?.branchId || null;
  };
  const pays = (data.payments || []).filter((payment) => {
    const invoiceId = paymentInvoiceId(payment);
    const amountCents = Number(payment?.amountCents || 0);
    const status = String(payment?.status || "captured").toLowerCase();
    return Boolean(invoiceId && invById[invoiceId])
      && status === "captured"
      && Number.isFinite(amountCents)
      && amountCents > 0
      && !invoiceIsVoided(data, invoiceId)
      && inRange(paymentTs(payment))
      && inBranch(paymentBranchId(payment));
  });
  const periodExp = data.expenses.filter((e) => (!e.status || e.status === "approved") && inRange(e.ts) && inBranch(e.branchId));
  const transfers = data.borrowings.filter((t) => inRange(t.ts) && (rb === "all" || t.fromBranchId === rb || t.toBranchId === rb));
  const lossMoves = data.stockMovements.filter((mv) => typeof mv.reason === "string" && mv.reason.startsWith("Loss/Damage") && inRange(mv.ts) && inBranch(mv.branchId));
  const lossTotal = lossMoves.reduce((s, mv) => { const p = prod(mv.productId); return s + Math.abs(mv.qty) * (p ? branchInventoryCostCents(data, p, mv.branchId) : 0); }, 0);
  const lossByReason = {}; lossMoves.forEach((mv) => { const r = mv.reason.replace("Loss/Damage · ", "").split(" — ")[0]; const p = prod(mv.productId); lossByReason[r] = (lossByReason[r] || 0) + Math.abs(mv.qty) * (p ? branchInventoryCostCents(data, p, mv.branchId) : 0); });

  const itemsSold = saleMoves.reduce((s, m) => s + (-m.qty), 0);
  const cogs = saleMoves.reduce((s, m) => { const p = prod(m.productId); return s + (-m.qty) * (p ? branchInventoryCostCents(data, p, m.branchId) : 0); }, 0);
  // Gross sales is the full non-void invoice value for the selected period,
  // including invoices that are still open or have since become overdue.
  // Total sales remains conservative: only paid invoices from a closed
  // business day are recognized in profit, margin and product P&L.
  const grossSales = invs.reduce((s, i) => s + Math.max(0, Number(i.totalCents || 0)), 0);
  const totalSales = recInvs.reduce((s, i) => s + Math.max(0, Number(i.totalCents || 0)), 0);
  const periodOpenInvoices = invs.filter((invoice) => invOutstanding(invoice) > 0 && !invIsDebt(invoice) && !invIsOverdue(invoice));
  const periodOverdueInvoices = invs.filter((invoice) => invIsOverdue(invoice));
  const periodDebtInvoices = invs.filter((invoice) => invIsDebt(invoice));
  const openSales = periodOpenInvoices.reduce((sum, invoice) => sum + invOutstanding(invoice), 0);
  const overdueSales = periodOverdueInvoices.reduce((sum, invoice) => sum + invOutstanding(invoice), 0);
  const debtSales = periodDebtInvoices.reduce((sum, invoice) => sum + invOutstanding(invoice), 0);
  const grossProfit = totalSales - cogs;
  const expTotal = periodExp.reduce((s, e) => s + e.amountCents, 0);
  const netProfit = grossProfit - expTotal - lossTotal;
  const margin = totalSales > 0 ? Math.round((grossProfit / totalSales) * 100) : 0;
  const cleared = pays.reduce((sum, payment) => sum + Number(payment.amountCents || 0), 0);
  const clearedInvoiceCount = new Set(pays.map(paymentInvoiceId)).size;
  const pending = countPending(data);
  const inventoryValue = reportProducts.reduce(
    (sum, product) => sum + productStockValuation(data, product, bId).costValue,
    0
  );

  const payMix = {}; pays.forEach((p) => { payMix[p.method] = (payMix[p.method] || 0) + p.amountCents; });
  const payRows = Object.entries(payMix).sort((a, b) => b[1] - a[1]);
  const payMax = Math.max(1, ...payRows.map(([, v]) => v));

  // Build product analytics once so the visible table, preview, print, PDF and
  // downloads cannot drift onto different product/sales datasets.
  const productsById = new Map((data.products || []).map((product) => [product.id, product]));
  const reportProductByKey = new Map(reportProducts.map((product) => [productDedupeKey(product), product]));
  const productAliases = new Map();
  (data.products || []).forEach((product) => {
    const key = productDedupeKey(product);
    [product.id, product.sku, product.barcode, product.name, ...barcodeCatalogIdsForProduct(product)]
      .filter(Boolean)
      .forEach((value) => productAliases.set(String(value).trim().toLowerCase(), key));
  });
  const productKeyForValue = (value) => productAliases.get(String(value || "").trim().toLowerCase()) || "";
  const productKeyForId = (productId) => {
    const product = productsById.get(productId);
    return product ? productDedupeKey(product) : productKeyForValue(productId) || (productId ? "product:" + productId : "");
  };
  const movementSoldQty = {};
  saleMoves.forEach((movement) => {
    const key = productKeyForId(movement.productId);
    if (key) movementSoldQty[key] = (movementSoldQty[key] || 0) + Math.max(0, -Number(movement.qty || 0));
  });
  const invoiceSoldQty = {};
  invs.forEach((invoice) => (invoice.items || []).forEach((item) => {
    const key = productKeyForValue(item.productId)
      || productKeyForValue(item.sku)
      || productKeyForValue(item.barcode)
      || productKeyForValue(item.name || item.productName);
    const qty = Math.max(0, Number(item.qty ?? item.quantity ?? 0));
    if (key && qty > 0) invoiceSoldQty[key] = (invoiceSoldQty[key] || 0) + qty;
  }));
  const lossQtyByProd = {};
  lossMoves.forEach((movement) => {
    const key = productKeyForId(movement.productId);
    if (key) lossQtyByProd[key] = (lossQtyByProd[key] || 0) + Math.abs(Number(movement.qty || 0));
  });
  const qtyFor = (product) => {
    const key = productDedupeKey(product);
    return Math.max(invoiceSoldQty[key] || 0, movementSoldQty[key] || 0);
  };
  const lossFor = (product) => lossQtyByProd[productDedupeKey(product)] || 0;
  const productsWithSales = reportProducts
    .map((p) => ({ p, qty: qtyFor(p) }))
    .filter((entry) => entry.qty > 0)
    .sort((a, b) => b.qty - a.qty);
  const fastCut = Math.ceil(productsWithSales.length / 3);
  const mediumCut = Math.ceil(2 * productsWithSales.length / 3);
  const productRank = {};
  productsWithSales.forEach((entry, index) => { productRank[productDedupeKey(entry.p)] = index; });
  const classOf = (product) => {
    if (qtyFor(product) <= 0) return "none";
    const rank = productRank[productDedupeKey(product)];
    if (rank < fastCut) return "fast";
    if (rank < mediumCut) return "medium";
    return "slow";
  };
  const VLABEL = { fast: "Fast", medium: "Medium", slow: "Slow", none: "No sales" };
  const VCOLOR = { fast: "var(--ok)", medium: "var(--warn)", slow: "var(--danger)", none: "var(--muted-2)" };
  const movementCounts = { fast: 0, medium: 0, slow: 0, none: 0 };
  reportProducts.forEach((product) => { movementCounts[classOf(product)] += 1; });
  const productSearchNeedle = productSearch.trim().toLowerCase();
  const matchesProductSearch = (product) => !productSearchNeedle || [
    product.name,
    product.sku,
    product.barcode,
    product.category,
    product.size,
    ...barcodeCatalogIdsForProduct(product),
  ].some((value) => String(value || "").toLowerCase().includes(productSearchNeedle));
  const allProductReportRows = reportProducts.map((p) => {
    const priceCents = productBranchAverageCents(data, p, bId, branchProductPriceCents);
    const costCents = productBranchAverageCents(data, p, bId, (item, id) => branchInventoryCostCents(data, item, id));
    const qty = qtyFor(p);
    const revenue = qty * priceCents;
    const cost = qty * costCents;
    const lossValue = lossFor(p) * costCents;
    const profit = revenue - cost;
    const netProfit = profit - lossValue;
    return {
      p,
      qty,
      revenue,
      cost,
      lossValue,
      profit,
      netProfit,
      marg: priceCents > 0 ? Math.round((priceCents - costCents) / priceCents * 100) : 0,
      stockOnHand: productOnHand(data, p, bId || null),
      movement: classOf(p),
    };
  });

  // Product P&L is built from the same recognized invoices and sale movements
  // as the summary above. This keeps every product row reconcilable to the
  // headline sales, COGS and loss figures for the selected branch and period.
  const productPnl = new Map();
  const ensureProductPnlRow = (key, fallback = {}) => {
    const stableKey = key || `unmapped:${String(fallback.name || "sale").trim().toLowerCase()}`;
    if (!productPnl.has(stableKey)) {
      const product = reportProductByKey.get(stableKey)
        || productsById.get(fallback.productId)
        || null;
      productPnl.set(stableKey, {
        key: stableKey,
        product,
        name: product?.name || fallback.name || "Unallocated invoice sales",
        sku: product?.sku || fallback.sku || "",
        category: product?.category || fallback.category || "",
        qty: 0,
        revenue: 0,
        cogs: 0,
        lossValue: 0,
      });
    }
    return productPnl.get(stableKey);
  };
  const productKeyForLine = (line) => productKeyForValue(line?.productId)
    || productKeyForValue(line?.sku)
    || productKeyForValue(line?.barcode)
    || productKeyForValue(line?.name || line?.productName)
    || `unmapped:${String(line?.name || line?.productName || line?.productId || "sale").trim().toLowerCase()}`;

  recInvs.forEach((invoice) => {
    invoiceSoldLines(data, invoice, invoice.branchId).forEach((line) => {
      const row = ensureProductPnlRow(productKeyForLine(line), line);
      row.qty += Math.max(0, Number(line.qty || 0));
      row.revenue += Math.max(0, Math.round(Number(line.totalCents || 0)));
    });
  });
  saleMoves.forEach((movement) => {
    const product = productsById.get(movement.productId) || prod(movement.productId);
    const row = ensureProductPnlRow(productKeyForId(movement.productId), {
      productId: movement.productId,
      name: product?.name || "Product",
      sku: product?.sku || "",
      category: product?.category || "",
    });
    row.cogs += Math.max(0, -Number(movement.qty || 0))
      * (product ? branchInventoryCostCents(data, product, movement.branchId) : 0);
  });
  lossMoves.forEach((movement) => {
    const product = productsById.get(movement.productId) || prod(movement.productId);
    const row = ensureProductPnlRow(productKeyForId(movement.productId), {
      productId: movement.productId,
      name: product?.name || "Product",
      sku: product?.sku || "",
      category: product?.category || "",
    });
    row.lossValue += Math.abs(Number(movement.qty || 0))
      * (product ? branchInventoryCostCents(data, product, movement.branchId) : 0);
  });

  // Preserve reconciliation even for legacy invoices whose item lines were
  // incomplete. The adjustment remains visible instead of silently vanishing.
  const allocatedProductRevenue = Array.from(productPnl.values()).reduce((sum, row) => sum + row.revenue, 0);
  const unallocatedRevenue = totalSales - allocatedProductRevenue;
  if (unallocatedRevenue !== 0) {
    ensureProductPnlRow("unallocated:invoice-adjustment", {
      name: "Unallocated invoice adjustment",
    }).revenue += unallocatedRevenue;
  }

  const productPnlRows = Array.from(productPnl.values())
    .map((row) => {
      const grossProductProfit = row.revenue - row.cogs;
      const productProfit = grossProductProfit - row.lossValue;
      return {
        ...row,
        grossProductProfit,
        productProfit,
        margin: row.revenue > 0 ? Math.round((grossProductProfit / row.revenue) * 100) : 0,
      };
    })
    .filter((row) => row.qty > 0 || row.revenue !== 0 || row.cogs !== 0 || row.lossValue !== 0)
    .sort((a, b) => b.revenue - a.revenue || String(a.name).localeCompare(String(b.name)));
  const productPnlRowMatchesKey = (row, key) => Boolean(key) && (
    row.key === key
    || (row.product && productDedupeKey(row.product) === key)
    || productKeyForValue(row.sku) === key
    || productKeyForValue(row.barcode) === key
    || productKeyForValue(row.name) === key
  );
  const scannedPnlProduct = scannedPnlProductKey
    ? reportProductByKey.get(scannedPnlProductKey)
      || reportProducts.find((product) => productDedupeKey(product) === scannedPnlProductKey)
      || null
    : null;
  const productPnlRowsForDisplay = scannedPnlProduct
    && !productPnlRows.some((row) => productPnlRowMatchesKey(row, scannedPnlProductKey))
    ? [...productPnlRows, {
        key: scannedPnlProductKey,
        product: scannedPnlProduct,
        name: scannedPnlProduct.name || "Product",
        sku: scannedPnlProduct.sku || "",
        category: scannedPnlProduct.category || "",
        qty: 0,
        revenue: 0,
        cogs: 0,
        lossValue: 0,
        grossProductProfit: 0,
        productProfit: 0,
        margin: 0,
      }]
    : productPnlRows;
  const pnlProductSearchNeedle = pnlProductSearch.trim().toLowerCase();
  const visibleProductPnlRows = productPnlRowsForDisplay.filter((row) => {
    if (scannedPnlProductKey) return productPnlRowMatchesKey(row, scannedPnlProductKey);
    return !pnlProductSearchNeedle || [
      row.name,
      row.sku,
      row.category,
    ].some((value) => String(value || "").toLowerCase().includes(pnlProductSearchNeedle))
      || (row.product && (
        productMatchesBarcode(row.product, pnlProductSearch)
        || productMatchesCatalog(row.product, findBarcodeCatalogEntry(data, pnlProductSearch))
      ));
  });
  const visibleProductPnlTotals = visibleProductPnlRows.reduce((totals, row) => ({
    qty: totals.qty + row.qty,
    revenue: totals.revenue + row.revenue,
    cogs: totals.cogs + row.cogs,
    lossValue: totals.lossValue + row.lossValue,
    grossProductProfit: totals.grossProductProfit + row.grossProductProfit,
    productProfit: totals.productProfit + row.productProfit,
  }), { qty: 0, revenue: 0, cogs: 0, lossValue: 0, grossProductProfit: 0, productProfit: 0 });
  const productRows = allProductReportRows.filter((row) => row.qty > 0).sort((a, b) => b.revenue - a.revenue);
  const visibleProductRows = allProductReportRows
    .filter((row) => (vel === "all" || row.movement === vel) && matchesProductSearch(row.p))
    .sort((a, b) => b.qty - a.qty || String(a.p.name || "").localeCompare(String(b.p.name || "")));
  const topMax = Math.max(1, ...productRows.map((r) => r.qty));

  const trend = {}; recInvs.forEach((i) => { trend[i.date] = (trend[i.date] || 0) + i.totalCents; });
  const trendRows = Object.entries(trend).sort((a, b) => (a[0] < b[0] ? -1 : 1)).slice(-10);
  const trendMax = Math.max(1, ...trendRows.map(([, v]) => v));

  const unresolvedInvoices = activeInvoices.filter((i) => invOutstanding(i) > 0 && inBranch(i.branchId));
  const openInvoiceReport = unresolvedInvoices.filter((invoice) => !invIsDebt(invoice) && !invIsOverdue(invoice));
  const overdueInvoiceReport = unresolvedInvoices.filter((invoice) => invIsOverdue(invoice));
  const debtInvoiceReport = unresolvedInvoices.filter((invoice) => invIsDebt(invoice));
  const voidedInvoiceReport = (data.invoices || [])
    .filter((invoice) => inBranch(invoice.branchId) && invoiceIsVoided(data, invoice))
    .sort((a, b) => Number(b.ts || 0) - Number(a.ts || 0));
  const invoiceDebtByCashierReport = {};
  debtInvoiceReport.forEach((i) => {
    const cashier = invoiceCashierName(i);
    invoiceDebtByCashierReport[cashier] = (invoiceDebtByCashierReport[cashier] || 0) + invOutstanding(i);
  });
  const missingDebtByCashierReport = {};
  const missingDebtCountByCashier = {};
  (data.cashierJointDebts || []).filter((debt) => inBranch(debt.branchId)).forEach((debt) => (debt.shares || []).forEach((share) => {
    const amount = cashierJointDebtShareBalance(data, debt, share).outstandingCents;
    if (amount <= 0) return;
    const cashier = share.cashierName || share.cashierId || "Unassigned cashier";
    missingDebtByCashierReport[cashier] = (missingDebtByCashierReport[cashier] || 0) + amount;
    missingDebtCountByCashier[cashier] = (missingDebtCountByCashier[cashier] || 0) + 1;
  }));
  const debtByCashier = {};
  new Set([...Object.keys(invoiceDebtByCashierReport), ...Object.keys(missingDebtByCashierReport)]).forEach((cashier) => {
    debtByCashier[cashier] = (invoiceDebtByCashierReport[cashier] || 0) + (missingDebtByCashierReport[cashier] || 0);
  });
  const expByCat = {}; periodExp.forEach((e) => { expByCat[e.category] = (expByCat[e.category] || 0) + e.amountCents; });

  // Credit recovery contains only invoices explicitly carried over by End of Day.
  const carried = activeInvoices.filter((i) => i.carriedOver && inBranch(i.branchId));
  const recoveredList = carried.filter((i) => invOutstanding(i) <= 0);
  const pendingList = carried.filter((i) => invIsDebt(i));
  const partialCount = carried.filter((i) => i.paidCents > 0 && invIsDebt(i)).length;
  const pendingTotal = pendingList.reduce((s, i) => s + invOutstanding(i), 0);
  const recoveredTotal = recoveredList.reduce((s, i) => s + i.totalCents, 0);
  const carriedIds = new Set(carried.map((i) => i.id));
  const clearedTodayCount = new Set(data.payments.filter((p) => p.status === "captured" && isToday(p.ts) && carriedIds.has(p.orderId)).map((p) => p.orderId)).size;

  // export builder for the active sub-report
  const buildExport = () => {
    const m = (c) => (c / 100);
    if (sub === "products") return {
      name: "product-report",
      headers: ["Product", "SKU", "Category", "Units sold", "Revenue", "Profit", "Margin %", "On hand", "Movement"],
      rows: visibleProductRows.map((r) => [r.p.name, r.p.sku, r.p.category || "", r.qty, m(r.revenue), m(r.netProfit), r.marg, r.stockOnHand, VLABEL[r.movement]]),
    };
    if (sub === "pnl") return {
      name: "profit-loss-by-product",
      headers: ["Product", "SKU", "Category", "Units sold", "Sales", "COGS", "Loss & damage", "Gross profit", "Product profit", "Gross margin %"],
      rows: visibleProductPnlRows.map((row) => [row.name, row.sku, row.category, row.qty, m(row.revenue), m(row.cogs), m(row.lossValue), m(row.grossProductProfit), m(row.productProfit), row.margin]),
    };
    if (sub === "loss") return { name: "loss-damage", headers: ["Date", "Product", "SKU", "Qty", "Reason", "Cost value"], rows: lossMoves.map((mv) => { const p = prod(mv.productId); return [dt(mv.ts), p ? p.name : mv.productId, p ? p.sku : "", Math.abs(mv.qty), mv.reason.replace("Loss/Damage · ", ""), m(Math.abs(mv.qty) * (p ? branchInventoryCostCents(data, p, mv.branchId) : 0))]; }) };
    if (sub === "inventory") return { name: "inventory", headers: ["Product", "SKU", "On hand", "Cost value", "Retail value"], rows: reportProducts.map((p) => { const valuation = productStockValuation(data, p, bId); return [p.name, p.sku, valuation.quantity, m(valuation.costValue), m(valuation.retailValue)]; }) };
    if (sub === "reorder") {
      const weekMs = 7 * 864e5, LB = 8; const lbStart = Date.now() - LB * weekMs;
      const fm = data.stockMovements.filter((m2) => typeof m2.reason === "string" && m2.reason.startsWith("Sale") && m2.ts >= lbStart && inBranch(m2.branchId));
      const sbp = {}; let earliest = Date.now(); fm.forEach((m2) => { sbp[m2.productId] = (sbp[m2.productId] || 0) + (-m2.qty); if (m2.ts < earliest) earliest = m2.ts; });
      const wkObs = fm.length ? Math.max(1, Math.min(LB, (Date.now() - earliest) / weekMs)) : 1;
      const rws = branchProductsUnique(data, bId).map((p) => { const wk = duplicateProductIds(data, p, bId).reduce((s, id) => s + (sbp[id] || 0), 0) / wkObs; if (wk <= 0) return null; const oh = productOnHand(data, p, bId); const lvl = p.reorderLevel ?? data.settings.reorderLevel; const cover = oh / wk; const need = Math.max(0, Math.ceil(wk * reorderWeeks - oh)); return { p, oh, lvl, wk, cover, need }; }).filter((r) => r && r.need > 0).sort((a, b) => a.cover - b.cover);
      return { name: "reorder-forecast", headers: ["Product", "SKU", "On hand", "Weekly demand", "Weeks of cover", "Reorder level", "Suggested order (" + reorderWeeks + "wk cover)"], rows: rws.map((r) => [r.p.name, r.p.sku, r.oh, r.wk.toFixed(2), r.cover.toFixed(1), r.lvl, r.need]) };
    }
    if (sub === "cashier") return {
      name: "cashier-debts",
      headers: ["Cashier", "Debt invoices", "Missing inventory counts", "Invoice debt", "Missing inventory debt", "Total owed"],
      rows: Object.entries(debtByCashier).map(([n, v]) => [n, debtInvoiceReport.filter((i) => invoiceCashierName(i) === n).length, missingDebtCountByCashier[n] || 0, m(invoiceDebtByCashierReport[n] || 0), m(missingDebtByCashierReport[n] || 0), m(v)]),
    };
    if (sub === "open") return { name: "open-invoices", headers: ["Invoice", "Cashier", "Customer", "Date", "Outstanding", "Status"], rows: openInvoiceReport.map((i) => [i.number || i.receiptNo, invoiceCashierName(i), i.customerName, i.date, m(invOutstanding(i)), "open"]) };
    if (sub === "overdue") return { name: "overdue-invoices", headers: ["Invoice", "Cashier", "Customer", "Date", "Outstanding", "Status"], rows: overdueInvoiceReport.map((i) => [i.number || i.receiptNo, invoiceCashierName(i), i.customerName, i.date, m(invOutstanding(i)), "overdue"]) };
    if (sub === "voided") return {
      name: "voided-invoices",
      headers: ["Invoice", "Cashier", "Customer", "Date", "Total", "Void reason", "Approved by"],
      rows: voidedInvoiceReport.map((invoice) => {
        const voidInfo = invoiceVoidState(data, invoice.id);
        return [invoice.number || invoice.receiptNo, invoiceCashierName(invoice), invoice.customerName, invoice.date, m(invoice.totalCents), voidInfo.decision?.reason || voidInfo.request?.reason || "", voidInfo.decision?.decidedByName || voidInfo.decision?.decidedBy || "Supervisor"];
      }),
    };
    if (sub === "credit") return { name: "debt-recovery", headers: ["Invoice", "Cashier", "Customer", "Date", "Total", "Outstanding", "State"], rows: carried.map((i) => [i.number, invoiceCashierName(i), i.customerName, i.date, m(i.totalCents), m(invOutstanding(i)), invOutstanding(i) <= 0 ? "recovered" : (i.paidCents > 0 ? "partial debt" : "debt")]) };
    if (sub === "expenses") return { name: "expenses", headers: ["Date", "Category", "Amount", "Note"], rows: periodExp.map((e) => [e.date, e.category, m(e.amountCents), e.note || ""]) };
    if (sub === "transfers") return { name: "transfers", headers: ["Transfer", "From", "To", "Product", "SKU", "Qty", "Date", "Status"], rows: transfers.flatMap((t) => normalizedTransferItems(t, data.products).map((item) => [t.number, bname(t.fromBranchId), bname(t.toBranchId), item.productName, item.sku, item.qty, new Date(t.ts).toLocaleString(), t.status || "completed"])) };
    return { name: "overview", headers: ["Metric", "Value"], rows: [["Gross sales (all non-void invoices)", m(grossSales)], ["Open invoice balance", m(openSales)], ["Overdue invoice balance", m(overdueSales)], ["Debt balance", m(debtSales)], ["Total sales (paid and closed)", m(totalSales)], ["Inventory value", m(inventoryValue)], ["Cost of goods", m(cogs)], ["Gross profit", m(grossProfit)], ["Expenses", m(expTotal)], ["Loss & damage", m(lossTotal)], ["Net profit", m(netProfit)], ["Margin %", margin], ["Gross invoices", invs.length], ["Recognized transactions", recInvs.length], ["Items sold", itemsSold], ["Cleared payments", m(cleared)]] };
  };
  const periodLabel = period === "custom" ? fromD + " to " + toD : { today: "Today", "7d": "Last 7 days", "30d": "Last 30 days", all: "All time" }[period];
  const activeBranchName = rb === "all" ? "All branches" : bname(rb);
  const buildPrintableReport = () => {
    const t = buildExport();
    const titleMap = {
      overview: "Daily Sales Report",
      products: "Product Sales Report",
      pnl: "Product Profit & Loss Report",
      inventory: "Inventory Report",
      reorder: "Reorder Forecast",
      cashier: "Cashier Debt Report",
      open: "Open Invoices Report",
      overdue: "Overdue Invoices Report",
      voided: "Voided Invoices Report",
      credit: "Debt Recovery Report",
      expenses: "Expense Report",
      loss: "Loss & Damage Report",
      transfers: "Stock Transfer Report",
    };
    const totals = (() => {
      if (sub === "products") return [
        { label: "Products shown", value: visibleProductRows.length },
        { label: "Units sold", value: visibleProductRows.reduce((sum, row) => sum + row.qty, 0) },
        { label: "Revenue", value: fmt(visibleProductRows.reduce((sum, row) => sum + row.revenue, 0), cur) },
        { label: "Net profit", value: fmt(visibleProductRows.reduce((sum, row) => sum + row.netProfit, 0), cur) },
      ];
      if (sub === "pnl") return [
        { label: "Product sales", value: fmt(visibleProductPnlTotals.revenue, cur) },
        { label: "Product COGS", value: fmt(visibleProductPnlTotals.cogs, cur) },
        { label: "Gross product profit", value: fmt(visibleProductPnlTotals.grossProductProfit, cur) },
        { label: "Product profit", value: fmt(visibleProductPnlTotals.productProfit, cur) },
      ];
      if (sub === "inventory") return [
        { label: "Products", value: t.rows.length },
        { label: "Units on hand", value: t.rows.reduce((sum, row) => sum + Number(row[2] || 0), 0) },
        { label: "Cost value", value: fmt(Math.round(t.rows.reduce((sum, row) => sum + Number(row[3] || 0), 0) * 100), cur) },
        { label: "Retail value", value: fmt(Math.round(t.rows.reduce((sum, row) => sum + Number(row[4] || 0), 0) * 100), cur) },
      ];
      if (sub === "reorder") return [
        { label: "Products to reorder", value: t.rows.length },
        { label: "Suggested units", value: t.rows.reduce((sum, row) => sum + Number(row[6] || 0), 0) },
      ];
      if (sub === "cashier") return [
        { label: "Cashiers", value: t.rows.length },
        { label: "Debt invoices", value: t.rows.reduce((sum, row) => sum + Number(row[1] || 0), 0) },
        { label: "Missing inventory counts", value: t.rows.reduce((sum, row) => sum + Number(row[2] || 0), 0) },
        { label: "Amount owed", value: fmt(Math.round(t.rows.reduce((sum, row) => sum + Number(row[5] || 0), 0) * 100), cur) },
      ];
      if (sub === "open") return [
        { label: "Open invoices", value: openInvoiceReport.length },
        { label: "Outstanding", value: fmt(openInvoiceReport.reduce((sum, invoice) => sum + invOutstanding(invoice), 0), cur) },
      ];
      if (sub === "overdue") return [
        { label: "Overdue invoices", value: overdueInvoiceReport.length },
        { label: "Outstanding", value: fmt(overdueInvoiceReport.reduce((sum, invoice) => sum + invOutstanding(invoice), 0), cur) },
      ];
      if (sub === "voided") return [
        { label: "Voided invoices", value: voidedInvoiceReport.length },
        { label: "Voided value", value: fmt(voidedInvoiceReport.reduce((sum, invoice) => sum + Number(invoice.totalCents || 0), 0), cur) },
      ];
      if (sub === "credit") return [
        { label: "Recovered", value: recoveredList.length },
        { label: "Outstanding debts", value: pendingList.length },
        { label: "Outstanding", value: fmt(pendingTotal, cur) },
        { label: "Partial", value: partialCount },
      ];
      if (sub === "expenses") return [
        { label: "Expense records", value: periodExp.length },
        { label: "Total expenses", value: fmt(expTotal, cur) },
      ];
      if (sub === "loss") return [
        { label: "Loss records", value: lossMoves.length },
        { label: "Units lost", value: lossMoves.reduce((sum, movement) => sum + Math.abs(Number(movement.qty || 0)), 0) },
        { label: "Loss value", value: fmt(lossTotal, cur) },
      ];
      if (sub === "transfers") return [
        { label: "Transfers", value: transfers.length },
        { label: "Units transferred", value: transfers.reduce((sum, transfer) => sum + transferUnitCount(transfer, data.products), 0) },
      ];
      return [
        { label: "Gross Sales", value: fmt(grossSales, cur) },
        { label: "Total Sales", value: fmt(totalSales, cur) },
        { label: "Gross Profit", value: fmt(grossProfit, cur) },
        { label: "Net Profit", value: fmt(netProfit, cur) },
        { label: "Transactions", value: recInvs.length },
      ];
    })();
    const filters = [
      { label: "Report", value: RSUBS.find(([k]) => k === sub)?.[1] || sub },
      { label: "Branch", value: activeBranchName },
      { label: "Period", value: periodLabel },
    ];
    if (sub === "products") {
      filters.push({ label: "Movement", value: vel === "all" ? "All" : VLABEL[vel] });
      if (productSearch.trim()) filters.push({ label: "Product search", value: productSearch.trim() });
    }
    if (sub === "pnl" && pnlProductSearch.trim()) filters.push({ label: "Product search", value: pnlProductSearch.trim() });
    if (sub === "reorder") filters.push({ label: "Target cover", value: reorderWeeks + " week(s)" });
    return buildReportDocument({
      title: titleMap[sub] || "VISIONPOS Report",
      companyName: data.settings.store || "VISIONPOS",
      companyDetails: "Cloud POS reports",
      logoUrl: data.settings.logoUrl || "",
      branchName: activeBranchName,
      generatedBy: "Current user",
      dateRange: periodLabel,
      filters,
      headers: t.headers,
      rows: t.rows,
      totals,
      orientation: t.headers.length > 6 ? "landscape" : "portrait",
    });
  };
  const doExport = (kind) => {
    if (kind === "preview") { setPrintPreview(buildPrintableReport()); return; }
    if (kind === "print") { setPrintPreview(buildPrintableReport()); return; }
    if (kind === "pdf") { downloadPDF(buildPrintableReport()); return; }
    const t = buildExport();
    const stamp = "visionary-" + t.name + "-" + (period === "custom" ? fromD + "_to_" + toD : period);
    if (kind === "csv" || kind === "excel") downloadFile(stamp + ".csv", [t.headers, ...t.rows].map((r) => r.map(csvEscape).join(",")).join("\n"), "text/csv");
    else if (kind === "json") downloadFile(stamp + ".json", JSON.stringify(t.rows.map((r) => Object.fromEntries(t.headers.map((h, i) => [h, r[i]]))), null, 2), "application/json");
  };

  const Stat = ({ l, v, sub2, warn }) => (<div className="stat"><div className="sl">{l}</div><div className={"sv" + (warn ? " warn" : "")}>{v}</div>{sub2 && <div className="sl" style={{ marginTop: 4 }}>{sub2}</div>}</div>);
  const Bars = ({ rows }) => rows.length === 0 ? <div className="notice">No data for this period.</div> : (
    <div className="bars">{rows.map((r) => (<div className="bar-row" key={r.label}><span className="bl">{r.label}</span>
      <div className="bar-track"><div className="bar-fill" style={{ width: (r.val / r.max * 100) + "%" }} /></div><span className="bv">{r.right}</span></div>))}</div>
  );

  return (
    <div>
      <PageHead title="Reports" sub="Computed live from local data — works offline." />
      <div className="repctrl">
        <div className="segbtns">{[["today", "Today"], ["7d", "7 days"], ["30d", "30 days"], ["all", "All time"], ["custom", "Custom"]].map(([k, lbl]) => (
          <button key={k} className={"seg" + (period === k ? " on" : "")} onClick={() => setPeriod(k)}>{lbl}</button>))}</div>
        {period === "custom" && (
          <div style={{ display: "flex", gap: 10, alignItems: "flex-end" }}>
            <div><label className="label">From</label><input className="input" type="date" style={{ height: 38, width: 152 }} value={fromD} max={toD} onChange={(e) => setFromD(e.target.value)} /></div>
            <div><label className="label">To</label><input className="input" type="date" style={{ height: 38, width: 152 }} value={toD} min={fromD} max={todayStr()} onChange={(e) => setToD(e.target.value)} /></div>
          </div>
        )}
        <div><label className="label">Branch</label>
          <select className="select" style={{ width: 170 }} value={rb} onChange={(e) => setRb(e.target.value)}>
            <option value="all">All branches</option>{data.branches.map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}</select></div>
        <div className="expbtns">
          <button className="btn xs btn-ghost" onClick={() => doExport("preview")}><FileText /> Preview</button>
          <button className="btn xs btn-ghost" onClick={() => doExport("print")}><Printer /> Print</button>
          <button className="btn xs btn-ghost" onClick={() => doExport("pdf")}>Save PDF</button>
          <button className="btn xs btn-ghost" onClick={() => doExport("excel")}>Export Excel</button>
          <button className="btn xs btn-ghost" onClick={() => doExport("json")}>JSON</button>
        </div>
      </div>
      <div className="subtabs">{RSUBS.map(([k, lbl]) => (<button key={k} className={"wtab" + (sub === k ? " on" : "")} onClick={() => setSub(k)}>{lbl}</button>))}</div>

      {sub === "overview" && (
        <>
          <div className="stats">
            <Stat l="Gross Sales" v={fmt(grossSales, cur)} sub2={invs.length + " non-void invoice(s)"} />
            <Stat l="Inventory Value" v={fmt(inventoryValue, cur)} sub2={activeBranchName} />
            <Stat l="Net Profit" v={fmt(netProfit, cur)} warn={netProfit < 0} />
            <Stat l="Cost of Goods" v={fmt(cogs, cur)} />
            <Stat l="Average Margin" v={margin + "%"} />
          </div>
          <div className="stats">
            <Stat l="Open Invoices" v={fmt(openSales, cur)} sub2={periodOpenInvoices.length + " invoice(s)"} warn={openSales > 0} />
            <Stat l="Overdue Invoices" v={fmt(overdueSales, cur)} sub2={periodOverdueInvoices.length + " invoice(s)"} warn={overdueSales > 0} />
            <Stat l="Debts" v={fmt(debtSales, cur)} sub2={periodDebtInvoices.length + " carried-over invoice(s)"} warn={debtSales > 0} />
            <Stat l="Expenses" v={fmt(expTotal, cur)} sub2={periodExp.length + " record(s)"} />
            <Stat l="Items Sold" v={itemsSold} />
            <Stat l="Payments Collected" v={fmt(cleared, cur)} sub2={clearedInvoiceCount + " invoice(s)"} />
            <Stat l="Pending Sync" v={pending} sub2="local only" warn={pending > 0} />
          </div>
          <div className="grid2" style={{ gap: 16 }}>
            <div className="panel"><div className="section-title" style={{ marginTop: 0 }}>Sales Trend</div>
              <Bars rows={trendRows.map(([d, v]) => ({ label: d, val: v, max: trendMax, right: fmt(v, cur) }))} /></div>
            <div className="panel"><div className="section-title" style={{ marginTop: 0 }}>Payment Methods</div>
              <Bars rows={payRows.map(([mth, v]) => ({ label: mth, val: v, max: payMax, right: fmt(v, cur) }))} /></div>
          </div>
          <div className="panel" style={{ marginTop: 16 }}><div className="section-title" style={{ marginTop: 0 }}>Top Products</div>
            <Bars rows={productRows.slice(0, 6).map((r) => ({ label: r.p.name, val: r.qty, max: topMax, right: r.qty + " u" }))} /></div>
        </>
      )}

      {sub === "products" && (() => {
        const openExactProduct = () => {
          openScannedReportProduct(productSearch);
        };
        if (prodSel) {
          const p = reportProducts.find((x) => x.id === prodSel) || data.products.find((x) => x.id === prodSel); if (!p) return null;
          const equivalentIds = new Set(duplicateProductIds(data, p, rb === "all" ? null : rb));
          equivalentIds.add(p.id);
          const moves = data.stockMovements.filter((mv) => equivalentIds.has(mv.productId) && inBranch(mv.branchId)).sort((a, b) => a.ts - b.ts);
          let bal = 0; const ledger = moves.map((mv) => { bal += mv.qty; return { ...mv, bal }; }).reverse();
          const priceCents = productBranchAverageCents(data, p, rb === "all" ? undefined : rb, branchProductPriceCents);
          const costCents = productBranchAverageCents(data, p, rb === "all" ? undefined : rb, (item, id) => branchInventoryCostCents(data, item, id));
          const soldUnits = qtyFor(p); const rev = soldUnits * priceCents; const cost = soldUnits * costCents; const cls = classOf(p);
          const lossUnits = lossFor(p); const lossVal = lossUnits * costCents; const gp = rev - cost; const net = gp - lossVal;
          const stockValuation = productStockValuation(data, p, rb === "all" ? undefined : rb);
          const stockOnHand = stockValuation.quantity;
          return (
            <div>
              <button className="btn xs btn-ghost" onClick={() => setProdSel(null)} style={{ marginBottom: 12 }}><ArrowLeft /> All products</button>
              <div className="panel" style={{ marginBottom: 14 }}>
                <div className="page-h" style={{ marginBottom: 6 }}><div><div className="title" style={{ fontSize: 18 }}>{p.name}</div><div className="sub">{p.sku} · {p.size} · {p.category}</div></div>
                  <span className="ist" style={{ background: "var(--surface-2)", color: VCOLOR[cls] }}>{VLABEL[cls]} mover</span></div>
                <div className="stats">
                  <Stat l="On hand" v={stockOnHand} />
                  <Stat l="Units sold" v={soldUnits} sub2={period === "all" ? "all time" : period === "custom" ? "custom range" : period} />
                  <Stat l="Units lost" v={lossUnits} warn={lossUnits > 0} />
                  <Stat l="Stock value" v={fmt(stockValuation.costValue, cur)} />
                </div>
              </div>
              <div className="panel" style={{ marginBottom: 14 }}>
                <div className="section-title" style={{ marginTop: 0 }}>Profit &amp; Loss · {period === "all" ? "all time" : period === "custom" ? "custom range" : period}</div>
                {[["Revenue", rev], ["Cost of goods sold", -cost], ["Gross profit", gp], ["Loss & damage", -lossVal]].map(([l, v]) => (
                  <div className="totrow" key={l}><span>{l}</span><span style={{ color: v < 0 ? "var(--danger)" : "var(--text)" }}>{v < 0 ? "−" : ""}{fmt(Math.abs(v), cur)}</span></div>))}
                <div className="totrow grand"><span>Net profit</span><span className="v" style={{ color: net < 0 ? "var(--danger)" : "var(--ok)" }}>{fmt(net, cur)}</span></div>
                <div className="sub" style={{ marginTop: 8 }}>Margin {rev > 0 ? Math.round(gp / rev * 100) : 0}% · cost {fmt(costCents, cur)} · price {fmt(priceCents, cur)}</div>
              </div>
              <div className="section-title" style={{ margin: "4px 0 8px" }}>Stock movement history{rb === "all" ? "" : " · " + bname(rb)}</div>
              {ledger.length === 0 ? <div className="notice">No movements recorded for this product.</div> : (
                <div className="tablewrap tblscroll"><table className="tbl"><thead><tr><th>Date</th><th>Type / reason</th><th>Change</th><th>Balance</th>{rb === "all" ? <th>Branch</th> : null}</tr></thead>
                  <tbody>{ledger.map((mv) => (<tr key={mv.id}><td>{dt(mv.ts)}</td><td>{mv.reason}</td>
                    <td style={{ fontWeight: 700, color: mv.qty < 0 ? "var(--danger)" : "var(--ok)" }}>{mv.qty > 0 ? "+" : ""}{mv.qty}</td>
                    <td style={{ fontWeight: 700 }}>{mv.bal}</td>{rb === "all" ? <td>{bname(mv.branchId)}</td> : null}</tr>))}</tbody></table></div>)}
            </div>
          );
        }
        return (
          <>
            <div style={{ display: "flex", gap: 10, marginBottom: 12, flexWrap: "wrap" }}>
              <div className="possearch" style={{ height: 44, flex: "1 1 260px", minWidth: 0 }}>
                <Search size={18} />
                <input
                  ref={productSearchRef}
                  value={productSearch}
                  onChange={(event) => setProductSearch(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key !== "Enter" && event.key !== "Tab") return;
                    event.preventDefault();
                    openExactProduct();
                  }}
                  placeholder="Search product name, SKU, or barcode..."
                  aria-label="Search product reports"
                />
                {productSearch ? (
                  <button
                    type="button"
                    className="btn xs btn-ghost"
                    onClick={() => { setProductSearch(""); productSearchRef.current?.focus(); }}
                    aria-label="Clear product search"
                  >
                    <X size={16} />
                  </button>
                ) : null}
              </div>
              <button
                type="button"
                className={"btn sm " + (productScannerOn ? "primary" : "btn-ghost")}
                onClick={() => {
                  const next = !productScannerOn;
                  setProductScannerOn(next);
                  setProductScanMessage(next ? "Scanner ready. Scan a product barcode." : "Scanner off.");
                  if (next) {
                    setProductSearch("");
                    window.setTimeout(() => {
                      productSearchRef.current?.focus();
                      productSearchRef.current?.select();
                    }, 0);
                  }
                }}
                aria-pressed={productScannerOn}
                title="Use a barcode scanner to open a product report"
              >
                <Barcode size={17} /> {productScannerOn ? "USB on" : "USB scanner"}
              </button>
              <button type="button" className="btn sm btn-ghost" onClick={() => setReportCameraOpen(true)}><Camera size={17} /> Camera scan</button>
            </div>
            {productScanMessage ? <div className="sub" role="status" style={{ margin: "-4px 0 10px", color: productScannerOn ? "var(--ok)" : "var(--muted)" }}>{productScanMessage}</div> : null}
            <div className="cfilter" style={{ marginBottom: 12 }}>
              {[["all", "All (" + reportProducts.length + ")"], ["fast", "Fast (" + movementCounts.fast + ")"], ["medium", "Medium (" + movementCounts.medium + ")"], ["slow", "Slow (" + movementCounts.slow + ")"], ["none", "No sales (" + movementCounts.none + ")"]].map(([k, l]) => (
                <button key={k} className={"seg" + (vel === k ? " on" : "")} onClick={() => setVel(k)}>{l}</button>))}
            </div>
            <div className="tablewrap tblscroll"><table className="tbl"><thead><tr><th>Product</th><th>Units sold</th><th>Revenue</th><th>Profit</th><th>Margin</th><th>On hand</th><th>Movement</th></tr></thead>
              <tbody>{visibleProductRows.map((row) => {
                const { p, qty: q, revenue: rev, netProfit: net, marg, stockOnHand, movement: cls } = row;
                return (<tr key={p.id} style={{ cursor: "pointer" }} onClick={() => setProdSel(p.id)}>
                  <td><div className="nm">{p.name}</div><div className="mt2">{p.sku} · {p.category}</div></td>
                  <td style={{ fontWeight: 700 }}>{q}</td><td className="amt">{fmt(rev, cur)}</td>
                  <td className="amt" style={{ color: net < 0 ? "var(--danger)" : "var(--text)" }}>{fmt(net, cur)}</td>
                  <td>{marg}%</td><td>{stockOnHand}</td>
                  <td><span className="ist" style={{ background: "var(--surface-2)", color: VCOLOR[cls] }}>{VLABEL[cls]}</span></td></tr>);
              })}
                {visibleProductRows.length === 0 && <tr><td colSpan="7"><div className="notice">No products match this search and movement filter.</div></td></tr>}</tbody></table></div>
            <div className="sub" style={{ marginTop: 8 }}>Movement class is based on units sold in the selected period (top third = Fast, middle = Medium, rest = Slow). Tap any product for its full stock-movement ledger.</div>
          </>
        );
      })()}

      {sub === "pnl" && (
        <>
          <div className="panel"><div className="section-title" style={{ marginTop: 0 }}>Profit &amp; Loss · {period === "all" ? "all time" : period}</div>
            {[["Total sales (paid and closed)", totalSales], ["Cost of goods sold", -cogs], ["Gross profit", grossProfit], ["Expenses", -expTotal], ["Loss & damage", -lossTotal]].map(([l, v]) => (
              <div className="totrow" key={l}><span>{l}</span><span style={{ color: v < 0 ? "var(--danger)" : "var(--text)" }}>{v < 0 ? "−" : ""}{fmt(Math.abs(v), cur)}</span></div>))}
            <div className="totrow grand"><span>Net profit</span><span className="v" style={{ color: netProfit < 0 ? "var(--danger)" : "var(--ok)" }}>{fmt(netProfit, cur)}</span></div>
            <div className="sub" style={{ marginTop: 10 }}>Margin {margin}% · {recInvs.length} transactions · {itemsSold} units</div>
          </div>

          <div style={{ display: "flex", gap: 12, alignItems: "flex-end", justifyContent: "space-between", margin: "18px 0 10px", flexWrap: "wrap" }}>
            <div>
              <div className="section-title" style={{ margin: 0 }}>Profit &amp; loss by product</div>
              <div className="sub">Sales and cost are assigned per product. Shared operating expenses remain in the summary above.</div>
            </div>
            <div style={{ display: "flex", gap: 8, width: "min(100%, 620px)", flexWrap: "wrap" }}>
              <div className="searchbox" style={{ flex: "1 1 260px", minWidth: 0 }}>
                <Search size={18} />
                <input
                  ref={pnlProductSearchRef}
                  value={pnlProductSearch}
                  onChange={(event) => {
                    setScannedPnlProductKey("");
                    setPnlProductSearch(event.target.value);
                  }}
                  onKeyDown={(event) => {
                    if (event.key !== "Enter" && event.key !== "Tab") return;
                    const value = event.currentTarget.value;
                    if (!isValidBarcode(normalizeBarcode(value))) return;
                    event.preventDefault();
                    openScannedReportProduct(value);
                  }}
                  placeholder="Search product, SKU, category, or barcode..."
                  aria-label="Search product profit and loss"
                />
                {pnlProductSearch ? (
                  <button type="button" className="btn xs btn-ghost" onClick={() => { setScannedPnlProductKey(""); setPnlProductSearch(""); pnlProductSearchRef.current?.focus(); }} aria-label="Clear product profit search">
                    <X size={16} />
                  </button>
                ) : null}
              </div>
              <button
                type="button"
                className={"btn sm " + (productScannerOn ? "primary" : "btn-ghost")}
                onClick={() => {
                  const next = !productScannerOn;
                  setProductScannerOn(next);
                  setProductScanMessage(next ? "Scanner ready. Scan a product barcode." : "Scanner off.");
                  if (next) window.setTimeout(() => pnlProductSearchRef.current?.focus(), 0);
                }}
                aria-pressed={productScannerOn}
                title="Use a barcode scanner to find product profit and loss"
              >
                <Barcode size={17} /> {productScannerOn ? "USB on" : "USB scanner"}
              </button>
              <button type="button" className="btn sm btn-ghost" onClick={() => setReportCameraOpen(true)}><Camera size={17} /> Camera scan</button>
            </div>
          </div>
          {productScanMessage ? <div className="sub" role="status" style={{ margin: "-4px 0 10px", color: productScannerOn ? "var(--ok)" : "var(--muted)" }}>{productScanMessage}</div> : null}

          <div className="tablewrap tblscroll"><table className="tbl"><thead><tr>
            <th>Product</th><th>Units sold</th><th>Sales</th><th>COGS</th><th>Loss / damage</th><th>Gross profit</th><th>Product profit</th><th>Margin</th>
          </tr></thead>
            <tbody>{visibleProductPnlRows.map((row) => (
              <tr key={row.key}>
                <td><div className="nm">{row.name}</div><div className="mt2">{[row.sku, row.category].filter(Boolean).join(" · ") || "Unmapped sale"}</div></td>
                <td style={{ fontWeight: 700 }}>{row.qty}</td>
                <td className="amt">{fmt(row.revenue, cur)}</td>
                <td className="amt">{fmt(row.cogs, cur)}</td>
                <td className="amt" style={{ color: row.lossValue > 0 ? "var(--danger)" : "var(--muted)" }}>{fmt(row.lossValue, cur)}</td>
                <td className="amt" style={{ color: row.grossProductProfit < 0 ? "var(--danger)" : "var(--text)" }}>{fmt(row.grossProductProfit, cur)}</td>
                <td className="amt" style={{ color: row.productProfit < 0 ? "var(--danger)" : "var(--ok)" }}>{fmt(row.productProfit, cur)}</td>
                <td>{row.margin}%</td>
              </tr>
            ))}
              {visibleProductPnlRows.length === 0 && <tr><td colSpan="8"><div className="notice">No product profit and loss records match this period, branch, and search.</div></td></tr>}
            </tbody>
            {visibleProductPnlRows.length > 0 && <tfoot><tr>
              <td><strong>{pnlProductSearch ? "Shown total" : "Product total"}</strong><div className="mt2">{visibleProductPnlRows.length} product(s)</div></td>
              <td><strong>{visibleProductPnlTotals.qty}</strong></td>
              <td className="amt"><strong>{fmt(visibleProductPnlTotals.revenue, cur)}</strong></td>
              <td className="amt"><strong>{fmt(visibleProductPnlTotals.cogs, cur)}</strong></td>
              <td className="amt"><strong>{fmt(visibleProductPnlTotals.lossValue, cur)}</strong></td>
              <td className="amt"><strong>{fmt(visibleProductPnlTotals.grossProductProfit, cur)}</strong></td>
              <td className="amt" style={{ color: visibleProductPnlTotals.productProfit < 0 ? "var(--danger)" : "var(--ok)" }}><strong>{fmt(visibleProductPnlTotals.productProfit, cur)}</strong></td>
              <td><strong>{visibleProductPnlTotals.revenue > 0 ? Math.round(visibleProductPnlTotals.grossProductProfit / visibleProductPnlTotals.revenue * 100) : 0}%</strong></td>
            </tr></tfoot>}
          </table></div>
          <div className="sub" style={{ marginTop: 8 }}>Product profit = sales - cost of goods sold - product loss/damage. Net profit also deducts shared operating expenses shown above.</div>
        </>
      )}

      {sub === "inventory" && (() => {
        const rows = branchProductsUnique(data, bId).map((p) => ({ p, ...productStockValuation(data, p, bId) }));
        const costVal = rows.reduce((s, r) => s + r.costValue, 0);
        const retailVal = rows.reduce((s, r) => s + r.retailValue, 0);
        const units = rows.reduce((s, r) => s + r.quantity, 0);
        return (<>
          <div className="stats"><Stat l="Units on hand" v={units} /><Stat l="Stock value (cost)" v={fmt(costVal, cur)} /><Stat l="Stock value (retail)" v={fmt(retailVal, cur)} /><Stat l="Potential margin" v={fmt(retailVal - costVal, cur)} /></div>
          <div className="tablewrap tblscroll"><table className="tbl"><thead><tr><th>Product</th><th>SKU</th><th>On hand</th><th>Cost value</th><th>Retail value</th></tr></thead>
            <tbody>{rows.map((r) => (<tr key={r.p.id}><td>{r.p.name}</td><td>{r.p.sku}</td><td>{r.quantity}</td><td className="amt">{fmt(r.costValue, cur)}</td><td className="amt">{fmt(r.retailValue, cur)}</td></tr>))}</tbody></table></div>
        </>);
      })()}

      {sub === "reorder" && (() => {
        // Weekly reorder forecast: demand is a weekly run-rate measured over a recent lookback window.
        const WEEKS_LOOKBACK = 8; const weekMs = 7 * 864e5;
        const lookbackStart = Date.now() - WEEKS_LOOKBACK * weekMs;
        const fcMoves = data.stockMovements.filter((m) => typeof m.reason === "string" && m.reason.startsWith("Sale") && m.ts >= lookbackStart && inBranch(m.branchId));
        const soldByProd = {}; let earliest = Date.now();
        fcMoves.forEach((m) => { soldByProd[m.productId] = (soldByProd[m.productId] || 0) + (-m.qty); if (m.ts < earliest) earliest = m.ts; });
        const weeksObserved = fcMoves.length ? Math.max(1, Math.min(WEEKS_LOOKBACK, (Date.now() - earliest) / weekMs)) : 1;
        const weekly = (pid) => (soldByProd[pid] || 0) / weeksObserved; // average units sold per week
        const target = reorderWeeks;
        const rows = branchProductsUnique(data, bId).map((p) => {
          const wk = duplicateProductIds(data, p, bId).reduce((s, id) => s + weekly(id), 0);
          if (wk <= 0) return null; // idle product — not part of the reorder forecast
          const oh = productOnHand(data, p, bId); const lvl = p.reorderLevel ?? data.settings.reorderLevel;
          const cover = oh / wk; // weeks of stock remaining at current demand
          const need = Math.max(0, Math.ceil(wk * target - oh)); // order enough to cover `target` weeks
          return { p, oh, lvl, wk, cover, need };
        }).filter((r) => r && r.need > 0).sort((a, b) => a.cover - b.cover);
        const totalUnits = rows.reduce((s, r) => s + r.need, 0);
        const totalCost = rows.reduce((s, r) => s + r.need * productBranchAverageCents(data, r.p, bId, branchProductCostCents), 0);
        return (<>
          <div className="cfilter" style={{ marginBottom: 12 }}>
            <span className="cfilthint" style={{ marginRight: 8 }}>Cover demand for</span>
            {[[1, "1 week"], [2, "2 weeks"], [4, "4 weeks"]].map(([k, l]) => (
              <button key={k} className={"seg" + (reorderWeeks === k ? " on" : "")} onClick={() => setReorderWeeks(k)}>{l}</button>))}
            <span className="cfilthint" style={{ marginLeft: "auto" }}>Demand from sales over the last {Math.round(weeksObserved)} week{Math.round(weeksObserved) === 1 ? "" : "s"}</span>
          </div>
          {rows.length === 0 ? <div className="notice">No moving products need reordering to cover {target} week{target === 1 ? "" : "s"} of demand{rb === "all" ? " across all branches" : " at " + bname(rb)}.</div> : (<>
            <div className="stats"><Stat l="Products to reorder" v={rows.length} /><Stat l="Units to order" v={totalUnits} /><Stat l="Est. order cost" v={fmt(totalCost, cur)} /><Stat l="Coverage target" v={target + " week" + (target === 1 ? "" : "s")} /></div>
            <div className="tablewrap tblscroll"><table className="tbl"><thead><tr><th>Product</th><th style={{ textAlign: "right" }}>On hand</th><th style={{ textAlign: "right" }}>Weekly demand</th><th style={{ textAlign: "right" }}>Weeks of cover</th><th style={{ textAlign: "right" }}>Reorder ≤</th><th style={{ textAlign: "right" }}>Suggested order</th></tr></thead>
              <tbody>{rows.map((r) => (<tr key={r.p.id}>
                <td><div className="nm">{r.p.name}</div><div className="mt2">{r.p.sku}</div></td>
                <td style={{ textAlign: "right", fontWeight: 700, color: r.oh <= r.lvl ? "var(--warn)" : "var(--text)" }}>{r.oh}</td>
                <td style={{ textAlign: "right", fontFamily: "var(--font-mono)" }}>{r.wk.toFixed(1)}/wk</td>
                <td style={{ textAlign: "right", color: r.cover < 1 ? "var(--danger)" : r.cover < target ? "var(--warn)" : "var(--muted)" }}>{r.cover.toFixed(1)}</td>
                <td style={{ textAlign: "right" }}>{r.lvl}</td>
                <td style={{ textAlign: "right" }}><span className="pill plain">+{r.need}</span></td>
              </tr>))}</tbody></table></div>
            <div className="sub" style={{ marginTop: 8 }}>Only products that are actually selling appear here, ordered by urgency (least cover first). Weekly demand is the average units sold per week over the last {Math.round(weeksObserved)} week{Math.round(weeksObserved) === 1 ? "" : "s"}; the suggested order tops each product up to {target} week{target === 1 ? "" : "s"} of cover. Idle products with no recent sales are excluded.</div>
          </>)}
        </>);
      })()}

      {sub === "cashier" && (
        Object.keys(debtByCashier).length === 0 ? <div className="notice">No cashier invoice or missing inventory debts.</div> : (
          <div className="list">{Object.entries(debtByCashier).map(([n, v]) => (<div className="row" key={n}>
            <div className="avatar" style={{ background: "linear-gradient(135deg,#E64368,#A66BFF)" }}>{n.charAt(0)}</div>
            <div className="meta"><div className="nm">{n}</div><div className="mt2">{debtInvoiceReport.filter((i) => invoiceCashierName(i) === n).length} carried-over invoice(s) · {missingDebtCountByCashier[n] || 0} missing inventory count(s)</div></div>
            <span className="pill plain" style={{ color: "#C23A56" }}>{fmt(v, cur)} owed</span>
            {onOpenCashierCredit && (invoiceDebtByCashierReport[n] || 0) > 0 ? <button className="btn sm" onClick={() => onOpenCashierCredit(n)}>View invoices <ChevronRight /></button> : null}
          </div>))}</div>)
      )}

      {sub === "open" && (
        openInvoiceReport.length === 0 ? <div className="notice">No open invoices.</div> : (
          <div className="tablewrap tblscroll"><table className="tbl"><thead><tr><th>Invoice</th><th>Cashier</th><th>Customer</th><th>Date</th><th>Outstanding</th><th>Status</th></tr></thead>
            <tbody>{openInvoiceReport.map((i) => (<tr key={i.id}><td className="innum">{String(i.number || i.receiptNo || "").slice(-12)}</td><td>{invoiceCashierName(i)}</td><td>{i.customerName}</td><td>{dt(i.ts)}</td><td className="amt">{fmt(invOutstanding(i), cur)}</td><td><span className="ist open">open</span></td></tr>))}</tbody></table></div>)
      )}

      {sub === "overdue" && (
        overdueInvoiceReport.length === 0 ? <div className="notice">No overdue invoices.</div> : (
          <div className="tablewrap tblscroll"><table className="tbl"><thead><tr><th>Invoice</th><th>Cashier</th><th>Customer</th><th>Date</th><th>Outstanding</th><th>Status</th></tr></thead>
            <tbody>{overdueInvoiceReport.map((i) => (<tr key={i.id}><td className="innum">{String(i.number || i.receiptNo || "").slice(-12)}</td><td>{invoiceCashierName(i)}</td><td>{i.customerName}</td><td>{dt(i.ts)}</td><td className="amt">{fmt(invOutstanding(i), cur)}</td><td><span className="ist overdue">overdue</span></td></tr>))}</tbody></table></div>)
      )}

      {sub === "voided" && (
        voidedInvoiceReport.length === 0 ? <div className="notice">No voided invoices.</div> : (
          <div className="tablewrap tblscroll"><table className="tbl"><thead><tr><th>Invoice</th><th>Cashier</th><th>Customer</th><th>Date</th><th>Total</th><th>Void reason</th><th>Approved by</th></tr></thead>
            <tbody>{voidedInvoiceReport.map((invoice) => {
              const voidInfo = invoiceVoidState(data, invoice.id);
              return <tr key={invoice.id}><td className="innum">{String(invoice.number || invoice.receiptNo || "").slice(-12)}</td><td>{invoiceCashierName(invoice)}</td><td>{invoice.customerName}</td><td>{dt(invoice.ts)}</td><td className="amt">{fmt(invoice.totalCents, cur)}</td><td>{voidInfo.decision?.reason || voidInfo.request?.reason || "—"}</td><td>{voidInfo.decision?.decidedByName || voidInfo.decision?.decidedBy || "Supervisor"}</td></tr>;
            })}</tbody></table></div>)
      )}

      {sub === "credit" && (
        <>
          <div className="stats">
            <Stat l="Recovered Credits" v={recoveredList.length} sub2={fmt(recoveredTotal, cur)} />
            <Stat l="Outstanding Debt" v={fmt(pendingTotal, cur)} sub2={pendingList.length + " invoice(s)"} warn={pendingTotal > 0} />
            <Stat l="Partial Credits" v={partialCount} />
            <Stat l="Cleared Today" v={clearedTodayCount} />
          </div>
          <div className="grid2" style={{ gap: 16 }}>
            <div className="panel">
              <div className="sub" style={{ marginBottom: 2 }}>Recovery</div>
              <div className="section-title" style={{ marginTop: 0 }}>Credit Recovery History</div>
              {recoveredList.length === 0 ? <div className="notice">No cleared cashier credit records yet.</div> : (
                <div className="list">{recoveredList.map((i) => (<div className="row" key={i.id}>
                  <div className="meta"><div className="nm innum">{i.number.slice(-12)}</div><div className="mt2">{i.cashier} · {i.customerName} · {dt(i.ts)}</div></div>
                  <span className="ist paid">recovered</span><span className="pill plain">{fmt(i.totalCents, cur)}</span></div>))}</div>)}
            </div>
            <div className="panel">
              <div className="sub" style={{ marginBottom: 2 }}>Recovery</div>
              <div className="section-title" style={{ marginTop: 0 }}>Debt Recovery Queue</div>
              {pendingList.length === 0 ? <div className="notice">No outstanding cashier debt records.</div> : (
                <div className="list">{pendingList.map((i) => (<div className="row" key={i.id}>
                  <div className="meta"><div className="nm innum">{i.number.slice(-12)}</div><div className="mt2">{i.cashier} · {i.customerName} · {dt(i.ts)}</div></div>
                  <span className={"ist " + invStatus(i)}>{invStatus(i)}</span><span className="pill plain" style={{ color: "#C23A56" }}>{fmt(invOutstanding(i), cur)} owed</span></div>))}</div>)}
            </div>
          </div>
        </>
      )}

      {sub === "expenses" && (
        <>
          {Object.keys(expByCat).length > 0 && <div className="stats">{Object.entries(expByCat).map(([c, v]) => <Stat key={c} l={c} v={fmt(v, cur)} />)}</div>}
          {periodExp.length === 0 ? <div className="notice">No expenses in this period.</div> : (
            <div className="list">{[...periodExp].reverse().map((e) => (<div className="row" key={e.id}><div className="avatar"><TrendingDown style={{ width: 17, height: 17 }} /></div>
              <div className="meta"><div className="nm">{e.category}</div><div className="mt2">{e.note || "—"} · {dt(e.ts)}</div></div><span className="pill plain">{fmt(e.amountCents, cur)}</span></div>))}</div>)}
        </>
      )}

      {sub === "loss" && (
        <>
          {Object.keys(lossByReason).length > 0 && <div className="stats"><Stat l="Total loss" v={fmt(lossTotal, cur)} warn />{Object.entries(lossByReason).map(([r, v]) => <Stat key={r} l={r} v={fmt(v, cur)} />)}</div>}
          {lossMoves.length === 0 ? <div className="notice">No loss or damage recorded in this period{rb === "all" ? "" : " at " + bname(rb)}.</div> : (
            <div className="tablewrap tblscroll"><table className="tbl"><thead><tr><th>Date</th><th>Product</th><th>Qty</th><th>Reason</th><th>Cost value</th></tr></thead>
              <tbody>{lossMoves.slice().sort((a, b) => b.ts - a.ts).map((mv) => { const p = prod(mv.productId); return (
                <tr key={mv.id}><td>{dt(mv.ts)}</td>
                  <td><div className="nm">{p ? p.name : mv.productId}</div><div className="mt2">{p ? p.sku : ""}</div></td>
                  <td style={{ fontWeight: 700, color: "var(--danger)" }}>−{Math.abs(mv.qty)}</td>
                  <td>{mv.reason.replace("Loss/Damage · ", "")}</td>
                  <td className="amt" style={{ color: "var(--danger)" }}>{fmt(Math.abs(mv.qty) * (p ? branchInventoryCostCents(data, p, mv.branchId) : 0), cur)}</td></tr>); })}</tbody></table></div>)}
        </>
      )}

      {sub === "transfers" && (
        transfers.length === 0 ? <div className="notice">No transfers in this period.</div> : (
          <div className="list">{transfers.map((t) => { const items = normalizedTransferItems(t, data.products); const units = transferUnitCount(t, data.products); return (<div className="row" key={t.id}>
            <div className="meta"><div className="nm" style={{ fontFamily: "var(--font-mono)", fontSize: 13 }}>{t.number}</div>
              <div className="mt2">{bname(t.fromBranchId)} → {bname(t.toBranchId)} · {items.map((item) => item.productName + " × " + item.qty).join(", ")}{items.length > 1 ? " · " + units + " units total" : ""}</div></div>
            <span className="ist paid">{t.status || "completed"}</span><span className="pill plain">{dt(t.ts)}</span></div>); })}</div>)
      )}
      {reportCameraOpen && (
        <CameraBarcodeScanner
          eyebrow="Reports"
          title={sub === "pnl" ? "Find product profit report" : "Open product report"}
          onClose={() => setReportCameraOpen(false)}
          onScan={openScannedReportProduct}
        />
      )}
      <ReportPreviewDialog
        report={printPreview}
        onClose={() => setPrintPreview(null)}
        onPrint={() => printReport(printPreview)}
        onDownloadPDF={() => downloadPDF(printPreview)}
      />
    </div>
  );
}

/* ---- Documents (report & document center) ---- */
const DOC_TYPES = [
  ["suppliers", "Invoices from Suppliers"], ["sales", "Sales Invoices"], ["inventory", "Inventory Counts"],
  ["corrections", "Stock Corrections"], ["loss", "Loss & Damage"], ["transfers", "Stock Transfers"], ["expenses", "Expenses"], ["purchases", "Purchase Orders"], ["endofday", "End of Day Closes"],
];
const openMail = (subject, body) => { try { window.open("mailto:?subject=" + encodeURIComponent(subject) + "&body=" + encodeURIComponent(body), "_blank"); } catch (_) {} };
const openWhatsApp = (text) => { try { window.open("https://wa.me/?text=" + encodeURIComponent(text), "_blank"); } catch (_) {} };

function DocumentsTab({ data }) {
  const cur = data.settings.currency;
  const [type, setType] = useState("suppliers");
  const [branch, setBranch] = useState("all");
  const [start, setStart] = useState("");
  const [end, setEnd] = useState("");
  const [selected, setSelected] = useState(null);
  const [poView, setPoView] = useState(null); // grouped purchase order popup
  const [repView, setRepView] = useState(null); // inventory count report popup
  const bname = (id) => data.branches.find((b) => b.id === id)?.name || "—";
  const prod = (id) => data.products.find((p) => p.id === id);
  const fromTs = start ? new Date(start + "T00:00:00").getTime() : null;
  const toTs = end ? new Date(end + "T23:59:59").getTime() : null;
  const inRange = (ts) => (fromTs == null || ts >= fromTs) && (toTs == null || ts <= toTs);
  const inBranch = (branchId) => branch === "all" || branchId === branch;
  const transferInBranch = (transfer) => branch === "all" || transfer.fromBranchId === branch || transfer.toBranchId === branch;

  let eyebrow = "Documents", title = "Document Reports", docs = [];
  if (type === "suppliers" || type === "purchases") {
    eyebrow = "Purchases"; title = type === "suppliers" ? "Supplier Invoice Reports" : "Purchase Order Reports";
    const groups = {};
    data.purchases.filter((p) => inRange(p.ts) && inBranch(p.branchId)).forEach((po) => { const k = po.batchId || po.id; (groups[k] = groups[k] || []).push(po); });
    docs = Object.entries(groups).map(([key, items]) => {
      const ts = Math.max(...items.map((i) => i.ts));
      const total = items.reduce((s, i) => s + purchaseLineTotalCents(i), 0);
      const units = items.reduce((s, i) => s + i.qty, 0);
      const recd = items.filter((i) => i.status === "received").length;
      const suppliers = Array.from(new Set(items.map((i) => i.supplierName).filter(Boolean)));
      const branches = Array.from(new Set(items.map((i) => bname(i.branchId)).filter(Boolean)));
      const no = items[0].batchNo;
      return { id: key, poItems: items,
        label: (no ? no + " · " : "") + items.length + " item" + (items.length > 1 ? "s" : "") + " · " + units + " unit" + (units > 1 ? "s" : ""),
        meta: (suppliers.join(", ") || "—") + " · " + branches.join(", ") + " · " + (recd === items.length ? "received" : recd + "/" + items.length + " received"),
        date: dt(ts), ts, amountCents: total,
        detail: [["Purchase order", no || "—"], ["Items", items.length], ["Units", units], ["Supplier(s)", suppliers.join(", ") || "—"], ["Branch(es)", branches.join(", ")], ["Received", recd + "/" + items.length], ["Total", fmtExact(total, cur)], ["Date", dt(ts)]] };
    });
  } else if (type === "sales") {
    eyebrow = "Sales"; title = "Sales Invoice Reports";
    docs = data.invoices.filter((i) => inRange(i.ts) && inBranch(i.branchId)).map((i) => {
      const voided = invoiceIsVoided(data, i);
      return { id: i.id, label: i.number, meta: i.customerName + " · " + i.cashier, date: i.date, ts: i.ts, amountCents: i.totalCents,
        detail: [["Invoice", i.number], ["Customer", i.customerName], ["Cashier", i.cashier], ["Branch", bname(i.branchId)], ["Total", fmt(i.totalCents, cur)], ["Paid", fmt(i.paidCents, cur)], ["Outstanding", fmt(voided ? 0 : invOutstanding(i), cur)], ["Status", voided ? "VOIDED" : invStatus(i)], ["Date", i.date]] };
    });
  } else if (type === "inventory") {
    eyebrow = "Inventory"; title = "Inventory Count Reports";
    const groups = {};
    (data.countLog || []).filter((c) => inRange(c.ts) && inBranch(c.branchId)).forEach((c) => { const k = c.branchId + "|" + c.ts; (groups[k] = groups[k] || []).push(c); });
    docs = Object.entries(groups).map(([key, entries]) => {
      const ts = entries[0].ts; const branchId = entries[0].branchId;
      const lines = entries.map((c) => { const p = prod(c.productId); return { id: c.id, name: p ? p.name : c.productId, sku: p ? p.sku : "", system: c.system, counted: c.counted, variance: c.variance, costCents: p ? branchInventoryCostCents(data, p, branchId) : 0, kind: c.kind }; });
      const discrepancies = lines.filter((l) => l.variance !== 0);
      const rep = { store: data.settings.store, branchName: bname(branchId), branchId, ts, lines, discrepancies,
        varianceUnits: lines.reduce((s, l) => s + l.variance, 0), varianceCost: lines.reduce((s, l) => s + l.variance * l.costCents, 0),
        shortUnits: discrepancies.filter((l) => l.variance < 0).reduce((s, l) => s - l.variance, 0),
        overUnits: discrepancies.filter((l) => l.variance > 0).reduce((s, l) => s + l.variance, 0),
        shortCost: discrepancies.filter((l) => l.variance < 0).reduce((s, l) => s + Math.abs(l.variance * l.costCents), 0),
        overCost: discrepancies.filter((l) => l.variance > 0).reduce((s, l) => s + l.variance * l.costCents, 0),
        amendments: lines.filter((l) => l.kind === "amendment").length, applied: discrepancies.length };
      return { id: key, countReport: rep,
        label: bname(branchId) + " · " + dt(ts),
        meta: lines.length + " item(s) counted · " + discrepancies.length + " discrepancy(ies)" + (rep.amendments ? " · " + rep.amendments + " amendment(s)" : ""),
        date: dt(ts), ts, amountCents: Math.abs(rep.varianceCost),
        detail: [["Branch", rep.branchName], ["When", new Date(ts).toLocaleString()], ["Items counted", lines.length], ["Discrepancies", discrepancies.length], ["Amendments", rep.amendments], ["Shortage total", fmt(rep.shortCost, cur)], ["Overage total", fmt(rep.overCost, cur)], ["Net variance value", fmt(rep.varianceCost, cur)]] };
    });
  } else if (type === "corrections") {
    eyebrow = "Inventory"; title = "Stock Correction Records";
    docs = (data.stockMovements || [])
      .filter((movement) => inRange(movement.ts) && inBranch(movement.branchId) && (movement.mode === "correction" || String(movement.reason || "").startsWith("Stock correction")))
      .map((movement) => {
        const product = prod(movement.productId);
        const value = Math.abs(Number(movement.qty) || 0) * (product ? branchInventoryCostCents(data, product, movement.branchId) : 0);
        return {
          id: movement.id,
          label: product?.name || "Product correction",
          meta: `${bname(movement.branchId)} · ${movement.previousQty ?? "—"} to ${movement.correctedQty ?? "—"} (${Number(movement.qty) > 0 ? "+" : ""}${movement.qty || 0})`,
          date: dt(movement.ts), ts: movement.ts, amountCents: value,
          detail: [["Product", product?.name || movement.productId], ["SKU", product?.sku || "—"], ["Branch", bname(movement.branchId)], ["Previous quantity", movement.previousQty ?? "—"], ["Corrected quantity", movement.correctedQty ?? "—"], ["Adjustment", `${Number(movement.qty) > 0 ? "+" : ""}${movement.qty || 0}`], ["Reason", movement.correctionReason || movement.reason || "Stock correction"], ["Note", movement.correctionNote || "—"], ["Corrected by", movement.correctedBy || "Supervisor"], ["When", dt(movement.ts)]]
        };
      });
  } else if (type === "loss") {
    eyebrow = "Shrinkage"; title = "Loss & Damage Reports";
    docs = data.stockMovements.filter((m) => inRange(m.ts) && inBranch(m.branchId) && (m.reason === "Adjustment" || (m.reason === "Inventory count" && m.qty < 0))).map((m) => { const p = prod(m.productId); const val = m.qty * (p ? branchInventoryCostCents(data, p, m.branchId) : 0);
      return { id: m.id, label: p ? p.name : "Product", meta: bname(m.branchId) + " · " + Math.abs(m.qty) + " units lost", date: dt(m.ts), ts: m.ts, amountCents: Math.abs(val),
        detail: [["Product", p ? p.name : ""], ["SKU", p ? p.sku : ""], ["Branch", bname(m.branchId)], ["Units lost", Math.abs(m.qty)], ["Cost value", fmt(Math.abs(val), cur)], ["Source", m.reason], ["When", new Date(m.ts).toLocaleString()]] }; });
  } else if (type === "transfers") {
    eyebrow = "Inventory"; title = "Stock Transfer Reports";
    docs = data.borrowings.filter((t) => inRange(t.ts) && transferInBranch(t)).map((t) => { const items = normalizedTransferItems(t, data.products); const units = transferUnitCount(t, data.products);
      return { id: t.id, label: t.number, meta: bname(t.fromBranchId) + " → " + bname(t.toBranchId) + " · " + items.map((item) => item.productName + " × " + item.qty).join(", ") + (items.length > 1 ? " · " + units + " units total" : ""), date: dt(t.ts), ts: t.ts, amountCents: 0,
        detail: [["Transfer", t.number], ["From", bname(t.fromBranchId)], ["To", bname(t.toBranchId)], ["Products", items.length], ["Total units", units], ...items.map((i, idx) => ["Item " + (idx + 1), i.productName + " × " + i.qty]), ["Status", t.status || "completed"], ["Note", t.note || "—"], ["When", dt(t.ts)]] }; });
  } else if (type === "expenses") {
    eyebrow = "Expenses"; title = "Expense Reports";
    docs = data.expenses.filter((e) => (!e.status || e.status === "approved") && inRange(e.ts) && inBranch(e.branchId)).map((e) => ({ id: e.id, label: e.category, meta: e.note || "—", date: e.date, ts: e.ts, amountCents: e.amountCents,
      detail: [["Category", e.category], ["Amount", fmt(e.amountCents, cur)], ["Note", e.note || "—"], ["Date", e.date]] }));
  } else if (type === "endofday") {
    eyebrow = "Shift Close"; title = "End of Day Closes";
    docs = (data.endOfDays || []).filter((e) => inRange(e.ts) && inBranch(e.branchId)).map((e) => ({ id: e.id, label: e.date + " · " + e.time + " · " + (e.branchName || ""), meta: e.transactions + " sale(s) · closed by " + e.closedBy, date: dt(e.ts), ts: e.ts, amountCents: e.totalSalesCents,
      detail: [["Branch", e.branchName], ["Date", e.date], ["Time", e.time], ["Transactions", e.transactions], ["Items sold", e.itemsSold], ["Total sales", fmt(e.totalSalesCents, cur)], ["Cash", fmt(e.cashCents, cur)], ["M-Pesa", fmt(e.mpesaCents, cur)], ["Card", fmt(e.cardCents, cur)], ["Invoice (credit)", fmt(e.invoiceCents, cur)], ["Counted cash", e.countedCashCents != null ? fmt(e.countedCashCents, cur) : "—"], ["Note", e.note || "—"], ["Closed by", e.closedBy]] }));
  }
  docs = docs.sort((a, b) => b.ts - a.ts);
  const sum = docs.reduce((s, d) => s + (d.amountCents || 0), 0);
  const periodLabel = (!start && !end) ? "All dates" : (start || "…") + " → " + (end || "…");
  const branchLabel = branch === "all" ? "All branches" : bname(branch);

  const runSelected = (a) => {
    if (!selected) return;
    const body = selected.detail.map(([k, v]) => k + ": " + v).join("\n");
    if (a === "print") {
      const esc = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;");
      const rows = selected.detail.map(([k, v]) => "<tr><td class='k'>" + esc(k) + "</td><td>" + esc(v) + "</td></tr>").join("");
      const html = "<html><head><title>" + esc(selected.label) + "</title><style>body{font-family:system-ui,Arial,sans-serif;padding:28px;color:#111}h1{font-size:17px;margin:0 0 2px}h2{font-size:12px;color:#666;font-weight:400;margin:0 0 16px}table{width:100%;border-collapse:collapse;font-size:13px;max-width:560px}td{border-bottom:1px solid #e5e5e5;padding:7px 8px;vertical-align:top}td.k{color:#666;width:42%}</style></head><body><h1>" + esc(title) + "</h1><h2>" + esc(selected.label) + " · " + esc(selected.date || "") + "</h2><table><tbody>" + rows + "</tbody></table></body></html>";
      try {
        const fr = document.createElement("iframe"); fr.style.cssText = "position:fixed;right:0;bottom:0;width:0;height:0;border:0;";
        document.body.appendChild(fr); const d = fr.contentWindow.document; d.open(); d.write(html); d.close();
        setTimeout(() => { try { fr.contentWindow.focus(); fr.contentWindow.print(); } catch (_) { window.print(); } setTimeout(() => fr.remove(), 1000); }, 250);
      } catch (_) { window.print(); }
      return;
    }
    if (a === "download") { downloadFile("visionary-doc-" + selected.id + ".json", JSON.stringify(Object.fromEntries(selected.detail), null, 2), "application/json"); return; }
    if (a === "email") { openMail(selected.label, selected.label + "\n" + body); return; }
    if (a === "whatsapp") { openWhatsApp(selected.label + "\n" + body); return; }
  };

  return (
    <div>
      <PageHead title="Documents" sub="Reports & documents — filter, then open any file to print, download, email or WhatsApp it." />
      <div className="repctrl" style={{ marginBottom: 16 }}>
        <div><label className="label">Document type</label>
          <select className="select" style={{ minWidth: 210 }} value={type} onChange={(e) => { setType(e.target.value); setSelected(null); }}>{DOC_TYPES.map(([k, l]) => <option key={k} value={k}>{l}</option>)}</select></div>
        <div><label className="label">Branch</label>
          <select className="select" style={{ minWidth: 180 }} value={branch} onChange={(e) => { setBranch(e.target.value); setSelected(null); setPoView(null); setRepView(null); }}>
            <option value="all">All branches</option>
            {data.branches.map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}
          </select></div>
        <div><label className="label">Start date</label><input type="date" className="input" style={{ maxWidth: 168 }} value={start} onChange={(e) => setStart(e.target.value)} /></div>
        <div><label className="label">End date</label><input type="date" className="input" style={{ maxWidth: 168 }} value={end} onChange={(e) => setEnd(e.target.value)} /></div>
      </div>

      <DocumentFile title={title} count={docs.length} meta={`${eyebrow} · ${periodLabel} · ${branchLabel} · ${fmt(sum, cur)}`}>
        {docs.length === 0 ? <div className="notice">No documents found for this period.</div> : (
          <div className="list">{docs.map((d) => (
            <div className={"row" + (d.poItems || d.countReport ? " clickable" : "") + (selected && selected.id === d.id ? " rowsel" : "")} key={d.id} onClick={d.poItems ? () => setPoView(d) : d.countReport ? () => setRepView(d) : undefined}>
              <div className="avatar">{d.poItems ? <ShoppingBag style={{ width: 17, height: 17 }} /> : d.countReport ? <Boxes style={{ width: 17, height: 17 }} /> : <FileText style={{ width: 17, height: 17 }} />}</div>
              <div className="meta"><div className="nm">{d.label}</div><div className="mt2">{d.meta} · {d.date}</div></div>
              {d.amountCents > 0 && <span className="pill plain">{fmt(d.amountCents, cur)}</span>}
              <button className="btn xs btn-ghost" onClick={(e) => { e.stopPropagation(); d.poItems ? setPoView(d) : d.countReport ? setRepView(d) : setSelected(d); }}>View</button>
            </div>))}</div>
        )}
      </DocumentFile>

      {selected && !selected.poItems && !selected.countReport && (
        <div className="scrim" onClick={() => setSelected(null)}>
          <div className="modal" style={{ maxWidth: 560 }} onClick={(e) => e.stopPropagation()}>
            <div className="modal-head"><div><div className="sub" style={{ margin: 0 }}>{title}</div><div className="title" style={{ fontSize: 19, display: "flex", alignItems: "center", gap: 8 }}><FileText style={{ width: 18, height: 18 }} /> {selected.label}</div><div className="sub" style={{ marginTop: 2 }}>{selected.date}</div></div>
              <button className="iconbtn" onClick={() => setSelected(null)}><X /></button></div>
            <div className="docvkv" style={{ marginTop: 8 }}>{selected.detail.map(([k, v], i) => (<div className="kv" key={i}><span className="k">{k}</span><span className="v">{String(v)}</span></div>))}</div>
            <div className="expbtns" style={{ marginTop: 16, flexWrap: "wrap" }}>
              <button className="btn xs btn-primary" onClick={() => runSelected("download")}><FileText /> Download</button>
              <button className="btn xs btn-ghost" onClick={() => runSelected("print")}><Printer /> Print</button>
              <button className="btn xs btn-ghost" onClick={() => runSelected("email")}>Email</button>
              <button className="btn xs btn-ghost" onClick={() => runSelected("whatsapp")}>WhatsApp</button>
            </div>
          </div>
        </div>
      )}
      {poView && (() => {
        const items = poView.poItems || [];
        const head = items[0] || {};
        const total = items.reduce((s, i) => s + purchaseLineTotalCents(i), 0);
        return (
          <div className="scrim" onClick={() => setPoView(null)}>
            <div className="modal" style={{ maxWidth: 640 }} onClick={(e) => e.stopPropagation()}>
              <div className="modal-head"><div><div className="sub" style={{ margin: 0 }}>Purchase order</div><div className="title" style={{ fontSize: 19, display: "flex", alignItems: "center", gap: 8 }}><ShoppingBag style={{ width: 18, height: 18 }} /> {head.batchNo || "Purchase"} · {dt(head.ts)}</div></div>
                <button className="iconbtn" onClick={() => setPoView(null)}><X /></button></div>
              <div className="tablewrap" style={{ marginTop: 8 }}>
                <table className="tbl"><thead><tr><th>Product</th><th>Supplier</th><th>Branch</th><th style={{ textAlign: "right" }}>Qty</th><th style={{ textAlign: "right" }}>Unit cost</th><th style={{ textAlign: "right" }}>Line total</th><th>Status</th></tr></thead>
                  <tbody>{items.map((po) => (<tr key={po.id}>
                    <td>{po.productName}</td><td>{po.supplierName}</td><td>{bname(po.branchId)}</td>
                    <td style={{ textAlign: "right" }}>{po.qty}</td><td style={{ textAlign: "right" }}>{fmtExact(purchaseUnitCostCents(po), cur, 6)}</td><td style={{ textAlign: "right" }}>{fmtExact(purchaseLineTotalCents(po), cur)}</td>
                    <td>{po.status === "received" ? <span className="ist paid">received</span> : <span className="ist">ordered</span>}</td>
                  </tr>))}</tbody></table>
              </div>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginTop: 14, gap: 10, flexWrap: "wrap" }}>
                <div className="sub">Total <b style={{ color: "var(--text)", fontSize: 16 }}>{fmtExact(total, cur)}</b> · {items.length} line(s)</div>
                <div className="expbtns" style={{ flexWrap: "wrap" }}>
                  <button className="btn xs btn-primary" onClick={() => { const headers = ["Product", "Supplier", "Branch", "Qty", "Unit cost", "Line total", "Status"]; const rows = items.map((po) => [po.productName, po.supplierName, bname(po.branchId), po.qty, purchaseUnitCostCents(po) / 100, purchaseLineTotalCents(po) / 100, po.status]); downloadFile("visionary-PO-" + (head.batchNo || poView) + ".csv", [headers, ...rows].map((r) => r.map(csvEscape).join(",")).join("\n"), "text/csv"); }}><FileText /> Download</button>
                  <button className="btn xs btn-ghost" onClick={() => {
                    const esc = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;");
                    const rws = items.map((po) => "<tr><td>" + esc(po.productName) + "</td><td>" + esc(po.supplierName) + "</td><td>" + esc(bname(po.branchId)) + "</td><td class='r'>" + po.qty + "</td><td class='r'>" + fmtExact(purchaseUnitCostCents(po), cur, 6) + "</td><td class='r'>" + fmtExact(purchaseLineTotalCents(po), cur) + "</td><td>" + po.status + "</td></tr>").join("");
                    const html = "<html><head><title>" + esc(head.batchNo || "Purchase order") + "</title><style>body{font-family:system-ui,Arial,sans-serif;padding:28px;color:#111}h1{font-size:17px;margin:0 0 2px}h2{font-size:12px;color:#666;font-weight:400;margin:0 0 16px}table{width:100%;border-collapse:collapse;font-size:12px}th,td{border-bottom:1px solid #e5e5e5;padding:6px 8px;text-align:left}td.r,th.r{text-align:right}</style></head><body><h1>Purchase Order " + esc(head.batchNo || "") + "</h1><h2>" + esc(dt(head.ts)) + " · Total " + esc(fmtExact(total, cur)) + "</h2><table><thead><tr><th>Product</th><th>Supplier</th><th>Branch</th><th class='r'>Qty</th><th class='r'>Unit</th><th class='r'>Total</th><th>Status</th></tr></thead><tbody>" + rws + "</tbody></table></body></html>";
                    try { const fr = document.createElement("iframe"); fr.style.cssText = "position:fixed;right:0;bottom:0;width:0;height:0;border:0;"; document.body.appendChild(fr); const dd = fr.contentWindow.document; dd.open(); dd.write(html); dd.close(); setTimeout(() => { try { fr.contentWindow.focus(); fr.contentWindow.print(); } catch (_) { window.print(); } setTimeout(() => fr.remove(), 1000); }, 250); } catch (_) { window.print(); }
                  }}><Printer /> Print</button>
                  <button className="btn xs btn-ghost" onClick={() => openMail("Purchase Order " + (head.batchNo || ""), "Purchase Order " + (head.batchNo || "") + " · " + dt(head.ts) + "\n\n" + items.map((po) => po.qty + "× " + po.productName + " (" + po.supplierName + ") — " + fmtExact(purchaseLineTotalCents(po), cur)).join("\n") + "\n\nTotal: " + fmtExact(total, cur))}>Email</button>
                </div>
              </div>
            </div>
          </div>
        );
      })()}
      {repView && repView.countReport && (() => {
        const r = repView.countReport;
        return (
          <div className="scrim" onClick={() => setRepView(null)}>
            <div className="modal" style={{ maxWidth: 720 }} onClick={(e) => e.stopPropagation()}>
              <div className="modal-head"><div><div className="sub" style={{ margin: 0 }}>{r.store || "VISIONPOS"} · {r.branchName}</div><div className="title" style={{ fontSize: 18, display: "flex", alignItems: "center", gap: 8 }}><Boxes style={{ width: 18, height: 18 }} /> Inventory Discrepancy Report</div><div className="sub" style={{ marginTop: 2 }}>{dt(r.ts)}</div></div>
                <div className="expbtns"><button className="btn xs btn-primary" onClick={() => exportDiscrepancy(r, cur, "pdf")}><FileText /> Download PDF (read-only)</button>
                  <button className="btn xs btn-ghost" onClick={() => exportDiscrepancy(r, cur, "print")}><Printer /> Print</button>
                  <button className="btn xs btn-ghost" onClick={() => openMail("Inventory Discrepancy Report · " + r.branchName, "Inventory Discrepancy Report — " + r.branchName + " · " + dt(r.ts) + "\n\nItems counted: " + r.lines.length + "\nDiscrepancies: " + r.discrepancies.length + "\nAmendments: " + r.amendments + "\nShortage total: " + fmt(r.shortCost, cur) + "\nOverage total: " + fmt(r.overCost, cur) + "\nNet variance value: " + fmt(r.varianceCost, cur) + "\n\n" + (r.discrepancies.length ? r.discrepancies.map((l) => l.name + ": system " + l.system + ", counted " + l.counted + ", variance " + (l.variance > 0 ? "+" : "") + l.variance).join("\n") : "No discrepancies."))}>Email</button>
                  <button className="iconbtn" onClick={() => setRepView(null)}><X /></button></div></div>
              <div className="stats" style={{ marginTop: 4 }}>
                <div className="stat"><div className="sl">Items counted</div><div className="sv">{r.lines.length}</div></div>
                <div className="stat"><div className="sl">Discrepancies</div><div className={"sv" + (r.discrepancies.length ? " warn" : "")}>{r.discrepancies.length}</div></div>
                <div className="stat"><div className="sl">Amendments</div><div className="sv">{r.amendments}</div></div>
                <div className="stat"><div className="sl">Shortage total</div><div className={"sv" + (r.shortCost ? " warn" : "")}>{fmt(r.shortCost, cur)}</div></div>
                <div className="stat"><div className="sl">Overage total</div><div className="sv">{fmt(r.overCost, cur)}</div></div>
                <div className="stat"><div className="sl">Net variance value</div><div className={"sv" + (r.varianceCost < 0 ? " warn" : "")}>{fmt(r.varianceCost, cur)}</div></div>
              </div>
              <div className="tablewrap" style={{ marginTop: 8, maxHeight: 360, overflow: "auto" }}>
                <table className="tbl"><thead><tr><th>Product</th><th style={{ textAlign: "right" }}>System</th><th style={{ textAlign: "right" }}>Counted</th><th style={{ textAlign: "right" }}>Variance</th><th style={{ textAlign: "right" }}>Value impact</th><th>Type</th></tr></thead>
                  <tbody>{r.lines.map((l) => (<tr key={l.id}>
                    <td><div className="nm">{l.name}</div><div className="mt2">{l.sku}</div></td>
                    <td style={{ textAlign: "right" }}>{l.system}</td><td style={{ textAlign: "right" }}>{l.counted}</td>
                    <td style={{ textAlign: "right", fontWeight: 700, color: l.variance < 0 ? "var(--danger)" : l.variance > 0 ? "var(--ok)" : "var(--muted)" }}>{(l.variance > 0 ? "+" : "") + l.variance}</td>
                    <td className="amt" style={{ color: l.variance < 0 ? "var(--danger)" : "var(--text)" }}>{fmt(l.variance * l.costCents, cur)}</td>
                    <td>{l.kind === "amendment" ? <span className="ist open">amendment</span> : <span className="ist paid">count</span>}</td>
                  </tr>))}</tbody></table>
              </div>
            </div>
          </div>
        );
      })()}
    </div>
  );
}

/* ---- Users & Security ---- */
const ROLES = ["Cashier", "Supervisor", "Manager"];
const RIGHTS = [
  { id: "sell", label: "Sell at till" },
  { id: "invoices", label: "Sales & clearing" },
  { id: "customers", label: "Customers" },
  { id: "products", label: "Products & pricing" },
  { id: "stock", label: "Stock & counts" },
  { id: "purchases", label: "Purchasing" },
  { id: "transfers", label: "Transfers" },
  { id: "suppliers", label: "Suppliers" },
  { id: "cash", label: "Cash management" },
  { id: "expenses", label: "Expenses" },
  { id: "approve_expenses", label: "Approve expenses" },
  { id: "financials", label: "Financials & reports" },
  { id: "branches", label: "Branches" },
  { id: "documents", label: "Documents" },
  { id: "users", label: "Users & security" },
  { id: "settings", label: "Settings" },
];
const ROLE_RIGHTS = {
  Cashier: ["sell", "customers"],
  Supervisor: ["sell", "invoices", "customers", "stock", "expenses", "documents"],
  Manager: ["sell", "invoices", "customers", "products", "stock", "purchases", "transfers", "suppliers", "cash", "expenses", "approve_expenses", "financials", "branches", "documents"],
};
// Strong password: ≥8 chars, with uppercase, lowercase, a number, and a special character.
function passwordIssue(pw) {
  if (pw.length < 8) return "Password must be at least 8 characters.";
  if (!/[A-Z]/.test(pw)) return "Password needs at least one uppercase letter.";
  if (!/[a-z]/.test(pw)) return "Password needs at least one lowercase letter.";
  if (!/[0-9]/.test(pw)) return "Password needs at least one number.";
  if (!/[^A-Za-z0-9]/.test(pw)) return "Password needs at least one special character.";
  return null;
}
function resetErrorMessage(code) {
  return ({
    password_too_short: "Password must be at least 8 characters.",
    password_missing_uppercase: "Password needs at least one uppercase letter.",
    password_missing_lowercase: "Password needs at least one lowercase letter.",
    password_missing_number: "Password needs at least one number.",
    password_missing_special: "Password needs at least one special character.",
    passwords_do_not_match: "Passwords don't match.",
    reset_token_required: "Open the reset link from your email first.",
  })[code] || code;
}
function maskEmailLocal(email) {
  const [name, domain] = String(email || "").trim().toLowerCase().split("@");
  if (!name || !domain) return "";
  return `${name.slice(0, 2)}${name.length > 2 ? "***" : "*"}@${domain}`;
}
function PasswordRules({ password, confirm }) {
  const rules = [
    ["At least 8 characters", password.length >= 8],
    ["One uppercase letter", /[A-Z]/.test(password)],
    ["One lowercase letter", /[a-z]/.test(password)],
    ["One number", /[0-9]/.test(password)],
    ["One special character", /[^A-Za-z0-9]/.test(password)],
    ["Passwords match", Boolean(password) && password === confirm],
  ];
  return (
    <div className="authnote" style={{ marginTop: 10, display: "grid", gap: 6 }}>
      {rules.map(([label, ok]) => (
        <div key={label} style={{ display: "flex", alignItems: "center", gap: 8, color: ok ? "var(--ok)" : "var(--muted)" }}>
          {ok ? <Check style={{ width: 14, height: 14 }} /> : <AlertCircle style={{ width: 14, height: 14 }} />}
          <span>{label}</span>
        </div>
      ))}
    </div>
  );
}
function TerminalsTab({ data, isAdmin }) {
  const [terminals, setTerminals] = useState([]);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState("");
  const bn = (id) => data.branches.find((b) => b.id === id)?.name || "—";
  const currentBranch = data.branches.find((b) => b.id === data.settings?.activeBranchId) || data.branches[0] || null;
  const [activation, setActivation] = useState({ terminalName: "", code: "" });
  const loadTerminals = async (silent = false) => {
    if (!isAdmin) return;
    if (!silent) setBusy(true);
    try {
      const result = await authGet("/api/auth/terminals", { session: true });
      setTerminals(result.terminals || []);
      if (!silent) setMsg("");
    } catch (error) {
      if (!silent) setMsg("Could not load terminals: " + error.message);
    } finally {
      if (!silent) setBusy(false);
    }
  };
  const generateActivation = async () => {
    if (!currentBranch?.id) return setMsg("Select your working branch before generating a terminal code.");
    if (!activation.terminalName.trim()) return setMsg("Enter terminal name.");
    setBusy(true);
    try {
      const result = await authApi("/api/auth/terminal-activations", { branchId: currentBranch.id, terminalName: activation.terminalName.trim() }, { session: true });
      setActivation((p) => ({ ...p, code: result.code || "" }));
      setMsg("Activation code generated. Open VISIONPOS Cashier and enter this code once.");
    } catch (error) {
      setMsg("Could not generate activation code: " + error.message);
    } finally {
      setBusy(false);
    }
  };
  const updateTerminal = async (terminal, patch) => {
    setBusy(true);
    try {
      const safePatch = { ...patch };
      delete safePatch.branchId;
      await authApi("/api/auth/terminals/" + encodeURIComponent(terminal.uuid), safePatch, { session: true });
      await loadTerminals();
    } catch (error) {
      setMsg("Terminal update failed: " + error.message);
    } finally {
      setBusy(false);
    }
  };
  useEffect(() => {
    if (!isAdmin) return undefined;
    loadTerminals();
    const refreshTimer = window.setInterval(() => loadTerminals(true), 15000);
    return () => window.clearInterval(refreshTimer);
  }, [isAdmin]); // eslint-disable-line
  if (!isAdmin) return <div><PageHead title="Terminals" sub="Only the owner admin can manage cashier terminals." /><div className="notice">Sign in as the owner admin to generate terminal activation codes.</div></div>;
  return (
    <div>
      <PageHead title="Terminals" sub="Register cashier desktop apps for the current branch and revoke lost devices." />
      <div className="addpanel fade" style={{ marginBottom: 14 }}>
        <div className="section-title" style={{ marginTop: 0 }}>Generate activation code</div>
        <div className="grid3">
          <div><label className="label">Terminal name</label><input className="input" value={activation.terminalName} onChange={(e) => setActivation({ ...activation, terminalName: e.target.value, code: "" })} placeholder="SIPCITY Till 1" /></div>
          <div><label className="label">Branch</label><div className="notice" style={{ minHeight: 56, display: "flex", alignItems: "center", margin: 0 }}><Building2 style={{ width: 16, height: 16 }} /> {currentBranch?.name || "No branch selected"}</div></div>
          <div style={{ display: "flex", alignItems: "end" }}><button className="btn btn-primary" disabled={busy} onClick={generateActivation}><KeyRound /> Generate code</button></div>
        </div>
        {activation.code && (
          <div className="notice" style={{ marginTop: 12, textAlign: "center" }}>
            <div style={{ fontSize: 13, fontWeight: 700, letterSpacing: 0 }}>Enter this code in the VISIONPOS Cashier app</div>
            <div style={{ fontSize: 24, fontWeight: 950, letterSpacing: ".1em", marginTop: 6 }}>{activation.code}</div>
          </div>
        )}
        {msg && <div className="notice" style={{ marginTop: 12 }}>{msg}</div>}
      </div>
      <div className="tablewrap">
        <table><thead><tr><th>Terminal</th><th>Branch</th><th>Status</th><th>Version</th><th>Last seen</th><th>Actions</th></tr></thead><tbody>
          {terminals.length === 0 ? <tr><td colSpan="6">No activated terminals yet. Generate a code, then activate the desktop app.</td></tr> : terminals.map((t) => (
            <tr key={t.uuid}>
              <td><b>{t.terminalName}</b><div className="muted mono">{String(t.uuid || "").slice(0, 8)}...</div></td>
              <td>{bn(t.branchId) || "Unassigned"}</td>
              <td><span className={"ist " + (t.status === "ACTIVE" ? "paid" : t.status === "DISABLED" ? "hold" : "bad")}>{t.status}</span></td>
              <td>{t.appVersion || "-"}</td>
              <td>{t.lastSeen ? new Date(t.lastSeen).toLocaleString() : "Never"}</td>
              <td style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                <button className="btn xs btn-ghost" disabled={busy} onClick={() => { const name = prompt("Rename terminal", t.terminalName || ""); if (name) updateTerminal(t, { terminalName: name }); }}><Edit /> Rename</button>
                {t.status === "ACTIVE" ? <button className="btn xs btn-ghost" disabled={busy} onClick={() => updateTerminal(t, { action: "disable" })}><X /> Disable</button> : <button className="btn xs btn-ghost" disabled={busy || t.status === "REVOKED"} onClick={() => updateTerminal(t, { action: "activate" })}><Check /> Enable</button>}
                <button className="btn xs btn-ghost" disabled={busy || t.status === "REVOKED"} onClick={() => updateTerminal(t, { action: "revoke" })}><Trash2 /> Revoke</button>
              </td>
            </tr>
          ))}
        </tbody></table>
      </div>
    </div>
  );
}
function UsersTab({ data, update, isAdmin }) {
  const [adding, setAdding] = useState(false);
  const [f, setF] = useState({ name: "", role: ROLES[0], pin: "", email: "", password: "", branchId: data.branches[0]?.id || "", rights: ROLE_RIGHTS.Cashier.slice() });
  const [err, setErr] = useState(""); const [reveal, setReveal] = useState({}); const [editRights, setEditRights] = useState(null);
  const [delMsg, setDelMsg] = useState("");
  const [credEdit, setCredEdit] = useState(null); // employee id whose PIN/password is being changed
  const [credVal, setCredVal] = useState(""); const [credErr, setCredErr] = useState("");
  const [adminCred, setAdminCred] = useState(false); const [adminPw, setAdminPw] = useState(""); const [adminErr, setAdminErr] = useState("");
  const [fpEnroll, setFpEnroll] = useState(null);
  const [fpFirst, setFpFirst] = useState(null);
  const [fpBusy, setFpBusy] = useState(false);
  const [fpErr, setFpErr] = useState("");
  const [fpMsg, setFpMsg] = useState("");
  const [fpPreview, setFpPreview] = useState(null);
  const [fpComplete, setFpComplete] = useState(false);
  const fpCloseTimer = useRef(null);
  const [terminals, setTerminals] = useState([]);
  const [terminalBusy, setTerminalBusy] = useState(false);
  const [userBusy, setUserBusy] = useState(false);
  const [emergencyPinEdit, setEmergencyPinEdit] = useState(null);
  const [emergencyPin, setEmergencyPin] = useState("");
  const [emergencyPinError, setEmergencyPinError] = useState("");
  const visibleEmployees = (data.employees || []).filter((employee) => employee.status !== "deleted");
  useEffect(() => () => {
    if (fpCloseTimer.current) clearTimeout(fpCloseTimer.current);
  }, []);
  useEffect(() => {
    let cancelled = false;
    authGet("/api/auth/users", { session: true }).then((result) => {
      if (cancelled || !Array.isArray(result?.users)) return;
      update((current) => {
        const employees = Array.isArray(current.employees) ? current.employees : [];
        const byId = new Map(employees.map((employee) => [String(employee.id), employee]));
        let changed = false;
        for (const cloudUser of result.users) {
          const previous = byId.get(String(cloudUser.id));
          const merged = previous ? { ...previous, ...cloudUser, synced: true } : { ...cloudUser, synced: true };
          if (!previous || JSON.stringify(previous) !== JSON.stringify(merged)) changed = true;
          byId.set(String(cloudUser.id), merged);
        }
        return changed ? { ...current, employees: Array.from(byId.values()) } : current;
      });
    }).catch((error) => {
      if (!cancelled) setErr("Could not refresh cloud users: " + credentialMessage(error));
    });
    return () => { cancelled = true; };
  }, []);
  const isBranchWideRole = ["Supervisor", "Manager"].includes(f.role);
  const activeTerminalForBranch = (branchId) => terminals.find((terminal) => (
    String(terminal.branchId || "") === String(branchId || "")
    && String(terminal.status || "").toUpperCase() === "ACTIVE"
  ));
  const selectedTerminal = activeTerminalForBranch(f.branchId);
  const credentialMessage = (error) => {
    const message = String(error?.message || "");
    if (message.includes("duplicate_pin")) return "That PIN is already assigned to another employee.";
    if (message.includes("branch_terminal_required")) return "This branch has no active terminal. Activate one in Terminals before creating or updating branch users.";
    if (message.includes("branch_required")) return "Select a branch for this user.";
    if (message.includes("emergency_pin_invalid")) return "Emergency checkout PIN must be exactly 4 digits.";
    if (message.includes("supervisor_account_required")) return "Emergency checkout PINs are only available to supervisors, managers, and administrators.";
    if (message.includes("too_many_override_attempts")) return "Too many failed attempts. Wait 10 minutes before trying again.";
    return message || "Cloud user validation failed.";
  };
  const saveCloudCredential = (emp, secret = {}) => authApi("/api/auth/users", { ...emp, ...secret }, { session: true });
  const openCred = (id) => { setCredEdit(id); setCredVal(""); setCredErr(""); setEditRights(null); };
  const saveCred = async (emp) => {
    if (emp.role === "Cashier") {
      if (!emp.branchId) return setCredErr("This cashier must be assigned to a branch.");
      if (!activeTerminalForBranch(emp.branchId)) return setCredErr("This branch has no active terminal. Activate one before changing cashier credentials.");
      if (!/^\d{4}$/.test(credVal)) return setCredErr("PIN must be 4 digits.");
      if (visibleEmployees.some((e) => e.id !== emp.id && e.pin === credVal)) return setCredErr("That PIN's already in use.");
    } else {
      const issue = passwordIssue(credVal); if (issue) return setCredErr(issue);
    }
    setUserBusy(true);
    try {
      const secret = emp.role === "Cashier" ? { pin: credVal } : { password: credVal };
      await saveCloudCredential(emp, secret);
      update((d) => ({ ...d, employees: d.employees.map((e) => e.id === emp.id ? { ...e, ...secret, synced: false } : e) }));
      setCredEdit(null); setCredVal(""); setCredErr("");
    } catch (error) {
      setCredErr(credentialMessage(error));
    } finally {
      setUserBusy(false);
    }
  };
  const saveAdminPw = () => {
    const issue = passwordIssue(adminPw); if (issue) return setAdminErr(issue);
    update((d) => ({ ...d, admin: { ...d.admin, password: adminPw } }));
    setAdminCred(false); setAdminPw(""); setAdminErr("");
  };
  const openEmergencyPin = (id) => {
    setEmergencyPinEdit((current) => current === id ? null : id);
    setEmergencyPin("");
    setEmergencyPinError("");
    setCredEdit(null);
    setEditRights(null);
  };
  const saveEmergencyPin = async (emp) => {
    if (!/^\d{4}$/.test(emergencyPin)) return setEmergencyPinError("Emergency checkout PIN must be exactly 4 digits.");
    setUserBusy(true);
    setEmergencyPinError("");
    try {
      await authApi(`/api/auth/users/${encodeURIComponent(emp.id)}/emergency-pin`, { pin: emergencyPin }, { session: true });
      setEmergencyPinEdit(null);
      setEmergencyPin("");
    } catch (error) {
      setEmergencyPinError(credentialMessage(error));
    } finally {
      setUserBusy(false);
    }
  };
  const reset = () => { setF({ name: "", role: ROLES[0], pin: "", email: "", password: "", branchId: data.branches[0]?.id || "", rights: ROLE_RIGHTS.Cashier.slice() }); setErr(""); setAdding(false); };
  const setRole = (role) => setF((p) => ({
    ...p,
    role,
    rights: (ROLE_RIGHTS[role] || []).slice(),
    branchId: ["Supervisor", "Manager"].includes(role) ? "" : (p.branchId || data.branches[0]?.id || ""),
  }));
  const toggleNew = (r) => setF((p) => { const cur = rightsList(p.rights); return { ...p, rights: cur.includes(r) ? cur.filter((x) => x !== r) : [...cur, r] }; });
  const add = async () => {
    if (!f.name.trim()) return setErr("Add a name.");
    if (f.role === "Cashier" && !f.branchId) return setErr("Select a branch for this cashier.");
    if (f.role === "Cashier" && !selectedTerminal) return setErr("This branch has no active terminal. Activate one in Terminals before creating cashiers.");
    let emp;
    let secret;
    if (f.role === "Cashier") {
      if (!/^\d{4}$/.test(f.pin)) return setErr("Cashiers sign in with a 4-digit PIN.");
      if (visibleEmployees.some((e) => e.pin === f.pin)) return setErr("That PIN's taken.");
      emp = { id: uid("e"), name: f.name.trim(), role: f.role, pin: f.pin, branchId: f.branchId, rights: f.rights, status: "active", synced: false };
      secret = { pin: f.pin };
    } else {
      const em = f.email.trim().toLowerCase();
      if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(em)) return setErr("Enter a valid email for this user.");
      const pwIssue = passwordIssue(f.password); if (pwIssue) return setErr(pwIssue);
      if (f.pin && !/^\d{4}$/.test(f.pin)) return setErr("Emergency checkout PIN must be exactly 4 digits.");
      if (f.pin && visibleEmployees.some((e) => e.pin === f.pin)) return setErr("That PIN's taken.");
      if (em === data.admin.email.toLowerCase() || visibleEmployees.some((e) => (e.email || "").toLowerCase() === em)) return setErr("That email is already in use.");
      emp = { id: uid("e"), name: f.name.trim(), role: f.role, email: em, password: f.password, branchId: f.branchId || null, rights: f.rights, status: "active", synced: false };
      secret = { password: f.password, ...(f.pin ? { pin: f.pin } : {}) };
    }
    setUserBusy(true);
    try {
      const result = await saveCloudCredential(emp, secret);
      const savedEmployee = result?.user ? { ...emp, ...result.user, synced: true } : emp;
      update((d) => ({ ...d, employees: [...d.employees.filter((employee) => employee.id !== savedEmployee.id), savedEmployee] }));
      reset();
    } catch (error) {
      setErr(credentialMessage(error));
    } finally {
      setUserBusy(false);
    }
  };
  const remove = (id) => {
    const emp = data.employees.find((e) => e.id === id); if (!emp) return;
    const pendInv = operationalInvoices(data).filter((i) => i.cashierId === id && invOutstanding(i) > 0);
    if (pendInv.length) { setDelMsg(emp.name + " can't be deleted — " + pendInv.length + " pending invoice(s) are still outstanding under this user. Clear them first."); return; }
    setDelMsg("");
    update((d) => ({ ...d, employees: d.employees.map((e) => e.id === id ? { ...e, status: "deleted", synced: false, updatedAt: now() } : e) }));
    authApi("/api/auth/users/" + encodeURIComponent(id) + "/delete", {}, { session: true }).catch((error) => {
      setDelMsg("User hidden locally, but cloud deletion was not completed: " + error.message);
    });
  };
  const setEmployeeEnabled = async (employee, enabled) => {
    const status = enabled ? "active" : "inactive";
    setUserBusy(true);
    setDelMsg("");
    try {
      const result = await authApi(`/api/auth/users/${encodeURIComponent(employee.id)}/status`, { status }, { session: true });
      update((current) => ({
        ...current,
        employees: current.employees.map((item) => item.id === employee.id
          ? { ...item, ...(result?.user || {}), status, synced: true }
          : item),
      }));
      if (!enabled) {
        setCredEdit(null);
        setEditRights(null);
        setEmergencyPinEdit(null);
      }
      setDelMsg(`${employee.name} ${enabled ? "enabled" : "disabled"} successfully.`);
    } catch (error) {
      setDelMsg(`Could not ${enabled ? "enable" : "disable"} ${employee.name}: ${credentialMessage(error)}`);
    } finally {
      setUserBusy(false);
    }
  };
  const openFingerprintEnroll = (emp) => {
    if (fpCloseTimer.current) clearTimeout(fpCloseTimer.current);
    fpCloseTimer.current = null;
    setFpEnroll(emp);
    setFpFirst(null);
    setFpPreview(null);
    setFpComplete(false);
    setFpErr("");
    setFpMsg(emp.fingerprintEnrolled
      ? "This user already has an enrolled fingerprint. Capture twice to replace it."
      : "Capture 1 of 2. Ask the user to place their finger on the SecuGen Hamster reader.");
  };
  const closeFingerprintEnroll = () => {
    if (fpCloseTimer.current) clearTimeout(fpCloseTimer.current);
    fpCloseTimer.current = null;
    setFpEnroll(null);
    setFpFirst(null);
    setFpPreview(null);
    setFpComplete(false);
    setFpErr("");
    setFpMsg("");
  };
  const captureFingerprintEnrollment = async () => {
    if (!fpEnroll) return;
    setFpBusy(true);
    setFpErr("");
    try {
      const capture = await secugenCapture();
      setFpPreview(capture);
      if (!fpFirst) {
        setFpFirst(capture);
        setFpMsg("Capture 2 of 2. Lift the finger, place it again, then scan.");
        return;
      }
      const match = await secugenVerify(fpFirst.template, capture.template);
      if (!match.ok) {
        setFpFirst(null);
        setFpMsg("The two captures did not match. Start again with capture 1 of 2.");
        setFpErr("Fingerprint verification failed.");
        return;
      }
      await authApi("/api/auth/fingerprints/enroll", { userId: fpEnroll.id, template: capture.template, deviceSerial: capture.deviceSerial }, { session: true });
      update((current) => ({
        ...current,
        employees: current.employees.map((employee) => employee.id === fpEnroll.id
          ? { ...employee, fingerprintEnrolled: true }
          : employee),
      }));
      setFpEnroll((current) => current ? { ...current, fingerprintEnrolled: true } : current);
      setFpComplete(true);
      setFpMsg("Fingerprint enrolled successfully. Closing...");
      setFpFirst(null);
      fpCloseTimer.current = setTimeout(closeFingerprintEnroll, 1100);
    } catch (error) {
      setFpErr(secugenMessage(error));
    } finally {
      setFpBusy(false);
    }
  };
  const removeFingerprintEnrollment = async () => {
    if (!fpEnroll) return;
    setFpBusy(true);
    setFpErr("");
    try {
      await authApi("/api/auth/fingerprints/remove", { userId: fpEnroll.id }, { session: true });
      update((current) => ({
        ...current,
        employees: current.employees.map((employee) => employee.id === fpEnroll.id
          ? { ...employee, fingerprintEnrolled: false }
          : employee),
      }));
      setFpEnroll((current) => current ? { ...current, fingerprintEnrolled: false } : current);
      setFpFirst(null);
      setFpPreview(null);
      setFpMsg("Fingerprint removed for " + fpEnroll.name + ".");
    } catch (error) {
      setFpErr(error.message || "Could not remove fingerprint.");
    } finally {
      setFpBusy(false);
    }
  };
  const toggleRight = (id, r) => update((d) => ({ ...d, employees: d.employees.map((e) => { if (e.id !== id) return e; const cur = rightsList(e.rights); const rights = cur.includes(r) ? cur.filter((x) => x !== r) : [...cur, r]; return { ...e, rights, synced: false }; }) }));
  const bn = (id) => data.branches.find((b) => b.id === id)?.name || "—";
  const loadTerminals = async () => {
    setTerminalBusy(true);
    try {
      const result = await authGet("/api/auth/terminals", { session: true });
      setTerminals(result.terminals || []);
    } catch (error) {
      setErr("Could not load terminals: " + error.message);
    } finally {
      setTerminalBusy(false);
    }
  };
  useEffect(() => { if (isAdmin) loadTerminals(); }, [isAdmin]); // eslint-disable-line
  const RightsGrid = ({ selected, onToggle }) => {
    const selectedRights = rightsList(selected);
    return <div className="rights-grid">{RIGHTS.map((r) => { const on = selectedRights.includes(r.id); return (
      <button key={r.id} type="button" className={"rightchip" + (on ? " on" : "")} onClick={() => onToggle(r.id)}>{on ? <Check /> : <Plus />} {r.label}</button>); })}</div>;
  };
  return (
    <div><PageHead title="Users & Security" sub="Cashiers sign in with a PIN at their branch. Supervisors and managers sign in with email, password, and an email code." />
      {delMsg && <div className="notice" style={{ marginBottom: 12, borderColor: "var(--danger)" }}><AlertCircle style={{ width: 14, height: 14, verticalAlign: "-2px", color: "var(--danger)" }} /> {delMsg} <button className="linknum" onClick={() => setDelMsg("")} style={{ marginLeft: 8 }}>dismiss</button></div>}
      <div className="row" style={{ marginBottom: adminCred ? 8 : 14 }}><div className="avatar"><ShieldCheck style={{ width: 18, height: 18 }} /></div>
        <div className="meta"><div className="nm">Admin · {data.admin.email}</div><div className="mt2">Full access · all branches · all rights</div></div>
        <button className="btn xs btn-ghost" onClick={() => { setAdminCred((v) => !v); setAdminPw(""); setAdminErr(""); }}><Lock /> Change password</button>
        <button className="btn xs btn-ghost" onClick={() => openEmergencyPin("admin")}><KeyRound /> Emergency PIN</button>
        <span className="ist paid">owner</span></div>
      {adminCred && (
        <div className="addpanel fade" style={{ marginBottom: 14 }}>
          <div className="label" style={{ marginBottom: 8 }}>New password for the owner admin</div>
          <div style={{ display: "flex", gap: 10, alignItems: "flex-start" }}>
            <input className="input" type="text" value={adminPw} onChange={(e) => { setAdminPw(e.target.value); setAdminErr(""); }} placeholder="8+ chars, upper, number, symbol" style={{ flex: 1 }} />
            <button className="btn btn-primary" style={{ width: "auto", padding: "0 16px" }} onClick={saveAdminPw}><Check /> Save</button>
            <button className="btn btn-ghost" style={{ width: "auto", padding: "0 16px" }} onClick={() => { setAdminCred(false); setAdminPw(""); setAdminErr(""); }}>Cancel</button>
          </div>
          {adminErr && <div className="alert" style={{ marginTop: 10 }}><AlertCircle />{adminErr}</div>}
        </div>
      )}
      {emergencyPinEdit === "admin" && (
        <div className="addpanel fade" style={{ marginBottom: 14 }}>
          <div className="label" style={{ marginBottom: 8 }}>Emergency checkout PIN for the owner admin</div>
          <div className="notice" style={{ marginBottom: 10 }}>Use only when fingerprint checkout is unavailable. The server verifies and audits every override.</div>
          <div style={{ display: "flex", gap: 10, alignItems: "flex-start" }}>
            <input className="input mono" type="password" inputMode="numeric" autoComplete="new-password" maxLength={4} value={emergencyPin} onChange={(event) => { setEmergencyPin(event.target.value.replace(/\D/g, "").slice(0, 4)); setEmergencyPinError(""); }} placeholder="4 digits" style={{ flex: 1 }} />
            <button className="btn btn-primary" disabled={userBusy || !/^\d{4}$/.test(emergencyPin)} style={{ width: "auto", padding: "0 16px" }} onClick={() => saveEmergencyPin({ id: "admin", name: "Owner admin" })}><ShieldCheck /> {userBusy ? "Saving..." : "Save PIN"}</button>
            <button className="btn btn-ghost" disabled={userBusy} style={{ width: "auto", padding: "0 16px" }} onClick={() => { setEmergencyPinEdit(null); setEmergencyPin(""); setEmergencyPinError(""); }}>Cancel</button>
          </div>
          {emergencyPinError && <div className="alert" style={{ marginTop: 10 }}><AlertCircle />{emergencyPinError}</div>}
        </div>
      )}
      {!adding ? <button className="row-add" onClick={() => setAdding(true)}><Plus /> Add user</button> : (
        <div className="addpanel fade"><div className="grid3">
          <div><label className="label">Name</label><input className="input" value={f.name} onChange={(e) => { setF({ ...f, name: e.target.value }); setErr(""); }} placeholder="Full name" /></div>
          <div><label className="label">Role</label><select className="select" value={f.role} onChange={(e) => setRole(e.target.value)}>{ROLES.map((r) => <option key={r}>{r}</option>)}</select></div>
          <div><label className="label">Branch</label><select className="select" value={f.branchId || ""} onChange={(e) => { setF({ ...f, branchId: e.target.value }); setErr(""); }}><option value="">{isBranchWideRole ? "All branches" : "Select branch"}</option>{data.branches.map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}</select></div></div>
          {f.role === "Cashier" && <div className="notice" style={{ marginTop: 12, display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12 }}>
            <span>{terminalBusy ? "Checking active terminals..." : !f.branchId ? "Select a branch to check its terminal." : selectedTerminal ? `Active terminal detected: ${selectedTerminal.terminalName || selectedTerminal.name || "Registered terminal"}` : `No active terminal for ${bn(f.branchId)}. Activate one in Terminals before creating this user.`}</span>
            <button type="button" className="btn xs btn-ghost" onClick={loadTerminals} disabled={terminalBusy}><RefreshCw /> Refresh</button>
          </div>}
          {f.role === "Cashier" ? (
            <div className="field"><label className="label">4-digit PIN <span style={{ color: "var(--muted-2)", fontWeight: 500 }}>· cashiers sign in by PIN</span></label><input className="input mono" inputMode="numeric" maxLength={4} value={f.pin} onChange={(e) => { setF({ ...f, pin: e.target.value.replace(/\D/g, "").slice(0, 4) }); setErr(""); }} placeholder="0000" /></div>
          ) : (
            <div className="grid3">
              <div><label className="label">Email <span style={{ color: "var(--muted-2)", fontWeight: 500 }}>· signs in with password & email code</span></label><input className="input" type="email" value={f.email} onChange={(e) => { setF({ ...f, email: e.target.value }); setErr(""); }} placeholder="name@store.com" /></div>
              <div><label className="label">Password</label><input className="input" type="text" value={f.password} onChange={(e) => { setF({ ...f, password: e.target.value }); setErr(""); }} placeholder="8+ chars, upper, number, symbol" /></div>
              <div><label className="label">Emergency checkout PIN <span style={{ color: "var(--muted-2)", fontWeight: 500 }}>· optional</span></label><input className="input mono" type="password" inputMode="numeric" autoComplete="new-password" maxLength={4} value={f.pin} onChange={(e) => { setF({ ...f, pin: e.target.value.replace(/\D/g, "").slice(0, 4) }); setErr(""); }} placeholder="4 digits" /></div>
            </div>
          )}
          <div className="field"><label className="label">Access rights <span style={{ color: "var(--muted-2)", fontWeight: 500 }}>· {f.rights.length} selected · defaults from role, tap to change</span></label>
            <RightsGrid selected={f.rights} onToggle={toggleNew} /></div>
          {err && <div className="alert"><AlertCircle />{err}</div>}
          <div style={{ display: "flex", gap: 10, marginTop: 16 }}><button className="btn btn-ghost" onClick={reset} disabled={userBusy}>Cancel</button><button className="btn btn-primary" onClick={add} disabled={userBusy || (f.role === "Cashier" && (terminalBusy || !selectedTerminal))}><Check /> {userBusy ? "Creating..." : "Create user"}</button></div></div>)}
      <div className="list">{visibleEmployees.map((e) => (
        <div key={e.id}>
          <div className={"row user-security-row" + (isActiveEmployee(e) ? "" : " disabled")}><div className="avatar">{e.name.charAt(0)}</div>
            <div className="meta"><div className="nm">{e.name} {e.role === "Supervisor" && <span className="roletag sup">{e.branchId ? "Supervisor · " + bn(e.branchId) : "Supervisor"}</span>}</div><div className="mt2">{e.role} · {e.branchId ? bn(e.branchId) : "All branches"} · {(e.rights || []).length} rights</div></div>
            <span className="pill plain" title="Branch is fixed once a user is created" style={{ fontSize: 11 }}><Building2 style={{ width: 12, height: 12, verticalAlign: "-2px", marginRight: 4 }} />{e.branchId ? bn(e.branchId) : "All branches"}</span>
            <button className="btn xs btn-ghost" onClick={() => setEditRights(editRights === e.id ? null : e.id)}><ShieldCheck /> Rights</button>
            <button className="btn xs btn-ghost" onClick={() => openCred(credEdit === e.id ? null : e.id)}><Lock /> {e.role === "Cashier" ? "PIN" : "Password"}</button>
            {isAdmin && ["Supervisor", "Manager", "Admin"].includes(e.role) && <button className="btn xs btn-ghost" onClick={() => openEmergencyPin(e.id)}><KeyRound /> Emergency PIN</button>}
            <button className={"btn xs btn-ghost" + (e.fingerprintEnrolled ? " fp-enrolled-btn" : "")} onClick={() => openFingerprintEnroll(e)}>
              {e.fingerprintEnrolled ? <Check /> : <Fingerprint />} {e.fingerprintEnrolled ? "Enrolled" : "Enroll"}
            </button>
            {e.role === "Cashier"
              ? <button className="pill" onClick={() => setReveal((r) => ({ ...r, [e.id]: !r[e.id] }))}>{reveal[e.id] ? <EyeOff /> : <Eye />}{reveal[e.id] ? e.pin : "••••"}</button>
              : <span className="pill plain" style={{ fontSize: 11 }}>{e.email || "no email"}</span>}
            <button type="button" role="switch" aria-checked={isActiveEmployee(e)} disabled={userBusy}
              className={"user-enable-toggle" + (isActiveEmployee(e) ? " on" : "")}
              onClick={() => setEmployeeEnabled(e, !isActiveEmployee(e))}>
              <span className="user-enable-track"><span /></span><span>{isActiveEmployee(e) ? "Enabled" : "Disabled"}</span>
            </button>
            <button className="smdel" onClick={() => remove(e.id)}><Trash2 /></button></div>
          {credEdit === e.id && (
            <div className="addpanel fade" style={{ marginTop: 8 }}>
              <div className="label" style={{ marginBottom: 8 }}>{e.role === "Cashier" ? "New 4-digit PIN" : "New password"} for {e.name}</div>
              <div style={{ display: "flex", gap: 10, alignItems: "flex-start" }}>
                {e.role === "Cashier"
                  ? <input className="input mono" inputMode="numeric" maxLength={4} value={credVal} onChange={(ev) => { setCredVal(ev.target.value.replace(/\D/g, "").slice(0, 4)); setCredErr(""); }} placeholder="0000" style={{ flex: 1 }} />
                  : <input className="input" type="text" value={credVal} onChange={(ev) => { setCredVal(ev.target.value); setCredErr(""); }} placeholder="8+ chars, upper, number, symbol" style={{ flex: 1 }} />}
                <button className="btn btn-primary" style={{ width: "auto", padding: "0 16px" }} onClick={() => saveCred(e)}><Check /> Save</button>
                <button className="btn btn-ghost" style={{ width: "auto", padding: "0 16px" }} onClick={() => { setCredEdit(null); setCredVal(""); setCredErr(""); }}>Cancel</button>
              </div>
              {credErr && <div className="alert" style={{ marginTop: 10 }}><AlertCircle />{credErr}</div>}
            </div>
          )}
          {emergencyPinEdit === e.id && (
            <div className="addpanel fade" style={{ marginTop: 8 }}>
              <div className="label" style={{ marginBottom: 8 }}>Emergency checkout PIN for {e.name}</div>
              <div className="notice" style={{ marginBottom: 10 }}>Used only when cashier fingerprint checkout cannot be completed. Every use is branch-checked, rate-limited, and recorded in the audit log.</div>
              <div style={{ display: "flex", gap: 10, alignItems: "flex-start" }}>
                <input className="input mono" type="password" inputMode="numeric" autoComplete="new-password" maxLength={4} value={emergencyPin} onChange={(ev) => { setEmergencyPin(ev.target.value.replace(/\D/g, "").slice(0, 4)); setEmergencyPinError(""); }} onKeyDown={(ev) => { if (ev.key === "Enter") saveEmergencyPin(e); }} placeholder="4 digits" style={{ flex: 1 }} />
                <button className="btn btn-primary" disabled={userBusy || !/^\d{4}$/.test(emergencyPin)} style={{ width: "auto", padding: "0 16px" }} onClick={() => saveEmergencyPin(e)}><ShieldCheck /> {userBusy ? "Saving..." : "Save PIN"}</button>
                <button className="btn btn-ghost" disabled={userBusy} style={{ width: "auto", padding: "0 16px" }} onClick={() => { setEmergencyPinEdit(null); setEmergencyPin(""); setEmergencyPinError(""); }}>Cancel</button>
              </div>
              {emergencyPinError && <div className="alert" style={{ marginTop: 10 }}><AlertCircle />{emergencyPinError}</div>}
            </div>
          )}
          {editRights === e.id && (
            <div className="addpanel fade" style={{ marginTop: 8 }}>
              <div className="label" style={{ marginBottom: 8 }}>Access rights for {e.name}</div>
              <RightsGrid selected={e.rights || []} onToggle={(r) => toggleRight(e.id, r)} />
            </div>
          )}
        </div>))}</div>
      {fpEnroll && (
        <div className="scrim" onClick={closeFingerprintEnroll}>
          <div className="modal" style={{ maxWidth: 520 }} onClick={(e) => e.stopPropagation()}>
            <div className="modal-head"><div><div className="sub" style={{ margin: 0 }}>SecuGen Hamster</div><div className="title" style={{ fontSize: 21, display: "flex", alignItems: "center", gap: 8 }}>{fpComplete ? <Check style={{ width: 20, height: 20, color: "var(--success)" }} /> : <Fingerprint style={{ width: 20, height: 20 }} />} {fpComplete ? "Fingerprint Enrolled" : "Enroll Fingerprint"}</div></div><button className="iconbtn" onClick={closeFingerprintEnroll}><X /></button></div>
            <div className="notice" style={{ marginTop: 12, textAlign: "left" }}>
              <b>{fpEnroll.name}</b><br />
              {fpMsg || "Capture fingerprint twice to verify it belongs to this user. Only the encrypted fingerprint template is stored."}
            </div>
            <div className={"fp-reader-preview" + (fpBusy ? " scanning" : "")}>
              {fpPreview?.previewUrl
                ? <img src={fpPreview.previewUrl} alt="Latest fingerprint scan preview" />
                : <div className="fp-reader-empty"><Fingerprint /><b>{fpBusy ? "Scanning fingerprint..." : "Fingerprint preview"}</b><span>Place one finger flat on the reader.</span></div>}
            </div>
            <div className="fp-reader-meta">
              <span>{fpEnroll.fingerprintEnrolled
                ? <span className="fp-enrolled-status"><Check /> Enrolled</span>
                : fpFirst ? "First capture saved" : "Ready for first capture"}</span>
              <span>{fpPreview?.quality !== "" && fpPreview?.quality != null ? `Quality ${fpPreview.quality}` : "Preview is not stored"}</span>
            </div>
            {fpErr && <div className="alert"><AlertCircle />{fpErr}</div>}
            <div style={{ display: "flex", gap: 10, marginTop: 16, flexWrap: "wrap" }}>
              <button className="btn btn-primary" style={{ flex: 1, minWidth: 190 }} disabled={fpBusy || fpComplete} onClick={captureFingerprintEnrollment}>{fpComplete ? <Check /> : <Fingerprint />} {fpComplete ? "Enrolled" : fpBusy ? "Scanning..." : fpFirst ? "Capture second scan" : "Capture first scan"}</button>
              <button className="btn btn-ghost" style={{ flex: 1, minWidth: 160 }} disabled={fpBusy || fpComplete} onClick={removeFingerprintEnrollment}><Trash2 /> Remove fingerprint</button>
            </div>
            <div className="cust-meta" style={{ marginTop: 12 }}>After the one-time SecuGen driver and WebAPI Client setup, enrollment is completed here with the Capture buttons. No PowerShell command is required.</div>
          </div>
        </div>
      )}
      <div className="notice" style={{ marginTop: 12 }}>Rights determine which areas a user can open. The owner admin always has full access.</div>
    </div>
  );
}

/* ---- System Health ---- */
function formatEnvDate(value) {
  if (!value) return "Never";
  try { return new Date(value).toLocaleString(); } catch (_) { return String(value); }
}

function EnvironmentTab({ environment, onRefresh }) {
  const [state, setState] = useState(environment || null);
  const [busy, setBusy] = useState(false);
  const current = normalizeEnvironment(state?.mode || environment?.mode || "test");
  const cfg = state?.config || {};

  useEffect(() => { setState(environment || null); }, [environment]);

  const refresh = async () => {
    setBusy(true);
    try {
      const next = await onRefresh?.();
      if (next) setState(next);
    } finally {
      setBusy(false);
    }
  };

  const deploymentCard = (mode, title, description, database, api) => {
    const active = current.mode === mode;
    return (
      <div className={"env-card " + mode + (active ? " active" : "")}>
        <div className="split">
          <EnvironmentBadge mode={mode} />
          {active && <span className="pill success">Active deployment</span>}
        </div>
        <h3>{title}</h3>
        <p>{description}</p>
        <div className="env-info-row"><span>Database</span><strong>{database}</strong></div>
        <div className="env-info-row"><span>API</span><strong>{api}</strong></div>
      </div>
    );
  };

  return (
    <div>
      <PageHead
        title="Environment"
        sub="Live and Test are separate deployments. This server connects to one database at startup from its environment file."
        right={<button className="btn sm btn-ghost" onClick={refresh} disabled={busy}><RefreshCw /> {busy ? "Refreshing" : "Refresh"}</button>}
      />
      <div className="poscard env-current">
        <div>
          <div className="sub">Current deployment</div>
          <EnvironmentBadge mode={current.mode} />
        </div>
        <div className="sub">There is no in-app switch. Start the Live or Test deployment process to change environments.</div>
      </div>
      {current.mode === "test" && (
        <div className="notice warn"><AlertCircle /> TEST MODE is active. Receipts are marked as test and dashboards show a TEST watermark.</div>
      )}
      <div className="env-grid">
        {deploymentCard("test", "Sandbox / Test", "Training environment for demo terminals, receipts, inventory tests, and integrations.", "visionary_test", "https://sandbox.visionarypos.cloud")}
        {deploymentCard("live", "Production / Live", "Real business environment for permanent sales, inventory, reports, and receipts.", "visionary_live", "https://visionarypos.cloud")}
      </div>
      <div className="env-info">
        <div className="tile"><div className="k">Environment</div><div className="v">{current.label}</div></div>
        <div className="tile"><div className="k">Database</div><div className="v">{cfg.database || "Configured by DATABASE_URL"}</div></div>
        <div className="tile"><div className="k">API</div><div className="v">{cfg.api || window.location.origin}</div></div>
        <div className="tile"><div className="k">Version</div><div className="v">{cfg.version || "0.1.0"}</div></div>
      </div>
      <div className="notice" style={{ marginTop: 14 }}>
        To change environments, restart the appropriate process: <strong>npm run start:live</strong> for production or <strong>npm run start:test</strong> for sandbox. Each process uses its own DATABASE_URL, uploads, backups, logs, and credentials.
      </div>
    </div>
  );
}
function SystemHealthTab({ data, online, maintenance, onRefresh, onRunMaintenance }) {
  const [busy, setBusy] = useState("");
  const m = maintenance || {};
  const storage = m.storage || storageUsageSnapshot();
  const lastCleanup = m.lastCleanupAt ? new Date(m.lastCleanupAt).toLocaleString() : "Not yet";
  const lastSync = data.lastSyncedAt ? new Date(data.lastSyncedAt).toLocaleString() : "Not yet";
  const pendingUploads = Number(m.pendingUploads || 0);
  const syncError = pendingUploads > 0 ? (m.syncError || "") : "";
  const syncText = syncError ? "Sync error" : pendingUploads > 0 ? "Pending uploads" : "Synced";
  const run = async (mode) => {
    setBusy(mode);
    try { await onRunMaintenance?.(mode); }
    finally { setBusy(""); await onRefresh?.(); }
  };
  const storageRows = [
    ["Cache", storage.cache, "Product images, barcode/search indexes, stale API responses"],
    ["Settings", storage.settings, "Printer, scanner, API, and device configuration"],
    ["Sync Queue", storage.syncQueue, "Unsynced sales, stock updates, and offline transactions"],
    ["Authentication", storage.auth, "Current session/device token, preserved until logout"],
    ["Protected POS Data", storage.protectedData, "Sales, payments, inventory, customers, products"],
    ["Maintenance Logs", storage.maintenance, "Cleanup audit history"],
    ["Other", storage.other, "Browser-managed app data"],
  ];
  return (
    <div>
      <PageHead title="System Health" sub="Automatic maintenance, sync queue, and device storage."
        right={<div style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
          <button className="btn sm" onClick={onRefresh}><RefreshCw /> Refresh</button>
          <button className="btn sm btn-primary" disabled={!!busy} onClick={() => run("light")}><RefreshCw /> {busy === "light" ? "Running..." : "Run cleanup"}</button>
          <button className="btn sm btn-ghost" disabled={!!busy} onClick={() => run("deep")}><Boxes /> {busy === "deep" ? "Running..." : "Deep maintenance"}</button>
        </div>} />
      <div className="stats compact">
        <div className="stat"><div className="sl">Device status</div><div className={"sv" + (online ? "" : " warn")}>{online ? "Online" : "Offline"}</div></div>
        <div className="stat"><div className="sl">Sync status</div><div className={"sv" + (syncError ? " warn" : "")}>{syncText}</div></div>
        <div className="stat"><div className="sl">Pending uploads</div><div className="sv">{pendingUploads}</div></div>
        <div className="stat"><div className="sl">Storage used</div><div className="sv">{fmtBytes(storage.total)}</div></div>
      </div>
      <div className="notice" style={{ marginTop: 12 }}>
        Automatic maintenance runs at startup, hourly for lightweight cleanup, and daily for deep maintenance. It never deletes sales, payments, inventory transactions, user settings, authentication data, or the sync queue.
      </div>
      {syncError && <div className="alert" style={{ marginTop: 12 }}><AlertCircle />{syncError}</div>}
      <div className="grid2" style={{ marginTop: 14 }}>
        <div className="addpanel">
          <div className="section-title" style={{ marginTop: 0 }}>Maintenance Schedule</div>
          <div className="kv"><span>Last cleanup</span><b>{lastCleanup}</b></div>
          <div className="kv"><span>Last mode</span><b>{m.lastMode || "startup pending"}</b></div>
          <div className="kv"><span>Last sync</span><b>{lastSync}</b></div>
          <div className="kv"><span>Device ID</span><b className="mono">{m.deviceId ? m.deviceId.slice(-12) : "browser"}</b></div>
          {m.lastError && <div className="alert" style={{ marginTop: 12 }}><AlertCircle />{m.lastError}</div>}
        </div>
        <div className="addpanel">
          <div className="section-title" style={{ marginTop: 0 }}>Protected Areas</div>
          <div className="notice">Business data, sync queue, settings, and auth tokens are protected. Logout is the only flow that removes authentication state.</div>
          <div className="kv"><span>Business store</span><b>{STORE_KEY}</b></div>
          <div className="kv"><span>Sync queue</span><b>{OUTBOX_KEY}</b></div>
          <div className="kv"><span>Session</span><b>{SESSION_KEY}</b></div>
        </div>
      </div>
      <div className="tablewrap" style={{ marginTop: 14 }}>
        <table><thead><tr><th>Storage area</th><th>Size</th><th>Purpose</th></tr></thead><tbody>
          {storageRows.map(([label, size, purpose]) => <tr key={label}><td><b>{label}</b></td><td>{fmtBytes(size)}</td><td>{purpose}</td></tr>)}
        </tbody></table>
      </div>
      <div className="section-title" style={{ margin: "18px 0 8px" }}>Maintenance Audit Log</div>
      <div className="tablewrap">
        <table><thead><tr><th>Time</th><th>Action</th><th>Details</th></tr></thead><tbody>
          {(m.audit || []).length === 0 ? <tr><td colSpan="3">No maintenance actions recorded yet.</td></tr> : (m.audit || []).map((row) => (
            <tr key={row.id}><td>{new Date(row.ts).toLocaleString()}</td><td>{row.action}</td><td>{(row.detail?.actions || []).join(", ") || `${row.detail?.removed?.length || 0} cache item(s) removed`}</td></tr>
          ))}
        </tbody></table>
      </div>
    </div>
  );
}

/* ---- Settings ---- */
function SettingsTab({ data, update }) {
  const s = data.settings; const set = (patch) => update((d) => ({ ...d, settings: { ...d.settings, ...patch } }));
  return (
    <div><PageHead title="Settings" sub="Store-wide configuration." />
      <div className="addpanel"><div className="grid2">
        <div><label className="label">Store name</label><input className="input" value={s.store} onChange={(e) => set({ store: e.target.value })} /></div>
        <div><label className="label">Currency</label><select className="select" value={s.currency} onChange={(e) => set({ currency: e.target.value })}><option value="KES">KES — Kenyan Shilling</option><option value="$">USD — US Dollar</option></select></div></div>
        <div className="grid2" style={{ marginTop: 12 }}>
          <div><label className="label">Theme</label><select className="select" value={s.theme || "light"} onChange={(e) => set({ theme: e.target.value })}><option value="light">Light</option><option value="dark">Dark</option></select></div>
          <div><label className="label">Default reorder level</label><input className="input" inputMode="numeric" value={s.reorderLevel} onChange={(e) => set({ reorderLevel: parseInt(e.target.value, 10) || 0 })} /></div></div></div>
      <div className="section-title" style={{ margin: "18px 0 8px", display: "flex", alignItems: "center", gap: 8 }}><Smartphone style={{ width: 16, height: 16, color: "var(--accent)" }} /> Receipt till number</div>
      <div className="addpanel">
        <div><label className="label">Default till (fallback for branches with none set)</label><input className="input" inputMode="numeric" value={s.mpesaTill || ""} onChange={(e) => set({ mpesaTill: e.target.value })} placeholder="e.g. 5204512" /></div>
        <div className="notice" style={{ marginTop: 12 }}>Each branch can have its own till — set it per branch under <b>Branches</b>. This default is only used for branches without one. The till prints on customer receipts; it is for display only and does not collect payment.</div>
      </div>
      <div className="notice">Changes save automatically. Prices are stored in cents.</div>
    </div>
  );
}

