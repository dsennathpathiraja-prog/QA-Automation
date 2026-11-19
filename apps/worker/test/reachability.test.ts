import { describe, expect, it } from 'vitest';
import { PlatformError } from '@qa/domain';
import { InMemoryEnvironmentRepository } from '@qa/testing';
import { checkReachability } from '../src/reachability';

const id = '11111111-1111-4111-8111-111111111111';

async function queued() {
  const environments = new InMemoryEnvironmentRepository();
  await environments.insert({
    id,
    name: 'QA',
    kind: 'qa',
    applicationUrl: 'https://qa.shop.example',
    browser: { browser: 'chromium', headless: true },
    restrictions: { maxParallelism: 1, prodSafeOnly: false },
    enabled: true,
  });
  await environments.queueReachability(id);
  return environments;
}

describe('environment reachability', () => {
  it('records that the application answered', async () => {
    const environments = await queued();
    expect(await checkReachability(environments, async () => ({ status: 200 }))).toBe('busy');
    expect(await environments.get(id)).toMatchObject({ reachability: 'reachable', reachabilityDetail: 'The application answered 200.' });
    expect(await checkReachability(environments, async () => ({ status: 200 }))).toBe('idle');
  });

  it('records a refusal when the host is not approved', async () => {
    const environments = await queued();
    await checkReachability(environments, async () => {
      throw new PlatformError('denied', 'host qa.shop.example is not on the approved-host list');
    });
    const saved = await environments.get(id);
    expect(saved?.reachability).toBe('unreachable');
    expect(saved?.reachabilityDetail).toMatch(/approved list/);
  });

  it('records a server error as unreachable', async () => {
    const environments = await queued();
    await checkReachability(environments, async () => ({ status: 503 }));
    expect((await environments.get(id))?.reachabilityDetail).toBe('The application returned status 503.');
  });
});