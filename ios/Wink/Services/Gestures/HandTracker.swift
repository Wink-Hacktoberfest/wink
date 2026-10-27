import CoreGraphics
import Foundation

nonisolated struct Landmark: Sendable, Equatable {
    var x: Double   // 0..1, left → right in the image
    var y: Double   // 0..1, top → bottom
    var z: Double = 0

    func distance(to o: Landmark) -> Double { hypot(x - o.x, y - o.y) }
}

nonisolated enum Handedness: String, Sendable { case left, right, unknown }

/// 21 MediaPipe hand landmarks, normalized to the frame.
nonisolated struct Hand: Sendable, Equatable {
    var landmarks: [Landmark]
    var handedness: Handedness

    static let wrist = 0
    static let thumbCMC = 1, thumbMCP = 2, thumbIP = 3, thumbTip = 4
    static let indexMCP = 5, indexPIP = 6, indexDIP = 7, indexTip = 8
    static let middleMCP = 9, middlePIP = 10, middleTip = 12
    static let ringMCP = 13, ringPIP = 14, ringTip = 16
    static let pinkyMCP = 17, pinkyPIP = 18, pinkyTip = 20

    subscript(_ i: Int) -> Landmark { landmarks[i] }

    /// Bone segments for drawing.
    static let connections: [(Int, Int)] = [
        (0, 1), (1, 2), (2, 3), (3, 4),
        (0, 5), (5, 6), (6, 7), (7, 8),
        (5, 9), (9, 10), (10, 11), (11, 12),
        (9, 13), (13, 14), (14, 15), (15, 16),
        (13, 17), (0, 17), (17, 18), (18, 19), (19, 20),
    ]
}

/// Detects hands in a frame. Called off the main actor, one frame at a time.
nonisolated protocol HandTracker: AnyObject, Sendable {
    func detect(_ frame: Frame) -> [Hand]
}
