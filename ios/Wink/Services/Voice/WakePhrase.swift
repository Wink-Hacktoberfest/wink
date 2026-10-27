import Foundation

/// Fuzzy "Hey Wink" detection on Whisper transcripts.
nonisolated enum WakePhrase {
    /// Variants Whisper produces for "hey wink", longest first so "hey winky" beats "hey wink".
    static let variants: [String] = [
        "hey winky", "hey wink", "hey winks", "hey wing", "hey link", "hey wynk", "hey winc", "hey weenk",
        "hey quink", "hey blink", "hay wink", "hi wink", "a wink", "okay wink", "ok wink", "hey wake",
        "heywink", "hey, wink",
    ].sorted { $0.count > $1.count }

    /// Lowercases, drops punctuation, collapses whitespace.
    static func normalize(_ text: String) -> String {
        let lowered = text.lowercased().replacingOccurrences(of: "’", with: "'")
        let kept = lowered.unicodeScalars.map { scalar -> Character in
            if CharacterSet.alphanumerics.contains(scalar) || scalar == "'" { return Character(scalar) }
            return " "
        }
        return String(kept).split(whereSeparator: \.isWhitespace).joined(separator: " ")
    }

    /// If the utterance contains the wake phrase near its start, returns the command after it (may be empty).
    static func command(in transcript: String) -> String? {
        let text = normalize(transcript)
        guard !text.isEmpty else { return nil }
        for variant in variants {
            let v = normalize(variant)
            guard let range = text.range(of: v) else { continue }
            // Must start within the first ~2 filler words ("um hey wink …"), on a word boundary.
            let prefix = text[text.startIndex..<range.lowerBound]
            guard prefix.split(separator: " ").count <= 2 else { continue }
            if range.upperBound < text.endIndex, text[range.upperBound] != " " { continue }
            return String(text[range.upperBound...]).trimmingCharacters(in: .whitespaces)
        }
        return nil
    }
}
