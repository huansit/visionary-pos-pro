import { Router } from "express";
import { requireAdminOrSupervisor } from "../auth.js";
import { publicEnvironment } from "../config.js";
import { getEnvironmentState } from "../environment.js";

const router = Router();

router.get("/public", (_req, res) => {
  res.json(publicEnvironment());
});

router.get("/", requireAdminOrSupervisor, async (_req, res, next) => {
  try {
    res.json({ ok: true, environment: await getEnvironmentState() });
  } catch (error) {
    next(error);
  }
});

export default router;
