import { PlatformError, type Clock, type SecretLease, type SecretMaterial, type SecretStore, systemClock } from '@qa/domain';
import { assertLocator } from './locator';
import { makeLease } from './in-memory-secret-store';

export type OpenBaoAuth =
  | { type: 'approle'; roleId: string; secretId: string }
  | { type: 'token'; token: string };

export type FetchFn = (url: string, init?: { method?: string; headers?: Record<string, string>; body?: string }) => Promise<{
  status: number;
  json(): Promise<unknown>;
}>;

export interface OpenBaoOptions {
  addr: string;
  mount?: string;
  auth: OpenBaoAuth;
  fetchImpl?: FetchFn;
  clock?: Clock;
}

/**
 * KV v2 adapter. Policies decide capability: the `api` AppRole is granted create/update only, the
 * `worker` AppRole read. This adapter does not try to work around a denied operation.
 */
export class OpenBaoSecretStore implements SecretStore {
  readonly kind = 'openbao';
  private token: { value: string; expiresAt: number } | undefined;
  private readonly mount: string;
  private readonly clock: Clock;
  private readonly fetchFn: FetchFn;

  constructor(private readonly o: OpenBaoOptions) {
    this.mount = o.mount ?? 'qa-platform';
    this.clock = o.clock ?? systemClock;
    this.fetchFn = o.fetchImpl ?? ((url, init) => fetch(url, init) as ReturnType<FetchFn>);
  }

  async put(locator: string, material: SecretMaterial) {
    assertLocator(locator);
    const res = await this.call('POST', `/v1/${this.mount}/data/${locator}`, { data: material });
    const version = (res as { data?: { version?: number } }).data?.version;
    return { version: typeof version === 'number' ? version : 1 };
  }

  async lease(locator: string, opts?: { ttlMs?: number }): Promise<SecretLease> {
    assertLocator(locator);
    const res = (await this.call('GET', `/v1/${this.mount}/data/${locator}`)) as { data?: { data?: SecretMaterial } };
    const data = res.data?.data;
    if (!data) throw new PlatformError('not-found', 'secret not found');
    return makeLease({ ...data }, new Date(this.clock.now().getTime() + (opts?.ttlMs ?? 300_000)));
  }

  async exists(locator: string): Promise<boolean> {
    assertLocator(locator);
    try {
      await this.call('GET', `/v1/${this.mount}/metadata/${locator}`);
      return true;
    } catch (e) {
      if (e instanceof PlatformError && e.errorClass === 'not-found') return false;
      throw e;
    }
  }

  async delete(locator: string): Promise<void> {
    assertLocator(locator);
    await this.call('DELETE', `/v1/${this.mount}/metadata/${locator}`);
  }

  private async login(): Promise<string> {
    const a = this.o.auth;
    if (a.type === 'token') return a.token;
    const now = this.clock.now().getTime();
    if (this.token && this.token.expiresAt - 30_000 > now) return this.token.value;
    const res = await this.fetchFn(`${this.o.addr}/v1/auth/approle/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ role_id: a.roleId, secret_id: a.secretId }),
    });
    if (res.status !== 200) throw new PlatformError('auth', `OpenBao login failed (${res.status})`);
    const body = (await res.json()) as { auth?: { client_token?: string; lease_duration?: number } };
    const t = body.auth?.client_token;
    if (!t) throw new PlatformError('auth', 'OpenBao login returned no token');
    this.token = { value: t, expiresAt: now + (body.auth?.lease_duration ?? 300) * 1000 };
    return t;
  }

  private async call(method: string, path: string, body?: unknown): Promise<unknown> {
    const token = await this.login();
    const res = await this.fetchFn(`${this.o.addr}${path}`, {
      method,
      headers: { 'x-vault-token': token, 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    if (res.status === 404) throw new PlatformError('not-found', 'secret not found');
    if (res.status === 403) throw new PlatformError('denied', 'OpenBao policy denied this operation');
    if (res.status === 401) {
      this.token = undefined;
      throw new PlatformError('auth', 'OpenBao token rejected');
    }
    if (res.status >= 500) throw new PlatformError('transient', `OpenBao error (${res.status})`);
    if (res.status >= 400) throw new PlatformError('validation', `OpenBao request failed (${res.status})`);
    if (res.status === 204) return {};
    return res.json();
  }
}
