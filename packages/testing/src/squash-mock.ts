import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';

/**
 * A fake SquashTM 15.0.4 REST API that follows the vendor documentation (paths, HAL `_embedded`
 * keys, `page` object, snake_case fields, authentication behaviour). Used for contract tests
 * so adapter code never needs the real instance. It records every request so tests can prove
 * that a READ token never receives a write, and a READ_WRITE token can create a test case.
 */
export interface SquashMockRequest {
  method: string;
  path: string;
  authorization?: string;
  /** Parsed JSON body for POST/PATCH (tests assert create shape). */
  body?: unknown;
  /** Request Content-Type (attachment uploads are multipart/form-data). */
  contentType?: string;
  /** Raw body byte length (multipart screenshots). */
  rawByteLength?: number;
}

export interface SquashMockOptions {
  token: string;
  /** What the mock's token may do. A READ token makes every non-GET answer 403, as Squash would. */
  permissions?: 'READ' | 'READ_WRITE';
  contextPath?: string;
  /** Override the default Retail Web / Back Office projects (used for name-resolution tests). */
  projects?: { id: number; name: string }[];
  /** Test hook: return a response to replace the normal one. */
  override?: (req: SquashMockRequest) => { status: number; body?: unknown; contentType?: string } | undefined;
}

export interface SquashMock {
  baseUrl: string;
  requests: SquashMockRequest[];
  nonGetRequests(): SquashMockRequest[];
  close(): Promise<void>;
}

export function makeSquashToken(o: { permissions?: string; expiresAt?: Date } = {}): string {
  const enc = (v: unknown) => Buffer.from(JSON.stringify(v)).toString('base64url');
  return `${enc({ alg: 'HS512' })}.${enc({ sub: '1', uuid: 'mock', permissions: o.permissions ?? 'READ', iat: 1_721_308_789, exp: Math.floor((o.expiresAt ?? new Date('2027-01-01T00:00:00Z')).getTime() / 1000) })}.${'s'.repeat(40)}`;
}

const defaultProjectName = (id: number) => (id === 1 ? 'Retail Web' : 'Back Office');
const project = (id: number, name = defaultProjectName(id)) => ({ _type: 'project', id, name });
const link = (id: number, _type: string, name: string) => ({ _type, id, name });

const TEST_CASES: Record<string, any>[] = [
  {
    _type: 'test-case', id: 238, name: 'Guest checkout with card', reference: 'TC-238', project: project(1), importance: 'HIGH', status: 'APPROVED',
    prerequisite: '<p>A product is in the basket &amp; stock exists</p>',
    description: '<p>Check the guest can pay.</p><script>alert("injected")</script><ul><li>card</li><li>voucher</li></ul>',
    last_modified_on: '2026-10-01T10:00:00.000Z',
    custom_fields: [{ code: 'CF_TXT', label: 'level', value: 'smoke' }, { code: 'CF_TAGS', label: 'tags', value: ['checkout', 'payments'] }],
    automated_test: null,
    steps: [
      { _type: 'action-step', id: 1, action: '<p>Open the basket</p>', expected_result: '<p>Basket shows 1 item</p>' },
      { _type: 'action-step', id: 2, action: '<p>Pay by card</p>', expected_result: '<p>Order confirmation is shown</p>' },
      { _type: 'call-step', id: 3, called_test_case: link(239, 'test-case', 'Log out') },
    ],
  },
  { _type: 'scripted-test-case', id: 239, name: 'Log out', reference: 'TC-239', project: project(1), script: 'Feature: logout\n  Scenario: user logs out', steps: [] },
  { _type: 'keyword-test-case', id: 240, name: 'Search by keyword', reference: 'TC-240', project: project(1), steps: [] },
  { _type: 'test-case', id: 300, name: 'Back office login', reference: 'BO-1', project: project(2), steps: [] },
];

