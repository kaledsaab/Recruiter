const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createApp } = require('../src/app');
const { runFollowups } = require('../src/followup');

const sent = { whatsapp: [], push: [] };
const fakeWhatsApp = { name: 'whatsapp', configured: true, send: async (phone, text) => { sent.whatsapp.push({ phone, text }); return { status: 'sent' }; } };
const fakePush = { name: 'push', configured: true, send: async (tokens, msg) => { sent.push.push({ tokens, ...msg }); return { status: tokens.length ? 'sent' : 'skipped' }; } };

let server, base, ctx, tmp;
const tokens = {};
const ids = {};

async function call(method, url, { token, body, form } = {}) {
  const headers = {};
  if (token) headers.Authorization = `Bearer ${token}`;
  if (body) headers['Content-Type'] = 'application/json';
  const res = await fetch(base + url, { method, headers, body: form || (body && JSON.stringify(body)) });
  const data = await res.json().catch(() => null);
  return { status: res.status, data };
}
const login = async (email, password) => (await call('POST', '/api/auth/login', { body: { email, password } })).data.token;

before(async () => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'recruiter-test-'));
  const built = createApp({
    dbFile: ':memory:',
    whatsapp: fakeWhatsApp,
    push: fakePush,
    config: { uploadDir: tmp, adminEmail: 'admin@test.com', adminPassword: 'secret', jwtSecret: 'test', followup: { defaultDays: 7, intervalMinutes: 60 } },
  });
  ctx = built.ctx;
  await new Promise((r) => { server = built.app.listen(0, r); });
  base = `http://127.0.0.1:${server.address().port}`;
  tokens.admin = await login('admin@test.com', 'secret');
});

after(() => { server.close(); fs.rmSync(tmp, { recursive: true, force: true }); });

test('default steps: Step 1..8 then Arrival', async () => {
  const { data } = await call('GET', '/api/stages', { token: tokens.admin });
  assert.deepEqual(data.map((s) => s.name), ['Step 1', 'Step 2', 'Step 3', 'Step 4', 'Step 5', 'Step 6', 'Step 7', 'Step 8', 'Arrival']);
  assert.equal(data.at(-1).is_final, 1);
});

test('rejects bad login and unauthenticated access', async () => {
  assert.equal((await call('POST', '/api/auth/login', { body: { email: 'admin@test.com', password: 'x' } })).status, 401);
  assert.equal((await call('GET', '/api/applications')).status, 401);
});

test('admin creates a recruiter; recruiter creates client and candidate', async () => {
  const r = await call('POST', '/api/users', { token: tokens.admin, body: { name: 'Gulf Recruit', email: 'rec@test.com', role: 'recruiter', company: 'Gulf Recruit LLC', password: 'pw1234', phone: '971500000001' } });
  assert.equal(r.status, 201);
  ids.recruiter = r.data.id;
  tokens.recruiter = await login('rec@test.com', 'pw1234');

  const forbidden = await call('POST', '/api/users', { token: tokens.recruiter, body: { name: 'X', email: 'x@test.com', role: 'admin', password: 'pw' } });
  assert.equal(forbidden.status, 403);

  const c = await call('POST', '/api/users', { token: tokens.recruiter, body: { name: 'Client Co', email: 'client@test.com', role: 'client', password: 'pw1234', phone: '+971 50 000 0002' } });
  const e = await call('POST', '/api/users', { token: tokens.recruiter, body: { name: 'Ali Worker', email: 'emp@test.com', role: 'candidate', password: 'pw1234', phone: '971500000003' } });
  ids.client = c.data.id; ids.candidate = e.data.id;
  tokens.client = await login('client@test.com', 'pw1234');
  tokens.candidate = await login('emp@test.com', 'pw1234');

  // other recruiter for isolation checks
  await call('POST', '/api/users', { token: tokens.admin, body: { name: 'Other', email: 'other@test.com', role: 'recruiter', password: 'pw1234' } });
  tokens.other = await login('other@test.com', 'pw1234');
});

