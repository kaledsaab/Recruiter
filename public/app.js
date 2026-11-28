/* Recruitment Portal — single page front-end (vanilla JS, hash routing) */
const state = { token: localStorage.getItem('token'), user: JSON.parse(localStorage.getItem('user') || 'null'), stream: null };
const $ = (sel, el = document) => el.querySelector(sel);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const fmtDate = (s) => (s ? new Date(s.includes('T') ? s : `${s.replace(' ', 'T')}Z`).toLocaleString() : '-');
const ROLE_LABEL = { admin: 'Administrator', recruiter: 'Recruiting company', client: 'Client', candidate: 'Employee / Candidate' };
const DOC_TYPES = ['passport', 'photo', 'visa', 'contract', 'medical', 'police_clearance', 'ticket', 'other'];

async function api(path, opts = {}) {
  const headers = { ...(opts.headers || {}) };
  if (state.token) headers.Authorization = `Bearer ${state.token}`;
  let body = opts.body;
  if (body && !(body instanceof FormData)) { headers['Content-Type'] = 'application/json'; body = JSON.stringify(body); }
  const res = await fetch(`/api${path}`, { ...opts, headers, body });
  if (res.status === 401 && state.token) { logout(); throw new Error('Session expired'); }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
  return data;
}

function toast(msg) {
  const t = $('#toast'); t.textContent = msg; t.hidden = false;
  clearTimeout(toast.t); toast.t = setTimeout(() => (t.hidden = true), 3500);
}

function formData(form) { return Object.fromEntries(new FormData(form).entries()); }

function logout() {
  localStorage.clear(); state.token = null; state.user = null;
  state.stream?.close(); state.stream = null;
  location.hash = '#/login'; render();
}

/* ---------------- Layout ---------------- */
function navLinks() {
  const r = state.user.role;
  const links = [['#/', 'Applications']];
  if (r === 'admin' || r === 'recruiter') links.push(['#/new', 'New application'], ['#/users', r === 'admin' ? 'Users' : 'Clients & candidates'], ['#/company-docs', 'Company documents']);
  if (r === 'admin') links.push(['#/stages', 'Steps'], ['#/deliveries', 'Notification log']);
  links.push(['#/profile', 'My profile']);
  return links.map(([h, t]) => `<a href="${h}" class="${location.hash === h || (h === '#/' && (location.hash === '' || location.hash === '#/')) ? 'active' : ''}">${t}</a>`).join('');
}

async function refreshBadge() {
  if (!state.token) return;
  const { unread } = await api('/notifications?unread=1');
  const b = $('#badge'); b.hidden = !unread; b.textContent = unread;
}

function startStream() {
  if (state.stream || !state.token) return;
  state.stream = new EventSource(`/api/notifications/stream?token=${encodeURIComponent(state.token)}`);
  state.stream.addEventListener('notification', (e) => {
    const n = JSON.parse(e.data);
    toast(`🔔 ${n.title}`);
    refreshBadge();
    if ('Notification' in window && Notification.permission === 'granted') new Notification(n.title, { body: n.body });
  });
}

async function openNotifications() {
  const panel = $('#notif-panel');
  if (!panel.hidden) { panel.hidden = true; return; }
  const { items } = await api('/notifications');
  panel.innerHTML = `<div class="row" style="padding:10px 14px;justify-content:space-between"><b>Notifications</b><button class="link" id="markall">Mark all read</button></div>` +
    (items.map((n) => `<div class="n ${n.read_at ? '' : 'unread'}" data-app="${n.application_id || ''}"><b>${esc(n.title)}</b><div>${esc(n.body)}</div><small>${fmtDate(n.created_at)}</small></div>`).join('') || '<div class="n muted">No notifications yet</div>');
  panel.hidden = false;
  $('#markall', panel).onclick = async () => { await api('/notifications/read', { method: 'POST', body: {} }); panel.hidden = true; refreshBadge(); };
  panel.querySelectorAll('.n[data-app]').forEach((el) => el.addEventListener('click', () => {
    if (el.dataset.app) { location.hash = `#/applications/${el.dataset.app}`; panel.hidden = true; }
  }));
  await api('/notifications/read', { method: 'POST', body: {} }); refreshBadge();
}

