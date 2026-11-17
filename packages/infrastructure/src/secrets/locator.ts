import { PlatformError } from '@qa/domain';

const LOCATOR = /^[A-Za-z0-9][A-Za-z0-9/_-]{0,200}$/;

export function assertLocator(locator: string): void {
  if (!LOCATOR.test(locator) || locator.includes('..') || locator.includes('//') || locator.endsWith('/')) {
    throw new PlatformError('validation', 'invalid secret locator');
  }
}
