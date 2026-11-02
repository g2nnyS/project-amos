import { once } from 'node:events';
import type { Readable, Writable } from 'node:stream';

const limit = 4_194_304;
const decoder = new TextDecoder('utf-8', { fatal: true });

async function readExact(stream: Readable, bytes: number): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let got = 0;
  while (got < bytes) {
    const chunk = stream.read(bytes - got) as Buffer | null;
    if (chunk) { chunks.push(chunk); got += chunk.length; continue; }
    if (stream.readableEnded) throw new Error('closed');
    await new Promise<void>((resolve, reject) => {
      const finish = (error?: Error) => {
        stream.removeListener('readable', onReadable);
        stream.removeListener('end', onEnd);
        if (error) reject(error); else resolve();
      };
      const onReadable = () => finish();
      const onEnd = () => finish(stream.readableLength ? undefined : new Error('closed'));
      stream.on('readable', onReadable);
      stream.on('end', onEnd);
      if (stream.readableLength) finish();
    });
  }
  return Buffer.concat(chunks, bytes);
}

export async function readFrame(stream: Readable): Promise<unknown> {
  const header = await readExact(stream, 4);
  const size = header.readUInt32BE();
  if (size > limit) throw new Error('limit');
  return JSON.parse(decoder.decode(await readExact(stream, size)));
}

export async function writeFrame(stream: Writable, value: unknown): Promise<void> {
  const body = Buffer.from(JSON.stringify(value));
  if (body.length > limit) throw new Error('limit');
  const header = Buffer.alloc(4);
  header.writeUInt32BE(body.length);
  if (!stream.write(header) || !stream.write(body)) await once(stream, 'drain');
}
