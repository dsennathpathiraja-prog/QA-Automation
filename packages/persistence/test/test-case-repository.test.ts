import { describe, expect, it } from 'vitest';
import { PgTestCaseRepository } from '../src';
import { freshDb } from './helpers';

describe('test case library storage', () => {
  it('keeps the first version and adds the next one', async () => {
    const { db } = await freshDb({ seed: false });
    const cases = new PgTestCaseRepository(db);
    const created = await cases.insert({
      id: '11111111-1111-4111-8111-111111111111',
      key: 'login',
      name: 'Login',
      summary: 'A customer signs in',
      workItem: 'QA-1',
      steps: 'Open the page',
      expected: 'The form is shown',
      kind: 'positive',
      priority: 'medium',
    });
    expect(created.currentVersion).toBe(1);
    expect(created).toMatchObject({ kind: 'positive', priority: 'medium' });
    const revised = await cases.saveVersion(created.id, 2, 'Open the page and submit', 'The account page opens', 'A customer signs in');
    expect(revised.currentVersion).toBe(2);
    expect((await cases.versions(created.id)).map((v) => v.version)).toEqual([2, 1]);
    const collection = await cases.insertCollection({ id: '22222222-2222-4222-8222-222222222222', name: 'Checkout smoke', description: '' });
    expect(await cases.addCase(collection.id, created.id)).toBe('added');
    expect((await cases.getCollection(collection.id))?.cases).toEqual([
      { id: created.id, name: 'Login', version: 2, position: 1, kind: 'positive', priority: 'medium' },
    ]);
  });

  it('soft-deletes a case and a collection with its members', async () => {
    const { db } = await freshDb({ seed: false });
    const cases = new PgTestCaseRepository(db);
    const a = await cases.insert({
      id: '11111111-1111-4111-8111-111111111111',
      key: 'qap-qa-1-1',
      name: 'Negative: Login',
      summary: '',
      workItem: 'QA-1',
      steps: 'Open',
      expected: 'Form',
      kind: 'negative',
      priority: 'high',
    });
    const b = await cases.insert({
      id: '22222222-2222-4222-8222-222222222222',
      key: 'qap-qa-1-2',
      name: 'Logout',
      summary: '',
      workItem: 'QA-1',
      steps: 'Click',
      expected: 'Out',
      kind: 'positive',
      priority: 'medium',
    });
    const collection = await cases.insertCollection({ id: '33333333-3333-4333-8333-333333333333', name: 'QA-1', description: 'Cases generated for QA-1' });
    await cases.addCase(collection.id, a.id);
    await cases.addCase(collection.id, b.id);
    expect((await cases.listCollections())[0]?.size).toBe(2);
    expect(await cases.softDelete(a.id)).toBe(true);
    expect(await cases.get(a.id)).toBeUndefined();
    expect((await cases.listCollections())[0]?.size).toBe(1);
    expect((await cases.getCollection(collection.id))?.cases).toEqual([
      { id: b.id, name: 'Logout', version: 1, position: 2, kind: 'positive', priority: 'medium' },
    ]);
    expect(await cases.softDeleteCollection(collection.id)).toBe(true);
    expect(await cases.getCollection(collection.id)).toBeUndefined();
    expect(await cases.get(b.id)).toBeUndefined();
    expect(await cases.list()).toEqual([]);
    expect(await cases.listCollections()).toEqual([]);
  });

  it('soft-deletes every platform case and collection', async () => {
    const { db } = await freshDb({ seed: false });
    const cases = new PgTestCaseRepository(db);
    const a = await cases.insert({
      id: '11111111-1111-4111-8111-111111111111',
      key: 'qap-1',
      name: 'Positive: one',
      summary: '',
      workItem: 'QA-1',
      steps: 'Open',
      expected: 'Ok',
      kind: 'positive',
      priority: 'medium',
    });
    const collection = await cases.insertCollection({ id: '22222222-2222-4222-8222-222222222222', name: 'QA-1', description: '' });
    await cases.addCase(collection.id, a.id);
    expect(await cases.softDeleteAllPlatform()).toEqual({ cases: 1, collections: 1 });
    expect(await cases.list()).toEqual([]);
    expect(await cases.listCollections()).toEqual([]);
  });
});