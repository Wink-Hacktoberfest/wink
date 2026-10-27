import SwiftUI
import SceneKit

private enum WinkStyle {
    static let background = Color(red: 0.945, green: 0.945, blue: 0.935)
    static let ink = Color(red: 0.07, green: 0.075, blue: 0.07)
    static let muted = Color(red: 0.38, green: 0.39, blue: 0.37)
}

private enum WinkTab: String, CaseIterable {
    case home = "Home", capture = "Capture", ask = "Ask"
    var symbol: String {
        switch self { case .home: "square.grid.2x2"; case .capture: "viewfinder"; case .ask: "sparkle" }
    }
}

struct ContentView: View {
    @Bindable var controller: WinkController
    @State private var showSettings = false
    @State private var tab = WinkTab.home
    @State private var search = ""
    @State private var question = ""
    @State private var selectedMemory: Memory?
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    private var filteredMemories: [Memory] {
        let query = search.trimmingCharacters(in: .whitespacesAndNewlines)
        return query.isEmpty ? controller.memories : controller.memories.filter {
            [$0.title, $0.summary, $0.note ?? "", $0.place?.name ?? ""].joined(separator: " ")
                .localizedCaseInsensitiveContains(query)
        }
    }

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: 24) {
                    header
                    if let pending = controller.pending { pendingCard(pending) }
                    switch tab {
                    case .home: homeContent
                    case .capture: captureContent
                    case .ask: askContent
                    }
                    if let error = controller.lastError ?? controller.cameraError {
                        Label(error, systemImage: "exclamationmark.triangle")
                            .font(.footnote).foregroundStyle(Color(red: 0.6, green: 0.22, blue: 0.08))
                            .padding(16).frame(maxWidth: .infinity, alignment: .leading).winkCard()
                    }
                }
                .padding(.horizontal, 22).padding(.top, 12).padding(.bottom, 24)
                .frame(maxWidth: 760)
                .frame(maxWidth: .infinity)
            }
            .background(WinkStyle.background)
            .toolbar(.hidden, for: .navigationBar)
            .safeAreaInset(edge: .bottom, spacing: 0) { navigationDock }
            .sheet(isPresented: $showSettings) { SettingsView(controller: controller, config: controller.config) }
            .sheet(item: $selectedMemory) { memory in
                MemoryDetailView(memory: memory) {
                    await controller.delete(memory)
                    return controller.memories.contains(where: { $0.id == memory.id })
                        ? (controller.lastError ?? "Couldn't remove this memory. Check your connection and try again.") : nil
                }
            }
            .refreshable { await controller.refreshMemories(); await controller.refreshHealth() }
            .onChange(of: tab) { _, _ in
                if controller.listener.isPushToTalkActive { controller.listener.endPushToTalk() }
            }
        }
        .tint(WinkStyle.ink).foregroundStyle(WinkStyle.ink)
    }

    private var header: some View {
        HStack(spacing: 12) {
            HStack(spacing: 10) {
                Image(systemName: "eye").font(.title2).frame(width: 44, height: 44)
                    .background(.white, in: Circle())
                VStack(alignment: .leading, spacing: 2) {
                    Text("wink").font(.system(.title2, design: .rounded, weight: .bold))
                    Text("Your world, remembered.").font(.caption).foregroundStyle(WinkStyle.muted)
                }
                Spacer(minLength: 0)
            }
            .padding(6).padding(.trailing, 12).background(.white.opacity(0.65), in: Capsule())
            Button { showSettings = true } label: {
                Image(systemName: "slider.horizontal.3").font(.title3).frame(width: 48, height: 48)
                    .background(.white.opacity(0.75), in: Circle())
            }
            .accessibilityLabel("Settings and connection")
        }
    }

    private var homeContent: some View {
        VStack(alignment: .leading, spacing: 24) {
            VStack(alignment: .leading, spacing: 8) {
                Text("Be here.\nRemember everything.")
                    .font(.system(.largeTitle, design: .rounded, weight: .medium)).tracking(-1.2)
                    .accessibilityAddTraits(.isHeader)
                Text("A little help from the glasses you love.")
                    .font(.subheadline).foregroundStyle(WinkStyle.muted)
            }
            glassesCard
            HStack(spacing: 10) {
                StatusPill(title: "Glasses", ok: controller.glasses.isRunning,
                           detail: controller.glasses.isRunning ? "Connected" : "Not streaming")
                StatusPill(title: "Service", ok: controller.health?.ok == true,
                           detail: controller.health.map { $0.mock ? "Demo mode" : "Connected" } ?? "Offline")
                StatusPill(title: "TV", ok: controller.liveSocket.state == .connected,
                           detail: "\(controller.liveSocket.state)".capitalized)
            }
            memoriesSection
        }
    }

    private var glassesCard: some View {
        VStack(alignment: .leading, spacing: 0) {
            HStack {
                VStack(alignment: .leading, spacing: 5) {
                    Text("Your everyday companion").font(.headline)
                    Text("Made for Meta Ray-Ban").font(.caption).foregroundStyle(WinkStyle.muted)
                }
                Spacer()
                Image(systemName: "sparkle").font(.title2)
            }
            .padding(20)
            GlassesHeroView().frame(height: 220)
            HStack(spacing: 12) {
                Text("See it. Save it. Find it.").font(.subheadline)
                Spacer()
                Button { tab = .capture } label: {
                    Image(systemName: "arrow.up.right").font(.headline).frame(width: 44, height: 44)
                        .foregroundStyle(.white).background(WinkStyle.ink, in: Circle())
                }.accessibilityLabel("Open capture")
            }.padding(20)
        }.winkCard()
    }

    private var captureContent: some View {
        VStack(alignment: .leading, spacing: 20) {
            pageHeading("Keep this moment.", subtitle: "Point, frame, or say “Hey Wink, save this.”")
            sourceControls
            PreviewView(image: controller.preview, hands: controller.hands, selection: controller.freshSelection,
                        pointer: controller.pointer, showPointer: controller.tvPointerMode)
                .frame(height: 360)
                .overlay(alignment: .topLeading) { gestureBadge.padding(14) }
                .accessibilityLabel("Live \(controller.sourceKind.label) camera preview")
            HStack(spacing: 12) {
                Button {
                    Task { await controller.perform(.save(note: nil), utterance: "") }
                } label: {
                    Label("Save moment", systemImage: "camera").font(.headline)
                        .frame(maxWidth: .infinity).padding(.vertical, 17)
                }.buttonStyle(WinkPrimaryButton())
                Button {
                    Task { await controller.perform(.glance, utterance: "What am I looking at?") }
                } label: {
                    Image(systemName: "eye").font(.title2).frame(width: 56, height: 56).winkCard()
                }.accessibilityLabel("Describe what I am looking at")
            }
            .disabled(controller.state == .thinking || controller.state == .paused)
            voiceCard
            VStack(spacing: 16) {
                Toggle("Share camera preview with TV", isOn: $controller.sendFramePreviews)
                Toggle("Control TV with gestures", isOn: $controller.tvPointerMode)
                Button {
                    Task { await controller.perform(controller.state == .paused ? .resume : .pause, utterance: "") }
                } label: {
                    Label(controller.state == .paused ? "Resume Wink" : "Pause Wink",
                          systemImage: controller.state == .paused ? "play" : "pause")
                        .frame(maxWidth: .infinity, alignment: .leading)
                }
            }.font(.subheadline).padding(20).winkCard()
        }
    }

    private var askContent: some View {
        VStack(alignment: .leading, spacing: 24) {
            pageHeading("A thought away.", subtitle: "Find the little things you didn't want to forget.")
            GlassesHeroView().frame(height: 180)
            if !controller.lastReply.isEmpty {
                VStack(alignment: .leading, spacing: 12) {
                    Label("Wink remembers", systemImage: "sparkle").font(.caption.weight(.semibold))
                    Text(controller.lastReply).font(.title3).textSelection(.enabled)
                }.padding(22).frame(maxWidth: .infinity, alignment: .leading).winkCard()
            }
            VStack(alignment: .leading, spacing: 14) {
                TextField("What was that book?", text: $question, axis: .vertical)
                    .font(.body).lineLimit(2...5).submitLabel(.send).onSubmit(sendQuestion)
                HStack {
                    Text("Ask about your memories").font(.caption).foregroundStyle(WinkStyle.muted)
                    Spacer()
                    Button(action: sendQuestion) {
                        Image(systemName: "arrow.up").font(.headline).frame(width: 44, height: 44)
                            .foregroundStyle(.white).background(WinkStyle.ink, in: Circle())
                    }
                    .accessibilityLabel("Send question")
                    .disabled(question.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || controller.state == .thinking || controller.state == .paused)
                }
            }.padding(20).winkCard()
            voiceCard
            if !controller.lastPlaces.isEmpty {
                Text("Places nearby").font(.title2).accessibilityAddTraits(.isHeader)
                ForEach(controller.lastPlaces) { place in
                    VStack(alignment: .leading, spacing: 6) {
                        Label(place.name, systemImage: "mappin.and.ellipse").font(.headline)
                        if let address = place.address { Text(address).font(.subheadline).foregroundStyle(WinkStyle.muted) }
                        if let distance = place.distanceMeters { Text("\(Int(distance)) m away").font(.caption) }
                    }.padding(20).frame(maxWidth: .infinity, alignment: .leading).winkCard()
                }
            }
        }
    }

    private func sendQuestion() {
        let value = question.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !value.isEmpty, controller.state != .thinking, controller.state != .paused else { return }
        controller.submitTyped(value)
        question = ""
    }

    private func pageHeading(_ title: String, subtitle: String) -> some View {
        VStack(alignment: .leading, spacing: 8) {
            Text(title).font(.system(.largeTitle, design: .rounded, weight: .medium)).tracking(-1)
                .accessibilityAddTraits(.isHeader)
            Text(subtitle).font(.subheadline).foregroundStyle(WinkStyle.muted)
        }
    }

    private var sourceControls: some View {
        VStack(spacing: 14) {
            Picker("Camera", selection: Binding(get: { controller.sourceKind },
                                                set: { kind in Task { await controller.switchSource(to: kind) } })) {
                ForEach(FrameSourceKind.allCases) { Text($0.label).tag($0) }
            }.pickerStyle(.segmented)
            Button { Task { await controller.connectGlasses() } } label: {
                Label(controller.glasses.isRegistered ? "Connect glasses" : "Set up Meta Ray-Ban", systemImage: "eyeglasses")
                    .font(.subheadline.weight(.semibold)).frame(maxWidth: .infinity).padding(.vertical, 12)
            }.buttonStyle(WinkPrimaryButton())
        }
    }

    private var gestureBadge: some View {
        Label(controller.lastGesture == "—" ? "Ready for a gesture" : controller.lastGesture,
              systemImage: controller.tvPointerMode ? "cursorarrow" : "hand.raised")
            .font(.caption.weight(.semibold)).padding(.horizontal, 12).padding(.vertical, 8)
            .background(.regularMaterial, in: Capsule())
    }

    private var voiceCard: some View {
        VStack(alignment: .leading, spacing: 14) {
            HStack {
                Label(controller.state.rawValue.capitalized, systemImage: controller.state == .paused ? "pause.circle" : "waveform")
                    .font(.headline)
                Spacer()
                Text(controller.listener.modelState.label).font(.caption).foregroundStyle(WinkStyle.muted)
            }
            ProgressView(value: Double(min(controller.listener.level * 12, 1))).tint(WinkStyle.ink)
                .accessibilityLabel("Microphone level")
            if !controller.listener.lastHeard.isEmpty {
                Text("“\(controller.listener.lastHeard)”").font(.subheadline).foregroundStyle(WinkStyle.muted)
            }
            if tab != .ask, !controller.lastReply.isEmpty { Text(controller.lastReply).font(.body) }
            Text(controller.listener.isPushToTalkActive ? "Listening… release to send" : "Hold to talk")
                .font(.headline).frame(maxWidth: .infinity).padding(.vertical, 18)
                .foregroundStyle(.white)
                .background(controller.listener.isPushToTalkActive ? Color(red: 0.3, green: 0.32, blue: 0.29) : WinkStyle.ink, in: Capsule())
                .contentShape(Capsule())
                .gesture(DragGesture(minimumDistance: 0)
                    .onChanged { _ in if !controller.listener.isPushToTalkActive { controller.listener.beginPushToTalk() } }
                    .onEnded { _ in controller.listener.endPushToTalk() })
                .accessibilityAddTraits(.isButton)
                .accessibilityLabel(controller.listener.isPushToTalkActive ? "Finish talking" : "Start talking")
                .accessibilityHint("Double tap to start or finish recording a command")
                .accessibilityAction {
                    if controller.listener.isPushToTalkActive { controller.listener.endPushToTalk() }
                    else { controller.listener.beginPushToTalk() }
                }
            if let error = controller.listener.micError { Text(error).font(.caption).foregroundStyle(.red) }
        }.padding(20).winkCard()
    }

    private func pendingCard(_ pending: WinkController.PendingAction) -> some View {
        VStack(alignment: .leading, spacing: 14) {
            Label(pending.prompt, systemImage: "hand.thumbsup").font(.headline)
            Text("Give a thumbs up, or confirm below.").font(.caption).foregroundStyle(WinkStyle.muted)
            HStack {
                Button("Keep it") { controller.cancelPending() }.buttonStyle(.bordered)
                Button("Yes, forget") { Task { await controller.confirmPending() } }.buttonStyle(.borderedProminent)
            }
        }.padding(20).frame(maxWidth: .infinity, alignment: .leading).winkCard()
    }

    private var memoriesSection: some View {
        VStack(alignment: .leading, spacing: 16) {
            HStack {
                Text("Your memories").font(.system(.title2, design: .rounded, weight: .medium))
                    .accessibilityAddTraits(.isHeader)
                Spacer()
                Text("\(controller.memories.count)").font(.subheadline).foregroundStyle(WinkStyle.muted)
                Button { Task { await controller.refreshMemories() } } label: {
                    Image(systemName: "arrow.clockwise").frame(width: 44, height: 44)
                }.accessibilityLabel("Refresh memories")
            }
            HStack(spacing: 12) {
                Image(systemName: "magnifyingglass").foregroundStyle(WinkStyle.muted)
                TextField("Search your memories", text: $search).autocorrectionDisabled()
                    .accessibilityLabel("Search your memories")
                if !search.isEmpty {
                    Button { search = "" } label: { Image(systemName: "xmark.circle.fill").frame(width: 30, height: 30) }
                        .accessibilityLabel("Clear search")
                }
            }.padding(16).background(.white.opacity(0.8), in: Capsule())
            if filteredMemories.isEmpty {
                VStack(alignment: .leading, spacing: 12) {
                    Image(systemName: search.isEmpty ? "bookmark" : "magnifyingglass").font(.title)
                    Text(search.isEmpty ? "Make room for a first memory." : "No matching memories.").font(.headline)
                    Text(search.isEmpty ? "A book, a place, a passing thought. Say “Hey Wink, save this” to keep it close." : "Try another word, title, or place.")
                        .font(.subheadline).foregroundStyle(WinkStyle.muted)
                    if search.isEmpty {
                        Button("Capture a moment") { tab = .capture }.font(.subheadline.weight(.semibold)).padding(.top, 6)
                    }
                }.padding(24).frame(maxWidth: .infinity, alignment: .leading).winkCard()
            }
            ForEach(filteredMemories) { memory in
                Button { selectedMemory = memory } label: { MemoryRow(memory: memory) }
                    .buttonStyle(.plain).accessibilityHint("Open memory details")
            }
        }
    }

    private var navigationDock: some View {
        HStack(spacing: 6) {
            ForEach(WinkTab.allCases, id: \.self) { item in
                Button {
                    withAnimation(reduceMotion ? nil : .easeInOut(duration: 0.2)) { tab = item }
                } label: {
                    HStack(spacing: 8) {
                        Image(systemName: item.symbol).font(.headline)
                        if tab == item { Text(item.rawValue).font(.subheadline.weight(.semibold)) }
                    }
                    .frame(minWidth: 44, minHeight: 46).padding(.horizontal, tab == item ? 14 : 5)
                    .background(tab == item ? Color.white.opacity(0.14) : .clear, in: Capsule())
                    .overlay(Capsule().strokeBorder(.white.opacity(tab == item ? 0.3 : 0), lineWidth: 1))
                }
                .accessibilityLabel(item.rawValue)
                .accessibilityAddTraits(tab == item ? [.isSelected] : [])
            }
        }
        .foregroundStyle(.white).padding(7).background(WinkStyle.ink, in: Capsule())
        .shadow(color: .black.opacity(0.13), radius: 18, y: 8)
        .padding(.horizontal, 20).padding(.top, 10).padding(.bottom, 8)
        .frame(maxWidth: .infinity)
        .background(LinearGradient(colors: [WinkStyle.background.opacity(0), WinkStyle.background], startPoint: .top, endPoint: .bottom))
    }
}

