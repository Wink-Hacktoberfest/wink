import Foundation

nonisolated enum GestureEvent: Equatable, Sendable {
    case point(Box)
    case frame(Box)
    case palm
    case thumbsUp
    case fingers(Int)
    case flick(direction: Int)   // -1 = left, +1 = right
    case pinchStart
    case pinchEnd

    var name: GestureName {
        switch self {
        case .point: .point
        case .frame: .frame
        case .palm: .palm
        case .thumbsUp: .thumbsUp
        case .fingers: .fingers
        case .flick: .flick
        case .pinchStart, .pinchEnd: .pinch
        }
    }
}

nonisolated struct PointerSample: Equatable, Sendable {
    var x: Double
    var y: Double
    var pinching: Bool
}

nonisolated enum HandPose: Equatable, Sendable {
    case point, lShape, palm, thumbsUp, fingers(Int), fist, other
}

/// Static per-frame hand shape analysis.
nonisolated enum HandAnalysis {
    static func scale(_ h: Hand) -> Double { max(h[Hand.wrist].distance(to: h[Hand.middleMCP]), 0.01) }

    static func isExtended(_ h: Hand, tip: Int, pip: Int) -> Bool {
        let w = h[Hand.wrist]
        return w.distance(to: h[tip]) > w.distance(to: h[pip]) * 1.15
    }

    static func thumbExtended(_ h: Hand) -> Bool {
        let s = scale(h)
        let tip = h[Hand.thumbTip]
        return tip.distance(to: h[Hand.indexMCP]) > 0.6 * s
            && h[Hand.wrist].distance(to: tip) > h[Hand.wrist].distance(to: h[Hand.thumbIP]) * 1.02
    }

    static func fingers(_ h: Hand) -> (index: Bool, middle: Bool, ring: Bool, pinky: Bool, thumb: Bool) {
        (isExtended(h, tip: Hand.indexTip, pip: Hand.indexPIP),
         isExtended(h, tip: Hand.middleTip, pip: Hand.middlePIP),
         isExtended(h, tip: Hand.ringTip, pip: Hand.ringPIP),
         isExtended(h, tip: Hand.pinkyTip, pip: Hand.pinkyPIP),
         thumbExtended(h))
    }

    /// Angle in degrees between the thumb and index finger directions.
    static func thumbIndexAngle(_ h: Hand) -> Double {
        let t = (h[Hand.thumbTip].x - h[Hand.thumbMCP].x, h[Hand.thumbTip].y - h[Hand.thumbMCP].y)
        let i = (h[Hand.indexTip].x - h[Hand.indexMCP].x, h[Hand.indexTip].y - h[Hand.indexMCP].y)
        let dot = t.0 * i.0 + t.1 * i.1
        let mag = hypot(t.0, t.1) * hypot(i.0, i.1)
        guard mag > 0 else { return 0 }
        return acos(min(max(dot / mag, -1), 1)) * 180 / .pi
    }

    static func pose(_ h: Hand) -> HandPose {
        guard h.landmarks.count == 21 else { return .other }
        let f = fingers(h)
        let s = scale(h)
        if f.index && f.middle && f.ring && f.pinky && f.thumb { return .palm }
        if f.index && !f.middle && !f.ring && !f.pinky {
            return f.thumb && thumbIndexAngle(h) > 45 ? .lShape : .point
        }
        if !f.index && !f.middle && !f.ring && !f.pinky {
            if f.thumb && h[Hand.thumbTip].y < h[Hand.indexMCP].y - 0.35 * s { return .thumbsUp }
            return .fist
        }
        if f.index && f.middle && !f.ring && !f.pinky && !f.thumb { return .fingers(2) }
        if f.index && f.middle && f.ring && !f.pinky { return .fingers(3) }
        return .other
    }

    static func pinchDistance(_ h: Hand) -> Double {
        h[Hand.thumbTip].distance(to: h[Hand.indexTip]) / scale(h)
    }

    /// Selection box (~35% of the frame) centered just beyond the fingertip along the finger direction.
    static func pointBox(_ h: Hand, size: Double = 0.35) -> Box {
        let tip = h[Hand.indexTip], base = h[Hand.indexMCP]
        var dx = tip.x - base.x, dy = tip.y - base.y
        let len = max(hypot(dx, dy), 1e-6)
        dx /= len; dy /= len
        let cx = tip.x + dx * size * 0.6
        let cy = tip.y + dy * size * 0.6
        let x = min(max(cx - size / 2, 0), 1 - size)
        let y = min(max(cy - size / 2, 0), 1 - size)
        return Box(x: x, y: y, w: size, h: size)
    }

    /// The vertex of an L-shaped hand (where thumb and index meet).
    static func lCorner(_ h: Hand) -> Landmark {
        let a = h[Hand.thumbMCP], b = h[Hand.indexMCP]
        return Landmark(x: (a.x + b.x) / 2, y: (a.y + b.y) / 2)
    }

    static func frameBox(_ a: Hand, _ b: Hand) -> Box? {
        let p = lCorner(a), q = lCorner(b)
        let x0 = min(p.x, q.x), x1 = max(p.x, q.x), y0 = min(p.y, q.y), y1 = max(p.y, q.y)
        guard x1 - x0 > 0.08, y1 - y0 > 0.08 else { return nil }
        return Box(x: x0, y: y0, w: x1 - x0, h: y1 - y0).clamped
    }
}

