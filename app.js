(() => {
  "use strict";

  const API = "https://api.quran.com/api/v4";
  const ALQURAN = "https://api.alquran.cloud/v1";
  const AUDIO_BASE = "https://everyayah.com/data";
  const QCF = "https://cdn.jsdelivr.net/npm/quran-qcf4@1.1.0";
  const HEADER_FONT = "QCF4_QBSML";
  const BASMALA_GLYPH = ["", "QCF4_Hafs_01"];
  const TOTAL_PAGES = 604;
  const TOTAL_VERSES = 6236;
  const LINES_PER_PAGE = 15;
  const MAX_PAGE_RATIO = 0.68; // width / height on wide screens
  const MIN_PAGE_RATIO = 0.46; // narrowest a page may get, so it can fill a tall phone screen
  const BISMILLAH = "بِسْمِ ٱللَّهِ ٱلرَّحْمَٰنِ ٱلرَّحِيمِ";
  const TABS = ["home", "quran", "mushaf", "saved", "search"];
  // One of these is shown as the daily verse, chosen by the date.
  const DAILY_VERSES = [
    "29:69", "2:286", "94:5", "2:152", "3:139", "13:28", "65:3", "39:53", "40:60", "2:186",
    "3:173", "8:46", "9:51", "16:128", "20:114", "21:87", "33:41", "49:13", "57:4", "64:11",
    "67:2", "93:5", "17:80", "28:24", "25:74", "14:7", "2:45", "3:8", "2:201", "18:10", "6:162",
  ];
  const ICONS = {
    bookmark: '<svg viewBox="0 0 24 24"><path d="M6 3h12v18l-6-4-6 4z"/></svg>',
    more: '<svg viewBox="0 0 24 24"><rect x="3" y="3" width="18" height="18" rx="5"/><path d="M8 12h.01M12 12h.01M16 12h.01" stroke-width="2.6"/></svg>',
    close: '<svg viewBox="0 0 24 24"><path d="M6 6l12 12M18 6L6 18"/></svg>',
    note: '<svg viewBox="0 0 24 24"><path d="M4 20h4L19 9l-4-4L4 16z"/><path d="M13 7l4 4"/></svg>',
  };

  const { SURAHS, JUZ, RECITERS, DEFAULT_TRANSLATIONS, PAGE_FIRST_VERSE } = window;
  const $ = (id) => document.getElementById(id);
  const el = (tag, cls, text) => {
    const n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = text;
    return n;
  };
  const arabicDigits = (n) => String(n).replace(/\d/g, (d) => "٠١٢٣٤٥٦٧٨٩"[d]);
  const pad3 = (n) => String(n).padStart(3, "0");
  const splitKey = (key) => key.split(":").map(Number);
  const clampPage = (p) => Math.min(TOTAL_PAGES, Math.max(1, p | 0));
  const dateKey = (d = new Date()) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  const norm = (s) => s.toLowerCase().replace(/['’\-\s]/g, "");

  // ---------- persistence ----------
  const store = {
    get(k, fallback) {
      try {
        const v = localStorage.getItem("mushaf:" + k);
        return v == null ? fallback : JSON.parse(v);
      } catch { return fallback; }
    },
    set(k, v) {
      try { localStorage.setItem("mushaf:" + k, JSON.stringify(v)); } catch { /* storage unavailable */ }
    },
  };

  const settings = Object.assign({
    theme: "light",
    layout: "auto",
    script: "glyph",
    mode: "mushaf",
    reciter: RECITERS[0][0],
    translation: DEFAULT_TRANSLATIONS[0][0],
    autoAdvance: true,
    showTranslit: true,
  }, store.get("settings", {}));
  const saveSettings = () => store.set("settings", settings);
  // Earlier versions defaulted to plain text; move everyone to the Madani glyphs once.
  if (!settings.qcf4) { settings.script = "glyph"; settings.qcf4 = true; delete settings.fs; saveSettings(); }

  let bookmarks = store.get("bookmarks", []);
  const saveBookmarks = () => store.set("bookmarks", bookmarks);
  const notes = store.get("notes", {}); // verse key -> { text, time }
  const saveNotes = () => store.set("notes", notes);

  // Reading progress: which verses are read and the days something was read.
  const khatam = Object.assign({ start: null, read: [] }, store.get("khatam", {}));
  const readSet = new Set(khatam.read);
  const saveKhatam = () => { khatam.read = [...readSet]; store.set("khatam", khatam); };
  const readDays = new Set(store.get("days", []));
  let lastPos = store.get("lastPos", null) || (store.get("lastPage", null) ? { mode: "mushaf", page: store.get("lastPage") } : null);
  let lastMushafPage = store.get("lastMushafPage", lastPos && lastPos.page ? lastPos.page : null);

  // ---------- metadata helpers ----------
  const verseStart = [0];
  SURAHS.forEach((m) => verseStart.push(verseStart[verseStart.length - 1] + m[3]));
  const verseIndex = (key) => { const [s, a] = splitKey(key); return verseStart[s - 1] + a - 1; };
  const keyAt = (i) => {
    let s = 1;
    while (verseStart[s] <= i) s++;
    return `${s}:${i - verseStart[s - 1] + 1}`;
  };
  const juzStarts = JUZ.map(([key]) => verseIndex(key));
  const juzOfIndex = (i) => { let j = 0; while (j + 1 < juzStarts.length && juzStarts[j + 1] <= i) j++; return j; };

  const juzForPage = (p) => {
    let j = 1;
    JUZ.forEach(([, start], i) => { if (start <= p) j = i + 1; });
    return j;
  };
  const surahForPage = (p) => {
    let s = 1;
    SURAHS.forEach((m, i) => { if (m[4] <= p) s = i + 1; });
    return s;
  };
  const nextVerseKey = (key) => {
    const [s, a] = splitKey(key);
    if (a < SURAHS[s - 1][3]) return `${s}:${a + 1}`;
    return s < 114 ? `${s + 1}:1` : null;
  };
  const verseLabel = (key) => {
    const [s, a] = splitKey(key);
    return `${SURAHS[s - 1][1]} ${s}:${a}`;
  };
  const compareKeys = (a, b) => {
    const [s1, a1] = splitKey(a), [s2, a2] = splitKey(b);
    return s1 - s2 || a1 - a2;
  };
  function pageForVerse(key) {
    let lo = 0, hi = PAGE_FIRST_VERSE.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (compareKeys(PAGE_FIRST_VERSE[mid], key) <= 0) lo = mid; else hi = mid - 1;
    }
    return lo + 1;
  }
  const versesOnPage = (p) => {
    const from = verseIndex(PAGE_FIRST_VERSE[p - 1]);
    const to = p < TOTAL_PAGES ? verseIndex(PAGE_FIRST_VERSE[p]) : TOTAL_VERSES;
    const out = [];
    for (let i = from; i < to; i++) out.push(keyAt(i));
    return out;
  };
  const surahReadCount = (s) => {
    let n = 0;
    for (let a = 1; a <= SURAHS[s - 1][3]; a++) if (readSet.has(`${s}:${a}`)) n++;
    return n;
  };

  // ---------- data loading ----------
  const pageCache = new Map();
  const surahCache = new Map();
  const verseCache = new Map();
  const translitCache = new Map();
  const fontCache = new Map();

  async function fetchJSON(url) {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return res.json();
  }

  function cached(map, key, load) {
    if (!map.has(key)) {
      const promise = load();
      promise.catch(() => map.delete(key));
      map.set(key, promise);
    }
    return map.get(key);
  }

  // Page layout and glyph fonts: KFGQPC QCF4 (Madinah Mushaf 1441H) via the quran-qcf4 package.
  const loadPage = (p) => cached(pageCache, p, () => fetchJSON(`${QCF}/pages/${pad3(p)}.json`));

  const loadFont = (name) => cached(fontCache, name, () => {
    const file = name === HEADER_FONT ? name : `${name}_W`;
    const face = new FontFace(name, `url(${QCF}/fonts-woff2/${file}.woff2)`, { display: "block" });
    return face.load().then((f) => { document.fonts.add(f); });
  });

  const fontsOf = (data) => {
    const fonts = new Set();
    data.lines.forEach((l) => l.words.forEach((w) => fonts.add(w.font)));
    return [...fonts];
  };

  // Uthmani text and the selected translation for a whole surah, from quran.com.
  const loadSurahVerses = (s) => cached(surahCache, `${s}|${settings.translation}`, async () => {
    const out = new Map();
    let next = 1;
    while (next) {
      const data = await fetchJSON(`${API}/verses/by_chapter/${s}?fields=text_uthmani` +
        `&translations=${settings.translation}&per_page=50&page=${next}`);
      data.verses.forEach((v) => out.set(v.verse_key, v));
      next = data.pagination && data.pagination.next_page;
    }
    return out;
  });

  // A single verse; reuses the surah request when that is already loaded.
  const loadVerse = (key) => {
    const surah = surahCache.get(`${splitKey(key)[0]}|${settings.translation}`);
    if (surah) return surah.then((m) => m.get(key));
    return cached(verseCache, `${key}|${settings.translation}`, async () => {
      const data = await fetchJSON(`${API}/verses/by_key/${key}?fields=text_uthmani&translations=${settings.translation}`);
      return data.verse;
    });
  };

  const loadTranslit = (s) => cached(translitCache, s, async () => {
    const data = await fetchJSON(`${ALQURAN}/surah/${s}/en.transliteration`);
    return data.data.ayahs.map((a) => a.text);
  });

  function cleanTranslation(html) {
    const tpl = document.createElement("template");
    tpl.innerHTML = html || "";
    tpl.content.querySelectorAll("sup").forEach((s) => s.remove());
    return tpl.content.textContent.trim();
  }
  const translationOf = (v) => {
    const tr = v && v.translations && v.translations[0];
    return tr ? cleanTranslation(tr.text) : "";
  };

  // Fill `box` with one verse in the Mushaf glyphs (or plain text), ending in its ayah marker.
  // `apply` wraps the DOM change so a scrolling list can keep its place.
  async function fillVerseArabic(box, key, apply = (fn) => fn()) {
    const a = splitKey(key)[1];
    if (settings.script === "glyph") {
      try {
        const data = await loadPage(pageForVerse(key));
        const words = [];
        data.lines.forEach((l) => l.words.forEach((w) => {
          if (w.verse_key === key && (w.type === "word" || w.type === "end")) words.push(w);
        }));
        await Promise.all([...new Set(words.map((w) => w.font))].map(loadFont));
        apply(() => {
          box.replaceChildren(...words.map((w) => {
            const span = el("span", null, w.char);
            span.style.fontFamily = w.font;
            return span;
          }));
          box.classList.add("glyph");
        });
        return;
      } catch { /* fall back to text below */ }
    }
    let text = "";
    try {
      const v = await loadVerse(key);
      text = v ? v.text_uthmani : "";
    } catch {
      try {
        const data = await loadPage(pageForVerse(key));
        const words = [];
        data.lines.forEach((l) => l.words.forEach((w) => { if (w.verse_key === key && w.type === "word") words.push(w.text); }));
        text = words.join(" ");
      } catch { /* leave empty */ }
    }
    apply(() => {
      box.classList.remove("glyph");
      box.replaceChildren(text + " ", el("span", "star num", String(a)));
    });
  }

  // ---------- reading progress ----------
  function touchDay() {
    const today = dateKey();
    if (readDays.has(today)) return;
    readDays.add(today);
    store.set("days", [...readDays].sort().slice(-400));
  }

  function setRead(keys, read) {
    let changed = false;
    keys.forEach((k) => {
      if (read && !readSet.has(k)) { readSet.add(k); changed = true; }
      if (!read && readSet.has(k)) { readSet.delete(k); changed = true; }
    });
    if (!changed) return;
    if (read) {
      if (!khatam.start) khatam.start = Date.now();
      touchDay();
    }
    saveKhatam();
    keys.forEach((k) => {
      const card = $(cardId(k));
      if (card) {
        card.classList.toggle("read", read);
        card.querySelector(".mark input").checked = read;
      }
    });
    updateMarkPageBtn();
  }

  function toggleVerseRead(key) {
    const read = !readSet.has(key);
    setRead([key], read);
    return read;
  }

  function streakCount() {
    let n = 0;
    const d = new Date();
    if (!readDays.has(dateKey(d))) d.setDate(d.getDate() - 1);
    while (readDays.has(dateKey(d))) { n++; d.setDate(d.getDate() - 1); }
    return n;
  }

  function progressStats() {
    const perJuz = new Array(30).fill(0);
    readSet.forEach((k) => perJuz[juzOfIndex(verseIndex(k))]++);
    const juzDone = perJuz.filter((n, j) => n >= (j < 29 ? juzStarts[j + 1] : TOTAL_VERSES) - juzStarts[j]).length;
    const pct = (readSet.size / TOTAL_VERSES) * 100;
    return { juzDone, pct: pct === 0 ? "0%" : pct < 10 ? `${pct.toFixed(1)}%` : `${Math.floor(pct)}%` };
  }

  // Where "Resume" picks up: the last reading position, else the first unread verse.
  function resumeKey() {
    if (lastPos) return lastPos.key || PAGE_FIRST_VERSE[(lastPos.page || 1) - 1];
    for (let i = 0; i < TOTAL_VERSES; i++) if (!readSet.has(keyAt(i))) return keyAt(i);
    return "1:1";
  }

  function savePos(pos) {
    lastPos = pos;
    store.set("lastPos", pos);
    if (pos.mode === "mushaf") {
      lastMushafPage = pos.page;
      store.set("lastMushafPage", pos.page);
    }
  }

  function resume() {
    if (lastPos && lastPos.mode === "mushaf") return openMushaf(lastPos.page);
    const [s, a] = splitKey(resumeKey());
    if (!lastPos && settings.mode === "mushaf") return openMushaf(pageForVerse(`${s}:${a}`));
    return openSurah(s, a > 1 ? a : null);
  }

  // ---------- Home ----------
  let dailyRendered = null;
  function renderHome() {
    const key = resumeKey();
    const [s, a] = splitKey(key);
    $("resumeSurah").textContent = SURAHS[s - 1][1];
    $("resumeVerse").textContent = lastPos && lastPos.mode === "mushaf" ? `Page ${lastPos.page}` : `Verse ${a}`;
    $("resumeMeta").textContent = lastPos && lastPos.mode === "mushaf" ? `Surah ${s} · Verse ${a}` : `Surah ${s}`;
    $("resumeText").textContent = lastPos || readSet.size ? "Resume" : "Start";

    const { juzDone, pct } = progressStats();
    $("statStreak").textContent = streakCount();
    $("statJuz").textContent = juzDone;
    $("statPct").textContent = pct;
    renderDaily();
  }

  const dailyKey = () => {
    const d = new Date();
    const day = Math.floor(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()) / 864e5);
    return DAILY_VERSES[day % DAILY_VERSES.length];
  };
  function renderDaily() {
    const stamp = `${dateKey()}|${settings.translation}|${settings.script}`;
    if (dailyRendered === stamp) return;
    dailyRendered = stamp;
    const key = dailyKey();
    const now = new Date();
    $("dailyDay").textContent = now.toLocaleDateString("en-US", { weekday: "short" });
    $("dailyNum").textContent = now.getDate();
    $("dailyRef").textContent = `${SURAHS[splitKey(key)[0] - 1][1]} ${key}`;
    fillVerseArabic($("dailyArabic"), key);
    $("dailyTrans").textContent = "";
    loadVerse(key).then((v) => { $("dailyTrans").textContent = translationOf(v); }, () => {
      $("dailyTrans").textContent = "Connect to the internet to see today's translation.";
      dailyRendered = null;
    });
  }

  // ---------- Quran tab ----------
  let quranSeg = "surahs";
  const translationName = () => {
    const opt = $("translationSel").selectedOptions[0];
    return opt ? opt.textContent.replace(/^.*?—\s*/, "") : "";
  };

  function row({ num, numCls = "", name, sub, ar, onClick, onDelete }) {
    const li = el("li");
    if (num != null) li.append(el("span", "numc " + numCls, String(num)));
    const info = el("div", "info");
    info.append(el("div", "name", name));
    if (sub) {
      if (sub instanceof Node) info.append(sub); else info.append(el("div", "sub", sub));
    }
    li.append(info);
    if (ar) li.append(el("div", "ar", ar));
    if (onDelete) {
      const del = el("button", "icon-btn del");
      del.setAttribute("aria-label", "Remove");
      del.innerHTML = ICONS.close;
      del.addEventListener("click", (e) => { e.stopPropagation(); onDelete(); });
      li.append(del);
    }
    if (onClick) li.addEventListener("click", onClick);
    return li;
  }

  function renderQuranList() {
    $("quranSubtitle").textContent = `114 Surahs · ${translationName()}`;
    const list = $("quranList");
    const q = norm($("surahFilter").value.trim());
    list.replaceChildren();
    if (quranSeg === "surahs") {
      SURAHS.forEach((m, i) => {
        if (q && !norm(`${i + 1} ${m[1]} ${m[2]}`).includes(q) && !m[0].includes($("surahFilter").value.trim())) return;
        const read = surahReadCount(i + 1);
        list.append(row({
          num: i + 1, numCls: read === m[3] ? "done" : read ? "started" : "",
          name: m[1], sub: `${m[2]} · ${m[3]} verses`, ar: m[0],
          onClick: () => openSurah(i + 1),
        }));
      });
      if (!list.children.length) list.append(el("li", "empty", "No surah matches that filter."));
    } else if (quranSeg === "juz") {
      JUZ.forEach(([key, page], i) => {
        if (q && !norm(`juz ${i + 1} ${verseLabel(key)}`).includes(q)) return;
        const [s, a] = splitKey(key);
        list.append(row({
          num: i + 1, name: `Juz ${i + 1}`, sub: `Starts ${verseLabel(key)} · page ${page}`, ar: "الجزء " + arabicDigits(i + 1),
          onClick: () => openSurah(s, a > 1 ? a : null),
        }));
      });
    } else {
      if (!bookmarks.length) list.append(el("li", "empty", "No bookmarks yet. Tap an ayah while reading and choose Bookmark."));
      bookmarks.forEach((b, i) => {
        const remove = () => { bookmarks.splice(i, 1); saveBookmarks(); renderQuranList(); };
        list.append(b.key
          ? row({ name: verseLabel(b.key), sub: `Ayah · page ${b.page}`, ar: SURAHS[splitKey(b.key)[0] - 1][0], onClick: () => openVerse(b.key), onDelete: remove })
          : row({ name: `Page ${b.page}`, sub: `${SURAHS[surahForPage(b.page) - 1][1]} · Juz ${juzForPage(b.page)}`, onClick: () => openMushaf(b.page), onDelete: remove }));
      });
    }
  }

  // ---------- Mushaf tab ----------
  let gotoMode = "page";
  const GOTO_PLACEHOLDER = { page: "Page 1 – 604", juz: "Juz 1 – 30", surah: "Surah 1 – 114 or a name" };
  function renderMushafTab() {
    $("mushafPageLabel").textContent = `Page ${lastMushafPage || 1}`;
    $("mushafContinueText").textContent = lastMushafPage ? "Continue Reading" : "Start Reading";
  }
  function resolveGoto(value) {
    const v = value.trim();
    const n = parseInt(v, 10);
    if (gotoMode === "page") return n >= 1 && n <= TOTAL_PAGES ? n : null;
    if (gotoMode === "juz") return n >= 1 && n <= 30 ? JUZ[n - 1][1] : null;
    if (n >= 1 && n <= 114 && /^\d+$/.test(v)) return SURAHS[n - 1][4];
    const q = norm(v);
    if (q.length < 2) return null;
    const i = SURAHS.findIndex((m) => norm(m[1]).includes(q) || norm(m[2]).includes(q) || m[0].includes(v));
    return i >= 0 ? SURAHS[i][4] : null;
  }

  // ---------- Saved tab ----------
  let savedSeg = "ayahs";
  function renderSaved() {
    const ayahCount = bookmarks.filter((b) => b.key).length;
    const noteKeys = Object.keys(notes).sort((a, b) => notes[b].time - notes[a].time);
    $("savedSubtitle").textContent = `${ayahCount} saved ayah${ayahCount === 1 ? "" : "s"} · ${noteKeys.length} note${noteKeys.length === 1 ? "" : "s"}`;
    const box = $("savedList");
    box.replaceChildren();

    const empty = (title, text) => {
      const card = el("div", "card empty-card");
      const ico = el("span");
      ico.innerHTML = savedSeg === "notes" ? ICONS.note : ICONS.bookmark;
      const btn = el("button", "dark-btn", "+ Start Reading");
      btn.addEventListener("click", resume);
      card.append(ico, el("h3", null, title), el("p", null, text), btn);
      box.append(card);
    };

    if (savedSeg === "ayahs") {
      if (!bookmarks.length) return empty("No bookmarks yet", "Tap an ayah while reading and choose Bookmark.");
      bookmarks.forEach((b, i) => {
        const card = el("article", "card saved-item");
        const top = el("div", "saved-top");
        const label = el("div");
        label.append(el("strong", null, b.key ? verseLabel(b.key) : `Page ${b.page}`));
        const del = el("button", "icon-btn");
        del.setAttribute("aria-label", "Remove bookmark");
        del.innerHTML = ICONS.close;
        del.addEventListener("click", (e) => { e.stopPropagation(); bookmarks.splice(i, 1); saveBookmarks(); renderSaved(); });
        top.append(label, el("span", null, b.key ? `Page ${b.page}` : `${SURAHS[surahForPage(b.page) - 1][1]} · Juz ${juzForPage(b.page)}`), del);
        card.append(top);
        if (b.key) {
          const ar = el("div", "verse-ar");
          ar.lang = "ar";
          const trans = el("div", "saved-trans");
          card.append(ar, trans);
          fillVerseArabic(ar, b.key);
          loadVerse(b.key).then((v) => { trans.textContent = translationOf(v); }, () => {});
          card.addEventListener("click", () => openVerse(b.key));
        } else {
          card.addEventListener("click", () => openMushaf(b.page));
        }
        box.append(card);
      });
    } else {
      if (!noteKeys.length) return empty("No notes yet", "Tap an ayah while reading and choose Note to write a reflection.");
      noteKeys.forEach((key) => {
        const card = el("article", "card saved-item");
        const top = el("div", "saved-top");
        top.append(el("strong", null, verseLabel(key)),
          el("span", null, new Date(notes[key].time).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" })));
        card.append(top, el("div", "saved-note", notes[key].text));
        card.addEventListener("click", () => openSheet(key, { note: true }));
        box.append(card);
      });
    }
  }

  // ---------- views & routing ----------
  let view = "home";
  let returnTab = "home";
  function setHash(h, push) {
    if (location.hash === h) return;
    history[push ? "pushState" : "replaceState"](null, "", h);
  }
  function setMode(mode) {
    settings.mode = mode;
    saveSettings();
    document.body.dataset.mode = mode;
  }
  function setChrome(state) { document.body.dataset.chrome = state; }

  function showTab(name, push = true) {
    if (view === "reader") audio.pause();
    view = name;
    document.body.dataset.view = name;
    document.querySelectorAll(".tabbar-item").forEach((b) => b.classList.toggle("active", b.dataset.tabLink === name));
    closeSheet();
    closePanels();
    setHash(`#/${name}`, push);
    if (name === "home") renderHome();
    if (name === "quran") renderQuranList();
    if (name === "mushaf") renderMushafTab();
    if (name === "saved") renderSaved();
    if (name === "search") setTimeout(() => $("searchInput").focus({ preventScroll: true }), 30);
    applyThemeColor();
  }

  function enterReader() {
    if (view !== "reader") returnTab = TABS.includes(view) ? view : "home";
    view = "reader";
    document.body.dataset.view = "reader";
    closeSheet();
    closePanels();
    touchDay();
    applyThemeColor();
  }

  function openMushaf(page, push = true) {
    const wasReader = view === "reader";
    setMode("mushaf");
    enterReader();
    if (!wasReader) {
      setChrome("hidden");
      if (!store.get("chromeHint", false)) { toast("Tap the page to show controls"); store.set("chromeHint", true); }
    }
    return goTo(page, { push: push && !wasReader });
  }
  function openVerse(key) {
    const [s, a] = splitKey(key);
    if (settings.mode === "mushaf" && view === "reader") return goTo(pageForVerse(key)).then(() => flashVerse(key));
    return openSurah(s, a);
  }
  function applyRoute() {
    const h = decodeURIComponent(location.hash.slice(1));
    let m;
    if ((m = h.match(/^\/(\w+)$/)) && TABS.includes(m[1])) return showTab(m[1], false);
    if ((m = h.match(/^p?(\d{1,3})$/))) return openMushaf(clampPage(+m[1]), false);
    if ((m = h.match(/^s(\d{1,3})(?::(\d{1,3}))?$/)) && +m[1] >= 1 && +m[1] <= 114) return openSurah(+m[1], m[2] ? +m[2] : null, false);
    showTab("home", false);
  }
  function leaveReader() { stopAudio(); showTab(returnTab); }

  // ---------- Mushaf reader ----------
  let currentPage = 1;
  let visiblePages = [];
  const verseText = new Map(); // verse key -> Arabic text, for visible pages
  let renderToken = 0;

  const isDouble = () => {
    if (settings.layout === "double") return true;
    if (settings.layout === "single") return false;
    const r = $("reader").getBoundingClientRect();
    return r.width >= 900 && r.width / r.height > 1.05;
  };
  const spreadPages = (p) => {
    if (!isDouble()) return [p];
    const right = p % 2 ? p : p - 1;
    return right + 1 <= TOTAL_PAGES ? [right, right + 1] : [right];
  };

  function sizePages() {
    const spread = $("spread");
    const pages = spread.querySelectorAll(".page");
    if (!pages.length) return;
    const reader = $("reader");
    const cs = getComputedStyle(reader);
    let w = reader.clientWidth - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight);
    const h = reader.clientHeight - parseFloat(cs.paddingTop) - parseFloat(cs.paddingBottom);
    document.querySelectorAll(".nav-arrow").forEach((a) => {
      if (getComputedStyle(a).display !== "none") w -= a.offsetWidth + 8;
    });
    // Pages keep a book-like shape on wide screens and stretch to fill a phone screen.
    const pw = Math.floor(Math.min(w / pages.length, h * MAX_PAGE_RATIO));
    const ph = Math.floor(Math.min(h, pw / MIN_PAGE_RATIO));
    pages.forEach((pg) => {
      pg.style.width = `${pw}px`;
      pg.style.height = `${ph}px`;
    });
    pages.forEach(fitPage);
  }

  // Scale the text so the widest line exactly fills the page, as in the printed mushaf.
  function fitPage(pg) {
    const lines = pg.querySelector(".lines");
    if (!lines) return;
    const base = 20;
    lines.style.fontSize = `${base}px`;
    const rows = [...lines.querySelectorAll(".line")];
    let widest = 0;
    rows.forEach((r) => {
      const gap = parseFloat(getComputedStyle(r).columnGap) || 0;
      const kids = [...r.children];
      const width = kids.reduce((n, k) => n + k.getBoundingClientRect().width, 0) + gap * Math.max(0, kids.length - 1);
      widest = Math.max(widest, width);
    });
    if (!widest) return;
    const count = pg.classList.contains("short") ? rows.length + 4 : LINES_PER_PAGE;
    const byWidth = base * (lines.clientWidth / widest) * 0.99;
    const byHeight = lines.clientHeight / (count * 1.32);
    lines.style.fontSize = `${Math.min(byWidth, byHeight).toFixed(2)}px`;
  }

  const spinnerBox = (cls = "page-loading") => { const b = el("div", cls); b.append(el("div", "spinner")); return b; };

  function pageShell(p) {
    const page = el("section", "page");
    page.dataset.page = p;
    const head = el("div", "page-head");
    head.append(el("span", "head-surah", SURAHS[surahForPage(p) - 1][1]), el("span", "head-juz", `Part ${juzForPage(p)}`));
    const foot = el("div", "page-foot");
    foot.append(el("span", "foot-line"), el("span", "foot-gem"), el("span", "page-num", String(p)), el("span", "foot-gem"), el("span", "foot-line"));
    page.append(head, spinnerBox(), foot);
    return page;
  }

  function buildLines(data, glyph) {
    const frag = document.createDocumentFragment();
    data.lines.forEach((line) => {
      const header = line.words.find((w) => w.type === "surah_header");
      if (header) {
        const box = el("div", "surah-header");
        const name = el("span", "surah-name", glyph ? header.char : "سورة " + SURAHS[header.sura - 1][0]);
        if (glyph) name.style.fontFamily = header.font;
        box.append(name);
        frag.append(box);
        return;
      }
      const bism = line.words.find((w) => w.type === "bismillah");
      if (bism) {
        const b = el("div", "bismillah", glyph ? bism.char : BISMILLAH);
        if (glyph) b.style.fontFamily = bism.font;
        frag.append(b);
        return;
      }
      const lineEl = el("div", "line");
      line.words.forEach((w) => {
        const span = el("span", "word" + (w.type === "end" ? " end" : w.type === "quarter" ? " quarter" : ""));
        if (w.verse_key) span.dataset.key = w.verse_key;
        if (glyph) {
          span.textContent = w.char;
          span.style.fontFamily = w.font;
        } else if (w.type === "end") {
          span.textContent = arabicDigits(splitKey(w.verse_key)[1]);
        } else {
          span.textContent = w.type === "quarter" ? "۞" : w.text;
        }
        lineEl.append(span);
      });
      frag.append(lineEl);
    });
    return frag;
  }

  function indexVerseText(data) {
    const words = new Map();
    data.lines.forEach((l) => l.words.forEach((w) => {
      if (w.type !== "word" || !w.verse_key) return;
      if (!words.has(w.verse_key)) words.set(w.verse_key, []);
      words.get(w.verse_key).push(w.text);
    }));
    words.forEach((list, key) => verseText.set(key, list.join(" ")));
  }

  async function renderPage(p, pageEl, token) {
    try {
      const data = await loadPage(p);
      let glyph = settings.script === "glyph";
      if (glyph) glyph = await Promise.all(fontsOf(data).map(loadFont)).then(() => true, () => false);
      if (token !== renderToken) return;
      indexVerseText(data);
      const lines = el("div", "lines");
      lines.append(buildLines(data, glyph));
      pageEl.classList.toggle("short", data.lines.length < LINES_PER_PAGE);
      pageEl.classList.toggle("glyph", glyph);
      if (data.surahs && data.surahs[0]) pageEl.querySelector(".head-surah").textContent = SURAHS[data.surahs[0].id - 1][1];
      pageEl.children[1].replaceWith(lines);
      fitPage(pageEl);
      if (!glyph) document.fonts.ready.then(() => fitPage(pageEl));
      if (playingKey) markPlaying(playingKey);
    } catch (err) {
      if (token !== renderToken) return;
      const box = el("div", "page-error");
      const inner = el("div");
      inner.append(el("div", null, "Couldn't load this page. Check your connection."));
      const retry = el("button", "ghost-btn", "Retry");
      retry.addEventListener("click", (e) => { e.stopPropagation(); box.replaceWith(spinnerBox()); renderPage(p, pageEl, renderToken); });
      inner.append(retry);
      box.append(inner);
      pageEl.children[1].replaceWith(box);
    }
  }

  function render() {
    const token = ++renderToken;
    visiblePages = spreadPages(currentPage);
    verseText.clear();
    const spread = $("spread");
    spread.classList.toggle("double", visiblePages.length > 1 || isDouble());
    spread.replaceChildren(...visiblePages.map(pageShell));
    sizePages();
    const done = Promise.all(visiblePages.map((p, i) => renderPage(p, spread.children[i], token)));

    const first = visiblePages[0];
    const last = visiblePages[visiblePages.length - 1];
    setTitle(surahForPage(first), `Page ${visiblePages.join("–")} · Juz ${juzForPage(first)}`);
    $("prevBtn").disabled = first <= 1;
    $("nextBtn").disabled = last >= TOTAL_PAGES;
    updateBookmarkBtn();
    updateMarkPageBtn();

    // Warm the cache for the following spread.
    done.then(() => {
      for (let n = last + 1; n <= Math.min(TOTAL_PAGES, last + visiblePages.length); n++) loadPage(n).catch(() => {});
    });
    return done;
  }

  function setTitle(s, meta) {
    $("surahTitle").textContent = SURAHS[s - 1][0];
    $("pageMeta").textContent = `${SURAHS[s - 1][1]} · ${meta}`;
    document.title = `${SURAHS[s - 1][1]} · Mushaf Quran`;
  }

  function goTo(p, { push = false } = {}) {
    currentPage = clampPage(p);
    savePos({ mode: "mushaf", page: currentPage });
    setHash("#p" + currentPage, push);
    closeSheet();
    return render();
  }
  const nextPage = () => { const last = visiblePages[visiblePages.length - 1]; if (last < TOTAL_PAGES) return goTo(last + 1); };
  const prevPage = () => { const first = visiblePages[0]; if (first > 1) return goTo(first - visiblePages.length); };

  function flashVerse(key) {
    document.querySelectorAll(`.word[data-key="${key}"]`).forEach((w) => {
      w.classList.remove("flash"); void w.offsetWidth; w.classList.add("flash");
    });
  }

  const visibleVerseKeys = () => visiblePages.flatMap(versesOnPage);
  function updateMarkPageBtn() {
    const keys = visibleVerseKeys();
    $("markPageBtn").classList.toggle("active", keys.length > 0 && keys.every((k) => readSet.has(k)));
  }
  function toggleMarkPage() {
    const keys = visibleVerseKeys();
    const read = !keys.every((k) => readSet.has(k));
    setRead(keys, read);
    if (read) toast(visiblePages.length > 1 ? `Pages ${visiblePages.join(" & ")} marked as read` : `Page ${visiblePages[0]} marked as read`);
    else toast("Marked as unread");
  }

  // ---------- verse-by-verse reader ----------
  let curSurah = null;
  let surahToken = 0;
  let glyphObserver = null;
  const cardId = (key) => "v" + key.replace(":", "-");

  function buildSurahTabs() {
    const nav = $("surahTabs");
    SURAHS.forEach((m, i) => {
      const b = el("button", "surah-tab", m[1]);
      b.dataset.surah = i + 1;
      b.addEventListener("click", () => openSurah(i + 1, null, false));
      nav.append(b);
    });
  }

  function verseCard(key) {
    const a = splitKey(key)[1];
    const card = el("article", "card verse-card");
    card.id = cardId(key);
    card.dataset.key = key;
    if (readSet.has(key)) card.classList.add("read");
    const ar = el("div", "verse-ar");
    ar.lang = "ar";
    ar.append(el("span", "star num", String(a)));
    const foot = el("div", "verse-foot");
    const mark = el("label", "mark");
    const box = el("input");
    box.type = "checkbox";
    box.checked = readSet.has(key);
    mark.append(box, document.createTextNode("Mark"));
    const bm = el("button", "icon-btn bm");
    bm.setAttribute("aria-label", "Bookmark ayah");
    bm.innerHTML = ICONS.bookmark;
    bm.classList.toggle("active", bookmarks.some((b) => b.key === key));
    const more = el("button", "icon-btn more");
    more.setAttribute("aria-label", "More actions");
    more.innerHTML = ICONS.more;
    foot.append(mark, bm, more);
    card.append(ar, el("div", "verse-translit"), el("div", "verse-trans"), foot);
    return card;
  }

  async function openSurah(s, verse = null, push = true) {
    const wasReader = view === "reader";
    setMode("verses");
    enterReader();
    setChrome("shown");
    const token = ++surahToken;
    curSurah = s;
    const m = SURAHS[s - 1];
    setHash(verse ? `#s${s}:${verse}` : `#s${s}`, push && !wasReader);
    setTitle(s, `${m[3]} verses · Juz ${juzForPage(m[4])}`);
    savePos({ mode: "verses", key: `${s}:${verse || 1}` });

    document.querySelectorAll(".surah-tab").forEach((t) => t.classList.toggle("active", +t.dataset.surah === s));
    const active = document.querySelector(".surah-tab.active");
    if (active) active.scrollIntoView({ block: "nearest", inline: "center" });

    const inner = el("div", "verses-inner");
    const meta = el("div", "surah-meta");
    meta.append(el("strong", null, m[1]), el("span", "chip", `${m[3]} Verses`), el("span", "chip", m[5] === "Meccan" ? "Makkiyah" : "Madaniyah"));
    inner.append(meta);
    if (s !== 1 && s !== 9) {
      const basmala = el("div", "card basmala-card", BISMILLAH);
      inner.append(basmala);
      if (settings.script === "glyph") {
        loadFont(BASMALA_GLYPH[1]).then(() => {
          basmala.textContent = BASMALA_GLYPH[0];
          basmala.style.fontFamily = BASMALA_GLYPH[1];
          basmala.classList.add("glyph");
        }, () => {});
      }
    }
    const cards = [];
    for (let a = 1; a <= m[3]; a++) {
      const card = verseCard(`${s}:${a}`);
      cards.push(card);
      inner.append(card);
    }
    if (s < 114) {
      const next = el("button", "dark-btn next-surah", `Continue to ${SURAHS[s][1]} →`);
      next.addEventListener("click", () => openSurah(s + 1, null, false));
      inner.append(next);
    }
    const container = $("verses");
    container.replaceChildren(inner);
    container.scrollTop = 0;

    // Arabic is filled lazily, a card at a time, as it scrolls into view.
    if (glyphObserver) glyphObserver.disconnect();
    glyphObserver = new IntersectionObserver((entries) => {
      entries.forEach((e) => {
        if (!e.isIntersecting) return;
        glyphObserver.unobserve(e.target);
        fillVerseArabic(e.target.querySelector(".verse-ar"), e.target.dataset.key, keepAnchor);
      });
    }, { root: container, rootMargin: "800px 0px" });
    cards.forEach((c) => glyphObserver.observe(c));

    loadSurahVerses(s).then((verses) => {
      if (token !== surahToken) return;
      keepAnchor(() => cards.forEach((card) => { card.querySelector(".verse-trans").textContent = translationOf(verses.get(card.dataset.key)); }));
    }, () => {
      if (token === surahToken) toast("Translation unavailable right now");
    });
    if (settings.showTranslit) {
      loadTranslit(s).then((list) => {
        if (token !== surahToken) return;
        keepAnchor(() => cards.forEach((card, i) => { card.querySelector(".verse-translit").textContent = list[i] || ""; }));
      }, () => {});
    }

    if (verse) {
      const card = $(cardId(`${s}:${verse}`));
      if (card) {
        card.scrollIntoView({ block: "start" });
        card.classList.add("flash");
      }
    }
    if (playingKey) markPlaying(playingKey);
  }

  // Cards above the viewport grow as their Arabic and translations arrive; keep the first
  // card that starts on screen fixed in place while that happens.
  function keepAnchor(mutate) {
    const container = $("verses");
    const top = container.getBoundingClientRect().top;
    const anchor = [...container.querySelectorAll(".verse-card")].find((c) => c.getBoundingClientRect().top >= top - 1);
    const before = anchor ? anchor.getBoundingClientRect().top : 0;
    mutate();
    if (anchor) container.scrollTop += anchor.getBoundingClientRect().top - before;
  }

  function topVisibleKey() {
    const container = $("verses");
    const top = container.getBoundingClientRect().top + 80; // a card only counts once a good part of it shows
    const cards = container.querySelectorAll(".verse-card");
    for (const c of cards) if (c.getBoundingClientRect().bottom > top) return c.dataset.key;
    return cards.length ? cards[0].dataset.key : null;
  }

  let scrollTimer;
  function onVersesScroll() {
    clearTimeout(scrollTimer);
    scrollTimer = setTimeout(() => {
      const key = topVisibleKey();
      if (!key || view !== "reader") return;
      savePos({ mode: "verses", key });
      const [s, a] = splitKey(key);
      setHash(`#s${s}:${a}`, false);
      setTitle(s, `${SURAHS[s - 1][3]} verses · Juz ${juzOfIndex(verseIndex(key)) + 1}`);
    }, 250);
  }

  function switchMode() {
    if (settings.mode === "mushaf") {
      const w = document.querySelector(".spread .word[data-key]");
      const key = w ? w.dataset.key : PAGE_FIRST_VERSE[currentPage - 1];
      const [s, a] = splitKey(key);
      openSurah(s, a > 1 ? a : null, false);
    } else {
      setMode("mushaf");
      setChrome("shown");
      goTo(pageForVerse(topVisibleKey() || `${curSurah}:1`));
    }
  }

  // ---------- audio ----------
  const audio = $("audio");
  let playingKey = null;
  let bismillahPending = false;
  let repeat = false;

  const audioUrl = (key) => {
    const [s, a] = splitKey(key);
    return `${AUDIO_BASE}/${settings.reciter}/${pad3(s)}${pad3(a)}.mp3`;
  };
  const needsBismillah = (key) => {
    const [s, a] = splitKey(key);
    return a === 1 && s !== 1 && s !== 9;
  };
  const reciterName = () => (RECITERS.find((r) => r[0] === settings.reciter) || RECITERS[0])[1];

  function markPlaying(key) {
    document.querySelectorAll(".word.playing, .verse-card.playing").forEach((w) => w.classList.remove("playing"));
    if (!key) return;
    document.querySelectorAll(`.word[data-key="${key}"]`).forEach((w) => w.classList.add("playing"));
    const card = $(cardId(key));
    if (card && settings.mode === "verses") {
      card.classList.add("playing");
      const r = card.getBoundingClientRect();
      const c = $("verses").getBoundingClientRect();
      if (r.top < c.top || r.bottom > c.bottom - 90) card.scrollIntoView({ block: "center", behavior: "smooth" });
    }
  }

  function playVerse(key) {
    playingKey = key;
    bismillahPending = needsBismillah(key);
    audio.src = bismillahPending ? audioUrl("1:1") : audioUrl(key);
    audio.play().catch(() => toast("Audio couldn't start"));
    markPlaying(key);
    $("audioInfo").textContent = verseLabel(key);
    $("playBtn").classList.add("playing");
    const nk = nextVerseKey(key);
    if (nk) new Audio().src = audioUrl(nk); // preload the following ayah
  }

  function stopAudio(message) {
    audio.pause();
    playingKey = null;
    markPlaying(null);
    $("playBtn").classList.remove("playing");
    $("audioInfo").textContent = message || "Tap play to listen";
  }

  const isShown = (key) => settings.mode === "verses"
    ? !!$(cardId(key))
    : !!document.querySelector(`.spread .word[data-key="${key}"]`);

  audio.addEventListener("ended", async () => {
    if (bismillahPending) {
      bismillahPending = false;
      audio.src = audioUrl(playingKey);
      audio.play().catch(() => {});
      return;
    }
    if (repeat) { audio.currentTime = 0; audio.play().catch(() => {}); return; }
    const nk = playingKey && nextVerseKey(playingKey);
    if (!nk) return stopAudio("Sadaqa Allahu al-'Azim");
    if (isShown(nk)) return playVerse(nk);
    if (!settings.autoAdvance || view !== "reader") return stopAudio();
    playingKey = nk;
    if (settings.mode === "verses") await openSurah(splitKey(nk)[0], null, false);
    else await nextPage();
    playVerse(nk);
  });
  audio.addEventListener("pause", () => { if (!audio.ended) $("playBtn").classList.remove("playing"); });
  audio.addEventListener("play", () => $("playBtn").classList.add("playing"));
  audio.addEventListener("error", () => { if (playingKey) stopAudio("Audio unavailable for this reciter"); });

  function togglePlay() {
    if (playingKey && !audio.paused) return audio.pause();
    if (playingKey && audio.src && isShown(playingKey)) return audio.play();
    const first = document.querySelector(".spread .word[data-key]");
    const k = settings.mode === "verses" ? topVisibleKey() : first && first.dataset.key;
    if (k) playVerse(k);
  }

  // ---------- ayah sheet ----------
  let sheetKey = null;
  function openSheet(key, { note = false } = {}) {
    sheetKey = key;
    const [s, a] = splitKey(key);
    closePanels();
    document.querySelectorAll(".word.selected").forEach((w) => w.classList.remove("selected"));
    document.querySelectorAll(`.word[data-key="${key}"]`).forEach((w) => w.classList.add("selected"));
    $("sheetTitle").textContent = `${SURAHS[s - 1][1]}: ${a}`;
    const ar = $("sheetArabic");
    ar.textContent = verseText.get(key) || "";
    fillVerseArabic(ar, key);
    $("sheetTranslit").textContent = "";
    $("sheetTrans").textContent = "Loading translation…";
    $("noteEditor").hidden = !note;
    $("noteText").value = notes[key] ? notes[key].text : "";
    $("noteDelete").hidden = !notes[key];
    updateSheetActions();
    $("sheet").classList.add("open");
    $("sheet").setAttribute("aria-hidden", "false");
    $("scrim").classList.add("show");
    if (note) setTimeout(() => $("noteText").focus(), 280);
    if (settings.showTranslit) loadTranslit(s).then((l) => { if (sheetKey === key) $("sheetTranslit").textContent = l[a - 1] || ""; }, () => {});
    loadVerse(key).then((v) => {
      if (sheetKey === key) $("sheetTrans").textContent = translationOf(v);
    }, () => { if (sheetKey === key) $("sheetTrans").textContent = "Translation unavailable right now."; });
  }
  function updateSheetActions() {
    if (!sheetKey) return;
    const read = readSet.has(sheetKey);
    $("actMark").classList.toggle("active", read);
    $("actMarkLabel").textContent = read ? "Read" : "Mark read";
    $("actBookmark").classList.toggle("active", bookmarks.some((b) => b.key === sheetKey));
    $("actNote").classList.toggle("active", !!notes[sheetKey]);
  }
  function closeSheet() {
    if (!sheetKey) return;
    sheetKey = null;
    document.querySelectorAll(".word.selected").forEach((w) => w.classList.remove("selected"));
    $("sheet").classList.remove("open");
    $("sheet").setAttribute("aria-hidden", "true");
    if (!anyPanelOpen()) $("scrim").classList.remove("show");
  }
  function saveNote() {
    if (!sheetKey) return;
    const text = $("noteText").value.trim();
    if (text) { notes[sheetKey] = { text, time: Date.now() }; toast("Note saved"); }
    else if (notes[sheetKey]) { delete notes[sheetKey]; toast("Note deleted"); }
    saveNotes();
    $("noteDelete").hidden = !notes[sheetKey];
    updateSheetActions();
    if (view === "saved") renderSaved();
  }
  async function shareVerse(key) {
    const url = `${location.origin}${location.pathname}#s${key}`;
    const text = `${$("sheetTrans").textContent}\n— ${verseLabel(key)}`;
    if (navigator.share) {
      try { await navigator.share({ title: verseLabel(key), text, url }); } catch { /* cancelled */ }
      return;
    }
    try { await navigator.clipboard.writeText(`${text}\n${url}`); toast("Link copied"); } catch { toast("Couldn't share"); }
  }

  // ---------- bookmarks ----------
  function updateBookmarkBtn() {
    $("bookmarkBtn").classList.toggle("active", bookmarks.some((b) => !b.key && visiblePages.includes(b.page)));
  }
  function togglePageBookmark() {
    const p = visiblePages[0];
    const i = bookmarks.findIndex((b) => !b.key && visiblePages.includes(b.page));
    if (i >= 0) { bookmarks.splice(i, 1); toast("Bookmark removed"); }
    else { bookmarks.unshift({ page: p, time: Date.now() }); toast(`Page ${p} bookmarked`); }
    saveBookmarks();
    updateBookmarkBtn();
  }
  function toggleAyahBookmark(key) {
    const i = bookmarks.findIndex((b) => b.key === key);
    if (i >= 0) { bookmarks.splice(i, 1); toast("Bookmark removed"); }
    else { bookmarks.unshift({ key, page: pageForVerse(key), time: Date.now() }); toast(`${verseLabel(key)} bookmarked`); }
    saveBookmarks();
    const card = $(cardId(key));
    if (card) card.querySelector(".bm").classList.toggle("active", i < 0);
    updateSheetActions();
    if (view === "saved") renderSaved();
  }

  // ---------- settings panel ----------
  function openPanel(id) {
    closeSheet();
    $(id).classList.add("open");
    $(id).setAttribute("aria-hidden", "false");
    $("scrim").classList.add("show");
  }
  function closePanels() {
    $("settingsPanel").classList.remove("open");
    $("settingsPanel").setAttribute("aria-hidden", "true");
    if (!sheetKey) $("scrim").classList.remove("show");
  }
  const anyPanelOpen = () => $("settingsPanel").classList.contains("open");

  // ---------- search ----------
  let searchSeq = 0;
  function highlight(node, text, q) {
    const idx = q ? text.toLowerCase().indexOf(q.toLowerCase()) : -1;
    if (idx < 0) { node.textContent = text; return node; }
    node.append(text.slice(0, idx));
    node.append(el("mark", null, text.slice(idx, idx + q.length)));
    node.append(text.slice(idx + q.length));
    return node;
  }

  function quickResults(q) {
    const out = [];
    const ref = q.match(/^(\d{1,3})\s*[:.\s]\s*(\d{1,3})$/);
    if (ref) {
      const s = +ref[1], a = +ref[2];
      if (s >= 1 && s <= 114 && a >= 1 && a <= SURAHS[s - 1][3]) {
        out.push(row({ num: s, name: `Go to ${verseLabel(`${s}:${a}`)}`, sub: SURAHS[s - 1][2], ar: SURAHS[s - 1][0], onClick: () => openSurah(s, a) }));
      }
    } else if (/^\d+$/.test(q)) {
      const n = +q;
      if (n >= 1 && n <= 114) out.push(row({ num: n, name: SURAHS[n - 1][1], sub: `${SURAHS[n - 1][2]} · ${SURAHS[n - 1][3]} verses`, ar: SURAHS[n - 1][0], onClick: () => openSurah(n) }));
      if (n >= 1 && n <= TOTAL_PAGES) out.push(row({ name: `Mushaf page ${n}`, sub: `${SURAHS[surahForPage(n) - 1][1]} · Juz ${juzForPage(n)}`, onClick: () => openMushaf(n) }));
    } else {
      const nq = norm(q);
      SURAHS.forEach((m, i) => {
        if (nq.length >= 2 && (norm(m[1]).includes(nq) || norm(m[2]).includes(nq) || m[0].includes(q))) {
          out.push(row({ num: i + 1, name: m[1], sub: `${m[2]} · ${m[3]} verses`, ar: m[0], onClick: () => openSurah(i + 1) }));
        }
      });
    }
    return out.slice(0, 6);
  }

  async function runSearch(q) {
    const seq = ++searchSeq;
    const list = $("searchResults");
    q = q.trim();
    list.replaceChildren();
    $("searchEmpty").hidden = !!q;
    if (!q) return;
    const quick = quickResults(q);
    if (quick.length) { list.append(el("li", "section", "Jump to")); list.append(...quick); }
    if (q.length < 3 || /^[\d\s:.]+$/.test(q)) {
      if (!quick.length) list.append(el("li", "empty", "Type a little more to search."));
      return;
    }

    const arabic = /[؀-ۿ]/.test(q);
    const loading = el("li", "empty", "Searching…");
    list.append(loading);
    try {
      const edition = arabic ? "quran-simple-clean" : "en.sahih";
      const data = await fetchJSON(`${ALQURAN}/search/${encodeURIComponent(q)}/all/${edition}`);
      if (seq !== searchSeq) return;
      loading.remove();
      const matches = (data.data && data.data.matches) || [];
      list.append(el("li", "section", `${data.data ? data.data.count : 0} verses`));
      if (!matches.length) list.append(el("li", "empty", "No matches"));
      matches.slice(0, 100).forEach((m) => {
        const key = `${m.surah.number}:${m.numberInSurah}`;
        const snip = el("div", "snippet");
        if (arabic) snip.setAttribute("dir", "rtl");
        highlight(snip, m.text, q);
        list.append(row({ num: m.surah.number, name: verseLabel(key), sub: snip, onClick: () => openSurah(m.surah.number, m.numberInSurah) }));
      });
    } catch {
      if (seq !== searchSeq) return;
      loading.textContent = "Search is unavailable right now.";
    }
  }

  // ---------- settings ----------
  function applyThemeColor() {
    const meta = document.querySelector('meta[name="theme-color"]');
    const t = settings.theme;
    const reader = view === "reader";
    meta.content = t === "dark" ? (reader ? "#171e1a" : "#0f1412")
      : t === "sepia" ? (reader ? "#fbf6ec" : "#eee6d6")
        : (reader ? "#ffffff" : "#f2f4f7");
  }
  function applyTheme() {
    document.documentElement.dataset.theme = settings.theme;
    applyThemeColor();
  }

  function fillSelect(sel, options, value) {
    sel.replaceChildren(...options.map(([v, label]) => {
      const o = el("option", null, label);
      o.value = v;
      return o;
    }));
    sel.value = String(value);
  }

  async function loadTranslationList() {
    try {
      const data = await fetchJSON(`${API}/resources/translations`);
      const list = data.translations
        .map((t) => [t.id, `${t.language_name[0].toUpperCase()}${t.language_name.slice(1)} — ${t.translated_name ? t.translated_name.name : t.name}`])
        .sort((a, b) => a[1].localeCompare(b[1]));
      if (list.length) fillSelect($("translationSel"), list, settings.translation);
      if (view === "quran") renderQuranList();
    } catch { /* keep built-in defaults */ }
  }

  // Redraw whatever is on screen after a display setting changes.
  function refresh() {
    dailyRendered = null;
    if (view === "reader") {
      if (settings.mode === "mushaf") render();
      else {
        const [s, a] = splitKey(topVisibleKey() || `${curSurah}:1`);
        openSurah(s, a > 1 ? a : null, false);
      }
    } else showTab(view, false);
  }

  function initSettings() {
    $("themeSel").value = settings.theme;
    $("scriptSel").value = settings.script;
    $("layoutSel").value = settings.layout;
    $("autoAdvance").checked = settings.autoAdvance;
    $("showTranslit").checked = settings.showTranslit;
    fillSelect($("reciterSel"), RECITERS, settings.reciter);
    fillSelect($("translationSel"), DEFAULT_TRANSLATIONS, settings.translation);
    $("playerReciter").textContent = reciterName();
    loadTranslationList();

    $("themeSel").addEventListener("change", (e) => { settings.theme = e.target.value; saveSettings(); applyTheme(); });
    $("layoutSel").addEventListener("change", (e) => { settings.layout = e.target.value; saveSettings(); if (view === "reader" && settings.mode === "mushaf") render(); });
    $("scriptSel").addEventListener("change", (e) => { settings.script = e.target.value; saveSettings(); refresh(); });
    $("autoAdvance").addEventListener("change", (e) => { settings.autoAdvance = e.target.checked; saveSettings(); });
    $("showTranslit").addEventListener("change", (e) => { settings.showTranslit = e.target.checked; saveSettings(); if (view === "reader" && settings.mode === "verses") refresh(); });
    $("reciterSel").addEventListener("change", (e) => {
      settings.reciter = e.target.value; saveSettings();
      $("playerReciter").textContent = reciterName();
      if (playingKey && !audio.paused) playVerse(playingKey);
    });
    $("translationSel").addEventListener("change", (e) => { settings.translation = +e.target.value; saveSettings(); refresh(); });
    $("resetKhatam").addEventListener("click", () => {
      if (!confirm("Reset your reading progress? Read verses will be cleared. Bookmarks and notes are kept.")) return;
      readSet.clear();
      khatam.start = null;
      saveKhatam();
      closePanels();
      refresh();
      toast("Reading progress reset");
    });
  }

  // ---------- misc ----------
  let toastTimer;
  function toast(msg) {
    const t = $("toast");
    t.textContent = msg;
    t.classList.add("show");
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => t.classList.remove("show"), 1900);
  }

  function segmented(id, onChange) {
    const wrap = $(id);
    wrap.querySelectorAll(".seg").forEach((b) => b.addEventListener("click", () => {
      wrap.querySelectorAll(".seg").forEach((x) => x.classList.toggle("active", x === b));
      onChange(b.dataset.seg);
    }));
  }

  function bindEvents() {
    document.querySelectorAll("[data-tab-link]").forEach((b) => b.addEventListener("click", () => showTab(b.dataset.tabLink)));
    document.querySelectorAll("[data-open]").forEach((b) => b.addEventListener("click", () => openPanel(b.dataset.open)));
    document.querySelectorAll("[data-close]").forEach((b) => b.addEventListener("click", () => { closePanels(); closeSheet(); }));
    $("scrim").addEventListener("click", () => { closePanels(); closeSheet(); });

    // Home
    $("resumeCard").addEventListener("click", resume);
    $("dailyCard").addEventListener("click", () => { const [s, a] = splitKey(dailyKey()); openSurah(s, a); });

    // Quran
    $("mushafBanner").addEventListener("click", () => openMushaf(lastMushafPage || 1));
    $("surahFilter").addEventListener("input", renderQuranList);
    segmented("quranSeg", (seg) => { quranSeg = seg; renderQuranList(); });

    // Mushaf tab
    $("mushafContinue").addEventListener("click", () => openMushaf(lastMushafPage || 1));
    segmented("gotoSeg", (seg) => {
      gotoMode = seg;
      $("gotoInput").placeholder = GOTO_PLACEHOLDER[seg];
      $("gotoInput").inputMode = seg === "surah" ? "text" : "numeric";
      $("gotoInput").value = "";
      $("gotoHint").textContent = "";
    });
    $("gotoForm").addEventListener("submit", (e) => {
      e.preventDefault();
      const page = resolveGoto($("gotoInput").value);
      if (!page) { $("gotoHint").textContent = `Enter ${GOTO_PLACEHOLDER[gotoMode].replace(/^(\w+)/, (w) => `a ${w.toLowerCase()} from`)}.`; return; }
      $("gotoHint").textContent = "";
      $("gotoInput").blur();
      openMushaf(page);
    });

    // Saved
    segmented("savedSeg", (seg) => { savedSeg = seg; renderSaved(); });

    // Search
    let searchTimer;
    $("searchInput").addEventListener("input", (e) => {
      clearTimeout(searchTimer);
      searchTimer = setTimeout(() => runSearch(e.target.value), 350);
    });
    $("searchForm").addEventListener("submit", (e) => { e.preventDefault(); clearTimeout(searchTimer); runSearch($("searchInput").value); $("searchInput").blur(); });

    // Reader chrome
    $("backBtn").addEventListener("click", leaveReader);
    $("floatBack").addEventListener("click", leaveReader);
    $("modeBtn").addEventListener("click", switchMode);
    $("bookmarkBtn").addEventListener("click", togglePageBookmark);
    $("markPageBtn").addEventListener("click", toggleMarkPage);
    $("nextBtn").addEventListener("click", (e) => { e.stopPropagation(); nextPage(); });
    $("prevBtn").addEventListener("click", (e) => { e.stopPropagation(); prevPage(); });
    $("playBtn").addEventListener("click", togglePlay);
    $("repeatBtn").addEventListener("click", () => {
      repeat = !repeat;
      $("repeatBtn").classList.toggle("active", repeat);
      toast(repeat ? "Repeating this ayah" : "Repeat off");
    });
    $("reciterBtn").addEventListener("click", () => { openPanel("settingsPanel"); setTimeout(() => $("reciterSel").focus(), 260); });

    // Mushaf: hover highlights the whole ayah, tapping an ayah opens its sheet, tapping elsewhere toggles the controls.
    const spread = $("spread");
    spread.addEventListener("mouseover", (e) => {
      const w = e.target.closest(".word[data-key]");
      document.querySelectorAll(".word.hover").forEach((x) => x.classList.remove("hover"));
      if (w) document.querySelectorAll(`.word[data-key="${w.dataset.key}"]`).forEach((x) => x.classList.add("hover"));
    });
    spread.addEventListener("mouseleave", () => document.querySelectorAll(".word.hover").forEach((x) => x.classList.remove("hover")));
    $("reader").addEventListener("click", (e) => {
      const w = e.target.closest(".word[data-key]");
      if (w) return openSheet(w.dataset.key);
      if (e.target.closest("button")) return;
      setChrome(document.body.dataset.chrome === "hidden" ? "shown" : "hidden");
    });

    // Verse cards
    const verses = $("verses");
    verses.addEventListener("scroll", onVersesScroll, { passive: true });
    verses.addEventListener("click", (e) => {
      const card = e.target.closest(".verse-card");
      if (!card) return;
      const key = card.dataset.key;
      if (e.target.closest(".bm")) toggleAyahBookmark(key);
      else if (e.target.closest(".more") || e.target.closest(".verse-ar")) openSheet(key);
    });
    verses.addEventListener("change", (e) => {
      const card = e.target.closest(".verse-card");
      if (card && e.target.matches(".mark input")) e.target.checked = toggleVerseRead(card.dataset.key);
    });

    // Sheet actions
    $("actShare").addEventListener("click", () => { if (sheetKey) shareVerse(sheetKey); });
    $("actPlay").addEventListener("click", () => {
      if (!sheetKey) return;
      const k = sheetKey;
      closeSheet();
      if (view !== "reader") openSurah(...splitKey(k)).then(() => playVerse(k));
      else playVerse(k);
    });
    $("actMark").addEventListener("click", () => {
      if (!sheetKey) return;
      toast(toggleVerseRead(sheetKey) ? `${verseLabel(sheetKey)} marked as read` : "Marked as unread");
      updateSheetActions();
    });
    $("actBookmark").addEventListener("click", () => { if (sheetKey) toggleAyahBookmark(sheetKey); });
    $("actNote").addEventListener("click", () => {
      const editor = $("noteEditor");
      editor.hidden = !editor.hidden;
      if (!editor.hidden) $("noteText").focus();
    });
    $("noteSave").addEventListener("click", saveNote);
    $("noteDelete").addEventListener("click", () => { $("noteText").value = ""; saveNote(); $("noteEditor").hidden = true; });
    $("actCopy").addEventListener("click", async () => {
      if (!sheetKey) return;
      const v = await loadVerse(sheetKey).catch(() => null);
      const arabic = (v && v.text_uthmani) || verseText.get(sheetKey) || "";
      const text = `${arabic}\n\n${$("sheetTrans").textContent}\n— ${verseLabel(sheetKey)}`;
      try { await navigator.clipboard.writeText(text); toast("Copied"); } catch { toast("Copy failed"); }
    });

    // Swipe: in an Arabic mushaf, dragging left-to-right turns to the next page.
    let touchX = null, touchY = null;
    $("reader").addEventListener("touchstart", (e) => { touchX = e.touches[0].clientX; touchY = e.touches[0].clientY; }, { passive: true });
    $("reader").addEventListener("touchend", (e) => {
      if (touchX == null) return;
      const dx = e.changedTouches[0].clientX - touchX;
      const dy = e.changedTouches[0].clientY - touchY;
      touchX = null;
      if (Math.abs(dx) > 60 && Math.abs(dx) > Math.abs(dy) * 1.5) (dx > 0 ? nextPage : prevPage)();
    });

    document.addEventListener("keydown", (e) => {
      if (e.target.matches("input, select, textarea")) {
        if (e.key === "Escape") e.target.blur();
        return;
      }
      if (e.key === "Escape") {
        if (sheetKey || anyPanelOpen()) { closePanels(); closeSheet(); }
        else if (view === "reader") leaveReader();
        return;
      }
      if (e.key === "/") { e.preventDefault(); showTab("search"); return; }
      if (anyPanelOpen() || sheetKey || view !== "reader") return;
      const mushaf = settings.mode === "mushaf";
      if (e.key === "ArrowLeft" && mushaf) { e.preventDefault(); nextPage(); }
      else if (e.key === "ArrowRight" && mushaf) { e.preventDefault(); prevPage(); }
      else if (e.key === " ") { e.preventDefault(); togglePlay(); }
      else if ((e.key === "b" || e.key === "B") && mushaf) togglePageBookmark();
    });

    window.addEventListener("popstate", applyRoute);

    let resizeTimer, wasDouble = isDouble();
    window.addEventListener("resize", () => {
      clearTimeout(resizeTimer);
      resizeTimer = setTimeout(() => {
        if (view !== "reader" || settings.mode !== "mushaf") return;
        const d = isDouble();
        if (d !== wasDouble) { wasDouble = d; render(); } else sizePages();
      }, 120);
    });
  }

  // ---------- boot ----------
  document.body.dataset.mode = settings.mode;
  document.body.dataset.chrome = "shown";
  applyTheme();
  buildSurahTabs();
  initSettings();
  bindEvents();
  applyRoute();

  if ("serviceWorker" in navigator && /^https:|^http:\/\/localhost/.test(location.href)) {
    navigator.serviceWorker.register("sw.js").catch(() => {});
  }
})();
