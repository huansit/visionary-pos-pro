// PM2 process config. Start with: pm2 start ecosystem.config.cjs
module.exports = {
  apps: [
    {
      name: "visionary-live",
      script: "npm",
      args: "run start:live",
      cwd: __dirname,
      instances: 1,
      exec_mode: "fork",
      watch: false,
      max_memory_restart: "300M",
    },
    {
      name: "visionary-test",
      script: "npm",
      args: "run start:test",
      cwd: __dirname,
      instances: 1,
      exec_mode: "fork",
      watch: false,
      max_memory_restart: "300M",
    },
  ],
};
