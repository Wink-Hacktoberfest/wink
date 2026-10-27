import AudioToolbox
import AVFoundation
import Foundation
import Observation

/// Speaks replies into the glasses (current audio route) and plays short earcons.
@Observable
final class SpeechOut: NSObject, AVSpeechSynthesizerDelegate, AVAudioPlayerDelegate {
    enum Earcon: SystemSoundID {
        case heard = 1113     // begin-listening chime
        case saved = 1407     // payment-success style chirp
        case gesture = 1104   // tick
        case error = 1073
        case thinking = 1103
    }

    private(set) var isSpeaking = false
    private(set) var lastSpoken = ""

    @ObservationIgnored private let synthesizer = AVSpeechSynthesizer()
    @ObservationIgnored private var continuation: CheckedContinuation<Void, Never>?
    @ObservationIgnored private let voice = AVSpeechSynthesisVoice(language: "en-US")
    @ObservationIgnored private var player: AVAudioPlayer?
    /// Fetches natural-voice MP3 for a reply; nil or a failure falls back to the built-in voice.
    @ObservationIgnored var audioProvider: ((String) async -> Data?)?

    override init() {
        super.init()
        synthesizer.delegate = self
        synthesizer.usesApplicationAudioSession = true
    }

    /// Speaks and returns when finished (or interrupted).
    func speak(_ text: String) async {
        let text = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !text.isEmpty else { return }
        stop()
        lastSpoken = text
        isSpeaking = true
        if let provider = audioProvider, let data = await provider(text), await play(mp3: data) {
            isSpeaking = false
            return
        }
        let utterance = AVSpeechUtterance(string: text)
        utterance.voice = voice
        utterance.rate = AVSpeechUtteranceDefaultSpeechRate * 1.05
        await withCheckedContinuation { (c: CheckedContinuation<Void, Never>) in
            continuation = c
            synthesizer.speak(utterance)
        }
        isSpeaking = false
    }

    func stop() {
        if synthesizer.isSpeaking { synthesizer.stopSpeaking(at: .immediate) }
        player?.stop()
        player = nil
        finish()
    }

    /// Plays MP3 on the current route (the glasses when connected); false if it can't be decoded or played.
    private func play(mp3 data: Data) async -> Bool {
        guard let player = try? AVAudioPlayer(data: data) else { return false }
        player.delegate = self
        self.player = player
        guard player.play() else { self.player = nil; return false }
        await withCheckedContinuation { (c: CheckedContinuation<Void, Never>) in
            continuation = c
        }
        self.player = nil
        return true
    }

    nonisolated func audioPlayerDidFinishPlaying(_ player: AVAudioPlayer, successfully flag: Bool) {
        Task { @MainActor in self.finish() }
    }

    nonisolated func audioPlayerDecodeErrorDidOccur(_ player: AVAudioPlayer, error: Error?) {
        Task { @MainActor in self.finish() }
    }

    func play(_ earcon: Earcon) {
        AudioServicesPlaySystemSound(earcon.rawValue)
    }

    private func finish() {
        continuation?.resume()
        continuation = nil
    }

    nonisolated func speechSynthesizer(_ synthesizer: AVSpeechSynthesizer, didFinish utterance: AVSpeechUtterance) {
        Task { @MainActor in self.finish() }
    }

    nonisolated func speechSynthesizer(_ synthesizer: AVSpeechSynthesizer, didCancel utterance: AVSpeechUtterance) {
        Task { @MainActor in self.finish() }
    }
}
