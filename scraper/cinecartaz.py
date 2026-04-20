"""Cinecartaz scraper.

Pulls movie + cinema data from https://cinecartaz.publico.pt/.

Contract (verified against real pages, 2026-04-20):
- Homepage has inline <script> with many `window.Movies.push({...})` and
  `window.Rooms["REGION"].locals.push({...})` calls.
- Movie detail pages at /filme/{slug}-{id} have:
    div.tabsSession[data-id="Lisboa"|"Grande Lisboa"|...]
      .tab-day[data-menu="tab-{region}-{n}"] with day label
      ul.list-sessions.tab-{region}-{n} > li per cinema
        a[href="/cinema/...-{cinema_id}"] = cinema link
        div.shedule with time string

Shedule string format (verified):
  "13h15, 16h, 18h50, 21h40"              # bare times, no version -> inferred VO
  "13h15, 15h40 (VP)"                       # trailing (VP) -> dubbed
  "12h40, 15h40, 18h35, 21h40 | 21h50 (IMAX)"   # | separates segments, parenthetical = tech format
  "12h20, 15h10, 18h10, 21h20 | 17h40, 20h50 (4DX)"
"""

from __future__ import annotations

import logging
import re
import time as time_module
from datetime import date, datetime, timedelta
from typing import Optional
from urllib.parse import urljoin
from zoneinfo import ZoneInfo

import requests
from bs4 import BeautifulSoup
from requests.adapters import HTTPAdapter
from urllib3.util.retry import Retry

from models import CinemaShowtime, DaySession, Movie, TimeSlot

logger = logging.getLogger(__name__)

BASE_URL = "https://cinecartaz.publico.pt"
USER_AGENT = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36"
LISBON_TZ = ZoneInfo("Europe/Lisbon")

# Which regions we care about
TARGET_REGIONS = ("Lisboa", "Grande Lisboa")

# Portuguese weekday mapping (from tab labels like "QUARTA" etc.)
# Python: Monday=0 ... Sunday=6
WEEKDAY_PT = {
    "SEGUNDA": 0,
    "TERCA": 1,
    "TERÇA": 1,
    "QUARTA": 2,
    "QUINTA": 3,
    "SEXTA": 4,
    "SABADO": 5,
    "SÁBADO": 5,
    "DOMINGO": 6,
}

TECH_FORMATS = {"IMAX", "4DX", "3D", "ATMOS", "SCREENX", "XVISION", "XL VISION"}

# Matches window.Movies.push({ ... }) with JS object literal
MOVIES_PUSH_RE = re.compile(
    r"window\.Movies\.push\(\s*\{(.*?)\}\s*\);",
    re.DOTALL,
)

# Matches window.Rooms["REGION"].locals.push({ ... })
ROOMS_PUSH_RE = re.compile(
    r'window\.Rooms\["([^"]+)"\]\.locals\.push\(\s*\{(.*?)\}\s*\);',
    re.DOTALL,
)


def _make_session() -> requests.Session:
    """HTTP session with retries and UA."""
    s = requests.Session()
    retry = Retry(
        total=3,
        backoff_factor=0.5,
        status_forcelist=[500, 502, 503, 504],
        allowed_methods=["GET"],
    )
    s.mount("https://", HTTPAdapter(max_retries=retry))
    s.headers.update({"User-Agent": USER_AGENT})
    return s


def _parse_js_object(body: str) -> dict:
    """Parse a JS object literal body (without the outer {}).

    Handles cinecartaz's specific format: unquoted keys, single or double quotes,
    numeric arrays, trailing commas.

    Example input:
        id: 414326,
        title: "Foo",
        url: "/filme/foo-414326",
        cinemas:[270072,302946],
        locations: ['Lisboa','Porto']
    """
    # Quote unquoted keys: "key:" -> '"key":'
    text = re.sub(r"(\b[a-zA-Z_][a-zA-Z0-9_]*)\s*:", r'"\1":', body)
    # Replace single quotes with double quotes
    text = text.replace("'", '"')
    # Remove trailing commas before closing brackets
    text = re.sub(r",(\s*[\]}])", r"\1", text)
    # Wrap as object
    import json

    return json.loads("{" + text + "}")


