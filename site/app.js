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

function lisbonNowMinutes() {
  const now = new Date();
  const lisbon = new Date(now.toLocaleString("en-US", { timeZone: "Europe/Lisbon" }));
  return lisbon.getHours() * 60 + lisbon.getMinutes();
}

function isPastSlot(sessionDate, timeStr) {
  if (sessionDate !== todayISO()) return false;
  return timeToMinutes(timeStr) < lisbonNowMinutes();
}

function renderTimeSlot(ts, movie, sessionDate) {
  // Only show a badge for explicitly dubbed (Portuguese) sessions.
  // Undubbed = assumed VO, no badge needed.
  let versionBadge = "";
  let inferredMark = "";
  if (ts.dubbed) {
    versionBadge = `<span class="badge badge-vp">VP</span>`;
  } else if (ts.inferred_vo) {
    inferredMark = `<span class="inferred" title="Original version inferred (not explicitly marked)">~</span>`;
  }

  // Tech badge — only IMAX is worth calling out
  let techBadge = "";
  if (ts.tech_format === "IMAX") {
    techBadge = ` <span class="badge badge-imax">IMAX</span>`;
  }

  const pastCls = sessionDate && isPastSlot(sessionDate, ts.time) ? " past" : "";
  return `<span class="time-slot${pastCls}">${inferredMark}<span class="time-num">${escapeHtml(ts.time)}</span> ${versionBadge}${techBadge}</span>`;
}

function renderRatings(movie) {
  // Kept as a no-op so callsites don't break; ratings now rendered by renderMovieLinks.
  return "";
}

const DAY_LABEL_EN = {
  "hoje": "Today",
  "amanhã": "Tomorrow", "amanha": "Tomorrow",
  "segunda": "Mon", "terça": "Tue", "terca": "Tue", "quarta": "Wed",
  "quinta": "Thu", "sexta": "Fri", "sábado": "Sat", "sabado": "Sat", "domingo": "Sun",
};
function timeToMinutes(t) {
  // "13h45" -> 13*60+45; "21h" -> 21*60; tolerant to extras.
  if (!t) return 0;
  const m = /(\d{1,2})h(\d{0,2})/.exec(t);
  if (!m) return 0;
  return parseInt(m[1], 10) * 60 + (m[2] ? parseInt(m[2], 10) : 0);
}

function sortedTimes(times) {
  return [...times].sort((a, b) => timeToMinutes(a.time) - timeToMinutes(b.time));
}

function translateDayLabel(label) {
  if (!label) return "";
  const key = label.toLowerCase().trim();
  return escapeHtml(DAY_LABEL_EN[key] || label);
}

