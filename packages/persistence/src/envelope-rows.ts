import { eq } from 'drizzle-orm';
import type { Db } from './db';
import { secretEnvelope } from './schema';

export interface EnvelopeRowData {
  locator: string;
  version: number;
  wrappedDek: string;
  dekIv: string;
  dekTag: string;
  iv: string;
  tag: string;
  ciphertext: string;
}

/** Structurally matches the infrastructure `EnvelopeRowStore`; persistence does not import infrastructure. */
export class PgEnvelopeRows {
  constructor(private readonly db: Db) {}

  async get(locator: string): Promise<EnvelopeRowData | undefined> {
    const [r] = await this.db.select().from(secretEnvelope).where(eq(secretEnvelope.locator, locator)).limit(1);
    if (!r) return undefined;
    const { updatedAt: _u, ...row } = r;
    return row;
  }

  async put(row: EnvelopeRowData): Promise<void> {
    await this.db.insert(secretEnvelope).values(row).onConflictDoUpdate({ target: secretEnvelope.locator, set: { ...row, updatedAt: new Date() } });
  }

  async delete(locator: string): Promise<void> {
    await this.db.delete(secretEnvelope).where(eq(secretEnvelope.locator, locator));
  }
}
