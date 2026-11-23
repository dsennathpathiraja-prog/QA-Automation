import { describe, expect, it } from 'vitest';
import { uuidv7 } from '@qa/domain';
import {
  PgApprovedHostRepository,
  PgExecutionRepository,
  PgRunPolicyStore,
  PgWorkflowRepository,
  PgWorkflowVersionRepository,
  schema,
} from '../src';
import { freshDb } from './helpers';

describe('PgRunPolicyStore browser allowlist', () => {
  it('fills allowedOrigins from the environment URL and application hosts (not a stale empty list)', async () => {
    const { db } = await freshDb();
    const hosts = new PgApprovedHostRepository(db);
    await hosts.add({ hostPattern: 'sdk.paynsure.internal', purpose: 'application', internal: true, allowHttp: true });
    await hosts.add({ hostPattern: 'playwright-mcp', purpose: 'connector', internal: true, allowHttp: true });

    const envId = uuidv7();
    await db.insert(schema.environment).values({
      id: envId,
      projectId: '01900000-0000-7000-8000-000000000001',
      name: 'Paynsure QA',
      kind: 'qa',
      applicationUrl: 'https://sdk.paynsure.internal/portal',
    });

    const workflows = new PgWorkflowRepository(db);
    const versions = new PgWorkflowVersionRepository(db);
    const runs = new PgExecutionRepository(db);
    const wf = await workflows.insert({
      id: uuidv7(),
      key: 'rv',
      name: 'RV',
      description: '',
      type: 'requirement-validation',
      definition: {
        spec: {
          connectors: [{ role: 'browserAutomation', binding: { connectorInstanceId: null } }],
          policy: { capabilityDeny: ['scm.write.*'] },
          steps: [{ id: 'explore_ui' }],
        },
      },
    });
    const version = await versions.insert({
      id: uuidv7(),
      workflowId: wf.id,
      version: 1,
      contentHash: 'hash',
      definition: wf.definition,
      approvedBy: 'lead',
    });
    const run = await runs.insert({
      id: uuidv7(),
      workflowId: wf.id,
      versionId: version.id,
      definition: wf.definition,
      params: { environment: envId },
    });

    const policy = await new PgRunPolicyStore(db).get(run.id);
    expect(policy?.environmentKind).toBe('qa');
    expect(policy?.allowedOrigins).toEqual(
      expect.arrayContaining(['https://sdk.paynsure.internal', 'sdk.paynsure.internal']),
    );
    // Connector-purpose hosts must not be treated as browser navigation targets.
    expect(policy?.allowedOrigins).not.toContain('playwright-mcp');
  });

  it('re-reads application hosts on each get so a later approval is visible', async () => {
    const { db } = await freshDb();
    const hosts = new PgApprovedHostRepository(db);
    const workflows = new PgWorkflowRepository(db);
    const versions = new PgWorkflowVersionRepository(db);
    const runs = new PgExecutionRepository(db);
    const store = new PgRunPolicyStore(db);

    const wf = await workflows.insert({
      id: uuidv7(),
      key: 'rv2',
      name: 'RV2',
      description: '',
      type: 'requirement-validation',
      definition: { spec: { connectors: [], policy: { capabilityDeny: [] }, steps: [{ id: 'a' }] } },
    });
    const version = await versions.insert({
      id: uuidv7(),
      workflowId: wf.id,
      version: 1,
      contentHash: 'h2',
      definition: wf.definition,
      approvedBy: 'lead',
    });
    const run = await runs.insert({
      id: uuidv7(),
      workflowId: wf.id,
      versionId: version.id,
      definition: wf.definition,
      params: {},
    });

    expect((await store.get(run.id))?.allowedOrigins).toEqual([]);
    await hosts.add({ hostPattern: 'sdk.paynsure.internal', purpose: 'application', internal: true, allowHttp: true });
    expect((await store.get(run.id))?.allowedOrigins).toContain('sdk.paynsure.internal');
  });
});
