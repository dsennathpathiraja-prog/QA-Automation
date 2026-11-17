# Local trial on your own machine

For trying the platform on one computer with Docker Desktop (Windows, macOS) or Docker Engine (Linux).
It is **not** for shared or production use: plain HTTP, fixed throw-away passwords, no OpenBao, no egress proxy.
Use `../docker-compose.yml` for a real host.

## Run it

Open a terminal in the repository folder (the one that contains `deploy`), then:

```
docker compose -f deploy/compose/local/docker-compose.local.yml up --build
```

The first run builds three images and downloads Postgres and Keycloak, so it takes several minutes.
When the log settles, open **http://localhost:8080** and sign in with one of these trial users
(password `Trial-Pass-1` for all):

| User | Group | Role |
|------|-------|------|
| `trial-admin` | QA-Platform-Admins | Administrator |
| `trial-lead` | QA-Platform-Leads | QA Lead |
| `trial-engineer` | QA-Platform-Engineers | QA Engineer |
| `trial-user` | QA-Platform-Users | Business User |

Keycloak's admin console is at http://localhost:8080/auth (user `admin`, password `admin`).

## What to check

1. Signing in as each user shows a different menu (Administrators see Identity mapping and AI Models, Business Users do not).
2. Sign out, then sign in again.
3. `docker compose -f deploy/compose/local/docker-compose.local.yml ps` shows `api` as healthy and `worker` running.
4. To see local models on the AI Models page, run Ollama on your machine and uncomment `OLLAMA_URL` in `docker-compose.local.yml`.

## Stop or reset

```
docker compose -f deploy/compose/local/docker-compose.local.yml down        # stop, keep data
docker compose -f deploy/compose/local/docker-compose.local.yml down -v     # stop and delete the database
```

## If something fails

Send the output of `docker compose -f deploy/compose/local/docker-compose.local.yml ps` and
`docker compose -f deploy/compose/local/docker-compose.local.yml logs api keycloak web` (secrets are not printed).