/* ---------------- Views ---------------- */
function stepsHtml(progress) {
  return `<div class="steps">${progress.steps.map((s, i) => `<div class="step ${s.state}"><div class="dot">${s.state === 'done' ? '✓' : i + 1}</div>${esc(s.name)}</div>`).join('')}</div>`;
}

function viewLogin() {
  $('#view').innerHTML = `
  <div class="login">
    <div class="card"><h1>Sign in</h1>
      <p class="muted">Clients, employees and recruiting companies sign in to follow applications.</p>
      <form id="login"><label>Email</label><input name="email" type="email" required autocomplete="username">
      <label style="margin-top:10px">Password</label><input name="password" type="password" required autocomplete="current-password">
      <button style="margin-top:14px;width:100%">Sign in</button></form>
    </div>
    <div class="card"><h2>Track an application</h2>
      <form id="track" class="grid"><div><label>Reference</label><input name="reference" placeholder="APP-2026-XXXXXX" required></div>
      <div><label>Passport number</label><input name="passport" required></div><button>Check status</button></form>
      <div id="track-result"></div>
    </div>
  </div>`;
  $('#login').onsubmit = async (e) => {
    e.preventDefault();
    try {
      const r = await api('/auth/login', { method: 'POST', body: formData(e.target) });
      state.token = r.token; state.user = r.user;
      localStorage.setItem('token', r.token); localStorage.setItem('user', JSON.stringify(r.user));
      if ('Notification' in window && Notification.permission === 'default') Notification.requestPermission();
      location.hash = '#/'; render();
    } catch (err) { toast(err.message); }
  };
  $('#track').onsubmit = async (e) => {
    e.preventDefault();
    try {
      const a = await api(`/track?${new URLSearchParams(formData(e.target))}`);
      $('#track-result').innerHTML = `<p style="margin-top:14px"><b>${esc(a.candidate_name)}</b> — ${esc(a.profession)}, ${esc(a.nationality)}<br>Current step: <span class="pill">${esc(a.current_stage_name)}</span></p>${stepsHtml(a.progress)}`;
    } catch (err) { $('#track-result').innerHTML = `<p class="muted">${esc(err.message)}</p>`; }
  };
}

async function viewApplications(params) {
  const q = params.get('q') || '';
  const stageId = params.get('stage') || '';
  const [summary, apps] = await Promise.all([
    api('/applications/summary'),
    api(`/applications?${new URLSearchParams({ ...(q && { q }), ...(stageId && { stage_id: stageId }) })}`),
  ]);
  $('#view').innerHTML = `
    <h1>Applications</h1>
    <div class="stats" style="margin-bottom:18px">${summary.map((s) => `<div class="stat ${String(s.id) === stageId ? 'sel' : ''}" data-stage="${s.id}"><b>${s.count}</b><span>${esc(s.name)}</span></div>`).join('')}</div>
    <div class="card">
      <form id="search" class="row" style="margin-bottom:12px"><div style="flex:1"><input name="q" value="${esc(q)}" placeholder="Search name, reference, profession, nationality, passport…"></div><button>Search</button>${q || stageId ? '<a class="btn secondary" href="#/" style="background:var(--primary-weak);color:var(--primary)">Clear</a>' : ''}</form>
      <table><thead><tr><th>Reference</th><th>Name</th><th>Profession</th><th>Nationality</th><th>Client</th><th>Current step</th><th>Progress</th></tr></thead>
      <tbody>${apps.map((a) => `<tr class="click" data-id="${a.id}"><td>${esc(a.reference)}</td><td>${esc(a.candidate_name)}</td><td>${esc(a.profession)}</td><td>${esc(a.nationality)}</td><td>${esc(a.client_company || a.client_name || '-')}</td>
        <td><span class="pill ${a.current_stage_final ? 'ok' : ''}">${esc(a.current_stage_name || '-')}</span></td>
        <td><div class="bar"><i style="width:${a.step_count ? Math.round(((a.current_stage_final ? a.step_index : a.step_index - 1) / a.step_count) * 100) : 0}%"></i></div><small class="muted">${a.step_index}/${a.step_count}</small></td></tr>`).join('') || '<tr><td colspan="7" class="muted">No applications found</td></tr>'}</tbody></table>
    </div>`;
  $('#search').onsubmit = (e) => { e.preventDefault(); const v = formData(e.target).q; location.hash = `#/?${new URLSearchParams({ ...(v && { q: v }), ...(stageId && { stage: stageId }) })}`; };
  document.querySelectorAll('.stat').forEach((el) => (el.onclick = () => { location.hash = el.dataset.stage === stageId ? '#/' : `#/?stage=${el.dataset.stage}`; }));
  document.querySelectorAll('tr.click').forEach((el) => (el.onclick = () => (location.hash = `#/applications/${el.dataset.id}`)));
}

