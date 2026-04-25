# Skipi

**Maritime Document Management for Seafarers.**
Local-first desktop app. All your certificates, contracts, and career records live on your computer — no cloud, no account, no server.

Built by a Master Mariner for seafarers.

---

## What it does

- **Document vault** — store certificates, passports, CoCs, CoPs, medical, and vessel-specific docs with expiry tracking
- **Sea service record** — log each contract with vessel details, sign-on/sign-off dates, supporting documents (contract, sea service letter, discharge letter, flight tickets)
- **CV builder** — generate an up-to-date seafarer CV from your vault
- **Packages** — bundle the right docs to send to crewing agencies
- **AI-assisted scanning** (optional) — point an Ollama or Claude API key at a cert photo to auto-extract fields

All data stays in a folder on your disk. You pick the folder, you own the files, you can move them anywhere.

## Status

Closed beta. Build available for invited testers via [releases](../../releases).

## Platforms

macOS (Apple Silicon + Intel), Windows (x64), Linux (x64).

## Tech

Tauri 2 (Rust + WebView). Single-file HTML frontend. SQLite for structured data. Local FS for documents.

## License

MIT. See [LICENSE](LICENSE).

## Contact

Tymur Rudov — [tymur.rudov@icloud.com](mailto:tymur.rudov@icloud.com) — [skipi.app](https://skipi.app)
