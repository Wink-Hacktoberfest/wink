import Foundation
import MediaPipeTasksVision
import os
import UIKit

/// MediaPipe HandLandmarker in video mode, up to two hands. Model: Resources/hand_landmarker.task.
nonisolated final class MediaPipeHandTracker: HandTracker, @unchecked Sendable {
    private let landmarker: HandLandmarker
    private let lock = OSAllocatedUnfairLock()
    private var lastTimestamp = 0

    init() throws {
        guard let path = Bundle.main.path(forResource: "hand_landmarker", ofType: "task") else {
            throw NSError(domain: "Wink", code: 1, userInfo: [NSLocalizedDescriptionKey: "hand_landmarker.task missing from bundle"])
        }
        let options = HandLandmarkerOptions()
        options.baseOptions.modelAssetPath = path
        options.runningMode = .video
        options.numHands = 2
        options.minHandDetectionConfidence = 0.5
        options.minHandPresenceConfidence = 0.5
        options.minTrackingConfidence = 0.5
        landmarker = try HandLandmarker(options: options)
    }

    func detect(_ frame: Frame) -> [Hand] {
        lock.withLock {
            guard let image = try? MPImage(uiImage: UIImage(cgImage: frame.image)) else { return [] }
            // Video mode needs strictly increasing timestamps.
            var ts = Int(frame.timestamp * 1000)
            if ts <= lastTimestamp { ts = lastTimestamp + 1 }
            lastTimestamp = ts
            guard let result = try? landmarker.detect(videoFrame: image, timestampInMilliseconds: ts) else { return [] }
            return result.landmarks.enumerated().map { index, points in
                let name = index < result.handedness.count ? result.handedness[index].first?.categoryName?.lowercased() : nil
                return Hand(
                    landmarks: points.map { Landmark(x: Double($0.x), y: Double($0.y), z: Double($0.z)) },
                    handedness: name == "left" ? .left : name == "right" ? .right : .unknown
                )
            }
        }
    }
}
