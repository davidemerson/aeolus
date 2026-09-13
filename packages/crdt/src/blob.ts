import { Readable } from 'node:stream';

import {
  DeleteObjectCommand,
  GetObjectCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  S3Client,
  type S3ClientConfig,
} from '@aws-sdk/client-s3';

export interface BlobObject {
  // node Readable so route handlers can `reply.send(stream)`.
  body: Readable;
  contentLength: number | null;
}

export interface BlobListing {
  key: string;
  size: number;
}

export interface BlobStore {
  put(key: string, body: Buffer): Promise<void>;
  get(key: string): Promise<Buffer | null>;
  // Streaming variant for download routes that pipe straight back
  // to the client. Buffered get() is still available for callers
  // that genuinely need the bytes (Yjs apply, asset materialise).
  getStream(key: string): Promise<BlobObject | null>;
  delete(key: string): Promise<void>;
  // Enumerate every object the store knows about (optionally
  // scoped to a key prefix). Used by the GC sweep to find blobs
  // not referenced by any DB row. Paginates internally.
  list(prefix?: string): Promise<BlobListing[]>;
}

export class MemoryBlobStore implements BlobStore {
  private readonly objects = new Map<string, Buffer>();

  async put(key: string, body: Buffer): Promise<void> {
    this.objects.set(key, Buffer.from(body));
  }

  async get(key: string): Promise<Buffer | null> {
    const value = this.objects.get(key);
    return value ? Buffer.from(value) : null;
  }

  async getStream(key: string): Promise<BlobObject | null> {
    const value = this.objects.get(key);
    if (!value) return null;
    return {
      body: Readable.from(Buffer.from(value)),
      contentLength: value.byteLength,
    };
  }

  async delete(key: string): Promise<void> {
    this.objects.delete(key);
  }

  async list(prefix?: string): Promise<BlobListing[]> {
    const out: BlobListing[] = [];
    for (const [key, value] of this.objects) {
      if (prefix && !key.startsWith(prefix)) continue;
      out.push({ key, size: value.byteLength });
    }
    return out;
  }

  size(): number {
    return this.objects.size;
  }
}

export interface S3BlobStoreOptions {
  bucket: string;
  client?: S3Client;
  clientConfig?: S3ClientConfig;
}

export class S3BlobStore implements BlobStore {
  private readonly client: S3Client;
  private readonly bucket: string;

  constructor(options: S3BlobStoreOptions) {
    this.client = options.client ?? new S3Client(options.clientConfig ?? {});
    this.bucket = options.bucket;
  }

  async put(key: string, body: Buffer): Promise<void> {
    await this.client.send(new PutObjectCommand({ Bucket: this.bucket, Key: key, Body: body }));
  }

  async get(key: string): Promise<Buffer | null> {
    try {
      const res = await this.client.send(new GetObjectCommand({ Bucket: this.bucket, Key: key }));
      if (!res.Body) return null;
      const chunks: Buffer[] = [];
      const stream = res.Body as AsyncIterable<Uint8Array>;
      for await (const chunk of stream) {
        chunks.push(Buffer.from(chunk));
      }
      return Buffer.concat(chunks);
    } catch (err) {
      if (isNotFoundError(err)) return null;
      throw err;
    }
  }

  async getStream(key: string): Promise<BlobObject | null> {
    try {
      const res = await this.client.send(new GetObjectCommand({ Bucket: this.bucket, Key: key }));
      if (!res.Body) return null;
      // S3's SDK body is a node Readable in node runtime, but the
      // typing widens to (Blob & SdkStreamMixin) |
      // (ReadableStream & SdkStreamMixin) | (Readable & SdkStreamMixin).
      // The web ReadableStream isn't an AsyncIterable in TS's type
      // system, so route everything through `transformToWebStream()`
      // when it's not already a node Readable.
      const body =
        res.Body instanceof Readable
          ? res.Body
          : Readable.fromWeb(
              res.Body as unknown as import('node:stream/web').ReadableStream<Uint8Array>,
            );
      return {
        body,
        contentLength: typeof res.ContentLength === 'number' ? res.ContentLength : null,
      };
    } catch (err) {
      if (isNotFoundError(err)) return null;
      throw err;
    }
  }

  async delete(key: string): Promise<void> {
    await this.client.send(new DeleteObjectCommand({ Bucket: this.bucket, Key: key }));
  }

  async list(prefix?: string): Promise<BlobListing[]> {
    const out: BlobListing[] = [];
    let continuationToken: string | undefined;
    // ListObjectsV2 returns at most 1000 keys per call. The GC
    // sweep wants every key under the prefix, so paginate.
    do {
      const res = await this.client.send(
        new ListObjectsV2Command({
          Bucket: this.bucket,
          Prefix: prefix,
          ContinuationToken: continuationToken,
        }),
      );
      for (const obj of res.Contents ?? []) {
        if (obj.Key == null) continue;
        out.push({ key: obj.Key, size: obj.Size ?? 0 });
      }
      continuationToken = res.IsTruncated ? res.NextContinuationToken : undefined;
    } while (continuationToken);
    return out;
  }
}

function isNotFoundError(err: unknown): boolean {
  if (typeof err !== 'object' || err === null) return false;
  const name = (err as { name?: string }).name;
  return name === 'NoSuchKey' || name === 'NotFound';
}

/**
 * The blob store every process builds at boot, from the same four
 * variables (AEOLUS_S3_BUCKET, AWS_REGION, AWS_S3_ENDPOINT,
 * AWS_S3_FORCE_PATH_STYLE). Six launchers and one-shot tools used to
 * spell this block out separately.
 *
 * No bucket → MemoryBlobStore, which is only meaningful for a laptop
 * boot: in production it would silently accept uploads into process
 * memory, so there it is a boot failure (ADR 0024).
 */
/** The S3 client settings every process and one-shot tool derives from the environment. */
export function s3ClientConfigFromEnv(env: NodeJS.ProcessEnv = process.env): S3ClientConfig {
  return {
    region: env.AWS_REGION ?? 'us-east-1',
    endpoint: env.AWS_S3_ENDPOINT,
    forcePathStyle: env.AWS_S3_FORCE_PATH_STYLE === '1',
  };
}

export function blobStoreFromEnv(env: NodeJS.ProcessEnv = process.env): BlobStore {
  const bucket = env.AEOLUS_S3_BUCKET;
  if (!bucket) {
    if (env.NODE_ENV === 'production') {
      throw new Error(
        'AEOLUS_S3_BUCKET is not set. It is required in production; ' +
          'an in-memory blob store would lose every upload on restart.',
      );
    }
    return new MemoryBlobStore();
  }
  return new S3BlobStore({ bucket, clientConfig: s3ClientConfigFromEnv(env) });
}
