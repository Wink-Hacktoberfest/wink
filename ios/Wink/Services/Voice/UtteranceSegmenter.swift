@preconcurrency import AVFoundation
import Foundation
import os

/// Runs on the audio thread: converts mic buffers to 16 kHz mono and cuts utterances with a simple energy VAD.
nonisolated final class UtteranceSegmenter: @unchecked Sendable {
    static let sampleRate: Double = 16_000

    struct Tuning {
        var startThreshold: Float = 0.015     // RMS that counts as speech
        var stopThreshold: Float = 0.008      // RMS below which it's silence
        var minSpeech: Double = 0.35          // seconds of speech before we keep an utterance
        var endSilence: Double = 0.7          // trailing silence that ends an utterance
        var maxUtterance: Double = 9          // hard cap
        var preRoll: Double = 0.3             // audio kept from before speech started
    }

    private let lock = OSAllocatedUnfairLock()
    private var tuning = Tuning()
    private var converter: AVAudioConverter?
    private var inputFormat: AVAudioFormat?
    private let outputFormat = AVAudioFormat(commonFormat: .pcmFormatFloat32, sampleRate: sampleRate, channels: 1, interleaved: false)!

    private var preRoll: [Float] = []
    private var current: [Float] = []
    private var inSpeech = false
    private var speechSamples = 0
    private var silenceSamples = 0
    private var pushToTalk = false
    private var muted = false

    private var _level: Float = 0
    /// Latest RMS level, for a UI meter.
    var level: Float { lock.withLock { _level } }

    /// Called (on the audio thread) with a finished utterance; `pushToTalk` tells which path produced it.
    var onUtterance: (@Sendable (_ samples: [Float], _ pushToTalk: Bool) -> Void)?

    func setMuted(_ value: Bool) {
        lock.withLock {
            muted = value
            if value && !pushToTalk { resetLocked() }
        }
    }

    func beginPushToTalk() {
        lock.withLock {
            resetLocked()
            pushToTalk = true
        }
    }

    func endPushToTalk() {
        let samples: [Float] = lock.withLock {
            guard pushToTalk else { return [] }
            pushToTalk = false
            let s = current
            resetLocked()
            return s
        }
        if samples.count > Int(Self.sampleRate * 0.3) { onUtterance?(samples, true) }
    }

    func process(_ buffer: AVAudioPCMBuffer) {
        guard let samples = convert(buffer), !samples.isEmpty else { return }
        var rms: Float = 0
        for s in samples { rms += s * s }
        rms = sqrt(rms / Float(samples.count))

        var finished: [Float]?
        lock.withLock {
            _level = rms
            if pushToTalk {
                current.append(contentsOf: samples)
                if Double(current.count) > Self.sampleRate * 15 { current.removeFirst(samples.count) }
                return
            }
            if muted { return }
            let t = tuning
            if !inSpeech {
                preRoll.append(contentsOf: samples)
                let maxPre = Int(Self.sampleRate * t.preRoll)
                if preRoll.count > maxPre { preRoll.removeFirst(preRoll.count - maxPre) }
                if rms > t.startThreshold {
                    inSpeech = true
                    current = preRoll
                    speechSamples = samples.count
                    silenceSamples = 0
                }
                return
            }
            current.append(contentsOf: samples)
            if rms < t.stopThreshold {
                silenceSamples += samples.count
            } else {
                silenceSamples = 0
                speechSamples += samples.count
            }
            let ended = Double(silenceSamples) / Self.sampleRate >= t.endSilence
            let capped = Double(current.count) / Self.sampleRate >= t.maxUtterance
            if ended || capped {
                if Double(speechSamples) / Self.sampleRate >= t.minSpeech { finished = current }
                resetLocked()
            }
        }
        if let finished { onUtterance?(finished, false) }
    }

    private func resetLocked() {
        current = []
        preRoll = []
        inSpeech = false
        speechSamples = 0
        silenceSamples = 0
    }

    private func convert(_ buffer: AVAudioPCMBuffer) -> [Float]? {
        if inputFormat != buffer.format {
            inputFormat = buffer.format
            converter = AVAudioConverter(from: buffer.format, to: outputFormat)
        }
        guard let converter else { return nil }
        let ratio = outputFormat.sampleRate / buffer.format.sampleRate
        let capacity = AVAudioFrameCount(Double(buffer.frameLength) * ratio) + 32
        guard let out = AVAudioPCMBuffer(pcmFormat: outputFormat, frameCapacity: capacity) else { return nil }
        var consumed = false
        var error: NSError?
        converter.convert(to: out, error: &error) { _, status in
            if consumed {
                status.pointee = .noDataNow
                return nil
            }
            consumed = true
            status.pointee = .haveData
            return buffer
        }
        guard error == nil, let data = out.floatChannelData else { return nil }
        return Array(UnsafeBufferPointer(start: data[0], count: Int(out.frameLength)))
    }
}