const REQUIREMENTS: Record<string, any>[] = [
  {
    _type: 'requirement', id: 624, name: 'Guest can check out', project: project(1), mode: 'NATIVE',
    current_version: {
      _type: 'requirement-version', id: 98, name: 'Guest can check out', reference: 'REQ-1', version_number: 3, criticality: 'MAJOR',
      category: { code: 'CAT_FUNCTIONAL' }, status: 'APPROVED', description: '<p>A visitor can buy without an account.</p>',
      custom_fields: [{ code: 'CF_TAG', label: 'tags', value: ['checkout'] }],
      verifying_test_cases: [link(238, 'test-case', 'Guest checkout with card')],
      last_modified_on: '2026-09-30T08:00:00.000Z',
    },
  },
  { _type: 'requirement', id: 625, name: 'Guest can check out later', project: project(2) },
];

const EXECUTIONS: Record<string, any>[] = [
  { _type: 'execution', id: 2, execution_order: 1, execution_status: 'SUCCESS', last_executed_by: 'qa.one', last_executed_on: '2026-09-24T10:00:00.000Z', path: '/Retail Web/Release 12/Iteration 1', number_of_issues: 0 },
  { _type: 'execution', id: 5, execution_order: 0, execution_status: 'BLOCKED', last_executed_by: 'qa.two', last_executed_on: '2026-09-25T10:00:00.000Z', path: '/Retail Web/Release 12/Iteration 2', number_of_issues: 2 },
];

const summaryOf = (e: Record<string, any>) => {
  const { _type, id, name, reference, automated_test_reference } = e;
  return {
    _type,
    id,
    name,
    ...(reference === undefined ? {} : { reference }),
    ...(automated_test_reference === undefined ? {} : { automated_test_reference }),
  };
};

