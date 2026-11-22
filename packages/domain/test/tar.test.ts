import { describe, expect, it } from 'vitest';
import { tarUtf8File } from '../src';

describe('tarUtf8File', () => {
  it('builds a ustar archive Docker can unpack', () => {
    const tar = tarUtf8File('qa-cases.json', '[{"id":"a"}]');
    expect(tar.length % 512).toBe(0);
    expect(tar.subarray(0, 11).toString('utf8')).toBe('qa-cases.js');
    expect(tar.includes(Buffer.from('[{"id":"a"}]', 'utf8'))).toBe(true);
  });
});