private struct WinkPrimaryButton: ButtonStyle {
    func makeBody(configuration: Configuration) -> some View {
        configuration.label.foregroundStyle(.white)
            .background(WinkStyle.ink.opacity(configuration.isPressed ? 0.75 : 1), in: Capsule())
    }
}

private extension View {
    func winkCard() -> some View {
        background(.white.opacity(0.75), in: RoundedRectangle(cornerRadius: 26))
            .overlay(RoundedRectangle(cornerRadius: 26).strokeBorder(.white, lineWidth: 1))
            .shadow(color: .black.opacity(0.025), radius: 14, y: 6)
    }
}

struct StatusPill: View {
    let title: String
    let ok: Bool
    let detail: String
    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack(spacing: 5) {
                Circle().fill(ok ? Color(red: 0.26, green: 0.40, blue: 0.30) : Color.gray).frame(width: 6, height: 6)
                Text(title).font(.caption.weight(.semibold))
            }
            Text(detail).font(.caption2).foregroundStyle(WinkStyle.muted).fixedSize(horizontal: false, vertical: true)
        }
        .frame(maxWidth: .infinity, alignment: .leading).padding(13).winkCard()
        .accessibilityElement(children: .combine)
    }
}

struct MemoryRow: View {
    let memory: Memory
    var body: some View {
        VStack(alignment: .leading, spacing: 16) {
            HStack(alignment: .top) {
                VStack(alignment: .leading, spacing: 6) {
                    Text(memory.title).font(.system(.title3, design: .rounded, weight: .medium)).multilineTextAlignment(.leading)
                    if let place = memory.place { Label(place.name, systemImage: "mappin").font(.caption).foregroundStyle(WinkStyle.muted) }
                }
                Spacer(minLength: 12)
                Image(systemName: "arrow.up.right").font(.subheadline).padding(9).background(WinkStyle.background, in: Circle())
            }
            AsyncImage(url: memory.imageURL) { image in image.resizable().scaledToFill() } placeholder: {
                Rectangle().fill(WinkStyle.background).overlay { Image(systemName: "photo").font(.largeTitle).foregroundStyle(WinkStyle.muted) }
            }
            .frame(height: 185).frame(maxWidth: .infinity).clipped().clipShape(RoundedRectangle(cornerRadius: 18))
            Text(memory.summary).font(.subheadline).foregroundStyle(WinkStyle.muted).lineLimit(2).multilineTextAlignment(.leading)
            if let note = memory.note, !note.isEmpty { Text("“\(note)”").font(.caption).italic().multilineTextAlignment(.leading) }
        }.padding(20).winkCard()
    }
}

