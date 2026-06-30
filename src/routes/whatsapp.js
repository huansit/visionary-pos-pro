import { Router } from "express";
import { processWhatsAppCommand } from "../services/whatsappCommands.js";
import { sendWhatsAppText } from "../services/whatsappClient.js";
import { auditWhatsApp } from "../services/whatsappAudit.js";

const router = Router();

function extractMessages(body) {
  const messages = [];
  for (const entry of body?.entry || []) {
    for (const change of entry?.changes || []) {
      const value = change?.value || {};
      for (const message of value.messages || []) {
        if (message.type !== "text") continue;
        messages.push({
          from: message.from,
          id: message.id,
          text: message.text?.body || "",
        });
      }
    }
  }
  return messages;
}

router.get("/webhook", (req, res) => {
  const mode = req.query["hub.mode"];
  const token = req.query["hub.verify_token"];
  const challenge = req.query["hub.challenge"];
  if (mode === "subscribe" && token && token === process.env.WHATSAPP_VERIFY_TOKEN) {
    return res.status(200).send(challenge);
  }
  return res.status(403).send("verification_failed");
});

router.post("/webhook", async (req, res) => {
  const messages = extractMessages(req.body);
  res.status(200).json({ ok: true, received: messages.length });

  for (const message of messages) {
    try {
      const reply = await processWhatsAppCommand({ from: message.from, text: message.text, req });
      await sendWhatsAppText(message.from, reply);
    } catch (error) {
      console.error("WhatsApp webhook message failed:", error);
      try {
        await auditWhatsApp("whatsapp_webhook_failed", {
          phone: message.from,
          command: message.text,
          status: "failed",
          detail: { error: error.message, messageId: message.id },
          req,
        });
      } catch (auditError) {
        console.error("WhatsApp webhook audit failed:", auditError);
      }
    }
  }
});

router.post("/commands/test", async (req, res, next) => {
  try {
    if (process.env.NODE_ENV === "production" && process.env.WHATSAPP_TEST_ENDPOINT !== "1") {
      return res.status(404).json({ error: "not_found" });
    }
    const reply = await processWhatsAppCommand({
      from: req.body?.from || "test",
      text: req.body?.text || "help",
      req,
    });
    res.json({ reply });
  } catch (error) {
    next(error);
  }
});

export default router;
