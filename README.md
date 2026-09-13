# Twiq

Twiq is a small, self-hosted social network. It is an original product whose
desktop interface is a careful reconstruction of the *shape* of a 2014-era web
application: a 46px fixed top bar, a 290px left rail beside a 590px content
column, 1px hairline borders, compact controls, reverse-chronological
timelines, and 300-character posts called **Tweets**.

Nothing in this repository is taken from any other service. The name, the
logo, the icon set, the stylesheet, the templates, the server, the schema and
the seed data are all original to Twiq. What is reproduced is the *layout
convention* of that era, not anyone's code or assets.

> **On legal risk.** Reimplementing a well-known interface layout carries some
> inherent risk, and nothing here eliminates it. This project deliberately
> avoids third-party names, marks, logos, icons, fonts, stylesheets, markup,
> APIs and scraped data. If you deploy Twiq publicly, review your own position.

---

## 1. Requirements

| Requirement | Version | Notes |
| --- | --- | --- |
| Node.js | 20.11 LTS or newer (22 LTS recommended) | only for local development |
| PostgreSQL | 14 or newer (16 recommended) | `citext` and `pg_trgm` extensions |
| Docker Engine + Compose v2 | any current release | the supported deployment path |
| Caddy | 2.x, **installed on the host** | not a Compose service - see §9 |

Build tooling (`python3`, a C compiler) is only needed if `argon2` has no
prebuilt binary for your platform; the Dockerfile installs it in a build stage
that is discarded.

## 2. Environment configuration

Copy the example file and edit it:

```bash
cp .env.example .env
```

Generate a real session secret:

```bash
node -e "console.log(require('crypto').randomBytes(48).toString('hex'))"
```

| Variable | Purpose |
| --- | --- |
| `NODE_ENV` | `production` in deployment, `development` locally |
| `PORT` / `HOST` | where the Node server listens (`40437` / `0.0.0.0` in Docker) |
| `BASE_URL` | public origin, used for canonical URLs, Open Graph tags and email links |
| `DATABASE_URL` | PostgreSQL connection string |
| `DATABASE_POOL_MAX` | connection pool ceiling (default 10) |
| `SESSION_SECRET` | **required in production**, at least 32 characters |
| `SESSION_TTL_HOURS` | how long "Remember me" sessions last (default 720 = 30 days) |
| `SECURE_COOKIES` | `true` behind HTTPS; set `false` only for plain-HTTP local work |
| `TRUST_PROXY` | `1` behind Caddy, `false` when Node is exposed directly |
| `UPLOAD_DIR` | absolute path for stored media |
| `MAX_UPLOAD_SIZE` | bytes per upload (default 15 MB) |
| `STORAGE_DRIVER` | `local` today; the service is written so S3 can be added |
| `LOG_LEVEL` | `fatal`…`trace` (default `info`) |
| `ENABLE_WEBSOCKETS` | live badge updates; the site works with this off |
| `ENABLE_REGISTRATION` | close sign-ups without taking the site down |
| `RATE_LIMIT_*` | per-window ceilings for login, registration, Tweets, DMs, uploads |
| `ADMIN_USERNAME` / `ADMIN_EMAIL` / `ADMIN_PASSWORD` | the account `npm run seed` promotes to `admin` |

Never commit `.env`. It is in `.gitignore`.

## 3. Docker setup

```bash
cp .env.example .env
$EDITOR .env                      # set SESSION_SECRET, ADMIN_PASSWORD, BASE_URL
docker compose up -d --build
docker compose ps
curl -fsS http://127.0.0.1:40437/healthz
```

Compose starts exactly two services:

* **`postgres`** — PostgreSQL 16, data in the `postgres-data` volume, not
  published to the host at all.
* **`twiq`** — the application, published on **`127.0.0.1:40437`** only, so
  nothing but the host itself (i.e. Caddy) can reach it.

There is deliberately **no Caddy container** and no `caddy` image is pulled.
TLS is the host's job.

The container runs migrations on start (`RUN_MIGRATIONS=true`). Set
`RUN_SEED=true` once if you also want the development community inserted.

