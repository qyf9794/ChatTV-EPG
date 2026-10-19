import {
  GetObjectCommand,
  ListObjectsV2Command,
  DeleteObjectsCommand,
  PutObjectCommand,
  S3Client
} from "@aws-sdk/client-s3";
import { addAbortSignal, Readable } from "node:stream";
import { finished } from "node:stream/promises";
import { PUBLIC_EPG_PREFIX } from "@vocaltv/public-epg-contract";
import type { ObjectMetadata, RetentionObjectStore } from "./encoding.js";

const DEFAULT_MAX_GET_BYTES = 64 * 1024 * 1024;
// A slow provider must fail this finite run rather than hold the lease forever.
const R2_REQUEST_TIMEOUT_MS = 60_000;
function providerFailure(operation: string, cause: unknown): Error {
  const value = cause as { name?: unknown; $metadata?: { httpStatusCode?: unknown } };
  const name = typeof value?.name === "string" && /^[A-Za-z_]{1,64}$/.test(value.name) ? value.name : "Unknown";
  const code = Number.isInteger(value?.$metadata?.httpStatusCode) ? value.$metadata!.httpStatusCode : 0;
  return new Error(`${operation}:${code}:${name}`);
}


export class R2ObjectStore implements RetentionObjectStore {
  private readonly client: S3Client;
  private readonly bucket: string;
  private readonly requestTimeoutMs: number;

  constructor(options: { accountID: string; accessKeyID: string; secretAccessKey: string; bucket: string; requestTimeoutMs?: number }) {
    if (!/^[a-f0-9]{32}$/iu.test(options.accountID) || !options.bucket.trim()
      || !options.accessKeyID.trim() || !options.secretAccessKey.trim()) {
      throw new Error("r2_configuration_invalid");
    }
    this.bucket = options.bucket;
    this.requestTimeoutMs = options.requestTimeoutMs ?? R2_REQUEST_TIMEOUT_MS;
    if (!Number.isInteger(this.requestTimeoutMs) || this.requestTimeoutMs < 1000 || this.requestTimeoutMs > R2_REQUEST_TIMEOUT_MS) {
      throw new Error("r2_configuration_invalid");
    }
    this.client = new S3Client({
      region: "auto",
      endpoint: `https://${options.accountID}.r2.cloudflarestorage.com`,
      credentials: { accessKeyId: options.accessKeyID, secretAccessKey: options.secretAccessKey },
      // Each counted call is exactly one network attempt. Retry decisions stay
      // with the caller so every attempt remains inside its request/time budget.
      maxAttempts: 1
    });
  }

  private async getObject(key: string, maximumBytes: number): Promise<{ value: Uint8Array; etag: string } | null> {
    const controller = new AbortController();
    // The SDK resolves send() once response headers arrive. Keep the same
    // deadline alive until the response body has also finished or been closed.
    const timeout = setTimeout(() => controller.abort(new DOMException("R2 GET timed out", "TimeoutError")), this.requestTimeoutMs);
    let body: Readable | undefined;
    let bodyFinished: Promise<void> | undefined;
    try {
      let result;
      try {
        result = await this.client.send(new GetObjectCommand({ Bucket: this.bucket, Key: key }), { abortSignal: controller.signal });
      } catch (error) {
        const value = error as { name?: string; $metadata?: { httpStatusCode?: number } };
        if (!controller.signal.aborted && (value.name === "NoSuchKey" || value.name === "NotFound" || value.$metadata?.httpStatusCode === 404)) return null;
        throw error;
      }
      if (result.Body) {
        body = result.Body instanceof Readable ? result.Body
          : Readable.fromWeb(result.Body as Parameters<typeof Readable.fromWeb>[0]);
        // Observe close before aborting, including a response arriving after the
        // deadline. Await this below so no body survives the store operation.
        bodyFinished = finished(body, { cleanup: true }).catch(() => undefined);
        addAbortSignal(controller.signal, body);
      }
      controller.signal.throwIfAborted();
      if (typeof result.ContentLength === "number" && (result.ContentLength < 0 || result.ContentLength > maximumBytes)) {
        throw new Error("r2_object_size_invalid");
      }
      if (!body) return null;
      const chunks: Uint8Array[] = [];
      let total = 0;
      for await (const chunk of body as AsyncIterable<Uint8Array>) {
        total += chunk.byteLength;
        if (total > maximumBytes) throw new Error("r2_object_size_invalid");
        chunks.push(new Uint8Array(chunk));
      }
      controller.signal.throwIfAborted();
      if (typeof result.ContentLength === "number" && total !== result.ContentLength) throw new Error("r2_object_size_invalid");
      if (!result.ETag) throw new Error("r2_etag_missing");
      const value = new Uint8Array(total);
      let offset = 0;
      for (const chunk of chunks) { value.set(chunk, offset); offset += chunk.byteLength; }
      return { value, etag: result.ETag };
    } catch (error) {
      if (error instanceof Error && (error.message === "r2_object_size_invalid" || error.message === "r2_etag_missing")) throw error;
      throw providerFailure("r2_get_failed", controller.signal.aborted ? controller.signal.reason : error);
    } finally {
      clearTimeout(timeout);
      body?.destroy();
      await bodyFinished;
    }
  }

