/**
 * Minimal ustar writer for Docker's PUT /containers/{id}/archive.
 * One regular file entry + two 512-byte zero blocks.
 */
export function tarUtf8File(pathInArchive: string, content: string): Buffer {
  const name = pathInArchive.replace(/^\//, '');
  if (!name || name.length > 100) throw new Error('tar path must be 1-100 characters without a leading slash');
  const data = Buffer.from(content, 'utf8');
  const header = Buffer.alloc(512, 0);
  header.write(name, 0, 100, 'utf8');
  header.write('0000644\0', 100, 8, 'utf8'); // mode
  header.write('0000000\0', 108, 8, 'utf8'); // uid
  header.write('0000000\0', 116, 8, 'utf8'); // gid
  header.write(`${data.length.toString(8).padStart(11, '0')}\0`, 124, 12, 'utf8'); // size
  header.write(`${Math.floor(Date.now() / 1000).toString(8).padStart(11, '0')}\0`, 136, 12, 'utf8'); // mtime
  header.write('        ', 148, 8, 'utf8'); // checksum placeholder
  header.write('0', 156, 1, 'utf8'); // type: regular file
  header.write('ustar\0', 257, 6, 'utf8');
  header.write('00', 263, 2, 'utf8');
  let sum = 0;
  for (let i = 0; i < 512; i += 1) sum += header[i]!;
  header.write(`${sum.toString(8).padStart(6, '0')}\0 `, 148, 8, 'utf8');
  const pad = (512 - (data.length % 512)) % 512;
  return Buffer.concat([header, data, Buffer.alloc(pad), Buffer.alloc(1024)]);
}
