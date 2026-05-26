# SafeView — audio_processor.py
# Authors: Blen Bizuayehu, Lidiya Getale, Bisrat Teshome
# Bahir Dar Institute of Technology — Software Engineering Capstone, 2018 EC
# Purpose: Load OpenAI Whisper locally once at import and transcribe WebM audio bytes.

from __future__ import annotations

import io
import logging
import os
import shutil
import subprocess
import tempfile
import time
from pathlib import Path
from typing import Any, Optional

logger = logging.getLogger(__name__)

WHISPER_MODEL_NAME = "tiny"
WHISPER_SAMPLE_RATE = 16000
WHISPER_CHANNELS = 1

# whisper-tiny — lower CPU use while profanity audio is mutually exclusive with vision.

_whisper_model: Optional[Any] = None
WHISPER_LOADED: bool = False
PYDUB_AVAILABLE: bool = False
FFMPEG_AVAILABLE: bool = False

_AudioSegment: Any = None


def _safe_import_pydub() -> bool:
    """Import pydub once; log clearly when the package is missing."""
    global PYDUB_AVAILABLE, _AudioSegment

    if PYDUB_AVAILABLE and _AudioSegment is not None:
        return True

    try:
        from pydub import AudioSegment

        _AudioSegment = AudioSegment
        PYDUB_AVAILABLE = True
        return True
    except ImportError as exc:
        PYDUB_AVAILABLE = False
        _AudioSegment = None
        print(
            "CRITICAL: pydub is not installed. "
            "Run: pip install pydub (inside backend/.venv)"
        )
        logger.critical("[SafeView] pydub import failed: %s", exc)
        return False


def _resolve_ffmpeg_paths() -> tuple[str | None, str | None]:
    """
    Locate ffmpeg/ffprobe on PATH or common install locations (Windows-friendly).
    """
    ffmpeg = shutil.which("ffmpeg")
    ffprobe = shutil.which("ffprobe")

    if ffmpeg:
        return ffmpeg, ffprobe

    local_app = os.environ.get("LOCALAPPDATA", "")
    candidates = [
        Path(local_app) / "Microsoft" / "WinGet" / "Links" / "ffmpeg.exe",
        Path("C:/ffmpeg/bin/ffmpeg.exe"),
        Path("C:/Program Files/ffmpeg/bin/ffmpeg.exe"),
    ]

    for candidate in candidates:
        if candidate.is_file():
            ffmpeg = str(candidate)
            probe = candidate.parent / "ffprobe.exe"
            ffprobe = str(probe) if probe.is_file() else None
            return ffmpeg, ffprobe

    return None, None


def _configure_ffmpeg_for_pydub() -> bool:
    """Point pydub at ffmpeg; required for WebM/Opus → WAV conversion."""
    global FFMPEG_AVAILABLE

    if not _safe_import_pydub():
        FFMPEG_AVAILABLE = False
        return False

    ffmpeg, ffprobe = _resolve_ffmpeg_paths()
    if not ffmpeg:
        FFMPEG_AVAILABLE = False
        print("CRITICAL: FFmpeg not found on system path.")
        logger.critical(
            "[SafeView] FFmpeg not found — install ffmpeg and add it to PATH "
            "(e.g. winget install Gyan.FFmpeg)"
        )
        return False

    _AudioSegment.converter = ffmpeg
    if ffprobe:
        _AudioSegment.ffprobe = ffprobe

    FFMPEG_AVAILABLE = True
    logger.info("[SafeView] FFmpeg configured for pydub: %s", ffmpeg)
    return True


