// GuestAgent
//
// Guest-agent client used by the host bridge to dispatch verbs INTO a
// running guest. The preferred VZ path requires the guest to expose a
// Virtio socket endpoint on port 3294. We connect via
// `VZVirtioSocketDevice.connect(toPort:completionHandler:)` per
// `apple-developer-docs/Virtualization/VZVirtioSocketDevice.md:25-30`,
// take the resulting `VZVirtioSocketConnection.fileDescriptor`, and
// speak the same length-prefixed JSON framing the host bridge already
// uses (`WireFormat`).
//
// A normal macOS guest TCP listener is not the same as a Virtio socket
// endpoint. TCP is only attempted when a VM spec explicitly configures it.
//
// Wire framing (host ↔ guest):
//   [4 bytes little-endian length][JSON payload]
// Request shape:   {id: uuid, action: {verb: "exec", ...}}
// Response shape:  {id: uuid, result: {success: bool, data?: ..., error?: string}}

import Foundation
import Darwin
#if canImport(Virtualization)
import Virtualization
#endif

/// Fixed vsock port we run the guest agent on. Chosen to avoid the
/// well-known low-numbered range and keep typed-out as `0xCDE` (3294)
/// for memorability. Documented in the design notes E6 evidence row.
public let kInterceptorGuestAgentPort: UInt32 = 3294

// Tiny @unchecked Sendable wrapper so we can hand a `[String: Any]` across
// CheckedContinuation boundaries — same pattern Transport.swift uses
// (Transport.swift:234 UncheckedSendableBox).
public struct GuestAgentDict: @unchecked Sendable {
    public let dict: [String: Any]

    public init(_ dict: [String: Any]) {
        self.dict = dict
    }
}

final class GuestAgentConnectContinuation: @unchecked Sendable {
    private let lock = NSLock()
    private var continuation: CheckedContinuation<Int32, Error>?

    init(_ continuation: CheckedContinuation<Int32, Error>) {
        self.continuation = continuation
    }

    func resume(returning value: Int32) {
        lock.lock()
        let cc = continuation
        continuation = nil
        lock.unlock()
        cc?.resume(returning: value)
    }

    func resume(throwing error: Error) {
        lock.lock()
        let cc = continuation
        continuation = nil
        lock.unlock()
        cc?.resume(throwing: error)
    }
}

public enum GuestAgentError: Error, CustomStringConvertible, Sendable {
    case notConnected(String)
    case framing(String)
    case ioFailure(String)
    case remote(String)
    case timeout(String)

    public var description: String {
        switch self {
        case .notConnected(let m): return "agent.notConnected: \(m)"
        case .framing(let m): return "agent.framing: \(m)"
        case .ioFailure(let m): return "agent.ioFailure: \(m)"
        case .remote(let m): return "agent.remote: \(m)"
        case .timeout(let m): return "agent.timeout: \(m)"
        }
    }
}

/// Protocol every guest-agent client implements. Single in-process actor
/// per VM, owned by VMInstance.
public protocol GuestAgent: Sendable {
    /// Dial the guest agent. Implementation depends on transport (vsock
    /// for Linux + macOS-on-macOS; SSH fallback later).
    func connect(timeout: TimeInterval) async throws

    /// Send one request and wait for its matching response. JSON dict in,
    /// JSON dict out. Returns the `result` envelope.
    func request(_ action: GuestAgentDict, timeout: TimeInterval) async throws -> GuestAgentDict

    /// Close the underlying transport.
    func disconnect() async
}

/// Convenience helpers built atop `request(_:)`.
public extension GuestAgent {
    func control(_ verb: String, params: [String: Any] = [:], timeout: TimeInterval = 30) async throws -> [String: Any] {
        var action = params
        action["verb"] = verb
        let r = try await request(GuestAgentDict(action), timeout: timeout).dict
        let success = r["success"] as? Bool ?? false
        if !success {
            throw GuestAgentError.remote(r["error"] as? String ?? "\(verb) failed")
        }
        return (r["data"] as? [String: Any]) ?? r
    }

