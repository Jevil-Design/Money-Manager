# Money Manager — backup & sync server

Stores your Money Manager data on a server you control: full snapshots for
point-in-time restore, plus the same data written into normalised tables so
other tools can query balances and transactions directly.

## Run it

```bash
cd server
npm install
npm run register -- you@example.com "Your Name"   # prints an API token, once
npm start                                         # http://localhost:4000
```

Then in the app: **Settings → Cloud backup & sync** → paste the server URL and
token → **Test connection** → **Push backup**.

### Environment

| Variable | Default | Purpose |
|---|---|---|
| `PORT` | `4000` | HTTP port |
| `DB_FILE` | `./data/money-manager.db` | SQLite file — put this on your mounted storage volume |
| `FILES_DIR` | `./data/attachments` | Receipt/invoice files |
| `CORS_ORIGIN` | `*` | Lock this to the origin serving the app |
| `KEEP_SNAPSHOTS` | `40` | Older snapshots are pruned after each push |
| `MAX_BODY` | `64mb` | Upload ceiling |
| `GOOGLE_CLIENT_ID` | — | Required only for Google sign-in |
| `ALLOWED_EMAILS` | — | Comma-separated allowlist for Google sign-in |

Put it behind HTTPS (nginx/Caddy) before using it over the internet — the token
is a bearer credential.

## Endpoints

All routes except `/health` need `Authorization: Bearer <token>`.

| Method | Path | Does |
|---|---|---|
| GET | `/api/v1/health` | liveness, no auth |
| POST | `/api/v1/auth/google` | `{accessToken}` from Google → this server's API token, no auth (see GOOGLE-SETUP.md) |
| GET | `/api/v1/me` | account info, record counts, last snapshot |
| POST | `/api/v1/backup` | `{label, device, payload}` → stores a snapshot **and** rewrites the normalised tables |
| GET | `/api/v1/backup/latest` | newest snapshot with its payload |
| GET | `/api/v1/backup/:id` | one snapshot by id |
| GET | `/api/v1/snapshots` | snapshot list (id, label, device, size, count, date) |
| DELETE | `/api/v1/snapshots/:id` | remove a snapshot |
| GET | `/api/v1/transactions?from&to&limit&offset` | paged transactions from the normalised tables |
| GET | `/api/v1/balances` | per-account balance and net worth, computed from `transaction_line` |
| GET | `/api/v1/sync-log` | last 100 push/pull events |
| POST | `/api/v1/attachments` | `{txnId, fileName, mimeType, dataUrl}` → writes the file to `FILES_DIR` |
| GET | `/api/v1/attachments/:id` | download a stored file |

## Google sync

Two routes, one OAuth client ID — **server/GOOGLE-SETUP.md** walks through both:
back up straight into a visible "Money Manager" folder in your Drive (no
hosting), or sign in with Google against this server and keep the data in your
own database. Both can be on at once; the destination toggle is per push.

## Data model

`schema.sql` holds the whole thing: `user`, `currency`, `settings`, `account`,
`category`, `subcategory`, `txn`, `transaction_line`, `tag`, `transaction_tag`,
`budget`, `recurring_transaction`, `credit_card`, `loan`, `savings_goal`,
`attachment`, `snapshot`, `sync_log`. Every record carries `created_at` /
`updated_at`.

Balances come from one place only: `transaction_line`, which holds signed
per-account movements. An expense is one negative line, income one positive
line, and a transfer is two lines that sum to zero — so transfers can never
inflate income or expense totals, on the server or in the app.

Each push is written in a single SQL transaction: if anything fails, the
previous state is untouched and the client is told the backup did not save.

## Moving to Postgres

Swap `better-sqlite3` for `pg`, apply `schema.sql` with the substitutions noted
at the top of that file, and replace the `db.prepare(...).run/get/all` calls
with `pool.query`. The endpoint contract and the client need no changes.
