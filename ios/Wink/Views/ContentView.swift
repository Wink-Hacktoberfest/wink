import SwiftUI

struct ContentView: View {
    @Bindable var controller: WinkController
    @State private var showSettings = false

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: 16) {
                    statusRow
                    sourceControls
                    PreviewView(image: controller.preview, hands: controller.hands, selection: controller.freshSelection,
                                pointer: controller.pointer, showPointer: controller.tvPointerMode)
                        .frame(height: 380)
                        .overlay(alignment: .topLeading) { gestureBadge.padding(10) }
                    voiceCard
                    if let pending = controller.pending { pendingCard(pending) }
                    if let error = controller.lastError ?? controller.cameraError {
                        Label(error, systemImage: "exclamationmark.triangle.fill")
                            .font(.footnote)
                            .foregroundStyle(.orange)
                    }
                    memoriesSection
                }
                .padding(16)
            }
            .navigationTitle("Wink")
            .toolbar {
                ToolbarItem(placement: .topBarTrailing) {
                    Button { showSettings = true } label: { Image(systemName: "gearshape.fill") }
                }
            }
            .sheet(isPresented: $showSettings) {
                SettingsView(controller: controller, config: controller.config)
            }
            .refreshable { await controller.refreshMemories() }
        }
    }

    // MARK: Pieces

    private var statusRow: some View {
        HStack(spacing: 8) {
            StatusPill(title: "Glasses", ok: controller.glasses.isRunning,
                       detail: controller.glasses.isRunning ? "live" : controller.glasses.registrationText)
            StatusPill(title: "Backend", ok: controller.health?.ok == true,
                       detail: controller.health.map { $0.mock ? "mock" : "live" } ?? "offline")
            StatusPill(title: "Socket", ok: controller.liveSocket.state == .connected,
                       detail: "\(controller.liveSocket.state)")
        }
    }

    private var sourceControls: some View {
        HStack(spacing: 12) {
            Picker("Camera", selection: Binding(get: { controller.sourceKind },
                                                set: { kind in Task { await controller.switchSource(to: kind) } })) {
                ForEach(FrameSourceKind.allCases) { Text($0.label).tag($0) }
            }
            .pickerStyle(.segmented)
            Button {
                Task { await controller.connectGlasses() }
            } label: {
                Label(controller.glasses.isRegistered ? "Connect" : "Register", systemImage: "eyeglasses")
                    .font(.subheadline.bold())
            }
            .buttonStyle(.borderedProminent)
        }
    }

    private var gestureBadge: some View {
        HStack(spacing: 6) {
            Image(systemName: "hand.raised.fill")
            Text(controller.lastGesture)
            if controller.tvPointerMode { Text("· TV pointer").foregroundStyle(.pink) }
        }
        .font(.caption.bold())
        .padding(.horizontal, 10).padding(.vertical, 6)
        .background(.ultraThinMaterial, in: Capsule())
    }

    private var voiceCard: some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack {
                Circle().fill(stateColor).frame(width: 12, height: 12)
                Text(controller.state.rawValue.capitalized).font(.title3.bold())
                Spacer()
                Text(controller.listener.modelState.label).font(.caption).foregroundStyle(.secondary)
            }
            ProgressView(value: Double(min(controller.listener.level * 12, 1)))
                .tint(controller.listener.isListening ? .green : .gray)
            if !controller.listener.lastHeard.isEmpty {
                Text("Heard: “\(controller.listener.lastHeard)”").font(.callout)
            }
            if !controller.lastReply.isEmpty {
                Text(controller.lastReply).font(.body.weight(.semibold)).foregroundStyle(.yellow)
            }
            HStack {
                Text(controller.listener.isPushToTalkActive ? "Listening… release to send" : "Hold to talk (no wake word)")
                    .font(.headline)
                    .frame(maxWidth: .infinity)
                    .padding(.vertical, 14)
                    .background(controller.listener.isPushToTalkActive ? Color.red : Color.accentColor,
                                in: RoundedRectangle(cornerRadius: 14))
                    .foregroundStyle(.black)
                    .gesture(
                        DragGesture(minimumDistance: 0)
                            .onChanged { _ in if !controller.listener.isPushToTalkActive { controller.listener.beginPushToTalk() } }
                            .onEnded { _ in controller.listener.endPushToTalk() }
                    )
                Button {
                    Task { await controller.perform(.save(note: nil), utterance: "") }
                } label: {
                    Image(systemName: "camera.fill").font(.title2).frame(width: 52, height: 48)
                }
                .buttonStyle(.bordered)
            }
            if let mic = controller.listener.micError {
                Text(mic).font(.caption).foregroundStyle(.red)
            }
        }
        .padding(14)
        .background(Color.white.opacity(0.06), in: RoundedRectangle(cornerRadius: 18))
    }

    private func pendingCard(_ pending: WinkController.PendingAction) -> some View {
        HStack {
            Text(pending.prompt + " (thumbs up)").font(.headline)
            Spacer()
            Button("Yes") { Task { await controller.confirmPending() } }.buttonStyle(.borderedProminent)
            Button("No") { controller.cancelPending() }.buttonStyle(.bordered)
        }
        .padding(12)
        .background(Color.orange.opacity(0.2), in: RoundedRectangle(cornerRadius: 14))
    }

    private var memoriesSection: some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack {
                Text("Memories").font(.title2.bold())
                Spacer()
                Button { Task { await controller.refreshMemories() } } label: { Image(systemName: "arrow.clockwise") }
            }
            if controller.memories.isEmpty {
                Text("Say “Hey Wink, save this” or frame something with both hands.")
                    .font(.callout).foregroundStyle(.secondary)
            }
            ForEach(controller.memories) { memory in
                MemoryRow(memory: memory)
                    .contextMenu {
                        Button("Delete", role: .destructive) { Task { await controller.delete(memory) } }
                    }
            }
        }
    }

    private var stateColor: Color {
        switch controller.state {
        case .idle: .green
        case .listening: .cyan
        case .thinking: .yellow
        case .speaking: .purple
        case .paused: .gray
        }
    }
}

struct StatusPill: View {
    let title: String
    let ok: Bool
    let detail: String

    var body: some View {
        VStack(alignment: .leading, spacing: 2) {
            HStack(spacing: 5) {
                Circle().fill(ok ? Color.green : Color.red).frame(width: 8, height: 8)
                Text(title).font(.caption.bold())
            }
            Text(detail).font(.caption2).foregroundStyle(.secondary).lineLimit(1)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(10)
        .background(Color.white.opacity(0.06), in: RoundedRectangle(cornerRadius: 12))
    }
}

struct MemoryRow: View {
    let memory: Memory

    var body: some View {
        HStack(spacing: 12) {
            AsyncImage(url: memory.imageURL) { image in
                image.resizable().scaledToFill()
            } placeholder: {
                Color.white.opacity(0.08)
            }
            .frame(width: 64, height: 64)
            .clipShape(RoundedRectangle(cornerRadius: 10))
            VStack(alignment: .leading, spacing: 3) {
                Text(memory.title).font(.headline).lineLimit(1)
                Text(memory.summary).font(.subheadline).foregroundStyle(.secondary).lineLimit(2)
                HStack(spacing: 6) {
                    if let note = memory.note { Text("“\(note)”").italic() }
                    if let place = memory.place { Text("· \(place.name)") }
                }
                .font(.caption).foregroundStyle(.secondary).lineLimit(1)
            }
            Spacer(minLength: 0)
        }
    }
}
