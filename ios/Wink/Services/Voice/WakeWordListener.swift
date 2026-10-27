@preconcurrency import AVFoundation
import Foundation
import Observation

/// Always-on "Hey Wink" listener: mic → energy VAD → WhisperKit → wake-phrase match → command text.
/// Also offers push-to-talk (no wake word) and a short follow-up window after a bare "Hey Wink".
@Observable
final class WakeWordListener {
    enum ModelState: Equatable {
        case notLoaded
        case downloading(Double)
        case loading
        case ready
        case failed(String)

        var label: String {
            switch self {
            case .notLoaded: "Model not loaded"
            case let .downloading(p): "Downloading Whisper \(Int(p * 100))%"
            case .loading: "Loading Whisper…"
            case .ready: "Whisper ready"
            case let .failed(msg): "Whisper failed: \(msg)"
            }
        }
    }

    private(set) var modelState: ModelState = .notLoaded
    private(set) var isListening = false
    private(set) var isPushToTalkActive = false
    private(set) var isTranscribing = false
    private(set) var lastHeard = ""
    private(set) var level: Float = 0
    private(set) var micError: String?

    /// While true (e.g. Wink is speaking) VAD utterances are ignored so Wink doesn't hear itself.
    var isMuted = false {
        didSet { segmenter.setMuted(isMuted) }
    }

    /// (command text after the wake phrase, full raw transcript)
    @ObservationIgnored var onCommand: ((_ command: String, _ raw: String) -> Void)?
    /// Bare "Hey Wink" with nothing after it.
    @ObservationIgnored var onWakeOnly: (() -> Void)?
    /// Called the moment an utterance is captured and sent to Whisper.
    @ObservationIgnored var onUtteranceCaptured: (() -> Void)?

    @ObservationIgnored private let engine = AVAudioEngine()
    @ObservationIgnored private let segmenter = UtteranceSegmenter()
    @ObservationIgnored private let transcriber = WhisperTranscriber()
    @ObservationIgnored private var followUpUntil: Date?
    @ObservationIgnored private var levelTimer: Timer?

    /// Download + load the Whisper model. Safe to call repeatedly.
    func preloadModel() {
        switch modelState {
        case .downloading, .loading, .ready: return
        default: break
        }
        modelState = .downloading(0)
        Task {
            do {
                try await transcriber.load { p in
                    Task { @MainActor [weak self] in
                        guard let self else { return }
                        if p >= 1 { self.modelState = .loading } else if case .downloading = self.modelState { self.modelState = .downloading(p) }
                    }
                }
                modelState = .ready
            } catch {
                modelState = .failed(error.localizedDescription)
            }
        }
    }

    func start() {
        guard !isListening else { return }
        segmenter.onUtterance = { [weak self] samples, ptt in
            Task { @MainActor in self?.handle(samples: samples, pushToTalk: ptt) }
        }
        let input = engine.inputNode
        let format = input.outputFormat(forBus: 0)
        guard format.sampleRate > 0, format.channelCount > 0 else {
            micError = "No microphone input available"
            return
        }
        let segmenter = self.segmenter
        input.removeTap(onBus: 0)
        input.installTap(onBus: 0, bufferSize: 4096, format: format) { buffer, _ in
            segmenter.process(buffer)
        }
        do {
            engine.prepare()
            try engine.start()
            isListening = true
            micError = nil
        } catch {
            micError = error.localizedDescription
            input.removeTap(onBus: 0)
        }
        levelTimer?.invalidate()
        levelTimer = Timer.scheduledTimer(withTimeInterval: 0.1, repeats: true) { [weak self] _ in
            Task { @MainActor in
                guard let self else { return }
                self.level = self.segmenter.level
            }
        }
    }

    func stop() {
        engine.inputNode.removeTap(onBus: 0)
        engine.stop()
        isListening = false
        levelTimer?.invalidate()
        levelTimer = nil
    }

    /// Restart after an audio route change (glasses connected/disconnected).
    func restart() {
        stop()
        start()
    }

    func beginPushToTalk() {
        isPushToTalkActive = true
        segmenter.beginPushToTalk()
    }

    func endPushToTalk() {
        isPushToTalkActive = false
        segmenter.endPushToTalk()
    }

    /// The next utterance within `seconds` is treated as a command without the wake word.
    func armFollowUp(seconds: Double = 6) {
        followUpUntil = Date().addingTimeInterval(seconds)
    }

    /// Feed text as if heard (for typing commands in the simulator).
    func simulate(_ text: String) {
        route(transcript: text, pushToTalk: false)
    }

    private func handle(samples: [Float], pushToTalk: Bool) {
        guard modelState == .ready else { return }
        onUtteranceCaptured?()
        isTranscribing = true
        Task {
            let text = (try? await transcriber.transcribe(samples)) ?? ""
            isTranscribing = false
            route(transcript: text, pushToTalk: pushToTalk)
        }
    }

    private func route(transcript text: String, pushToTalk: Bool) {
        let cleaned = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !cleaned.isEmpty else { return }
        lastHeard = cleaned
        if pushToTalk {
            onCommand?(WakePhrase.command(in: cleaned) ?? cleaned, cleaned)
            return
        }
        if let command = WakePhrase.command(in: cleaned) {
            if command.isEmpty {
                armFollowUp()
                onWakeOnly?()
            } else {
                followUpUntil = nil
                onCommand?(command, cleaned)
            }
            return
        }
        if let until = followUpUntil, until > Date() {
            followUpUntil = nil
            onCommand?(cleaned, cleaned)
        }
    }
}
