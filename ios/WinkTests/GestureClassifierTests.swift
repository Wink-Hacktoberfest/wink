import XCTest
@testable import Wink

/// Builds synthetic hands: wrist at the bottom, fingers pointing up (toward smaller y).
enum HandFactory {
    static func hand(at origin: (Double, Double) = (0.5, 0.7), scale s: Double = 0.1,
                     index: Bool, middle: Bool, ring: Bool, pinky: Bool, thumb: Bool,
                     thumbUp: Bool = false, pinch: Bool = false) -> Hand {
        var lm = Array(repeating: Landmark(x: 0, y: 0), count: 21)
        let (ox, oy) = origin
        func p(_ dx: Double, _ dy: Double) -> Landmark { Landmark(x: ox + dx * s, y: oy + dy * s) }
        lm[0] = p(0, 0)
        // Finger columns: index, middle, ring, pinky at x offsets.
        let columns: [(Int, Double, Bool)] = [(5, -0.35, index), (9, 0, middle), (13, 0.3, ring), (17, 0.55, pinky)]
        for (mcp, dx, extended) in columns {
            lm[mcp] = p(dx, -1)
            lm[mcp + 1] = p(dx, -1.4)
            if extended {
                lm[mcp + 2] = p(dx, -1.7)
                lm[mcp + 3] = p(dx, -2.0)
            } else {
                lm[mcp + 2] = p(dx, -1.2)
                lm[mcp + 3] = p(dx, -0.8)   // tip curled back toward the palm
            }
        }
        lm[1] = p(-0.4, -0.3)
        lm[2] = p(-0.7, -0.5)
        if thumbUp {
            lm[3] = p(-0.8, -1.2); lm[4] = p(-0.85, -1.8)
        } else if thumb {
            lm[3] = p(-1.0, -0.6); lm[4] = p(-1.4, -0.7)   // out to the side → L with the index
        } else {
            lm[3] = p(-0.5, -0.8); lm[4] = p(-0.2, -0.9)   // tucked across the palm
        }
        if pinch { lm[4] = Landmark(x: lm[8].x + 0.005, y: lm[8].y + 0.005) }
        return Hand(landmarks: lm, handedness: .right)
    }
}

final class GestureClassifierTests: XCTestCase {
    func testPoses() {
        XCTAssertEqual(HandAnalysis.pose(HandFactory.hand(index: true, middle: false, ring: false, pinky: false, thumb: false)), .point)
        XCTAssertEqual(HandAnalysis.pose(HandFactory.hand(index: true, middle: true, ring: true, pinky: true, thumb: true)), .palm)
        XCTAssertEqual(HandAnalysis.pose(HandFactory.hand(index: true, middle: false, ring: false, pinky: false, thumb: true)), .lShape)
        XCTAssertEqual(HandAnalysis.pose(HandFactory.hand(index: false, middle: false, ring: false, pinky: false, thumb: true, thumbUp: true)), .thumbsUp)
        XCTAssertEqual(HandAnalysis.pose(HandFactory.hand(index: true, middle: true, ring: false, pinky: false, thumb: false)), .fingers(2))
    }

    func testPointFiresOnceAfterHold() {
        var c = GestureClassifier()
        let hand = HandFactory.hand(index: true, middle: false, ring: false, pinky: false, thumb: false)
        var fired: [GestureEvent] = []
        for i in 0..<30 { fired += c.update(hands: [hand], time: Double(i) * 0.05).events }
        let points = fired.filter { if case .point = $0 { true } else { false } }
        XCTAssertEqual(points.count, 1)
        if case let .point(box) = points.first {
            XCTAssertEqual(box.w, 0.35, accuracy: 0.001)
            XCTAssertLessThan(box.midY, 0.5, "box should sit above the fingertip (finger points up)")
        }
    }

    func testPalmNeedsLongerHold() {
        var c = GestureClassifier()
        let palm = HandFactory.hand(index: true, middle: true, ring: true, pinky: true, thumb: true)
        var events: [GestureEvent] = []
        for i in 0..<10 { events += c.update(hands: [palm], time: Double(i) * 0.05).events } // 0.45 s
        XCTAssertFalse(events.contains(.palm))
        for i in 10..<20 { events += c.update(hands: [palm], time: Double(i) * 0.05).events }
        XCTAssertEqual(events.filter { $0 == .palm }.count, 1)
    }

    func testTwoHandFrame() {
        var c = GestureClassifier()
        let a = HandFactory.hand(at: (0.25, 0.8), index: true, middle: false, ring: false, pinky: false, thumb: true)
        let b = HandFactory.hand(at: (0.75, 0.4), index: true, middle: false, ring: false, pinky: false, thumb: true)
        var events: [GestureEvent] = []
        for i in 0..<20 { events += c.update(hands: [a, b], time: Double(i) * 0.05).events }
        XCTAssertTrue(events.contains { if case .frame = $0 { true } else { false } })
    }

    func testPinchPointerAndFlick() {
        var c = GestureClassifier()
        var events: [GestureEvent] = []
        var lastPointer: PointerSample?
        for i in 0..<6 {
            let h = HandFactory.hand(at: (0.3 + Double(i) * 0.06, 0.7), index: true, middle: false, ring: false, pinky: false, thumb: false, pinch: true)
            let out = c.update(hands: [h], time: Double(i) * 0.03)
            events += out.events
            lastPointer = out.pointer
        }
        XCTAssertTrue(events.contains(.pinchStart))
        XCTAssertEqual(lastPointer?.pinching, true)
        XCTAssertTrue(events.contains(.flick(direction: 1)))
    }
}
