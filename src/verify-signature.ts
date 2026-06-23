import { createHmac, timingSafeEqual } from "node:crypto"

const GITHUB_SIG_PREFIX = "sha256="

/**
 * Verify a GitHub webhook signature from the X-Hub-Signature-256 header.
 * Returns false for missing, empty, or malformed headers.
 * Uses constant-time comparison to prevent timing attacks.
 */
export function verifyGithubSignature(
  rawBody: string,
  signatureHeader: string,
  secret: string,
): boolean {
  if (!signatureHeader || !signatureHeader.startsWith(GITHUB_SIG_PREFIX)) return false

  const received = Buffer.from(signatureHeader.slice(GITHUB_SIG_PREFIX.length), "hex")
  const expected = Buffer.from(
    createHmac("sha256", secret).update(rawBody).digest("hex"),
    "hex",
  )

  // Guard length before timingSafeEqual (throws on mismatched lengths)
  if (received.length !== expected.length) return false
  return timingSafeEqual(received, expected)
}

export function verifyToken(headerToken: string, secret: string): boolean {
  if (!headerToken) return false
  const a = Buffer.from(headerToken)
  const b = Buffer.from(secret)
  // Compare byte lengths (not JS char lengths) to handle multibyte characters
  // safely — timingSafeEqual throws if byte lengths differ.
  if (a.length !== b.length) return false
  return timingSafeEqual(a, b)
}
