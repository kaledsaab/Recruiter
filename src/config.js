const fs = require('node:fs');
const path = require('node:path');

// Minimal .env loader (no external dependency)
const envFile = path.join(__dirname, '..', '.env');
if (fs.existsSync(envFile)) {
  for (const line of fs.readFileSync(envFile, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
}

const env = process.env;
module.exports = {
  port: Number(env.PORT || 3000),
  jwtSecret: env.JWT_SECRET || 'dev-secret-change-me',
  dataDir: path.resolve(env.DATA_DIR || './data'),
  uploadDir: path.resolve(env.UPLOAD_DIR || './uploads'),
  appUrl: env.APP_URL || `http://localhost:${env.PORT || 3000}`,
  adminEmail: env.ADMIN_EMAIL || 'admin@example.com',
  adminPassword: env.ADMIN_PASSWORD || 'admin123',
  whatsapp: {
    token: env.WHATSAPP_TOKEN || '',
    phoneNumberId: env.WHATSAPP_PHONE_NUMBER_ID || '',
    apiVersion: env.WHATSAPP_API_VERSION || 'v21.0',
    templateName: env.WHATSAPP_TEMPLATE_NAME || '',
    templateLang: env.WHATSAPP_TEMPLATE_LANG || 'en',
  },
  fcm: { serviceAccountFile: env.FCM_SERVICE_ACCOUNT_FILE || '' },
  followup: {
    intervalMinutes: Number(env.FOLLOWUP_INTERVAL_MINUTES || 60),
    defaultDays: Number(env.FOLLOWUP_DEFAULT_DAYS || 7),
  },
};