  async get(key: string, maximumBytes = DEFAULT_MAX_GET_BYTES): Promise<Uint8Array | null> {
    return (await this.getObject(key, maximumBytes))?.value ?? null;
  }

  async getWithETag(key: string, maximumBytes = DEFAULT_MAX_GET_BYTES): Promise<{ value: Uint8Array; etag: string } | null> {
    return this.getObject(key, maximumBytes);
  }

  async put(key: string, value: Uint8Array, metadata: ObjectMetadata): Promise<void> {
    try {
      await this.client.send(new PutObjectCommand({
        Bucket: this.bucket,
        Key: key,
        Body: Buffer.from(value),
        ContentLength: value.byteLength,
        ContentType: metadata.contentType,
        ...(metadata.contentEncoding ? { ContentEncoding: metadata.contentEncoding } : {}),
        CacheControl: metadata.cacheControl
      }), { abortSignal: AbortSignal.timeout(this.requestTimeoutMs) });
    } catch (error) {
      throw providerFailure("r2_put_failed", error);
    }
  }

  async putConditional(
    key: string,
    value: Uint8Array,
    metadata: ObjectMetadata,
    condition: { ifMatch: string } | { ifNoneMatch: "*" }
  ): Promise<string> {
    try {
      const result = await this.client.send(new PutObjectCommand({
        Bucket: this.bucket,
        Key: key,
        Body: Buffer.from(value),
        ContentLength: value.byteLength,
        ContentType: metadata.contentType,
        ...(metadata.contentEncoding ? { ContentEncoding: metadata.contentEncoding } : {}),
        CacheControl: metadata.cacheControl,
        ...( "ifMatch" in condition ? { IfMatch: condition.ifMatch } : { IfNoneMatch: "*" })
      }), { abortSignal: AbortSignal.timeout(this.requestTimeoutMs) });
      if (!result.ETag) throw new Error("r2_etag_missing");
      return result.ETag;
    } catch (error) {
      const value = error as { name?: string; $metadata?: { httpStatusCode?: number } };
      if (value.name === "PreconditionFailed" || value.name === "ConditionalRequestConflict"
        || value.$metadata?.httpStatusCode === 412 || value.$metadata?.httpStatusCode === 409) {
        throw new Error("r2_precondition_failed");
      }
      if (error instanceof Error && error.message === "r2_etag_missing") throw error;
      throw providerFailure("r2_put_failed", error);
    }
  }

  close(): void {
    this.client.destroy();
  }

  async list(prefix: string, cursor?: string) {
    if (prefix !== PUBLIC_EPG_PREFIX) throw new Error("retention_namespace_invalid");
    try {
      const result = await this.client.send(new ListObjectsV2Command({ Bucket: this.bucket, Prefix: prefix,
        MaxKeys: 1000, ...(cursor ? { ContinuationToken: cursor } : {}) }), { abortSignal: AbortSignal.timeout(this.requestTimeoutMs) });
      const objects = (result.Contents ?? []).map((item) => {
        if (!item.Key?.startsWith(prefix) || !Number.isSafeInteger(item.Size) || !item.LastModified) throw new Error("retention_listing_invalid");
        return { key: item.Key, bytes: item.Size!, lastModified: item.LastModified.getTime() };
      });
      if (result.IsTruncated && !result.NextContinuationToken) throw new Error("retention_listing_invalid");
      return { objects, ...(result.IsTruncated ? { cursor: result.NextContinuationToken! } : {}) };
    } catch { throw new Error("retention_listing_failed"); }
  }

  async delete(keys: string[]): Promise<void> {
    if (!keys.length || keys.length > 1000 || keys.some((key) => !key.startsWith(PUBLIC_EPG_PREFIX))) throw new Error("retention_namespace_invalid");
    try {
      const result = await this.client.send(new DeleteObjectsCommand({ Bucket: this.bucket,
        Delete: { Objects: keys.map((Key) => ({ Key })), Quiet: true } }), { abortSignal: AbortSignal.timeout(this.requestTimeoutMs) });
      if (result.Errors?.length) throw new Error("retention_delete_failed");
    } catch { throw new Error("retention_delete_failed"); }
  }
}

export function r2StoreFromEnvironment(environment: NodeJS.ProcessEnv = process.env, requestTimeoutMs?: number): R2ObjectStore {
  const accountID = environment.EPG_PUBLISHER_R2_ACCOUNT_ID;
  const accessKeyID = environment.EPG_PUBLISHER_R2_ACCESS_KEY_ID;
  const secretAccessKey = environment.EPG_PUBLISHER_R2_SECRET_ACCESS_KEY;
  const bucket = environment.EPG_PUBLISHER_R2_BUCKET;
  if (!accountID || !accessKeyID || !secretAccessKey || !bucket) throw new Error("r2_configuration_missing");
  return new R2ObjectStore({ accountID, accessKeyID, secretAccessKey, bucket, requestTimeoutMs });
}
