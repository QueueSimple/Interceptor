import { describe, expect, test } from "bun:test"
import { refuseUntrustedCaller } from "../daemon/caller-guard"

function request(origin?: string): Request {
  const headers = origin === undefined ? {} : { origin }
  return new Request("http://localhost:19222/", { headers })
}

describe("refuseUntrustedCaller", () => {
  test("a local CLI with no Origin is allowed on every loopback spelling", () => {
    for (const address of ["127.0.0.1", "::1", "::ffff:127.0.0.1"]) {
      expect(refuseUntrustedCaller(request(), address)).toBeNull()
    }
  })

  test("a local browser extension is allowed", () => {
    expect(refuseUntrustedCaller(request("chrome-extension://hkjbaciefhhgekldhncknbjkofbpenng"), "127.0.0.1")).toBeNull()
    expect(refuseUntrustedCaller(request("moz-extension://4b8a1c2d-0000-4000-8000-000000000000"), "::1")).toBeNull()
  })

  test("a web page on this machine is refused", () => {
    for (const origin of ["https://example.com", "http://localhost:3000", "null", "file://"]) {
      expect(refuseUntrustedCaller(request(origin), "127.0.0.1")?.status).toBe(403)
    }
  })

  test("an extension-looking origin with a path is refused", () => {
    expect(refuseUntrustedCaller(request("chrome-extension://abc/evil/path"), "127.0.0.1")?.status).toBe(403)
  })

  test("any caller from another machine is refused, even with no Origin", () => {
    for (const address of ["100.113.252.104", "192.168.0.125", "fd7a:115c:a1e0::1", "0.0.0.0"]) {
      expect(refuseUntrustedCaller(request(), address)?.status).toBe(403)
    }
  })

  test("an unknown address fails closed", () => {
    expect(refuseUntrustedCaller(request(), undefined)?.status).toBe(403)
    expect(refuseUntrustedCaller(request(), null)?.status).toBe(403)
  })
})
