import Foundation

// Codable mirrors of docs/api.md (v1). Keep in sync with the contract.

nonisolated struct Location: Codable, Sendable, Equatable {
    var lat: Double
    var lng: Double
}

/// Normalized to the image: 0..1, origin top-left.
nonisolated struct Box: Codable, Sendable, Equatable {
    var x: Double
    var y: Double
    var w: Double
    var h: Double

    static let full = Box(x: 0, y: 0, w: 1, h: 1)

    /// Clamped to the unit square.
    var clamped: Box {
        let x0 = min(max(x, 0), 1), y0 = min(max(y, 0), 1)
        let x1 = min(max(x + w, 0), 1), y1 = min(max(y + h, 0), 1)
        return Box(x: x0, y: y0, w: max(x1 - x0, 0), h: max(y1 - y0, 0))
    }

    var midX: Double { x + w / 2 }
    var midY: Double { y + h / 2 }
}

nonisolated enum SelectionMode: String, Codable, Sendable {
    case full, point, frame, lasso
}

nonisolated struct Selection: Codable, Sendable, Equatable {
    var mode: SelectionMode
    var box: Box?

    static let full = Selection(mode: .full, box: nil)

    // Always encode `box`, even when nil (the contract says `Box | null`).
    enum CodingKeys: String, CodingKey { case mode, box }
    func encode(to encoder: Encoder) throws {
        var c = encoder.container(keyedBy: CodingKeys.self)
        try c.encode(mode, forKey: .mode)
        try c.encode(box, forKey: .box)
    }
}

nonisolated struct Place: Codable, Sendable, Equatable, Identifiable {
    var id: String
    var name: String
    var category: String
    var address: String?
    var phone: String?
    var lat: Double
    var lng: Double
    var distanceMeters: Double?
}

nonisolated enum MemoryKind: String, Codable, Sendable {
    case explicit, passive
}

nonisolated struct Memory: Codable, Sendable, Equatable, Identifiable {
    var id: String
    var createdAt: String
    var kind: MemoryKind
    var title: String
    var summary: String
    var visibleText: String
    var objects: [String]
    var note: String?
    var imageUrl: String
    var selection: Selection
    var location: Location?
    var place: Place?

    var imageURL: URL? { URL(string: imageUrl) }
}

nonisolated enum CaptureSource: String, Codable, Sendable {
    case glasses, phone
}

// MARK: - Route payloads

nonisolated struct HealthResponse: Codable, Sendable {
    struct Models: Codable, Sendable { var chat: String; var vision: String; var embed: String }
    var ok: Bool
    var mock: Bool
    var models: Models?
}

/// `meta` part of `POST /v1/memories`.
nonisolated struct SaveMemoryMeta: Codable, Sendable {
    var utterance: String
    var note: String?
    var selection: Selection
    var kind: MemoryKind
    var source: CaptureSource
    var capturedAt: String
    var location: Location?

    enum CodingKeys: String, CodingKey { case utterance, note, selection, kind, source, capturedAt, location }
    func encode(to encoder: Encoder) throws {
        var c = encoder.container(keyedBy: CodingKeys.self)
        try c.encode(utterance, forKey: .utterance)
        try c.encode(note, forKey: .note)
        try c.encode(selection, forKey: .selection)
        try c.encode(kind, forKey: .kind)
        try c.encode(source, forKey: .source)
        try c.encode(capturedAt, forKey: .capturedAt)
        try c.encode(location, forKey: .location)
    }
}

nonisolated struct SaveMemoryResponse: Codable, Sendable {
    var memory: Memory
    var speech: String
}

/// `meta` part of `POST /v1/glance`.
nonisolated struct GlanceMeta: Codable, Sendable {
    var utterance: String
    var location: Location?

    enum CodingKeys: String, CodingKey { case utterance, location }
    func encode(to encoder: Encoder) throws {
        var c = encoder.container(keyedBy: CodingKeys.self)
        try c.encode(utterance, forKey: .utterance)
        try c.encode(location, forKey: .location)
    }
}

nonisolated struct GlanceResponse: Codable, Sendable {
    var speech: String
    var title: String
    var objects: [String]
}

nonisolated struct AskRequest: Codable, Sendable {
    var question: String
    var location: Location?

    enum CodingKeys: String, CodingKey { case question, location }
    func encode(to encoder: Encoder) throws {
        var c = encoder.container(keyedBy: CodingKeys.self)
        try c.encode(question, forKey: .question)
        try c.encode(location, forKey: .location)
    }
}

nonisolated struct AskResponse: Codable, Sendable {
    var speech: String
    var memories: [Memory]
}

nonisolated struct NearbyRequest: Codable, Sendable {
    var memoryId: String?
    var query: String?
    var location: Location

    enum CodingKeys: String, CodingKey { case memoryId, query, location }
    func encode(to encoder: Encoder) throws {
        var c = encoder.container(keyedBy: CodingKeys.self)
        try c.encode(memoryId, forKey: .memoryId)
        try c.encode(query, forKey: .query)
        try c.encode(location, forKey: .location)
    }
}

nonisolated struct NearbyResponse: Codable, Sendable {
    var speech: String
    var places: [Place]
}

