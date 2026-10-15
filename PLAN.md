# GenQR — Project Plan

Status: **v0.3 — agreed** · 2026-10-15 · Phase 1 in progress.

---

## 1. Goal

An internal web app for generating branded QR codes. It also works as a URL shortener with click analytics. Users sign in with local accounts or Active Directory. Admins manage configuration, users and roles.

Expected load: about **100 users** and **100 clicks/day**. Primary target is **Linux**, but the app must also run on Windows.

## 2. Decisions Log

| # | Topic | Decision |
|---|---|---|
| D1 | Email protocol | **SMTP** (no SNMP). Admins can switch email sending on or off globally. |
| D2 | SMTP provider | Generic SMTP settings. Gmail comes as a preset (`smtp.gmail.com:587`, STARTTLS, app password), but any SMTP server works. |
| D3 | User sources | Admins can **import users from AD** or **create local users** (password stored hashed in the app DB). |
| D4 | Login order | Look up the **local DB first**. A local user is checked against the stored hash. An AD user is checked by binding to AD. |
| D5 | Short URL format | `https://<app host>/short/<code>`, e.g. `https://genqr.jeddah-cables.com/short/aB3xK9q` |
| D6 | Roles | Assigned **manually** by admins (admin / user). No AD group mapping. |
| D7 | Word/PDF export | **QR code only**, no template. |
| D8 | Source control | Git repository. Updates are applied with an **update script built on `git pull`**. |
| D9 | Database | **Not tied to SQLite.** Starts on SQLite. An admin can switch to **MySQL/MariaDB, PostgreSQL or SQL Server** from the UI. The required driver is installed automatically and the config files are written for them. |
| D10 | Non-imported AD users | **Never log in.** An AD user must be imported by an admin first. Anyone not in the local DB is rejected without contacting AD. |
| D11 | Git hosting | **GitHub** |
| D12 | Updating | From the **server command line** *and* an **"Update now" button** in the admin UI |
| D13 | DB switch | **Copy existing data** into the new database |
| D14 | Ops tooling | **One-line installer**, a **control script** (`status/start/stop/restart`) and a **CLI admin password reset** |

## 3. Tech Stack

| Layer | Choice | Notes |
|---|---|---|
| Runtime | Node.js 22 LTS | Linux and Windows |
| Backend | Express + TypeScript | REST JSON API |
| Frontend | React 18 + Vite + TypeScript, MUI | |
| **DB access** | **Knex.js** (query builder + migrations) | One codebase and one set of migrations for SQLite, MySQL, PostgreSQL and MSSQL. See section 6. |
| DB drivers | `better-sqlite3` (bundled), `mysql2`, `pg`, `tedious` (installed on demand) | |
| AD / LDAP | `ldapts` | LDAPS / StartTLS |
| Password hashing | `argon2` | Local users |
| Sessions | httpOnly secure cookie; sessions stored in the active DB | |
| QR | `qrcode` (matrix) + custom SVG renderer | Colors, logo, module styles |
| Export | `sharp` (PNG/JPG), `pdfkit` (PDF), `docx` (Word) | |
| Email | `nodemailer` | |
| Analytics | `ua-parser-js`, optional GeoLite2 | |
| Charts | Recharts | |
| Process manager | **systemd** on Linux (Windows Service via NSSM on Windows) | Needed for restart after an update or a DB switch |

## 4. Roles & Permissions

| Capability | User | Admin |
|---|:-:|:-:|
| Create / download / print / email own QR codes | ✅ | ✅ |
| View own QR history | ✅ | ✅ |
| Edit redirect target of own short links | ✅ | ✅ |
| View analytics for own links | ✅ | ✅ |
| View / edit **all** QR codes & short links | ❌ | ✅ |
| View analytics for all links | ❌ | ✅ |
| Manage users & roles | ❌ | ✅ |
| Configure AD, SMTP, database, branding, logos | ❌ | ✅ |
| View audit log, system/version info | ❌ | ✅ |

## 5. Features

### 5.1 First-launch setup wizard
- Runs when the DB has no users. Every other route redirects to `/setup`.
- Collects the admin **username, password** and **recovery email**.
- **Security:** a one-time **setup token** is printed in the server console/log, and the wizard asks for it. This stops anyone else on the network claiming admin first.
- This first admin is a local account. It is the break-glass login that still works if AD is down.

