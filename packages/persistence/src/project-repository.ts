import { and, eq, isNull, sql } from 'drizzle-orm';
import { PlatformError } from '@qa/domain';
import type { NewProject, ProjectPatch, ProjectRecord, ProjectRepository, ProjectStatus } from '@qa/application';
import type { Db } from './db';
import { project } from './schema';

/** Stable id for the Default project created by migration 0019 (backfill target). */
export const DEFAULT_PROJECT_ID = '01900000-0000-7000-8000-000000000001';

type Row = typeof project.$inferSelect;

const isUniqueViolation = (e: unknown): boolean => {
  const code = (e as { code?: string; cause?: { code?: string } })?.code ?? (e as { cause?: { code?: string } })?.cause?.code;
  return code === '23505';
};

const live = (id: string) => and(eq(project.id, id), isNull(project.deletedAt));

const toRecord = (r: Row): ProjectRecord => ({
  id: r.id,
  key: r.key,
  name: r.name,
  description: r.description,
  status: r.status as ProjectStatus,
  createdAt: r.createdAt,
  updatedAt: r.updatedAt,
});

export class PgProjectRepository implements ProjectRepository {
  constructor(private readonly db: Db) {}

  async list(filter?: { status?: ProjectStatus }): Promise<ProjectRecord[]> {
    const cond = filter?.status
      ? and(isNull(project.deletedAt), eq(project.status, filter.status))
      : isNull(project.deletedAt);
    const rows = await this.db.select().from(project).where(cond).orderBy(project.name);
    return rows.map(toRecord);
  }

  async get(id: string): Promise<ProjectRecord | undefined> {
    const [row] = await this.db.select().from(project).where(live(id)).limit(1);
    return row && toRecord(row);
  }

  async getByKey(key: string): Promise<ProjectRecord | undefined> {
    const [row] = await this.db
      .select()
      .from(project)
      .where(and(eq(project.key, key), isNull(project.deletedAt)))
      .limit(1);
    return row && toRecord(row);
  }

  async insert(n: NewProject): Promise<ProjectRecord> {
    try {
      const [row] = await this.db
        .insert(project)
        .values({ id: n.id, key: n.key, name: n.name, description: n.description, createdBy: n.createdBy ?? null })
        .returning();
      return toRecord(row!);
    } catch (e) {
      if (isUniqueViolation(e)) throw new PlatformError('conflict', `A project with that key or name already exists.`);
      throw e;
    }
  }

  async update(id: string, patch: ProjectPatch): Promise<ProjectRecord> {
    const set: Partial<typeof project.$inferInsert> = {
      updatedAt: new Date(),
      rowVersion: sql`${project.rowVersion} + 1` as unknown as number,
    };
    if (patch.name !== undefined) set.name = patch.name;
    if (patch.description !== undefined) set.description = patch.description;
    if (patch.status !== undefined) set.status = patch.status;
    try {
      const [row] = await this.db.update(project).set(set).where(live(id)).returning();
      if (!row) throw new PlatformError('not-found', 'Project not found');
      return toRecord(row);
    } catch (e) {
      if (isUniqueViolation(e)) throw new PlatformError('conflict', `A project with that name already exists.`);
      throw e;
    }
  }

  async softDelete(id: string): Promise<void> {
    await this.db.update(project).set({ deletedAt: new Date(), status: 'archived', updatedAt: new Date() }).where(live(id));
  }
}