test('recruiter creates application; parties notified on app + WhatsApp', async () => {
  await call('POST', '/api/auth/devices', { token: tokens.client, body: { token: 'device-abc', platform: 'android' } });
  const r = await call('POST', '/api/applications', { token: tokens.recruiter, body: {
    candidate_name: 'Ali Worker', profession: 'Electrician', nationality: 'Indian', passport_number: 'P1234567',
    client_id: ids.client, candidate_user_id: ids.candidate,
  } });
  assert.equal(r.status, 201);
  assert.equal(r.data.current_stage_name, 'Step 1');
  assert.equal(r.data.recruiter_id, ids.recruiter);
  ids.app = r.data.id; ids.ref = r.data.reference;
  await ctx.notifier.flush();

  const n = await call('GET', '/api/notifications', { token: tokens.client });
  assert.equal(n.data.unread, 1);
  assert.equal(n.data.items[0].kind, 'created');
  assert.ok(sent.whatsapp.some((m) => m.phone === '+971 50 000 0002'));
  assert.ok(sent.push.some((p) => p.tokens.includes('device-abc')));
});

test('validation: required fields', async () => {
  const r = await call('POST', '/api/applications', { token: tokens.recruiter, body: { candidate_name: 'X' } });
  assert.equal(r.status, 400);
});

test('access control: each party sees only its applications; clients cannot change status', async () => {
  for (const who of ['client', 'candidate', 'recruiter', 'admin']) {
    const { data } = await call('GET', '/api/applications', { token: tokens[who] });
    assert.equal(data.length, 1, who);
  }
  assert.equal((await call('GET', '/api/applications', { token: tokens.other })).data.length, 0);
  assert.equal((await call('GET', `/api/applications/${ids.app}`, { token: tokens.other })).status, 404);
  assert.equal((await call('POST', `/api/applications/${ids.app}/stage`, { token: tokens.client, body: { direction: 'next' } })).status, 403);
});

test('recruiter uploads passport copy; client and candidate can download', async () => {
  const form = new FormData();
  form.append('file', new Blob(['%PDF-1.4 fake'], { type: 'application/pdf' }), 'passport.pdf');
  form.append('doc_type', 'passport');
  const r = await call('POST', `/api/applications/${ids.app}/documents`, { token: tokens.recruiter, form });
  assert.equal(r.status, 201);
  ids.doc = r.data.id;

  const app = await call('GET', `/api/applications/${ids.app}`, { token: tokens.candidate });
  assert.equal(app.data.passport_file_id, ids.doc);
  assert.equal(app.data.documents.length, 1);

  const dl = await fetch(`${base}/api/documents/${ids.doc}/download`, { headers: { Authorization: `Bearer ${tokens.client}` } });
  assert.equal(dl.status, 200);
  assert.equal(await dl.text(), '%PDF-1.4 fake');
  const denied = await fetch(`${base}/api/documents/${ids.doc}/download`, { headers: { Authorization: `Bearer ${tokens.other}` } });
  assert.equal(denied.status, 404);

  const bad = new FormData();
  bad.append('file', new Blob(['x'], { type: 'application/x-msdownload' }), 'evil.exe');
  assert.equal((await call('POST', `/api/applications/${ids.app}/documents`, { token: tokens.recruiter, form: bad })).status, 400);
});

test('status change notifies concerned parties and records history', async () => {
  sent.whatsapp.length = 0;
  const r = await call('POST', `/api/applications/${ids.app}/stage`, { token: tokens.recruiter, body: { direction: 'next', comment: 'Visa applied' } });
  assert.equal(r.status, 200);
  assert.equal(r.data.current_stage_name, 'Step 2');
  await ctx.notifier.flush();
  const phones = sent.whatsapp.map((m) => m.phone);
  assert.ok(phones.includes('+971 50 000 0002') && phones.includes('971500000003'));
  assert.ok(!phones.includes('971500000001'), 'actor not notified');
  assert.match(sent.whatsapp[0].text, /Step 2.*Visa applied/s);

  const d = await call('GET', `/api/applications/${ids.app}`, { token: tokens.client });
  assert.equal(d.data.history.length, 2);
  assert.equal(d.data.progress.steps[0].state, 'done');
  assert.equal(d.data.progress.steps[1].state, 'current');
});