async function download(docId, name) {
  const res = await fetch(`/api/documents/${docId}/download`, { headers: { Authorization: `Bearer ${state.token}` } });
  if (!res.ok) return toast('Download failed');
  const url = URL.createObjectURL(await res.blob());
  Object.assign(document.createElement('a'), { href: url, download: name }).click();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
}

async function viewApplication(id) {
  const a = await api(`/applications/${id}`);
  const canEdit = ['admin', 'recruiter'].includes(state.user.role);
  const stageOptions = a.progress.steps.map((s) => `<option value="${s.id}" ${s.id === a.current_stage_id ? 'selected' : ''}>${esc(s.name)}</option>`).join('');
  $('#view').innerHTML = `
    <p><a href="#/">← Back to applications</a></p>
    <h1>${esc(a.candidate_name)} <span class="muted" style="font-weight:400">· ${esc(a.reference)}</span></h1>
    <div class="card"><h2>Progress — ${a.progress.percent}%</h2>${stepsHtml(a.progress)}
      ${canEdit ? `<form id="stage" class="row" style="margin-top:16px">
        <button type="button" class="secondary" id="prev">← Previous</button>
        <div><label>Move to step</label><select name="stage_id">${stageOptions}</select></div>
        <div style="flex:1"><label>Comment (sent to concerned parties)</label><input name="comment" placeholder="Optional"></div>
        <button>Update status</button><button type="button" id="next">Next step →</button></form>` : ''}
    </div>
    <div class="grid">
      <div class="card"><h2>Details</h2>
        <table>
          <tr><th>Name</th><td>${esc(a.candidate_name)}</td></tr>
          <tr><th>Profession</th><td>${esc(a.profession)}</td></tr>
          <tr><th>Nationality</th><td>${esc(a.nationality)}</td></tr>
          <tr><th>Passport no.</th><td>${esc(a.passport_number || '-')}</td></tr>
          <tr><th>Passport copy</th><td>${a.passport_file_id ? `<button class="link" data-dl="${a.passport_file_id}" data-name="passport">Download</button>` : '<span class="muted">Not uploaded</span>'}</td></tr>
          <tr><th>Client</th><td>${esc(a.client_company || a.client_name || '-')}</td></tr>
          <tr><th>Recruiter</th><td>${esc(a.recruiter_company || a.recruiter_name || '-')}</td></tr>
          <tr><th>Employee account</th><td>${esc(a.candidate_user_name || '-')}</td></tr>
          <tr><th>Arrival date</th><td>${esc(a.arrival_date || '-')}</td></tr>
          <tr><th>In current step since</th><td>${fmtDate(a.stage_entered_at)}</td></tr>
          ${a.notes ? `<tr><th>Notes</th><td>${esc(a.notes)}</td></tr>` : ''}
        </table>
      </div>
      <div class="card"><h2>History</h2><ul class="timeline">${a.history.map((h) => `<li><b>${esc(h.to_stage || '-')}</b>${h.from_stage ? ` <span class="muted">from ${esc(h.from_stage)}</span>` : ''}<br><small class="muted">${fmtDate(h.changed_at)} · ${esc(h.changed_by_name || '')}</small>${h.comment ? `<br>${esc(h.comment)}` : ''}</li>`).join('')}</ul></div>
    </div>
    <div class="card"><h2>Documents</h2>
      ${canEdit ? `<form id="upload" class="row" style="margin-bottom:14px">
        <div><label>Type</label><select name="doc_type">${DOC_TYPES.map((t) => `<option>${t}</option>`).join('')}</select></div>
        <div><label>Step</label><select name="stage_id">${stageOptions}</select></div>
        <div style="flex:1"><label>File (PDF, image, Word — max 15 MB)</label><input type="file" name="file" required></div><button>Upload</button></form>` : ''}
      <table><thead><tr><th>Type</th><th>File</th><th>Step</th><th>Uploaded</th><th></th></tr></thead><tbody>
      ${a.documents.map((d) => `<tr><td><span class="pill">${esc(d.doc_type)}</span></td><td>${esc(d.original_name)}</td><td>${esc(d.stage_name || '-')}</td><td>${fmtDate(d.uploaded_at)}<br><small class="muted">${esc(d.uploaded_by_name || '')}</small></td>
        <td><button class="link" data-dl="${d.id}" data-name="${esc(d.original_name)}">Download</button>${canEdit ? ` · <button class="link" data-del="${d.id}">Delete</button>` : ''}</td></tr>`).join('') || '<tr><td colspan="5" class="muted">No documents yet</td></tr>'}
      </tbody></table></div>
    ${canEdit ? `<div class="card"><h2>Edit details</h2><form id="edit" class="grid">
      ${['candidate_name', 'profession', 'nationality', 'passport_number', 'arrival_date'].map((f) => `<div><label>${f.replace('_', ' ')}</label><input name="${f}" ${f === 'arrival_date' ? 'type="date"' : ''} value="${esc(a[f] || '')}"></div>`).join('')}
      <div style="grid-column:1/-1"><label>Notes</label><textarea name="notes">${esc(a.notes || '')}</textarea></div><div><button>Save</button></div></form></div>` : ''}`;

  document.querySelectorAll('[data-dl]').forEach((b) => (b.onclick = () => download(b.dataset.dl, b.dataset.name)));
  if (!canEdit) return;
  const move = async (body) => { try { await api(`/applications/${id}/stage`, { method: 'POST', body }); toast('Status updated — parties notified'); viewApplication(id); } catch (e) { toast(e.message); } };
  $('#stage').onsubmit = (e) => { e.preventDefault(); move(formData(e.target)); };
  $('#next').onclick = () => move({ direction: 'next', comment: $('#stage [name=comment]').value });
  $('#prev').onclick = () => move({ direction: 'previous', comment: $('#stage [name=comment]').value });
  $('#upload').onsubmit = async (e) => {
    e.preventDefault();
    try { await api(`/applications/${id}/documents`, { method: 'POST', body: new FormData(e.target) }); toast('Document uploaded'); viewApplication(id); } catch (err) { toast(err.message); }
  };
  document.querySelectorAll('[data-del]').forEach((b) => (b.onclick = async () => {
    if (!confirm('Delete this document?')) return;
    try { await api(`/documents/${b.dataset.del}`, { method: 'DELETE' }); viewApplication(id); } catch (err) { toast(err.message); }
  }));
  $('#edit').onsubmit = async (e) => {
    e.preventDefault();
    try { await api(`/applications/${id}`, { method: 'PUT', body: formData(e.target) }); toast('Saved'); viewApplication(id); } catch (err) { toast(err.message); }
  };
}

