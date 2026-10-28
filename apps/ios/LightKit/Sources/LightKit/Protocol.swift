import Foundation

/// The sync wire protocol. See `docs/sync-protocol.md`.

public let lightWeekProtocolVersion = 1

/// A single change to one entity.
///
/// `fields` is a sparse patch rather than a whole row, so a client that changed
/// one thing cannot clobber another device's edit to a different field.
public struct Op: Codable, Sendable {
    public var id: String
    public var kind: String
    public var entityId: String
    public var type: String
    public var fields: JSONValue?
    public var clock: String
    public var node: String

    public init(id: String = LightID.new(), kind: String, entityId: String,
                type: String = "upsert", fields: JSONValue? = nil,
                clock: String, node: String) {
        self.id = id
        self.kind = kind
        self.entityId = entityId
        self.type = type
        self.fields = fields
        self.clock = clock
        self.node = node
    }
}

public struct PushRequest: Codable, Sendable {
    public var version: Int
    public var since: Int
    public var ops: [Op]

    /// Spelled out because a `public struct`'s memberwise initialiser is
    /// internal: without this, the push body decodes outside the package but
    /// cannot be built there, and an app has to re-declare the three fields to
    /// make a request — which is how the one type that defines the wire format
    /// ends up with a second definition in every client.
    public init(version: Int = lightWeekProtocolVersion, since: Int, ops: [Op]) {
        self.version = version
        self.since = since
        self.ops = ops
    }
}

public struct SyncResponse: Codable, Sendable {
    public var version: Int
    public var cursor: Int
    public var ops: [Op]
    public var hasMore: Bool
    public var accepted: [String]?
    public var rejected: [Rejection]?
    public var stale: Bool?

    public struct Rejection: Codable, Sendable {
        public var id: String
        public var reason: String
    }
}

/// A JSON value, because an op's patch is arbitrary by design.
///
/// Swift has no `Any`-shaped `Codable`, so this is the usual enum. It exists so
/// that `Op` round-trips without every entity needing a bespoke op type.
public enum JSONValue: Codable, Sendable, Equatable {
    case string(String)
    case number(Double)
    case integer(Int)
    case bool(Bool)
    case null
    case array([JSONValue])
    case object([String: JSONValue])

    public init(from decoder: Decoder) throws {
        let container = try decoder.singleValueContainer()
        if container.decodeNil() {
            self = .null
        } else if let value = try? container.decode(Bool.self) {
            self = .bool(value)
        } else if let value = try? container.decode(Int.self) {
            self = .integer(value)
        } else if let value = try? container.decode(Double.self) {
            self = .number(value)
        } else if let value = try? container.decode(String.self) {
            self = .string(value)
        } else if let value = try? container.decode([JSONValue].self) {
            self = .array(value)
        } else if let value = try? container.decode([String: JSONValue].self) {
            self = .object(value)
        } else {
            throw DecodingError.dataCorruptedError(
                in: container, debugDescription: "unsupported JSON value")
        }
    }

    public func encode(to encoder: Encoder) throws {
        var container = encoder.singleValueContainer()
        switch self {
        case .null: try container.encodeNil()
        case .bool(let value): try container.encode(value)
        case .integer(let value): try container.encode(value)
        case .number(let value): try container.encode(value)
        case .string(let value): try container.encode(value)
        case .array(let value): try container.encode(value)
        case .object(let value): try container.encode(value)
        }
    }

    /// Re-encodes an `Encodable` as a patch, which is how a typed entity
    /// becomes an op's `fields`.
    public static func encoding<T: Encodable>(_ value: T) throws -> JSONValue {
        let data = try JSONEncoder().encode(value)
        return try JSONDecoder().decode(JSONValue.self, from: data)
    }
}
