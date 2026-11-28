const fs = require('node:fs');
const crypto = require('node:crypto');

/**
 * Mobile push channel using Firebase Cloud Messaging (HTTP v1 API).
 * Configure FCM_SERVICE_ACCOUNT_FILE with a Firebase service-account JSON.
 * Without it, pushes are logged to the console.
 */
function createPush(cfg, { fetchImpl = globalThis.fetch, logger = console } = {}) {
  let account = null;
  if (cfg.serviceAccountFile) {
    try {
      account = JSON.parse(fs.readFileSync(cfg.serviceAccountFile, 'utf8'));
    } catch (e) {
      logger.error(`[push] cannot read service account: ${e.message}`);
    }
  }
  let cached = { token: null, exp: 0 };

  async function accessToken() {
    const now = Math.floor(Date.now() / 1000);
    if (cached.token && cached.exp - 60 > now) return cached.token;
    const enc = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
    const unsigned = `${enc({ alg: 'RS256', typ: 'JWT' })}.${enc({
      iss: account.client_email,
      scope: 'https://www.googleapis.com/auth/firebase.messaging',
      aud: 'https://oauth2.googleapis.com/token',
      iat: now,
      exp: now + 3600,
    })}`;
    const sig = crypto.sign('RSA-SHA256', Buffer.from(unsigned), account.private_key).toString('base64url');
    const res = await fetchImpl('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
        assertion: `${unsigned}.${sig}`,
      }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(`FCM auth failed: ${JSON.stringify(data)}`);
    cached = { token: data.access_token, exp: now + (data.expires_in || 3600) };
    return cached.token;
  }

  async function send(tokens, { title, body, data = {} }) {
    if (!tokens.length) return { status: 'skipped', detail: 'no registered devices' };
    if (!account) {
      logger.log(`[push:dev] -> ${tokens.length} device(s): ${title} — ${body}`);
      return { status: 'logged', detail: 'Push not configured; message logged' };
    }
    const bearer = await accessToken();
    const url = `https://fcm.googleapis.com/v1/projects/${account.project_id}/messages:send`;
    const strData = Object.fromEntries(Object.entries(data).map(([k, v]) => [k, String(v)]));
    const results = await Promise.all(
      tokens.map(async (token) => {
        const res = await fetchImpl(url, {
          method: 'POST',
          headers: { Authorization: `Bearer ${bearer}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({ message: { token, notification: { title, body }, data: strData } }),
        });
        return res.ok;
      }),
    );
    const ok = results.filter(Boolean).length;
    return { status: ok ? 'sent' : 'failed', detail: `${ok}/${tokens.length} delivered` };
  }

  return { name: 'push', configured: Boolean(account), send };
}

module.exports = { createPush };
