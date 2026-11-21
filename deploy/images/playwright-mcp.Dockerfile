# Managed Playwright MCP for Explore UI / connector Test connection.
# Base image already includes Chromium under PLAYWRIGHT_BROWSERS_PATH; it does not
# ship Google Chrome at /opt/google/chrome/chrome. @playwright/mcp defaults to the
# chrome channel, so we pin MCP, bake Chromium for its Playwright revision, and
# always launch with --browser chromium.
FROM mcr.microsoft.com/playwright:v1.55.0-noble

WORKDIR /opt/playwright-mcp
ENV PLAYWRIGHT_BROWSERS_PATH=/ms-playwright \
    npm_config_update_notifier=false

# Pin MCP (1.55-aligned). Install at build time so start does not run npx @latest.
# Re-install Chromium for this package's Playwright revision into /ms-playwright.
#
# QA-42: @playwright/mcp@0.0.35 Streamable HTTP enables runHeartbeat=true. The server
# pings the client every 3s and closes the whole MCP session (and browser) after a 5s
# ping timeout. Streamable HTTP has no standing channel for those pings between POSTs,
# so Explore UI open→navigate→settle→evaluate can hit a dead/blank session. SSE transport
# already passes false; pin Streamable HTTP to the same (no heartbeat teardown).
RUN npm init -y \
 && npm install --omit=dev @playwright/mcp@0.0.35 \
 && npx playwright install chromium \
 && node -e "const fs=require('fs'); const p='node_modules/@playwright/mcp/lib/mcp/http.js'; let s=fs.readFileSync(p,'utf8'); const from='await mcpServer.connect(serverBackendFactory, transport, true);'; const to='await mcpServer.connect(serverBackendFactory, transport, false);'; if(!s.includes(from)) { console.error('QA-42 heartbeat patch: expected connect(..., true) not found in', p); process.exit(1); } fs.writeFileSync(p, s.replace(from, to)); console.log('QA-42: disabled Streamable HTTP MCP heartbeat');" \
 && rm -rf /root/.npm /tmp/*

ENV PLAYWRIGHT_MCP_BROWSER=chromium \
    HOME=/tmp \
    NODE_ENV=production

USER pwuser
EXPOSE 8931
# Flags must match @playwright/mcp@0.0.35 (no --allowed-hosts — that option is newer and exits 1).
# QA-43: --isolated keeps each MCP session's Chromium profile in memory so concurrent /
# leftover Explore sessions do not collide on /ms-playwright/mcp-chromium ("Browser is
# already in use"). Persistent MFA still uses savedSessionName / storage-state when set.
ENTRYPOINT ["node", "/opt/playwright-mcp/node_modules/@playwright/mcp/cli.js", \
  "--browser", "chromium", \
  "--headless", \
  "--isolated", \
  "--port", "8931", \
  "--host", "0.0.0.0"]
