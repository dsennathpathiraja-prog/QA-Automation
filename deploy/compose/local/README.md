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

1. Start (or rebuild) the browser profile (worker must already be up on the same Compose project). The image bakes Chromium and a pinned `@playwright/mcp` — rebuild whenever `deploy/images/playwright-mcp.Dockerfile` changes (includes `--isolated` and `--no-sandbox` for Docker Chromium):

```
docker compose -f deploy/compose/local/docker-compose.local.yml --profile browser up --build -d playwright-mcp
```

2. Confirm the service is running and healthy: `docker compose -f deploy/compose/local/docker-compose.local.yml ps` should list `playwright-mcp`. From the worker, DNS must resolve the **service name** `playwright-mcp` (not the image tag `qa-playwright-mcp`).

3. In the UI, add **Playwright (managed)** with:
   - **Server address (from the worker container):** `http://playwright-mcp:8931` — same as worker env `PLAYWRIGHT_MCP_URL`. Do **not** use `localhost` or the image name; do not append `/mcp` (the connector adds that path).
   - **From the host machine only** (published loopback port): `http://127.0.0.1:8931` — for curl/debug; the worker cannot use this URL.
   - **Application addresses:** comma-separated origins the browser may open (for example `https://shop.example.com`).
4. If the page says `playwright-mcp` is not approved, click **Approve playwright-mcp (internal, plain http)** (Administrator).
5. Run **Test connection**. A pass shows “Connected to the managed Playwright server.”

If Explore UI / Test connection says `could not resolve playwright-mcp`, the browser container is not on network `qa-platform-local` with the worker — re-run the profile `up` above (do not start MCP with a different Compose project name).

If `docker compose … ps` shows `playwright-mcp` **Restarting** and logs say `unknown option '--allowed-hosts'`, rebuild after pulling a Dockerfile that only uses flags supported by `@playwright/mcp@0.0.35` (`--browser chromium --headless --port 8931 --host 0.0.0.0`).

### Private shop hosts (PayNSure / `*.internal`)

Desktop Chrome can open `http://sdk.paynsure.internal/shop` via the **host** resolver (`/etc/hosts` or VPN DNS). Chromium inside `playwright-mcp` does **not** inherit host `/etc/hosts`.

**Do not** map the shop to `host-gateway` by default — that often returns **HTTP 4xx/5xx** (`ERR_HTTP_RESPONSE_CODE_FAILURE`) from the Docker host instead of the shop VirtualHost. Set `PLAYWRIGHT_MCP_SHOP_IP` to the real LAN/VPN IP and apply the shop overlay (`docker-compose.playwright-shop.yml`). `extra_hosts` uses **YAML mapping** form (`host: ip`) — Compose on Windows rejects a list of `"host:ip"` strings.

```bash
# Linux/macOS — use the same A record the host browser uses
export PLAYWRIGHT_MCP_SHOP_IP=$(getent hosts sdk.paynsure.internal | awk '{print $1; exit}')
docker compose -f deploy/compose/local/docker-compose.local.yml \
  -f deploy/compose/local/docker-compose.playwright-shop.yml \
  --profile browser up -d --force-recreate playwright-mcp

bash deploy/compose/scripts/verify-playwright-shop-dns.sh   # expect HTTP 2xx
```

Windows PowerShell:

```powershell
$env:PLAYWRIGHT_MCP_SHOP_IP = (Resolve-DnsName sdk.paynsure.internal -Type A |
  Where-Object { $_.IPAddress } | Select-Object -First 1).IPAddress
docker compose -f deploy/compose/local/docker-compose.local.yml `
  -f deploy/compose/local/docker-compose.playwright-shop.yml `
  --profile browser up -d --force-recreate playwright-mcp
```

Keep `http://sdk.paynsure.internal` (or the bare host) on the Playwright connector allowlist, then retry Explore UI — the MD artifact should list storefront cues (Search products, Add to cart, Proceed to checkout, …).

### Email / notification template preview (Phase 8 E2)

