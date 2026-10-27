import XCTest
@testable import Wink

final class IntentParserTests: XCTestCase {
    func testSaveWithNote() {
        XCTAssertEqual(IntentParser.parse("save this it's the wine sam liked"), .save(note: "the wine sam liked"))
        XCTAssertEqual(IntentParser.parse("Save this."), .save(note: nil))
        XCTAssertEqual(IntentParser.parse("remember this"), .save(note: nil))
    }

    func testGlanceAskNearby() {
        XCTAssertEqual(IntentParser.parse("what's this?"), .glance)
        XCTAssertEqual(IntentParser.parse("what was that book?"), .ask(question: "what was that book"))
        XCTAssertEqual(IntentParser.parse("where can I get this nearby"), .nearby(query: nil))
        XCTAssertEqual(IntentParser.parse("where can I buy oat milk near me"), .nearby(query: "oat milk"))
    }

    func testControlIntents() {
        XCTAssertEqual(IntentParser.parse("forget that"), .forget)
        XCTAssertEqual(IntentParser.parse("pause"), .pause)
        XCTAssertEqual(IntentParser.parse("resume"), .resume)
        XCTAssertEqual(IntentParser.parse("show my memories"), .showMemories)
    }

    func testWakePhraseVariants() {
        XCTAssertEqual(WakePhrase.command(in: "Hey Wink, save this."), "save this")
        XCTAssertEqual(WakePhrase.command(in: "Hey, wink. What was that book?"), "what was that book")
        XCTAssertEqual(WakePhrase.command(in: "Hey wing what's this"), "what's this")
        XCTAssertEqual(WakePhrase.command(in: "okay wink pause"), "pause")
        XCTAssertEqual(WakePhrase.command(in: "Hey Winky"), "")
        XCTAssertNil(WakePhrase.command(in: "I was thinking about a winkle"))
        XCTAssertNil(WakePhrase.command(in: "the weather is nice today"))
    }
}
