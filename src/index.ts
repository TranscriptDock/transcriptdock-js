/** Transcript Dock public API client. No runtime dependencies. */

export const VERSION = "0.1.0";

const DEFAULT_ORIGIN = "https://www.transcriptdock.com";
const METHODS = ["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"];
const KEYED_POSTS = ["/v1/jobs", "/v1/batches", "/v1/video-discoveries", "/v1/language-discoveries"];
const TERMINAL = ["succeeded", "failed", "cancelled"];
const MAX_TIMER_MS = 2_147_483_647;

/** A JSON object as returned by the API. Unknown fields are kept. */
export interface JsonObject {
  [key: string]: unknown;
}

/** Common job fields. Every other field the API returns is kept. */
export interface Job extends JsonObject {
  id: string;
  status: "queued" | "processing" | "awaiting_provider" | "succeeded" | "failed" | "cancelled" | (string & {});
  result_id: string | null;
  error: JsonObject | null;
}

export type HttpMethod = "GET" | "POST" | "PUT" | "PATCH" | "DELETE" | "HEAD" | "OPTIONS";
export type ExportFormat = "json" | "txt" | "srt" | "vtt";
export type QueryValue = string | number | boolean | null | undefined;

export interface ClientOptions {
  /** API origin. HTTPS, or HTTP on loopback for local development. */
  baseUrl?: string;
  /** Default per request timeout in seconds. */
  timeout?: number;
}

export interface RequestOptions {
  body?: unknown;
  query?: Record<string, QueryValue>;
  idempotencyKey?: string;
  /** Return the raw response text instead of a parsed JSON object. */
  text?: boolean;
  /** Timeout for this request in seconds. */
  timeout?: number;
}

/** An API or transport failure. Requests are never automatically retried. */
export class ApiError extends Error {
  readonly code: string;
  /** HTTP status, 0 for an opaque redirect, or null when no response arrived. */
  readonly status: number | null;
  readonly retryable: boolean;
  readonly requestId: string | null;
  readonly retryAfterSeconds: number | null;

  constructor(
    code: string,
    message: string,
    options: { status?: number | null; retryable?: boolean; requestId?: string | null; retryAfterSeconds?: number | null } = {},
  ) {
    super(message);
    this.name = "ApiError";
    this.code = code;
    this.status = options.status ?? null;
    this.retryable = options.retryable ?? false;
    this.requestId = options.requestId ?? null;
    this.retryAfterSeconds = options.retryAfterSeconds ?? null;
  }
}

/** Polling expired. `job` holds the last observed response, or null if no poll completed. */
export class JobTimeoutError extends Error {
  readonly job: Job | null;

  constructor(job: Job | null) {
    super("The job is still running. Check it again using its ID.");
    this.name = "JobTimeoutError";
    this.job = job;
  }
}

function positive(value: unknown, name: string): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    throw new TypeError(`${name} must be a finite positive number.`);
  }
  return value;
}

function encodeId(value: unknown): string {
  if (typeof value !== "string" || value === "" || value === "." || value === "..") {
    throw new TypeError("Provide a nonempty ID.");
  }
  try {
    return encodeURIComponent(value).replace(/[!'()*]/g, (c) => "%" + c.charCodeAt(0).toString(16).toUpperCase());
  } catch {
    throw new TypeError("Provide a nonempty ID.");
  }
}

/** Decode percent escapes leniently, like Python's urllib.parse.unquote. */
function unquote(value: string): string {
  return value.replace(/(?:%[0-9A-Fa-f]{2})+/g, (run) => {
    const bytes = new Uint8Array(run.length / 3);
    for (let i = 0; i < bytes.length; i++) bytes[i] = parseInt(run.slice(i * 3 + 1, i * 3 + 3), 16);
    return new TextDecoder().decode(bytes);
  });
}

function isLoopback(hostname: string): boolean {
  return hostname === "localhost" || hostname === "[::1]" || /^127\.\d+\.\d+\.\d+$/.test(hostname);
}

function isObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function sleep(seconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, Math.min(seconds * 1000, MAX_TIMER_MS)));
}

