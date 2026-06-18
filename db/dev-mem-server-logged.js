import { createWriteStream } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const log = createWriteStream(join(here, "..", "dev-mem-runtime.log"), { flags: "a" });
const write = (...args) => log.write(args.map((arg) => typeof arg === "string" ? arg : JSON.stringify(arg)).join(" ") + "\n");

console.log = (...args) => write(...args);
console.error = (...args) => write(...args);
process.on("uncaughtException", (error) => write("uncaughtException", error.stack || error.message));
process.on("unhandledRejection", (error) => write("unhandledRejection", error?.stack || error?.message || error));

await import("./dev-mem-server.js");