async function viewNew() {
  const [clients, candidates, recruiters] = await Promise.all([
    api('/users?role=client'), api('/users?role=candidate'), state.user.role === 'admin' ? api('/users?role=recruiter') : Promise.resolve([]),
  ]);
  const opts = (list) => `<option value="">— none —</option>${list.map((u) => `<option value="${u.id}">${esc(u.company ? `${u.company} (${u.name})` : u.name)}</option>`).join('')}`;
  $('#view').innerHTML = `<h1>New application</h1>
    <form id="new" class="card">
      <div class="grid">
        <div><label>Name *</label><input name="candidate_name" required></div>
        <div><label>Profession *</label><input name="profession" required></div>
        <div><label>Nationality *</label><input name="nationality" required></div>
        <div><label>Passport number</label><input name="passport_number"></div>
        <div><label>Passport copy</label><input type="file" name="passport_file" accept="application/pdf,image/*"></div>
        <div><label>Client</label><select name="client_id">${opts(clients)}</select></div>
        <div><label>Employee / candidate login</label><select name="candidate_user_id">${opts(candidates)}</select></div>
        ${state.user.role === 'admin' ? `<div><label>Recruiting company</label><select name="recruiter_id">${opts(recruiters)}</select></div>` : ''}
        <div style="grid-column:1/-1"><label>Notes</label><textarea name="notes"></textarea></div>
      </div>
      <p class="muted">Need a new client or employee login? Create it under <a href="#/users">${state.user.role === 'admin' ? 'Users' : 'Clients & candidates'}</a>.</p>
      <button>Create application</button>
    </form>`;
  $('#new').onsubmit = async (e) => {
    e.preventDefault();
    const data = formData(e.target);
    const file = data.passport_file; delete data.passport_file;
    for (const k of ['client_id', 'candidate_user_id', 'recruiter_id']) data[k] = data[k] ? Number(data[k]) : null;
    try {
      const app = await api('/applications', { method: 'POST', body: data });
      if (file && file.size) {
        const fd = new FormData(); fd.append('file', file); fd.append('doc_type', 'passport');
        await api(`/applications/${app.id}/documents`, { method: 'POST', body: fd });
      }
      toast(`Application ${app.reference} created`);
      location.hash = `#/applications/${app.id}`;
    } catch (err) { toast(err.message); }
  };
}

