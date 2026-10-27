import Foundation
@preconcurrency import WhisperKit

/// Owns the WhisperKit pipeline (non-Sendable) and serializes access to it.
actor WhisperTranscriber {
    /// Small English model: fast enough for wake-word utterances on device.
    nonisolated static let variant = "openai_whisper-base.en"
    nonisolated static let repo = "argmaxinc/whisperkit-coreml"

    nonisolated static var downloadBase: URL {
        URL.applicationSupportDirectory.appending(path: "WhisperKit", directoryHint: .isDirectory)
    }

    private final class Box: @unchecked Sendable {
        let pipe: WhisperKit
        init(_ pipe: WhisperKit) { self.pipe = pipe }
    }

    private var box: Box?

    var isLoaded: Bool { box != nil }

    /// Downloads (first launch only) and loads the model. `progress` gets 0...1 during download.
    func load(progress: @escaping @Sendable (Double) -> Void) async throws {
        guard box == nil else { return }
        let base = Self.downloadBase
        try FileManager.default.createDirectory(at: base, withIntermediateDirectories: true)
        let folder = try await WhisperKit.download(variant: Self.variant, downloadBase: base, from: Self.repo) { p in
            progress(p.fractionCompleted)
        }
        progress(1)
        let config = WhisperKitConfig(
            model: Self.variant,
            downloadBase: base,
            modelRepo: Self.repo,
            modelFolder: folder.path,
            tokenizerFolder: base,
            verbose: false,
            prewarm: true,
            load: true,
            download: false
        )
        box = Box(try await WhisperKit(config))
    }

    /// 16 kHz mono float samples → text.
    func transcribe(_ samples: [Float]) async throws -> String {
        guard let pipe = box?.pipe else { return "" }
        let options = DecodingOptions(
            verbose: false,
            task: .transcribe,
            language: "en",
            temperature: 0,
            usePrefillPrompt: true,
            skipSpecialTokens: true,
            withoutTimestamps: true
        )
        let results = try await pipe.transcribe(audioArray: samples, decodeOptions: options)
        return results.map(\.text).joined(separator: " ")
            .replacingOccurrences(of: "[BLANK_AUDIO]", with: "")
            .trimmingCharacters(in: .whitespacesAndNewlines)
    }
}
