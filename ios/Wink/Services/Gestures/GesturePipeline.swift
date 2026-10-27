import Foundation

/// Hand tracking + gesture classification on its own executor, off the main actor.
actor GesturePipeline {
    struct Result: Sendable {
        var hands: [Hand]
        var output: GestureClassifier.Output
    }

    private let tracker: (any HandTracker)?
    private var classifier = GestureClassifier()
    nonisolated let trackerName: String

    init() {
        if let mp = try? MediaPipeHandTracker() {
            tracker = mp
            trackerName = "MediaPipe"
        } else {
            tracker = VisionHandTracker()
            trackerName = "Apple Vision"
        }
    }

    func process(_ frame: Frame, choosing: Bool) -> Result {
        guard let tracker else { return Result(hands: [], output: .init()) }
        classifier.choosingMode = choosing
        let hands = tracker.detect(frame)
        let output = classifier.update(hands: hands, time: frame.timestamp)
        return Result(hands: hands, output: output)
    }

    func reset() { classifier.reset() }
}
