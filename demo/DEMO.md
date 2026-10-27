# Wink demo (≈3 minutes)

## Before judging
- [ ] TV laptop: `/tv?token=…` open full screen on the projector, live socket connected (status pill shows "idle").
- [ ] iPhone: Wink running, glasses connected, backend URL = the deployed Worker, MOCK off (`/v1/health` shows `"mock": false`).
- [ ] Phone hotspot ready in case venue Wi-Fi drops. Backup video on the laptop.
- [ ] Glasses charged, camera LED check, phone volume up.
- [ ] Memory wall seeded with 2–3 memories so the TV doesn't start empty.

## Table staging
A book with a clear cover · a wine bottle or snack with a bold label · a sticky note with a **fake** Wi-Fi password (`Pumpkin-2026`) · a set of keys · a mug · 3–4 random objects to make the table look cluttered.

## Script

| # | Who / what | Say or do | Judges see and hear |
|---|---|---|---|
| 1 | Hook (presenter) | "How many things did you see today that you meant to remember? Phones make you stop, unlock, take a photo and never find it again. Wink is memory for your glasses." | — |
| 2 | Judge puts on the glasses | Presenter: "Look at the book and say: Hey Wink, save this." | Earcon, then in-ear "Saved. *Project title*, by …". The memory animates onto the TV wall. |
| 3 | Point gesture | "Messy table. Point at the snack, and say: Hey Wink, save this, it's the one Sam liked." | TV shows the point gesture toast and a crop of *only* that item, with the note. |
| 4 | Frame gesture | "Frame the sticky note with both hands." | Instant save, no voice. The Wi-Fi note appears on the wall. |
| 5 | Keys | Presenter drops the keys into the mug. Judge: "Hey Wink, save this, my keys are here." | Saved. |
| 6 | Palm | "Show it your palm." | In-ear "Paused." TV status pill turns to paused. Palm again resumes. (Privacy beat.) |
| 7 | Recall | Presenter asks the judge: "What was the Wi-Fi password?" They won't remember. Judge: "Hey Wink, what's the Wi-Fi password?" | In-ear answer, matching memory highlighted on the TV. Then: "Where did I leave my keys?" → "In the mug, about a minute ago." |
| 8 | Vision Pro moment | Judge: "Hey Wink, show my memories." Pinch and move. | A cursor glides over the TV wall; pinch opens a memory, a flick deletes it. |
| 9 | Nearby (if shipped) | "Hey Wink, where can I get this nearby?" | Real places from Overture Maps in Snowflake listed on the TV, closest first, read out in the ear. |
| 10 | Tech reveal (presenter, 30 s) | Architecture slide or README diagram | "Whisper and MediaPipe on the phone. gpt-oss-120b and Mistral Small 3.1 on Cloudflare Workers AI. Memories as Arctic Embed vectors in Snowflake. Overture Maps Places for the real world, explored with CoCo. All open models, MIT licensed." |

## Lines to have ready for judges' questions
- **Dataset:** Overture Maps Places by CARTO, free on the Snowflake Marketplace. Show the CoCo screenshots in `docs/coco/`.
- **How CoCo helped:** explored the nested Overture schema (names, categories, phones), wrote the nearby query, and designed the memory table with vector search.
- **Why open models:** your memories are personal, so the whole stack can be self-hosted; nothing depends on a closed model.
- **Privacy:** captures only on request, camera LED visible, "forget that" deletes, palm pauses. Face blurring is next.
- **Why not just a phone:** your hands stay free, and pointing tells Wink *which* thing you mean.