async function viewUsers() {
  const users = await api('/users');
  const roles = state.user.role === 'admin' ? ['client', 'candidate', 'recruiter', 'admin'] : ['client', 'candidate'];
  $('#view').innerHTML = `<h1>${state.user.role === 'admin' ? 'Users' : 'Clients & candidates'}</h1>
    <form id="newuser" class="card"><h2>Create account</h2><div class="grid">
      <div><label>Role</label><select name="role">${roles.map((r) => `<option value="${r}">${ROLE_LABEL[r]}</option>`).join('')}</select></div>
      <div><label>Full name *</label><input name="name" required></div>
      <div><label>Email *</label><input name="email" type="email" required></div>
      <div><label>WhatsApp number</label><input name="phone" placeholder="e.g. 971501234567"></div>
      <div><label>Company</label><input name="company"></div>
      <div><label>Initial password *</label><input name="password" required minlength="6"></div>
    </div><button style="margin-top:12px">Create</button></form>
    <div class="card"><table><thead><tr><th>Name</th><th>Email</th><th>WhatsApp</th><th>Role</th><th>Company</th>${state.user.role === 'admin' ? '<th>Status</th>' : ''}</tr></thead><tbody>
    ${users.map((u) => `<tr><td>${esc(u.name)}</td><td>${esc(u.email)}</td><td>${esc(u.phone || '-')}</td><td>${ROLE_LABEL[u.role]}</td><td>${esc(u.company || '-')}</td>
      ${state.user.role === 'admin' ? `<td>${u.id === state.user.id ? 'active' : `<button class="link" data-toggle="${u.id}" data-active="${u.active}">${u.active ? 'Deactivate' : 'Activate'}</button>`}</td>` : ''}</tr>`).join('')}
    </tbody></table></div>`;
  $('#newuser').onsubmit = async (e) => {
    e.preventDefault();
    try { await api('/users', { method: 'POST', body: formData(e.target) }); toast('Account created'); viewUsers(); } catch (err) { toast(err.message); }
  };
  document.querySelectorAll('[data-toggle]').forEach((b) => (b.onclick = async () => {
    await api(`/users/${b.dataset.toggle}`, { method: 'PUT', body: { active: b.dataset.active !== '1' } }); viewUsers();
  }));
}

