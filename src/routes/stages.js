const express = require('express');
const { requireRole } = require('../auth');
const { tx } = require('../db');

/** Configurable tracking steps: rename, add, remove, reorder, set SLA days. */
module.exports = (ctx) => {
  const r = express.Router();
  const { db } = ctx;

  r.get('/', (req, res) => {
    const all = req.query.all === '1' && req.user.role === 'admin';
    res.json(db.prepare(`SELECT * FROM stages ${all ? '' : 'WHERE active = 1'} ORDER BY position, id`).all());
  });

  r.post('/', requireRole('admin'), (req, res) => {
    const { name, description, sla_days, is_final, position } = req.body || {};
    if (!name) return res.status(400).json({ error: 'name is required' });
    const max = db.prepare('SELECT COALESCE(MAX(position), 0) AS m FROM stages').get().m;
    const pos = position ?? max + 1;
    const id = tx(db, () => {
      db.prepare('UPDATE stages SET position = position + 1 WHERE position >= ?').run(pos);
      return db.prepare('INSERT INTO stages (name, description, position, sla_days, is_final) VALUES (?, ?, ?, ?, ?)')
        .run(name, description || null, pos, sla_days ?? null, is_final ? 1 : 0).lastInsertRowid;
    });
    res.status(201).json(db.prepare('SELECT * FROM stages WHERE id = ?').get(id));
  });

  r.put('/reorder', requireRole('admin'), (req, res) => {
    const ids = req.body?.ids;
    if (!Array.isArray(ids)) return res.status(400).json({ error: 'ids array is required' });
    tx(db, () => ids.forEach((id, i) => db.prepare('UPDATE stages SET position = ? WHERE id = ?').run(i + 1, id)));
    res.json(db.prepare('SELECT * FROM stages WHERE active = 1 ORDER BY position, id').all());
  });

  r.put('/:id', requireRole('admin'), (req, res) => {
    const cur = db.prepare('SELECT * FROM stages WHERE id = ?').get(req.params.id);
    if (!cur) return res.status(404).json({ error: 'Not found' });
    const b = req.body || {};
    db.prepare('UPDATE stages SET name=?, description=?, sla_days=?, is_final=?, active=? WHERE id=?').run(
      b.name ?? cur.name,
      b.description ?? cur.description,
      b.sla_days === undefined ? cur.sla_days : b.sla_days,
      b.is_final === undefined ? cur.is_final : b.is_final ? 1 : 0,
      b.active === undefined ? cur.active : b.active ? 1 : 0,
      cur.id,
    );
    res.json(db.prepare('SELECT * FROM stages WHERE id = ?').get(cur.id));
  });

  // Delete if unused, otherwise deactivate (keeps history intact).
  r.delete('/:id', requireRole('admin'), (req, res) => {
    const id = Number(req.params.id);
    if (db.prepare('SELECT COUNT(*) AS n FROM applications WHERE current_stage_id = ?').get(id).n) {
      return res.status(409).json({ error: 'Applications are currently at this step; move them first' });
    }
    const used =
      db.prepare('SELECT COUNT(*) AS n FROM stage_history WHERE from_stage_id = ? OR to_stage_id = ?').get(id, id).n +
      db.prepare('SELECT COUNT(*) AS n FROM documents WHERE stage_id = ?').get(id).n;
    if (used) {
      db.prepare('UPDATE stages SET active = 0 WHERE id = ?').run(id);
      return res.json({ ok: true, deactivated: true });
    }
    db.prepare('DELETE FROM stages WHERE id = ?').run(id);
    res.json({ ok: true, deleted: true });
  });

  return r;
};
