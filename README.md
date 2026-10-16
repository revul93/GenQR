# GenQR

Branded QR code generator with editable short links and click analytics. Users sign in with local accounts or Active Directory.
Built with Node.js, React and Knex. It starts on SQLite and can move to PostgreSQL or MySQL/MariaDB from the admin settings. See [PLAN.md](PLAN.md) for the full design and roadmap.

## Install

**Linux:**

```bash
curl -fsSL https://raw.githubusercontent.com/revul93/GenQR/main/scripts/install.sh | sudo bash
```

**Windows** (elevated PowerShell):

```powershell
irm https://raw.githubusercontent.com/revul93/GenQR/main/scripts/install.ps1 | iex
```

The **[administrator guide](docs/ADMIN.md)** covers HTTPS, Active Directory, email, databases, backups, updates, security and troubleshooting.

The Linux installer:
- installs git, build tools and Node.js 22 if they are missing
- creates the `genqr` service account and clones the repo into `/opt/genqr`
- builds the app, generates `.env` and creates the database
- installs and starts the systemd services and the `genqrctl` command

When it finishes, it prints the URL and the **setup token** for the first-launch wizard.

You can override the defaults with environment variables, e.g. `| sudo GENQR_PORT=8080 GENQR_DIR=/srv/genqr bash`. The variables are listed at the top of [scripts/install.sh](scripts/install.sh).

For production, put a reverse proxy with HTTPS in front of the app; [deploy/nginx.conf.example](deploy/nginx.conf.example) is a starting point.

## Operating

| Command | |
|---|---|
| `genqrctl status` | Service state, version, database, health |
| `genqrctl start` / `stop` / `restart` | Service control |
| `genqrctl logs [-f]` | Service log |
| `genqrctl update [--force]` | Pull from GitHub, back up, build, migrate, restart (rolls back on failure) |
| `genqrctl reset-password <user> [--unlock]` | Set a new password for a local user, e.g. the admin |
| `genqrctl setup-token` | Show the first-launch setup token |
| `genqrctl backup <file>` | Back up the database (SQLite file copy, or a `.json.gz` dump for any engine) |
| `genqrctl restore <file>` | Replace all data with a backup (stops and restarts the service) |
| `genqrctl db-status` | Database engine, driver and row counts |
| `genqrctl db-switch --client pg\|mysql\|sqlite …` | Move all data to another empty database and switch to it (also in Settings → Database) |

Admins can also update from **Admin → System → Update now**. That button drops a request file, and the `genqr-update.path` systemd unit picks it up and runs the same update script.

Local files are never tracked by git: `.env`, `config/database.json`, `data/`, `logs/`, `backups/` and `drivers/`. That is why `git pull` updates never conflict with your local configuration.

## Tests

```bash
npm test
```

This runs the API and unit test suite (Vitest + Supertest) on a temporary SQLite database. To run it against PostgreSQL or MySQL, set `GENQR_TEST_DB`; see `server/test/setup.ts`. GitHub Actions runs the suite on SQLite, PostgreSQL and MariaDB for every push.

## Development

Requires Node.js 22 or later.

```bash
npm install
npm run dev
```

This starts the API on :3000 and Vite on :5173; open http://localhost:5173. On first start the setup token is printed in the server output. Other commands:

```bash
npm run build                                   # compile server + bundle client
npm start                                       # run the production build (serves the client too)
npm run cli -- reset-password admin             # CLI tools (after a build)
```

## Layout

```
server/   Express API (TypeScript): src/{routes,services,auth,db,cli}
client/   React + MUI front end (Vite)
scripts/  install.sh, update.sh, genqrctl, lib.sh
deploy/   systemd units, nginx example
config/   database.example.json
```
