import { describe, it, expect } from "vitest"
import { verifyToken } from "./verify-signature"

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
