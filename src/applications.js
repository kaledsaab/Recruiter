/** Shared application helpers: access scoping, progress, notifications on change. */

function scope(user) {
  switch (user.role) {
    case 'admin': return { sql: '1=1', params: [] };
    case 'recruiter': return { sql: 'a.recruiter_id = ?', params: [user.id] };
    case 'client': return { sql: 'a.client_id = ?', params: [user.id] };
    case 'candidate': return { sql: 'a.candidate_user_id = ?', params: [user.id] };
    default: return { sql: '0', params: [] };
  }
}

const SELECT_APP = `
  SELECT a.*, s.name AS current_stage_name, s.is_final AS current_stage_final,
         c.name AS client_name, c.company AS client_company,
         r.name AS recruiter_name, r.company AS recruiter_company,
         cu.name AS candidate_user_name, cu.email AS candidate_email, cu.phone AS candidate_phone
  FROM applications a
  LEFT JOIN stages s ON s.id = a.current_stage_id
  LEFT JOIN users c ON c.id = a.client_id
  LEFT JOIN users r ON r.id = a.recruiter_id
  LEFT JOIN users cu ON cu.id = a.candidate_user_id`;

function activeStages(db) {
  return db.prepare('SELECT * FROM stages WHERE active = 1 ORDER BY position, id').all();
}

/** Returns the step list with done/current/pending flags and a percentage. */
function progress(db, app) {
  const stages = activeStages(db);
  const idx = stages.findIndex((s) => s.id === app.current_stage_id);
  const steps = stages.map((s, i) => ({
    id: s.id,
    name: s.name,
    position: s.position,
    state: idx === -1 ? 'pending' : i < idx ? 'done' : i === idx ? (s.is_final ? 'done' : 'current') : 'pending',
  }));
  const done = steps.filter((s) => s.state === 'done').length;
  return { steps, percent: stages.length ? Math.round((done / stages.length) * 100) : 0 };
}

function getApplication(db, user, id) {
  const sc = scope(user);
  return db.prepare(`${SELECT_APP} WHERE a.id = ? AND ${sc.sql}`).get(Number(id), ...sc.params);
}

/** All users concerned by an application (candidate, client, recruiter). */
function partiesOf(app) {
  return [app.candidate_user_id, app.client_id, app.recruiter_id].filter(Boolean);
}

module.exports = { scope, SELECT_APP, activeStages, progress, getApplication, partiesOf };