function renderMovieLinks(movie) {
  const q = encodeURIComponent(movie.original_title || movie.title);
  const r = movie.ratings || {};
  const parts = [];

  // IMDb — color the whole link when a rating is present
  const imdbHref = r.imdb_id
    ? `https://www.imdb.com/title/${encodeURIComponent(r.imdb_id)}/`
    : `https://www.imdb.com/find/?q=${q}`;
  const imdbCls = r.imdb ? " mlink-rated rating-imdb" : "";
  const imdbValue = r.imdb ? ` <span class="mlink-val">${escapeHtml(r.imdb)}</span>` : "";
  parts.push(`<a class="mlink${imdbCls}" href="${imdbHref}" target="_blank" rel="noopener">IMDb${imdbValue}</a>`);

  // Rotten Tomatoes
  const rtCls = r.rt_critic ? " mlink-rated rating-rt" : "";
  const rtValue = r.rt_critic ? ` <span class="mlink-val">${escapeHtml(r.rt_critic)}</span>` : "";
  parts.push(`<a class="mlink${rtCls}" href="https://www.rottentomatoes.com/search?search=${q}" target="_blank" rel="noopener">RT${rtValue}</a>`);

  // Metacritic
  const mcCls = r.metacritic ? " mlink-rated rating-mc" : "";
  const mcValue = r.metacritic ? ` <span class="mlink-val">${escapeHtml(r.metacritic)}</span>` : "";
  parts.push(`<a class="mlink${mcCls}" href="https://www.metacritic.com/search/${q}/" target="_blank" rel="noopener">MC${mcValue}</a>`);

  // YouTube trailer search
  parts.push(`<a class="mlink mlink-trailer" href="https://www.youtube.com/results?search_query=${q}+trailer" target="_blank" rel="noopener" title="Trailer search">▶</a>`);

  return `<span class="movie-links">${parts.join('<span class="mlink-sep">·</span>')}</span>`;
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
  return times;
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
    // Sort: movies with any future sessions first, then past-only at bottom; within each group alphabetical.
    entries.sort((a, b) => {
      const aFuture = futureTimesCount(a.session) > 0 ? 0 : 1;
      const bFuture = futureTimesCount(b.session) > 0 ? 0 : 1;
      if (aFuture !== bFuture) return aFuture - bFuture;
      return (a.movie.original_title || a.movie.title).localeCompare(b.movie.original_title || b.movie.title);
    });

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

function renderPosterThumb(movie) {
  if (!movie.poster_url) {
    return `<div class="poster poster-missing" aria-hidden="true"></div>`;
  }
  // loading=lazy so off-screen rows don't fetch until scrolled into view
  return `<img class="poster" loading="lazy" src="${escapeHtml(movie.poster_url)}" alt="">`;
}

function decodeHtmlEntities(s) {
  // Cinecartaz og:description comes pre-HTML-escaped. Decode once.
  if (!s) return "";
  const el = document.createElement("textarea");
  el.innerHTML = s;
  return el.value;
}

function renderMovieExpanded(movie) {
  const plot = movie.plot_en || decodeHtmlEntities(movie.plot_pt) || "";
  const sourceTag = movie.plot_en ? "" : (movie.plot_pt ? ` <span class="plot-lang">(PT)</span>` : "");
  const plotHtml = plot
    ? `<p class="plot">${escapeHtml(plot)}${sourceTag}</p>`
    : `<p class="plot plot-missing">No synopsis available.</p>`;

  // Original language(s) from OMDB — useful for verifying VO assumption
  const langs = movie.original_languages && movie.original_languages.length
    ? movie.original_languages
    : (movie.original_language ? [movie.original_language] : []);
  const langHtml = langs.length
    ? `<p class="orig-lang"><strong>Original language:</strong> ${langs.map(escapeHtml).join(", ")}</p>`
    : "";

  const ccLink = movie.url
    ? `<a class="cc-link" href="https://cinecartaz.publico.pt${escapeHtml(movie.url)}" target="_blank" rel="noopener">Full info on cinecartaz ↗</a>`
    : "";
  return `
    <div class="movie-expanded" style="display:none">
      ${langHtml}
      ${plotHtml}
      ${ccLink}
    </div>
  `;
}

function renderMovieRowInCinema(movie, session) {
  return `
    <div class="movie-row" data-movie-id="${movie.id}">
      <div class="movie-row-main">
        ${renderPosterThumb(movie)}
        <div class="movie-row-body">
          <div class="movie-title-line">
            <span class="movie-title">${escapeHtml(movie.original_title || movie.title)}</span>
            ${renderMovieMeta(movie)}
            ${renderMovieLinks(movie)}
          </div>
          <div class="times-row">
            ${sortedTimes(session.times).map((t) => renderTimeSlot(t, movie, session.date)).join("")}
          </div>
        </div>
      </div>
      ${renderMovieExpanded(movie)}
    </div>
  `;
}

// ---------- Rendering: by-movie ----------

// Composite score for "how likely I want to see this".
// Robust to missing data — each component has a sensible default so movies
// without ratings still get ranked by popularity / penalties.
function movieInterestScore(movie, sessionCount) {
  // 1. Quality (0-1): MC preferred, then RT, then IMDb. Default 0.5 if none.
  let quality = 0.5;
  const r = movie.ratings || {};
  if (r.metacritic) {
    const n = parseInt(r.metacritic, 10);
    if (!isNaN(n)) quality = n / 100;
  } else if (r.rt_critic) {
    const n = parseInt(r.rt_critic, 10);
    if (!isNaN(n)) quality = n / 100;
  } else if (r.imdb) {
    const n = parseFloat(r.imdb);
    if (!isNaN(n)) quality = n / 10;
  }

  // 2. Popularity (0-1): log-scaled showtime count.
  // Typical range 1-40 showtimes; log(40)/log(40)=1.
  const pop = sessionCount > 0 ? Math.log(sessionCount + 1) / Math.log(40) : 0;
  const popularity = Math.min(1, pop);

  // 3. Penalties
  let penalty = 0;
  if (movie.age_rating === "M/6") penalty += 0.15;  // kids' movies
  const g = (movie.genre || "").toLowerCase();
  if (g.includes("terror") || g.includes("horror")) penalty += 0.10;

  return 0.55 * quality + 0.45 * popularity - penalty;
}

function renderByMovie() {
  const cinemas = sortedCinemas();
  const cinemaMap = new Map(cinemas.map((c) => [c.id, c]));

  // Count matching showtimes per movie (for popularity scoring + gating).
  // A movie only gets ranked if it has at least one session matching filters.
  const rankedMovies = [];
  for (const movie of state.data.movies) {
    let count = 0;
    let futureCount = 0;
    for (const ct of movie.showtimes) {
      for (const sess of ct.sessions) {
        if (!dateMatches(sess.date)) continue;
        const times = timesFilteredForLanguage(sess.times, movie);
        count += times.length;
        futureCount += futureTimesCount({ date: sess.date, times });
      }
    }
    if (count === 0) continue;
    // Use future-count for popularity so fully-past movies sink; fall back to total
    // so "Tomorrow"/"All" filters aren't affected (futureCount == count there).
    let score = movieInterestScore(movie, futureCount);
    if (futureCount === 0) score -= 0.4;  // strong demotion when nothing left today
    rankedMovies.push({ movie, sessionCount: count, score });
  }
  rankedMovies.sort((a, b) => b.score - a.score);
  const movies = rankedMovies.map((r) => r.movie);

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
    const metaInline = renderMovieMeta(movie).replace('<span class="movie-meta">', '').replace("</span>", "");
    parts.push(`
      <section class="movie-section movie-row" data-movie-id="${movie.id}">
        <div class="movie-section-header movie-row-main">
          ${renderPosterThumb(movie)}
          <div class="movie-section-body movie-row-body">
            <div class="movie-title-line">
              <span class="movie-title">${escapeHtml(movie.original_title || movie.title)}</span>
              ${renderMovieLinks(movie)}
            </div>
            <div class="movie-info">${metaInline}${directorStr}</div>
          </div>
        </div>
        ${renderMovieExpanded(movie)}
        <div class="movie-section-cinemas">
          ${cinemaEntries.slice(0, 3).map((ce) => renderCinemaLine(ce.cinema, ce.sessions, movie)).join("")}
          ${renderMoreCinemas(cinemaEntries.slice(3), movie)}
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

function renderCinemaLine(cinema, sessions, movie) {
  const distStr = cinema._dist != null ? ` <span class="dist">· ${formatKm(cinema._dist)}</span>` : "";
  // Flatten all times from all matching sessions; include date label if > 1 day
  const showDate = sessions.length > 1;
  const timeHtml = sessions
    .map((s) => {
      const dateLabel = showDate ? `<span class="dist">${translateDayLabel(s.day_label)}: </span>` : "";
      return dateLabel + sortedTimes(s.times).map((t) => renderTimeSlot(t, movie, s.date)).join("");
    })
    .join(" ");
  return `
    <div class="cinema-line">
      <div class="cinema-line-name">${escapeHtml(cinema.name)}${distStr}</div>
      <div class="times-row">${timeHtml}</div>
    </div>
  `;
}

function renderMoreCinemas(extraEntries, movie) {
  if (!extraEntries.length) return "";
  // Collapsed preview: list cinema names + distances, no times. Click to reveal full lines.
  const previewNames = extraEntries
    .map((ce) => {
      const dist = ce.cinema._dist != null ? ` <span class="dist">· ${formatKm(ce.cinema._dist)}</span>` : "";
      return `<span class="more-name">${escapeHtml(ce.cinema.name)}${dist}</span>`;
    })
    .join('<span class="more-sep">·</span>');
  const fullHtml = extraEntries
    .map((ce) => renderCinemaLine(ce.cinema, ce.sessions, movie))
    .join("");
  return `
    <div class="more-cinemas" data-expanded="false">
      <button class="more-cinemas-toggle" type="button">
        <span class="more-caret">▸</span>
        <span class="more-label">+ ${extraEntries.length} more cinema${extraEntries.length > 1 ? "s" : ""} — tap to show times</span>
      </button>
      <div class="more-cinemas-preview">${previewNames}</div>
      <div class="more-cinemas-full" style="display:none">${fullHtml}</div>
    </div>
  `;
}

// Count how many of a session's times are still in the future (in Lisbon).
function futureTimesCount(session) {
  if (session.date !== todayISO()) return session.times.length;
  return session.times.filter((t) => !isPastSlot(session.date, t.time)).length;
}

// ---------- Main render dispatch ----------

function render() {
  if (!state.data) return;
  if (state.view === "by-cinema") renderByCinema();
  else renderByMovie();
  attachRowHandlers();
}

function attachRowHandlers() {
  // Tap on movie row (but not on a link) -> toggle expanded panel
  document.querySelectorAll(".movie-row").forEach((row) => {
    const main = row.querySelector(".movie-row-main");
    const exp = row.querySelector(".movie-expanded");
    if (!main || !exp) return;
    main.addEventListener("click", (e) => {
      // Don't toggle when clicking a link or inside the expanded panel
      if (e.target.closest("a")) return;
      const open = row.classList.toggle("open");
      exp.style.display = open ? "" : "none";
    });
  });

  // "+ N more cinemas" expander (by-movie view)
  document.querySelectorAll(".more-cinemas").forEach((box) => {
    const toggle = box.querySelector(".more-cinemas-toggle");
    const preview = box.querySelector(".more-cinemas-preview");
    const full = box.querySelector(".more-cinemas-full");
    const caret = box.querySelector(".more-caret");
    const label = box.querySelector(".more-label");
    if (!toggle || !full) return;
    toggle.addEventListener("click", (e) => {
      e.stopPropagation();
      const expanded = box.dataset.expanded === "true";
      box.dataset.expanded = expanded ? "false" : "true";
      if (expanded) {
        full.style.display = "none";
        if (preview) preview.style.display = "";
        if (caret) caret.textContent = "▸";
        if (label) label.textContent = label.textContent.replace("hide", "+ ").replace(/hide times/, label.dataset.originalLabel || label.textContent);
      } else {
        full.style.display = "";
        if (preview) preview.style.display = "none";
        if (caret) caret.textContent = "▾";
        if (label) {
          if (!label.dataset.originalLabel) label.dataset.originalLabel = label.textContent;
          label.textContent = "hide times";
        }
      }
    });
  });
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
