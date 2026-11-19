FROM node:22-slim
WORKDIR /app
COPY apps/runner/main.mjs apps/runner/check.mjs apps/runner/execute.mjs /app/
ENV HOME=/tmp NODE_ENV=production
USER 1000:1000
ENTRYPOINT ["node", "/app/main.mjs"]
