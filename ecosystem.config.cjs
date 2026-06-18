// PM2 process config. Start with:  pm2 start ecosystem.config.cjs --env production
module.exports = {
  apps: [
    {
      name: "visionary-api",
      script: "./src/server.js",
      instances: 1,            // bump to "max" for cluster mode on a multi-core VPS
      exec_mode: "fork",       // change to "cluster" if instances > 1
      watch: false,
      max_memory_restart: "300M",
      env_production: { NODE_ENV: "production" },
    },
  ],
};
