# Wink

**"Hey Wink, save this."** Smart-glasses memory you control with your voice and your hands.

Wink runs on Meta Ray-Ban glasses and an iPhone. Say "Hey Wink, save this" and it remembers what you're looking at. Point at one object to save just that, or frame something with both hands. Later, ask "Hey Wink, what was that book?" and hear the answer in your ear, with the exact moment shown on your phone and on the big screen. Ask "where can I get this nearby?" and Wink finds real places from Overture Maps in Snowflake.

Built in 5 hours at the Hacktoberfest 2026 mini hackathon (Hacklahoma) by Arboy and Messi.

## How it works

```
Glasses camera + mic ─► iPhone: WhisperKit ("Hey Wink") + MediaPipe Hands (gestures) + crop
                     ─► Cloudflare Worker ─► R2 (images) · Durable Object (live TV feed)
                                         ─► Workers AI: Mistral Small 3.1 (vision) + gpt-oss-120b
                                         ─► Workers AI: BGE-M3 embeddings ─► Neon Postgres + pgvector (memories)
                                         ─► Snowflake: Overture Maps Places (nearby)
                     ◄─ spoken answer in the glasses
```

## Open-source AI inside

| What | Model | Where it runs |
|---|---|---|
| Wake word and voice commands | Whisper (`base.en`) via WhisperKit | on the iPhone |
| Hand gestures | MediaPipe Hand Landmarker | on the iPhone |
| Understanding what you saved | Mistral Small 3.1 (Apache-2.0) | Cloudflare Workers AI |
| Answers and spoken replies | gpt-oss-120b (Apache-2.0) | Cloudflare Workers AI |
| Memory search | BGE-M3 embeddings (MIT), pgvector | Cloudflare Workers AI + Neon |

## Snowflake

- **Dataset:** Overture Maps Places, the free CARTO listing on the Snowflake Marketplace.
- **CoCo evidence:** exploration prompts and service-role checks are ready in `snowflake/README.md`. Actual account validation and screenshots in `docs/coco/` are pending; local tests use mocked provider transports.

## Repo

- `ios/`: SwiftUI iPhone app for the glasses. Setup in `ios/README.md`.
- `backend/`: Cloudflare Worker API, live WebSocket hub and TV dashboard. Setup in `backend/README.md`.
- `neon/`: memory store schema and setup.
- `snowflake/`: setup SQL, Overture exploration, places queries.
- `docs/api.md`: the API contract. `PRD.md`: product spec. `demo/DEMO.md`: demo script.

## Privacy

Wink only captures when you ask, by voice or gesture. Memories live in your own Neon database and R2 bucket, and "Hey Wink, forget that" deletes one. Every model is open-weight, so the whole stack can be self-hosted.

## License

MIT. See `LICENSE`.
