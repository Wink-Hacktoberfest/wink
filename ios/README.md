# Wink iOS

SwiftUI app that turns Meta Ray-Ban glasses into a memory: "Hey Wink, save this" captures what you see, "Hey Wink, what was that book?" answers in your ear. It talks to the backend through `docs/api.md`.

## Setup

```bash
brew install xcodegen            # only needed if you change project.yml or add/remove files
cd ios
cp Config/Secrets.example.xcconfig Config/Secrets.xcconfig   # then edit it
xcodegen generate                # regenerates Wink.xcodeproj from project.yml
LANG=en_US.UTF-8 pod install     # MediaPipe; creates Wink.xcworkspace (the LANG avoids a Ruby 4 encoding crash)
open Wink.xcworkspace            # always the workspace, never the .xcodeproj
```

Command-line build:

```bash
xcodebuild -workspace Wink.xcworkspace -scheme Wink -destination 'generic/platform=iOS Simulator' build
```

### Secrets and backend URL

`Config/Secrets.xcconfig` (gitignored) sets:

```
WINK_API_BASE_URL = http:/$()/192.168.1.20:8787     // xcconfig treats // as a comment, so use $() between the slashes
WINK_TOKEN = <same token as the backend's WINK_TOKEN>
```

Both reach the app through Info.plist (`WinkAPIBaseURL`, `WinkToken`). The **Settings sheet** (gear icon) overrides both at runtime (stored in UserDefaults), so you can switch between `wrangler dev` on the Mac (`http://<mac-lan-ip>:8787`, run with `--ip 0.0.0.0`) and the deployed `https://wink-api.<subdomain>.workers.dev` without rebuilding. The sheet also shows `/v1/health`, including whether the backend is in **mock mode**.

## Running on a device

The glasses, the camera and Bluetooth audio only work on a physical iPhone. The simulator only proves the app builds (and runs the unit tests).

1. **Signing:** team `BW3XQ8353L`, bundle id `com.arboymagomba.Wink`, automatic signing. The entitlements (`Wink/Wink.entitlements`) hold only the keychain group. Meta's CameraAccess sample also adds Hotspot Configuration and Access Wi-Fi Information, but a personal team can't sign those and Wink doesn't need them.
2. **Meta AI app:** install it on the iPhone, pair the glasses, then turn on **Developer Mode** (Meta AI > Settings > your glasses > Developer Mode). In Developer Mode `MetaAppID` can stay `0` (set in `Config/Wink.xcconfig`), so you don't need a Wearables Developer Center app.
3. Run Wink on the phone and allow microphone, camera and location access.
4. Tap **Register** (or Settings > Register with Meta AI). Meta AI opens; approve Wink, and it calls back to `wink://` (handled in `WinkApp.onOpenURL`).
5. Tap **Connect**. The first time, Meta AI asks for glasses camera permission (pick "Allow always"). The preview switches to the glasses POV.
6. The glasses' Bluetooth audio (HFP) becomes the mic and speaker. While the glasses camera streams, Wink listens on the iPhone mic instead, because the camera and HFP share one Bluetooth Classic link. Settings shows the current route. Replies use the backend's Aura-2 voice (`POST /v1/speak`), falling back to the built-in voice, through whatever output route is active.
7. The first launch downloads Whisper `base.en` (~150 MB) from Hugging Face. The status line shows progress. Wait for "Whisper ready" before saying "Hey Wink".

No glasses? Keep the camera toggle on **Phone** (back camera). In Debug builds, Settings > **Enable mock glasses** uses MockDeviceKit to simulate a pair of glasses streaming the phone camera.

## Voice commands

Say **"Hey Wink"** followed by the command. Whisper variants like "hey wing", "hey link", "a wink", "okay wink" and "hey winky" also work. "Hey Wink" on its own answers "Yes?" and takes the next sentence as the command. **Hold to talk** skips the wake word.

| Say | Does |
|---|---|
| "save this" / "remember this, it's the wine Sam liked" | `POST /v1/memories` with the cropped frame. The text after "save this" becomes the note |
| "what's this?" / "read this" | `POST /v1/glance` (nothing is saved) |
| "what was that book?" / "where did I put my keys?" | `POST /v1/ask` (the default for anything unrecognized) |
| "where can I get this nearby?" / "where can I buy oat milk near me" | `POST /v1/nearby` with the last memory or the query |
| "forget that" | asks for confirmation; a thumbs up deletes the last memory |
| "pause" / "resume" | stops reacting to everything except "resume" and an open palm |
| "show my memories" | toggles TV pointer mode (pinch drives the cursor on the TV) |

## Gestures (seen by the glasses camera)

| Gesture | Hold | Does |
|---|---|---|
| **Point** (index out, other fingers curled) | 0.4 s | Selects a box (~35% of the frame) just past the fingertip. The next "save this" or "what's this" within 3 s crops to it |
| **Frame** (both hands in an L, thumb and index) | 0.4 s | Selects the box between the two corners and **saves immediately** |
| **Open palm** (all five fingers) | 0.6 s | Toggles pause |
| **Thumbs up** | 0.4 s | Confirms the pending action ("forget that") |
| **1–3 fingers** | 0.5 s | After a nearby search, reads out place #n |
| **Pinch** (thumb tip to index tip) | live | In TV pointer mode, moves the TV cursor (`pointer` events, at most 20/s) |
| **Flick** (fast sideways move while pinching) | — | In TV pointer mode, sends `flick` (the TV deletes or dismisses) |

Each gesture fires once per hold, with a 1.2 s cooldown.

## Code map

- `WinkApp.swift`: `Wearables.configure()` and the DAT URL callback.
- `WinkController.swift`: the orchestrator. It connects frames to gestures and selection, voice to intents to the API to speech, and sends live events.
- `Services/API`: `WinkModels` (mirrors of `docs/api.md`), `WinkAPIClient` (every route; JPEG ≤ 1280 px multipart), `LiveSocket` (`/v1/live?role=glasses`, auto-reconnect, throttled pointer and frame previews).
- `Services/Camera`: `FrameSource` protocol, `GlassesFrameSource` (DAT), `PhoneFrameSource` (AVCaptureSession), `ImageUtils`.
- `Services/Voice`: `AudioSessionManager`, `UtteranceSegmenter` (energy VAD), `WhisperTranscriber` (WhisperKit), `WakeWordListener`, `WakePhrase`, `IntentParser`, `SpeechOut`.
- `Services/Gestures`: `HandTracker` protocol, `MediaPipeHandTracker` (falls back to `VisionHandTracker` if the model fails to load), `GestureClassifier` (pure Swift, unit tested), `GesturePipeline` (actor, off the main thread).
- `WinkTests`: tests for `IntentParser`, `WakePhrase` and `GestureClassifier`.
