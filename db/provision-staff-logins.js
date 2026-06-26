import bcrypt from "bcryptjs";
import { isMySql, pool, q } from "../src/db.js";

const rounds = parseInt(process.env.BCRYPT_ROUNDS || "12", 10);

const staff = [
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
  const rights = { rights: user.rights || [] };

  if (isMySql) {
    await q(
      `INSERT INTO credentials (id, kind, name, email, phone, pin_hash, password_hash, branch_id, rights)
       VALUES ($1,$2,$3,$4,NULL,$5,$6,$7,$8)
       ON DUPLICATE KEY UPDATE
         kind = VALUES(kind),
         name = VALUES(name),
         email = VALUES(email),
         pin_hash = VALUES(pin_hash),
         password_hash = VALUES(password_hash),
         branch_id = VALUES(branch_id),
         rights = VALUES(rights),
         updated_at = NOW()`,
      [user.id, user.kind, user.name, email, pinHash, passwordHash, user.branchId || null, rights]
    );
  } else {
    await q(
      `INSERT INTO credentials (id, kind, name, email, phone, pin_hash, password_hash, branch_id, rights)
       VALUES ($1,$2,$3,$4,NULL,$5,$6,$7,$8)
       ON CONFLICT (id) DO UPDATE SET
         kind = EXCLUDED.kind,
         name = EXCLUDED.name,
         email = EXCLUDED.email,
         pin_hash = EXCLUDED.pin_hash,
         password_hash = EXCLUDED.password_hash,
         branch_id = EXCLUDED.branch_id,
         rights = EXCLUDED.rights,
         updated_at = now()`,
      [user.id, user.kind, user.name, email, pinHash, passwordHash, user.branchId || null, rights]
    );
  }
}

try {
  for (const user of staff) {
    await upsertCredential(user);
    const login = user.pin ? `PIN ${user.pin}` : `${user.email} / ${user.password}`;
    console.log(`Provisioned ${user.name} (${user.role}, ${user.branchId || "all branches"}) - ${login}`);
  }
  console.log("Staff cloud logins are ready.");
} finally {
  await pool.end?.();
}