### 5.2 Authentication (D4)
```
login(username, password):
  user = DB.find(username)            # local DB first
  if user and user.source == 'local': verify argon2 hash
  elif user and user.source == 'ad':  LDAP bind as that user against AD
  else:                               # not in local DB (D10)
      reject with generic "invalid username or password" — AD is never contacted
  check user.is_active → create session
```
- Usernames are **unique across both sources**. An admin cannot create a local user with the same name as an imported AD user, or the reverse.
- Login rate limiting, lockout after N failures, and a configurable session timeout.
- **Password reset** for local users: an email link (needs SMTP). Fallback: CLI command `genqrctl reset-password <username>` (section 7.3).
- Admins can also set or reset a local user's password from the UI.
- AD users change their passwords through normal corporate channels.

### 5.3 Admin: Active Directory configuration
- Server URL(s), LDAPS/StartTLS, CA certificate, bind DN and password, base DN, user filter, and attribute mapping (sAMAccountName, mail, displayName).
- **Test connection** and **test user lookup** buttons.
- Secrets are encrypted at rest (AES-256-GCM). The key lives in `.env`.

### 5.4 Admin: User management
- **Import from AD:** search the directory, select users, assign a role, import.
- **Add local user:** username, display name, email, role and an initial password, with an optional "must change password at first login" flag.
- Change role, enable or disable, reset a local password, delete (with ownership reassignment).
- Optional nightly job that disables imported users who are disabled or removed in AD.

### 5.5 QR code creation
- **Content:** URL (dynamic, through a short link) or free text (static).
- **Styling:**
  - Foreground/background colors or a gradient, module shape, and eye/corner style and color
  - **Centered logo** from an upload or the admin logo library. Error correction is forced to **H** whenever a logo is used, and logo size is capped at about 25%.
  - Margin, size/DPI, and a contrast warning
- Live preview. Admin-defined **brand presets** for one-click on-brand codes.
- Every QR is saved with: creator, content, type, style, short link, and created/updated timestamps. It can be searched and reopened later.

### 5.6 Output: download, print, email
- **Download:** PNG, JPG, SVG, PDF, DOCX. Each contains the QR image only (D7) and is rendered server-side from one SVG.
- **Print:** a print page with a size choice.
- **Email:** recipients, subject, message and format(s), sent over SMTP. **Global on/off toggle.** When it is off, the button is hidden and the API refuses email requests.

### 5.7 Short URL redirector (D5)
- Route: `GET /short/:code`. The code is base62, 7 characters, with confusable characters excluded. Custom aliases are optional.
- The short link's base URL comes from the admin setting **"Public base URL"**, which defaults to the host entered in the setup wizard. It is never taken from the request's Host header, which can be spoofed.
  > ⚠ Printed QR codes contain this hostname. Changing it later breaks every code already printed, so the UI shows a warning when it is changed.
- **HTTP 302** redirects (not cached by browsers), so targets stay editable and every click is counted.
- The owner or an admin can edit the target, enable/disable the link and set an expiry date. Every change is kept in the link's history.
- Disabled, expired or unknown links show a branded "link not available" page.
- Only `http`/`https` targets are allowed. An optional domain allowlist or blocklist prevents open-redirect abuse.

### 5.8 Click analytics
- Each redirect logs: time, referrer, browser, OS, device, **source** (QR scan vs direct, via `?s=qr` in the QR-encoded URL), hashed IP, optional country, and a bot flag.
- Per-link and global dashboards, plus CSV export. Retention purges raw clicks after N months and keeps the daily aggregates.

### 5.9 Audit log
Records logins (success and failure), setup, every settings change (AD, SMTP, email toggle, DB switch), user and role changes, QR and link changes, emails sent and updates applied.

## 6. Database Abstraction & Switching (D9)

### 6.1 Approach
- All data access goes through **Knex**, with no raw dialect-specific SQL. Migrations use the Knex schema builder, so **one set of migrations** runs on all four engines.
- Data types are kept portable: string/text, integer, boolean, timestamps, and JSON stored as text.
- The CI test suite runs against **all four engines** using Docker containers. Then a switch never lands on a database that was never tested.

### 6.2 Where the connection lives
```
config/database.json     (git-ignored, written by the app; generated from database.example.json)
{
  "client": "sqlite",             // sqlite | mysql | pg | mssql
  "connection": { "filename": "./data/genqr.db" }
}
```
The DB password is stored encrypted with the key from `.env`. Tracked files are never modified. That matters so `git pull` updates never conflict with local config.

