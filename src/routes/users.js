const express = require('express');
const { hashPassword, requireRole } = require('../auth');

const FIELDS = 'id, name, email, phone, role, company, notify_whatsapp, notify_push, active, created_at';

module.exports = (ctx) => {
  const r = express.Router();
  const { db } = ctx;

  // Recruiters may create/list clients and candidates; admins manage everyone.
  const creatable = (actor) => (actor.role === 'admin' ? ['admin', 'recruiter', 'client', 'candidate'] : ['client', 'candidate']);

  r.get('/', requireRole('admin', 'recruiter'), (req, res) => {
    const roles = req.query.role ? [req.query.role] : creatable(req.user);
    const allowed = roles.filter((x) => creatable(req.user).includes(x));
    if (!allowed.length) return res.json([]);
    const rows = db
      .prepare(`SELECT ${FIELDS} FROM users WHERE role IN (${allowed.map(() => '?').join(',')}) ORDER BY name`)
      .all(...allowed);
    res.json(rows);
  });

  r.post('/', requireRole('admin', 'recruiter'), (req, res) => {
    const { name, email, phone, role, company, password } = req.body || {};
    if (!name || !email || !role || !password) return res.status(400).json({ error: 'name, email, role and password are required' });
    if (!creatable(req.user).includes(role)) return res.status(403).json({ error: `You cannot create ${role} accounts` });
    try {
      const { lastInsertRowid } = db
        .prepare('INSERT INTO users (name, email, phone, role, company, password_hash) VALUES (?, ?, ?, ?, ?, ?)')
        .run(name, String(email).toLowerCase().trim(), phone || null, role, company || null, hashPassword(password));
      res.status(201).json(db.prepare(`SELECT ${FIELDS} FROM users WHERE id = ?`).get(lastInsertRowid));
    } catch (e) {
      if (String(e.message).includes('UNIQUE')) return res.status(409).json({ error: 'Email already exists' });
      throw e;
    }
  });

  r.put('/:id', requireRole('admin'), (req, res) => {
    const cur = db.prepare('SELECT * FROM users WHERE id = ?').get(req.params.id);
    if (!cur) return res.status(404).json({ error: 'Not found' });
    const b = req.body || {};
    db.prepare('UPDATE users SET name=?, phone=?, company=?, role=?, active=?, password_hash=? WHERE id=?').run(
      b.name ?? cur.name,
      b.phone ?? cur.phone,
      b.company ?? cur.company,
      b.role ?? cur.role,
      b.active === undefined ? cur.active : b.active ? 1 : 0,
      b.password ? hashPassword(b.password) : cur.password_hash,
      cur.id,
    );
    res.json(db.prepare(`SELECT ${FIELDS} FROM users WHERE id = ?`).get(cur.id));
  });

  return r;
};
