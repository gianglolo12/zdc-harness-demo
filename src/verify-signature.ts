import { timingSafeEqual } from "node:crypto"

export function verifyToken(headerToken: string, secret: string): boolean {
  if (!headerToken || headerToken.length !== secret.length) return false
  return timingSafeEqual(Buffer.from(headerToken), Buffer.from(secret))
}
