# GenQR administrator guide

This guide covers installing, configuring, operating and securing GenQR. For what GenQR does and how it is built, see [PLAN.md](../PLAN.md).

- [1. Installing](#1-installing)
- [2. HTTPS and the public address](#2-https-and-the-public-address)
- [3. First launch](#3-first-launch)
- [4. Users and Active Directory](#4-users-and-active-directory)
- [5. Email](#5-email)
- [6. Short links and allowed destinations](#6-short-links-and-allowed-destinations)
- [7. Analytics, retention and countries](#7-analytics-retention-and-countries)
- [8. Databases](#8-databases)
- [9. Backups and restore](#9-backups-and-restore)
- [10. Updates](#10-updates)
- [11. Command reference](#11-command-reference)
- [12. Security model](#12-security-model)
- [13. Troubleshooting](#13-troubleshooting)
- [14. Uninstalling](#14-uninstalling)

---

## 1. Installing

### Linux (Debian/Ubuntu, RHEL/Rocky/Alma/Fedora)

```bash
curl -fsSL https://raw.githubusercontent.com/revul93/GenQR/main/scripts/install.sh | sudo bash
```

You can change the defaults with environment variables placed after `sudo`, e.g. `| sudo GENQR_PORT=8080 bash`:

| Variable | Default | Meaning |
|---|---|---|
| `GENQR_DIR` | `/opt/genqr` | Install folder |
| `GENQR_PORT` | `3000` | HTTP port |
| `GENQR_HOST` | `0.0.0.0` | Listen address; use `127.0.0.1` once a reverse proxy is in place |
| `GENQR_USER` | `genqr` | Service account |
| `GENQR_BRANCH` | `main` | Git branch to follow |
| `GENQR_REPO` | GitHub repo | Git URL |

The installer:
- installs git, curl, sudo, build tools and Node.js 22 if they are missing
- creates the service account and clones the code
- builds the app and writes `.env` with a random encryption key
- creates the database
- installs the `genqr`, `genqr-update.path` and `genqr-update.service` systemd units, a sudoers rule and the `genqrctl` command

When it finishes, it prints the URL and a **setup token**.

### Windows (Server 2019+ / Windows 10+)

From an **elevated** PowerShell:

```powershell
irm https://raw.githubusercontent.com/revul93/GenQR/main/scripts/install.ps1 | iex
```

Settings work the same way, as environment variables: `$env:GENQR_DIR`, `$env:GENQR_PORT`, `$env:GENQR_HOST`, `$env:GENQR_BRANCH`, `$env:GENQR_REPO`. The default folder is `C:\GenQR`.

The installer:
- uses winget to install Node.js 22 LTS, Git and NSSM if they are missing
- clones and builds the code
- creates the **GenQR** Windows service, running as `NT AUTHORITY\LocalService`
- creates the **GenQR Update Watcher** scheduled task
- puts `genqrctl` on the machine PATH (open a new prompt to use it)
- opens the port in Windows Firewall

> If winget isn't available (some Windows Server editions), install Node.js 22 LTS, Git and NSSM yourself first, then run the installer.

### Re-running the installer

Running the installer again on an installed server refreshes the system pieces (service definitions, sudoers rule, scheduled task, `genqrctl`) and then updates GenQR. Do this when an update tells you the installer has changed.

## 2. HTTPS and the public address

Run GenQR behind a reverse proxy that terminates HTTPS, then make the app listen only locally:
1. Set `HOST=127.0.0.1` in `.env`.
2. Run `genqrctl restart`.

- **nginx:** start from [`deploy/nginx.conf.example`](../deploy/nginx.conf.example).
- **IIS:** install *URL Rewrite* and *Application Request Routing*, enable the proxy in ARR, and add a reverse-proxy rule to `http://127.0.0.1:3000`. Also preserve the host header and pass `X-Forwarded-Proto`. Bind the site to your HTTPS certificate.

GenQR trusts proxy headers only from the local machine (`TRUST_PROXY=loopback` in `.env`).

**The public address** (Settings → Short links) is the host name built into every short link and QR code, e.g. `https://genqr.jeddah-cables.com`. Choose it before printing codes. If you change it later, codes printed earlier still point to the old host name, so keep that name pointing at the server.

## 3. First launch

1. Open the URL the installer printed.
2. Enter the **setup token**. If you lost it, run `genqrctl setup-token`.
3. Create the administrator account: username, password and recovery email.
4. Confirm the public address.

This first administrator is a **local** account, so it still works if Active Directory is down. Keep its password safe; `genqrctl reset-password <user>` can always reset it from the server.

## 4. Users and Active Directory

**Settings → Active Directory:**
- Enter the domain controller URLs, one per line, tried in order. Prefer `ldaps://dc.company.local:636`.
- Enter a read-only service account (bind DN and password) and the search base DN.
- **Test connection** checks everything, including an optional user lookup, without saving.
- Paste your internal CA certificate if the domain controller's certificate is not publicly trusted.

**Users:**
- **Import from AD:** search the directory and import people with the *User* or *Administrator* role. Only imported users can sign in. Their name and email are refreshed from AD at every sign-in, and they can type `DOMAIN\user` or `user@domain`.
- **Add local:** for people outside AD. You can require a password change at first sign-in.
- **Edit / Reset password / Unlock / Delete.** You can't demote, disable or delete yourself or the last active administrator. Deleting a user moves their QR codes and links to someone you choose.
- Five wrong passwords lock an account for 15 minutes. Admins can unlock it.

## 5. Email

**Settings → Email:**
- Turn sending **on** or **off**. When it is off, every email button is hidden and the API refuses to send.
- Presets are provided for **Gmail**, **Microsoft 365** and an **internal relay**.
  - **Gmail:** the username is the full address, and the password is an *app password* (Google Account → Security → 2-Step Verification → App passwords). The sender address must be that account or one of its aliases.
- **Send test email** checks the settings without saving them. If you change the server or username, you must type the password again: GenQR never sends a saved password to a different server.
- **Sent email** lists every message (QR codes, password resets, tests) and whether it was delivered.

With email on, users can email a QR code (as PNG/JPG/SVG/PDF/Word attachments) to up to 10 people. Local users can also reset a forgotten password through a one-hour link.

## 6. Short links and allowed destinations

Every QR code for a website points to `https://<public address>/short/<code>`. That lets owners change the destination, switch the link off or set an expiry later, without reprinting. Each change is kept in the link's history.

**Settings → Short links → Allowed destinations** controls where links may point:
- *Any website* (default)
- *Only the listed domains*: recommended, e.g. `jeddah-cables.com`
- *Any except the listed domains*

Subdomains are included. Links are always limited to http/https, can't contain usernames or passwords, and can't point to another short link.

## 7. Analytics, retention and countries

**What is recorded for each visit to a short link:**
- time and source (QR scan or plain link)
- referring site
- browser, operating system and device type
- optionally, the country

IP addresses are never stored: unique visitors are counted with a keyed one-way hash. Bots, link previews and quick repeat visits are left out.

**Settings → Analytics:**
- **Retention:** detailed clicks are kept for 13 months by default. Older clicks become daily totals, so long-range charts keep working.
- **Countries:** download MaxMind's free *GeoLite2 Country* database (`.mmdb`; needs a free account) and copy it to `data/GeoLite2-Country.mmdb`. Lookups happen locally.

## 8. Databases

GenQR starts on SQLite, a file in `data/` that is right for this scale. To move to **PostgreSQL** or **MySQL/MariaDB**:
1. Create an empty database and a user that can create tables in it.
2. Go to **Settings → Database**, enter the connection details, and click **Test connection**. The driver installs automatically.
3. Click **Switch**. GenQR copies all data, checks the row counts, saves the settings (password encrypted) and restarts.

If the new database can't be opened at startup, GenQR goes back to the previous one by itself. The old database is never changed, so you can always switch back.

From the command line: `genqrctl db-switch --client pg --host db --port 5432 --database genqr --user genqr`. It prompts for the password; use `--password-stdin` for automation.

SQL Server support exists in the code but is hidden until it has been tested against a real server.

## 9. Backups and restore

**What to back up:** `.env` (it holds the encryption key), `config/`, `data/` (the SQLite database, uploaded logos, GeoIP), and your server database if you moved to one.

- `genqrctl backup /path/genqr.db`: online copy of the SQLite database.
- `genqrctl backup /path/genqr.json.gz`: a portable dump that works on **any** engine.
- `genqrctl restore <file>`: replaces **all** data with the backup. It stops and restarts the service.

Every update also takes a backup first (in `backups/`, keeping the last 10).

> Keep `.env` with your backups. Without its `ENCRYPTION_KEY`, the saved AD, SMTP and database passwords can't be read.

## 10. Updates

- **From the web:** Admin → System → **Check for updates** / **Update now**.
- **From the server:** `genqrctl update`. Add `--force` (Linux) or `-Force` (Windows) to rebuild even when already up to date.

**What an update does:**
1. Backs up the configuration and database.
2. Pulls from GitHub.
3. Installs dependencies and builds.
4. Applies database migrations.
5. Restarts and waits for the new version to report healthy.

If any step fails, it **rolls back automatically**: it undoes the migrations, restores the database backup and the previous code, and restarts.

The update log is under Admin → System, or in `logs/update.log`.

## 11. Command reference

| Command | |
|---|---|
| `genqrctl status` | Service state, version, database, health |
| `genqrctl start` / `stop` / `restart` | Service control |
| `genqrctl logs [-f]` | Service log |
| `genqrctl update [--force]` | Update from GitHub (with backup and automatic rollback) |
| `genqrctl reset-password <user> [--unlock] [--must-change]` | New password for a local user |
| `genqrctl setup-token` | First-launch setup token |
| `genqrctl backup <file>` / `restore <file>` | Back up / restore (see §9) |
| `genqrctl db-status` | Engine, driver, row counts |
| `genqrctl db-switch …` | Move to another database (see §8) |
| `genqrctl install-driver` | Install the driver for the configured database |
| `genqrctl version` | Version and commit |

## 12. Security model

- **Least privilege.** The app runs as a dedicated account: `genqr` on Linux, `LocalService` on Windows.
  - **Linux:** root never runs code from the GenQR folder. The installer is self-contained; `genqrctl` is a root-owned copy; updates run as `genqr` and restart the service through a sudoers rule allowing only start/stop/restart of `genqr.service`.
  - **Windows:** the service account can only *read* the code. It can write only to `data`, `logs`, `config` and `drivers`. Updates run as SYSTEM from code the service account can't change, and admin tools load database drivers from an admin-only folder.
- **Secrets.**
  - Passwords are hashed with argon2id.
  - Stored AD, SMTP and database passwords are encrypted with AES-256-GCM, using the key in `.env`, which is readable only by the service account.
  - Sessions are random 256-bit tokens, stored hashed, in `HttpOnly`, `SameSite` cookies. Changing a password, resetting it or disabling an account signs that user out everywhere.
- **Abuse limits.**
  - Sign-in, password reset, setup, redirects, previews and email are rate-limited.
  - Accounts lock after repeated failures.
  - Cross-site requests are rejected.
  - Short-link destinations are restricted (see §6).
- **Audit log** (Admin → Audit log): records sign-ins, failed attempts, all user, settings, QR code and link changes, emails, updates and database switches.
- **Your part:** use HTTPS, set `HOST=127.0.0.1` behind the proxy, set an allowlist of destinations, keep the server patched, and protect `.env` and backups.

## 13. Troubleshooting

| Symptom | What to check |
|---|---|
| Service won't start | `genqrctl logs` (Linux: `journalctl -u genqr`; Windows: `logs\service.log`) |
| "Not reachable" from other machines | Firewall; `HOST` in `.env`; proxy configuration |
| AD sign-in fails for everyone | Settings → Active Directory → Test connection; certificate trust; service account password |
| AD user "Invalid username or password" | The user must be **imported** first; check that they are enabled in AD |
| Emails not arriving | Settings → Email → Sent email shows the server's answer; Gmail needs an app password |
| Update stuck at "requested" | Linux: `systemctl status genqr-update.path`; Windows: the *GenQR Update Watcher* task |
| Locked out as the only admin | On the server: `genqrctl reset-password <admin> --unlock` |
| Lost the setup token | `genqrctl setup-token` |
| Database switch failed | Settings → Database shows the log; nothing was changed, and the target was emptied again |

## 14. Uninstalling

**Linux:**

```bash
sudo systemctl disable --now genqr genqr-update.path
sudo rm /etc/systemd/system/genqr*.{service,path} /etc/sudoers.d/genqr /etc/genqr.conf /usr/local/bin/genqrctl
sudo systemctl daemon-reload
sudo userdel genqr    # after backing up and removing /opt/genqr
```

**Windows (elevated PowerShell):**

```powershell
Stop-Service GenQR; C:\GenQR\bin\nssm.exe remove GenQR confirm
Unregister-ScheduledTask -TaskName 'GenQR Update Watcher' -Confirm:$false
Remove-NetFirewallRule -DisplayName GenQR
# then back up and remove C:\GenQR, and remove C:\GenQR\bin from the machine PATH
```
