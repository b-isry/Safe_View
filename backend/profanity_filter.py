# SafeView — profanity_filter.py
# Authors: Blen Bizuayehu, Lidiya Getale, Bisrat Teshome
# Bahir Dar Institute of Technology — Software Engineering Capstone, 2018 EC
# Purpose: Load profanity blacklists at import and detect matches in transcribed text.

from __future__ import annotations

import json
import logging
import re
from pathlib import Path
from typing import Dict, Optional, Set

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


def detect_profanity(text: str, language: str) -> Dict[str, Optional[str] | bool]:
    """
    Scan transcribed text for profanity using language-specific blacklists.

    Each whitespace-separated word is checked for substring matches against
    blacklist terms (e.g. "fucking" matches "fuck"). Matched words are never
    written to logs.

    Args:
        text: Transcribed audio or subtitle text (typically lowercased).
        language: Language code "en" or "am".

    Returns:
        dict: detected, matched_word (first hit or None), action (MUTE or ALLOW).
    """
    clean = text.strip().lower()
    if not clean:
        return {
            "detected": False,
            "matched_word": None,
            "action": ACTION_ALLOW,
        }

    blacklist = _blacklist_for_language(language)
    if not blacklist:
        return {
            "detected": False,
            "matched_word": None,
            "action": ACTION_ALLOW,
        }

    for word in _WORD_SPLIT_RE.split(clean):
        if not word:
            continue
        if _word_matches_blacklist(word, blacklist):
            logger.info("[SafeView] Profanity detected.")
            return {
                "detected": True,
                "matched_word": word,
                "action": ACTION_MUTE,
            }

    return {
        "detected": False,
        "matched_word": None,
        "action": ACTION_ALLOW,
    }


load_blacklists()