def fetch_homepage_data(session: Optional[requests.Session] = None) -> tuple[list[dict], dict[str, list[dict]]]:
    """Fetch and parse window.Movies and window.Rooms from cinecartaz homepage.

    Returns (movies, rooms_by_region).
    """
    session = session or _make_session()
    logger.info("Fetching cinecartaz homepage")
    resp = session.get(BASE_URL, timeout=15)
    resp.raise_for_status()
    html = resp.text

    movies: list[dict] = []
    seen_ids: set[int] = set()
    for m in MOVIES_PUSH_RE.finditer(html):
        try:
            obj = _parse_js_object(m.group(1))
            mid = int(obj.get("id", 0))
            if mid in seen_ids:
                continue  # cinecartaz duplicates some movies in the JS
            seen_ids.add(mid)
            movies.append(obj)
        except Exception as e:
            logger.warning("Failed to parse movie push: %s (body: %s)", e, m.group(1)[:200])

    rooms_by_region: dict[str, list[dict]] = {}
    seen_rooms: dict[str, set[int]] = {}
    for m in ROOMS_PUSH_RE.finditer(html):
        region = m.group(1)
        try:
            room = _parse_js_object(m.group(2))
            rid = int(room.get("id", 0))
            seen_in_region = seen_rooms.setdefault(region, set())
            if rid in seen_in_region:
                continue
            seen_in_region.add(rid)
            rooms_by_region.setdefault(region, []).append(room)
        except Exception as e:
            logger.warning("Failed to parse room push for %s: %s", region, e)

    logger.info(
        "Parsed %d movies, rooms in regions: %s",
        len(movies),
        {k: len(v) for k, v in rooms_by_region.items()},
    )
    return movies, rooms_by_region


def get_lisbon_cinemas(rooms_by_region: dict[str, list[dict]]) -> dict[int, dict]:
    """Combine Lisboa + Grande Lisboa rooms into {id: room_dict}."""
    result: dict[int, dict] = {}
    for region in TARGET_REGIONS:
        for room in rooms_by_region.get(region, []):
            rid = room.get("id")
            if rid:
                result[int(rid)] = {**room, "region": region}
    return result


def filter_lisbon_movies(movies: list[dict], lisbon_ids: set[int]) -> list[dict]:
    """Keep movies that play in at least one Lisbon cinema."""
    result = []
    for m in movies:
        cinemas = m.get("cinemas") or []
        if any(int(cid) in lisbon_ids for cid in cinemas):
            result.append(m)
    return result


def _resolve_day_date(day_label: str, tab_index: int, scrape_date: date) -> Optional[date]:
    """Resolve a day tab label to an absolute date.

    tab_index is 1-based (1=Hoje, 2=Amanha, 3=day+2).
    We trust tab_index primarily (since labels are brittle).
    """
    return scrape_date + timedelta(days=tab_index - 1)


def _parse_shedule_string(text: str) -> list[TimeSlot]:
    """Parse a div.shedule string into TimeSlot list.

    Examples:
        "13h15, 16h, 18h50, 21h40" -> 4 slots, inferred VO
        "13h15, 15h40 (VP)" -> 2 slots, dubbed
        "12h40, 15h40 | 21h50 (IMAX)" -> 2 VO + 1 VO+IMAX
    """
    if not text or not text.strip():
        return []

    slots: list[TimeSlot] = []
    # Split on | into segments
    segments = [s.strip() for s in text.split("|") if s.strip()]

    for seg in segments:
        # Extract optional trailing (LABEL)
        m = re.match(r"^(.*?)\s*(?:\(([^)]+)\))?\s*$", seg, re.DOTALL)
        if not m:
            continue
        times_part = m.group(1).strip().rstrip(",").strip()
        label = (m.group(2) or "").strip().upper() if m.group(2) else None

        dubbed = False
        tech_format: Optional[str] = None
        inferred_vo = True

        if label:
            if label == "VP":
                dubbed = True
                inferred_vo = False
            elif label == "VO":
                inferred_vo = False  # explicit VO (rare)
            elif label in TECH_FORMATS:
                tech_format = label
            else:
                # could be a combination like "VP 3D" or "VO IMAX"
                tokens = label.split()
                if "VP" in tokens:
                    dubbed = True
                    inferred_vo = False
                elif "VO" in tokens:
                    inferred_vo = False
                for t in tokens:
                    if t in TECH_FORMATS:
                        tech_format = t

        # Split times on comma
        for t in times_part.split(","):
            t = t.strip()
            if not t:
                continue
            normalized = _normalize_time(t)
            if normalized:
                slots.append(
                    TimeSlot(
                        time=normalized,
                        dubbed=dubbed,
                        tech_format=tech_format,
                        inferred_vo=inferred_vo,
                    )
                )
    return slots


def _normalize_time(t: str) -> Optional[str]:
    """Normalize times like '13h' -> '13h00', '21h40' -> '21h40'."""
    t = t.strip().lower()
    m = re.match(r"^(\d{1,2})h(\d{0,2})$", t)
    if not m:
        return None
    hh = m.group(1).zfill(2)
    mm = (m.group(2) or "00").ljust(2, "0")
    return f"{hh}h{mm}"


def _extract_cinema_id_from_link(href: str) -> Optional[int]:
    """Extract trailing numeric ID from '/cinema/slug-12345'."""
    m = re.search(r"-(\d+)$", href)
    return int(m.group(1)) if m else None


