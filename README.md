# GearInfo

Upload a photo of a mechanical component — gear, pipe fitting, throttle body, bearing,
valve, pump, fastener — and get a detailed engineering report: identification with
confidence, working principle and formulas, visible anatomy, typical specs, materials,
applications, design considerations, failure modes, maintenance, standards and safety.
You can then ask follow-up questions about the same part.

Powered by Google Gemini (`gemini-pro-latest` by default; override with `GEMINI_MODEL`).

## Run

```bash
python3 -m venv .venv
.venv/bin/pip install -r requirements.txt
echo "GEMINI_API_KEY=your-key" > .env
.venv/bin/uvicorn app.main:app --reload
```

Open http://127.0.0.1:8000, then drop, paste, or pick an image.

## Layout

- `app/main.py` — FastAPI server: image validation/downscaling, streaming Gemini calls (SSE), follow-up sessions (in memory)
- `app/prompts.py` — the system prompt that defines the report structure
- `static/` — single-page UI (vanilla JS, Markdown rendered with marked + DOMPurify, formulas with KaTeX)

Sessions live in memory, so they reset when the server restarts.
