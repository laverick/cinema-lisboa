// Cinema Lisboa - client-side app
// Loads showtimes.json and renders by-cinema or by-movie views with distance sorting.

const DEFAULT_LOCATION = { lat: 38.6920, lng: -9.2930, label: "Paço de Arcos" };

const state = {
  data: null,
  view: "by-cinema",          // "by-cinema" | "by-movie"
  dateFilter: "today",         // "today" | "tomorrow" | "all"
  search: "",
  englishOnly: false,
  location: { ...DEFAULT_LOCATION },
};

// ---------- Utilities ----------

function haversineKm(a, b) {
  const R = 6371;
  const toRad = (d) => (d * Math.PI) / 180;
  const dLat = toRad(b.lat - a.lat);
  const dLng = toRad(b.lng - a.lng);
  const lat1 = toRad(a.lat);
  const lat2 = toRad(b.lat);
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.sin(dLng / 2) ** 2 * Math.cos(lat1) * Math.cos(lat2);
  return 2 * R * Math.asin(Math.sqrt(h));
}

function formatKm(km) {
  if (km == null) return "";
  if (km < 10) return `${km.toFixed(1)} km`;
  return `${Math.round(km)} km`;
}

function todayISO() {
  // Use Europe/Lisbon date (the site serves Lisbon users; date in that TZ)
  const now = new Date();
  const lisbon = new Date(now.toLocaleString("en-US", { timeZone: "Europe/Lisbon" }));
  const y = lisbon.getFullYear();
  const m = String(lisbon.getMonth() + 1).padStart(2, "0");
  const d = String(lisbon.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

function tomorrowISO() {
  const now = new Date();
  const lisbon = new Date(now.toLocaleString("en-US", { timeZone: "Europe/Lisbon" }));
  lisbon.setDate(lisbon.getDate() + 1);
  const y = lisbon.getFullYear();
  const m = String(lisbon.getMonth() + 1).padStart(2, "0");
  const d = String(lisbon.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

function escapeHtml(s) {
  if (s == null) return "";
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

// ---------- Freshness ----------

function updateFreshness() {
  const label = document.getElementById("last-updated");
  const warn = document.getElementById("stale-warning");
  if (!state.data || !state.data.last_updated) {
    label.textContent = "no data";
    label.className = "stale-red";
    return;
  }
  const then = new Date(state.data.last_updated);
  const now = new Date();
  const mins = Math.floor((now - then) / 60000);
  let text;
  if (mins < 1) text = "updated just now";
  else if (mins < 60) text = `updated ${mins} min ago`;
  else if (mins < 1440) text = `updated ${Math.floor(mins / 60)} h ago`;
  else text = `updated ${Math.floor(mins / 1440)} d ago`;
  label.textContent = text;
  label.className = mins > 180 ? "stale-red" : mins > 90 ? "stale-yellow" : "fresh";
  warn.classList.toggle("hidden", mins <= 180);
}

// ---------- Badge rendering ----------

function badgeClassForTech(tech) {
  if (!tech) return null;
  const t = tech.toUpperCase();
  if (t === "IMAX") return "badge-imax";
  if (t === "4DX") return "badge-4dx";
  if (t === "3D") return "badge-3d";
  if (t === "ATMOS") return "badge-atmos";
  if (t === "SCREENX") return "badge-screenx";
  if (t === "XVISION" || t === "XL VISION") return "badge-xvision";
  return null;
}

function renderTimeSlot(ts, movie) {
  // Main audio/version badge
  let versionBadge = "";
  let inferredMark = "";
  if (ts.dubbed) {
    versionBadge = `<span class="badge badge-vp">VP</span>`;
  } else {
    // VO - show language from OMDB if available
    const lang = movie.original_language;
    if (lang && lang.toLowerCase() === "english") {
      versionBadge = `<span class="badge badge-vo-en">VO · EN</span>`;
    } else if (lang) {
      versionBadge = `<span class="badge badge-vo-other">VO · ${escapeHtml(lang)}</span>`;
    } else {
      versionBadge = `<span class="badge badge-vo-other">VO · ?</span>`;
    }
    if (ts.inferred_vo) inferredMark = `<span class="inferred" title="VO inferred (not explicitly marked)">~</span>`;
  }

  // Tech badge
  let techBadge = "";
  const cls = badgeClassForTech(ts.tech_format);
  if (cls) {
    techBadge = ` <span class="badge ${cls}">${escapeHtml(ts.tech_format)}</span>`;
  }

  return `<span class="time-slot">${inferredMark}<span class="time-num">${escapeHtml(ts.time)}</span> ${versionBadge}${techBadge}</span>`;
}

function renderRatings(movie) {
  const r = movie.ratings;
  if (!r || (!r.imdb && !r.rt_critic && !r.metacritic)) {
    return `<span class="rating-none">no ratings</span>`;
  }
  const parts = [];
  if (r.imdb) parts.push(`<span class="rating-imdb">IMDb ${escapeHtml(r.imdb)}</span>`);
  if (r.rt_critic) parts.push(`<span class="rating-rt">RT ${escapeHtml(r.rt_critic)}</span>`);
  if (r.metacritic) parts.push(`<span class="rating-mc">MC ${escapeHtml(r.metacritic)}</span>`);
  return `<span class="ratings">${parts.join("")}</span>`;
}

function renderMovieMeta(movie) {
  const bits = [];
  if (movie.genre) bits.push(escapeHtml(movie.genre));
  if (movie.duration_min) {
    const h = Math.floor(movie.duration_min / 60);
    const m = movie.duration_min % 60;
    bits.push(h ? `${h}h${String(m).padStart(2, "0")}` : `${m} min`);
  }
  if (movie.age_rating) bits.push(escapeHtml(movie.age_rating));
  return bits.length ? `<span class="movie-meta">${bits.join(" · ")}</span>` : "";
}

// ---------- Filtering ----------

function dateMatches(sessionDate) {
  if (state.dateFilter === "all") return true;
  if (state.dateFilter === "today") return sessionDate === todayISO();
  if (state.dateFilter === "tomorrow") return sessionDate === tomorrowISO();
  return true;
}

function movieMatchesSearch(movie) {
  if (!state.search) return true;
  const q = state.search.toLowerCase();
  return (
    movie.title.toLowerCase().includes(q) ||
    (movie.original_title && movie.original_title.toLowerCase().includes(q))
  );
}

function timesFilteredForLanguage(times, movie) {
  // English-only filter: keep only undubbed sessions where original_language starts with English
  if (!state.englishOnly) return times;
  const isEnglish =
    movie.original_language &&
    movie.original_language.toLowerCase() === "english";
  if (!isEnglish) return [];
  return times.filter((t) => !t.dubbed);
}

// ---------- Cinema distance + sorting ----------

function cinemaDistance(cinema) {
  if (cinema.lat == null || cinema.lng == null) return null;
  return haversineKm(state.location, { lat: cinema.lat, lng: cinema.lng });
}

function sortedCinemas() {
  const withDist = state.data.cinemas.map((c) => ({
    ...c,
    _dist: cinemaDistance(c),
  }));
  withDist.sort((a, b) => {
    if (a._dist == null && b._dist == null) return a.name.localeCompare(b.name);
    if (a._dist == null) return 1;
    if (b._dist == null) return -1;
    return a._dist - b._dist;
  });
  return withDist;
}

// ---------- Rendering: by-cinema ----------

function renderByCinema() {
  const cinemas = sortedCinemas();
  const cinemaMap = new Map(cinemas.map((c) => [c.id, c]));
  const movies = state.data.movies;

  // Build: cinema_id -> [ {movie, sessions-matching-date-and-language} ]
  const byCinema = new Map();
  for (const movie of movies) {
    if (!movieMatchesSearch(movie)) continue;
    for (const ct of movie.showtimes) {
      for (const sess of ct.sessions) {
        if (!dateMatches(sess.date)) continue;
        const filteredTimes = timesFilteredForLanguage(sess.times, movie);
        if (!filteredTimes.length) continue;
        if (!byCinema.has(ct.cinema_id)) byCinema.set(ct.cinema_id, []);
        byCinema.get(ct.cinema_id).push({ movie, session: { ...sess, times: filteredTimes } });
      }
    }
  }

  const container = document.getElementById("content");
  const parts = [];

  let anyShown = false;
  for (const cinema of cinemas) {
    const entries = byCinema.get(cinema.id);
    if (!entries || !entries.length) continue;
    anyShown = true;
    // Sort movies within cinema by title
    entries.sort((a, b) => a.movie.title.localeCompare(b.movie.title));

    const distStr = cinema._dist != null ? formatKm(cinema._dist) : "no location";
    const distCls = cinema._dist != null ? "cinema-distance" : "cinema-distance no-coords";
    const verifyLink = cinema.chain_url
      ? `<a class="cinema-verify-link" href="${escapeHtml(cinema.chain_url)}" target="_blank" rel="noopener" title="Verify on the cinema's own site">↗</a>`
      : "";

    parts.push(`
      <section class="cinema-section">
        <div class="cinema-header">
          <div>
            <span class="cinema-name">${escapeHtml(cinema.name)}</span>
            <span class="cinema-chain">${escapeHtml(cinema.chain)}</span>
            ${verifyLink}
          </div>
          <span class="${distCls}">${distStr}</span>
        </div>
        <div class="movie-list">
          ${entries.map((e) => renderMovieRowInCinema(e.movie, e.session)).join("")}
        </div>
      </section>
    `);
  }

  if (!anyShown) {
    container.innerHTML = `<div class="empty">No sessions match your filters.</div>`;
    return;
  }
  container.innerHTML = parts.join("");
}

function renderMovieRowInCinema(movie, session) {
  return `
    <div class="movie-row">
      <div class="movie-title-line">
        <span class="movie-title">${escapeHtml(movie.title)}</span>
        ${renderRatings(movie)}
        ${renderMovieMeta(movie)}
      </div>
      <div class="times-row">
        ${session.times.map((t) => renderTimeSlot(t, movie)).join("")}
      </div>
    </div>
  `;
}

// ---------- Rendering: by-movie ----------

function renderByMovie() {
  const cinemas = sortedCinemas();
  const cinemaMap = new Map(cinemas.map((c) => [c.id, c]));
  const movies = [...state.data.movies].sort((a, b) => a.title.localeCompare(b.title));

  const container = document.getElementById("content");
  const parts = [];
  let anyShown = false;

  for (const movie of movies) {
    if (!movieMatchesSearch(movie)) continue;

    // Collect cinemas (with at least one matching session) for this movie
    const cinemaEntries = [];
    for (const ct of movie.showtimes) {
      const relevantSessions = [];
      for (const sess of ct.sessions) {
        if (!dateMatches(sess.date)) continue;
        const filteredTimes = timesFilteredForLanguage(sess.times, movie);
        if (!filteredTimes.length) continue;
        relevantSessions.push({ ...sess, times: filteredTimes });
      }
      if (relevantSessions.length) {
        const cinema = cinemaMap.get(ct.cinema_id);
        if (cinema) cinemaEntries.push({ cinema, sessions: relevantSessions });
      }
    }

    if (!cinemaEntries.length) continue;
    anyShown = true;

    // Sort cinemas by distance
    cinemaEntries.sort((a, b) => {
      if (a.cinema._dist == null && b.cinema._dist == null) return 0;
      if (a.cinema._dist == null) return 1;
      if (b.cinema._dist == null) return -1;
      return a.cinema._dist - b.cinema._dist;
    });

    const directorStr = movie.director ? ` · ${escapeHtml(movie.director)}` : "";
    parts.push(`
      <section class="movie-section">
        <div class="movie-title-line">
          <span class="movie-title">${escapeHtml(movie.title)}</span>
          ${renderRatings(movie)}
        </div>
        <div class="movie-info">${renderMovieMeta(movie).replace('<span class="movie-meta">', '').replace("</span>", "") || ""}${directorStr}</div>
        ${cinemaEntries.map((ce) => renderCinemaLine(ce.cinema, ce.sessions, movie)).join("")}
      </section>
    `);
  }

  if (!anyShown) {
    container.innerHTML = `<div class="empty">No sessions match your filters.</div>`;
    return;
  }
  container.innerHTML = parts.join("");
}

function renderCinemaLine(cinema, sessions, movie) {
  const distStr = cinema._dist != null ? ` <span class="dist">· ${formatKm(cinema._dist)}</span>` : "";
  // Flatten all times from all matching sessions; include date label if > 1 day
  const showDate = sessions.length > 1;
  const timeHtml = sessions
    .map((s) => {
      const dateLabel = showDate ? `<span class="dist">${escapeHtml(s.day_label)}: </span>` : "";
      return dateLabel + s.times.map((t) => renderTimeSlot(t, movie)).join("");
    })
    .join(" ");
  return `
    <div class="cinema-line">
      <div class="cinema-line-name">${escapeHtml(cinema.name)}${distStr}</div>
      <div class="times-row">${timeHtml}</div>
    </div>
  `;
}

// ---------- Main render dispatch ----------

function render() {
  if (!state.data) return;
  if (state.view === "by-cinema") renderByCinema();
  else renderByMovie();
}

// ---------- Event handlers ----------

function setupHandlers() {
  document.getElementById("search").addEventListener("input", (e) => {
    state.search = e.target.value.trim();
    render();
  });
  document.querySelectorAll("#date-tabs .tab").forEach((btn) => {
    btn.addEventListener("click", () => {
      document.querySelectorAll("#date-tabs .tab").forEach((b) => b.classList.remove("active"));
      btn.classList.add("active");
      state.dateFilter = btn.dataset.date;
      render();
    });
  });
  document.querySelectorAll("#view-tabs .tab").forEach((btn) => {
    btn.addEventListener("click", () => {
      document.querySelectorAll("#view-tabs .tab").forEach((b) => b.classList.remove("active"));
      btn.classList.add("active");
      state.view = btn.dataset.view;
      render();
    });
  });
  document.getElementById("english-only").addEventListener("change", (e) => {
    state.englishOnly = e.target.checked;
    render();
  });
  document.getElementById("use-location").addEventListener("click", () => {
    if (!navigator.geolocation) {
      alert("Geolocation is not supported in this browser.");
      return;
    }
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        state.location = {
          lat: pos.coords.latitude,
          lng: pos.coords.longitude,
          label: "My location",
        };
        document.getElementById("location-label").textContent = state.location.label;
        render();
      },
      (err) => alert("Couldn't get your location: " + err.message),
      { timeout: 8000 }
    );
  });
}

// ---------- Load ----------

async function load() {
  try {
    const resp = await fetch("data/showtimes.json", { cache: "no-cache" });
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    state.data = await resp.json();
    updateFreshness();
    render();
    // Refresh freshness badge periodically
    setInterval(updateFreshness, 60000);
  } catch (e) {
    document.getElementById("content").innerHTML = `<div class="empty">Error loading data: ${escapeHtml(e.message)}</div>`;
    document.getElementById("last-updated").textContent = "error";
    document.getElementById("last-updated").className = "stale-red";
  }
}

setupHandlers();
load();
