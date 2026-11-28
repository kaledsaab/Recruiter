const express = require('express');
const { verifyPassword, signToken, hashPassword } = require('../auth');

module.exports = (ctx, auth) => {
  const r = express.Router();
  const { db, config } = ctx;

  r.post('/login', (req, res) => {
    const { email, password } = req.body || {};
    const user = db.prepare('SELECT * FROM users WHERE email = ?').get(String(email || '').toLowerCase().trim());
    if (!user || !user.active || !verifyPassword(password, user.password_hash)) {
      return res.status(401).json({ error: 'Invalid email or password' });
    }
    const token = signToken({ sub: user.id, role: user.role }, config.jwtSecret);
    const { password_hash, ...safe } = user;
    res.json({ token, user: safe });
  });

  r.get('/me', auth, (req, res) => {
    const u = db.prepare(
      'SELECT id, name, email, phone, role, company, notify_whatsapp, notify_push FROM users WHERE id = ?',
    ).get(req.user.id);
    res.json(u);
  });

  r.put('/me', auth, (req, res) => {
    const { name, phone, password, notify_whatsapp, notify_push } = req.body || {};
    const cur = db.prepare('SELECT * FROM users WHERE id = ?').get(req.user.id);
    db.prepare('UPDATE users SET name = ?, phone = ?, notify_whatsapp = ?, notify_push = ?, password_hash = ? WHERE id = ?').run(
      name ?? cur.name,
      phone ?? cur.phone,
      notify_whatsapp === undefined ? cur.notify_whatsapp : notify_whatsapp ? 1 : 0,
      notify_push === undefined ? cur.notify_push : notify_push ? 1 : 0,
      password ? hashPassword(password) : cur.password_hash,
      req.user.id,
    );
    res.json({ ok: true });
  });

  // Register a mobile device token for push notifications
  r.post('/devices', auth, (req, res) => {
    const { token, platform } = req.body || {};
    if (!token) return res.status(400).json({ error: 'token is required' });
    db.prepare(
      'INSERT INTO device_tokens (user_id, token, platform) VALUES (?, ?, ?) ON CONFLICT(token) DO UPDATE SET user_id = excluded.user_id, platform = excluded.platform',
    ).run(req.user.id, token, platform || null);
    res.status(201).json({ ok: true });
  });

  r.delete('/devices/:token', auth, (req, res) => {
    db.prepare('DELETE FROM device_tokens WHERE token = ? AND user_id = ?').run(req.params.token, req.user.id);
    res.json({ ok: true });
  });

  return r;
};