private struct MemoryDetailView: View {
    let memory: Memory
    let delete: () async -> String?
    @Environment(\.dismiss) private var dismiss
    @State private var confirmDelete = false
    @State private var deleting = false
    @State private var deleteError: String?
    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: 20) {
                    AsyncImage(url: memory.imageURL) { image in image.resizable().scaledToFit() } placeholder: {
                        Image(systemName: "photo").font(.largeTitle).frame(maxWidth: .infinity, minHeight: 180)
                    }.clipShape(RoundedRectangle(cornerRadius: 24))
                    Text(memory.title).font(.largeTitle.weight(.medium))
                    Text(memory.summary).font(.body)
                    if let note = memory.note { Text("“\(note)”").font(.body).italic() }
                    if !memory.visibleText.isEmpty { Text(memory.visibleText).font(.subheadline).foregroundStyle(WinkStyle.muted) }
                    if let place = memory.place { Label(place.name, systemImage: "mappin.and.ellipse") }
                    if let deleteError { Text(deleteError).font(.subheadline).foregroundStyle(.red) }
                    Button(deleting ? "Removing memory…" : "Forget this memory", role: .destructive) { confirmDelete = true }
                        .disabled(deleting).padding(.top)
                }.padding(24).textSelection(.enabled)
            }
            .background(WinkStyle.background).navigationTitle("A moment, kept").navigationBarTitleDisplayMode(.inline)
            .toolbar { ToolbarItem(placement: .confirmationAction) { Button("Done") { dismiss() } } }
            .confirmationDialog("Forget this memory?", isPresented: $confirmDelete, titleVisibility: .visible) {
                Button("Forget memory", role: .destructive) {
                    Task {
                        deleting = true
                        deleteError = await delete()
                        deleting = false
                        if deleteError == nil { dismiss() }
                    }
                }
            } message: { Text("This removes the saved memory and its photo.") }
        }.tint(WinkStyle.ink)
    }
}

