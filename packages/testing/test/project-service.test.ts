import { describe, expect, it } from 'vitest';
import { ProjectService } from '@qa/application';
import { InMemoryAuditSink, InMemoryProjectRepository } from '../src';

const actor = { id: 'admin-1' };

function setup() {
  const projects = new InMemoryProjectRepository();
  const audit = new InMemoryAuditSink();
  const service = new ProjectService({ projects, audit });
  return { projects, audit, service };
}

describe('ProjectService', () => {
  it('creates a project with a generated key and lists it', async () => {
    const s = setup();
    const created = await s.service.create(actor, { name: 'Retail Web' });
    expect(created).toMatchObject({ name: 'Retail Web', key: 'retail-web', status: 'active' });
    expect(await s.service.list()).toEqual([expect.objectContaining({ id: created.id, key: 'retail-web' })]);
    expect(s.audit.entries).toEqual([expect.objectContaining({ action: 'project.create', subjectId: created.id })]);
  });

  it('rejects duplicate names and archives', async () => {
    const s = setup();
    await s.service.create(actor, { name: 'Alpha', key: 'alpha' });
    await expect(s.service.create(actor, { name: 'alpha', key: 'alpha-2' })).rejects.toMatchObject({ errorClass: 'conflict' });
    const a = (await s.service.list())[0]!;
    const archived = await s.service.archive(actor, a.id);
    expect(archived.status).toBe('archived');
  });

  it('refuses to archive the Default project and creates an empty project row only', async () => {
    const s = setup();
    const def = await s.service.create(actor, { name: 'Default', key: 'default' });
    await expect(s.service.archive(actor, def.id)).rejects.toMatchObject({ errorClass: 'conflict' });
    const created = await s.service.create(actor, { name: 'Fresh' });
    expect(s.projects.rows.size).toBe(2);
    expect(created.key).toBe('fresh');
  });
});
