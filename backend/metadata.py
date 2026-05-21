# SafeView — metadata.py
# Authors: Blen Bizuayehu, Lidiya Getale, Bisrat Teshome
# Bahir Dar Institute of Technology — Software Engineering Capstone, 2018 EC
# Purpose: TMDb metadata filter stub with BR-06 token-bucket rate limiter (inactive until API key is set).
#
# ---------------------------------------------------------------------------
# ACTIVATING REAL TMDb LOOKUP (when ready — not required for capstone stub)
# ---------------------------------------------------------------------------
# 1. Create a free API key at https://www.themoviedb.org/settings/api
# 2. Set the environment variable before starting the backend:
#      Windows (PowerShell):  $env:TMDB_API_KEY = "your_v3_api_key_here"
#      Linux/macOS:           export TMDB_API_KEY="your_v3_api_key_here"
#    Or pass api_key explicitly to lookup_metadata(title, api_key="...").
# 3. Restart uvicorn so the process picks up the key.
# 4. Replace the stub body in lookup_metadata() (section marked TODO below) with
#    an HTTP GET to https://api.themoviedb.org/3/search/movie (or /tv) using
#    the key as ?api_key=... — map certification/ratings to BLUR vs ALLOW.
# Until that TODO is implemented, a configured key still returns ALLOW but
# enforces BR-06 (max 3 TMDb calls per minute via the token bucket).
# ---------------------------------------------------------------------------

from __future__ import annotations

import logging
import os
import time
from typing import Any, Dict, Optional

logger = logging.getLogger(__name__)

# BR-06: TMDb rate limit — 3 requests per minute when API integration is enabled
TMDB_REQUESTS_PER_MINUTE = 3
TMDB_BUCKET_CAPACITY = 3
TMDB_REFILL_RATE_PER_SECOND = TMDB_REQUESTS_PER_MINUTE / 60.0

TMDB_API_KEY_ENV = "TMDB_API_KEY"
TMDB_SEARCH_BASE_URL = "https://api.themoviedb.org/3/search/movie"

ACTION_ALLOW = "ALLOW"
ACTION_BLUR = "BLUR"
SOURCE_STUB = "stub"
SOURCE_TMDB = "tmdb"


class TokenBucket:
    """
    Token-bucket rate limiter ready for TMDb API activation (BR-06).

    Refills continuously at TMDB_REFILL_RATE_PER_SECOND up to TMDB_BUCKET_CAPACITY.
    """

    def __init__(self, capacity: int, refill_rate_per_second: float) -> None:
        """
        Initialize bucket state.

        Args:
            capacity: Maximum tokens (burst size).
            refill_rate_per_second: Tokens added per second.
        """
        self._capacity = float(capacity)
        self._refill_rate = refill_rate_per_second
        self._tokens = float(capacity)
        self._last_refill_monotonic = time.monotonic()

    def _refill(self) -> None:
        """Add tokens based on elapsed time since the last refill."""
        now = time.monotonic()
        elapsed_seconds = now - self._last_refill_monotonic
        self._tokens = min(
            self._capacity,
            self._tokens + elapsed_seconds * self._refill_rate,
        )
        self._last_refill_monotonic = now

    def consume(self, tokens: int = 1) -> bool:
        """
        Attempt to consume tokens; return False if rate limit would be exceeded.

        Args:
            tokens: Number of tokens to deduct.

        Returns:
            bool: True if the request is allowed; False if rate-limited.
        """
        if tokens <= 0:
            return True

        self._refill()
        if self._tokens >= tokens:
            self._tokens -= tokens
            return True
        return False


_tmdb_rate_limiter = TokenBucket(
    capacity=TMDB_BUCKET_CAPACITY,
    refill_rate_per_second=TMDB_REFILL_RATE_PER_SECOND,
)


def resolve_api_key(api_key: Optional[str] = None) -> Optional[str]:
    """
    Resolve TMDb API key from the argument or TMDB_API_KEY environment variable.

    Args:
        api_key: Explicit key override; empty strings are treated as missing.

    Returns:
        Optional[str]: Trimmed API key, or None if not configured.
    """
    if api_key is not None and api_key.strip():
        return api_key.strip()
    env_key = os.environ.get(TMDB_API_KEY_ENV, "").strip()
    return env_key or None


def lookup_metadata(title: str, api_key: Optional[str] = None) -> Dict[str, Any]:
    """
    TMDb metadata lookup stub — returns ALLOW until live TMDb mapping is implemented.

    Behavior:
        - No API key: immediate ALLOW (stub inactive); rate limiter not consumed.
        - API key set: BR-06 token bucket (3 req/min) is enforced; still ALLOW
          until the TODO HTTP integration below is implemented.

    Args:
        title: Media title to look up.
        api_key: Optional TMDb API key; falls back to TMDB_API_KEY env var.

    Returns:
        dict: Metadata decision including action, source, api_configured, rate_limited.
    """
    resolved_key = resolve_api_key(api_key)
    title_clean = title.strip()

    if not resolved_key:
        logger.info(
            "[SafeView][Metadata] Stub ALLOW for '%s' — set %s to activate TMDb.",
            title_clean,
            TMDB_API_KEY_ENV,
        )
        return _build_response(
            title=title_clean,
            action=ACTION_ALLOW,
            source=SOURCE_STUB,
            api_configured=False,
            rate_limited=False,
            message="TMDb API key not configured; stub returns ALLOW.",
        )

    if not _tmdb_rate_limiter.consume(1):
        logger.warning(
            "[SafeView][Metadata] TMDb rate limit exceeded (BR-06, %s req/min); "
            "failing open with ALLOW for '%s'.",
            TMDB_REQUESTS_PER_MINUTE,
            title_clean,
        )
        return _build_response(
            title=title_clean,
            action=ACTION_ALLOW,
            source=SOURCE_STUB,
            api_configured=True,
            rate_limited=True,
            message=(
                f"Rate limit exceeded ({TMDB_REQUESTS_PER_MINUTE} requests/minute); "
                "stub returns ALLOW."
            ),
        )

    # TODO: Replace stub with real TMDb HTTP call when certification mapping is defined.
    # Example (after key is set and rate limit passed):
    #   GET {TMDB_SEARCH_BASE_URL}?api_key={resolved_key}&query={title_clean}
    #   Parse adult/certification fields → action BLUR or ALLOW per product rules.
    logger.info(
        "[SafeView][Metadata] API key configured; stub ALLOW for '%s' (live lookup not wired).",
        title_clean,
    )
    return _build_response(
        title=title_clean,
        action=ACTION_ALLOW,
        source=SOURCE_STUB,
        api_configured=True,
        rate_limited=False,
        message="API key configured; live TMDb lookup not implemented — stub returns ALLOW.",
    )


def _build_response(
    title: str,
    action: str,
    source: str,
    api_configured: bool,
    rate_limited: bool,
    message: str,
) -> Dict[str, Any]:
    """
    Build a consistent metadata lookup response dict.

    Args:
        title: Media title that was queried.
        action: ALLOW or BLUR (stub always uses ALLOW).
        source: stub or tmdb.
        api_configured: Whether an API key was available.
        rate_limited: Whether BR-06 blocked a would-be API call.
        message: Human-readable status for logs/clients.

    Returns:
        dict: Normalized metadata filter result.
    """
    return {
        "title": title,
        "action": action,
        "source": source,
        "api_configured": api_configured,
        "rate_limited": rate_limited,
        "message": message,
    }
