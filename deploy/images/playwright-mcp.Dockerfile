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
RUN npm init -y \
 && npm install --omit=dev @playwright/mcp@0.0.35 \
 && npx playwright install chromium \
 && rm -rf /root/.npm /tmp/*

ENV PLAYWRIGHT_MCP_BROWSER=chromium \
    HOME=/tmp \
    NODE_ENV=production

USER pwuser
EXPOSE 8931
# Flags must match @playwright/mcp@0.0.35 (no --allowed-hosts — that option is newer and exits 1).
ENTRYPOINT ["node", "/opt/playwright-mcp/node_modules/@playwright/mcp/cli.js", \
  "--browser", "chromium", \
  "--headless", \
  "--port", "8931", \
  "--host", "0.0.0.0"]
