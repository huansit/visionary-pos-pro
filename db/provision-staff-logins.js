import bcrypt from "bcryptjs";
import { isMySql, pool, q } from "../src/db.js";

const mode = String(process.env.VISIONPOS_MODE || "").trim().toLowerCase();
if (
  (process.env.NODE_ENV !== "test" && mode !== "test") ||
  process.env.ALLOW_DEMO_STAFF_SEED !== "1"
) {
  throw new Error(
    "Refusing to provision demo staff. Use the Test environment and explicitly set ALLOW_DEMO_STAFF_SEED=1."
  );
}

const rounds = parseInt(process.env.BCRYPT_ROUNDS || "12", 10);

const staff = [
  {
    id: "admin",
    kind: "admin",
    name: process.env.ADMIN_NAME || "Owner",
    role: "Admin",
    email: (process.env.ADMIN_EMAIL || "admin@visionary.app").trim().toLowerCase(),
    phone: process.env.ADMIN_PHONE || null,
    password: process.env.ADMIN_PASSWORD || "Admin@123",
    branchId: null,
    rights: { admin: true },
  },
  {
    id: "e1",
    kind: "user",
    name: "Maya Chen",
    role: "Supervisor",
    email: "maya@visionary.app",
    password: "Maya@123",
    branchId: "b_sip",
    rights: ["sell", "invoices", "customers", "stock", "expenses", "documents"],
  },
  {
    id: "e2",
    kind: "cashier",
    name: "Theo Park",
    role: "Cashier",
    pin: "1357",
    branchId: "b_cpt",
    rights: ["sell", "customers"],
  },
  {
    id: "e3",
    kind: "cashier",
    name: "John",
    role: "Cashier",
    pin: "1111",
    branchId: "b_sip",
    rights: ["sell", "customers"],
  },
  {
    id: "e4",
    kind: "cashier",
    name: "Amina Yusuf",
    role: "Cashier",
    pin: "2222",
    branchId: "b_cpt",
    rights: ["sell", "customers"],
  },
];

async function upsertCredential(user) {
  const pinHash = user.pin ? await bcrypt.hash(String(user.pin), rounds) : null;
  const passwordHash = user.password ? await bcrypt.hash(String(user.password), rounds) : null;
  const email = user.email ? String(user.email).trim().toLowerCase() : null;
  const phone = user.phone ? String(user.phone).trim() : null;
  const rights = user.kind === "admin" ? { admin: true } : { rights: user.rights || [] };

  if (isMySql) {
    await q(
      `INSERT INTO credentials (id, kind, name, email, phone, pin_hash, password_hash, branch_id, rights)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
       ON DUPLICATE KEY UPDATE
         kind = VALUES(kind),
         name = VALUES(name),
         email = VALUES(email),
         phone = VALUES(phone),
         pin_hash = VALUES(pin_hash),
         password_hash = VALUES(password_hash),
         branch_id = VALUES(branch_id),
         rights = VALUES(rights),
         updated_at = NOW()`,
      [user.id, user.kind, user.name, email, phone, pinHash, passwordHash, user.branchId || null, rights]
    );
  } else {
    await q(
      `INSERT INTO credentials (id, kind, name, email, phone, pin_hash, password_hash, branch_id, rights)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
       ON CONFLICT (id) DO UPDATE SET
         kind = EXCLUDED.kind,
         name = EXCLUDED.name,
         email = EXCLUDED.email,
         phone = EXCLUDED.phone,
         pin_hash = EXCLUDED.pin_hash,
         password_hash = EXCLUDED.password_hash,
         branch_id = EXCLUDED.branch_id,
         rights = EXCLUDED.rights,
         updated_at = now()`,
      [user.id, user.kind, user.name, email, phone, pinHash, passwordHash, user.branchId || null, rights]
    );
  }
}

try {
  for (const user of staff) {
    await upsertCredential(user);
    const login = user.pin ? `PIN ${user.pin}` : `${user.email} / ${user.password}`;
    console.log(`Provisioned ${user.name} (${user.role}, ${user.branchId || "all branches"}) - ${login}`);
  }
  console.log("Admin and staff cloud logins are ready.");
} finally {
  await pool.end?.();
}
