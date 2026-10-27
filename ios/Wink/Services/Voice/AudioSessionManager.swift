import AVFoundation
import Foundation

/// Routes audio through the glasses: Bluetooth HFP for the mic, A2DP/HFP for speech, speaker as fallback.
enum AudioSessionManager {
    static func configure() throws {
        let session = AVAudioSession.sharedInstance()
        try session.setCategory(.playAndRecord, mode: .default,
                                options: [.allowBluetooth, .allowBluetoothA2DP, .defaultToSpeaker])
        try session.setPreferredSampleRate(16_000)
        try session.setActive(true, options: [])
        preferBluetoothInput()
    }

    /// Picks the glasses (HFP) mic when one is connected, otherwise the iPhone's own mic.
    /// The glasses camera stream can take over the Bluetooth link and drop HFP, which would leave no input at all.
    static func preferBluetoothInput() {
        let session = AVAudioSession.sharedInstance()
        let inputs = session.availableInputs ?? []
        if let bt = inputs.first(where: { $0.portType == .bluetoothHFP }) {
            try? session.setPreferredInput(bt)
        } else if let builtIn = inputs.first(where: { $0.portType == .builtInMic }) {
            try? session.setPreferredInput(builtIn)
        }
    }

    static func requestMicPermission() async -> Bool {
        await AVAudioApplication.requestRecordPermission()
    }

    static var routeDescription: String {
        let route = AVAudioSession.sharedInstance().currentRoute
        let input = route.inputs.first?.portName ?? "none"
        let output = route.outputs.first?.portName ?? "none"
        return "in: \(input) · out: \(output)"
    }
}
