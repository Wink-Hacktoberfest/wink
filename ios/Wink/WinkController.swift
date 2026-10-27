import AVFoundation
import CoreGraphics
import Foundation
import Observation

/// Orchestrates camera → gestures, mic → intents, the backend API, the live socket and speech.
@Observable
final class WinkController {
    struct ActiveSelection: Equatable {
        var mode: SelectionMode
        var box: Box
        var at: Date
    }

    enum PendingAction: Equatable {
        case forget(id: String, title: String)

        var prompt: String {
            switch self {
            case let .forget(_, title): "Forget \(title)?"
            }
        }
    }

    // MARK: Dependencies

    let config = WinkConfig.shared
    let liveSocket = LiveSocket()
    let listener = WakeWordListener()
    let speech = SpeechOut()
    let phone = PhoneFrameSource()
    let glasses = GlassesFrameSource()
    @ObservationIgnored let location = LocationProvider()
    @ObservationIgnored private let pipeline = GesturePipeline()

    // MARK: State

    private(set) var state: WinkState = .idle
    private(set) var sourceKind: FrameSourceKind = .phone
    private(set) var preview: CGImage?
    private(set) var hands: [Hand] = []
    private(set) var pose: HandPose?
    private(set) var pointer: PointerSample?
    private(set) var selection: ActiveSelection?
    private(set) var lastGesture: String = "—"
    private(set) var lastTranscript = ""
    private(set) var lastCommand = ""
    private(set) var lastReply = ""
    private(set) var lastError: String?
    private(set) var memories: [Memory] = []
    private(set) var health: HealthResponse?
    private(set) var healthError: String?
    private(set) var pending: PendingAction?
    private(set) var lastPlaces: [Place] = []
    private(set) var cameraError: String?
    var tvPointerMode = false
    var sendFramePreviews = true

    private(set) var lastMemoryId: String?
    var trackerName: String { pipeline.trackerName }

    @ObservationIgnored private var started = false
    @ObservationIgnored private var frameTask: Task<Void, Never>?
    @ObservationIgnored private var gestureBusy = false
    @ObservationIgnored private var placesAt = Date.distantPast
    @ObservationIgnored private var pendingAt = Date.distantPast
    @ObservationIgnored private var lastPinching = false

    static let selectionFreshness: TimeInterval = 3
    static let pendingTimeout: TimeInterval = 12

    var activeSource: any FrameSource { sourceKind == .glasses ? glasses : phone }

    var api: WinkAPIClient? { config.endpoint.map { WinkAPIClient(endpoint: $0) } }

    var freshSelection: ActiveSelection? {
        guard let selection, Date().timeIntervalSince(selection.at) < Self.selectionFreshness else { return nil }
        return selection
    }

    // MARK: Lifecycle

    func start() async {
        guard !started else { return }
        started = true

        // Natural voice from the backend (Aura-2 / ElevenLabs); the built-in voice covers any failure.
        speech.audioProvider = { [weak self] text in
            guard let api = self?.api else { return nil }
            return try? await api.speak(text)
        }

        glasses.observe()
        location.requestPermission()

        listener.onCommand = { [weak self] command, raw in self?.handleCommand(command, raw: raw) }
        listener.onWakeOnly = { [weak self] in self?.handleWakeOnly() }
        listener.onUtteranceCaptured = { [weak self] in self?.setState(.listening) }
        liveSocket.onEvent = { [weak self] event in self?.handleLive(event) }

        do { try AudioSessionManager.configure() } catch { lastError = "Audio: \(error.localizedDescription)" }
        if await AudioSessionManager.requestMicPermission() {
            listener.start()
        } else {
            lastError = "Microphone access is off."
        }
        listener.preloadModel()

        NotificationCenter.default.addObserver(forName: AVAudioSession.routeChangeNotification, object: nil, queue: .main) { [weak self] note in
            let raw = note.userInfo?[AVAudioSessionRouteChangeReasonKey] as? UInt
            let reason = raw.flatMap(AVAudioSession.RouteChangeReason.init(rawValue:))
            // Restart on any real route change; the glasses camera session reroutes Bluetooth without a device change.
            guard reason != .categoryChange, reason != nil else { return }
            Task { @MainActor in
                AudioSessionManager.preferBluetoothInput()
                self?.listener.restart()
            }
        }

        reconnectBackend()
        await startSource(sourceKind)
    }

    func reconnectBackend() {
        liveSocket.connect(config.endpoint)
        Task { await refreshHealth() }
        Task { await refreshMemories() }
    }

    func refreshHealth() async {
        guard let api else { healthError = WinkAPIError.notConfigured.localizedDescription; health = nil; return }
        do {
            health = try await api.health()
            healthError = nil
        } catch {
            health = nil
            healthError = error.localizedDescription
        }
    }

    func refreshMemories() async {
        guard let api else { return }
        do { memories = try await api.memories(limit: 50) } catch { lastError = "Memories: \(error.localizedDescription)" }
    }

    // MARK: Camera

