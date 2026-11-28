/**
 * WhatsApp channel using the Meta WhatsApp Cloud API.
 * When credentials are not configured, messages are logged to the console (useful in development).
 */
function createWhatsApp(cfg, { fetchImpl = globalThis.fetch, logger = console } = {}) {
  const configured = Boolean(cfg.token && cfg.phoneNumberId);

  async function send(phone, text) {
    const to = String(phone || '').replace(/[^\d]/g, '');
    if (!to) return { status: 'skipped', detail: 'no phone number' };
    if (!configured) {
      logger.log(`[whatsapp:dev] -> +${to}: ${text}`);
      return { status: 'logged', detail: 'WhatsApp not configured; message logged' };
    }
    const payload = cfg.templateName
      ? {
          messaging_product: 'whatsapp',
          to,
          type: 'template',
          template: {
            name: cfg.templateName,
            language: { code: cfg.templateLang },
            components: [{ type: 'body', parameters: [{ type: 'text', text: text.slice(0, 1000) }] }],
          },
        }
      : { messaging_product: 'whatsapp', to, type: 'text', text: { body: text, preview_url: true } };

    const url = `https://graph.facebook.com/${cfg.apiVersion}/${cfg.phoneNumberId}/messages`;
    const res = await fetchImpl(url, {
      method: 'POST',
      headers: { Authorization: `Bearer ${cfg.token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) return { status: 'failed', detail: JSON.stringify(data.error || data).slice(0, 500) };
    return { status: 'sent', detail: data.messages?.[0]?.id || 'ok' };
  }

  return { name: 'whatsapp', configured, send };
}

module.exports = { createWhatsApp };
