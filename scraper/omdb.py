"""OMDB enrichment - adds ratings + original language to Movie objects.

OMDB API: https://www.omdbapi.com/
Free tier: 1000 requests/day. We typically need ~30-60 per scrape, well under.

Title matching strategy:
1. If movie has original_title (from cinecartaz), try that first
2. Fall back to the cinecartaz Portuguese title
3. Last resort: strip Portuguese subtitle after colon and retry
4. If still no match, leave ratings/language as None

The Language field comes in the SAME response as ratings, so it's free.
"""

from __future__ import annotations

import logging
import re
import time as time_module
from typing import Optional

import requests

from models import Movie, Ratings

logger = logging.getLogger(__name__)

OMDB_URL = "https://www.omdbapi.com/"


def _query_omdb(session: requests.Session, api_key: str, title: str) -> Optional[dict]:
    """Query OMDB for a title. Returns the response dict or None on miss/error."""
    try:
        resp = session.get(
            OMDB_URL,
            params={"t": title, "apikey": api_key, "type": "movie"},
            timeout=10,
        )
        if resp.status_code != 200:
            return None
        data = resp.json()
        if data.get("Response") == "False":
            return None
        return data
    except Exception as e:
        logger.warning("OMDB query failed for '%s': %s", title, e)
        return None


def _translate_article(title: str) -> Optional[str]:
    """Common Portuguese -> English article swap: 'O Drama' -> 'The Drama'.

    Heuristic — OMDB search is lenient so this catches a lot of English-origin
    films whose Portuguese release title just swapped the article.
    """
    m = re.match(r"^(O|A|Os|As)\s+(.+)$", title)
    if m:
        return f"The {m.group(2)}"
    return None


def _strip_subtitle(title: str) -> Optional[str]:
    """Drop 'Main Title: Subtitle' -> 'Main Title'."""
    if ":" in title:
        before, _, _ = title.partition(":")
        stripped = before.strip()
        if stripped and stripped != title:
            return stripped
    if " - " in title:
        before, _, _ = title.partition(" - ")
        stripped = before.strip()
        if stripped and stripped != title:
            return stripped
    return None


def _extract_ratings(data: dict) -> Ratings:
    """Extract ratings from OMDB response."""
    r = Ratings()
    for rating in data.get("Ratings", []) or []:
        source = rating.get("Source", "")
        value = rating.get("Value", "")
        if "Internet Movie Database" in source:
            # "7.2/10" -> "7.2"
            m = re.match(r"([\d.]+)", value)
            if m:
                r.imdb = m.group(1)
        elif "Rotten Tomatoes" in source:
            r.rt_critic = value  # e.g. "85%"
        elif "Metacritic" in source:
            # "65/100" -> "65"
            m = re.match(r"(\d+)", value)
            if m:
                r.metacritic = m.group(1)
    # Also check top-level imdbRating as fallback
    if not r.imdb and data.get("imdbRating") and data.get("imdbRating") != "N/A":
        r.imdb = data["imdbRating"]
    if data.get("imdbID"):
        r.imdb_id = data["imdbID"]
    return r


def _extract_languages(data: dict) -> tuple[Optional[str], list[str]]:
    """Parse 'English, Spanish, French' -> ('English', ['English','Spanish','French'])."""
    lang_str = data.get("Language", "")
    if not lang_str or lang_str == "N/A":
        return None, []
    languages = [s.strip() for s in lang_str.split(",") if s.strip()]
    primary = languages[0] if languages else None
    return primary, languages


def enrich_movies(movies: list[Movie], api_key: str, delay: float = 0.25) -> None:
    """Mutate movies in place, adding ratings + language from OMDB.

    Logs misses so operator can add manual overrides if needed.
    """
    if not api_key:
        logger.warning("No OMDB API key; skipping enrichment")
        return

    session = requests.Session()
    hits = 0
    misses = 0

    for movie in movies:
        candidates: list[str] = []
        if movie.original_title:
            candidates.append(movie.original_title)
        candidates.append(movie.title)
        translated = _translate_article(movie.title)
        if translated:
            candidates.append(translated)
        stripped = _strip_subtitle(movie.title)
        if stripped:
            candidates.append(stripped)

        data = None
        used_title = None
        for title in candidates:
            data = _query_omdb(session, api_key, title)
            if data:
                # Reject low-confidence matches: if OMDB returned no IMDB rating,
                # it's likely a different same-titled film (and we can't trust
                # its language metadata either).
                imdb_rating = data.get("imdbRating")
                if not imdb_rating or imdb_rating == "N/A":
                    logger.debug(
                        "OMDB low-confidence (no rating) for '%s' -> '%s', skipping",
                        movie.title, title,
                    )
                    data = None
                    time_module.sleep(delay)
                    continue
                used_title = title
                break
            time_module.sleep(delay)

        if not data:
            misses += 1
            logger.info("OMDB miss: '%s' (tried %s)", movie.title, candidates)
            time_module.sleep(delay)
            continue

        hits += 1
        movie.ratings = _extract_ratings(data)
        primary, langs = _extract_languages(data)
        movie.original_language = primary
        movie.original_languages = langs
        if data.get("Title") and not movie.original_title:
            movie.original_title = data["Title"]
        # Poster + English plot (OMDB). Cinecartaz fallbacks are already populated.
        poster = data.get("Poster")
        if poster and poster != "N/A":
            movie.poster_url = poster  # prefer OMDB over cinecartaz for English-market art
        plot = data.get("Plot")
        if plot and plot != "N/A":
            movie.plot_en = plot
        logger.debug("OMDB hit: '%s' -> '%s' (%s)", movie.title, used_title, primary)
        time_module.sleep(delay)

    logger.info("OMDB enrichment: %d hits, %d misses (of %d movies)", hits, misses, len(movies))