    func exec(_ argv: [String], env: [String: String] = [:], workdir: String? = nil, tty: Bool = false, timeout: TimeInterval = 60) async throws -> (exitCode: Int32, stdout: String, stderr: String, durationMs: Int) {
        var action: [String: Any] = ["verb": "exec", "argv": argv, "env": env, "tty": tty, "timeout": timeout]
        if let w = workdir { action["workdir"] = w }
        let responseTimeout = timeout > 0 ? timeout + 5 : timeout
        let r = try await request(GuestAgentDict(action), timeout: responseTimeout).dict
        let success = r["success"] as? Bool ?? false
        if !success {
            throw GuestAgentError.remote(r["error"] as? String ?? "exec failed")
        }
        let data = r["data"] as? [String: Any] ?? [:]
        let exit = (data["exitCode"] as? Int32) ?? Int32((data["exitCode"] as? Int) ?? 0)
        let out = data["stdout"] as? String ?? ""
        let err = data["stderr"] as? String ?? ""
        let durMs = (data["durationMs"] as? Int) ?? 0
        return (exit, out, err, durMs)
    }

    func getIP(timeout: TimeInterval = 10) async throws -> String? {
        let r = try await request(GuestAgentDict(["verb": "get_ip"]), timeout: timeout).dict
        let data = r["data"] as? [String: Any]
        return data?["ipAddress"] as? String
    }

    func screenshot(out: String? = nil, timeout: TimeInterval = 30) async throws -> [String: Any] {
        var params: [String: Any] = [:]
        if let out { params["out"] = out }
        return try await control("screenshot", params: params, timeout: timeout)
    }

    func readAX(maxDepth: Int? = nil, app: String? = nil, timeout: TimeInterval = 30) async throws -> [String: Any] {
        var params: [String: Any] = [:]
        if let maxDepth { params["max_depth"] = maxDepth }
        if let app { params["app"] = app }
        return try await control("read_ax", params: params, timeout: timeout)
    }

    func click(x: Double, y: Double, button: String = "left", timeout: TimeInterval = 10) async throws -> [String: Any] {
        try await control("click", params: ["x": x, "y": y, "button": button], timeout: timeout)
    }

    func typeText(_ text: String, timeout: TimeInterval = 30) async throws -> [String: Any] {
        try await control("type", params: ["text": text], timeout: timeout)
    }

    func keys(_ keys: String, timeout: TimeInterval = 10) async throws -> [String: Any] {
        try await control("keys", params: ["keys": keys], timeout: timeout)
    }

    func mount(tag: String, path: String, timeout: TimeInterval = 30) async throws -> [String: Any] {
        try await control("mount", params: ["tag": tag, "path": path], timeout: timeout)
    }

    func trust(timeout: TimeInterval = 10) async throws -> [String: Any] {
        try await control("trust", timeout: timeout)
    }

    func logs(limit: Int? = nil, timeout: TimeInterval = 10) async throws -> [String: Any] {
        var params: [String: Any] = [:]
        if let limit { params["limit"] = limit }
        return try await control("logs", params: params, timeout: timeout)
    }

    func copyIn(path: String, data: Data, mode: String? = nil, timeout: TimeInterval = 60) async throws -> [String: Any] {
        var params: [String: Any] = ["path": path, "dataBase64": data.base64EncodedString()]
        if let mode { params["mode"] = mode }
        return try await control("cp_in", params: params, timeout: timeout)
    }

    func copyOut(path: String, timeout: TimeInterval = 60) async throws -> [String: Any] {
        try await control("cp_out", params: ["path": path], timeout: timeout)
    }
}

/// Concrete vsock-backed agent. Owns the raw fd from
/// `VZVirtioSocketConnection.fileDescriptor`. State (fd + pending map) is
/// serialized through a dedicated dispatch queue, which is async-safe
/// under Swift 6 strict concurrency where NSLock.lock() is not.
@available(macOS 11.0, *)
private actor GuestAgentRequestLock {
    private var locked = false
    private var waiters: [CheckedContinuation<Void, Never>] = []

    func lock() async {
        if !locked {
            locked = true
            return
        }
        await withCheckedContinuation { continuation in
            waiters.append(continuation)
        }
    }

    func unlock() {
        if waiters.isEmpty {
            locked = false
        } else {
            waiters.removeFirst().resume()
        }
    }
}

