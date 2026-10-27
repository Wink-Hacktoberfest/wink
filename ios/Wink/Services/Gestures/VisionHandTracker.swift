import Foundation
import Vision

/// Fallback tracker using Apple Vision (no model file). Maps Vision joints onto MediaPipe's 21-point layout.
nonisolated final class VisionHandTracker: HandTracker, @unchecked Sendable {
    private static let order: [VNHumanHandPoseObservation.JointName] = [
        .wrist,
        .thumbCMC, .thumbMP, .thumbIP, .thumbTip,
        .indexMCP, .indexPIP, .indexDIP, .indexTip,
        .middleMCP, .middlePIP, .middleDIP, .middleTip,
        .ringMCP, .ringPIP, .ringDIP, .ringTip,
        .littleMCP, .littlePIP, .littleDIP, .littleTip,
    ]

    func detect(_ frame: Frame) -> [Hand] {
        let request = VNDetectHumanHandPoseRequest()
        request.maximumHandCount = 2
        let handler = VNImageRequestHandler(cgImage: frame.image, orientation: .up)
        guard (try? handler.perform([request])) != nil, let observations = request.results else { return [] }
        return observations.compactMap { obs in
            guard let points = try? obs.recognizedPoints(.all) else { return nil }
            var landmarks: [Landmark] = []
            for joint in Self.order {
                guard let p = points[joint], p.confidence > 0.2 else { return nil }
                landmarks.append(Landmark(x: Double(p.location.x), y: 1 - Double(p.location.y)))
            }
            let side: Handedness = switch obs.chirality {
            case .left: .left
            case .right: .right
            default: .unknown
            }
            return Hand(landmarks: landmarks, handedness: side)
        }
    }
}
