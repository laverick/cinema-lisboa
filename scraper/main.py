"""Orchestrates the cinema showtimes scrape.

Usage:
    python main.py --output-dir ../site/data
    python main.py --output-dir /tmp --max-movies 3   # quick test
    OMDB_API_KEY=xxxxx python main.py

Output: writes showtimes.json to {output_dir}/.
"""

from __future__ import annotations

import argparse
import json
import logging
import os
import sys
from datetime import datetime, timezone
from pathlib import Path
from zoneinfo import ZoneInfo

# allow running from repo root or from scraper/ dir
sys.path.insert(0, str(Path(__file__).parent))

from cinecartaz import LISBON_TZ, scrape_all
from cinemas_meta import CHAIN_URLS, CINEMA_META, infer_chain_from_name
from models import Cinema, ShowtimesData
from omdb import enrich_movies


def _build_cinemas(raw_cinemas: list[dict]) -> list[Cinema]:
    """Build Cinema objects from raw cinecartaz data + hardcoded metadata."""
    result = []
    for raw in raw_cinemas:
        cid = int(raw["id"])
        meta = CINEMA_META.get(cid, {})
        name = raw.get("name", "")
        chain = meta.get("chain") or infer_chain_from_name(name)
        result.append(
            Cinema(
                id=cid,
                name=name,
                chain=chain,
                region=raw.get("region", ""),
                location=raw.get("location", ""),
                lat=meta.get("lat"),
                lng=meta.get("lng"),
                chain_url=CHAIN_URLS.get(chain),
            )
        )
    return result


def main() -> int:
    parser = argparse.ArgumentParser(description="Scrape Lisbon cinema showtimes")
    parser.add_argument("--output-dir", default="site/data", help="Where to write showtimes.json")
    parser.add_argument("--omdb-key", default=os.environ.get("OMDB_API_KEY", ""))
    parser.add_argument("--max-movies", type=int, default=None, help="Limit for quick testing")
    parser.add_argument("--no-enrich", action="store_true", help="Skip OMDB enrichment")
    parser.add_argument("--log-level", default="INFO")
    args = parser.parse_args()

    logging.basicConfig(
        level=args.log_level,
        format="%(asctime)s %(levelname)s %(name)s: %(message)s",
    )
    logger = logging.getLogger("scraper")

    try:
        movies, raw_cinemas = scrape_all(max_movies=args.max_movies)
    except Exception as e:
        logger.exception("Scrape failed: %s", e)
        return 1

    logger.info("Scraped %d movies across %d cinemas", len(movies), len(raw_cinemas))

    if not args.no_enrich and args.omdb_key:
        enrich_movies(movies, args.omdb_key)
    elif not args.omdb_key:
        logger.warning("OMDB_API_KEY not set; ratings + language will be missing")

    cinemas = _build_cinemas(raw_cinemas)

    scrape_date = datetime.now(LISBON_TZ).date().isoformat()
    data = ShowtimesData(
        last_updated=datetime.now(timezone.utc),
        scrape_date=scrape_date,
        movies=movies,
        cinemas=cinemas,
    )

    output_dir = Path(args.output_dir)
    output_dir.mkdir(parents=True, exist_ok=True)
    output_path = output_dir / "showtimes.json"
    output_path.write_text(data.model_dump_json(indent=2))
    logger.info("Wrote %s (%d bytes)", output_path, output_path.stat().st_size)

    return 0


if __name__ == "__main__":
    sys.exit(main())
