import { describe, expect, it } from 'vitest';
import { PgTestCaseRepository } from '../src';
import { freshDb } from './helpers';

describe('test case library storage', () => {
  it('keeps the first version and adds the next one', async () => {
    const { db } = await freshDb({ seed: false });
    const cases = new PgTestCaseRepository(db);
    const created = await cases.insert({ id: '11111111-1111-4111-8111-111111111111', key: 'login', name: 'Login', summary: 'A customer signs in', workItem: 'QA-1', steps: 'Open the page', expected: 'The form is shown' });
    expect(created.currentVersion).toBe(1);
    const revised = await cases.saveVersion(created.id, 2, 'Open the page and submit', 'The account page opens', 'A customer signs in');
    expect(revised.currentVersion).toBe(2);
    expect((await cases.versions(created.id)).map((v) => v.version)).toEqual([2, 1]);
    const collection = await cases.insertCollection({ id: '22222222-2222-4222-8222-222222222222', name: 'Checkout smoke', description: '' });
    expect(await cases.addCase(collection.id, created.id)).toBe('added');
    expect((await cases.getCollection(collection.id))?.cases).toEqual([{ id: created.id, name: 'Login', version: 2, position: 1 }]);
  });
});