Useful commands:

```bash
docker compose logs -f twiq          # follow application logs
docker compose exec twiq node src/db/migrate.js status
docker compose restart twiq
docker compose down                  # stop (volumes survive)
```

## 4. Database setup

Inside Compose the database is created by the `postgres` image from
`POSTGRES_USER` / `POSTGRES_PASSWORD` / `POSTGRES_DB`. To create one by hand:

```sql
CREATE ROLE twiq LOGIN PASSWORD 'a good password';
CREATE DATABASE twiq OWNER twiq;
```

The first migration enables `citext` (case-insensitive usernames and e-mail)
and `pg_trgm` (fuzzy people search), so the role needs to be able to create
extensions, or a superuser should create them first.

## 5. Migrations

Forward-only SQL files in `migrations/`, applied in filename order, each in
its own transaction, recorded with a checksum in `schema_migrations`.

```bash
npm run migrate          # apply everything pending
npm run migrate:status   # list applied / pending
```

To add one, create `migrations/003_your_change.sql`. Never edit a migration
that has already been applied — the runner will warn you that it changed.

## 6. Seeds

```bash
npm run seed         # idempotent: adds anything missing
npm run seed:reset   # TRUNCATEs every table first, then seeds
```

This creates a fictional community — `@twiq`, `@alice`, `@bob`, `@charlie`,
`@diana` (protected), `@devuser`, `@newsbot`, `@marcus`, `@priya` — with
follows, replies, retweets, favorites, a pinned Tweet, Best Tweets, photo
Tweets, two Lists, Direct Messages and curated regional trends. The password
for every seeded account is `twiqtwiq` (override with `SEED_PASSWORD`).
Avatars, headers and photos are generated PNGs, not downloaded assets.

`npm run seed:reset` is destructive. Never run it against production.

## 7. Local development

```bash
npm install
cp .env.example .env       # point DATABASE_URL at your local postgres
npm run migrate
npm run seed
npm run dev                # node --watch
```

Then open <http://localhost:40437> and sign in as `alice` / `twiqtwiq`.

Run the tests (they create and migrate a separate `<database>_test`, so your
development data is untouched):

```bash
npm test
```

Layout of the source:

```
src/
  app.js            Express wiring: helmet, sessions, CSRF, routes, errors
  server.js         HTTP server, WebSocket attach, graceful shutdown
  config/           env parsing, pino logger, pg pool
  controllers/      one module per area of the site
  middleware/       auth, csrf, locals, rate limits, uploads, validation
  models/           SQL; the only place that talks to the database
  routes/           route tables; `/:username` is mounted last
  services/         entity parsing, trends, suggestions, storage, presenters
  validators/       zod schemas for every form and API body
views/              EJS templates and partials
public/css/twiq.css the entire interface, one stylesheet, no framework
public/js/twiq.js   progressive enhancement only
```

## 8. Production deployment

```bash
git clone <your-fork> /srv/twiq && cd /srv/twiq
cp .env.example .env && $EDITOR .env
docker compose up -d --build
```

Checklist:

* `NODE_ENV=production`
* `BASE_URL=https://your.domain`
* `SECURE_COOKIES=true`
* `TRUST_PROXY=1`
* a long random `SESSION_SECRET`
* a real `ADMIN_PASSWORD`, changed again after first sign-in
* `docker compose exec twiq node seeds/seed.js` if you want the admin account
  created (it creates only the administrator when other data already exists)

The application never terminates TLS itself, and it honours
`X-Forwarded-Proto` / `X-Forwarded-For` so redirects, secure cookies, client
IPs and rate-limit keys are correct behind the proxy.

## 9. Caddy configuration (on the host)

Caddy is installed on the host, **not** in Compose. `Caddyfile.example` is a
complete working file; the minimum is:

```caddyfile
twiq.example.com {
	reverse_proxy 127.0.0.1:40437
}
```

