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
When the log settles, open **http://localhost:8088** and sign in with one of these trial users
(password `Trial-Pass-1` for all):

| User | Group | Role |
|------|-------|------|
| `trial-admin` | QA-Platform-Admins | Administrator |
| `trial-lead` | QA-Platform-Leads | QA Lead |
| `trial-engineer` | QA-Platform-Engineers | QA Engineer |
| `trial-user` | QA-Platform-Users | Business User |

Keycloak's admin console is at http://localhost:8088/auth (user `admin`, password `admin`).

If another program already uses port 8088, pick a free one: `WEB_PORT=9000 docker compose -f ... up --build` (PowerShell: `$env:WEB_PORT=9000` first), then open that port instead.
The trial realm accepts any `http://localhost:<port>` as a sign-in return address (Keycloak only allows a wildcard at the very end of the address); this is acceptable only because the stack is for localhost.

## What to check

1. Signing in as each user shows a different menu (Administrators see Identity mapping and AI Models, Business Users do not).
2. Sign out, then sign in again.
3. `docker compose -f deploy/compose/local/docker-compose.local.yml ps` shows `api` as healthy and `worker` running.
4. To see local models on the AI Models page, run Ollama on your machine and uncomment `OLLAMA_URL` in `docker-compose.local.yml`.

## Playwright browser connector (Test connection)

The managed Playwright MCP server is **not** part of the default stack. Without it, Connectors → Playwright → **Test connection** fails with “Could not reach Playwright”.

1. Start (or rebuild) the browser profile (worker must already be up). The image bakes Chromium and a pinned `@playwright/mcp` — rebuild whenever `deploy/images/playwright-mcp.Dockerfile` changes:

```
docker compose -f deploy/compose/local/docker-compose.local.yml --profile browser up --build -d playwright-mcp
```

2. Confirm the service is running: `docker compose -f deploy/compose/local/docker-compose.local.yml ps` should list `playwright-mcp`.

3. In the UI, add **Playwright (managed)** with:
   - **Server address:** `http://playwright-mcp:8931` (Docker DNS name the **worker** uses — not `localhost`, and do not append `/mcp`; the connector adds that path).
   - **Application addresses:** comma-separated origins the browser may open (for example `https://shop.example.com`).
4. If the page says `playwright-mcp` is not approved, click **Approve playwright-mcp (internal, plain http)** (Administrator).
5. Run **Test connection**. A pass shows “Connected to the managed Playwright server.”

Optional: publish port `8931:8931` on that service only if you need to hit MCP from the host machine; the worker does not need a published port.

## Runner

The reachability button checks the address from the worker unless you also start the runner:

```
docker compose -f deploy/compose/local/docker-compose.local.yml --profile browser --profile runners up --build -d
```

`runner-image` exits on purpose after the image `qa-runner:local` exists. Rebuild that profile whenever `apps/runner/` or `deploy/images/runner.Dockerfile` changes — a stale image is a common cause of Executions showing every case **Blocked** with “without case results.” `runner-launcher` is the service that starts a new container for each check. It is the only service that uses the Docker socket. Open the environment again and press Check reachability. The line starts with "The runner finished." On 19 Nov 2026 that check showed "The runner finished. The application answered 200."

### Run a prepared work item (Executions)

1. Rebuild runners (Playwright-capable `qa-runner:local`):  
   `docker compose -f deploy/compose/local/docker-compose.local.yml --profile runners up --build -d`
2. Confirm the environment Check reachability still ends with “The runner finished.”
3. On Executions, prepare work item **7259** (or your PayNSure item) and press **Run**.
4. Expect per-case **Passed** / **Failed** (not all Blocked) with screenshots. Squash sync needs a **READ_WRITE** personal API token on the switched-on Squash connector (project name e.g. ToolKit-AgenFlow): Test Connection → Switch on → **restart the worker** after replacing the token.

## Stop or reset

```
docker compose -f deploy/compose/local/docker-compose.local.yml down        # stop, keep data
docker compose -f deploy/compose/local/docker-compose.local.yml down -v     # stop and delete the database
```

### Clear platform Test Cases only (keep the rest of the database)

After a rebuild, engineers/leads can empty the platform case library without wiping Squash:

1. **UI:** Test Cases → **Clear platform test cases** (confirms; soft-deletes collections and cases).
2. **API** (signed-in engineer/lead session cookie):

```
POST /api/v1/test-cases/reset
Content-Type: application/json

{ "confirm": "RESET_PLATFORM_CASES" }
```

3. **SQL soft-delete** (local Docker Postgres; Squash untouched):

```
docker compose -f deploy/compose/local/docker-compose.local.yml exec -T postgres \
  psql -U qa_platform -d qa_platform -c "
    DELETE FROM test_collection_case;
    UPDATE test_case SET deleted_at = now(), updated_at = now() WHERE deleted_at IS NULL;
    UPDATE test_collection SET deleted_at = now(), updated_at = now() WHERE deleted_at IS NULL;
  "
```

Hard wipe of only those tables (optional; still does not touch Squash):

```
docker compose -f deploy/compose/local/docker-compose.local.yml exec -T postgres \
  psql -U qa_platform -d qa_platform -c "
    TRUNCATE test_collection_case, test_case_version, work_item_case_result,
             work_item_execution, test_case, test_collection;
  "
```

## If something fails

Send the output of `docker compose -f deploy/compose/local/docker-compose.local.yml ps` and
`docker compose -f deploy/compose/local/docker-compose.local.yml logs api keycloak web` (secrets are not printed).