def load_whisper() -> None:
    """
    Load the Whisper tiny checkpoint once into the module-level cache.

    On success, sets _whisper_model and WHISPER_LOADED=True. On failure, logs,
    leaves _whisper_model=None, and sets WHISPER_LOADED=False (fail open).
    """
    global _whisper_model, WHISPER_LOADED

    _configure_ffmpeg_for_pydub()

    try:
        import whisper

        _whisper_model = whisper.load_model(WHISPER_MODEL_NAME)
        WHISPER_LOADED = True
        logger.info(
            "[SafeView] Loaded whisper-%s model.",
            WHISPER_MODEL_NAME,
        )
    except Exception as exc:
        logger.error(
            "[SafeView] Failed to load whisper-%s: %s. Audio transcription will fail open.",
            WHISPER_MODEL_NAME,
            exc,
        )
        _whisper_model = None
        WHISPER_LOADED = False


def is_silent(audio_bytes: bytes) -> bool:
    """
    Skip tiny chunks before decode/transcribe.

    Note: RMS is only meaningful after decode; raw WebM bytes are not checked here.
    """
    if len(audio_bytes) < 1000:
        return True
    return False


def _normalize_wav_segment(segment: Any) -> Any:
    """Force Whisper-friendly PCM: 16 kHz mono."""
    return (
        segment.set_frame_rate(WHISPER_SAMPLE_RATE)
        .set_channels(WHISPER_CHANNELS)
    )


def _export_wav_bytes(segment: Any) -> bytes:
    """Export AudioSegment to WAV bytes (16 kHz, mono)."""
    wav_buffer = io.BytesIO()
    segment.export(
        wav_buffer,
        format="wav",
        parameters=["-ac", str(WHISPER_CHANNELS), "-ar", str(WHISPER_SAMPLE_RATE)],
    )
    return wav_buffer.getvalue()


def _ffmpeg_convert_to_wav(audio_bytes: bytes, input_format: str) -> bytes | None:
    """
    Fallback WebM → WAV via ffmpeg CLI when pydub fails.
    """
    ffmpeg, _ = _resolve_ffmpeg_paths()
    if not ffmpeg:
        print("CRITICAL: FFmpeg not found on system path.")
        return None

    suffix = ".webm" if input_format == "webm" else f".{input_format}"
    in_path: str | None = None
    out_path: str | None = None

    try:
        with tempfile.NamedTemporaryFile(suffix=suffix, delete=False) as inp:
            inp.write(audio_bytes)
            in_path = inp.name

        out_path = in_path + ".wav"
        subprocess.run(
            [
                ffmpeg,
                "-y",
                "-hide_banner",
                "-loglevel",
                "error",
                "-i",
                in_path,
                "-ac",
                str(WHISPER_CHANNELS),
                "-ar",
                str(WHISPER_SAMPLE_RATE),
                "-f",
                "wav",
                out_path,
            ],
            check=True,
            capture_output=True,
            timeout=30,
        )
        wav_bytes = Path(out_path).read_bytes()
        if len(wav_bytes) < 44:
            logger.warning("[SafeView] ffmpeg produced suspiciously small WAV.")
            return None
        return wav_bytes
    except subprocess.CalledProcessError as exc:
        stderr = exc.stderr.decode("utf-8", errors="replace") if exc.stderr else str(exc)
        logger.error("[SafeView] ffmpeg conversion failed: %s", stderr)
        return None
    except Exception as exc:
        logger.error("[SafeView] ffmpeg fallback failed: %s", exc)
        return None
    finally:
        for path in (in_path, out_path):
            if path and os.path.isfile(path):
                try:
                    os.unlink(path)
                except OSError:
                    pass


