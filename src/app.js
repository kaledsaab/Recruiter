const path = require('node:path');
const express = require('express');
const defaultConfig = require('./config');
const { openDb } = require('./db');
const { hashPassword, authMiddleware } = require('./auth');
const { createWhatsApp } = require('./notifications/whatsapp');
const { createPush } = require('./notifications/push');
const { createNotifier } = require('./notifications');
const { progress } = require('./applications');

function createApp(overrides = {}) {
  const config = { ...defaultConfig, ...overrides.config };
  const db = overrides.db || openDb(overrides.dbFile || path.join(config.dataDir, 'recruiter.db'), {
    adminEmail: config.adminEmail, adminPassword: config.adminPassword, hashPassword,
  });
  const whatsapp = overrides.whatsapp || createWhatsApp(config.whatsapp);
  const push = overrides.push || createPush(config.fcm);
  const notifier = createNotifier({ db, whatsapp, push, appUrl: config.appUrl });
  const ctx = { db, config, notifier, whatsapp, push };

  const app = express();
  app.disable('x-powered-by');
  app.use(express.json({ limit: '1mb' }));
  const auth = authMiddleware(ctx);

  app.get('/api/health', (req, res) => res.json({
    ok: true, whatsapp: whatsapp.configured ? 'live' : 'console', push: push.configured ? 'live' : 'console',
  }));

  // Public status lookup (no login): reference + passport number
  app.get('/api/track', (req, res) => {
    const { reference, passport } = req.query;
    if (!reference || !passport) return res.status(400).json({ error: 'reference and passport are required' });
    const a = db.prepare(`SELECT a.id, a.reference, a.candidate_name, a.profession, a.nationality, a.current_stage_id,
      a.updated_at, s.name AS current_stage_name FROM applications a LEFT JOIN stages s ON s.id = a.current_stage_id
      WHERE a.reference = ? AND UPPER(a.passport_number) = UPPER(?)`).get(String(reference).trim(), String(passport).trim());
    if (!a) return res.status(404).json({ error: 'No application found' });
    const { id, ...pub } = a;
    res.json({ ...pub, progress: progress(db, a) });
  });

  app.use('/api/auth', require('./routes/auth')(ctx, auth));
  app.use('/api/users', auth, require('./routes/users')(ctx));
  app.use('/api/stages', auth, require('./routes/stages')(ctx));
  app.use('/api/applications', auth, require('./routes/applications')(ctx));
  app.use('/api/notifications', auth, require('./routes/notifications')(ctx));
  app.use('/api', auth, require('./routes/documents')(ctx));

  app.use(express.static(path.join(__dirname, '..', 'public')));

  app.use('/api', (req, res) => res.status(404).json({ error: 'Not found' }));
  app.use((err, req, res, next) => {
    console.error(err);
    res.status(500).json({ error: 'Internal server error' });
  });

  return { app, ctx };
}

module.exports = { createApp };
