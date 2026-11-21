# Compose deployment (initial target)

Single self-hosted Ubuntu host. See `docs/architecture/platform-decisions.md` in the design store for the design.

Status: **authored but not executed** (no Docker on the authoring host). Validate with `docker compose config`
and the Phase 1 smoke test before use.

For a quick trial on one machine, use `local/README.md` instead.

```
cp .env.example .env            # non-secret settings only
./scripts/install.sh            # bootstrap secrets, init OpenBao (run twice: init, then configure)
docker compose up -d            # core services
docker compose --profile llm up -d ollama    # local LLM host (add -f docker-compose.gpu.yml for GPU)
docker compose --profile browser up -d playwright-mcp   # managed Playwright MCP (http://playwright-mcp:8931)
```

Playwright **Test connection** needs the browser profile running and connector URL `http://playwright-mcp:8931` (approve that host for plain http). Details: `local/README.md` and `docs/playwright-agents-mcp.md`.

Identity (decision Q2a, default accepted): a new Keycloak is deployed with the stack and imported with realm
`qa-platform`; create the four IdP groups (`QA-Platform-Admins`, `-Leads`, `-Engineers`, `-Users`) and assign users, or
broker Entra ID through Keycloak and map its groups to these names. A user in several groups receives the union of roles;
a user in none cannot sign in. The client secret is generated into `secrets/oidc_client_secret` and must be set on the
Keycloak client (commands at the end of `scripts/install.sh`). Verify that your Keycloak image honours the `*_FILE`
variables used for its passwords; if not, supply them another way.

Known gaps, tracked for Phase 1/2: TLS on the OpenBao listener (internal network only for now), `worker`,
`runner-launcher` and `playwright-mcp` services (added with the phases that need them), certificates under
`./certs`, the SPA static files, Garage cluster layout for the `s3` profile.

Air-gapped profile: set `PLATFORM_PROFILE=airgapped`, leave `squid/allowed-hosts.txt` empty (internal hosts are
reached directly on internal networks you attach explicitly), and load images from an offline bundle.
