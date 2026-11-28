const express = require('express');
const { requireRole } = require('../auth');
const { runFollowups } = require('../followup');

module.exports = (ctx) => {
  const r = express.Router();
  const { db, notifier } = ctx;

  r.get('/', (req, res) => {
    const unread = req.query.unread === '1' ? 'AND read_at IS NULL' : '';
    const items = db.prepare(`SELECT * FROM notifications WHERE user_id = ? ${unread} ORDER BY id DESC LIMIT 100`).all(req.user.id);
    const count = db.prepare('SELECT COUNT(*) AS n FROM notifications WHERE user_id = ? AND read_at IS NULL').get(req.user.id).n;
    res.json({ unread: count, items });
  });

  r.post('/read', (req, res) => {
    const ids = req.body?.ids;
    if (Array.isArray(ids) && ids.length) {
      db.prepare(`UPDATE notifications SET read_at = datetime('now') WHERE user_id = ? AND read_at IS NULL AND id IN (${ids.map(() => '?').join(',')})`)
        .run(req.user.id, ...ids.map(Number));
    } else {
      db.prepare("UPDATE notifications SET read_at = datetime('now') WHERE user_id = ? AND read_at IS NULL").run(req.user.id);
    }
    res.json({ ok: true });
  });

  // Live in-app notifications via Server-Sent Events (pass ?token=...)
  r.get('/stream', (req, res) => {
    res.set({ 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
    res.flushHeaders();
    res.write('retry: 5000\n\n');
    const onEvent = (n) => res.write(`event: notification\ndata: ${JSON.stringify(n)}\n\n`);
    const ping = setInterval(() => res.write(': ping\n\n'), 25000);
    notifier.events.on(`user:${req.user.id}`, onEvent);
    req.on('close', () => { clearInterval(ping); notifier.events.off(`user:${req.user.id}`, onEvent); });
  });

  // Admin: delivery log and manual follow-up run
  r.get('/deliveries', requireRole('admin'), (req, res) => {
    res.json(db.prepare(`SELECT d.*, n.title, n.kind, u.name AS user_name FROM notification_deliveries d
      JOIN notifications n ON n.id = d.notification_id JOIN users u ON u.id = n.user_id ORDER BY d.id DESC LIMIT 200`).all());
  });

  r.post('/followups/run', requireRole('admin'), (req, res) => {
    res.json({ reminded: runFollowups(ctx) });
  });

  return r;
};