nonisolated struct MemoriesResponse: Codable, Sendable {
    var memories: [Memory]
}

nonisolated struct APIErrorEnvelope: Codable, Sendable {
    struct Body: Codable, Sendable { var code: String; var message: String }
    var error: Body
}

// MARK: - Live events

nonisolated enum WinkState: String, Codable, Sendable {
    case idle, listening, thinking, speaking, paused
}

nonisolated enum GestureName: String, Codable, Sendable {
    case point, frame, lasso, palm, thumbsUp, fingers, pinch, flick
}

/// One message on `/v1/live` (and the body of `POST /v1/events`).
nonisolated enum LiveEvent: Sendable, Equatable {
    case status(state: WinkState, text: String?)
    case transcript(text: String)
    case gesture(GestureName, value: Double?, box: Box?)
    case pointer(x: Double, y: Double, pinching: Bool)
    case frame(jpegBase64: String)
    case memorySaved(Memory)
    case memoryDeleted(id: String)
    case glance(speech: String, title: String, objects: [String])
    case answer(question: String, speech: String, memories: [Memory])
    case nearby(speech: String, places: [Place])
    case unknown(type: String)
}

extension LiveEvent: Codable {
    private enum K: String, CodingKey {
        case type, state, text, gesture, value, box, x, y, pinching, jpegBase64, memory, id
        case speech, title, objects, question, memories, places
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: K.self)
        let type = try c.decode(String.self, forKey: .type)
        switch type {
        case "status":
            self = .status(state: try c.decode(WinkState.self, forKey: .state), text: try c.decodeIfPresent(String.self, forKey: .text))
        case "transcript":
            self = .transcript(text: try c.decode(String.self, forKey: .text))
        case "gesture":
            self = .gesture(try c.decode(GestureName.self, forKey: .gesture),
                            value: try c.decodeIfPresent(Double.self, forKey: .value),
                            box: try c.decodeIfPresent(Box.self, forKey: .box))
        case "pointer":
            self = .pointer(x: try c.decode(Double.self, forKey: .x), y: try c.decode(Double.self, forKey: .y),
                            pinching: try c.decode(Bool.self, forKey: .pinching))
        case "frame":
            self = .frame(jpegBase64: try c.decode(String.self, forKey: .jpegBase64))
        case "memory.saved":
            self = .memorySaved(try c.decode(Memory.self, forKey: .memory))
        case "memory.deleted":
            self = .memoryDeleted(id: try c.decode(String.self, forKey: .id))
        case "glance":
            self = .glance(speech: try c.decode(String.self, forKey: .speech), title: try c.decode(String.self, forKey: .title),
                           objects: try c.decode([String].self, forKey: .objects))
        case "answer":
            self = .answer(question: try c.decode(String.self, forKey: .question), speech: try c.decode(String.self, forKey: .speech),
                           memories: try c.decode([Memory].self, forKey: .memories))
        case "nearby":
            self = .nearby(speech: try c.decode(String.self, forKey: .speech), places: try c.decode([Place].self, forKey: .places))
        default:
            self = .unknown(type: type)
        }
    }

    func encode(to encoder: Encoder) throws {
        var c = encoder.container(keyedBy: K.self)
        switch self {
        case let .status(state, text):
            try c.encode("status", forKey: .type)
            try c.encode(state, forKey: .state)
            try c.encodeIfPresent(text, forKey: .text)
        case let .transcript(text):
            try c.encode("transcript", forKey: .type)
            try c.encode(text, forKey: .text)
        case let .gesture(name, value, box):
            try c.encode("gesture", forKey: .type)
            try c.encode(name, forKey: .gesture)
            try c.encodeIfPresent(value, forKey: .value)
            try c.encodeIfPresent(box, forKey: .box)
        case let .pointer(x, y, pinching):
            try c.encode("pointer", forKey: .type)
            try c.encode(x, forKey: .x)
            try c.encode(y, forKey: .y)
            try c.encode(pinching, forKey: .pinching)
        case let .frame(jpeg):
            try c.encode("frame", forKey: .type)
            try c.encode(jpeg, forKey: .jpegBase64)
        case let .memorySaved(memory):
            try c.encode("memory.saved", forKey: .type)
            try c.encode(memory, forKey: .memory)
        case let .memoryDeleted(id):
            try c.encode("memory.deleted", forKey: .type)
            try c.encode(id, forKey: .id)
        case let .glance(speech, title, objects):
            try c.encode("glance", forKey: .type)
            try c.encode(speech, forKey: .speech)
            try c.encode(title, forKey: .title)
            try c.encode(objects, forKey: .objects)
        case let .answer(question, speech, memories):
            try c.encode("answer", forKey: .type)
            try c.encode(question, forKey: .question)
            try c.encode(speech, forKey: .speech)
            try c.encode(memories, forKey: .memories)
        case let .nearby(speech, places):
            try c.encode("nearby", forKey: .type)
            try c.encode(speech, forKey: .speech)
            try c.encode(places, forKey: .places)
        case let .unknown(type):
            try c.encode(type, forKey: .type)
        }
    }
}
