import SwiftUI

struct SettingsView: View {
    @Bindable var controller: WinkController
    @Bindable var config: WinkConfig
    @Environment(\.dismiss) private var dismiss
    @State private var typed = ""

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    TextField(WinkConfig.bundleBaseURL.isEmpty ? "http://192.168.1.20:8787" : WinkConfig.bundleBaseURL,
                              text: $config.baseURLOverride)
                        .textInputAutocapitalization(.never)
                        .autocorrectionDisabled()
                        .keyboardType(.URL)
                    SecureField("Token (blank = bundled)", text: $config.tokenOverride)
                        .textInputAutocapitalization(.never)
                    LabeledContent("Using", value: config.baseURLString.isEmpty ? "—" : config.baseURLString)
                    Button("Apply & reconnect") { controller.reconnectBackend() }
                    Button("Reset to bundled values", role: .destructive) {
                        config.resetOverrides()
                        controller.reconnectBackend()
                    }
                } header: {
                    Text("Backend")
                } footer: {
                    Text("Use http://<mac-lan-ip>:8787 for wrangler dev, or the workers.dev URL when deployed.")
                }

                Section("Health") {
                    if let h = controller.health {
                        LabeledContent("OK", value: h.ok ? "yes" : "no")
                        LabeledContent("Mock mode", value: h.mock ? "ON (canned replies)" : "off")
                        if let m = h.models {
                            LabeledContent("Chat", value: m.chat)
                            LabeledContent("Vision", value: m.vision)
                        }
                    } else {
                        Text(controller.healthError ?? "Not checked").foregroundStyle(.secondary)
                    }
                    Button("Check now") { Task { await controller.refreshHealth() } }
                    LabeledContent("Live socket", value: "\(controller.liveSocket.state)")
                    if let e = controller.liveSocket.lastError { Text(e).font(.caption).foregroundStyle(.secondary) }
                }

                Section("Glasses") {
                    LabeledContent("SDK", value: WinkApp.wearablesConfigured ? "configured" : (WinkApp.wearablesError ?? "not configured"))
                    LabeledContent("Registration", value: controller.glasses.registrationText)
                    LabeledContent("Devices", value: "\(controller.glasses.deviceCount)")
                    LabeledContent("Stream", value: controller.glasses.statusText)
                    if let e = controller.glasses.lastError { Text(e).font(.caption).foregroundStyle(.red) }
                    Button("Register with Meta AI") { Task { await controller.glasses.register() } }
                    Button("Unregister", role: .destructive) { Task { await controller.glasses.unregister() } }
                    #if DEBUG
                    Button("Enable mock glasses (MockDeviceKit)") { controller.glasses.enableMockGlasses() }
                    #endif
                }

                Section("Voice") {
                    LabeledContent("Whisper", value: controller.listener.modelState.label)
                    LabeledContent("Audio route", value: AudioSessionManager.routeDescription)
                    LabeledContent("Hand tracker", value: controller.trackerName)
                    Toggle("Send POV frames to TV", isOn: $controller.sendFramePreviews)
                    HStack {
                        TextField("Type a command, e.g. save this", text: $typed)
                        Button("Send") { controller.submitTyped(typed); typed = "" }
                    }
                }
            }
            .navigationTitle("Settings")
            .toolbar { ToolbarItem(placement: .confirmationAction) { Button("Done") { dismiss() } } }
        }
    }
}