def fetch_movie_showtimes(
    movie_dict: dict,
    lisbon_cinema_ids: set[int],
    scrape_date: date,
    session: Optional[requests.Session] = None,
) -> Optional[Movie]:
    """Fetch and parse a movie detail page.

    Returns a Movie object with showtimes for Lisbon-area cinemas, or None if the
    movie has no Lisbon showings or the page is unreachable.
    """
    session = session or _make_session()
    url = urljoin(BASE_URL, movie_dict["url"])
    logger.debug("Fetching movie page: %s", url)
    try:
        resp = session.get(url, timeout=15)
        resp.raise_for_status()
    except Exception as e:
        logger.warning("Failed to fetch %s: %s", url, e)
        return None

    soup = BeautifulSoup(resp.text, "lxml")

    # Metadata (optional - extract what we can)
    metadata = _extract_movie_metadata(soup)

    # Showtimes
    showtimes_by_cinema: dict[int, list[DaySession]] = {}

    for region in TARGET_REGIONS:
        tab_section = soup.select_one(f'div.tabsSession[data-id="{region}"]')
        if not tab_section:
            continue

        # Find day tabs to get labels in order
        day_tabs = tab_section.select(f'div.tab-day[data-menu^="tab-{region}-"]')
        day_info: dict[int, str] = {}
        for tab in day_tabs:
            menu = tab.get("data-menu", "")
            m = re.search(rf"tab-{re.escape(region)}-(\d+)$", menu)
            if not m:
                continue
            idx = int(m.group(1))
            p = tab.select_one("p.day")
            label = p.get_text(strip=True) if p else ""
            day_info[idx] = label

        # Find session lists for each day
        for idx, label in day_info.items():
            ul = tab_section.select_one(f"ul.list-sessions.tab-{region}-{idx}")
            if not ul:
                continue
            day_date = _resolve_day_date(label, idx, scrape_date)
            if not day_date:
                continue

            for li in ul.select("li"):
                link = li.select_one("p.schedule-detail_section_cinema_name a")
                shedule = li.select_one("div.shedule")
                if not link or not shedule:
                    continue
                cid = _extract_cinema_id_from_link(link.get("href", ""))
                if cid is None or cid not in lisbon_cinema_ids:
                    continue
                times = _parse_shedule_string(shedule.get_text(strip=True))
                if not times:
                    continue

                # De-dupe identical day_sessions for same cinema/date
                sessions = showtimes_by_cinema.setdefault(cid, [])
                existing = next((s for s in sessions if s.date == day_date.isoformat()), None)
                if existing:
                    # merge times (preserve order, skip exact dupes)
                    seen = {(t.time, t.dubbed, t.tech_format) for t in existing.times}
                    for t in times:
                        key = (t.time, t.dubbed, t.tech_format)
                        if key not in seen:
                            existing.times.append(t)
                            seen.add(key)
                else:
                    sessions.append(
                        DaySession(
                            date=day_date.isoformat(),
                            day_label=label,
                            times=times,
                        )
                    )

    if not showtimes_by_cinema:
        return None

    showtimes = [
        CinemaShowtime(cinema_id=cid, sessions=sorted(sessions, key=lambda s: s.date))
        for cid, sessions in showtimes_by_cinema.items()
    ]

    return Movie(
        id=int(movie_dict["id"]),
        title=movie_dict.get("title", ""),
        url=movie_dict.get("url", ""),
        showtimes=showtimes,
        **metadata,
    )


