import { strict as assert } from "node:assert";
import { test } from "node:test";
import {
  classifyHeygenError,
  classifyHeygenErrorCode,
  consumeHeygenRemediation,
  HEYGEN_NOT_AUTHENTICATED_MESSAGE,
  HEYGEN_NOT_FOUND_MESSAGE,
  HEYGEN_OUTDATED_MESSAGE,
  reportHeygenFailure,
} from "./heygen-cli.mjs";

function captureFailureReport(err, context) {
  const originalError = console.error;
  const stderrCalls = [];
  console.error = (...args) => stderrCalls.push(args);
  try {
    reportHeygenFailure(err, context);
  } finally {
    console.error = originalError;
  }
  return stderrCalls;
}

test("classifies ENOENT-style missing heygen errors with install instructions", () => {
  const message = classifyHeygenError({ code: "ENOENT", message: "spawn heygen ENOENT" });

  assert.equal(message, HEYGEN_NOT_FOUND_MESSAGE);
});

test("classifies auth failures with login instructions", () => {
  const message = classifyHeygenError({ stderr: Buffer.from("Error: not logged in") });

  assert.equal(message, HEYGEN_NOT_AUTHENTICATED_MESSAGE);
});

test("classifies a real 401 as auth, but not a bare 401 substring in prose", () => {
  assert.equal(
    classifyHeygenError({ stderr: Buffer.from("HTTP 401 Unauthorized") }),
    HEYGEN_NOT_AUTHENTICATED_MESSAGE,
  );
  // A request id that merely contains "401" must NOT read as an auth failure.
  const noise = classifyHeygenError({ stderr: Buffer.from("upload failed (request req-401abc)") });
  assert.notEqual(noise, HEYGEN_NOT_AUTHENTICATED_MESSAGE);
});

test("classifies old heygen versions with update instructions", () => {
  const message = classifyHeygenError({
    stderr: Buffer.from("heygen v0.1.5 does not support --headers"),
  });

  assert.equal(message, HEYGEN_OUTDATED_MESSAGE);
});

test("does not misclassify a resource 'not found' error as a missing CLI", () => {
  // A stale voiceId makes `heygen voice speech create` fail with "voice not
  // found"; the error message embeds the `heygen ...` command line. This must
  // pass through as detail, not send the user to reinstall a working CLI.
  const message = classifyHeygenError({
    stderr: Buffer.from("Error: voice not found (id: stale-123)"),
    message: "Command failed: heygen voice speech create --voice stale-123",
  });

  assert.notEqual(message, HEYGEN_NOT_FOUND_MESSAGE);
  assert.equal(message, "Error: voice not found (id: stale-123)");
});

test("classifies a shell 'command not found' as a missing CLI", () => {
  const message = classifyHeygenError({ stderr: Buffer.from("bash: heygen: command not found") });

  assert.equal(message, HEYGEN_NOT_FOUND_MESSAGE);
});

test("passes through unrelated errors", () => {
  const message = classifyHeygenError({
    stderr: Buffer.from("rate limit exceeded"),
    message: "Command failed",
  });

  assert.equal(message, "rate limit exceeded");
});

test("classifies existing HeyGen failures with stable reason codes", () => {
  assert.equal(classifyHeygenErrorCode({ code: "ENOENT" }), "not_found");
  assert.equal(
    classifyHeygenErrorCode({ stderr: Buffer.from("HTTP 401 Unauthorized") }),
    "not_authenticated",
  );
  assert.equal(
    classifyHeygenErrorCode({ stderr: Buffer.from("heygen v0.1.5 is unsupported") }),
    "outdated",
  );
  assert.equal(classifyHeygenErrorCode({ stderr: Buffer.from("provider unavailable") }), "other");
});

test("classifies rate-limit text case-insensitively", () => {
  assert.equal(
    classifyHeygenErrorCode({ stderr: Buffer.from("RATE LIMIT exceeded") }),
    "rate_limited",
  );
});

test("classifies quota and insufficient-credit errors as rate limited", () => {
  for (const detail of ["Quota exhausted", "INSUFFICIENT CREDIT remaining"]) {
    assert.equal(classifyHeygenErrorCode({ stderr: Buffer.from(detail) }), "rate_limited");
  }
});

test("classifies the literal 429 reason phrase and throttling language as rate limited", () => {
  for (const detail of ["Too Many Requests", "Error: throttled by upstream, retry later"]) {
    assert.equal(classifyHeygenErrorCode({ stderr: Buffer.from(detail) }), "rate_limited");
  }
});

test("does not misclassify unrelated errors that share a word with the new phrasing", () => {
  // Shares "too many" with "too many requests" but is a distinct failure (fd
  // exhaustion, not a rate limit) — the match must require the full phrase.
  assert.equal(
    classifyHeygenErrorCode({ stderr: Buffer.from("Too many open file descriptors") }),
    "other",
  );
});

test("classifies a bare 429 as rate limited without matching request IDs", () => {
  assert.equal(
    classifyHeygenErrorCode({ stderr: Buffer.from("HTTP 429 Too Many Requests") }),
    "rate_limited",
  );
  assert.equal(
    classifyHeygenErrorCode({ stderr: Buffer.from("request req-429abc failed") }),
    "other",
  );
});

test("reports not-found failures with actionable output", () => {
  const stderrCalls = captureFailureReport({ code: "ENOENT" }, "heygen asset search");

  assert.deepEqual(stderrCalls, [[HEYGEN_NOT_FOUND_MESSAGE]]);
});

test("records missing and outdated CLI remediation once", () => {
  consumeHeygenRemediation();
  captureFailureReport({ code: "ENOENT" }, "heygen audio sounds list");
  assert.deepEqual(consumeHeygenRemediation(), {
    code: "not_found",
    message: HEYGEN_NOT_FOUND_MESSAGE,
  });
  assert.equal(consumeHeygenRemediation(), null);

  captureFailureReport(
    { stderr: Buffer.from("heygen v0.1.5 does not support --headers") },
    "heygen audio sounds list",
  );
  assert.deepEqual(consumeHeygenRemediation(), {
    code: "outdated",
    message: HEYGEN_OUTDATED_MESSAGE,
  });
  assert.equal(consumeHeygenRemediation(), null);
});

test("does not record non-install remediation", () => {
  consumeHeygenRemediation();
  for (const error of [
    { stderr: Buffer.from("HTTP 401 Unauthorized") },
    { stderr: Buffer.from("quota exhausted") },
    { stderr: Buffer.from("provider unavailable") },
  ]) {
    captureFailureReport(error, "heygen audio sounds list");
    assert.equal(consumeHeygenRemediation(), null);
  }
});

test("reports generic failures without including raw detail", () => {
  const stderrCalls = captureFailureReport(
    { stderr: Buffer.from("private provider detail") },
    "heygen asset search",
  );

  assert.deepEqual(stderrCalls, [
    ["media-use: `heygen asset search` failed: private provider detail"],
  ]);
});
