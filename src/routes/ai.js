import { Router } from "express";

const router = Router();

router.post("/ask", async (req, res, next) => {
  try {
    const apiKey = process.env.ANTHROPIC_API_KEY;
    if (!apiKey) return res.status(503).json({ error: "ai_not_configured" });

    const system = String(req.body?.system || "").trim();
    const messages = Array.isArray(req.body?.messages) ? req.body.messages : [];
    const maxTokens = Math.min(Math.max(Number(req.body?.maxTokens || 400), 64), 1200);
    const model = process.env.ANTHROPIC_MODEL || "claude-sonnet-4-6";
    if (!system || !messages.length) return res.status(400).json({ error: "system_and_messages_required" });

    const response = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": apiKey,
        "anthropic-version": process.env.ANTHROPIC_VERSION || "2023-06-01",
      },
      body: JSON.stringify({
        model,
        max_tokens: maxTokens,
        system,
        messages: messages.map((m) => ({ role: m.role === "assistant" ? "assistant" : "user", content: String(m.content || "") })),
      }),
    });

    const json = await response.json().catch(() => ({}));
    if (!response.ok) {
      return res.status(response.status).json({
        error: json.error?.type || json.error?.message || "ai_request_failed",
      });
    }

    const text = (json.content || [])
      .map((block) => (block.type === "text" ? block.text : ""))
      .join("\n")
      .trim();
    res.json({ text, model });
  } catch (error) {
    next(error);
  }
});

export default router;
