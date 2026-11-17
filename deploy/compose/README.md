# Compose deployment (initial target)

Single self-hosted Ubuntu host. See `docs/architecture/platform-decisions.md` in the design store for the design.

Status: **authored but not executed** (no Docker on the authoring host). Validate with `docker compose config`
and the Phase 1 smoke test before use.

```
cp .env.example .env            # non-secret settings only
./scripts/install.sh            # bootstrap secrets, init OpenBao (run twice: init, then configure)
docker compose up -d            # core services
docker compose --profile llm up -d ollama    # local LLM host (add -f docker-compose.gpu.yml for GPU)
```

Known gaps, tracked for Phase 1/2: TLS on the OpenBao listener (internal network only for now), `worker`,
`runner-launcher` and `playwright-mcp` services (added with the phases that need them), certificates under
`./certs`, the SPA static files, Garage cluster layout for the `s3` profile.

Air-gapped profile: set `PLATFORM_PROFILE=airgapped`, leave `squid/allowed-hosts.txt` empty (internal hosts are
reached directly on internal networks you attach explicitly), and load images from an offline bundle.