async function viewStages() {
  const stages = await api('/stages?all=1');
  const active = stages.filter((s) => s.active);
  $('#view').innerHTML = `<h1>Tracking steps</h1>
    <p class="muted">Rename, add, remove or reorder steps. "Follow-up days" controls when automatic reminders are sent if an application stays in a step too long (empty = default).</p>
    <div class="card"><table><thead><tr><th>#</th><th>Name</th><th>Description</th><th>Follow-up days</th><th>Final (arrival)</th><th>Order</th><th></th></tr></thead><tbody>
    ${active.map((s, i) => `<tr data-id="${s.id}"><td>${i + 1}</td><td><input name="name" value="${esc(s.name)}"></td><td><input name="description" value="${esc(s.description || '')}"></td>
      <td><input name="sla_days" type="number" min="0" style="width:90px" value="${s.sla_days ?? ''}"></td><td><input name="is_final" type="checkbox" style="width:auto" ${s.is_final ? 'checked' : ''}></td>
      <td><button class="secondary" data-up ${i === 0 ? 'disabled' : ''}>↑</button> <button class="secondary" data-down ${i === active.length - 1 ? 'disabled' : ''}>↓</button></td>
      <td><button data-save>Save</button> <button class="danger" data-del>Remove</button></td></tr>`).join('')}
    </tbody></table></div>
    <form id="addstage" class="card row"><div style="flex:1"><label>New step name</label><input name="name" required></div>
      <div><label>Insert at position</label><input name="position" type="number" min="1" value="${active.length + 1}" style="width:110px"></div>
      <div><label>Follow-up days</label><input name="sla_days" type="number" min="0" style="width:110px"></div><button>Add step</button></form>
    ${stages.some((s) => !s.active) ? `<div class="card"><h2>Removed steps</h2>${stages.filter((s) => !s.active).map((s) => `<span class="pill">${esc(s.name)}</span> <button class="link" data-restore="${s.id}">restore</button> `).join(' ')}</div>` : ''}`;

  const ids = active.map((s) => s.id);
  const reorder = async (i, j) => { [ids[i], ids[j]] = [ids[j], ids[i]]; await api('/stages/reorder', { method: 'PUT', body: { ids } }); viewStages(); };
  document.querySelectorAll('tr[data-id]').forEach((tr, i) => {
    const id = tr.dataset.id;
    $('[data-up]', tr).onclick = () => reorder(i, i - 1);
    $('[data-down]', tr).onclick = () => reorder(i, i + 1);
    $('[data-save]', tr).onclick = async () => {
      const sla = $('[name=sla_days]', tr).value;
      try {
        await api(`/stages/${id}`, { method: 'PUT', body: { name: $('[name=name]', tr).value, description: $('[name=description]', tr).value, sla_days: sla === '' ? null : Number(sla), is_final: $('[name=is_final]', tr).checked } });
        toast('Step saved');
      } catch (e) { toast(e.message); }
    };
    $('[data-del]', tr).onclick = async () => {
      if (!confirm('Remove this step?')) return;
      try { await api(`/stages/${id}`, { method: 'DELETE' }); viewStages(); } catch (e) { toast(e.message); }
    };
  });
  document.querySelectorAll('[data-restore]').forEach((b) => (b.onclick = async () => { await api(`/stages/${b.dataset.restore}`, { method: 'PUT', body: { active: true } }); viewStages(); }));
  $('#addstage').onsubmit = async (e) => {
    e.preventDefault();
    const d = formData(e.target);
    try { await api('/stages', { method: 'POST', body: { name: d.name, position: Number(d.position) || undefined, sla_days: d.sla_days ? Number(d.sla_days) : null } }); viewStages(); } catch (err) { toast(err.message); }
  };
}

async function viewCompanyDocs() {
  const docs = await api('/company-documents');
  $('#view').innerHTML = `<h1>Company documents</h1>
    <form id="cdoc" class="card row"><div><label>Type</label><select name="doc_type"><option>trade_license</option><option>registration</option><option>agreement</option><option>other</option></select></div>
      <div style="flex:1"><label>File</label><input type="file" name="file" required></div><button>Upload</button></form>
    <div class="card"><table><thead><tr><th>Type</th><th>File</th><th>Company</th><th>Uploaded</th><th></th></tr></thead><tbody>
    ${docs.map((d) => `<tr><td><span class="pill">${esc(d.doc_type)}</span></td><td>${esc(d.original_name)}</td><td>${esc(d.company || d.uploaded_by_name)}</td><td>${fmtDate(d.uploaded_at)}</td>
      <td><button class="link" data-dl="${d.id}" data-name="${esc(d.original_name)}">Download</button> · <button class="link" data-del="${d.id}">Delete</button></td></tr>`).join('') || '<tr><td colspan="5" class="muted">No documents yet</td></tr>'}
    </tbody></table></div>`;
  $('#cdoc').onsubmit = async (e) => {
    e.preventDefault();
    try { await api('/company-documents', { method: 'POST', body: new FormData(e.target) }); toast('Uploaded'); viewCompanyDocs(); } catch (err) { toast(err.message); }
  };
  document.querySelectorAll('[data-dl]').forEach((b) => (b.onclick = () => download(b.dataset.dl, b.dataset.name)));
  document.querySelectorAll('[data-del]').forEach((b) => (b.onclick = async () => { if (confirm('Delete?')) { await api(`/documents/${b.dataset.del}`, { method: 'DELETE' }); viewCompanyDocs(); } }));
}