### 6.3 Driver auto-install
- `better-sqlite3` ships with the app.
- Other drivers are installed **on demand** into a separate, git-ignored folder `drivers/` (`npm install --prefix ./drivers mysql2@<pinned version>`). The app loads them from there.
  - Why a separate folder: the tracked `package.json` / `package-lock.json` stay untouched, so `git pull` never conflicts.
  - Driver versions are pinned in a tracked file `drivers.manifest.json`. The update script reinstalls the active driver after each update.
- Requirements: the server needs access to the npm registry (or an internal npm mirror), and the service user needs write access to the app folder.

### 6.4 Switch wizard (Admin → Settings → Database)
1. Choose an engine and enter host, port, database, user, password and TLS options.
2. **Install driver** (progress is shown) → **Test connection**.
3. **Run migrations** on the target to create the schema there.
4. **Copy data** from the current DB to the target table by table, in foreign-key order and in batches, then verify row counts.
5. Back up the current config, write the new `config/database.json`, and **restart** the service through systemd.
6. If the app fails to start on the new DB, it falls back to the previous config automatically and logs the error.

The old SQLite file is kept as a backup. A CLI version is also available: `npm run db:switch` for headless or recovery use.

## 7. Install, Control & Update Tooling (D8, D12, D14)

### 7.1 One-line installer
Linux (run as root):
```bash
curl -fsSL https://raw.githubusercontent.com/<org>/GenQR/main/scripts/install.sh | sudo bash
```
Windows (elevated PowerShell):
```powershell
irm https://raw.githubusercontent.com/<org>/GenQR/main/scripts/install.ps1 | iex
```
Options are passed as env vars: `GENQR_DIR` (default `/opt/genqr`), `GENQR_PORT` (default `3000`), `GENQR_BRANCH` (default `main`), `GENQR_REPO`.

What the installer does:
1. Checks the OS and installs **git**, **Node.js 22 LTS** (NodeSource) and build tools if they're missing.
2. Creates the system user `genqr` and clones the repo into `/opt/genqr`.
3. `npm ci` and builds the client.
4. Generates `.env` with a random session secret and encryption key, and creates `config/database.json` (SQLite).
5. Runs DB migrations.
6. Installs the systemd units (`genqr.service`, `genqr-update.service`, `genqr-update.path`) and the `genqrctl` command in `/usr/local/bin`.
7. Starts the service and prints the URL plus the **one-time setup token**.

Re-running the installer is safe: it detects an existing install and does an update instead.

### 7.2 Control script — `genqrctl`
One command for all server operations (wraps `systemctl` on Linux, the Windows Service on Windows):

| Command | Action |
|---|---|
| `genqrctl status` | Service state, version/commit, port, DB engine, health check |
| `genqrctl start` / `stop` / `restart` | Service control |
| `genqrctl logs [-f]` | Show / follow logs (journalctl) |
| `genqrctl update` | Run the update procedure (7.4) |
| `genqrctl reset-password <username>` | Set a new password for a local user (7.3) |
| `genqrctl setup-token` | Re-print the setup token (only while setup is not completed) |
| `genqrctl version` | Show installed version and commit |

### 7.3 CLI password reset
`genqrctl reset-password admin`
- Prompts twice for the new password, hidden as it's typed, and enforces the password policy. A `--password-stdin` option supports automation.
- Works for **local** users only, since AD passwords live in AD. It can also re-enable a locked or disabled account (`--unlock`).
- Ends all of that user's active sessions and writes an audit-log entry (`actor = cli`).
- Runs as root or as the `genqr` user, so access to the server itself is the authorization.

### 7.4 Update procedure
`scripts/update.sh` (Linux) and `scripts/update.ps1` (Windows) run these steps:
1. Check for a clean working tree, since local config is all git-ignored.
2. **Back up** the DB (SQLite file copy, or a dump for other engines when the dump tool is present) and `config/`.
3. `git fetch` + `git pull --ff-only`.
4. `npm ci` (server and client), plus reinstalling the active DB driver into `drivers/`.
5. `npm run build` for the client.
6. `npm run migrate` to apply new DB migrations.
7. Restart the service (`systemctl restart genqr`).
8. Health check on `/api/health`. On failure, roll back to the previous commit, restore the backup and restart.

