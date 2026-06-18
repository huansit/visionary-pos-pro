import bcrypt from "bcryptjs";
import "dotenv/config";

const [, , secret] = process.argv;
if (!secret) {
  console.error('usage: node db/hash-credential.js "<password-or-pin>"');
  process.exit(1);
}

const rounds = parseInt(process.env.BCRYPT_ROUNDS || "12", 10);
if (!Number.isInteger(rounds) || rounds < 10) {
  console.error("BCRYPT_ROUNDS must be an integer >= 10");
  process.exit(1);
}

console.log(await bcrypt.hash(secret, rounds));
