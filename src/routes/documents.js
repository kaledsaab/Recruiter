const express = require('express');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const multer = require('multer');
const { requireRole } = require('../auth');
const { getApplication, partiesOf } = require('../applications');

const ALLOWED = /^(application\/pdf|image\/(jpeg|png|webp|heic)|application\/msword|application\/vnd\.openxmlformats-officedocument\..+)$/;

module.exports = (ctx) => {
  const r = express.Router();
  const { db, notifier, config } = ctx;
  fs.mkdirSync(config.uploadDir, { recursive: true });

  const upload = multer({
    storage: multer.diskStorage({
      destination: config.uploadDir,
      filename: (req, file, cb) => cb(null, `${crypto.randomUUID()}${path.extname(file.originalname).toLowerCase().slice(0, 10)}`),
    }),
    limits: { fileSize: 15 * 1024 * 1024 },
    fileFilter: (req, file, cb) => cb(ALLOWED.test(file.mimetype) ? null : new Error('Unsupported file type'), ALLOWED.test(file.mimetype)),
  });
  const single = (req, res, next) =>
    upload.single('file')(req, res, (err) => (err ? res.status(400).json({ error: err.message }) : next()));

  const insertDoc = db.prepare(`INSERT INTO documents (application_id, stage_id, doc_type, original_name, stored_name, mime_type, size, uploaded_by)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)`);

  // Upload a document for an application (recruiting company or admin)
  r.post('/applications/:id/documents', requireRole('admin', 'recruiter'), single, (req, res) => {
    const app = getApplication(db, req.user, req.params.id);
    if (!app) { if (req.file) fs.rmSync(req.file.path, { force: true }); return res.status(404).json({ error: 'Not found' }); }
    if (!req.file) return res.status(400).json({ error: 'file is required' });
    const docType = String(req.body.doc_type || 'other').toLowerCase();
    const stageId = req.body.stage_id ? Number(req.body.stage_id) : app.current_stage_id;
    const id = Number(insertDoc.run(app.id, stageId, docType, req.file.originalname, req.file.filename, req.file.mimetype, req.file.size, req.user.id).lastInsertRowid);
    if (docType === 'passport') db.prepare('UPDATE applications SET passport_file_id = ? WHERE id = ?').run(id, app.id);
    db.prepare("UPDATE applications SET updated_at = datetime('now') WHERE id = ?").run(app.id);

    notifier.notify({
      userIds: partiesOf(app).filter((u) => u !== req.user.id),
      applicationId: app.id,
      kind: 'document',
      title: `New document: ${app.reference}`,
      body: `A ${docType} document ("${req.file.originalname}") was uploaded for ${app.candidate_name}.`,
    });
    res.status(201).json(db.prepare('SELECT id, application_id, stage_id, doc_type, original_name, mime_type, size, uploaded_at FROM documents WHERE id = ?').get(id));
  });

  // Company documents (licences, registrations...) not tied to an application
  r.post('/company-documents', requireRole('admin', 'recruiter'), single, (req, res) => {
    if (!req.file) return res.status(400).json({ error: 'file is required' });
    const id = insertDoc.run(null, null, String(req.body.doc_type || 'company'), req.file.originalname, req.file.filename, req.file.mimetype, req.file.size, req.user.id).lastInsertRowid;
    res.status(201).json(db.prepare('SELECT id, doc_type, original_name, mime_type, size, uploaded_at FROM documents WHERE id = ?').get(id));
  });

  r.get('/company-documents', requireRole('admin', 'recruiter'), (req, res) => {
    const own = req.user.role === 'admin' ? '' : 'AND d.uploaded_by = ?';
    res.json(db.prepare(`SELECT d.id, d.doc_type, d.original_name, d.mime_type, d.size, d.uploaded_at, u.name AS uploaded_by_name, u.company
      FROM documents d JOIN users u ON u.id = d.uploaded_by WHERE d.application_id IS NULL ${own} ORDER BY d.uploaded_at DESC`)
      .all(...(own ? [req.user.id] : [])));
  });

  function accessibleDoc(req) {
    const doc = db.prepare('SELECT * FROM documents WHERE id = ?').get(Number(req.params.docId));
    if (!doc) return null;
    if (doc.application_id == null) return req.user.role === 'admin' || doc.uploaded_by === req.user.id ? doc : null;
    return getApplication(db, req.user, doc.application_id) ? doc : null;
  }

  r.get('/documents/:docId/download', (req, res) => {
    const doc = accessibleDoc(req);
    if (!doc) return res.status(404).json({ error: 'Not found' });
    res.download(path.join(config.uploadDir, doc.stored_name), doc.original_name);
  });

  r.delete('/documents/:docId', requireRole('admin', 'recruiter'), (req, res) => {
    const doc = accessibleDoc(req);
    if (!doc) return res.status(404).json({ error: 'Not found' });
    if (req.user.role !== 'admin' && doc.uploaded_by !== req.user.id) return res.status(403).json({ error: 'Forbidden' });
    db.prepare('UPDATE applications SET passport_file_id = NULL WHERE passport_file_id = ?').run(doc.id);
    db.prepare('DELETE FROM documents WHERE id = ?').run(doc.id);
    fs.rmSync(path.join(config.uploadDir, doc.stored_name), { force: true });
    res.json({ ok: true });
  });

  return r;
};
