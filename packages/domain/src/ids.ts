/** UUIDv7: 48-bit unix-ms timestamp prefix keeps primary keys roughly time-ordered for index locality. */
export function uuidv7(nowMs: number = Date.now(), random: (n: number) => Uint8Array = (n) => globalThis.crypto.getRandomValues(new Uint8Array(n))): string {
  const b = new Uint8Array(16);
  let t = BigInt(nowMs);
  for (let i = 5; i >= 0; i -= 1) {
    b[i] = Number(t & 0xffn);
    t >>= 8n;
  }
  b.set(random(10), 6);
  b[6] = (b[6]! & 0x0f) | 0x70;
  b[8] = (b[8]! & 0x3f) | 0x80;
  const h = Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}