Escrow/email-template stories (e.g. WI 2357) need a **reachable template preview** surface. Without one, Explore stays **fail-closed** (Blocked / `needs-surface`) — it will not invent shop catalog passes for subject/greeting/Paid Amount/CTA.

**Option A — Environment setting:** Environments → General → **Template preview URL** (must be an approved application host).

**Option B — Worker env var** `QA_TEMPLATE_PREVIEW_URL` (overrides empty environment setting).

**Option C — Local fixture host** (documented mock HTML under `deploy/compose/local/fixtures/email-preview/`):

PowerShell:

```powershell
$env:QA_TEMPLATE_PREVIEW_URL = "http://email-preview-fixture/"
docker compose -f deploy/compose/local/docker-compose.local.yml `
  -f deploy/compose/local/docker-compose.email-preview.yml `
  --profile email-preview --profile browser up -d --build
```

Bash:

```bash
export QA_TEMPLATE_PREVIEW_URL=http://email-preview-fixture/
docker compose -f deploy/compose/local/docker-compose.local.yml \
  -f deploy/compose/local/docker-compose.email-preview.yml \
  --profile email-preview --profile browser up -d --build
```

Then:

1. Approve host `email-preview-fixture` for plain http on the Playwright connector allowlist (and keep the shop host if order-trigger paths matter).
2. Set the environment Template preview URL to `http://email-preview-fixture/` (or rely on the worker env var from the overlay).
3. Re-run Requirement Validation for WI 2357-like stories — Explore should open the preview DOM; plan/generate should assert **subject / greeting / order table / Confirm Delivery / Paid Amount**, not shop catalog.

Host debug of the fixture: `http://127.0.0.1:8099/` (published loopback). Worker/Playwright must use `http://email-preview-fixture/` (Compose DNS).

Unit verify (no Compose):

```powershell
pnpm typecheck
pnpm exec vitest run packages/agents packages/testing/test/environment-service.test.ts
```

### Case quality gate before publish (Phase 8 E3)

Publish (and generate/heal) refuse **body-only** stubs (`locator("body").toBeVisible` as the only assertion). Explore-gap / `needs-surface` cases are flagged but still stored as Blocked. The plan Markdown includes an **AC coverage** section (covered vs gaps).

Optional: on Workflow **Run**, check **Pause after plan (accept before generate)** so the run pauses after Plan for human review; **Resume** on Executions continues to Generate.

```powershell
pnpm typecheck
pnpm exec vitest run packages/agents/test/case-quality-gate.test.ts apps/worker/test/publish-cases.test.ts packages/workflow-engine/test/chaos.test.ts
```

## Runner (Playwright / Executions screenshots)

`runner-image` and `runner-launcher` are part of the **default** local stack (no compose profile). A normal `up --build` builds `qa-runner:local` and starts the launcher. The worker waits until `runner-launcher` is healthy. Executions **do not** HTTP probe-fall back to a fake Passed when the launcher is missing — cases stay **Blocked** with an actionable message instead.

```
docker compose -f deploy/compose/local/docker-compose.local.yml up --build -d
```

`runner-image` exits on purpose after `qa-runner:local` exists. Rebuild whenever `apps/runner/` or `deploy/images/runner.Dockerfile` changes. `runner-launcher` starts a fresh container per check/run and is the only service that uses the Docker socket.

Reachability: open the environment and press Check reachability. Prefer a line that starts with “The runner finished.”

### Run a prepared work item (Executions)

1. Ensure the default stack is up (includes runners):

```
docker compose -f deploy/compose/local/docker-compose.local.yml up --build -d
docker compose -f deploy/compose/local/docker-compose.local.yml ps
# Expect: runner-launcher = healthy/running; runner-image = Exited (0)
docker image inspect qa-runner:local --format '{{.Id}} {{.Created}}'
```

2. Smoke Playwright capture inside the image:

