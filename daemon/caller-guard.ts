// daemon/caller-guard.ts — who may talk to the daemon's WebSocket/HTTP server.
//
// Local patch (2026-09-17). startWsServer() binds every interface and used to upgrade any
// connection with no address, Origin or token check, so any device on the same wifi or
// tailnet could open a session and drive the logged-in browser. A web page open in the
// browser could also dial ws://localhost:19222, because WebSockets are not bound by the
// same-origin policy. The bind stays as it is (the CLI and the extension dial "localhost",
// which resolves to ::1 first on some hosts), and every request is judged here instead.
//
// Known cost: the iOS InterceptorRunner dials back from the phone's own address, so it is
// refused too. That feature is macOS + iOS only.

const LOOPBACK_ADDRESSES = new Set(["127.0.0.1", "::1", "::ffff:127.0.0.1"])

// Browser extensions send their own scheme. Web pages send http(s), and sandboxed or file
// pages send the literal string "null"; all of those are refused.
const EXTENSION_ORIGIN = /^(chrome-extension|moz-extension|safari-web-extension):\/\/[^/]+\/?$/

export function refuseUntrustedCaller(req: Request, address: string | null | undefined): Response | null {
  if (!address || !LOOPBACK_ADDRESSES.has(address)) {
    return new Response("forbidden: the interceptor daemon accepts callers on this machine only\n", { status: 403 })
  }
  const origin = req.headers.get("origin")
  if (origin !== null && !EXTENSION_ORIGIN.test(origin)) {
    return new Response("forbidden: web pages may not reach the interceptor daemon\n", { status: 403 })
  }
  return null
}
