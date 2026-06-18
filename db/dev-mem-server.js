process.env.PG_MEM = "1";
process.env.DATABASE_URL ||= "postgres://dev:dev@localhost:5432/visionary_mem";
process.env.DEVICE_TOKEN_SECRET ||= "dev-memory-device-token-secret";
process.env.DEVICE_SETUP_KEY ||= "dev-setup";
process.env.HOST ||= "127.0.0.1";
process.env.PORT ||= "3000";

await import("../src/server.js");
