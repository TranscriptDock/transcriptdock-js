// Contract checks against the shared loopback fixture. Run through `.ci/check.py` after a build.
// Imports the package by name so the ESM branch of the `exports` map is exercised.
import { isDeepStrictEqual } from "node:util";
import { TranscriptDock, ApiError, JobTimeoutError } from "transcriptdock";

function check(value, message) {
  if (!value) throw new Error(message);
}

async function raises(type, fn) {
  try {
    await fn();
  } catch (error) {
    if (error instanceof type) return error;
    throw error;
  }
  throw new Error(`Expected ${type.name}`);
}

const base = process.env.TRANSCRIPTDOCK_TEST_BASE_URL;
check(base, "TRANSCRIPTDOCK_TEST_BASE_URL is not set");
const client = new TranscriptDock("td_live_fixture_only", { baseUrl: base });
const body = { source: { url: "https://example.com/video" }, mode: "captions_only", max_credits: 1 };
for (let i = 0; i < 2; i++) {
  const out = await client.createJob(body, { idempotencyKey: "fixture-replay-01" });
  check(out.future_field === 42, "future response field lost");
  check(isDeepStrictEqual(out.request.body, body), "request body changed");
  check(out.request.idempotency_key === "fixture-replay-01" && out.request.authorized, "headers changed");
}
let out = await client.request("GET", "/v1/jobs", { query: { cursor: "a/b?c&d", limit: 7 } });
check(isDeepStrictEqual(out.request.query.cursor, ["a/b?c&d"]), "cursor encoding changed");
check((await client.getJob("id/other?x")).request.path.endsWith("id%2Fother%3Fx"), "ID path encoding changed");
check((await client.getTranscript("fixture")).words[0].start_ms === 123, "timing unit changed");
const exported = await client.exportTranscript("fixture", "srt");
check(exported.includes("fixture"), "export lost");
check(exported.includes("Café"), "export text not decoded as UTF-8");
for (const s of ["succeeded", "failed", "cancelled"]) {
  check((await client.waitForJob(s)).status === s, "terminal status lost");
}
let err = await raises(JobTimeoutError, () => client.waitForJob("processing", { timeout: 0.15, pollInterval: 1 }));
check(err.job.status === "processing", "timeout lost last job");
err = await raises(ApiError, () => client.request("GET", "/v1/rate-limit"));
check(err.status === 429 && err.retryable && err.retryAfterSeconds === 4 && err.requestId === "fixture-request", "API error fields lost");
check(!err.message.includes("td_live_fixture_only"), "key in error");
check((await raises(ApiError, () => client.request("GET", "/v1/redirect"))).status === 302, "redirect followed");
for (const p of ["gateway", "error-shape", "malformed", "array"]) {
  err = await raises(ApiError, () => client.request("GET", `/v1/${p}`));
  check(!err.message.includes("<html>"), "raw gateway page in error");
}
for (const path of ["/v1/batches", "/v1/video-discoveries", "/v1/language-discoveries"]) {
  await raises(TypeError, () => client.request("POST", path, { body: {} }));
  out = await client.request("POST", path, { body: { fixture: true }, idempotencyKey: "fixture-generic-01" });
  check(out.request.method === "POST", "generic submission failed");
}
check((await client.request("DELETE", "/v1/transcripts/fixture")).request.method === "DELETE", "delete dispatch failed");
for (const url of ["http://example.com", "https://user:pass@example.com", "https://example.com/path", "https://example.com?x=1"]) {
  await raises(TypeError, () => new TranscriptDock("fixture-key", { baseUrl: url }));
}
await raises(TypeError, () => new TranscriptDock("bad\nkey"));
await raises(TypeError, () => client.createJob({}, { idempotencyKey: "bad\nreplay" }));
await raises(TypeError, () => client.request("GET", "/v1/../secret"));
await raises(TypeError, () => client.waitForJob("fixture", { timeout: NaN }));
err = await raises(ApiError, () => client.request("GET", "/v1/slow", { timeout: 0.03 }));
check(err.code === "NETWORK_ERROR", "transport timeout not handled");
await raises(TypeError, () => client.request("post", "/v1/jobs", { body: {} }));
await raises(TypeError, () => client.request("GET", "/v1/%2e%2e/secret"));
const rejections = { budget: [402, "BUDGET_EXCEEDED"], conflict: [409, "IDEMPOTENCY_CONFLICT"], "jobs/not-owned": [404, "NOT_FOUND"] };
for (const [path, [status, code]] of Object.entries(rejections)) {
  err = await raises(ApiError, () => client.request("GET", `/v1/${path}`));
  check(err.status === status && err.code === code && !err.retryable, "budget, replay conflict or inaccessible job error lost");
}

console.log("JavaScript client checks passed");