test('moving to Arrival marks complete and sets arrival date', async () => {
  const stages = (await call('GET', '/api/stages', { token: tokens.admin })).data;
  const r = await call('POST', `/api/applications/${ids.app}/stage`, { token: tokens.admin, body: { stage_id: stages.at(-1).id } });
  assert.equal(r.data.current_stage_name, 'Arrival');
  assert.ok(r.data.arrival_date);
  assert.equal(r.data.progress.percent, 100);
});

test('public tracking by reference + passport', async () => {
  const ok = await call('GET', `/api/track?reference=${ids.ref}&passport=p1234567`);
  assert.equal(ok.status, 200);
  assert.equal(ok.data.current_stage_name, 'Arrival');
  assert.equal(ok.data.id, undefined);
  assert.equal((await call('GET', `/api/track?reference=${ids.ref}&passport=WRONG`)).status, 404);
});

test('admin can rename, add, reorder and remove steps', async () => {
  let stages = (await call('GET', '/api/stages', { token: tokens.admin })).data;
  const r1 = await call('PUT', `/api/stages/${stages[0].id}`, { token: tokens.admin, body: { name: 'Medical test', sla_days: 3 } });
  assert.equal(r1.data.name, 'Medical test');
  assert.equal((await call('PUT', `/api/stages/${stages[0].id}`, { token: tokens.recruiter, body: { name: 'x' } })).status, 403);

  const added = await call('POST', '/api/stages', { token: tokens.admin, body: { name: 'Step 9', position: 9 } });
  assert.equal(added.status, 201);
  stages = (await call('GET', '/api/stages', { token: tokens.admin })).data;
  assert.equal(stages.length, 10);
  assert.equal(stages[8].name, 'Step 9');
  assert.equal(stages[9].name, 'Arrival');

  const reversed = stages.map((s) => s.id).reverse();
  const re = await call('PUT', '/api/stages/reorder', { token: tokens.admin, body: { ids: reversed } });
  assert.equal(re.data[0].name, 'Arrival');
  await call('PUT', '/api/stages/reorder', { token: tokens.admin, body: { ids: reversed.reverse() } });

  const del = await call('DELETE', `/api/stages/${added.data.id}`, { token: tokens.admin });
  assert.equal(del.data.deleted, true);
  // step used in history is deactivated instead of deleted
  const del2 = await call('DELETE', `/api/stages/${stages[1].id}`, { token: tokens.admin });
  assert.equal(del2.data.deactivated, true);
  assert.equal((await call('GET', '/api/stages', { token: tokens.admin })).data.length, 8);
});

test('automatic follow-up reminds recruiter when application is stuck', async () => {
  const r = await call('POST', '/api/applications', { token: tokens.recruiter, body: {
    candidate_name: 'Sara', profession: 'Nurse', nationality: 'Filipino', client_id: ids.client, candidate_user_id: ids.candidate,
  } });
  await ctx.notifier.flush();
  // First step was renamed to "Medical test" with sla_days = 3
  assert.equal(runFollowups(ctx), 0, 'not yet due');
  const later = new Date(Date.now() + 4 * 86400000);
  assert.equal(runFollowups(ctx, later), 1);
  assert.equal(runFollowups(ctx, later), 0, 'no duplicate reminder');
  await ctx.notifier.flush();
  const n = await call('GET', '/api/notifications', { token: tokens.recruiter });
  assert.ok(n.data.items.some((x) => x.kind === 'followup' && x.application_id === r.data.id));
  assert.equal(runFollowups(ctx, new Date(Date.now() + 8 * 86400000)), 1, 'repeats after another SLA period');
});

test('delivery log records each channel', async () => {
  const { data } = await call('GET', '/api/notifications/deliveries', { token: tokens.admin });
  const channels = new Set(data.map((d) => d.channel));
  assert.ok(channels.has('in_app') && channels.has('whatsapp') && channels.has('push'));
});