/// Turns a stream of hand landmarks into discrete gestures (held, debounced, with cooldowns) plus a pointer.
nonisolated struct GestureClassifier {
    struct Output: Equatable, Sendable {
        var events: [GestureEvent] = []
        var pointer: PointerSample?
        var pose: HandPose?
    }

    private enum Key: Equatable, Hashable { case point, frame, palm, thumbsUp, fingers(Int) }

    struct Tuning {
        var pointHold = 0.4
        var frameHold = 0.4
        var palmHold = 0.6
        var thumbsUpHold = 0.4
        var fingersHold = 0.5
        var cooldown = 1.2
        var dropoutTolerance = 0.2
        var pinchStart = 0.28   // thumb–index distance / hand scale
        var pinchEnd = 0.42
        var flickSpeed = 1.2    // normalized widths per second
        var flickDistance = 0.12
        var flickCooldown = 0.8
    }

    var tuning = Tuning()
    /// When true, a lone index finger counts as `fingers(1)` instead of `point` (e.g. picking from a list).
    var choosingMode = false

    private var candidate: Key?
    private var candidateSince: TimeInterval = 0
    private var candidateLastSeen: TimeInterval = 0
    private var candidateFired = false
    private var lastFired: [Key: TimeInterval] = [:]
    private(set) var isPinching = false
    private var pinchTrail: [(t: TimeInterval, x: Double)] = []
    private var lastFlick: TimeInterval = -10

    init() {}

    mutating func reset() {
        candidate = nil
        candidateFired = false
        isPinching = false
        pinchTrail = []
    }

    mutating func update(hands: [Hand], time t: TimeInterval) -> Output {
        var out = Output()
        let valid = hands.filter { $0.landmarks.count == 21 }
        guard let primary = valid.max(by: { HandAnalysis.scale($0) < HandAnalysis.scale($1) }) else {
            if isPinching { out.events.append(.pinchEnd); isPinching = false }
            pinchTrail = []
            advance(key: nil, time: t, hands: valid, into: &out)
            return out
        }

        // Pinch (with hysteresis) drives the pointer and flicks.
        let d = HandAnalysis.pinchDistance(primary)
        if !isPinching && d < tuning.pinchStart {
            isPinching = true
            out.events.append(.pinchStart)
        } else if isPinching && d > tuning.pinchEnd {
            isPinching = false
            pinchTrail = []
            out.events.append(.pinchEnd)
        }
        let tip = primary[Hand.indexTip], thumb = primary[Hand.thumbTip]
        out.pointer = isPinching
            ? PointerSample(x: (tip.x + thumb.x) / 2, y: (tip.y + thumb.y) / 2, pinching: true)
            : PointerSample(x: tip.x, y: tip.y, pinching: false)

        if isPinching, let p = out.pointer {
            pinchTrail.append((t, p.x))
            pinchTrail.removeAll { t - $0.t > 0.25 }
            if let first = pinchTrail.first, t - first.t > 0.04, t - lastFlick > tuning.flickCooldown {
                let dx = p.x - first.x
                if abs(dx) > tuning.flickDistance && abs(dx) / (t - first.t) > tuning.flickSpeed {
                    out.events.append(.flick(direction: dx > 0 ? 1 : -1))
                    lastFlick = t
                    pinchTrail = []
                }
            }
        }

        // Static poses (not while pinching).
        let pose = HandAnalysis.pose(primary)
        out.pose = pose
        var key: Key?
        if !isPinching {
            if valid.count >= 2 {
                let poses = valid.prefix(2).map(HandAnalysis.pose)
                let lLike = poses.allSatisfy { $0 == .lShape || $0 == .point }
                if lLike && poses.contains(.lShape) && HandAnalysis.frameBox(valid[0], valid[1]) != nil { key = .frame }
            }
            if key == nil {
                switch pose {
                case .palm: key = .palm
                case .thumbsUp: key = .thumbsUp
                case .point, .lShape: key = choosingMode ? .fingers(1) : .point
                case let .fingers(n): key = .fingers(n)
                default: key = nil
                }
            }
        }
        advance(key: key, time: t, hands: valid, into: &out)
        return out
    }

    private mutating func advance(key: Key?, time t: TimeInterval, hands: [Hand], into out: inout Output) {
        if key == nil {
            if candidate != nil && t - candidateLastSeen > tuning.dropoutTolerance {
                candidate = nil
                candidateFired = false
            }
            return
        }
        if key != candidate {
            candidate = key
            candidateSince = t
            candidateFired = false
        }
        candidateLastSeen = t
        guard let key, !candidateFired, t - candidateSince >= hold(for: key) else { return }
        if let last = lastFired[key], t - last < tuning.cooldown { return }

        let event: GestureEvent?
        switch key {
        case .point:
            event = hands.max(by: { HandAnalysis.scale($0) < HandAnalysis.scale($1) }).map { .point(HandAnalysis.pointBox($0)) }
        case .frame:
            event = hands.count >= 2 ? HandAnalysis.frameBox(hands[0], hands[1]).map { .frame($0) } : nil
        case .palm: event = .palm
        case .thumbsUp: event = .thumbsUp
        case let .fingers(n): event = .fingers(n)
        }
        guard let event else { return }
        candidateFired = true
        lastFired[key] = t
        out.events.append(event)
    }

    private func hold(for key: Key) -> Double {
        switch key {
        case .point: tuning.pointHold
        case .frame: tuning.frameHold
        case .palm: tuning.palmHold
        case .thumbsUp: tuning.thumbsUpHold
        case .fingers: tuning.fingersHold
        }
    }
}
