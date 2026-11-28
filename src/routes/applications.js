const express = require('express');
const crypto = require('node:crypto');
const { requireRole } = require('../auth');
const { tx } = require('../db');
const { scope, SELECT_APP, activeStages, progress, getApplication, partiesOf } = require('../applications');

module.exports = (ctx) => {
  const r = express.Router();
  const { db, notifier } = ctx;

  const userWithRole = (id, role) => id && db.prepare('SELECT id FROM users WHERE id = ? AND role = ?').get(id, role);

  r.get('/', (req, res) => {
    const sc = scope(req.user);
    const where = [sc.sql];
    const params = [...sc.params];
    if (req.query.stage_id) { where.push('a.current_stage_id = ?'); params.push(Number(req.query.stage_id)); }
    if (req.query.q) {
      where.push('(a.candidate_name LIKE ? OR a.reference LIKE ? OR a.profession LIKE ? OR a.nationality LIKE ? OR a.passport_number LIKE ?)');
      params.push(...Array(5).fill(`%${req.query.q}%`));
    }
    const rows = db.prepare(`${SELECT_APP} WHERE ${where.join(' AND ')} ORDER BY a.updated_at DESC`).all(...params);
    const stages = activeStages(db);
    res.json(rows.map((a) => {
      const idx = stages.findIndex((s) => s.id === a.current_stage_id);
      return { ...a, step_index: idx + 1, step_count: stages.length };
    }));
  });

  r.get('/summary', (req, res) => {
    const sc = scope(req.user);
    const rows = db.prepare(`
      SELECT s.id, s.name, s.position, COUNT(a.id) AS count
      FROM stages s LEFT JOIN applications a ON a.current_stage_id = s.id AND ${sc.sql}
      WHERE s.active = 1 GROUP BY s.id ORDER BY s.position`).all(...sc.params);
    res.json(rows);
  });

  r.get('/:id', (req, res) => {
    const app = getApplication(db, req.user, req.params.id);
    if (!app) return res.status(404).json({ error: 'Not found' });
    const history = db.prepare(`
      SELECT h.*, f.name AS from_stage, t.name AS to_stage, u.name AS changed_by_name
      FROM stage_history h
      LEFT JOIN stages f ON f.id = h.from_stage_id
      LEFT JOIN stages t ON t.id = h.to_stage_id
      LEFT JOIN users u ON u.id = h.changed_by
      WHERE h.application_id = ? ORDER BY h.changed_at DESC, h.id DESC`).all(app.id);
    const documents = db.prepare(`
      SELECT d.id, d.doc_type, d.original_name, d.mime_type, d.size, d.uploaded_at, d.stage_id,
             s.name AS stage_name, u.name AS uploaded_by_name
      FROM documents d LEFT JOIN stages s ON s.id = d.stage_id LEFT JOIN users u ON u.id = d.uploaded_by
      WHERE d.application_id = ? ORDER BY d.uploaded_at DESC, d.id DESC`).all(app.id);
    res.json({ ...app, progress: progress(db, app), history, documents });
  });

  r.post('/', requireRole('admin', 'recruiter'), (req, res) => {
    const b = req.body || {};
    for (const f of ['candidate_name', 'profession', 'nationality']) {
      if (!b[f]) return res.status(400).json({ error: `${f} is required` });
    }
    const recruiterId = req.user.role === 'recruiter' ? req.user.id : b.recruiter_id || null;
    if (b.client_id && !userWithRole(b.client_id, 'client')) return res.status(400).json({ error: 'client_id is not a client' });
    if (b.candidate_user_id && !userWithRole(b.candidate_user_id, 'candidate')) return res.status(400).json({ error: 'candidate_user_id is not a candidate' });
    if (recruiterId && !userWithRole(recruiterId, 'recruiter')) return res.status(400).json({ error: 'recruiter_id is not a recruiter' });

    const first = activeStages(db)[0];
    const reference = `APP-${new Date().getFullYear()}-${crypto.randomBytes(3).toString('hex').toUpperCase()}`;
    const id = tx(db, () => {
      const id = Number(db.prepare(`
        INSERT INTO applications (reference, candidate_name, profession, nationality, passport_number,
          client_id, recruiter_id, candidate_user_id, current_stage_id, notes, created_by)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
        reference, b.candidate_name, b.profession, b.nationality, b.passport_number || null,
        b.client_id || null, recruiterId, b.candidate_user_id || null, first?.id || null, b.notes || null, req.user.id,
      ).lastInsertRowid);
      db.prepare('INSERT INTO stage_history (application_id, from_stage_id, to_stage_id, comment, changed_by) VALUES (?, NULL, ?, ?, ?)')
        .run(id, first?.id || null, 'Application created', req.user.id);
      return id;
    });
    const app = getApplication(db, req.user, id);
    notifier.notify({
      userIds: partiesOf(app).filter((u) => u !== req.user.id),
      applicationId: id,
      kind: 'created',
      title: `New application ${reference}`,
      body: `Application for ${app.candidate_name} (${app.profession}, ${app.nationality}) has been registered. Current step: ${app.current_stage_name || '-'}.`,
    });
    res.status(201).json(app);
  });

  r.put('/:id', requireRole('admin', 'recruiter'), (req, res) => {
    const cur = getApplication(db, req.user, req.params.id);
    if (!cur) return res.status(404).json({ error: 'Not found' });
    const b = req.body || {};
    if (b.client_id && !userWithRole(b.client_id, 'client')) return res.status(400).json({ error: 'client_id is not a client' });
    if (b.candidate_user_id && !userWithRole(b.candidate_user_id, 'candidate')) return res.status(400).json({ error: 'candidate_user_id is not a candidate' });
    const pick = (k) => (b[k] === undefined ? cur[k] : b[k]);
    db.prepare(`UPDATE applications SET candidate_name=?, profession=?, nationality=?, passport_number=?,
      client_id=?, candidate_user_id=?, recruiter_id=?, arrival_date=?, notes=?, updated_at=datetime('now') WHERE id=?`).run(
      pick('candidate_name'), pick('profession'), pick('nationality'), pick('passport_number'),
      pick('client_id'), pick('candidate_user_id'),
      req.user.role === 'admin' ? pick('recruiter_id') : cur.recruiter_id,
      pick('arrival_date'), pick('notes'), cur.id,
    );
    res.json(getApplication(db, req.user, cur.id));
  });

  /**
   * Change status. Body: { stage_id } or { direction: 'next' | 'previous' }, optional comment.
   * Notifies all concerned parties (in-app, push, WhatsApp).
   */
  r.post('/:id/stage', requireRole('admin', 'recruiter'), (req, res) => {
    const app = getApplication(db, req.user, req.params.id);
    if (!app) return res.status(404).json({ error: 'Not found' });
    const stages = activeStages(db);
    const idx = stages.findIndex((s) => s.id === app.current_stage_id);
    let target;
    const { stage_id, direction, comment } = req.body || {};
    if (stage_id) target = stages.find((s) => s.id === Number(stage_id));
    else if (direction === 'next') target = stages[idx + 1];
    else if (direction === 'previous') target = idx > 0 ? stages[idx - 1] : undefined;
    if (!target) return res.status(400).json({ error: 'Invalid target step' });
    if (target.id === app.current_stage_id) return res.status(400).json({ error: 'Application is already at this step' });

    tx(db, () => {
      db.prepare(`UPDATE applications SET current_stage_id = ?, stage_entered_at = datetime('now'), last_followup_at = NULL,
        arrival_date = CASE WHEN ? = 1 AND arrival_date IS NULL THEN date('now') ELSE arrival_date END,
        updated_at = datetime('now') WHERE id = ?`).run(target.id, target.is_final, app.id);
      db.prepare('INSERT INTO stage_history (application_id, from_stage_id, to_stage_id, comment, changed_by) VALUES (?, ?, ?, ?, ?)')
        .run(app.id, app.current_stage_id, target.id, comment || null, req.user.id);
    });

    const pos = stages.findIndex((s) => s.id === target.id) + 1;
    notifier.notify({
      userIds: partiesOf(app).filter((u) => u !== req.user.id),
      applicationId: app.id,
      kind: 'stage_change',
      title: target.is_final ? `${app.candidate_name} has arrived` : `Status update: ${app.reference}`,
      body: `${app.candidate_name} moved from "${app.current_stage_name || '-'}" to "${target.name}" (step ${pos} of ${stages.length}).${comment ? ` Note: ${comment}` : ''}`,
    });
    const updated = getApplication(db, req.user, app.id);
    res.json({ ...updated, progress: progress(db, updated) });
  });

  r.delete('/:id', requireRole('admin'), (req, res) => {
    const info = db.prepare('DELETE FROM applications WHERE id = ?').run(Number(req.params.id));
    res.status(info.changes ? 200 : 404).json({ ok: Boolean(info.changes) });
  });

  return r;
};