/// The bundled model is an original illustration, not a connection-status indicator.
private struct GlassesHeroView: View {
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @Environment(\.scenePhase) private var scenePhase
    @State private var rotating = true
    var body: some View {
        ZStack(alignment: .bottomTrailing) {
            GlassesSceneView(animate: rotating && !reduceMotion && scenePhase == .active)
                .accessibilityHidden(true)
            Button { rotating.toggle() } label: {
                Image(systemName: rotating && !reduceMotion ? "pause" : "play")
                    .font(.caption).frame(width: 44, height: 44).background(.white.opacity(0.7), in: Circle())
            }
            .disabled(reduceMotion)
            .accessibilityLabel(reduceMotion ? "Rotation disabled by Reduce Motion" : rotating ? "Pause glasses rotation" : "Rotate glasses")
            .padding(8)
        }
    }
}

private struct GlassesSceneView: UIViewRepresentable {
    func makeCoordinator() -> Coordinator { Coordinator() }
    var animate: Bool
    final class Coordinator { var model: SCNNode? }

    func makeUIView(context: Context) -> SCNView {
        let view = SCNView()
        view.backgroundColor = .clear
        view.antialiasingMode = .multisampling4X
        view.preferredFramesPerSecond = 30
        let scene = SCNScene()
        let model = SCNNode()
        if let url = Bundle.main.url(forResource: "wink-glasses", withExtension: "dae"),
           let asset = try? SCNScene(url: url) {
            for child in asset.rootNode.childNodes { model.addChildNode(child) }
        } else {
            // A recognizable static fallback if an asset is unavailable.
            for x: Float in [-0.72, 0.72] {
                let lens = SCNBox(width: 1.18, height: 0.82, length: 0.14, chamferRadius: 0.24)
                lens.firstMaterial?.diffuse.contents = UIColor(white: 0.1, alpha: 1)
                let node = SCNNode(geometry: lens); node.position.x = x; model.addChildNode(node)
            }
            let bridge = SCNNode(geometry: SCNBox(width: 0.4, height: 0.1, length: 0.12, chamferRadius: 0.05))
            bridge.geometry?.firstMaterial?.diffuse.contents = UIColor.black; model.addChildNode(bridge)
        }
        model.enumerateChildNodes { node, _ in
            for material in node.geometry?.materials ?? [] {
                material.lightingModel = .blinn
                material.specular.contents = UIColor(white: 0.45, alpha: 1)
                material.shininess = 0.65
                let nodeName = (node.name ?? "").lowercased()
                if material.name?.localizedCaseInsensitiveContains("matte") == true
                    || ["frame", "temple", "bridge", "rest"].contains(where: { nodeName.contains($0) }) {
                    material.diffuse.contents = UIColor(white: 0.13, alpha: 1)
                    material.ambient.contents = UIColor(white: 0.13, alpha: 1)
                    material.locksAmbientWithDiffuse = true
                }
            }
        }
        // Normalize assets to a consistent stage regardless of export units.
        let (lo, hi) = model.boundingBox
        let width = max(hi.x - lo.x, 0.01)
        let normalized = SCNNode()
        model.position = SCNVector3(-(lo.x + hi.x) / 2, -(lo.y + hi.y) / 2, -(lo.z + hi.z) / 2)
        normalized.addChildNode(model)
        normalized.scale = SCNVector3(3.3 / width, 3.3 / width, 3.3 / width)
        let turntable = SCNNode(); turntable.addChildNode(normalized)
        turntable.eulerAngles = SCNVector3(-0.20, -0.52, -0.06)
        scene.rootNode.addChildNode(turntable)
        context.coordinator.model = turntable
        let camera = SCNNode(); camera.camera = SCNCamera(); camera.position = SCNVector3(0, 0.25, 5.1)
        camera.camera?.fieldOfView = 36; scene.rootNode.addChildNode(camera); view.pointOfView = camera
        let ambient = SCNNode(); ambient.light = SCNLight(); ambient.light?.type = .ambient
        ambient.light?.intensity = 700; scene.rootNode.addChildNode(ambient)
        let key = SCNNode(); key.light = SCNLight(); key.light?.type = .omni
        key.light?.intensity = 1200; key.position = SCNVector3(-3, 4, 5); scene.rootNode.addChildNode(key)
        let rim = SCNNode(); rim.light = SCNLight(); rim.light?.type = .omni
        rim.light?.intensity = 900; rim.position = SCNVector3(3, 2, -3); scene.rootNode.addChildNode(rim)
        view.scene = scene
        return view
    }

    static func dismantleUIView(_ view: SCNView, coordinator: Coordinator) {
        view.isPlaying = false
        view.scene = nil
        coordinator.model = nil
    }

    func updateUIView(_ view: SCNView, context: Context) {
        guard let model = context.coordinator.model else { return }
        if animate, model.action(forKey: "turn") == nil {
            model.runAction(.repeatForever(.rotateBy(x: 0, y: .pi * 2, z: 0, duration: 24)), forKey: "turn")
        }
        model.isPaused = !animate
        view.isPlaying = animate
        view.rendersContinuously = animate
    }
}