@available(macOS 11.0, *)
public final class VsockGuestAgent: GuestAgent, @unchecked Sendable {
    private let socketDevice: VZVirtioSocketDevice
    private let connectQueue: DispatchQueue?
    private let port: UInt32
    private let stateQueue = DispatchQueue(label: "interceptor.bridge.vsockAgent")
    private var fd: Int32 = -1
    private var tcpFallbackHost: String?
    private var retainedConnection: AnyObject?
    private var pending: [String: CheckedContinuation<GuestAgentDict, Error>] = [:]
    private var reader: Task<Void, Never>?
    private let requestLock = GuestAgentRequestLock()

    private func withState<R>(_ body: (inout Int32, inout [String: CheckedContinuation<GuestAgentDict, Error>]) -> R) -> R {
        stateQueue.sync { body(&fd, &pending) }
    }

#if canImport(Virtualization)
    public init(socketDevice: VZVirtioSocketDevice, connectQueue: DispatchQueue? = nil, port: UInt32 = kInterceptorGuestAgentPort, tcpFallbackHost: String? = nil) {
        self.socketDevice = socketDevice
        self.connectQueue = connectQueue
        self.port = port
        self.tcpFallbackHost = tcpFallbackHost
    }
#endif

    public func setTCPFallbackHost(_ host: String?) {
        stateQueue.sync {
            self.tcpFallbackHost = host
        }
    }

    private func tcpFallbackHostSnapshot() -> String? {
        stateQueue.sync {
            tcpFallbackHost
        }
    }

    private func retainConnection(_ connection: AnyObject, fd connectionFd: Int32) {
        stateQueue.sync {
            retainedConnection = connection
            fd = connectionFd
        }
    }

    public func connect(timeout: TimeInterval = 30) async throws {
        let existingFd: Int32 = withState { (f, _) in f }
        if existingFd >= 0 {
            return
        }
        let deadline = timeout > 0 ? Date().addingTimeInterval(timeout) : nil
        var lastError: Error?

        while true {
            if withState({ (f, _) in f }) >= 0 {
                return
            }

            let remaining: TimeInterval
            if let deadline {
                remaining = deadline.timeIntervalSinceNow
                if remaining <= 0 {
                    break
                }
            } else {
                remaining = 0
            }

            let attemptTimeout = deadline == nil ? timeout : min(5, max(0.5, remaining))
            let connectedFd: Int32
            if let host = tcpFallbackHostSnapshot(), !host.isEmpty {
                do {
                    connectedFd = try Self.connectTCP(host: host, port: port, timeout: attemptTimeout)
                    withState { (f, _) in f = connectedFd }
                    return
                } catch {
                    lastError = error
                    if deadline == nil {
                        throw GuestAgentError.notConnected("tcp connect \(host):\(port): \(error)")
                    }
                    try? await Task.sleep(nanoseconds: 500_000_000)
                    continue
                }
            }
            do {
                connectedFd = try await connectVsockAttempt(timeout: attemptTimeout)
            } catch {
                lastError = error
                if deadline == nil {
                    throw GuestAgentError.notConnected("\(error); tcp fallback not attempted because no explicit tcp guest-agent transport is configured")
                } else {
                    try? await Task.sleep(nanoseconds: 500_000_000)
                    continue
                }
            }
            withState { (f, _) in f = connectedFd }
            return
        }

        let errorText = lastError.map { "\($0)" } ?? "timeout"
        throw GuestAgentError.notConnected("\(errorText); tcp fallback not attempted because no explicit tcp guest-agent transport is configured")
    }

