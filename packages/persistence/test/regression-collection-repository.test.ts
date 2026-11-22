import { describe, expect, it } from 'vitest';
import { PgRegressionCollectionRepository, seedRegressionCollections } from '../src';
import { freshDb } from './helpers';

describe('PgRegressionCollectionRepository', () => {
  it('seeds smoke and stores Squash case id members', async () => {
    const { db, client } = await freshDb();
    const first = await seedRegressionCollections(db);
    const second = await seedRegressionCollections(db);
    expect(first.created).toBe(true);
    expect(second.created).toBe(false);

    const repo = new PgRegressionCollectionRepository(db);
    const smoke = await repo.findByKey('smoke');
    expect(smoke?.name).toBe('Smoke');

    await repo.replaceMembers(smoke!.id, ['238', '239']);
    expect(await repo.listMembers(smoke!.id)).toEqual([
      { collectionId: smoke!.id, squashCaseId: '238', position: 0 },
      { collectionId: smoke!.id, squashCaseId: '239', position: 1 },
    ]);

    await repo.addMembers(smoke!.id, ['239', '240']);
    expect((await repo.listMembers(smoke!.id)).map((m) => m.squashCaseId)).toEqual(['238', '239', '240']);

    await client.close();
  });
});
