import { z } from 'zod';
import { PlatformError, matchHost } from '@qa/domain';
import {
  AUTH_PROFILE_TYPES,
  type ApprovedHost,
  type AuthProfileType,
  type EnvironmentRestrictions,
} from './ports';

const SECRET_KEYS = new Set(['password', 'token', 'storageState']);

export function checkedApplicationUrl(raw: string, hosts: ApprovedHost[]): string {
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    throw new PlatformError('validation', 'Application URL must be a full address, such as https://qa.example.com.');
  }
  if (url.username || url.password) throw new PlatformError('validation', 'Put credentials in an authentication profile, not in the application URL.');
  const host = url.hostname.toLowerCase();
  const rule = hosts.find((h) => matchHost(h.hostPattern, host));
  if (!rule) throw new PlatformError('validation', `Host ${host} is not on the approved-host list for applications. Approve it, then save the environment again.`);
  if (url.protocol === 'http:') {
    if (!(rule.internal && rule.allowHttp)) throw new PlatformError('validation', `Plain http is not allowed for ${host}. Approve it as an internal host, or use https.`);
  } else if (url.protocol !== 'https:') {
    throw new PlatformError('validation', 'Application URL must use https, or http for an approved internal host.');
  }
  return url.toString();
}

export function profileName(raw: string): string {
  const name = raw.trim();
  if (name.length < 1 || name.length > 80) throw new PlatformError('validation', 'Profile name must be between 1 and 80 characters.');
  return name;
}

export function stringMap(raw: Record<string, string> | undefined, label: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(raw ?? {})) {
    const k = key.trim();
    if (!/^[A-Za-z][A-Za-z0-9_-]{0,39}$/.test(k)) throw new PlatformError('validation', `${label} keys must start with a letter and stay under 40 characters.`);
    if (value.length > 500) throw new PlatformError('validation', `${label} values must be 500 characters or fewer.`);
    out[k] = value;
  }
  if (Object.keys(out).length > 40) throw new PlatformError('validation', `${label} can hold at most 40 entries.`);
  return out;
}

const PUBLIC_CONFIG = z.record(z.string().max(40), z.string().max(500));

export function authConfig(type: AuthProfileType, raw: Record<string, string> | undefined, hosts: ApprovedHost[]): Record<string, string> {
  const config = stringMap(raw, 'Authentication settings');
  for (const key of Object.keys(config)) {
    if (SECRET_KEYS.has(key)) throw new PlatformError('validation', 'Put passwords and tokens in the secret fields. They are stored separately and are never shown again.');
  }
  if (type === 'basic' || type === 'form-login') {
    if (!config.username?.trim()) throw new PlatformError('validation', 'Enter the username. The password is stored separately and is never shown again.');
    config.username = config.username.trim();
  }
  if (type === 'form-login') {
    if (!config.loginUrl) throw new PlatformError('validation', 'Enter the login page address.');
    config.loginUrl = checkedApplicationUrl(config.loginUrl, hosts);
  }
  const parsed = PUBLIC_CONFIG.safeParse(config);
  if (!parsed.success) throw new PlatformError('validation', 'Authentication settings are not valid.');
  return parsed.data;
}

export function authType(raw: string): AuthProfileType {
  if (!(AUTH_PROFILE_TYPES as readonly string[]).includes(raw)) throw new PlatformError('validation', 'Authentication type must be none, basic, form login, bearer, or saved browser session.');
  return raw as AuthProfileType;
}

export function requiredSecret(type: AuthProfileType, secrets: Record<string, string> | undefined, replacing: boolean): Record<string, string> | undefined {
  if (type === 'none') {
    if (secrets && Object.keys(secrets).length > 0) throw new PlatformError('validation', 'An authentication profile of type none does not take a secret.');
    return undefined;
  }
  const key = type === 'bearer' ? 'token' : type === 'storage-state' ? 'storageState' : 'password';
  if (!secrets) return replacing ? undefined : failSecret(type);
  const value = secrets[key]?.trim() ?? '';
  if (!value) return replacing ? undefined : failSecret(type);
  if (Object.keys(secrets).some((k) => k !== key)) throw new PlatformError('validation', 'Send only the secret this authentication type uses.');
  return { [key]: value };
}

function failSecret(type: AuthProfileType): never {
  const what = type === 'bearer' ? 'a token' : type === 'storage-state' ? 'the saved browser session' : 'a password';
  throw new PlatformError('validation', `Enter ${what}. It is stored encrypted and is never shown again.`);
}

export function restrictionIssues(restrictions: EnvironmentRestrictions, ctx: { workflowType?: 'requirement-validation' | 'regression-testing'; parallelism?: number; prodSafe?: boolean }): string[] {
  const errors: string[] = [];
  if (ctx.workflowType && restrictions.workflowTypes && !restrictions.workflowTypes.includes(ctx.workflowType)) {
    const label = ctx.workflowType === 'requirement-validation' ? 'Requirement validation' : 'Regression testing';
    errors.push(`${label} is not allowed on this environment. Change the execution restrictions, or pick another environment.`);
  }
  if (ctx.parallelism !== undefined && ctx.parallelism > restrictions.maxParallelism) {
    errors.push(`Parallelism ${ctx.parallelism} is above this environment's limit of ${restrictions.maxParallelism}.`);
  }
  if (restrictions.prodSafeOnly && ctx.prodSafe === false) {
    errors.push('This environment runs only cases marked prod-safe. Remove the other cases, or turn off that restriction.');
  }
  return errors;
}