    private func connectVsockAttempt(timeout: TimeInterval) async throws -> Int32 {
        // VZVirtioSocketDevice.connect(toPort:completionHandler:) returns a
        // VZVirtioSocketConnection whose fileDescriptor is a real socket
        // file descriptor (apple-developer-docs/.../VZVirtioSocketDevice.md:30).
        // We drive it as a normal POSIX socket.
        let device = self.socketDevice
        let connectQueue = self.connectQueue
        let port = self.port
        // VZVirtioSocketConnection isn't Sendable; extract the fileDescriptor
        // (Int32, Sendable) inside the completion closure and retain the
        // connection object on this agent so the fd remains valid.
        return try await withCheckedThrowingContinuation { cc in
            let gate = GuestAgentConnectContinuation(cc)
            let startConnect = {
                device.connect(toPort: port) { result in
                    switch result {
                    case .success(let conn):
                        let connectionFd = conn.fileDescriptor
                        guard connectionFd >= 0 else {
                            gate.resume(throwing: GuestAgentError.notConnected("vsock connect port \(port): connection closed before fileDescriptor was usable"))
                            return
                        }
                        self.retainConnection(conn, fd: connectionFd)
                        gate.resume(returning: connectionFd)
                    case .failure(let err):
                        gate.resume(throwing: GuestAgentError.notConnected("vsock connect port \(port): \(err.localizedDescription)"))
                    }
                }
            }
            if let connectQueue {
                connectQueue.async(execute: startConnect)
            } else {
                startConnect()
            }
            if timeout > 0 {
                DispatchQueue.global(qos: .userInitiated).asyncAfter(deadline: .now() + timeout) {
                    gate.resume(throwing: GuestAgentError.timeout("vsock connect port \(port) after \(Int(timeout))s"))
                }
            }
        }
    }

    private static func connectTCP(host: String, port: UInt32, timeout: TimeInterval) throws -> Int32 {
        let sock = Darwin.socket(AF_INET, SOCK_STREAM, 0)
        guard sock >= 0 else {
            throw GuestAgentError.ioFailure("tcp socket: \(String(cString: strerror(errno)))")
        }

        let originalFlags = Darwin.fcntl(sock, F_GETFL, 0)
        guard originalFlags >= 0 else {
            let message = String(cString: strerror(errno))
            Darwin.close(sock)
            throw GuestAgentError.ioFailure("tcp fcntl(F_GETFL): \(message)")
        }
        guard Darwin.fcntl(sock, F_SETFL, originalFlags | O_NONBLOCK) == 0 else {
            let message = String(cString: strerror(errno))
            Darwin.close(sock)
            throw GuestAgentError.ioFailure("tcp fcntl(F_SETFL): \(message)")
        }

        var addr = sockaddr_in()
        addr.sin_len = UInt8(MemoryLayout<sockaddr_in>.size)
        addr.sin_family = sa_family_t(AF_INET)
        addr.sin_port = UInt16(port).bigEndian
        let parsed = host.withCString { inet_pton(AF_INET, $0, &addr.sin_addr) }
        guard parsed == 1 else {
            Darwin.close(sock)
            throw GuestAgentError.notConnected("tcp fallback host is not IPv4: \(host)")
        }

        let addrSize = socklen_t(MemoryLayout<sockaddr_in>.size)
        let connectResult = withUnsafePointer(to: &addr) { ptr -> Int32 in
            ptr.withMemoryRebound(to: sockaddr.self, capacity: 1) { sptr in
                Darwin.connect(sock, sptr, addrSize)
            }
        }
        if connectResult == 0 {
            _ = Darwin.fcntl(sock, F_SETFL, originalFlags)
            return sock
        }

        let connectErrno = errno
        guard connectErrno == EINPROGRESS else {
            let message = String(cString: strerror(connectErrno))
            Darwin.close(sock)
            throw GuestAgentError.notConnected("tcp connect \(host):\(port): \(message)")
        }

        let timeoutMs: Int32
        if timeout <= 0 {
            timeoutMs = -1
        } else {
            timeoutMs = Int32(min(Double(Int32.max), ceil(timeout * 1000)))
        }
        var pfd = pollfd(fd: sock, events: Int16(POLLOUT), revents: 0)
        let pollResult = Darwin.poll(&pfd, 1, timeoutMs)
        guard pollResult > 0 else {
            let message = pollResult == 0 ? "after \(Int(timeout))s" : String(cString: strerror(errno))
            Darwin.close(sock)
            if pollResult == 0 {
                throw GuestAgentError.timeout("tcp connect \(host):\(port) \(message)")
            }
            throw GuestAgentError.notConnected("tcp connect \(host):\(port): \(message)")
        }

        var socketError: Int32 = 0
        var socketErrorLength = socklen_t(MemoryLayout<Int32>.size)
        guard Darwin.getsockopt(sock, SOL_SOCKET, SO_ERROR, &socketError, &socketErrorLength) == 0 else {
            let message = String(cString: strerror(errno))
            Darwin.close(sock)
            throw GuestAgentError.ioFailure("tcp getsockopt(SO_ERROR): \(message)")
        }
        guard socketError == 0 else {
            let message = String(cString: strerror(socketError))
            Darwin.close(sock)
            throw GuestAgentError.notConnected("tcp connect \(host):\(port): \(message)")
        }

        _ = Darwin.fcntl(sock, F_SETFL, originalFlags)
        return sock
    }