    func switchSource(to kind: FrameSourceKind) async {
        guard kind != sourceKind else { return }
        activeSource.stop()
        sourceKind = kind
        preview = nil
        hands = []
        await startSource(kind)
    }

    private func startSource(_ kind: FrameSourceKind) async {
        frameTask?.cancel()
        let source = activeSource
        cameraError = nil
        do {
            try await source.start()
        } catch {
            cameraError = error.localizedDescription
        }
        let stream = source.frames()
        frameTask = Task { [weak self] in
            for await frame in stream {
                guard let self, !Task.isCancelled else { return }
                self.onFrame(frame)
            }
        }
    }

    private func onFrame(_ frame: Frame) {
        preview = frame.image
        if sendFramePreviews { liveSocket.sendFramePreview(frame.image) }
        guard !gestureBusy else { return }
        gestureBusy = true
        let choosing = !lastPlaces.isEmpty && Date().timeIntervalSince(placesAt) < 30
        Task {
            let result = await pipeline.process(frame, choosing: choosing)
            gestureBusy = false
            apply(result)
        }
    }

    // MARK: Gestures

    private func apply(_ result: GesturePipeline.Result) {
        hands = result.hands
        pose = result.output.pose
        pointer = result.output.pointer
        if tvPointerMode, let p = result.output.pointer {
            liveSocket.sendPointer(x: p.x, y: p.y, pinching: p.pinching, force: p.pinching != lastPinching)
            lastPinching = p.pinching
        }
        for event in result.output.events { handleGesture(event) }
    }

    func handleGesture(_ event: GestureEvent) {
        if state == .paused, event != .palm { return }
        switch event {
        case let .point(box):
            selection = ActiveSelection(mode: .point, box: box, at: Date())
            note(gesture: "Point")
            speech.play(.gesture)
            post(.gesture(.point, value: nil, box: box))
        case let .frame(box):
            selection = ActiveSelection(mode: .frame, box: box, at: Date())
            note(gesture: "Frame")
            speech.play(.gesture)
            post(.gesture(.frame, value: nil, box: box))
            Task { await perform(.save(note: nil), utterance: "") }
        case .palm:
            note(gesture: "Palm")
            post(.gesture(.palm, value: nil, box: nil))
            Task { await perform(state == .paused ? .resume : .pause, utterance: "") }
        case .thumbsUp:
            note(gesture: "Thumbs up")
            post(.gesture(.thumbsUp, value: nil, box: nil))
            Task { await confirmPending() }
        case let .fingers(n):
            note(gesture: "\(n) finger\(n == 1 ? "" : "s")")
            post(.gesture(.fingers, value: Double(n), box: nil))
            if !lastPlaces.isEmpty, n <= lastPlaces.count {
                let place = lastPlaces[n - 1]
                var line = place.name
                if let d = place.distanceMeters { line += ", \(Int(d)) meters away" }
                if let a = place.address { line += ", \(a)" }
                Task { await say(line + ".") }
            }
        case let .flick(direction):
            note(gesture: direction > 0 ? "Flick →" : "Flick ←")
            if tvPointerMode { post(.gesture(.flick, value: Double(direction), box: nil)) }
        case .pinchStart:
            if tvPointerMode { post(.gesture(.pinch, value: 1, box: nil)) }
        case .pinchEnd:
            if tvPointerMode { post(.gesture(.pinch, value: 0, box: nil)) }
        }
    }

    private func note(gesture: String) {
        lastGesture = gesture
    }

    // MARK: Voice

    private func handleWakeOnly() {
        speech.play(.heard)
        Task { await say("Yes?") }
        listener.armFollowUp()
    }

    func handleCommand(_ command: String, raw: String) {
        speech.play(.heard)
        lastTranscript = raw
        lastCommand = command
        post(.transcript(text: raw))
        let intent = IntentParser.parse(command)
        if state == .paused, intent != .resume { return }
        Task { await perform(intent, utterance: raw) }
    }

