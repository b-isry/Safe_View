# SafeView — profanity_filter.py
# Authors: Blen Bizuayehu, Lidiya Getale, Bisrat Teshome
# Bahir Dar Institute of Technology — Software Engineering Capstone, 2018 EC
# Purpose: Load profanity blacklists at import and detect matches in transcribed text.

from __future__ import annotations

import json
import logging
import re
from pathlib import Path
from typing import Dict, List, Optional, Set

logger = logging.getLogger(__name__)

DATA_DIR = Path(__file__).resolve().parent / "data"
BLACKLIST_EN_PATH = DATA_DIR / "blacklist_en.json"
BLACKLIST_AM_PATH = DATA_DIR / "blacklist_am.json"

ACTION_ALLOW = "ALLOW"
ACTION_MUTE = "MUTE"

_blacklist_en: Set[str] = set()
_blacklist_am: Set[str] = set()

_WORD_SPLIT_RE = re.compile(r"\s+")


def _load_blacklist(path: Path) -> Set[str]:
    """
    Load a JSON array blacklist file into a set for O(1) membership checks.

    Args:
        path: Path to blacklist_*.json under backend/data/.

    Returns:
        set[str]: Lowercased/stripped terms; empty set if the file is missing or invalid.
    """
    if not path.is_file():
        logger.warning(
            "[SafeView] Profanity blacklist not found at %s. Detection disabled for this language.",
            path,
        )
        return set()

    try:
        with path.open(encoding="utf-8") as handle:
            raw = json.load(handle)
    except (OSError, json.JSONDecodeError) as exc:
        logger.warning(
            "[SafeView] Failed to load profanity blacklist at %s: %s. Detection disabled for this language.",
            path,
            exc,
        )
        return set()

    if not isinstance(raw, list):
        logger.warning(
            "[SafeView] Profanity blacklist at %s is not a JSON array. Detection disabled for this language.",
            path,
        )
        return set()

    return {
        str(entry).strip().lower()
        for entry in raw
        if isinstance(entry, str) and str(entry).strip()
    }


def _normalize_extra_words(extra_words: List[str] | None) -> Set[str]:
    """
    Lowercase/strip user-provided terms from the extension settings.

    Args:
        extra_words: Optional list from POST /analyze-audio profanity_words field.

    Returns:
        set[str]: Normalized terms to merge into the active blacklist.
    """
    if not extra_words:
        return set()

    return {
        str(word).strip().lower()
        for word in extra_words
        if isinstance(word, str) and str(word).strip()
    }


def _merged_blacklist(language: str, extra_words: List[str] | None = None) -> Set[str]:
    """
    Combine server blacklist JSON with optional user-provided terms.

    Args:
        language: Whisper language code — "en" or "am".
        extra_words: Optional extension profanity word list.

    Returns:
        set[str]: Union of file-backed and user terms.
    """
    merged = set(_blacklist_for_language(language))
    merged.update(_normalize_extra_words(extra_words))
    return merged


def _blacklist_for_language(language: str) -> Set[str]:
    """
    Return the in-memory blacklist for the requested language code.

    Args:
        language: Whisper language code — "en" or "am".

    Returns:
        set[str]: Blacklist terms for that language, or empty if unsupported.
    """
    if language == "en":
        return _blacklist_en
    if language == "am":
        return _blacklist_am
    return set()


def _word_matches_blacklist(word: str, blacklist: Set[str]) -> bool:
    """
    Return True if any blacklist term appears as a substring of word.

    Args:
        word: Single token from transcribed text (expected lowercase).
        blacklist: Loaded profanity terms for the active language.

    Returns:
        bool: True when a substring match is found.
    """
    for term in blacklist:
        if term in word:
            return True
    return False


def load_blacklists() -> None:
    """
    Load English and Amharic blacklist JSON files into module-level sets.

    Missing or invalid files log a warning and leave that language's set empty.
    """
    global _blacklist_en, _blacklist_am

    _blacklist_en = _load_blacklist(BLACKLIST_EN_PATH)
    _blacklist_am = _load_blacklist(BLACKLIST_AM_PATH)

    if _blacklist_en:
        logger.info(
            "[SafeView] Loaded %d English profanity blacklist entries.",
            len(_blacklist_en),
        )
    if _blacklist_am:
        logger.info(
            "[SafeView] Loaded %d Amharic profanity blacklist entries.",
            len(_blacklist_am),
        )


def detect_profanity(
    text: str,
    language: str,
    extra_words: List[str] | None = None,
) -> Dict[str, Optional[str] | bool]:
    """
    Delegate to profanity_service.check_profanity (regex + substring, BEEP on hit).
    """
    import profanity_service

    result = profanity_service.check_profanity(text, language, extra_words)
    logger.info(
        "[SafeView][Audio-B4] Profanity check: detected=%s, text_length=%s",
        result.get("detected"),
        len(text),
    )
    return result


load_blacklists()
