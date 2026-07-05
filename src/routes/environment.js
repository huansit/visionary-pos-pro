import { Router } from "express";
import { requireAdminOrSupervisor } from "../auth.js";
import { getEnvironmentState, switchEnvironment } from "../environment.js";

const router = Router();

function isOwner(account) {
  const role = String(account?.role || account?.kind || "").toLowerCase();
  const rights = account?.rights && typeof account.rights === "object" ? account.rights : {};
  return role === "owner" || rights.owner === true || String(rights.role || "").toLowerCase() === "owner";
}

router.get("/public", async (_req, res, next) => {
  try {
    res.json({ ok: true, environment: await getEnvironmentState({ includeBlockers: false }) });
  } catch (error) {
    next(error);
  }
});

router.get("/", requireAdminOrSupervisor, async (_req, res, next) => {
  try {
    res.json({ ok: true, environment: await getEnvironmentState({ includeBlockers: true }) });
  } catch (error) {
    next(error);
  }
});

router.post("/switch", requireAdminOrSupervisor, async (req, res, next) => {
  try {
    if (!isOwner(req.account)) return res.status(403).json({ error: "owner_required" });
    const environment = await switchEnvironment({
      req,
      user: { ...req.account, sessionId: req.sessionId },
      mode: req.body?.mode,
      confirmation: req.body?.confirmation,
    });
    res.json({ ok: true, environment });
  } catch (error) {
    if (error.status) {
      return res.status(error.status).json({
        error: error.message,
        blockers: error.blockers || [],
      });
    }
    next(error);
  }
});

export default router;
