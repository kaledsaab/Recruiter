/**
 * Automatic follow-up: finds applications that have been waiting in a stage
 * longer than the stage SLA (or the default) and reminds the concerned parties.
 */
function runFollowups({ db, notifier, config }, now = new Date()) {
  const rows = db.prepare(`
    SELECT a.*, s.name AS stage_name, s.sla_days
    FROM applications a JOIN stages s ON s.id = a.current_stage_id
    WHERE s.is_final = 0`).all();

  const nowMs = now.getTime();
  const toMs = (t) => (t ? Date.parse(`${t.replace(' ', 'T')}Z`) : 0);
  const stamp = now.toISOString().slice(0, 19).replace('T', ' ');
  let sent = 0;

  for (const app of rows) {
    const days = app.sla_days ?? config.followup.defaultDays;
    if (!days || days <= 0) continue;
    const limit = days * 86400000;
    const waited = nowMs - toMs(app.stage_entered_at);
    const sinceLast = nowMs - toMs(app.last_followup_at);
    if (waited < limit || sinceLast < limit) continue;

    const waitedDays = Math.floor(waited / 86400000);
    notifier.notify({
      userIds: [app.recruiter_id],
      applicationId: app.id,
      kind: 'followup',
      title: `Action needed: ${app.reference}`,
      body: `${app.candidate_name} has been at "${app.stage_name}" for ${waitedDays} day(s). Please update the status or upload the pending documents.`,
    });
    notifier.notify({
      userIds: [app.client_id, app.candidate_user_id],
      applicationId: app.id,
      kind: 'followup',
      title: `Application ${app.reference} update`,
      body: `The application for ${app.candidate_name} is still in progress at "${app.stage_name}". We are following up with the recruiting company.`,
    });
    db.prepare('UPDATE applications SET last_followup_at = ? WHERE id = ?').run(stamp, app.id);
    sent++;
  }
  return sent;
}

function startFollowupScheduler(ctx) {
  const ms = Math.max(1, ctx.config.followup.intervalMinutes) * 60000;
  const timer = setInterval(() => {
    try {
      const n = runFollowups(ctx);
      if (n) console.log(`[followup] reminders sent for ${n} application(s)`);
    } catch (e) {
      console.error('[followup] error', e);
    }
  }, ms);
  timer.unref();
  return timer;
}

module.exports = { runFollowups, startFollowupScheduler };
