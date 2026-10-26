import io
import json
import os
import uuid
from pathlib import Path

from dotenv import load_dotenv
from fastapi import FastAPI, File, Form, HTTPException, UploadFile
from fastapi.responses import FileResponse, StreamingResponse
from fastapi.staticfiles import StaticFiles
from google import genai
from google.genai import errors, types
from PIL import Image, ImageOps
from pydantic import BaseModel

from .prompts import ANALYZE_INSTRUCTION, SYSTEM_PROMPT

ROOT = Path(__file__).resolve().parent.parent
STATIC_DIR = ROOT / "static"
load_dotenv(ROOT / ".env")

# "gemini-pro-latest" always points at Google's newest Pro model.
MODEL = os.environ.get("GEMINI_MODEL", "gemini-pro-latest")
# Large phone photos are slow to upload and add nothing past this size.
MAX_IMAGE_BYTES = 4_500_000
MAX_EDGE_PX = 2576
SUPPORTED_TYPES = {"image/jpeg", "image/png", "image/webp", "image/heic", "image/heif"}

CONFIG = types.GenerateContentConfig(
    system_instruction=SYSTEM_PROMPT,
    thinking_config=types.ThinkingConfig(thinking_level="high"),
)

app = FastAPI(title="GearInfo")
app.mount("/static", StaticFiles(directory=STATIC_DIR), name="static")

client = genai.Client(api_key=os.environ.get("GEMINI_API_KEY"))

# session_id -> chat; the chat object keeps the conversation history.
sessions: dict[str, genai.chats.AsyncChat] = {}
in_progress: set[str] = set()


def prepare_image(data: bytes, media_type: str) -> tuple[str, bytes]:
    """Return (media_type, bytes), downscaling/re-encoding if needed."""
    try:
        img = Image.open(io.BytesIO(data))
        img.verify()
        img = Image.open(io.BytesIO(data))
    except Exception:
        raise HTTPException(400, "That file doesn't look like a valid image.")

    if media_type in SUPPORTED_TYPES and len(data) <= MAX_IMAGE_BYTES and max(img.size) <= MAX_EDGE_PX:
        return media_type, data

    img = ImageOps.exif_transpose(img).convert("RGB")
    img.thumbnail((MAX_EDGE_PX, MAX_EDGE_PX))
    quality = 90
    while True:
        buf = io.BytesIO()
        img.save(buf, format="JPEG", quality=quality)
        if buf.tell() <= MAX_IMAGE_BYTES or quality <= 50:
            break
        quality -= 10
    return "image/jpeg", buf.getvalue()


def sse(event: dict) -> str:
    return f"data: {json.dumps(event)}\n\n"


def error_message(e: errors.APIError) -> str:
    if e.code in (401, 403) or (e.code == 400 and "API key" in str(e.message)):
        return "Invalid or missing Gemini API key. Set GEMINI_API_KEY in .env and restart the server."
    if e.code == 429:
        return "Gemini quota or rate limit reached. Wait a moment and try again."
    return f"Gemini API error ({e.code}): {e.message}"


async def stream_reply(session_id: str, message):
    chat = sessions[session_id]
    in_progress.add(session_id)
    finish_reason = None
    usage = None
    try:
        yield sse({"type": "start", "session_id": session_id})
        async for chunk in await chat.send_message_stream(message):
            if chunk.text:
                yield sse({"type": "text", "text": chunk.text})
            if chunk.candidates and chunk.candidates[0].finish_reason:
                finish_reason = chunk.candidates[0].finish_reason
            if chunk.usage_metadata:
                usage = chunk.usage_metadata
    except errors.APIError as e:
        yield sse({"type": "error", "message": error_message(e)})
        return
    except Exception as e:
        yield sse({"type": "error", "message": f"Couldn't reach Gemini: {e}"})
        return
    finally:
        in_progress.discard(session_id)

    if finish_reason in (types.FinishReason.SAFETY, types.FinishReason.PROHIBITED_CONTENT, types.FinishReason.BLOCKLIST):
        yield sse({"type": "error", "message": "Gemini declined to analyze this request."})
        return

    yield sse({
        "type": "done",
        "truncated": finish_reason == types.FinishReason.MAX_TOKENS,
        "usage": {
            "input_tokens": usage.prompt_token_count if usage else None,
            "output_tokens": usage.candidates_token_count if usage else None,
        },
    })


@app.get("/")
async def index():
    return FileResponse(STATIC_DIR / "index.html")


@app.post("/api/analyze")
async def analyze(image: UploadFile = File(...), notes: str = Form("")):
    data = await image.read()
    if not data:
        raise HTTPException(400, "Empty upload.")
    media_type, image_bytes = prepare_image(data, image.content_type or "")

    text = ANALYZE_INSTRUCTION
    if notes.strip():
        text += f"\n\nContext from the user about this part: {notes.strip()}"

    session_id = uuid.uuid4().hex
    sessions[session_id] = client.aio.chats.create(model=MODEL, config=CONFIG)
    message = [types.Part.from_bytes(data=image_bytes, mime_type=media_type), text]
    return StreamingResponse(stream_reply(session_id, message), media_type="text/event-stream")


class Question(BaseModel):
    session_id: str
    question: str


@app.post("/api/ask")
async def ask(q: Question):
    if q.session_id not in sessions:
        raise HTTPException(404, "Session not found - upload the image again.")
    if not q.question.strip():
        raise HTTPException(400, "Empty question.")
    if q.session_id in in_progress:
        raise HTTPException(409, "Previous answer is still in progress.")
    return StreamingResponse(stream_reply(q.session_id, q.question.strip()), media_type="text/event-stream")