export async function startSquashMock(o: SquashMockOptions): Promise<SquashMock> {
  const requests: SquashMockRequest[] = [];
  const permissions = o.permissions ?? 'READ';
  const context = o.contextPath ?? '/squash';
  const root = `${context}/api/rest/latest`;
  const cases: Record<string, any>[] = TEST_CASES.map((item) => ({ ...item, steps: Array.isArray(item.steps) ? [...item.steps] : [] }));
  const attachments: { id: number; path: string; name: string; bytes: number }[] = [];

  const page = (items: unknown[], key: string, url: URL) => {
    const size = Math.max(1, Number(url.searchParams.get('size') ?? 20));
    const number = Math.max(0, Number(url.searchParams.get('page') ?? 0));
    const slice = items.slice(number * size, number * size + size);
    return { _embedded: { [key]: slice }, page: { size, totalElements: items.length, totalPages: Math.max(1, Math.ceil(items.length / size)), number } };
  };

  const projects = (o.projects ?? [{ id: 1, name: 'Retail Web' }, { id: 2, name: 'Back Office' }]).map((p) => project(p.id, p.name));
  const projectById = (id: number) => projects.find((p) => p.id === id) ?? project(id);

  const route = (path: string, url: URL): { status: number; body: unknown } => {
    let m: RegExpMatchArray | null;
    if (path === '/projects') return { status: 200, body: page(projects, 'projects', url) };
    if ((m = path.match(/^\/projects\/(\d+)\/test-cases$/))) return { status: 200, body: page(cases.filter((t) => t.project.id === Number(m![1])).map(summaryOf), 'test-cases', url) };
    if (path === '/test-cases') return { status: 200, body: page(cases.map(summaryOf), 'test-cases', url) };
    if ((m = path.match(/^\/test-cases\/(\d+)$/))) {
      const t = cases.find((x) => x.id === Number(m![1]));
      return t ? { status: 200, body: t } : { status: 404, body: { message: 'not found' } };
    }
    if ((m = path.match(/^\/test-cases\/(\d+)\/executions$/))) return { status: 200, body: page(m[1] === '238' ? EXECUTIONS : [], 'executions', url) };
    if ((m = path.match(/^\/projects\/(\d+)\/requirements$/))) return { status: 200, body: page(REQUIREMENTS.filter((r) => r.project.id === Number(m![1])).map(summaryOf), 'requirements', url) };
    if (path === '/requirements') return { status: 200, body: page(REQUIREMENTS.map(summaryOf), 'requirements', url) };
    if ((m = path.match(/^\/requirements\/(\d+)$/))) {
      const r = REQUIREMENTS.find((x) => x.id === Number(m![1]));
      return r ? { status: 200, body: r } : { status: 404, body: { message: 'not found' } };
    }
    if (path === '/campaigns' || /^\/projects\/\d+\/campaigns$/.test(path)) return { status: 200, body: page([{ _type: 'campaign', id: 10, name: 'Release 12' }], 'campaigns', url) };
    if (path === '/iterations' || /^\/campaigns\/\d+\/iterations$/.test(path)) return { status: 200, body: page([{ _type: 'iteration', id: 20, name: 'Iteration 1' }, { _type: 'iteration', id: 21, name: 'Iteration 2' }], 'iterations', url) };
    // Regression campaign scope: GET /iterations/{id}/test-plan → ITPIs with linked test cases.
    if ((m = path.match(/^\/iterations\/(\d+)\/test-plan$/))) {
      const iterationId = Number(m[1]);
      const plan = iterationId === 20
        ? [
          { _type: 'test-plan-item', id: 1001, name: 'Guest checkout with card', test_case: link(238, 'test-case', 'Guest checkout with card') },
          { _type: 'test-plan-item', id: 1002, name: 'Log out', test_case: link(239, 'test-case', 'Log out') },
        ]
        : iterationId === 21
          ? [{ _type: 'test-plan-item', id: 1003, name: 'Search by keyword', test_case: link(240, 'test-case', 'Search by keyword') }]
          : [];
      return { status: 200, body: page(plan, 'test-plan', url) };
    }
    return { status: 404, body: { message: 'not found' } };
  };

  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk) => chunks.push(Buffer.from(chunk)));
    req.on('end', () => {
      const url = new URL(req.url ?? '/', 'http://mock');
      // Keep the real Authorization so tests can prove Squash 15.x Bearer-only (never Token / Basic / bare).
      const authHeader = typeof req.headers.authorization === 'string' ? req.headers.authorization : undefined;
      const raw = Buffer.concat(chunks);
      const reqContentType = typeof req.headers['content-type'] === 'string' ? req.headers['content-type'] : undefined;
      const rec: SquashMockRequest = {
        method: req.method ?? 'GET',
        path: url.pathname + url.search,
        authorization: authHeader,
        contentType: reqContentType,
        rawByteLength: raw.byteLength,
      };
      requests.push(rec);
      const send = (status: number, body: unknown, contentType = 'application/json') => {
        res.statusCode = status;
        res.setHeader('content-type', contentType);
        res.end(typeof body === 'string' ? body : JSON.stringify(body));
      };
      const forced = o.override?.(rec);
      if (forced) return send(forced.status, forced.body ?? {}, forced.contentType);
      if (!url.pathname.startsWith(root)) return send(404, '<html>not found</html>', 'text/html');
      const auth = authHeader ?? '';
      // SquashTM 15.0.4: only Authorization: Bearer <token> is accepted.
      if (auth.startsWith('Basic ')) return send(401, { message: 'Basic authentication is not allowed for REST API.' });
      if (auth.startsWith('Token ') || auth.startsWith('token ')) {
        return send(401, { message: 'Token authentication is not allowed for REST API.' });
      }
      if (!auth.startsWith('Bearer ')) return send(401, { message: 'Unauthorized' });
      if (auth !== `Bearer ${o.token}`) return send(401, { message: 'Unauthorized' });
      const path = url.pathname.slice(root.length);
      if (req.method !== 'GET') {
        // Real Squash answers 401 when a READ token tries to write (same as a bad token).
        if (permissions !== 'READ_WRITE') return send(401, { message: 'Unauthorized' });
        let created: RegExpMatchArray | null;
        // SquashTM: POST /executions/{id}/attachments or /test-cases/{id}/attachments (multipart field `files`).
        if (req.method === 'POST' && (created = path.match(/^\/(executions|test-cases)\/(\d+)\/attachments\/?$/))) {
          if (!String(reqContentType ?? '').includes('multipart/form-data')) {
            return send(400, { message: 'multipart/form-data required' });
          }
          const rawText = raw.toString('latin1');
          const nameMatch = /filename="([^"]+)"/i.exec(rawText);
          const id = 9000 + attachments.length + 1;
          const row = { id, path, name: nameMatch?.[1] ?? 'attachment.bin', bytes: raw.byteLength };
          attachments.push(row);
          rec.body = { name: row.name, bytes: row.bytes };
          return send(201, { _embedded: { attachments: [{ _type: 'attachment', id: row.id, name: row.name, size: row.bytes }] } });
        }
        let payload: Record<string, unknown> = {};
        try {
          payload = JSON.parse(raw.toString('utf8') || '{}') as Record<string, unknown>;
        } catch {
          return send(400, { message: 'invalid json' });
        }
        rec.body = payload;
        // SquashTM 15.0.4: POST /test-cases with parent project + automated_test_reference (not POST /projects/{id}/test-cases).
        if (req.method === 'POST' && path === '/test-cases') {
          const parent = payload.parent as { _type?: string; id?: unknown } | undefined;
          const projectId = Number(parent?.id);
          if (parent?._type !== 'project' || !Number.isInteger(projectId) || projectId <= 0) {
            return send(400, { message: 'parent {_type:project,id} is required' });
          }
          const id = 1000 + cases.length;
          const row = {
            _type: 'test-case',
            id,
            name: String(payload.name ?? ''),
            automated_test_reference: String(payload.automated_test_reference ?? ''),
            description: typeof payload.description === 'string' ? payload.description : undefined,
            project: projectById(projectId),
            steps: [] as Record<string, unknown>[],
          };
          cases.push(row);
          return send(201, row);
        }
        // SquashTM 15.0.4: PATCH /test-cases/{id} updates name / automated_test_reference / description (no parent).
        if (req.method === 'PATCH' && (created = path.match(/^\/test-cases\/(\d+)$/))) {
          const row = cases.find((item) => item.id === Number(created![1]));
          if (!row) return send(404, { message: 'not found' });
          if (typeof payload.name === 'string') row.name = payload.name;
          if (typeof payload.automated_test_reference === 'string') row.automated_test_reference = payload.automated_test_reference;
          if (typeof payload.description === 'string') row.description = payload.description;
          return send(200, row);
        }
        if (req.method === 'POST' && (created = path.match(/^\/test-cases\/(\d+)\/steps$/))) {
          const row = cases.find((item) => item.id === Number(created![1]));
          if (!row) return send(404, { message: 'not found' });
          const step = { _type: 'action-step', id: row.steps.length + 1, action: String(payload.action ?? ''), expected_result: String(payload.expected_result ?? '') };
          row.steps.push(step);
          return send(201, step);
        }
        // SquashTM 15.0.4: DELETE /test-steps/{id} removes one action step before republish replaces them.
        if (req.method === 'DELETE' && (created = path.match(/^\/test-steps\/(\d+)$/))) {
          const stepId = Number(created[1]);
          for (const row of cases) {
            const before = row.steps.length;
            row.steps = row.steps.filter((s: { id?: number }) => s.id !== stepId);
            if (row.steps.length !== before) return send(204, '');
          }
          return send(404, { message: 'not found' });
        }
        if (req.method === 'POST' && (created = path.match(/^\/iterations\/(\d+)\/executions$/))) {
          const id = 5000 + EXECUTIONS.length + 1;
          const row = {
            _type: 'execution',
            id,
            execution_order: 0,
            execution_status: String(payload.execution_status ?? 'READY'),
            last_executed_by: 'platform',
            last_executed_on: new Date().toISOString(),
            path: `/iteration/${created[1]}`,
            number_of_issues: 0,
            test_case: payload.test_case,
          };
          EXECUTIONS.push(row);
          return send(201, row);
        }
        if (req.method === 'PATCH' && (created = path.match(/^\/executions\/(\d+)$/))) {
          const row = EXECUTIONS.find((item) => item.id === Number(created![1]));
          if (!row) return send(404, { message: 'not found' });
          if (typeof payload.execution_status === 'string') row.execution_status = payload.execution_status;
          return send(200, row);
        }
        return send(405, { message: 'write not available in the mock' });
      }
      const r = route(path, url);
      return send(r.status, r.body);
    });
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as AddressInfo).port;
  return {
    baseUrl: `http://127.0.0.1:${port}${context}`,
    requests,
    nonGetRequests: () => requests.filter((r) => r.method !== 'GET'),
    close: () => new Promise((resolve) => server.close(() => resolve())),
  };
}
