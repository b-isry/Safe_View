# SafeView — profanity_service.py
# Aggressive transcript matching: file blacklist + regex + substring fallback.

from __future__ import annotations

import json
import logging
import re
from pathlib import Path
from typing import Dict, List, Optional, Set

logger = logging.getLogger(__name__)

DATA_DIR = Path(__file__).resolve().parent / "data"
PROFANITY_LIST_PATH = DATA_DIR / "profanity_list.txt"
BLACKLIST_EN_PATH = DATA_DIR / "blacklist_en.json"
BLACKLIST_AM_PATH = DATA_DIR / "blacklist_am.json"

ACTION_ALLOW = "ALLOW"
ACTION_BEEP = "BEEP"
AUDIO_ACTION_BEEP = "BEEP"

_blacklist_en: Set[str] = set()
_blacklist_am: Set[str] = set()
_profanity_list: Set[str] = set()


def _load_profanity_list_txt(path: Path) -> Set[str]:
    """Load newline-separated terms from profanity_list.txt (lowercased)."""
    if not path.is_file():
        logger.warning("[SafeView] profanity_list.txt not found at %s", path)
        return set()

    try:
        lines = path.read_text(encoding="utf-8").splitlines()
    except OSError as exc:
        logger.warning("[SafeView] Failed to read profanity_list.txt: %s", exc)
        return set()

    return {
        line.strip().lower()
        for line in lines
        if line.strip() and not line.strip().startswith("#")
    }


def _load_blacklist_json(path: Path) -> Set[str]:
    if not path.is_file():
        return set()

    try:
        with path.open(encoding="utf-8") as handle:
            raw = json.load(handle)
    except (OSError, json.JSONDecodeError) as exc:
        logger.warning("[SafeView] Failed to load blacklist %s: %s", path, exc)
        return set()

    if not isinstance(raw, list):
        return set()

    return {
        str(entry).strip().lower()
        for entry in raw
        if isinstance(entry, str) and str(entry).strip()
    }


def _normalize_extra_words(extra_words: List[str] | None) -> Set[str]:
    if not extra_words:
        return set()
    return {
        str(word).strip().lower()
        for word in extra_words
        if isinstance(word, str) and str(word).strip()
    }


def _blacklist_for_language(language: str) -> Set[str]:
    if language == "en":
        return set(_blacklist_en)
    if language == "am":
        return set(_blacklist_am)
    return set()


def _merged_blacklist(language: str, extra_words: List[str] | None = None) -> Set[str]:
    merged = set(_profanity_list)
    merged.update(_blacklist_for_language(language))
    merged.update(_normalize_extra_words(extra_words))
    return {word for word in merged if word}


def load_blacklists() -> None:
    """Load JSON blacklists and profanity_list.txt at startup."""
    global _blacklist_en, _blacklist_am, _profanity_list

    _blacklist_en = _load_blacklist_json(BLACKLIST_EN_PATH)
    _blacklist_am = _load_blacklist_json(BLACKLIST_AM_PATH)
    _profanity_list = _load_profanity_list_txt(PROFANITY_LIST_PATH)

    logger.info(
        "[SafeView] Profanity lists loaded — txt=%s en=%s am=%s",
        len(_profanity_list),
        len(_blacklist_en),
        len(_blacklist_am),
    )


def _beep_result(matched_word: str) -> Dict[str, Optional[str] | bool]:
    print("!!! BEEP !!!")
    logger.info("[SafeView] Profanity match — BEEP triggered.")
    return {
        "detected": True,
        "matched_word": matched_word,
        "action": ACTION_BEEP,
        "audio_action": AUDIO_ACTION_BEEP,
    }


def check_profanity(
    transcribed_text: str,
    language: str,
    extra_words: List[str] | None = None,
) -> Dict[str, Optional[str] | bool]:
    """
    Match transcribed speech against blacklists (regex first, substring fallback).

    Returns audio_action BEEP when a term matches.
    """
    clean = transcribed_text.strip().lower()
    if not clean:
        return {
            "detected": False,
            "matched_word": None,
            "action": ACTION_ALLOW,
            "audio_action": ACTION_ALLOW,
        }

    blacklist = _merged_blacklist(language, extra_words)
    if not blacklist:
        return {
            "detected": False,
            "matched_word": None,
            "action": ACTION_ALLOW,
            "audio_action": ACTION_ALLOW,
        }

    lowered_text = clean

    for word in blacklist:
        try:
            pattern = re.compile(rf"\b{re.escape(word)}\b", re.IGNORECASE)
            if pattern.search(lowered_text):
                return _beep_result(word)
        except re.error:
            continue

    if any(word.lower() in lowered_text for word in blacklist):
        for word in blacklist:
            if word in lowered_text:
                return _beep_result(word)

    return {
        "detected": False,
        "matched_word": None,
        "action": ACTION_ALLOW,
        "audio_action": ACTION_ALLOW,
    }


load_blacklists()
