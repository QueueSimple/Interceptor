import Foundation
import Darwin

public enum VMPortForwarderError: Error, CustomStringConvertible, Sendable {
    case invalidAddress(String)
    case socket(String)
    case bind(String)
    case listen(String)

    public var description: String {
        switch self {
        case .invalidAddress(let m): return "portForward.invalidAddress: \(m)"
        case .socket(let m): return "portForward.socket: \(m)"
        case .bind(let m): return "portForward.bind: \(m)"
        case .listen(let m): return "portForward.listen: \(m)"
        }
    }
}

public final class VMPortForwarder: @unchecked Sendable {
    public let hostAddress: String
    public private(set) var hostPort: Int
    public let guestAddress: String
    public let guestPort: Int

    private let queue: DispatchQueue
    private var serverFd: Int32 = -1
    private var listener: DispatchSourceRead?
    private var sockets: Set<Int32> = []

    public init(hostAddress: String, hostPort: Int, guestAddress: String, guestPort: Int) {
        self.hostAddress = hostAddress
        self.hostPort = hostPort
        self.guestAddress = guestAddress
        self.guestPort = guestPort
        self.queue = DispatchQueue(label: "interceptor.vm.portForward.\(hostAddress).\(hostPort).\(guestAddress).\(guestPort)")
    }

    public func start() throws -> Int {
        let fd = Darwin.socket(AF_INET, SOCK_STREAM, 0)
        guard fd >= 0 else {
            throw VMPortForwarderError.socket(String(cString: strerror(errno)))
        }
        var yes: Int32 = 1
        setsockopt(fd, SOL_SOCKET, SO_REUSEADDR, &yes, socklen_t(MemoryLayout<Int32>.size))

        let flags = Darwin.fcntl(fd, F_GETFL, 0)
        if flags >= 0 {
            _ = Darwin.fcntl(fd, F_SETFL, flags | O_NONBLOCK)
        }

        var addr = sockaddr_in()
        addr.sin_len = UInt8(MemoryLayout<sockaddr_in>.size)
        addr.sin_family = sa_family_t(AF_INET)
        addr.sin_port = UInt16(hostPort).bigEndian
        guard hostAddress.withCString({ inet_pton(AF_INET, $0, &addr.sin_addr) }) == 1 else {
            Darwin.close(fd)
            throw VMPortForwarderError.invalidAddress(hostAddress)
        }

        let addrSize = socklen_t(MemoryLayout<sockaddr_in>.size)
        let bindResult = withUnsafePointer(to: &addr) { ptr -> Int32 in
            ptr.withMemoryRebound(to: sockaddr.self, capacity: 1) { sptr in
                Darwin.bind(fd, sptr, addrSize)
            }
        }
        guard bindResult == 0 else {
            let message = String(cString: strerror(errno))
            Darwin.close(fd)
            throw VMPortForwarderError.bind(message)
        }
        guard Darwin.listen(fd, SOMAXCONN) == 0 else {
            let message = String(cString: strerror(errno))
            Darwin.close(fd)
            throw VMPortForwarderError.listen(message)
        }

        if hostPort == 0 {
            var bound = sockaddr_in()
            var boundSize = socklen_t(MemoryLayout<sockaddr_in>.size)
            let got = withUnsafeMutablePointer(to: &bound) { ptr -> Int32 in
                ptr.withMemoryRebound(to: sockaddr.self, capacity: 1) { sptr in
                    Darwin.getsockname(fd, sptr, &boundSize)
                }
            }
            if got == 0 {
                hostPort = Int(UInt16(bigEndian: bound.sin_port))
            }
        }

        serverFd = fd
        let source = DispatchSource.makeReadSource(fileDescriptor: fd, queue: queue)
        source.setEventHandler { [weak self] in
            self?.acceptReady()
        }
        source.setCancelHandler {}
        listener = source
        source.resume()
        return hostPort
    }

    public func stop() {
        queue.sync {
            listener?.cancel()
            listener = nil
            if serverFd >= 0 {
                Darwin.close(serverFd)
                serverFd = -1
            }
            for fd in sockets {
                Darwin.shutdown(fd, SHUT_RDWR)
                Darwin.close(fd)
            }
            sockets.removeAll()
        }
    }

    private func acceptReady() {
        while true {
            let client = Darwin.accept(serverFd, nil, nil)
            if client < 0 {
                let e = errno
                if e == EWOULDBLOCK || e == EAGAIN { return }
                return
            }
            sockets.insert(client)
            Task.detached(priority: .utility) { [weak self] in
                await self?.handle(client: client)
            }
        }
    }

    private func handle(client: Int32) async {
        let guest: Int32
        do {
            guest = try Self.connect(host: guestAddress, port: guestPort)
        } catch {
            closeTracked(client)
            return
        }
        queue.async { self.sockets.insert(guest) }

        Task.detached(priority: .utility) { [weak self] in
            Self.pipe(from: client, to: guest)
            self?.closeTracked(client)
            self?.closeTracked(guest)
        }
        Task.detached(priority: .utility) { [weak self] in
            Self.pipe(from: guest, to: client)
            self?.closeTracked(client)
            self?.closeTracked(guest)
        }
    }

    private func closeTracked(_ fd: Int32) {
        queue.async {
            guard self.sockets.remove(fd) != nil else { return }
            Darwin.shutdown(fd, SHUT_RDWR)
            Darwin.close(fd)
        }
    }

    private static func connect(host: String, port: Int) throws -> Int32 {
        let fd = Darwin.socket(AF_INET, SOCK_STREAM, 0)
        guard fd >= 0 else {
            throw VMPortForwarderError.socket(String(cString: strerror(errno)))
        }
        var addr = sockaddr_in()
        addr.sin_len = UInt8(MemoryLayout<sockaddr_in>.size)
        addr.sin_family = sa_family_t(AF_INET)
        addr.sin_port = UInt16(port).bigEndian
        guard host.withCString({ inet_pton(AF_INET, $0, &addr.sin_addr) }) == 1 else {
            Darwin.close(fd)
            throw VMPortForwarderError.invalidAddress(host)
        }
        let size = socklen_t(MemoryLayout<sockaddr_in>.size)
        let result = withUnsafePointer(to: &addr) { ptr -> Int32 in
            ptr.withMemoryRebound(to: sockaddr.self, capacity: 1) { sptr in
                Darwin.connect(fd, sptr, size)
            }
        }
        guard result == 0 else {
            let message = String(cString: strerror(errno))
            Darwin.close(fd)
            throw VMPortForwarderError.socket("connect \(host):\(port): \(message)")
        }
        return fd
    }

    private static func pipe(from src: Int32, to dst: Int32) {
        var buf = [UInt8](repeating: 0, count: 64 * 1024)
        while true {
            let n = buf.withUnsafeMutableBufferPointer { Darwin.read(src, $0.baseAddress, $0.count) }
            if n <= 0 { return }
            var written = 0
            while written < n {
                let w = buf.withUnsafeBufferPointer { ptr -> Int in
                    guard let base = ptr.baseAddress else { return -1 }
                    return Darwin.write(dst, base.advanced(by: written), n - written)
                }
                if w <= 0 { return }
                written += w
            }
        }
    }
}
