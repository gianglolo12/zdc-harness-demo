import { describe, it, expect } from "vitest"
import { createHmac } from "node:crypto"
import { verifyToken, verifyGithubSignature } from "./verify-signature"

describe("verifyToken", () => {
  it("đúng secret → true", () => expect(verifyToken("s3cret", "s3cret")).toBe(true))
  it("sai → false", () => expect(verifyToken("x", "s3cret")).toBe(false))
  it("rỗng → false", () => expect(verifyToken("", "s3cret")).toBe(false))
  it("multibyte header with same char-length but different byte-length → false (no throw)", () => {
    // "é" is 1 char but 2 bytes in UTF-8; "a" is 1 char and 1 byte.
    // With the old string-length guard these had equal .length (1===1) and
    // timingSafeEqual would throw. Now we compare Buffer byte lengths first.
    expect(() => verifyToken("é", "a")).not.toThrow()
    expect(verifyToken("é", "a")).toBe(false)
  })
  it("multibyte token that matches secret → true", () => {
    expect(verifyToken("café", "café")).toBe(true)
  })
})

describe("verifyGithubSignature", () => {
  const secret = "my-webhook-secret"
  const body = '{"action":"opened"}'

  function makeSignature(b: string, s: string): string {
    return "sha256=" + createHmac("sha256", s).update(b).digest("hex")
  }

  it("correct signature → true", () => {
    expect(verifyGithubSignature(body, makeSignature(body, secret), secret)).toBe(true)
  })

  it("wrong secret → false", () => {
    expect(verifyGithubSignature(body, makeSignature(body, "wrong-secret"), secret)).toBe(false)
  })

  it("tampered body → false", () => {
    const sig = makeSignature(body, secret)
    expect(verifyGithubSignature('{"action":"closed"}', sig, secret)).toBe(false)
  })

  it("missing sha256= prefix → false", () => {
    const bare = createHmac("sha256", secret).update(body).digest("hex")
    expect(verifyGithubSignature(body, bare, secret)).toBe(false)
  })

  it("empty header → false", () => {
    expect(verifyGithubSignature(body, "", secret)).toBe(false)
  })

  it("malformed header (sha1= prefix) → false", () => {
    expect(verifyGithubSignature(body, "sha1=abc123", secret)).toBe(false)
  })
})
