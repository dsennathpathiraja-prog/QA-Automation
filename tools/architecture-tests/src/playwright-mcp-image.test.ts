import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const root = resolve(__dirname, '../../..');

function read(rel: string): string {
  return readFileSync(resolve(root, rel), 'utf8');
}

describe('playwright-mcp image uses baked Chromium (not missing Google Chrome)', () => {
  it('Dockerfile pins MCP, installs Chromium at build time, and launches with --browser chromium', () => {
    const dockerfile = read('deploy/images/playwright-mcp.Dockerfile');
    expect(dockerfile).toMatch(/FROM mcr\.microsoft\.com\/playwright:v1\.55\.0-noble/);
    expect(dockerfile).toMatch(/@playwright\/mcp@0\.0\.35/);
    expect(dockerfile).toMatch(/npx playwright install chromium/);
    expect(dockerfile).toMatch(/--browser", "chromium"/);
    expect(dockerfile).toMatch(/PLAYWRIGHT_MCP_BROWSER=chromium/);
    expect(dockerfile).not.toMatch(/npx --yes @playwright\/mcp@latest/);
    expect(dockerfile).not.toMatch(/playwright install chrome(?:\s|$)/);
  });

  it('host and local Compose browser profiles build that image (no chrome-channel npx command)', () => {
    for (const file of ['deploy/compose/docker-compose.yml', 'deploy/compose/local/docker-compose.local.yml']) {
      const compose = read(file);
      expect(compose, file).toMatch(/playwright-mcp:/);
      expect(compose, file).toMatch(/dockerfile: deploy\/images\/playwright-mcp\.Dockerfile/);
      expect(compose, file).toMatch(/qa-playwright-mcp:local/);
      expect(compose, file).not.toMatch(/npx --yes @playwright\/mcp@latest/);
      expect(compose, file).not.toMatch(/image: mcr\.microsoft\.com\/playwright:v1\.55\.0-noble\n\s+command:.*@playwright\/mcp/);
    }
  });
});
