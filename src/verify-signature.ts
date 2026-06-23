import { timingSafeEqual } from "node:crypto"

export function verifyToken(headerToken: string, secret: string): boolean {
  if (!headerToken) return false
  const a = Buffer.from(headerToken)
  const b = Buffer.from(secret)
  // Compare byte lengths (not JS char lengths) to handle multibyte characters
  // safely — timingSafeEqual throws if byte lengths differ.
  if (a.length !== b.length) return false
  return timingSafeEqual(a, b)
}
