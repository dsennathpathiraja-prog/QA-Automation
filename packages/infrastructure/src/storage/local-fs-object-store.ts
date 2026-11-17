import { createHash } from 'node:crypto';
import { mkdir, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises';
import { dirname, join, normalize, relative, sep } from 'node:path';
import { PlatformError, type ObjectMeta, type ObjectStore } from '@qa/domain';

const sha = (b: Uint8Array) => createHash('sha256').update(b).digest('hex');

export class LocalFsObjectStore implements ObjectStore {
  readonly kind = 'local-fs';
  constructor(private readonly root: string) {}

  private path(key: string): string {
    if (!key || key.startsWith('/') || key.includes('\0')) throw new PlatformError('validation', 'invalid object key');
    const n = normalize(key);
    if (n.startsWith('..') || n.split(sep).includes('..')) throw new PlatformError('validation', 'invalid object key');
    return join(this.root, n);
  }

  async put(key: string, data: Uint8Array): Promise<ObjectMeta> {
    const p = this.path(key);
    await mkdir(dirname(p), { recursive: true });
    const tmp = `${p}.${process.pid}.${Date.now()}.tmp`;
    await writeFile(tmp, data);
    await rename(tmp, p);
    return { key, size: data.byteLength, sha256: sha(data) };
  }

  async get(key: string): Promise<Uint8Array> {
    try {
      return new Uint8Array(await readFile(this.path(key)));
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'ENOENT') throw new PlatformError('not-found', 'object not found');
      throw e;
    }
  }

  async head(key: string): Promise<ObjectMeta | undefined> {
    try {
      const data = await this.get(key);
      return { key, size: data.byteLength, sha256: sha(data) };
    } catch (e) {
      if (e instanceof PlatformError && e.errorClass === 'not-found') return undefined;
      throw e;
    }
  }

  async delete(key: string): Promise<void> {
    await rm(this.path(key), { force: true });
  }

  async list(prefix: string): Promise<ObjectMeta[]> {
    const out: ObjectMeta[] = [];
    const walk = async (dir: string) => {
      let entries: import('node:fs').Dirent[];
      try {
        entries = await readdir(dir, { withFileTypes: true });
      } catch {
        return;
      }
      for (const e of entries) {
        const full = join(dir, e.name);
        if (e.isDirectory()) await walk(full);
        else if (!e.name.endsWith('.tmp')) {
          const key = relative(this.root, full).split(sep).join('/');
          if (key.startsWith(prefix)) {
            const data = new Uint8Array(await readFile(full));
            out.push({ key, size: (await stat(full)).size, sha256: sha(data) });
          }
        }
      }
    };
    await walk(this.root);
    return out.sort((a, b) => (a.key < b.key ? -1 : 1));
  }
}
