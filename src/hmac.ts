import { createHmac, timingSafeEqual } from "node:crypto";

/**
 * Shopify signs the raw request body with the app's client secret and sends the
 * base64 digest in X-Shopify-Hmac-Sha256. The body must be the exact bytes
 * received; re-serialising parsed JSON would change the digest.
 */
export function verifyShopifyHmac(rawBody: Buffer, header: string | undefined, secret: string): boolean {
  if (!header) return false;

  const expected = createHmac("sha256", secret).update(rawBody).digest();
  const received = Buffer.from(header, "base64");

  // timingSafeEqual throws on length mismatch, and a length check leaks nothing useful.
  return received.length === expected.length && timingSafeEqual(received, expected);
}

export function signShopifyBody(rawBody: string | Buffer, secret: string): string {
  return createHmac("sha256", secret).update(rawBody).digest("base64");
}

export function safeEqualStrings(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}
