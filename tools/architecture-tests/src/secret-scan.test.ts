import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { SECRET_SCAN_ALLOWLIST, scanText } from './secret-scan';

const root = resolve(__dirname, '../../..');

describe('no plaintext credentials in the repository', () => {
  it('finds none in any tracked file (the local trial stack is the one documented exception)', () => {
    const files = execFileSync('git', ['ls-files', '-z'], { cwd: root }).toString().split('\0').filter(Boolean);
    expect(files.length).toBeGreaterThan(50);
    const findings = files
      .filter((f) => !/\.(png|jpe?g|gif|webp|ico|woff2?|zip|gz)$/.test(f))
      .flatMap((f) => scanText(f, readFileSync(resolve(root, f), 'utf8')));
    expect(findings).toEqual([]);
  });

  it('every allowlist entry says why it exists', () => {
    for (const a of SECRET_SCAN_ALLOWLIST) expect(a.reason.length).toBeGreaterThan(10);
  });

  it('detects the kinds of secret it is meant to catch', () => {
    const ghPat = 'github_pat_' + 'A1b2C3d4E5f6G7h8I9j0K1l2M3';
    const aws = 'AKIA' + 'ABCDEFGHIJKLMNOP';
    expect(scanText('src/x.ts', `const t = "${ghPat}"`)).toHaveLength(1);
    expect(scanText('src/x.ts', `key ${aws}`)).toHaveLength(1);
    expect(scanText('a.pem', '-----BEGIN ' + 'RSA PRIVATE KEY-----')).toHaveLength(1);
    expect(scanText('docker-compose.yml', '      DATABASE_PASSWORD: hunter2hunter2')).toHaveLength(1);
    expect(scanText('config/app.env', 'API_KEY=abcdef123456')).toHaveLength(1);
    expect(scanText('conf.json', '  "clientSecret": "very-secret-value"')).toHaveLength(1);
  });

  it('accepts references instead of values', () => {
    for (const line of [
      '      DATABASE_PASSWORD_FILE: /run/secrets/platform_db_password',
      '      PASSWORD: ${PLATFORM_DB_PASSWORD}',
      '  oidc_client_secret: { file: ./secrets/oidc_client_secret }',
      '      OIDC_CLIENT_SECRET_FILE: /run/secrets/oidc_client_secret',
      'token_ttl=15m',
    ]) expect(scanText('docker-compose.yml', line), line).toEqual([]);
  });

  it('does not exempt other places that look like the local trial stack', () => {
    expect(scanText('deploy/compose/docker-compose.yml', '      DATABASE_PASSWORD: local-trial-db-password')).toHaveLength(1);
    expect(scanText('deploy/compose/local/docker-compose.local.yml', '      DATABASE_PASSWORD: local-trial-db-password')).toEqual([]);
  });
});
