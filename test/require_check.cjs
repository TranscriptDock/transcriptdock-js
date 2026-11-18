// CommonJS smoke check: loads the package by name through the `require` branch of `exports`.
// Makes no network requests.
const assert = require("node:assert/strict");
const { TranscriptDock, ApiError, JobTimeoutError, VERSION } = require("transcriptdock");
const { version } = require("transcriptdock/package.json");

assert.equal(VERSION, version);
assert.equal(typeof TranscriptDock, "function");
assert.ok(new ApiError("X", "y") instanceof Error);
assert.equal(new JobTimeoutError(null).job, null);
assert.equal(new TranscriptDock("fixture-key").timeout, 30);
assert.throws(() => new TranscriptDock("fixture-key", { baseUrl: "http://example.com" }), TypeError);
assert.throws(() => new TranscriptDock("fixture-key", { timeout: 0 }), TypeError);
console.log("CommonJS entry point checks passed");