def _extract_movie_metadata(soup: BeautifulSoup) -> dict:
    """Pull genre, duration, age rating, director from the movie page.

    These are best-effort - fall back to None if not found.
    """
    meta: dict = {}

    # Typical structure has a .info or similar div with labeled fields.
    # We grep loosely for common patterns.
    text_blocks = soup.select(".movie-info, .film-info, .info-movie, .ficha")
    combined = " | ".join(b.get_text(" ", strip=True) for b in text_blocks)

    if not combined:
        # fallback: whole page text, but keep it short
        combined = soup.get_text(" ", strip=True)[:3000]

    # Duration: "1h58" or "118 min" or "128'"
    dur_match = re.search(r"(\d+)\s*h\s*(\d+)|\b(\d{2,3})\s*min\b|\b(\d{2,3})'\b", combined)
    if dur_match:
        if dur_match.group(1):
            meta["duration_min"] = int(dur_match.group(1)) * 60 + int(dur_match.group(2) or 0)
        elif dur_match.group(3):
            meta["duration_min"] = int(dur_match.group(3))
        elif dur_match.group(4):
            meta["duration_min"] = int(dur_match.group(4))

    # Age rating: "M/14", "M/12", "M/6", "M/16", "M/18"
    age_match = re.search(r"\bM/(\d{1,2})\b", combined)
    if age_match:
        meta["age_rating"] = f"M/{age_match.group(1)}"

    # Director: "Realização: Foo Bar" or "Realizador: Foo Bar"
    dir_match = re.search(r"Realiza(?:dor|ç[ãa]o)[:\s]+([A-ZÀ-Ý][A-Za-zÀ-ÿ\s\.\-]+?)(?:\s*[,|]|\s+Elenco|\s+G[ée]nero|$)", combined)
    if dir_match:
        meta["director"] = dir_match.group(1).strip()

    # Genre: "Género: Foo" or "Género: Foo, Bar"
    gen_match = re.search(r"G[ée]nero[:\s]+([A-Za-zÀ-ÿ,\s]+?)(?:\s*[|]|\s+Realiza|\s+Duraç|\s+Pa[íi]s|$)", combined)
    if gen_match:
        meta["genre"] = gen_match.group(1).strip().rstrip(",")

    # Original title: find "Título Original" section header, take the following text.
    # Structure: <h3 class="...">Título Original</h3> ... <p><a ...>One Battle After Another</a></p>
    orig_header = soup.find(lambda tag: tag.name in ("h3", "h4", "h2")
                            and "T\u00edtulo Original" in tag.get_text(strip=True))
    if orig_header:
        # Find next <p> or <a> with content
        sib = orig_header.find_next(["p", "a"])
        if sib:
            orig_text = sib.get_text(" ", strip=True)
            if orig_text and len(orig_text) < 200:
                meta["original_title"] = orig_text

    return meta


def validate_scrape_date(
    rooms_by_region: dict[str, list[dict]],
    scrape_date: date,
    session: Optional[requests.Session] = None,
    sample_movie_url: Optional[str] = None,
) -> tuple[bool, str]:
    """Sanity check: fetch a sample movie page and verify the 3rd tab's weekday
    matches `scrape_date + 2 days`.

    Returns (is_valid, message).
    """
    if not sample_movie_url:
        return True, "no sample movie provided, skipping date validation"

    session = session or _make_session()
    try:
        resp = session.get(urljoin(BASE_URL, sample_movie_url), timeout=15)
        resp.raise_for_status()
    except Exception as e:
        return False, f"could not fetch sample movie for validation: {e}"

    soup = BeautifulSoup(resp.text, "lxml")
    tab = soup.select_one(f'div.tabsSession[data-id="Lisboa"] .tab-day[data-menu="tab-Lisboa-3"] p.day')
    if not tab:
        return True, "day-3 tab not present (movie may only run 1-2 days); skipping validation"

    label = tab.get_text(strip=True).upper()
    expected_day = (scrape_date + timedelta(days=2)).weekday()
    actual_day = WEEKDAY_PT.get(label)

    if actual_day is None:
        return True, f"day-3 label '{label}' not a known weekday; skipping validation"

    if actual_day != expected_day:
        return (
            False,
            f"date mismatch: day-3 tab says {label} (weekday {actual_day}) "
            f"but scrape_date+2 is weekday {expected_day}. Site layout may have changed.",
        )
    return True, f"date validation passed ({label} == weekday {expected_day})"


def scrape_all(
    api_delay: float = 0.5,
    max_movies: Optional[int] = None,
) -> tuple[list[Movie], list[dict]]:
    """Top-level: scrape everything, return (movies, lisbon_cinemas_raw).

    Lisbon cinemas raw are the {id, name, location, region, ...} dicts from cinecartaz.
    """
    session = _make_session()
    scrape_date = datetime.now(LISBON_TZ).date()

    movies_raw, rooms_by_region = fetch_homepage_data(session)
    lisbon_cinemas = get_lisbon_cinemas(rooms_by_region)
    lisbon_ids = set(lisbon_cinemas.keys())
    filtered = filter_lisbon_movies(movies_raw, lisbon_ids)

    logger.info("Filtered to %d movies playing in %d Lisbon cinemas", len(filtered), len(lisbon_ids))

    # Date validation using first movie as sample
    if filtered:
        sample_url = filtered[0].get("url")
        is_valid, msg = validate_scrape_date(rooms_by_region, scrape_date, session, sample_url)
        logger.info("Date validation: %s", msg)
        if not is_valid:
            raise RuntimeError(f"Date validation failed: {msg}")

    if max_movies:
        filtered = filtered[:max_movies]

    movies: list[Movie] = []
    for i, m in enumerate(filtered, 1):
        logger.info("[%d/%d] Fetching %s", i, len(filtered), m.get("title"))
        movie = fetch_movie_showtimes(m, lisbon_ids, scrape_date, session)
        if movie:
            movies.append(movie)
        time_module.sleep(api_delay)

    return movies, list(lisbon_cinemas.values())
