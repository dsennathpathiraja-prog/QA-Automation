FROM node:22-slim
WORKDIR /app
COPY apps/runner/check.mjs /app/check.mjs
ENV HOME=/tmp NODE_ENV=production
USER 1000:1000
ENTRYPOINT ["node", "/app/check.mjs"]
