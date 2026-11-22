import { describe, expect, it } from 'vitest';
import { RegressionCollectionService } from '@qa/application';
import { InMemoryAuditSink, InMemoryRegressionCollectionRepository } from '../src';

describe('RegressionCollectionService', () => {
  it('ensures smoke and syncs approved Squash case ids', async () => {
    const collections = new InMemoryRegressionCollectionRepository();
    const service = new RegressionCollectionService({ collections, audit: new InMemoryAuditSink() });
    const smoke = await service.ensureSmoke();
    expect(smoke).toMatchObject({ key: 'smoke', size: 0, squashCaseIds: [] });

    const synced = await service.syncFromApprovedMappings({ id: 'lead' }, 'smoke', async () => ['238', '238', '241']);
    expect(synced.squashCaseIds).toEqual(['238', '241']);
    expect(await service.caseIdsForKey('smoke')).toEqual(['238', '241']);
    expect(await service.caseIdsForKey('missing')).toBeUndefined();
  });
});
