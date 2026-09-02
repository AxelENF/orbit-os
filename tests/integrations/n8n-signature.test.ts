import { createHmac } from "node:crypto";

import { describe, expect, it } from "vitest";

import {
  signN8nPayload,
  stableJson,
  verifyN8nSignature,
} from "@/lib/integrations/n8n-signature";

describe("n8n callback signatures", () => {
  it("canonicalizes nested object keys while preserving array order", () => {
    expect(stableJson({ z: 1, a: { d: true, b: ["second", "first"] } })).toBe(
      '{"a":{"b":["second","first"],"d":true},"z":1}',
    );
  });

  it("signs timestamp plus canonical JSON with SHA-256 HMAC", () => {
    const payload = { event: "copy", nested: { z: 2, a: 1 } };
    const timestamp = "1788282000";
    const secret = "test-secret";
    const expected = `sha256=${createHmac("sha256", secret)
      .update(`${timestamp}.${stableJson(payload)}`)
      .digest("hex")}`;

    expect(signN8nPayload(payload, timestamp, secret)).toBe(expected);
  });

  it("accepts the canonical signature when raw JSON key order differs", () => {
    const timestamp = "1788282000";
    const rawPayload = '{"z":2,"a":{"y":true,"x":"copy"}}';
    const signature = signN8nPayload(
      { a: { x: "copy", y: true }, z: 2 },
      timestamp,
      "test-secret",
    );

    expect(
      verifyN8nSignature(rawPayload, timestamp, signature, "test-secret", {
        nowMs: 1_788_282_000_000,
      }),
    ).toBe(true);
  });

  it("rejects invalid, malformed, and expired signatures", () => {
    const timestamp = "1788282000";
    const signature = signN8nPayload({ event: "copy" }, timestamp, "test-secret");

    expect(
      verifyN8nSignature(
        '{"event":"copy"}',
        timestamp,
        `${signature.slice(0, -1)}0`,
        "test-secret",
        { nowMs: 1_788_282_000_000 },
      ),
    ).toBe(false);
    expect(
      verifyN8nSignature("not-json", timestamp, signature, "test-secret", {
        nowMs: 1_788_282_000_000,
      }),
    ).toBe(false);
    expect(
      verifyN8nSignature(
        '{"event":"copy"}',
        timestamp,
        signature,
        "test-secret",
        { nowMs: 1_788_282_301_000 },
      ),
    ).toBe(false);
  });
});
