import { randomUUID } from 'node:crypto';
import { PlatformError } from '@qa/domain';
import type { ActorRef } from './connector-service';
import type { AuditSink, ProjectPatch, ProjectRecord, ProjectRepository, ProjectStatus } from './ports';

export interface ProjectServiceDeps {
  projects: ProjectRepository;
  audit: AuditSink;
}

export interface ProjectSummary {
  id: string;
  key: string;
  name: string;
  description: string;
  status: ProjectStatus;
  updatedAt: string;
}

export interface CreateProjectInput {
  name: string;
  key?: string;
  description?: string;
}

export interface UpdateProjectInput {
  name?: string;
  description?: string;
  status?: ProjectStatus;
}

const KEY_RE = /^[a-z][a-z0-9-]{1,62}$/;

const slugify = (name: string): string => {
  const s = name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 63);
  if (!s || !/^[a-z]/.test(s)) return `p-${s || 'project'}`.replace(/--+/g, '-').slice(0, 63);
  return s;
};

export class ProjectService {
  constructor(private readonly d: ProjectServiceDeps) {}

  async list(filter?: { status?: ProjectStatus }): Promise<ProjectSummary[]> {
    return (await this.d.projects.list(filter)).map((p) => this.summary(p));
  }

  async get(id: string): Promise<ProjectSummary> {
    return this.summary(await this.require(id));
  }

  async create(actor: ActorRef, input: CreateProjectInput): Promise<ProjectSummary> {
    const name = this.validName(input.name);
    const key = this.validKey(input.key?.trim() ? input.key : slugify(name));
    const description = (input.description ?? '').trim().slice(0, 2000);
    const id = randomUUID();
    const rec = await this.d.projects.insert({ id, key, name, description, createdBy: actor.id });
    await this.d.audit.append({
      actorId: actor.id,
      action: 'project.create',
      subjectType: 'project',
      subjectId: id,
      detail: { key, name },
    });
    return this.summary(rec);
  }

  async update(actor: ActorRef, id: string, input: UpdateProjectInput): Promise<ProjectSummary> {
    await this.require(id);
    const patch: ProjectPatch = {};
    if (input.name !== undefined) patch.name = this.validName(input.name);
    if (input.description !== undefined) patch.description = input.description.trim().slice(0, 2000);
    if (input.status !== undefined) {
      if (input.status !== 'active' && input.status !== 'archived') throw new PlatformError('validation', 'Project status must be active or archived.');
      patch.status = input.status;
    }
    if (Object.keys(patch).length === 0) return this.get(id);
    const rec = await this.d.projects.update(id, patch);
    await this.d.audit.append({
      actorId: actor.id,
      action: 'project.update',
      subjectType: 'project',
      subjectId: id,
      detail: { ...patch },
    });
    return this.summary(rec);
  }

  async archive(actor: ActorRef, id: string): Promise<ProjectSummary> {
    return this.update(actor, id, { status: 'archived' });
  }

  private async require(id: string): Promise<ProjectRecord> {
    const rec = await this.d.projects.get(id);
    if (!rec) throw new PlatformError('not-found', 'Project not found');
    return rec;
  }

  private summary(p: ProjectRecord): ProjectSummary {
    return {
      id: p.id,
      key: p.key,
      name: p.name,
      description: p.description,
      status: p.status,
      updatedAt: p.updatedAt.toISOString(),
    };
  }

  private validName(raw: string): string {
    const name = raw.trim();
    if (name.length < 1 || name.length > 200) throw new PlatformError('validation', 'Project name must be between 1 and 200 characters.');
    return name;
  }

  private validKey(raw: string): string {
    const key = raw.trim().toLowerCase();
    if (!KEY_RE.test(key)) throw new PlatformError('validation', 'Project key must start with a letter and use only lowercase letters, digits, and hyphens (2–63 characters).');
    return key;
  }
}