def audio_bytes_to_wav_bytes(audio_bytes: bytes, audio_format: str = "webm") -> bytes | None:
    """
    Extract PCM audio from WebM/Opus or WAV bytes using pydub (+ ffmpeg fallback).

    Output is strictly 16 kHz mono WAV for Whisper on CPU.

    Args:
        audio_bytes: Raw audio chunk from the client.
        audio_format: Container hint — "webm" or "wav".

    Returns:
        bytes | None: WAV file bytes, or None when conversion fails.
    """
    fmt = audio_format.strip().lower()
    if fmt == "wav":
        if len(audio_bytes) >= 4 and audio_bytes[:4] == b"RIFF":
            if _safe_import_pydub():
                try:
                    segment = _AudioSegment.from_wav(io.BytesIO(audio_bytes))
                    return _export_wav_bytes(_normalize_wav_segment(segment))
                except Exception as exc:
                    logger.warning("[SafeView] WAV re-normalize failed: %s", exc)
            return audio_bytes
        fmt = "webm"

    if not _safe_import_pydub():
        return _ffmpeg_convert_to_wav(audio_bytes, fmt)

    if not _configure_ffmpeg_for_pydub():
        return _ffmpeg_convert_to_wav(audio_bytes, fmt)

    try:
        segment = _AudioSegment.from_file(io.BytesIO(audio_bytes), format=fmt)
        wav_bytes = _export_wav_bytes(_normalize_wav_segment(segment))
        print(f"[AI-AUDIO] Conversion Success. WAV Size: {len(wav_bytes)} bytes")
        return wav_bytes
    except Exception as exc:
        logger.error("[SafeView] Pydub Error (%s): %s", fmt, exc)
        print(f"[SafeView] Pydub conversion failed ({fmt}): {exc}")

    wav_bytes = _ffmpeg_convert_to_wav(audio_bytes, fmt)
    if wav_bytes:
        print(f"[AI-AUDIO] Conversion Success. WAV Size: {len(wav_bytes)} bytes")
    return wav_bytes


def webm_to_wav_bytes(audio_bytes: bytes) -> bytes | None:
    """Backward-compatible WebM → WAV helper."""
    return audio_bytes_to_wav_bytes(audio_bytes, audio_format="webm")


def transcribe_audio(
    audio_bytes: bytes,
    language: str,
    audio_format: str = "webm",
) -> str:
    """
    Transcribe audio bytes using Whisper. Converts to WAV first when needed.

    Args:
        audio_bytes: Raw audio from the client (WebM or WAV).
        language: Whisper language code (e.g. en, am).
        audio_format: Container hint — "webm" or "wav".

    Returns:
        str: Transcribed text, or empty string on error or if Whisper is not loaded.
    """
    logger.info(
        "[SafeView][Audio-B1] Processing standalone file: %s bytes",
        len(audio_bytes),
    )
    logger.info(
        "[SafeView][Audio-B1] Received audio chunk, size=%s bytes, language=%s",
        len(audio_bytes),
        language,
    )

    if not WHISPER_LOADED or _whisper_model is None:
        logger.error(
            "[SafeView] transcribe_audio called but whisper-%s is not loaded.",
            WHISPER_MODEL_NAME,
        )
        return ""

    if is_silent(audio_bytes):
        logger.debug("[SafeView][Audio-B2] Chunk too small — skipped")
        return ""

    wav_bytes = audio_bytes_to_wav_bytes(audio_bytes, audio_format=audio_format)
    if not wav_bytes:
        logger.warning(
            "[SafeView][Audio-B2] Audio to WAV conversion failed — chunk skipped (size=%s, format=%s)",
            len(audio_bytes),
            audio_format,
        )
        return ""

    tmp_path: Optional[str] = None
    transcribe_started = time.perf_counter()
    try:
        with tempfile.NamedTemporaryFile(suffix=".wav", delete=False) as tmp:
            tmp.write(wav_bytes)
            tmp_path = tmp.name

        result = _whisper_model.transcribe(
            tmp_path,
            language=language,
            beam_size=1,
            best_of=1,
            temperature=0,
            fp16=False,
            condition_on_previous_text=False,
        )
        text = result.get("text", "").strip().lower()
        elapsed_ms = (time.perf_counter() - transcribe_started) * 1000
        logger.info(
            "[SafeView][Audio-B3] Transcription complete — length=%s (processed in %.0fms)",
            len(text),
            elapsed_ms,
        )
        return text
    except Exception as exc:
        logger.error(
            "[SafeView] transcribe_audio failed (language=%s): %s",
            language,
            exc,
        )
        return ""
    finally:
        if tmp_path is not None:
            try:
                os.unlink(tmp_path)
            except OSError:
                pass


load_whisper()