    public func request(_ action: GuestAgentDict, timeout: TimeInterval = 60) async throws -> GuestAgentDict {
        await requestLock.lock()
        do {
            let result = try await requestUnlocked(action, timeout: timeout)
            await requestLock.unlock()
            return result
        } catch {
            await requestLock.unlock()
            throw error
        }
    }

    private func requestUnlocked(_ action: GuestAgentDict, timeout: TimeInterval = 60) async throws -> GuestAgentDict {
        let id = UUID().uuidString
        var payload: [String: Any] = ["id": id, "action": action.dict]
        if payload["action"] == nil { payload["action"] = action.dict }

        let data: Data
        do {
            data = try JSONSerialization.data(withJSONObject: payload, options: [])
        } catch {
            throw GuestAgentError.framing("encode request: \(error.localizedDescription)")
        }

        var length = UInt32(data.count).littleEndian
        var frame = Data(bytes: &length, count: 4)
        frame.append(data)

        func sendAndRead() throws -> GuestAgentDict {
            let fdSnapshot: Int32 = withState { (f, _) in f }
            guard fdSnapshot >= 0 else { throw GuestAgentError.notConnected("no fd") }
            try Self.writeAll(fd: fdSnapshot, data: frame)
            let response = try Self.readFrame(fd: fdSnapshot, timeout: timeout)
            guard let obj = try JSONSerialization.jsonObject(with: response, options: []) as? [String: Any] else {
                throw GuestAgentError.framing("decode response: expected object")
            }
            let result = (obj["result"] as? [String: Any]) ?? [:]
            return GuestAgentDict(result)
        }

        do {
            return try sendAndRead()
        } catch {
            await disconnect()
            try await connect(timeout: min(max(timeout, 1), 10))
            do {
                return try sendAndRead()
            } catch {
                await disconnect()
                throw error
            }
        }
    }

    private static func writeAll(fd: Int32, data: Data) throws {
        try data.withUnsafeBytes { rawBuffer in
            guard let base = rawBuffer.baseAddress else { return }
            var written = 0
            while written < data.count {
                let n = Darwin.write(fd, base.advanced(by: written), data.count - written)
                if n > 0 {
                    written += n
                    continue
                }
                if n < 0 && errno == EINTR {
                    continue
                }
                let message = n == 0 ? "zero-byte write" : String(cString: strerror(errno))
                throw GuestAgentError.ioFailure("write: \(message)")
            }
        }
    }

    private static func readFrame(fd: Int32, timeout: TimeInterval) throws -> Data {
        let header = try readExact(fd: fd, count: 4, timeout: timeout)
        let length = header.withUnsafeBytes { $0.loadUnaligned(as: UInt32.self) }
        guard length > 0 && length <= 50_000_000 else {
            throw GuestAgentError.framing("invalid response length \(length)")
        }
        return try readExact(fd: fd, count: Int(length), timeout: timeout)
    }

