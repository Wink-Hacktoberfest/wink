import Foundation

nonisolated enum Intent: Equatable, Sendable {
    case save(note: String?)
    case glance
    case ask(question: String)
    case nearby(query: String?)
    case forget
    case pause
    case resume
    case showMemories
}

/// Command text (after the wake phrase) → intent. Pure Swift; defaults to `.ask`.
nonisolated enum IntentParser {
    static func parse(_ raw: String) -> Intent {
        let text = WakePhrase.normalize(raw)
        let original = raw.trimmingCharacters(in: .whitespacesAndNewlines.union(.punctuationCharacters))

        if matchesAny(text, exact: ["pause", "stop", "stop listening", "go to sleep", "sleep", "pause listening", "be quiet"]) {
            return .pause
        }
        if matchesAny(text, exact: ["resume", "wake up", "start listening", "unpause", "continue", "i'm back"]) {
            return .resume
        }
        if hasPrefix(text, ["forget that", "forget this", "forget it", "delete that", "delete this", "delete it", "forget the last", "remove that"]) {
            return .forget
        }
        if contains(text, ["show my memories", "show memories", "show me my memories", "open memories", "open my memories",
                           "my memories on the tv", "show the memories", "memory wall", "show me everything"]) {
            return .showMemories
        }
        if contains(text, ["nearby", "near me", "near here", "around here", "close by", "closest", "where can i get",
                           "where can i buy", "where can i find", "where do they sell", "where to buy"]) {
            return .nearby(query: nearbyQuery(text))
        }
        if let note = saveNote(text) {
            return .save(note: note.isEmpty ? nil : note)
        }
        if contains(text, ["what's this", "what is this", "whats this", "what's that", "what is that", "whats that",
                           "what am i looking at", "what am i holding", "read this", "what does this say", "what does it say",
                           "describe this", "identify this", "tell me about this", "look at this"]) {
            return .glance
        }
        return .ask(question: original.isEmpty ? text : original)
    }

    // MARK: Helpers

    private static let saveVerbs = ["save this", "save that", "save it", "remember this", "remember that", "remember it",
                                    "keep this", "note this", "capture this", "save", "remember", "bookmark this"]
    private static let noteLeadIns = ["it's ", "its ", "it is ", "this is ", "that's ", "thats ", "that is ", "as ",
                                      "for ", "because ", "called ", "and ", "so ", "please "]

    /// Polite or filler openers Whisper often keeps before the verb: "can you save this", "please remember that".
    private static let saveOpeners = ["can you ", "could you ", "would you ", "will you ", "please ", "go ahead and ",
                                      "i want to ", "i want you to ", "let's ", "lets ", "just ", "hey ", "okay ", "ok ", "uh ", "um "]

    /// Returns the note (possibly empty) if this is a save command.
    static func saveNote(_ input: String) -> String? {
        var text = input
        var stripped = true
        while stripped {
            stripped = false
            for opener in saveOpeners where text.hasPrefix(opener) {
                text = String(text.dropFirst(opener.count)).trimmingCharacters(in: .whitespaces)
                stripped = true
            }
        }
        // A multi-word save phrase anywhere still means save ("i really need you to save this").
        // Questions ("did I save this?", "do you remember that book?") stay questions.
        let questionStarts = ["what", "where", "when", "who", "which", "how", "did", "do", "does", "have", "is", "was", "can i"]
        if !saveVerbs.contains(where: { text == $0 || text.hasPrefix($0 + " ") }),
           !questionStarts.contains(where: { text == $0 || text.hasPrefix($0 + " ") }),
           let verb = saveVerbs.filter({ $0.contains(" ") && !$0.hasPrefix("remember") })
               .first(where: { (" " + text + " ").contains(" " + $0 + " ") }),
           let range = text.range(of: verb) {
            text = String(text[range.lowerBound...])
        }
        for verb in saveVerbs.sorted(by: { $0.count > $1.count }) where text == verb || text.hasPrefix(verb + " ") {
            var rest = String(text.dropFirst(verb.count)).trimmingCharacters(in: .whitespaces)
            var changed = true
            while changed {
                changed = false
                for lead in noteLeadIns where rest.hasPrefix(lead) {
                    rest = String(rest.dropFirst(lead.count)).trimmingCharacters(in: .whitespaces)
                    changed = true
                }
            }
            if ["please", "for me", "now"].contains(rest) { rest = "" }
            return rest
        }
        return nil
    }

    /// "where can I get oat milk nearby" → "oat milk"; "where can I get this nearby" → nil (use the last memory).
    static func nearbyQuery(_ text: String) -> String? {
        var t = " " + text + " "
        for phrase in ["where can i get", "where can i buy", "where can i find", "where do they sell", "where to buy",
                       "find me", "find", "is there", "are there", "nearby", "near me", "near here", "around here",
                       "close by", "closest", "the nearest", "nearest", "a place", "that sells", "to buy", "to get"] {
            t = t.replacingOccurrences(of: " \(phrase) ", with: " ")
        }
        let words = t.split(separator: " ").map(String.init)
        let filler: Set<String> = ["this", "that", "it", "one", "these", "those", "a", "an", "some", "the", "me", "any", "more", "of"]
        let meaningful = words.filter { !filler.contains($0) }
        return meaningful.isEmpty ? nil : words.drop(while: { filler.contains($0) }).joined(separator: " ")
    }

    private static func matchesAny(_ text: String, exact: [String]) -> Bool {
        let trimmed = text.replacingOccurrences(of: " please", with: "")
        return exact.contains(trimmed)
    }

    private static func hasPrefix(_ text: String, _ prefixes: [String]) -> Bool {
        prefixes.contains { text == $0 || text.hasPrefix($0 + " ") }
    }

    private static func contains(_ text: String, _ phrases: [String]) -> Bool {
        let padded = " " + text + " "
        return phrases.contains { padded.contains(" " + $0 + " ") }
    }
}
