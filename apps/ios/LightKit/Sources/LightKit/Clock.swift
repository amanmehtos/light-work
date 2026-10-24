import Foundation

/// Hybrid logical clock.
///
/// Mirrors `packages/core/src/hlc.ts`, including the encoding — the padded
/// base-36 form is what makes a clock sort as a string, and both sides have to
/// agree on the widths or comparisons silently disagree across platforms.
public struct HLC: Sendable, Equatable, Comparable {
    public var wall: Int
    public var counter: Int
    public var node: String

    private static let wallWidth = 11
    private static let counterWidth = 5

    public init(wall: Int, counter: Int, node: String) {
        self.wall = wall
        self.counter = counter
        self.node = node
    }

    public var encoded: String {
        let wallPart = String(wall, radix: 36).leftPadded(to: Self.wallWidth, with: "0")
        let counterPart = String(counter, radix: 36).leftPadded(to: Self.counterWidth, with: "0")
        return "\(wallPart):\(counterPart):\(node)"
    }

    public init?(encoded: String) {
        let parts = encoded.split(separator: ":", maxSplits: 2, omittingEmptySubsequences: false)
        guard parts.count == 3,
              let wall = Int(parts[0], radix: 36),
              let counter = Int(parts[1], radix: 36)
        else { return nil }
        self.init(wall: wall, counter: counter, node: String(parts[2]))
    }

    public static func < (lhs: HLC, rhs: HLC) -> Bool {
        if lhs.wall != rhs.wall { return lhs.wall < rhs.wall }
        if lhs.counter != rhs.counter { return lhs.counter < rhs.counter }
        return lhs.node < rhs.node
    }
}

/// A clock bound to one device.
///
/// Issues strictly increasing timestamps even when the device clock stands
/// still or runs backwards, which is what keeps edits from this device ordered
/// among themselves.
public final class Clock: @unchecked Sendable {
    private var current: HLC
    private let now: () -> Int
    private let lock = NSLock()

    public init(node: String, now: @escaping () -> Int = { Int(Date().timeIntervalSince1970 * 1000) }) {
        self.current = HLC(wall: 0, counter: 0, node: node)
        self.now = now
    }

    public var node: String { current.node }

    /// The next timestamp for a locally originated change.
    public func next() -> HLC {
        lock.lock()
        defer { lock.unlock() }
        let wall = max(current.wall, now())
        let counter = wall == current.wall ? current.counter + 1 : 0
        current = HLC(wall: wall, counter: counter, node: current.node)
        return current
    }

    /// Absorbs a remote timestamp, so anything this device then produces is
    /// ordered after it.
    @discardableResult
    public func observe(_ remote: HLC) -> HLC {
        lock.lock()
        defer { lock.unlock() }
        let wall = max(current.wall, remote.wall, now())
        let counter: Int
        if wall == current.wall && wall == remote.wall {
            counter = max(current.counter, remote.counter) + 1
        } else if wall == current.wall {
            counter = current.counter + 1
        } else if wall == remote.wall {
            counter = remote.counter + 1
        } else {
            counter = 0
        }
        current = HLC(wall: wall, counter: counter, node: current.node)
        return current
    }
}
