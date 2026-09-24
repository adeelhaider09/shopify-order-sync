import { describe, expect, it } from "vitest";
import { signShopifyBody, verifyShopifyHmac } from "../src/hmac.js";

const secret = "shpss_test_secret";
const body = Buffer.from('{"id":1,"name":"#1001"}');

describe("verifyShopifyHmac", () => {
  it("accepts a correctly signed body", () => {
    expect(verifyShopifyHmac(body, signShopifyBody(body, secret), secret)).toBe(true);
  });

  it("rejects a body that was modified after signing", () => {
    const signature = signShopifyBody(body, secret);
    const tampered = Buffer.from('{"id":1,"name":"#1002"}');
    expect(verifyShopifyHmac(tampered, signature, secret)).toBe(false);
  });

  it("rejects a signature made with a different secret", () => {
    expect(verifyShopifyHmac(body, signShopifyBody(body, "other"), secret)).toBe(false);
  });

  it("rejects missing or malformed headers without throwing", () => {
    expect(verifyShopifyHmac(body, undefined, secret)).toBe(false);
    expect(verifyShopifyHmac(body, "", secret)).toBe(false);
    expect(verifyShopifyHmac(body, "short", secret)).toBe(false);
  });

  it("is sensitive to whitespace, so the raw body must be used", () => {
    const signature = signShopifyBody(body, secret);
    const reserialised = Buffer.from(JSON.stringify(JSON.parse(body.toString()), null, 2));
    expect(verifyShopifyHmac(reserialised, signature, secret)).toBe(false);
  });
});