```bash
sudo cp Caddyfile.example /etc/caddy/Caddyfile
sudo $EDITOR /etc/caddy/Caddyfile          # set your hostname
sudo caddy validate --config /etc/caddy/Caddyfile
sudo systemctl reload caddy
```

Caddy obtains the certificate, sets the `X-Forwarded-*` headers Twiq expects,
and proxies the `/ws` WebSocket upgrade without extra configuration. If you
raise `MAX_UPLOAD_SIZE`, raise Caddy's `request_body max_size` to match.

## 10. Backups

Dump the database (run from the host):

```bash
docker compose exec -T postgres pg_dump -U twiq -d twiq --clean --if-exists \
  | gzip > twiq-$(date +%F).sql.gz
```

Restore into an empty database:

```bash
gunzip -c twiq-2014-11-05.sql.gz | docker compose exec -T postgres psql -U twiq -d twiq
```

Uploaded media lives in the `uploads` volume and is **not** in the dump. Back
it up too:

```bash
docker run --rm -v twiq_uploads:/data -v "$PWD":/backup alpine \
  tar czf /backup/twiq-uploads-$(date +%F).tar.gz -C /data .
```

A volume-level snapshot of `postgres-data` is only safe while the container is
stopped; `pg_dump` is safe at any time and is the recommended route. Nothing
in Twiq deletes or rotates backups for you.

## 11. Updating

```bash
cd /srv/twiq
docker compose exec -T postgres pg_dump -U twiq -d twiq | gzip > pre-update.sql.gz
git pull
docker compose up -d --build        # migrations run automatically on start
docker compose logs -f twiq
```

Migrations are forward-only. To roll back, restore the dump you just took and
check out the previous revision.

## 12. Troubleshooting

| Symptom | Cause and fix |
| --- | --- |
| `SESSION_SECRET must be at least 32 characters` | Set a real secret in `.env`. |
| Container restarts in a loop | `docker compose logs twiq`. Usually the database is not reachable — the app exits on purpose rather than serving 500s. |
| `role "twiq" does not exist` | `DATABASE_URL` points at the wrong server. Inside Compose the host is `postgres`, not `localhost`. |
| `permission denied to create extension "citext"` | Create `citext` and `pg_trgm` as a superuser first, then re-run migrations. |
| Signed out on every request | `SECURE_COOKIES=true` while browsing over plain HTTP. Either use HTTPS, or set it to `false` for local work. |
| Everything renders but forms return 403 | A stale page. The CSRF token lives in the session; reload and resubmit. Behind a proxy, check `TRUST_PROXY`. |
| Rate limits trigger for everybody at once | `TRUST_PROXY` is unset, so every request looks like it comes from the proxy. Set `TRUST_PROXY=1`. |
| Uploads fail with 413 | `MAX_UPLOAD_SIZE` and Caddy's `request_body max_size` disagree. |
| Images 404 after a redeploy | The `uploads` volume was removed. Restore it from a backup. |
| WebSocket errors in the console | Harmless: live badge updates are optional and everything falls back to polling and normal page loads. Set `ENABLE_WEBSOCKETS=false` to silence it. |
| `npm test` hangs | The suite must run serially (`--test-concurrency=1`, already set in `package.json`) because the tests truncate a shared database. |

---

## What is implemented

Authentication (registration, sign-in, sign-out, password change, password
reset, e-mail verification) · the reverse-chronological home timeline with
cursor pagination · Tweets, replies, retweets, favorites, deletion, pinned
Tweets and deterministically enlarged "Best Tweets" · the 2014 profile
(header image, overlapping avatar, statistics bar, Tweets / Tweets & replies /
Photos & videos) · follows, follow requests for protected accounts, blocks and
mutes · Who to follow · Trends with a transparent score · Discover · Connect ·
Direct Messages with the mutual-follow default · search over Tweets, people
and hashtags · Lists, public and private · media uploads with content
sniffing · settings including profile design · reporting · a role-based admin
panel with an audit log · a small JSON API · and historically styled 400, 403,
404, 429 and 500 pages.

## Licence

MIT — see [LICENSE](LICENSE).
