"""Hardcoded cinema metadata: coordinates, chain, homepage.

IDs verified against real cinecartaz data (2026-04-20). Add new entries as
cinecartaz adds cinemas — the scraper includes unknown cinemas without coords
(sorted last by distance).

To verify a cinema ID, check the <a href="/cinema/slug-{id}"> attribute on a
movie detail page on cinecartaz.
"""

from __future__ import annotations

# Paco de Arcos — user's default location
DEFAULT_LOCATION = (38.6920, -9.2930)

# Chain homepage URLs for the "verify" link
CHAIN_URLS = {
    "NOS": "https://www.cinemas.nos.pt/",
    "UCI": "https://www.ucicinemas.pt/",
    "Cinema City": "https://cinemacity.pt/",
    "Castello Lopes": "https://castellolopescinemas.pt/",
    "Cineplace": "https://www.cineplace.pt/",
    "Medeia": "https://www.medeiafilmes.com/",
    "Independent": "",
    "Other": "",
}


# Keyed by verified cinecartaz cinema id
CINEMA_META: dict[int, dict] = {
    # --- NOS (Greater Lisbon) ---
    17532: {"chain": "NOS", "lat": 38.7223, "lng": -9.1635},  # NOS Amoreiras
    17538: {"chain": "NOS", "lat": 38.7538, "lng": -9.1879},  # NOS Colombo
    17563: {"chain": "NOS", "lat": 38.6940, "lng": -9.4210},  # NOS CascaiShopping
    17585: {"chain": "NOS", "lat": 38.6907, "lng": -9.3117},  # NOS Oeiras Parque
    17586: {"chain": "NOS", "lat": 38.7685, "lng": -9.0940},  # NOS Vasco da Gama
    62570: {"chain": "NOS", "lat": 38.6720, "lng": -9.1588},  # NOS Almada Fórum
    80874: {"chain": "NOS", "lat": 38.7960, "lng": -9.1830},  # NOS Odivelas Strada
    81244: {"chain": "NOS", "lat": 38.7038, "lng": -8.9772},  # NOS Alegro Montijo

    # --- Cinema City ---
    169327: {"chain": "Cinema City", "lat": 38.7414, "lng": -9.1462},  # Campo Pequeno
    187898: {"chain": "Cinema City", "lat": 38.7360, "lng": -9.2230},  # Alegro Alfragide
    221112: {"chain": "Cinema City", "lat": 38.7520, "lng": -9.1420},  # Alvalade
    17625: {"chain": "Cinema City", "lat": 38.5224, "lng": -8.8941},  # Alegro Setúbal (far)

    # --- UCI ---
    54418: {"chain": "UCI", "lat": 38.7330, "lng": -9.1520},   # El Corte Inglés
    230335: {"chain": "UCI", "lat": 38.7480, "lng": -9.2340},  # Ubbo / Dolce Vita Tejo

    # --- Castello Lopes ---
    285110: {"chain": "Castello Lopes", "lat": 38.8000, "lng": -9.3800},  # Alegro Sintra
    215096: {"chain": "Castello Lopes", "lat": 38.6630, "lng": -9.0720},  # Fórum Barreiro

    # --- Independents ---
    17536: {"chain": "Independent", "lat": 38.7100, "lng": -9.1520},  # Cinemateca Portuguesa
    17541: {"chain": "Medeia",      "lat": 38.7372, "lng": -9.1537},  # Medeia Nimas
    17714: {"chain": "Independent", "lat": 38.7140, "lng": -9.1430},  # Cinema Ideal
    270072: {"chain": "Independent", "lat": 38.7250, "lng": -9.1500}, # Cinema Fernando Lopes
}


def infer_chain_from_name(name: str) -> str:
    """Fallback chain detection from the cinema name."""
    n = name.lower()
    if "nos" in n or "lusomundo" in n or "zon" in n:
        return "NOS"
    if "uci" in n:
        return "UCI"
    if "cinema city" in n or "cinemacity" in n:
        return "Cinema City"
    if "castello lopes" in n:
        return "Castello Lopes"
    if "cineplace" in n:
        return "Cineplace"
    if "medeia" in n or "nimas" in n:
        return "Medeia"
    if "cinemateca" in n or "ideal" in n:
        return "Independent"
    return "Other"