```
docker run --rm --network qa-platform-local \
  -e QA_TARGET_URL=http://web \
  -e QA_ALLOWED_HOSTS=web \
  -e QA_CASES_JSON='[{"id":"smoke","name":"Smoke","steps":["Open page","Capture evidence"]}]' \
  qa-runner:local
# Expect: RUNNER_MODE {"capture":"playwright",...} then RESULT_JSON ... then SCREENSHOT_JSON ...
```

3. On Executions, prepare a work item and press **Run**. Expect per-case **Passed** / **Failed** with JPEG screenshots. Large sets (hundreds of cases) are passed as chunked `QA_CASES_P*` env vars (not one giant `QA_CASES_JSON`, and not Docker putFiles into `/tmp`). You should not see “env QA_CASES_JSON is too long” or “putFiles (400)”.

4. If cases are **Blocked** with “runner-launcher is not available”, the launcher container is not on `qa-platform-local` — re-run step 1 (Docker socket must be available to Compose).

5. If cases are **Blocked** with “runner pool is full” / “pool stayed full”, check leftovers with **`docker ps -a`** (plain `docker ps` hides `created`/`exited` orphans that used to pin the pool). One Execute uses **one** `qa-runner-*` container for the whole batch — not one per case.

**PowerShell (Windows):**

```
docker ps -a --filter "label=qa.platform/managed=true"
docker images qa-runner:local
docker ps -aq --filter "label=qa.platform/managed=true" | ForEach-Object { docker rm -f $_ }
docker compose -f deploy/compose/local/docker-compose.local.yml up --build -d
```

**Bash:**

```
docker ps -a --filter label=qa.platform/managed=true
docker images qa-runner:local
docker rm -f $(docker ps -aq --filter label=qa.platform/managed=true) 2>/dev/null || true
docker compose -f deploy/compose/local/docker-compose.local.yml up --build -d
```

Local default `RUNNER_MAX_CONCURRENT` is **8** (never treat `0` as a valid limit). The launcher reclaims finished/never-started runners before admitting a new one; the worker waits up to ~3 minutes for a free slot. If the image is missing you get a PowerShell rebuild hint (not pool-full).

6. **Cancel a live work-item run** from Executions (Cancel on the live row). The worker stops and removes that run’s `qa-runner-*` container so the pool slot frees immediately — you should not need a manual reclaim after Cancel.

7. Squash sync needs a **READ_WRITE** personal API token on the switched-on Squash connector (project name e.g. ToolKit-AgenFlow): Test Connection → Switch on → **restart the worker** after replacing the token. After a Run, the work-item detail sync line should mention execution status and, when attachments succeed, uploaded screenshots. If Squash refuses attachments, the line warns and platform screenshots still show on Executions.

Optional browser MCP (Explore UI / connector Test connection) still uses `--profile browser` — that is separate from Executions screenshots.

## Automation Mapping (Phase 8 E6 Regression seed)

After cases are published to Squash, the worker seeds a **draft** automation asset and Squash↔script mapping. Open **Automation Mapping** (QA Lead / Engineer), **Approve** a draft, then **Resolve** a Squash case id — or call `GET /api/v1/automation/resolve?squashCaseId=<id>`. For Regression prep (approved-only vs Not Automated), use **Preview Regression resolve** or `POST /api/v1/automation/resolve-regression`. Details: [`docs/phase8-e6-regression-seed.md`](../../../docs/phase8-e6-regression-seed.md), [`docs/phase9-e1-approved-resolve.md`](../../../docs/phase9-e1-approved-resolve.md).

**Regression execute (Phase 9 E2):** after approve, a Regression workflow’s `rg.execute-tests` step runs only approved assets via the Playwright runner (live progress + screenshots on Executions as `rg:<runId>`). Draft/unmapped stay Skipped / Not Automated — no explore or generate. See [`docs/phase9-e2-regression-execute.md`](../../../docs/phase9-e2-regression-execute.md).

PowerShell-safe check:

```powershell
pnpm check
docker compose -f deploy/compose/local/docker-compose.local.yml up --build -d
# Sign in as trial-lead → Automation Mapping → Approve → Resolve
# Regression run → Executions → rg:<runId> for evidence
```

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
