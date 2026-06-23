import { describe, it, expect } from "vitest"
import { verifyToken } from "./verify-signature"

describe("verifyToken", () => {
  it("đúng secret → true", () => expect(verifyToken("s3cret", "s3cret")).toBe(true))
  it("sai → false", () => expect(verifyToken("x", "s3cret")).toBe(false))
  it("rỗng → false", () => expect(verifyToken("", "s3cret")).toBe(false))
})
