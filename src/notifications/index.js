const { EventEmitter } = require('node:events');

/**
 * Notification service: stores in-app notifications, streams them live (SSE)
 * and fans out to mobile push + WhatsApp for every concerned party.
 */
function createNotifier({ db, whatsapp, push, appUrl, logger = console }) {
  const events = new EventEmitter();
  events.setMaxListeners(0);
  const pending = new Set();

  const logDelivery = db.prepare(
    'INSERT INTO notification_deliveries (notification_id, channel, status, detail) VALUES (?, ?, ?, ?)',
  );

  async function deliverExternal(notificationId, user, { title, body, applicationId }) {
    const link = applicationId ? `${appUrl}/#/applications/${applicationId}` : appUrl;
    const tasks = [];
    if (user.notify_push) {
      const tokens = db.prepare('SELECT token FROM device_tokens WHERE user_id = ?').all(user.id).map((r) => r.token);
      tasks.push(['push', () => push.send(tokens, { title, body, data: { applicationId: applicationId || '' } })]);
    }
    if (user.notify_whatsapp) {
      tasks.push(['whatsapp', () => whatsapp.send(user.phone, `*${title}*\n${body}\n${link}`)]);
    }
    for (const [channel, run] of tasks) {
      try {
        const r = await run();
        logDelivery.run(notificationId, channel, r.status, r.detail || null);
      } catch (e) {
        logger.error(`[notify] ${channel} failed: ${e.message}`);
        logDelivery.run(notificationId, channel, 'failed', e.message.slice(0, 500));
      }
    }
  }

  /**
   * Notify a list of users. Returns immediately after storing in-app notifications;
   * external deliveries run in the background (await `flush()` to wait for them).
   */
  function notify({ userIds, applicationId = null, kind, title, body }) {
    const ids = [...new Set(userIds.filter(Boolean))];
    const insert = db.prepare(
      'INSERT INTO notifications (user_id, application_id, kind, title, body) VALUES (?, ?, ?, ?, ?)',
    );
    const created = [];
    for (const uid of ids) {
      const user = db
        .prepare('SELECT id, name, phone, notify_whatsapp, notify_push, active FROM users WHERE id = ?')
        .get(uid);
      if (!user || !user.active) continue;
      const { lastInsertRowid } = insert.run(uid, applicationId, kind, title, body);
      const id = Number(lastInsertRowid);
      logDelivery.run(id, 'in_app', 'sent', null);
      const record = db.prepare('SELECT * FROM notifications WHERE id = ?').get(id);
      events.emit(`user:${uid}`, record);
      created.push(record);
      const p = deliverExternal(id, user, { title, body, applicationId }).finally(() => pending.delete(p));
      pending.add(p);
    }
    return created;
  }

  const flush = () => Promise.all([...pending]);

  return { notify, flush, events };
}

module.exports = { createNotifier };