    /// Typed command (settings/debug) as if it had been said after "Hey Wink".
    func submitTyped(_ text: String) {
        let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return }
        handleCommand(WakePhrase.command(in: trimmed) ?? trimmed, raw: trimmed)
    }

    // MARK: Intents

    func perform(_ intent: Intent, utterance: String) async {
        lastError = nil
        switch intent {
        case .pause:
            tvPointerMode = false
            setState(.paused)
            await say("Paused.", keepState: true)
            return
        case .resume:
            setState(.idle)
            await say("I'm back.")
            return
        case .showMemories:
            tvPointerMode.toggle()
            await say(tvPointerMode ? "Here are your memories. Pinch to point." : "Okay, closing memories.")
            return
        case .forget:
            guard let id = lastMemoryId else { await say("There's nothing to forget yet."); return }
            let title = memories.first(where: { $0.id == id })?.title ?? "that memory"
            pending = .forget(id: id, title: title)
            pendingAt = Date()
            await say("Forget \(title)? Give me a thumbs up.")
            return
        default:
            break
        }

        guard let api else { await fail(WinkAPIError.notConfigured); return }
        setState(.thinking)
        speech.play(.thinking)
        do {
            switch intent {
            case let .save(note):
                let (image, sel) = try await captureCrop()
                let meta = SaveMemoryMeta(utterance: utterance, note: note, selection: sel, kind: .explicit,
                                          source: sourceKind.captureSource, capturedAt: WinkAPIClient.isoNow(),
                                          location: await location.current())
                let response = try await api.saveMemory(image: image, meta: meta)
                lastMemoryId = response.memory.id
                upsert(response.memory)
                selection = nil
                speech.play(.saved)
                await say(response.speech)
            case .glance:
                let (image, _) = try await captureCrop()
                let response = try await api.glance(image: image, meta: GlanceMeta(utterance: utterance, location: await location.current()))
                await say(response.speech)
            case let .ask(question):
                let response = try await api.ask(AskRequest(question: question, location: await location.current()))
                if let first = response.memories.first { lastMemoryId = first.id }
                await say(response.speech)
            case let .nearby(query):
                guard let here = await location.current() else {
                    await say("I need your location to find places nearby.")
                    return
                }
                let memoryId = query == nil ? lastMemoryId : nil
                guard memoryId != nil || query != nil else {
                    await say("Save or ask about something first, then I can find it nearby.")
                    return
                }
                let response = try await api.nearby(NearbyRequest(memoryId: memoryId, query: query, location: here))
                lastPlaces = response.places
                placesAt = Date()
                await say(response.speech)
            default:
                break
            }
        } catch {
            await fail(error)
        }
    }

    func confirmPending() async {
        guard let pending, Date().timeIntervalSince(pendingAt) < Self.pendingTimeout else {
            self.pending = nil
            return
        }
        self.pending = nil
        switch pending {
        case let .forget(id, _):
            guard let api else { await fail(WinkAPIError.notConfigured); return }
            setState(.thinking)
            do {
                try await api.deleteMemory(id: id)
                memories.removeAll { $0.id == id }
                if lastMemoryId == id { lastMemoryId = nil }
                await say("Forgotten.")
            } catch {
                await fail(error)
            }
        }
    }

    func cancelPending() { pending = nil }

    func delete(_ memory: Memory) async {
        guard let api else { return }
        do {
            try await api.deleteMemory(id: memory.id)
            memories.removeAll { $0.id == memory.id }
        } catch {
            lastError = error.localizedDescription
        }
    }

    /// Latest frame cropped to a fresh point/frame selection (else full), off the main actor.
    private func captureCrop() async throws -> (CGImage, Selection) {
        guard let frame = activeSource.latestFrame ?? (sourceKind == .glasses ? phone.latestFrame : nil) else {
            throw CaptureError.noFrame
        }
        let sel: Selection = freshSelection.map { Selection(mode: $0.mode, box: $0.box) } ?? .full
        let image = await Task.detached(priority: .userInitiated) { ImageUtils.crop(frame.image, to: sel.box) }.value
        return (image, sel)
    }

    enum CaptureError: LocalizedError {
        case noFrame
        var errorDescription: String? { "No camera frame yet. Connect the glasses or switch to the phone camera." }
    }

    // MARK: Speech + status

    private func say(_ text: String, keepState: Bool = false) async {
        lastReply = text
        let previous = state
        if !keepState { setState(.speaking, text: text) } else { post(.status(state: state, text: text)) }
        listener.isMuted = true
        await speech.speak(text)
        try? await Task.sleep(for: .milliseconds(250))
        listener.isMuted = false
        if keepState { return }
        setState(previous == .paused ? .paused : .idle)
    }

    private func fail(_ error: Error) async {
        lastError = error.localizedDescription
        speech.play(.error)
        let spoken = (error as? CaptureError) != nil ? "I can't see anything yet." : "Sorry, I couldn't reach Wink."
        await say(spoken)
    }

    private func setState(_ new: WinkState, text: String? = nil) {
        guard new != state || text != nil else { return }
        if state == .paused && new != .idle && new != .paused { return }
        state = new
        post(.status(state: new, text: text))
    }

    /// Discrete events: over the socket when connected, else `POST /v1/events`.
    private func post(_ event: LiveEvent) {
        if liveSocket.send(event) { return }
        guard let api else { return }
        Task { try? await api.postEvent(event) }
    }

    private func upsert(_ memory: Memory) {
        memories.removeAll { $0.id == memory.id }
        memories.insert(memory, at: 0)
    }

    private func handleLive(_ event: LiveEvent) {
        switch event {
        case let .memorySaved(memory): upsert(memory)
        case let .memoryDeleted(id): memories.removeAll { $0.id == id }
        default: break
        }
    }

    // MARK: Glasses

    func connectGlasses() async {
        if !glasses.isRegistered {
            await glasses.register()
            return
        }
        await switchSource(to: .glasses)
        if sourceKind == .glasses, !glasses.isRunning {
            await startSource(.glasses)
        }
    }

    func handleOpenURL(_ url: URL) async {
        if let error = await GlassesFrameSource.handle(url: url) { lastError = error }
    }
}
