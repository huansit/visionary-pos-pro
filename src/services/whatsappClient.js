const apiVersion = process.env.WHATSAPP_API_VERSION || "v20.0";

export function whatsappConfigured() {
  // Do not send outbound messages when inbound webhooks cannot be verified.
  // This safely disables a partial optional integration rather than letting it
  // affect the POS application's availability.
  return Boolean(
    process.env.WHATSAPP_ACCESS_TOKEN
    && process.env.WHATSAPP_PHONE_NUMBER_ID
    && process.env.WHATSAPP_APP_SECRET
  );
}

export async function sendWhatsAppText(to, body) {
  if (!whatsappConfigured()) {
    throw new Error("whatsapp_not_configured");
  }
  const url = `https://graph.facebook.com/${apiVersion}/${process.env.WHATSAPP_PHONE_NUMBER_ID}/messages`;
  const response = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${process.env.WHATSAPP_ACCESS_TOKEN}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      messaging_product: "whatsapp",
      to,
      type: "text",
      text: { preview_url: false, body: String(body).slice(0, 3900) },
    }),
  });
  if (!response.ok) {
    const text = await response.text().catch(() => "");
    throw new Error(`whatsapp_send_failed:${response.status}:${text.slice(0, 300)}`);
  }
  return response.json();
}
