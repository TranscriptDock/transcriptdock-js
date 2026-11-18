# Transcript Dock for JavaScript and TypeScript

A client for the [Transcript Dock API](https://www.transcriptdock.com/docs).
Written in TypeScript with bundled type declarations. No runtime dependencies.
Uses the global `fetch`, so it runs on Node.js 18 or newer, Deno, Bun and
Cloudflare Workers. Ships ES module and CommonJS builds.

Install from npm:

```sh
npm install transcriptdock
```

For local development, run `npm ci` and `npm run build` from this directory.

## Keep your API key on a server

Your API key can spend credits. Never ship it in browser code, a mobile app or
any bundle a user can download. Call the API from your server, a serverless
function or a worker, and expose only the results your users need.

## Submit and read a transcript

Set `TRANSCRIPTDOCK_API_KEY` in your environment. Keep it out of source control.

```ts
import { randomUUID } from "node:crypto";
import { TranscriptDock, JobTimeoutError } from "transcriptdock";

const client = new TranscriptDock(process.env.TRANSCRIPTDOCK_API_KEY!);
console.log(await client.capabilities());

// Generate once per intended operation. Save this key and the returned job ID.
// Reuse the same key and exact body if a submission's response is lost.
const submissionKey = randomUUID();
let job = await client.createJob(
  {
    source: { url: "https://www.youtube.com/watch?v=dQw4w9WgXcQ" },
    mode: "captions_only",
    max_credits: 1,
  },
  { idempotencyKey: submissionKey },
);
try {
  job = await client.waitForJob(job.id, { timeout: 120 });
  if (job.status === "succeeded" && job.result_id) {
    console.log(await client.getTranscript(job.result_id));
    console.log(await client.exportTranscript(job.result_id, "srt"));
  } else {
    console.log(job.status, job.error);
  }
} catch (error) {
  if (!(error instanceof JobTimeoutError)) throw error;
  console.log("Still running", error.job);
}
```

CommonJS works too: `const { TranscriptDock } = require("transcriptdock");`.

Creating a job can spend credits. This example caps the request at one credit
and requests captions only. It does not enable AI fallback. Check capabilities
and your plan before selecting other modes. Never blindly resubmit after a
network failure: check the job ID or replay the same body with the same
idempotency key. The client does not retry requests automatically.

## Supported operations

Every method is async. Responses are plain objects that keep every field the
API returns. Request bodies use the API's exact field names, such as
`max_credits`, and the server validates supported options. See the
[OpenAPI definition](https://www.transcriptdock.com/docs/openapi.yaml) for bodies.

* `capabilities()`, `usage()`
* `createJob(body, { idempotencyKey })`, `getJob(id, { wait: 0 })`,
  `listJobs({ limit: 20, cursor })`, `cancelJob(id)`,
  `retryJob(id, { idempotencyKey, maxCredits })`, `waitForJob(id, { timeout, pollInterval })`
* `getTranscript(id)`, `exportTranscript(id, format = "txt")`, `deleteTranscript(id)`
* `createBatch(body, { idempotencyKey })`, `getBatch(id)`
* `createVideoDiscovery(body, { idempotencyKey })`, `getVideoDiscovery(id)`
* `createLanguageDiscovery(body, { idempotencyKey })`, `getLanguageDiscovery(id)`
* `createUpload(body)`, `completeUpload(id)`
* `listWebhookEndpoints()`, `createWebhookEndpoint(body)`, `deleteWebhookEndpoint(id)`

Timeouts and poll intervals are in seconds. The client accepts
`new TranscriptDock(apiKey, { baseUrl, timeout })`; the default per request
timeout is 30 seconds. `waitForJob` defaults to a 120 second deadline and a 3
second poll interval.

`exportTranscript` returns a string for JSON, TXT, SRT and VTT, preserving the
export response. `getTranscript` keeps raw timing fields without converting
units. `waitForJob` resolves with succeeded, failed or cancelled jobs; check
`status` before using `result_id`. A timeout leaves the job running and rejects
with `JobTimeoutError`, whose `job` holds the last observed response (or `null`
if no poll completed). `deleteWebhookEndpoint` resolves with an empty object
because the API answers with no body.

`createUpload` creates an upload slot only. Send the bytes to the returned
signed upload URL separately, following the API instructions, without sending
your Transcript Dock API key to the storage host. Then call `completeUpload`.
Webhook secrets are sensitive; store them privately and verify callback
signatures in your receiver according to the API documentation.

`request(method, "/v1/...", { body, query, idempotencyKey, text, timeout })`
supports public endpoints added later. Methods must be uppercase. It rejects
absolute URLs, traversal paths and redirects. Submissions to jobs, batches,
discoveries and retries require an idempotency key. Custom API origins must use
HTTPS, except loopback HTTP for local development. The default origin is
`https://www.transcriptdock.com`; the apex domain redirects.

Invalid arguments throw a `TypeError` before any request is sent.

## Errors

```ts
import { ApiError } from "transcriptdock";

try {
  const jobs = await client.listJobs({ limit: 10 });
} catch (error) {
  if (!(error instanceof ApiError)) throw error;
  console.log(error.code, error.status, error.requestId);
  // retryable and retryAfterSeconds describe the API response.
  // Decide whether to retry using the operation's idempotency rules.
}
```

Transport failures and timeouts use `NETWORK_ERROR`; malformed responses use
`INVALID_RESPONSE`. A redirect becomes an `ApiError` with its 3xx status, or
status `0` where the runtime hides the redirect. API messages redact bearer
tokens. Error responses do not expose raw HTML pages.

## Development and release

```sh
npm ci
npm run typecheck
npm run build
python3 .ci/check.py
node test/require_check.cjs
npm pack --dry-run
```

TypeScript is the only development dependency and is pinned in
`package-lock.json`. Runtime dependencies are empty. The contract check runs
against a loopback fixture server and spends no credits.

The package is published by the founder only. The first 0.1.0 release is a
manual `npm publish --access public` from a clean, checked build, because npm
only lets a trusted publisher be added to a package that already exists. After
that, configure the npm trusted publisher and enable two factor authentication.
Never put registry or API credentials in this directory. A local build is not a
release.

The npm trusted publisher uses:

| Field | Value |
| --- | --- |
| Package | `transcriptdock` |
| Publisher | GitHub Actions |
| Organization or user | `TranscriptDock` |
| Repository | `transcriptdock-js` |
| Workflow filename | `release.yml` |
| Environment | `npm` |

Run the GitHub Actions workflow on `main` with `publish` enabled for an
authorized new release. It publishes with provenance. The normal push workflow
checks and packs only.
