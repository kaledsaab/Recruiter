# Recruiter — Recruitment Portal & Follow-up System

A web portal that lets **clients**, **employees/candidates** and **recruiting companies** follow each
application through a configurable set of tracking steps, with automatic notifications over the
**mobile app (push)**, **in-app (live)** and **WhatsApp**, plus automatic follow-up reminders.

## Features

| Requirement | Implementation |
|---|---|
| Clients & employees log in and see application status | Role-based login; each user only sees the applications they are linked to. Visual step tracker, history and documents. |
| Public status check | `Track an application` on the login page (reference + passport number, no login). |
| Applicant details: name, profession, nationality, passport copy, client | Captured when the application is created; passport copy uploaded as a `passport` document. |
| Step 1 … Step 8 → Arrival | Seeded by default. **Admins can rename, add, remove and reorder steps** at any time (`Steps` page). |
| Recruiting company logs in and uploads documents | Recruiters upload documents per application/step (PDF, images, Word, max 15 MB) and their own company documents. |
| Notifications to app & WhatsApp on status change | Every status change, new document or new application notifies all concerned parties (candidate, client, recruiter — except the person who made the change) by in-app/live, mobile push (Firebase) and WhatsApp (Meta Cloud API). |
| Automatic communication & follow-up | A scheduler checks applications stuck in a step longer than the step's *follow-up days* (or the default) and reminds the recruiter (action needed) and informs the client & candidate. Repeats every period until the status changes. |

### Roles
- **admin** – everything: users, steps, all applications, notification log, manual follow-up run.
- **recruiter** (recruiting company) – creates applications, changes status, uploads documents, creates client/candidate logins. Sees only its own applications.
- **client** – read-only view of its applications and documents.
- **candidate** (employee) – read-only view of their own application.

## Getting started

Requires **Node.js 22.13+** (uses the built-in `node:sqlite`, so there are no native dependencies).

```bash
npm install
```

```bash
cp .env.example .env
```

```bash
npm start
```

Open http://localhost:3000 and sign in with the default admin (`admin@example.com` / `admin123`,
change it in `.env` **before first start**, then change the password from *My profile*).

Run the tests:

```bash
npm test
```

## Notifications setup

Without credentials, WhatsApp and push messages are **written to the server console** so you can
develop without accounts. The *Notification log* page shows each delivery per channel.

**WhatsApp (Meta WhatsApp Cloud API)** — set `WHATSAPP_TOKEN` and `WHATSAPP_PHONE_NUMBER_ID`.
Meta only allows free-text messages within 24h of the user's last message; for business-initiated
notifications create an approved template with one body variable (`{{1}}`) and set
`WHATSAPP_TEMPLATE_NAME` / `WHATSAPP_TEMPLATE_LANG`. Users' WhatsApp numbers are stored in
international format (e.g. `971501234567`).

**Mobile push (Firebase Cloud Messaging)** — set `FCM_SERVICE_ACCOUNT_FILE` to a Firebase service
account JSON. The mobile app registers its FCM token after login with
`POST /api/auth/devices { "token": "...", "platform": "android|ios" }`.

**Live in-app** — the web portal listens on `GET /api/notifications/stream` (Server-Sent Events)
and shows a toast + browser notification immediately.

## REST API (summary)

All endpoints except login and track need `Authorization: Bearer <token>`.

| Method | Path | Who | Purpose |
|---|---|---|---|
| POST | `/api/auth/login` | all | Get a token |
| GET/PUT | `/api/auth/me` | all | Profile, WhatsApp number, notification preferences |
| POST | `/api/auth/devices` | all | Register mobile push token |
| GET | `/api/track?reference=&passport=` | public | Status lookup |
| GET/POST | `/api/users` | admin, recruiter | List / create accounts |
| GET | `/api/stages` | all | Active steps in order |
| POST/PUT/DELETE | `/api/stages[/:id]`, PUT `/api/stages/reorder` | admin | Configure steps |
| GET | `/api/applications[?q=&stage_id=]`, `/api/applications/summary` | all (scoped) | List / counts per step |
| GET | `/api/applications/:id` | all (scoped) | Details, progress, history, documents |
| POST/PUT | `/api/applications[/:id]` | admin, recruiter | Create / edit |
| POST | `/api/applications/:id/stage` | admin, recruiter | `{stage_id}` or `{direction:"next"\|"previous"}`, optional `comment` |
| POST | `/api/applications/:id/documents` | admin, recruiter | multipart `file`, `doc_type`, `stage_id` |
| GET/POST | `/api/company-documents` | admin, recruiter | Company documents |
| GET | `/api/documents/:id/download` | scoped | Download |
| GET | `/api/notifications`, POST `/api/notifications/read` | all | Inbox |
| GET | `/api/notifications/deliveries` | admin | Delivery log |
| POST | `/api/notifications/followups/run` | admin | Run follow-ups now |

## Project layout

```
src/
  server.js            entry point (HTTP server + follow-up scheduler)
  app.js               Express app wiring
  config.js            settings from environment / .env
  db.js                SQLite schema & seed (default steps, admin)
  auth.js              password hashing, JWT, role guard
  applications.js      access scoping & progress helpers
  followup.js          automatic follow-up reminders
  notifications/       notifier + WhatsApp + push channels
  routes/              REST endpoints
public/                web portal (no build step)
test/                  API tests (node:test)
```
