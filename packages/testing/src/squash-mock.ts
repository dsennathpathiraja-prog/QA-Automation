import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';

/**
 * A fake SquashTM 15.0.4 REST API that follows the vendor documentation (paths, HAL `_embedded`
 * keys, `page` object, snake_case fields, authentication behaviour). Used for contract tests
 * so adapter code never needs the real instance. It records every request so tests can prove
 * that nothing but GET was ever sent.
 */
export interface SquashMockRequest {
  method: string;
  path: string;
  authorization?: string;
}

export interface SquashMockOptions {
  token: string;
  /** What the mock's token may do. A READ token makes every non-GET answer 403, as Squash would. */
  permissions?: 'READ' | 'READ_WRITE';
  contextPath?: string;
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

const project = (id: number) => ({ _type: 'project', id, name: id === 1 ? 'Retail Web' : 'Back Office' });
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
  const { _type, id, name, reference } = e;
  return reference === undefined ? { _type, id, name } : { _type, id, name, reference };
};

export async function startSquashMock(o: SquashMockOptions): Promise<SquashMock> {
  const requests: SquashMockRequest[] = [];
  const permissions = o.permissions ?? 'READ';
  const context = o.contextPath ?? '/squash';
  const root = `${context}/api/rest/latest`;

  const page = (items: unknown[], key: string, url: URL) => {
    const size = Math.max(1, Number(url.searchParams.get('size') ?? 20));
    const number = Math.max(0, Number(url.searchParams.get('page') ?? 0));
    const slice = items.slice(number * size, number * size + size);
    return { _embedded: { [key]: slice }, page: { size, totalElements: items.length, totalPages: Math.max(1, Math.ceil(items.length / size)), number } };
  };

  const route = (path: string, url: URL): { status: number; body: unknown } => {
    let m: RegExpMatchArray | null;
    if (path === '/projects') return { status: 200, body: page([project(1), project(2)], 'projects', url) };
    if ((m = path.match(/^\/projects\/(\d+)\/test-cases$/))) return { status: 200, body: page(TEST_CASES.filter((t) => t.project.id === Number(m![1])).map(summaryOf), 'test-cases', url) };
    if (path === '/test-cases') return { status: 200, body: page(TEST_CASES.map(summaryOf), 'test-cases', url) };
    if ((m = path.match(/^\/test-cases\/(\d+)$/))) {
      const t = TEST_CASES.find((x) => x.id === Number(m![1]));
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
    return { status: 404, body: { message: 'not found' } };
  };

  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    const url = new URL(req.url ?? '/', 'http://mock');
    const rec: SquashMockRequest = { method: req.method ?? 'GET', path: url.pathname + url.search, authorization: req.headers.authorization ? '(present)' : undefined };
    requests.push(rec);
    const send = (status: number, body: unknown, contentType = 'application/json') => {
      res.statusCode = status;
      res.setHeader('content-type', contentType);
      res.end(typeof body === 'string' ? body : JSON.stringify(body));
    };
    const forced = o.override?.(rec);
    if (forced) return send(forced.status, forced.body ?? {}, forced.contentType);
    if (!url.pathname.startsWith(root)) return send(404, '<html>not found</html>', 'text/html');
    const auth = req.headers.authorization ?? '';
    if (auth.startsWith('Basic ')) return send(401, { message: 'Basic authentication is not allowed for REST API.' });
    if (auth !== `Bearer ${o.token}`) return send(401, { message: 'Unauthorized' });
    if (req.method !== 'GET') return send(permissions === 'READ' ? 403 : 405, { message: 'write not available in the mock' });
    const r = route(url.pathname.slice(root.length), url);
    return send(r.status, r.body);
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