    private static func readExact(fd: Int32, count: Int, timeout: TimeInterval) throws -> Data {
        let deadline = timeout > 0 ? Date().addingTimeInterval(timeout) : nil
        var data = Data()
        var buffer = [UInt8](repeating: 0, count: min(64 * 1024, max(1, count)))
        while data.count < count {
            let timeoutMs: Int32
            if let deadline {
                let remaining = deadline.timeIntervalSinceNow
                guard remaining > 0 else {
                    throw GuestAgentError.timeout("read \(count) bytes after \(Int(timeout))s")
                }
                timeoutMs = Int32(min(Double(Int32.max), ceil(remaining * 1000)))
            } else {
                timeoutMs = -1
            }
            var pfd = pollfd(fd: fd, events: Int16(POLLIN), revents: 0)
            let pollResult = Darwin.poll(&pfd, 1, timeoutMs)
            if pollResult == 0 {
                throw GuestAgentError.timeout("read \(count) bytes after \(Int(timeout))s")
            }
            if pollResult < 0 {
                if errno == EINTR { continue }
                throw GuestAgentError.ioFailure("poll: \(String(cString: strerror(errno)))")
            }
            if (pfd.revents & Int16(POLLHUP | POLLERR | POLLNVAL)) != 0 {
                throw GuestAgentError.notConnected("disconnected")
            }
            let wanted = min(buffer.count, count - data.count)
            let n = buffer.withUnsafeMutableBufferPointer {
                Darwin.read(fd, $0.baseAddress, wanted)
            }
            if n > 0 {
                data.append(buffer, count: n)
                continue
            }
            if n == 0 {
                throw GuestAgentError.notConnected("disconnected")
            }
            if errno == EINTR || errno == EAGAIN || errno == EWOULDBLOCK {
                continue
            }
            throw GuestAgentError.ioFailure("read: \(String(cString: strerror(errno)))")
        }
        return data
    }

    public func disconnect() async {
        reader?.cancel()
        reader = nil
        let (f, pendingCopy): (Int32, [String: CheckedContinuation<GuestAgentDict, Error>]) = withState { (fd, pending) in
            let snapshotPending = pending
            let snapshotFd = fd
            fd = -1
            retainedConnection = nil
            pending.removeAll()
            return (snapshotFd, snapshotPending)
        }
        for (_, cc) in pendingCopy {
            cc.resume(throwing: GuestAgentError.notConnected("disconnected"))
        }
        if f >= 0 { Darwin.close(f) }
    }

    // MARK: - read loop

    private func readLoop() async {
        var buffer = Data()
        var buf = [UInt8](repeating: 0, count: 64 * 1024)
        while !Task.isCancelled {
            let fdSnapshot: Int32 = withState { (f, _) in f }
            if fdSnapshot < 0 { return }
            let n = buf.withUnsafeMutableBufferPointer { Darwin.read(fdSnapshot, $0.baseAddress, $0.count) }
            if n == 0 {
                await self.disconnect()
                return
            }
            if n < 0 {
                let readErrno = errno
                if readErrno == EINTR {
                    continue
                }
                if readErrno == EAGAIN || readErrno == EWOULDBLOCK {
                    var pfd = pollfd(fd: fdSnapshot, events: Int16(POLLIN), revents: 0)
                    let pollResult = Darwin.poll(&pfd, 1, 250)
                    if pollResult < 0 && errno != EINTR {
                        await self.disconnect()
                        return
                    }
                    continue
                }
                await self.disconnect()
                return
            }
            buffer.append(buf, count: n)

            while buffer.count >= 4 {
                let length: UInt32 = buffer.withUnsafeBytes { $0.loadUnaligned(as: UInt32.self) }
                let totalSize = 4 + Int(length)
                if length == 0 || length > 50_000_000 {
                    buffer.removeAll()
                    break
                }
                if buffer.count < totalSize { break }
                let payload = buffer.subdata(in: 4..<totalSize)
                buffer.removeSubrange(0..<totalSize)

                guard let obj = try? JSONSerialization.jsonObject(with: payload, options: []) as? [String: Any] else {
                    continue
                }
                guard let id = obj["id"] as? String else { continue }
                let result = (obj["result"] as? [String: Any]) ?? [:]
                let cc: CheckedContinuation<GuestAgentDict, Error>? = withState { (_, p) in p.removeValue(forKey: id) }
                cc?.resume(returning: GuestAgentDict(result))
            }
        }
    }
}