async function viewDeliveries() {
  const [rows, health] = await Promise.all([api('/notifications/deliveries'), api('/health')]);
  $('#view').innerHTML = `<h1>Notification log</h1>
    <div class="card row" style="justify-content:space-between"><div>WhatsApp: <span class="pill">${health.whatsapp}</span> &nbsp; Push: <span class="pill">${health.push}</span>
      <div class="muted" style="font-size:13px">"console" means the channel is not configured yet and messages are written to the server log.</div></div>
      <button id="runfu">Run follow-ups now</button></div>
    <div class="card"><table><thead><tr><th>Time</th><th>User</th><th>Notification</th><th>Channel</th><th>Status</th><th>Detail</th></tr></thead><tbody>
    ${rows.map((d) => `<tr><td>${fmtDate(d.created_at)}</td><td>${esc(d.user_name)}</td><td>${esc(d.title)}</td><td>${esc(d.channel)}</td><td><span class="pill ${d.status === 'sent' ? 'ok' : ''}">${esc(d.status)}</span></td><td class="muted">${esc(d.detail || '')}</td></tr>`).join('') || '<tr><td colspan="6" class="muted">Nothing sent yet</td></tr>'}
    </tbody></table></div>`;
  $('#runfu').onclick = async () => { const r = await api('/notifications/followups/run', { method: 'POST' }); toast(`Follow-up reminders sent for ${r.reminded} application(s)`); viewDeliveries(); };
}

async function viewProfile() {
  const me = await api('/auth/me');
  $('#view').innerHTML = `<h1>My profile</h1>
    <form id="profile" class="card"><div class="grid">
      <div><label>Name</label><input name="name" value="${esc(me.name)}"></div>
      <div><label>Email</label><input value="${esc(me.email)}" disabled></div>
      <div><label>WhatsApp number (international, digits only)</label><input name="phone" value="${esc(me.phone || '')}" placeholder="971501234567"></div>
      <div><label>New password</label><input name="password" type="password" placeholder="Leave empty to keep"></div>
    </div>
    <p><label style="display:inline"><input type="checkbox" name="notify_whatsapp" style="width:auto" ${me.notify_whatsapp ? 'checked' : ''}> WhatsApp notifications</label>
    &nbsp; <label style="display:inline"><input type="checkbox" name="notify_push" style="width:auto" ${me.notify_push ? 'checked' : ''}> Mobile app notifications</label></p>
    <p class="muted">Role: ${ROLE_LABEL[me.role]}${me.company ? ` · ${esc(me.company)}` : ''}</p>
    <button>Save</button></form>`;
  $('#profile').onsubmit = async (e) => {
    e.preventDefault();
    const f = e.target;
    const body = { name: f.name.value, phone: f.phone.value, notify_whatsapp: f.notify_whatsapp.checked, notify_push: f.notify_push.checked };
    if (f.password.value) body.password = f.password.value;
    try { await api('/auth/me', { method: 'PUT', body }); toast('Profile saved'); } catch (err) { toast(err.message); }
  };
}

/* ---------------- Router ---------------- */
async function render() {
  const hash = location.hash || '#/';
  if (!state.token) { $('#topbar').hidden = true; return viewLogin(); }
  $('#topbar').hidden = false;
  $('#nav').innerHTML = navLinks();
  $('#who').textContent = `${state.user.name} · ${ROLE_LABEL[state.user.role]}`;
  startStream(); refreshBadge().catch(() => {});
  const [path, query] = hash.slice(1).split('?');
  const params = new URLSearchParams(query || '');
  try {
    let m;
    if ((m = path.match(/^\/applications\/(\d+)$/))) return await viewApplication(m[1]);
    switch (path) {
      case '/new': return await viewNew();
      case '/users': return await viewUsers();
      case '/stages': return await viewStages();
      case '/company-docs': return await viewCompanyDocs();
      case '/deliveries': return await viewDeliveries();
      case '/profile': return await viewProfile();
      default: return await viewApplications(params);
    }
  } catch (e) {
    $('#view').innerHTML = `<div class="card">${esc(e.message)}</div>`;
  }
}

$('#logout').onclick = logout;
$('#bell').onclick = openNotifications;
window.addEventListener('hashchange', render);
render();