### 7.5 "Update now" button (Admin → System)
- Shows the current version and commit, and checks GitHub for newer commits along with their commit messages.
- **Update now** does **not** run git inside the web process. The web app writes a trigger file (`data/update.request`). A systemd **path unit** (`genqr-update.path`) watches that file and starts `genqr-update.service`, which runs `update.sh` as a separate, privileged one-shot job. So the web process needs no sudo rights, and the update survives the restart of the app it is updating.
- On Windows, a Scheduled Task watches the trigger file the same way.
- The UI streams `logs/update.log` and waits on `/api/health`. When the app comes back on the new version, the page reloads. If the update fails and rolls back, the UI shows the log.
- Only admins can trigger it, and every trigger is written to the audit log.

## 8. Data Model (initial)

```
users            id, username (unique), display_name, email, source(local|ad), role(admin|user),
                 password_hash (local only), must_change_password, is_active,
                 last_login_at, created_at
settings         key, value_json, is_secret, updated_by, updated_at
logos            id, name, file_path, mime, uploaded_by, created_at
style_presets    id, name, style_json, is_default, created_by
qr_codes         id, owner_id, content_type, content_text, style_json, logo_id,
                 short_link_id, title, created_at, updated_at, deleted_at
short_links      id, code (unique), target_url, owner_id, is_active, expires_at,
                 created_at, updated_at
short_link_history id, short_link_id, old_url, new_url, changed_by, changed_at
clicks           id, short_link_id, ts, ip_hash, country, referrer, ua_browser, ua_os,
                 device_type, source, is_bot
clicks_daily     short_link_id, day, total, unique_count, by_source_json
email_log        id, qr_code_id, sent_by, recipients, formats, status, error, sent_at
audit_log        id, actor_id, action, entity_type, entity_id, details_json, ip, ts
sessions         sid, user_id, data, expires_at
password_resets  token_hash, user_id, expires_at, used_at
```

Uploaded logos live on disk in the git-ignored `data/uploads/`. Only their metadata goes in the DB, which keeps DB switching simple.

## 9. API Outline

```
POST /api/setup
POST /api/auth/login | /logout | /forgot | /reset | /change-password
GET  /api/me
GET  /api/health

/api/qr                CRUD, /api/qr/preview, /api/qr/:id/export?format=, /api/qr/:id/email
/api/links/:id         GET/PATCH, /stats, /clicks.csv

/api/admin/users       list, create-local, ldap-search, ldap-import, patch, reset-password
/api/admin/settings    ad, smtp (+test), email toggle, branding, public base URL, retention
/api/admin/database    status, install-driver, test, switch (job + progress)
/api/admin/logos, /presets, /audit, /stats, /system

GET  /short/:code      public redirect + click logging
```

## 10. UI Screens
Setup wizard · Login · Create QR · My QR codes · QR/link analytics · Admin: Users · Admin: Settings (AD, Email, Database, Branding, Short links, Retention) · Admin: Dashboard · Admin: Audit log · Admin: System

## 11. Security
- HTTPS behind a reverse proxy (Nginx on Linux, IIS on Windows); `Secure`/`HttpOnly`/`SameSite` cookies; CSRF protection
- `helmet` security headers, zod input validation, logo upload checks (SVG sanitized)
- Rate limits on login, `/short/*` and email
- Encrypted secrets (AD bind password, SMTP password, DB password)
- `.env`, `config/`, `data/` and `drivers/` are git-ignored, so secrets never reach the repo

## 12. Repository Layout

```
GenQR/
  server/        src/{routes,services,db,auth,qr,export,mail,analytics}, migrations/
  client/        src/{pages,components,api,hooks}
  shared/        types & zod schemas
  scripts/       install.sh/.ps1, update.sh/.ps1, genqrctl (+ .ps1), backup
  server/src/cli/  reset-password, setup-token, db-switch, version (called by genqrctl)
  deploy/        genqr.service, genqr-update.service, genqr-update.path, nginx.conf.example
  config/        database.example.json         (database.json is git-ignored)
  drivers.manifest.json
  .env.example   README.md   PLAN.md
```

## 13. Delivery Phases

