# Same Playwright base as the local browser MCP service so work-item runs can take real screenshots.
FROM mcr.microsoft.com/playwright:v1.55.0-noble
WORKDIR /app
COPY apps/runner/package.json /app/package.json
RUN npm install --omit=dev
COPY apps/runner/main.mjs apps/runner/check.mjs apps/runner/execute.mjs /app/
ENV HOME=/tmp NODE_ENV=production PLAYWRIGHT_BROWSERS_PATH=/ms-playwright
USER 1000:1000
ENTRYPOINT ["node", "/app/main.mjs"]
