const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');

const SCHEMA = `
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  email TEXT NOT NULL UNIQUE,
  phone TEXT,                       -- WhatsApp number in international format, e.g. 971501234567
  role TEXT NOT NULL CHECK (role IN ('admin','recruiter','client','candidate')),
  company TEXT,
  password_hash TEXT NOT NULL,
  notify_whatsapp INTEGER NOT NULL DEFAULT 1,
  notify_push INTEGER NOT NULL DEFAULT 1,
  active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Configurable tracking steps (names, number and order can be changed by an admin)
CREATE TABLE IF NOT EXISTS stages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  description TEXT,
  position INTEGER NOT NULL,
  sla_days INTEGER,                 -- days before an automatic follow-up (NULL = default)
  is_final INTEGER NOT NULL DEFAULT 0,
  active INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE IF NOT EXISTS applications (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  reference TEXT NOT NULL UNIQUE,
  candidate_name TEXT NOT NULL,
  profession TEXT NOT NULL,
  nationality TEXT NOT NULL,
  passport_number TEXT,
  passport_file_id INTEGER REFERENCES documents(id),
  client_id INTEGER REFERENCES users(id),
  recruiter_id INTEGER REFERENCES users(id),
  candidate_user_id INTEGER REFERENCES users(id),
  current_stage_id INTEGER REFERENCES stages(id),
  stage_entered_at TEXT NOT NULL DEFAULT (datetime('now')),
  last_followup_at TEXT,
  arrival_date TEXT,
  notes TEXT,
  created_by INTEGER REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS stage_history (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  application_id INTEGER NOT NULL REFERENCES applications(id) ON DELETE CASCADE,
  from_stage_id INTEGER REFERENCES stages(id),
  to_stage_id INTEGER REFERENCES stages(id),
  comment TEXT,
  changed_by INTEGER REFERENCES users(id),
  changed_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS documents (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  application_id INTEGER REFERENCES applications(id) ON DELETE CASCADE,
  stage_id INTEGER REFERENCES stages(id),
  doc_type TEXT NOT NULL DEFAULT 'other',  -- passport, visa, contract, medical, ticket, other...
  original_name TEXT NOT NULL,
  stored_name TEXT NOT NULL,
  mime_type TEXT,
  size INTEGER,
  uploaded_by INTEGER REFERENCES users(id),
  uploaded_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS notifications (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id),
  application_id INTEGER REFERENCES applications(id) ON DELETE CASCADE,
  kind TEXT NOT NULL,               -- stage_change, document, followup, created
  title TEXT NOT NULL,
  body TEXT NOT NULL,
  read_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Delivery log per channel (in-app, push, whatsapp)
CREATE TABLE IF NOT EXISTS notification_deliveries (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  notification_id INTEGER NOT NULL REFERENCES notifications(id) ON DELETE CASCADE,
  channel TEXT NOT NULL,
  status TEXT NOT NULL,             -- sent, failed, skipped, logged
  detail TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS device_tokens (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token TEXT NOT NULL UNIQUE,
  platform TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_app_client ON applications(client_id);
CREATE INDEX IF NOT EXISTS idx_app_recruiter ON applications(recruiter_id);
CREATE INDEX IF NOT EXISTS idx_app_candidate ON applications(candidate_user_id);
CREATE INDEX IF NOT EXISTS idx_notif_user ON notifications(user_id, read_at);
`;

const DEFAULT_STAGES = [
  ...Array.from({ length: 8 }, (_, i) => ({ name: `Step ${i + 1}`, final: 0 })),
  { name: 'Arrival', final: 1 },
];

function openDb(file, { adminEmail, adminPassword, hashPassword }) {
  if (file !== ':memory:') fs.mkdirSync(path.dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  db.exec('PRAGMA foreign_keys = ON; PRAGMA journal_mode = WAL;');
  db.exec(SCHEMA);

  // Seed default stages
  if (db.prepare('SELECT COUNT(*) AS n FROM stages').get().n === 0) {
    const ins = db.prepare('INSERT INTO stages (name, position, is_final) VALUES (?, ?, ?)');
    DEFAULT_STAGES.forEach((s, i) => ins.run(s.name, i + 1, s.final));
  }
  // Seed admin
  if (db.prepare("SELECT COUNT(*) AS n FROM users WHERE role = 'admin'").get().n === 0) {
    db.prepare("INSERT INTO users (name, email, role, password_hash) VALUES ('Administrator', ?, 'admin', ?)")
      .run(adminEmail.toLowerCase(), hashPassword(adminPassword));
  }
  return db;
}

/** Run fn inside a transaction. */
function tx(db, fn) {
  db.exec('BEGIN');
  try {
    const r = fn();
    db.exec('COMMIT');
    return r;
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
}

module.exports = { openDb, tx };