| Phase | Scope |
|---|---|
| **1. Foundation** | Git repo, scaffold, Knex + SQLite + migrations, setup wizard, local login, sessions, roles, audit log, **one-line installer, `genqrctl`, CLI password reset, update script + "Update now" button**, systemd units |
| **2. Users & AD** | Local user management, AD config and test, AD login, LDAP search/import |
| **3. QR core** | Designer (colors, logo, presets), save/history, PNG/JPG/SVG/PDF/DOCX export, print |
| **4. Short links** | `/short/:code` redirector, management, history, safety checks |
| **5. Email** | SMTP config (Gmail preset) and test, toggle, send QR, password-reset emails |
| **6. Analytics** | Click logging, dashboards, CSV, retention |
| **7. Multi-DB** | Driver installer, switch wizard with data copy, CLI, CI tests on MySQL/PG/MSSQL |
| **8. Hardening** | Security review, backups, docs, E2E tests |

**Phase 1 status:** done for Linux. The Windows equivalents (`install.ps1`, `update.ps1`, `genqrctl.ps1`, plus a Windows Service and a Scheduled Task as the update trigger) move to Phase 8, since Linux is the primary target. On Windows the app already runs with `npm start`, and the CLI works via `npm run cli -- <command>`.

**Phase 2 status:** done. Local users, AD settings (with a test button and failover across several domain controllers), LDAP search/import, and AD sign-in (also accepting `DOMAIN\user` and `user@domain`) all work. Name and email are refreshed from AD at each sign-in. Still to do: the optional nightly job that disables users removed from AD. Ownership reassignment on delete arrives with QR codes in Phase 3.

**Phase 3 status:** done. The designer offers colours, gradients, pattern and corner shapes, logos (a shared company library plus personal uploads; SVG uploads are rasterised to PNG), brand presets with a default, and a live preview with a **scan check** (the server decodes its own render). Codes are saved with history and search, can be downloaded as PNG/JPG/SVG/PDF/DOCX (PDF/DOCX at an exact printed size in cm) and printed at a chosen size. Deleting a user transfers their codes to another user. Note: until Phase 4, URL codes encode the target URL directly; Phase 4 switches new and existing URL codes to `/short/<code>` links.

**Phase 4 status:** done.
- **Short links:** every URL code gets a `/short/<code>` link (random 7 characters or a custom name), and the QR code encodes `…/short/<code>?s=qr`. Codes from Phase 3 were migrated automatically.
- **Editing:** the destination can be changed from the designer or the Short links page without changing the printed symbol. A saved code's type is locked.
- **Redirects:** 302 with `Cache-Control: no-store`. Unknown, switched-off and expired links show a branded page (404/410).
- **Link controls:** on/off switch, optional expiry, and a per-link change history.
- **Safety:** only http/https targets; no embedded credentials; no loops back to `/short/`; an admin allowlist or blocklist of domains (subdomains included); redirects are rate-limited.
- **Deleting** a QR code switches its link off.

**Phase 5 status:** done.
- **SMTP settings:** presets for Gmail (app password), Microsoft 365 and internal relays; STARTTLS/TLS/none; password encrypted; friendly error messages; a "send test" button that works with unsaved values.
- **Global switch:** turning email off hides every email button and makes the API refuse.
- **Sending QR codes:** to up to 10 recipients plus Cc, with a message, the code shown inline, the short link, and attachments in any mix of PNG/JPG/SVG/PDF/Word. Replies go to the sender. Limited to 30 per user per hour.
- **Email log:** every message (QR, password reset, test) with its result, shown in Settings → Email.
- **Self-service password reset** for local accounts: a one-hour single-use link. The response doesn't reveal whether an account exists (sending happens in the background), requests are rate-limited, and a reset signs the user out everywhere.

Phase 7 comes late on purpose. Because Knex is used from day one and the tests run on all engines, the code is portable from the start. Only the switch wizard itself waits.

## 14. Remaining Open Questions

1. **GitHub repository URL, and public or private?** The installer currently defaults to `https://github.com/revul93/GenQR` (taken from the local git identity). Please confirm or correct it. A public repo makes the one-line installer work as written. A private repo needs a deploy key or a read-only token on each server, and the installer would take it as a parameter.
2. Defaults I'll use unless you say otherwise:
   - non-URL text gives a static QR code
   - IPs stored hashed only; GeoIP country lookup off by default
   - English UI only
   - a saved QR's design and the short link target can both be edited later (the printed code keeps working since it points to the short link)
