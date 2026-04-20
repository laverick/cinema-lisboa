"""Pydantic models for the showtimes data contract."""

from __future__ import annotations

from datetime import datetime
from typing import Optional

from pydantic import BaseModel, Field


class TimeSlot(BaseModel):
    """A single showtime with inferred version info."""

    time: str  # e.g. "21h30" (normalized)
    dubbed: bool = False  # True if cinecartaz explicitly tagged (VP)
    tech_format: Optional[str] = None  # IMAX | 4DX | 3D | ATMOS | SCREENX | XVISION
    inferred_vo: bool = True  # True when VO is assumed (no explicit VP tag)


class DaySession(BaseModel):
    """Showings for one cinema on one day."""

    date: str  # ISO date, e.g. "2026-04-20"
    day_label: str  # "Hoje" | "Amanha" | "QUARTA" etc.
    times: list[TimeSlot] = Field(default_factory=list)


class CinemaShowtime(BaseModel):
    """All sessions for one cinema for a given movie."""

    cinema_id: int
    sessions: list[DaySession] = Field(default_factory=list)


class Ratings(BaseModel):
    imdb: Optional[str] = None
    rt_critic: Optional[str] = None
    metacritic: Optional[str] = None
    imdb_id: Optional[str] = None


class Movie(BaseModel):
    id: int
    title: str
    original_title: Optional[str] = None
    url: str  # e.g. "/filme/slug-415231"
    genre: Optional[str] = None
    duration_min: Optional[int] = None
    age_rating: Optional[str] = None
    director: Optional[str] = None
    original_language: Optional[str] = None
    original_languages: list[str] = Field(default_factory=list)
    ratings: Optional[Ratings] = None
    showtimes: list[CinemaShowtime] = Field(default_factory=list)


class Cinema(BaseModel):
    id: int
    name: str
    chain: str  # "NOS" | "UCI" | "Cinema City" | "Castello Lopes" | "Other"
    region: str  # "Lisboa" | "Grande Lisboa"
    location: str  # e.g. "Lisboa", "Oeiras", "Cascais"
    lat: Optional[float] = None
    lng: Optional[float] = None
    chain_url: Optional[str] = None  # homepage of the chain, for "verify" link


class ShowtimesData(BaseModel):
    last_updated: datetime
    scrape_date: str  # ISO date in Europe/Lisbon
    movies: list[Movie]
    cinemas: list[Cinema]