function noNonFinite(_key: string, value: unknown): unknown {
  if (typeof value === "number" && !Number.isFinite(value)) {
    throw new TypeError("Request bodies cannot contain NaN or Infinity.");
  }
  return value;
}

/** Transcript Dock API client. Responses keep every field returned by the API. */
export class TranscriptDock {
  readonly timeout: number;
  readonly #origin: string;
  readonly #apiKey: string;

  constructor(apiKey: string, options: ClientOptions = {}) {
    if (typeof apiKey !== "string" || !/^[\x21-\x7e]+$/.test(apiKey)) {
      throw new TypeError("Provide an API key without whitespace or control characters.");
    }
    const baseUrl = options.baseUrl ?? DEFAULT_ORIGIN;
    let origin: URL;
    try {
      origin = new URL(baseUrl);
    } catch {
      throw new TypeError("Provide a valid API origin.");
    }
    const secure = origin.protocol === "https:" || (origin.protocol === "http:" && isLoopback(origin.hostname));
    if (!secure || !origin.hostname) {
      throw new TypeError("Use an HTTPS origin, or HTTP on loopback for local development.");
    }
    if (origin.username || origin.password || origin.search || origin.hash || origin.pathname !== "/" || /[?#]/.test(baseUrl)) {
      throw new TypeError("The API origin cannot contain credentials, a path, query or fragment.");
    }
    this.#origin = origin.origin;
    this.#apiKey = apiKey;
    this.timeout = positive(options.timeout ?? 30, "timeout");
  }

  #redact(value: unknown): string {
    return String(value)
      .split(this.#apiKey)
      .join("[REDACTED]")
      .replace(/td_live_[A-Za-z0-9_-]+|Bearer\s+\S+/gi, "[REDACTED]");
  }

  /** Call a public /v1 endpoint. Redirects are not followed and nothing is retried automatically. */
  request(method: HttpMethod, path: string, options: RequestOptions & { text: true }): Promise<string>;
  request<T extends JsonObject = JsonObject>(method: HttpMethod, path: string, options?: RequestOptions & { text?: false }): Promise<T>;
  async request(method: string, path: string, options: RequestOptions = {}): Promise<JsonObject | string> {
    if (typeof method !== "string" || !METHODS.includes(method)) {
      throw new TypeError("Provide a supported HTTP method in uppercase.");
    }
    if (typeof path !== "string" || !path.startsWith("/v1/") || /[?#\\\x00-\x20\x7f]/.test(path)) {
      throw new TypeError("Use a /v1/ path and pass query parameters separately.");
    }
    if (unquote(path).split("/").some((part) => part === "." || part === "..")) {
      throw new TypeError("API paths cannot contain traversal segments.");
    }
    const { body, query, idempotencyKey, text = false } = options;
    const timeout = options.timeout === undefined ? this.timeout : positive(options.timeout, "timeout");
    const needsKey = method === "POST" && (KEYED_POSTS.includes(path) || path.endsWith("/retry"));
    if (needsKey && idempotencyKey == null) {
      throw new TypeError("Provide an idempotency key for this submission.");
    }
    const headers: Record<string, string> = {
      Authorization: `Bearer ${this.#apiKey}`,
      Accept: "application/json",
      "User-Agent": `transcriptdock-js/${VERSION}`,
    };
    if (idempotencyKey != null) {
      if (typeof idempotencyKey !== "string" || !/^[ -~]{8,128}$/.test(idempotencyKey)) {
        throw new TypeError("Idempotency keys must contain 8 to 128 printable ASCII characters.");
      }
      headers["Idempotency-Key"] = idempotencyKey;
    }
    let data: string | undefined;
    if (body != null) {
      if (method === "GET" || method === "HEAD") throw new TypeError("GET and HEAD requests cannot have a body.");
      data = JSON.stringify(body, noNonFinite);
      headers["Content-Type"] = "application/json";
    }
    let url = this.#origin + path;
    if (query) {
      const params = new URLSearchParams();
      for (const [key, value] of Object.entries(query)) {
        if (value != null) params.append(key, String(value));
      }
      const encoded = params.toString();
      if (encoded) url += "?" + encoded;
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), Math.min(timeout * 1000, MAX_TIMER_MS));
    let response: Response;
    let bytes: ArrayBuffer;
    try {
      response = await fetch(url, { method, headers, body: data, redirect: "manual", signal: controller.signal });
      bytes = await response.arrayBuffer();
    } catch {
      throw new ApiError("NETWORK_ERROR", "Could not reach the API. Check the job before retrying a submission.", { retryable: true });
    } finally {
      clearTimeout(timer);
    }

    let raw: string | null;
    try {
      raw = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
    } catch {
      raw = null;
    }
    const status = response.type === "opaqueredirect" ? 0 : response.status;
    if (status < 200 || status >= 300) throw this.#apiError(status, raw);
    if (raw === null) throw new ApiError("INVALID_RESPONSE", "The API response is not UTF-8 text.");
    if (text) return raw;
    if (status === 204) return {};
    let result: unknown;
    try {
      result = JSON.parse(raw);
    } catch {
      throw new ApiError("INVALID_RESPONSE", "The API did not return JSON.");
    }
    if (!isObject(result)) throw new ApiError("INVALID_RESPONSE", "The API did not return a JSON object.");
    return result;
  }

  #apiError(status: number, raw: string | null): ApiError {
    let envelope: unknown = {};
    try {
      envelope = raw === null ? {} : JSON.parse(raw);
    } catch {
      envelope = {};
    }
    const outer = isObject(envelope) ? envelope : {};
    const error = isObject(outer.error) ? outer.error : {};
    const code = typeof error.code === "string" && error.code ? error.code : "HTTP_ERROR";
    const message = typeof error.message === "string" && error.message ? error.message : `Request failed with status ${status}.`;
    const retryable = Object.hasOwn(error, "retryable") ? Boolean(error.retryable) : status === 429 || status >= 500;
    const retryAfter = error.retry_after_seconds;
    return new ApiError(this.#redact(code), this.#redact(message), {
      status,
      retryable,
      requestId: outer.request_id ? this.#redact(outer.request_id) : null,
      retryAfterSeconds: typeof retryAfter === "number" && Number.isFinite(retryAfter) ? retryAfter : null,
    });
  }

  capabilities(): Promise<JsonObject> {
    return this.request("GET", "/v1/capabilities");
  }

  createJob(body: JsonObject, options: { idempotencyKey: string }): Promise<Job> {
    return this.request<Job>("POST", "/v1/jobs", { body, idempotencyKey: options?.idempotencyKey });
  }

  async getJob(jobId: string, options: { wait?: number } = {}): Promise<Job> {
    return this.request<Job>("GET", `/v1/jobs/${encodeId(jobId)}`, { query: { wait: options.wait ?? 0 } });
  }

  listJobs(options: { limit?: number; cursor?: string | null } = {}): Promise<JsonObject> {
    return this.request("GET", "/v1/jobs", { query: { limit: options.limit ?? 20, cursor: options.cursor } });
  }

  async cancelJob(jobId: string): Promise<Job> {
    return this.request<Job>("POST", `/v1/jobs/${encodeId(jobId)}/cancel`);
  }

  async retryJob(jobId: string, options: { idempotencyKey: string; maxCredits?: number | null }): Promise<Job> {
    const body = options?.maxCredits == null ? {} : { max_credits: options.maxCredits };
    return this.request<Job>("POST", `/v1/jobs/${encodeId(jobId)}/retry`, { body, idempotencyKey: options?.idempotencyKey });
  }

  async getTranscript(transcriptId: string): Promise<JsonObject> {
    return this.request("GET", `/v1/transcripts/${encodeId(transcriptId)}`);
  }

  /** Returns the export body as text for every format, including json. */
  async exportTranscript(transcriptId: string, format: ExportFormat = "txt"): Promise<string> {
    if (!["json", "txt", "srt", "vtt"].includes(format)) throw new TypeError("Choose json, txt, srt or vtt.");
    return this.request("GET", `/v1/transcripts/${encodeId(transcriptId)}/export`, { query: { format }, text: true });
  }

  async deleteTranscript(transcriptId: string): Promise<JsonObject> {
    return this.request("DELETE", `/v1/transcripts/${encodeId(transcriptId)}`);
  }

  createBatch(body: JsonObject, options: { idempotencyKey: string }): Promise<JsonObject> {
    return this.request("POST", "/v1/batches", { body, idempotencyKey: options?.idempotencyKey });
  }

  async getBatch(batchId: string): Promise<JsonObject> {
    return this.request("GET", `/v1/batches/${encodeId(batchId)}`);
  }

  createVideoDiscovery(body: JsonObject, options: { idempotencyKey: string }): Promise<JsonObject> {
    return this.request("POST", "/v1/video-discoveries", { body, idempotencyKey: options?.idempotencyKey });
  }

  async getVideoDiscovery(discoveryId: string): Promise<JsonObject> {
    return this.request("GET", `/v1/video-discoveries/${encodeId(discoveryId)}`);
  }

  createLanguageDiscovery(body: JsonObject, options: { idempotencyKey: string }): Promise<JsonObject> {
    return this.request("POST", "/v1/language-discoveries", { body, idempotencyKey: options?.idempotencyKey });
  }

  async getLanguageDiscovery(discoveryId: string): Promise<JsonObject> {
    return this.request("GET", `/v1/language-discoveries/${encodeId(discoveryId)}`);
  }

  /** Request an upload slot. Send the file bytes separately, without the API key. */
  createUpload(body: JsonObject): Promise<JsonObject> {
    return this.request("POST", "/v1/uploads", { body });
  }

  async completeUpload(uploadId: string): Promise<JsonObject> {
    return this.request("POST", `/v1/uploads/${encodeId(uploadId)}/complete`);
  }

  usage(): Promise<JsonObject> {
    return this.request("GET", "/v1/usage");
  }

  listWebhookEndpoints(): Promise<JsonObject> {
    return this.request("GET", "/v1/webhook-endpoints");
  }

  createWebhookEndpoint(body: JsonObject): Promise<JsonObject> {
    return this.request("POST", "/v1/webhook-endpoints", { body });
  }

  /** The API answers 204 with no body; this resolves to an empty object. */
  async deleteWebhookEndpoint(endpointId: string): Promise<JsonObject> {
    return this.request("DELETE", `/v1/webhook-endpoints/${encodeId(endpointId)}`);
  }

  /** Resolve with any terminal job. Reject with JobTimeoutError carrying the last job on timeout. */
  async waitForJob(jobId: string, options: { timeout?: number; pollInterval?: number } = {}): Promise<Job> {
    const deadline = performance.now() + positive(options.timeout ?? 120, "timeout") * 1000;
    const pollInterval = positive(options.pollInterval ?? 3, "pollInterval");
    const path = `/v1/jobs/${encodeId(jobId)}`;
    let job: Job | null = null;
    for (;;) {
      let remaining = (deadline - performance.now()) / 1000;
      if (remaining <= 0) throw new JobTimeoutError(job);
      job = await this.request<Job>("GET", path, { timeout: Math.min(this.timeout, remaining) });
      if (TERMINAL.includes(job.status)) return job;
      remaining = (deadline - performance.now()) / 1000;
      if (remaining <= 0) throw new JobTimeoutError(job);
      await sleep(Math.min(pollInterval, remaining));
    }
  }
}
