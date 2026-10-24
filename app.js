(() => {
  "use strict";

  const API = "https://api.quran.com/api/v4";
  const ALQURAN = "https://api.alquran.cloud/v1";
  const AUDIO_BASE = "https://everyayah.com/data";
  const QCF = "https://cdn.jsdelivr.net/npm/quran-qcf4@1.1.0";
  const HEADER_FONT = "QCF4_QBSML";
  const TOTAL_PAGES = 604;
  const LINES_PER_PAGE = 15;
  const MAX_PAGE_RATIO = 0.68; // width / height on wide screens
  const MIN_PAGE_RATIO = 0.5; // narrowest a page may get on tall phone screens
  const BISMILLAH = "بِسْمِ ٱللَّهِ ٱلرَّحْمَٰنِ ٱلرَّحِيمِ";

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
    reciter: RECITERS[0][0],
    translation: DEFAULT_TRANSLATIONS[0][0],
    autoAdvance: true,
  }, store.get("settings", {}));
  const saveSettings = () => store.set("settings", settings);
  // Earlier versions defaulted to plain text; move everyone to the Madani glyphs once.
  if (!settings.qcf4) { settings.script = "glyph"; settings.qcf4 = true; delete settings.fs; saveSettings(); }

  let bookmarks = store.get("bookmarks", []);
  const saveBookmarks = () => store.set("bookmarks", bookmarks);

  // ---------- metadata helpers ----------
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

  // ---------- data loading ----------
  // Page layout and glyph fonts: KFGQPC QCF4 (Madinah Mushaf 1441H) via the quran-qcf4 package.
  const pageCache = new Map();
  const translationCache = new Map();
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

  const loadPage = (p) => cached(pageCache, p, () => fetchJSON(`${QCF}/pages/${pad3(p)}.json`));

  const loadFont = (name) => cached(fontCache, name, () => {
    const file = name === HEADER_FONT ? name : `${name}_W`;
    const face = new FontFace(name, `url(${QCF}/fonts-woff2/${file}.woff2)`, { display: "block" });
    return face.load().then((f) => { document.fonts.add(f); });
  });

  // Uthmani text and the selected translation for one page, from quran.com.
  const loadTranslations = (p) => cached(translationCache, `${p}|${settings.translation}`, async () => {
    const out = new Map();
    let next = 1;
    while (next) {
      const data = await fetchJSON(`${API}/verses/by_page/${p}?fields=text_uthmani` +
        `&translations=${settings.translation}&per_page=50&page=${next}`);
      data.verses.forEach((v) => out.set(v.verse_key, v));
      next = data.pagination && data.pagination.next_page;
    }
    return out;
  });

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

  // ---------- state ----------
  let currentPage = clampPage(parseInt(location.hash.slice(1), 10) || store.get("lastPage", 1));
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

  // ---------- rendering ----------
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
    rows.forEach((row) => {
      const gap = parseFloat(getComputedStyle(row).columnGap) || 0;
      const kids = [...row.children];
      const width = kids.reduce((n, k) => n + k.getBoundingClientRect().width, 0) + gap * Math.max(0, kids.length - 1);
      widest = Math.max(widest, width);
    });
    if (!widest) return;
    const count = pg.classList.contains("short") ? rows.length + 4 : LINES_PER_PAGE;
    const byWidth = base * (lines.clientWidth / widest) * 0.99;
    const byHeight = lines.clientHeight / (count * 1.32);
    lines.style.fontSize = `${Math.min(byWidth, byHeight).toFixed(2)}px`;
  }

  function pageShell(p) {
    const page = el("section", "page");
    page.dataset.page = p;
    const head = el("div", "page-head");
    head.append(el("span", "head-surah", "سورة " + SURAHS[surahForPage(p) - 1][0]),
      el("span", "head-juz", "الجزء " + arabicDigits(juzForPage(p))));
    const foot = el("div", "page-foot");
    foot.append(el("span", "page-num", arabicDigits(p)));
    page.append(head, spinnerBox(), foot);
    return page;
  }
  const spinnerBox = () => { const b = el("div", "page-loading"); b.append(el("div", "spinner")); return b; };

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
      const row = el("div", "line");
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
        row.append(span);
      });
      frag.append(row);
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
      if (glyph) {
        const fonts = new Set();
        data.lines.forEach((l) => l.words.forEach((w) => fonts.add(w.font)));
        glyph = await Promise.all([...fonts].map(loadFont)).then(() => true, () => false);
      }
      if (token !== renderToken) return;
      indexVerseText(data);
      const lines = el("div", "lines");
      lines.append(buildLines(data, glyph));
      pageEl.classList.toggle("short", data.lines.length < LINES_PER_PAGE);
      pageEl.classList.toggle("glyph", glyph);
      if (data.surahs && data.surahs[0]) pageEl.querySelector(".head-surah").textContent = "سورة " + SURAHS[data.surahs[0].id - 1][0];
      pageEl.children[1].replaceWith(lines);
      fitPage(pageEl);
      if (!glyph) document.fonts.ready.then(() => fitPage(pageEl));
      if (playingKey) markPlaying(playingKey);
    } catch (err) {
      if (token !== renderToken) return;
      const box = el("div", "page-error");
      const inner = el("div");
      inner.append(el("div", null, "Couldn't load this page. Check your connection."));
      const retry = el("button", null, "Retry");
      retry.addEventListener("click", () => { box.replaceWith(spinnerBox()); renderPage(p, pageEl, renderToken); });
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
    $("surahTitle").textContent = SURAHS[surahForPage(first) - 1][0];
    $("pageMeta").textContent = `${SURAHS[surahForPage(first) - 1][1]} · Page ${visiblePages.join("–")} · Juz ${juzForPage(first)}`;
    $("gotoInput").value = "";
    $("gotoInput").placeholder = String(first);
    $("prevBtn").disabled = first <= 1;
    $("nextBtn").disabled = last >= TOTAL_PAGES;
    updateBookmarkBtn();
    document.title = `${SURAHS[surahForPage(first) - 1][1]} — Page ${first} · Mushaf Quran`;

    // Warm the cache for the following spread.
    done.then(() => {
      for (let n = last + 1; n <= Math.min(TOTAL_PAGES, last + visiblePages.length); n++) loadPage(n).catch(() => {});
    });
    return done;
  }

  function goTo(p, { push = true } = {}) {
    currentPage = clampPage(p);
    store.set("lastPage", currentPage);
    if (push && location.hash !== "#" + currentPage) history.replaceState(null, "", "#" + currentPage);
    closePopover();
    return render();
  }
  const step = () => visiblePages.length;
  const nextPage = () => { const last = visiblePages[visiblePages.length - 1]; if (last < TOTAL_PAGES) return goTo(last + 1); };
  const prevPage = () => { const first = visiblePages[0]; if (first > 1) return goTo(first - step()); };

  async function goToVerse(key) {
    const p = pageForVerse(key);
    if (!visiblePages.includes(p)) await goTo(p);
    document.querySelectorAll(`.word[data-key="${key}"]`).forEach((w) => {
      w.classList.remove("flash"); void w.offsetWidth; w.classList.add("flash");
    });
  }

  // ---------- audio ----------
  const audio = $("audio");
  let playingKey = null;
  let bismillahPending = false;

  const audioUrl = (key) => {
    const [s, a] = splitKey(key);
    return `${AUDIO_BASE}/${settings.reciter}/${pad3(s)}${pad3(a)}.mp3`;
  };
  const needsBismillah = (key) => {
    const [s, a] = splitKey(key);
    return a === 1 && s !== 1 && s !== 9;
  };

  function markPlaying(key) {
    document.querySelectorAll(".word.playing").forEach((w) => w.classList.remove("playing"));
    if (key) document.querySelectorAll(`.word[data-key="${key}"]`).forEach((w) => w.classList.add("playing"));
  }

  function playVerse(key) {
    playingKey = key;
    bismillahPending = needsBismillah(key);
    audio.src = bismillahPending ? audioUrl("1:1") : audioUrl(key);
    audio.play().catch(() => toast("Audio couldn't start"));
    markPlaying(key);
    $("audioInfo").textContent = `${verseLabel(key)} · ${RECITERS.find((r) => r[0] === settings.reciter)[1]}`;
    $("playBtn").classList.add("playing");
    const nk = nextVerseKey(key);
    if (nk) new Audio().src = audioUrl(nk); // preload the following ayah
  }

  function stopAudio(message) {
    audio.pause();
    playingKey = null;
    markPlaying(null);
    $("playBtn").classList.remove("playing");
    $("audioInfo").textContent = message || "Tap an ayah or press play";
  }

  function firstVisibleKey() {
    const w = document.querySelector(".spread .word");
    return w && w.dataset.key;
  }

  audio.addEventListener("ended", async () => {
    if (bismillahPending) {
      bismillahPending = false;
      audio.src = audioUrl(playingKey);
      audio.play().catch(() => {});
      return;
    }
    const nk = playingKey && nextVerseKey(playingKey);
    if (!nk) return stopAudio("Sadaqa Allahu al-'Azim");
    if (document.querySelector(`.spread .word[data-key="${nk}"]`)) return playVerse(nk);
    if (!settings.autoAdvance) return stopAudio();
    const last = visiblePages[visiblePages.length - 1];
    if (last >= TOTAL_PAGES) return stopAudio();
    playingKey = nk;
    await nextPage();
    playVerse(nk);
  });
  audio.addEventListener("pause", () => { if (!audio.ended) $("playBtn").classList.remove("playing"); });
  audio.addEventListener("play", () => $("playBtn").classList.add("playing"));
  audio.addEventListener("error", () => { if (playingKey) stopAudio("Audio unavailable for this reciter"); });

  function togglePlay() {
    if (playingKey && !audio.paused) return audio.pause();
    if (playingKey && audio.src && document.querySelector(`.spread .word[data-key="${playingKey}"]`)) return audio.play();
    const k = firstVisibleKey();
    if (k) playVerse(k);
  }

  // ---------- popover ----------
  let popKey = null;
  function cleanTranslation(html) {
    const tpl = document.createElement("template");
    tpl.innerHTML = html || "";
    tpl.content.querySelectorAll("sup").forEach((s) => s.remove());
    return tpl.content.textContent.trim();
  }
  function openPopover(key) {
    popKey = key;
    document.querySelectorAll(".word.selected").forEach((w) => w.classList.remove("selected"));
    document.querySelectorAll(`.word[data-key="${key}"]`).forEach((w) => w.classList.add("selected"));
    $("popKey").textContent = verseLabel(key);
    $("popArabic").textContent = verseText.get(key) || "";
    $("popTrans").textContent = "Loading translation…";
    loadTranslations(pageForVerse(key)).then((verses) => {
      if (popKey !== key) return;
      const v = verses.get(key);
      if (v && v.text_uthmani) $("popArabic").textContent = v.text_uthmani;
      const tr = v && v.translations && v.translations[0];
      $("popTrans").textContent = tr ? cleanTranslation(tr.text) : "";
    }, () => {
      if (popKey === key) $("popTrans").textContent = "Translation unavailable right now.";
    });
    $("popBookmark").classList.toggle("active", bookmarks.some((b) => b.key === key));
    $("popover").classList.add("open");
    $("popover").setAttribute("aria-hidden", "false");
  }
  function closePopover() {
    popKey = null;
    document.querySelectorAll(".word.selected").forEach((w) => w.classList.remove("selected"));
    $("popover").classList.remove("open");
    $("popover").setAttribute("aria-hidden", "true");
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
    if (activeTab === "bookmarks") renderIndex();
  }
  function toggleAyahBookmark(key) {
    const i = bookmarks.findIndex((b) => b.key === key);
    if (i >= 0) { bookmarks.splice(i, 1); toast("Bookmark removed"); }
    else {
      bookmarks.unshift({ key, page: pageForVerse(key), time: Date.now() });
      toast(`${verseLabel(key)} bookmarked`);
    }
    saveBookmarks();
    $("popBookmark").classList.toggle("active", i < 0);
    if (activeTab === "bookmarks") renderIndex();
  }

  // ---------- panels ----------
  const panels = ["drawer", "searchPanel", "settingsPanel"];
  function openPanel(id) {
    panels.forEach((p) => { $(p).classList.toggle("open", p === id); $(p).setAttribute("aria-hidden", p !== id); });
    $("scrim").classList.add("show");
    closePopover();
    if (id === "drawer") { renderIndex(); scrollIndexToCurrent(); }
    if (id === "searchPanel") setTimeout(() => $("searchInput").focus(), 50);
  }
  function closePanels() {
    panels.forEach((p) => { $(p).classList.remove("open"); $(p).setAttribute("aria-hidden", "true"); });
    $("scrim").classList.remove("show");
  }
  const anyPanelOpen = () => panels.some((p) => $(p).classList.contains("open"));

  // ---------- index (surah / juz / bookmarks) ----------
  let activeTab = "surahs";
  function listItem({ num, name, sub, ar, current, onClick, onDelete }) {
    const li = el("li");
    if (current) li.classList.add("current");
    if (num != null) { const n = el("div", "num"); n.append(el("span", null, num)); li.append(n); }
    const info = el("div", "info");
    info.append(el("div", "name", name));
    if (sub) info.append(el("div", "sub", sub));
    li.append(info);
    if (ar) li.append(el("div", "ar", ar));
    if (onDelete) {
      const del = el("button", "icon-btn del");
      del.setAttribute("aria-label", "Remove bookmark");
      del.innerHTML = '<svg viewBox="0 0 24 24"><path d="M6 6l12 12M18 6L6 18"/></svg>';
      del.addEventListener("click", (e) => { e.stopPropagation(); onDelete(); });
      li.append(del);
    }
    li.addEventListener("click", onClick);
    return li;
  }

  function renderIndex() {
    const list = $("indexList");
    const filterBox = $("surahFilter");
    filterBox.hidden = activeTab !== "surahs";
    list.replaceChildren();
    const curSurah = surahForPage(visiblePages[0] || currentPage);

    if (activeTab === "surahs") {
      const q = filterBox.value.trim().toLowerCase();
      SURAHS.forEach((m, i) => {
        const hay = `${i + 1} ${m[0]} ${m[1]} ${m[2]}`.toLowerCase().replace(/['-]/g, "");
        if (q && !hay.includes(q.replace(/['-]/g, ""))) return;
        list.append(listItem({
          num: i + 1, name: m[1], sub: `${m[2]} · ${m[3]} ayahs · ${m[5]} · p.${m[4]}`, ar: m[0],
          current: i + 1 === curSurah,
          onClick: () => { closePanels(); goTo(m[4]); },
        }));
      });
    } else if (activeTab === "juz") {
      const curJuz = juzForPage(visiblePages[0] || currentPage);
      JUZ.forEach(([key, page], i) => {
        list.append(listItem({
          num: i + 1, name: `Juz ${i + 1}`, sub: `Starts ${verseLabel(key)} · p.${page}`, ar: "الجزء " + arabicDigits(i + 1),
          current: i + 1 === curJuz,
          onClick: () => { closePanels(); goTo(page); },
        }));
      });
    } else {
      const last = store.get("lastPage", null);
      if (last) {
        list.append(el("li", "list-section", "Last read"));
        list.append(listItem({
          name: `Page ${last}`, sub: `${SURAHS[surahForPage(last) - 1][1]} · Juz ${juzForPage(last)}`,
          onClick: () => { closePanels(); goTo(last); },
        }));
      }
      list.append(el("li", "list-section", "Bookmarks"));
      if (!bookmarks.length) list.append(el("li", "empty", "No bookmarks yet. Use the bookmark button or tap an ayah."));
      bookmarks.forEach((b, i) => {
        const remove = () => { bookmarks.splice(i, 1); saveBookmarks(); updateBookmarkBtn(); renderIndex(); };
        list.append(b.key
          ? listItem({ name: verseLabel(b.key), sub: `Ayah · page ${b.page}`, onClick: () => { closePanels(); goToVerse(b.key); }, onDelete: remove })
          : listItem({ name: `Page ${b.page}`, sub: `${SURAHS[surahForPage(b.page) - 1][1]} · Juz ${juzForPage(b.page)}`, onClick: () => { closePanels(); goTo(b.page); }, onDelete: remove }));
      });
    }
  }
  function scrollIndexToCurrent() {
    const cur = $("indexList").querySelector(".current");
    if (cur) cur.scrollIntoView({ block: "center" });
  }

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
        out.push(listItem({ name: `Go to ${verseLabel(`${s}:${a}`)}`, sub: "Verse", onClick: () => { closePanels(); goToVerse(`${s}:${a}`); } }));
      }
    } else if (/^\d+$/.test(q)) {
      const n = +q;
      if (n >= 1 && n <= TOTAL_PAGES) out.push(listItem({ name: `Go to page ${n}`, sub: `Juz ${juzForPage(n)}`, onClick: () => { closePanels(); goTo(n); } }));
      if (n >= 1 && n <= 114) out.push(listItem({ num: n, name: SURAHS[n - 1][1], sub: SURAHS[n - 1][2], ar: SURAHS[n - 1][0], onClick: () => { closePanels(); goTo(SURAHS[n - 1][4]); } }));
    } else {
      const norm = (s) => s.toLowerCase().replace(/['-\s]/g, "");
      const nq = norm(q);
      SURAHS.forEach((m, i) => {
        if (nq.length >= 2 && (norm(m[1]).includes(nq) || norm(m[2]).includes(nq) || m[0].includes(q))) {
          out.push(listItem({ num: i + 1, name: m[1], sub: m[2], ar: m[0], onClick: () => { closePanels(); goTo(m[4]); } }));
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
    if (!q) return;
    const quick = quickResults(q);
    if (quick.length) { list.append(el("li", "list-section", "Jump to")); list.append(...quick); }
    if (q.length < 3 || /^[\d\s:.]+$/.test(q)) return;

    const arabic = /[؀-ۿ]/.test(q);
    const loading = el("li", "empty", "Searching…");
    list.append(loading);
    try {
      const edition = arabic ? "quran-simple-clean" : "en.sahih";
      const data = await fetchJSON(`${ALQURAN}/search/${encodeURIComponent(q)}/all/${edition}`);
      if (seq !== searchSeq) return;
      loading.remove();
      const matches = (data.data && data.data.matches) || [];
      list.append(el("li", "list-section", `${data.data ? data.data.count : 0} verses`));
      if (!matches.length) list.append(el("li", "empty", "No matches"));
      matches.slice(0, 100).forEach((m) => {
        const key = `${m.surah.number}:${m.numberInSurah}`;
        const li = el("li");
        const info = el("div", "info");
        info.append(el("div", "name", verseLabel(key)));
        const snip = el("div", "snippet");
        if (arabic) snip.setAttribute("dir", "rtl");
        info.append(highlight(snip, m.text, q));
        li.append(info);
        li.addEventListener("click", () => { closePanels(); goToVerse(key); });
        list.append(li);
      });
    } catch {
      if (seq !== searchSeq) return;
      loading.textContent = "Search is unavailable right now.";
    }
  }

  // ---------- settings ----------
  function applyTheme() {
    document.documentElement.dataset.theme = settings.theme;
    const meta = document.querySelector('meta[name="theme-color"]');
    meta.content = settings.theme === "dark" ? "#182019" : settings.theme === "sepia" ? "#8a5a1e" : "#1f5f4a";
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
    } catch { /* keep built-in defaults */ }
  }

  function initSettings() {
    const scriptSel = el("select");
    scriptSel.id = "scriptSel";
    fillSelect(scriptSel, [["glyph", "Madani Mushaf (King Fahd Complex)"], ["text", "Uthmani text (Amiri)"]], settings.script);
    const scriptLabel = el("label", null, "Script");
    scriptLabel.append(scriptSel);
    $("layoutSel").closest("label").after(scriptLabel);

    $("themeSel").value = settings.theme;
    $("layoutSel").value = settings.layout;
    $("autoAdvance").checked = settings.autoAdvance;
    fillSelect($("reciterSel"), RECITERS, settings.reciter);
    fillSelect($("translationSel"), DEFAULT_TRANSLATIONS, settings.translation);
    loadTranslationList();

    $("themeSel").addEventListener("change", (e) => { settings.theme = e.target.value; saveSettings(); applyTheme(); });
    $("layoutSel").addEventListener("change", (e) => { settings.layout = e.target.value; saveSettings(); render(); });
    scriptSel.addEventListener("change", (e) => { settings.script = e.target.value; saveSettings(); render(); });
    $("autoAdvance").addEventListener("change", (e) => { settings.autoAdvance = e.target.checked; saveSettings(); });
    $("reciterSel").addEventListener("change", (e) => {
      settings.reciter = e.target.value; saveSettings();
      if (playingKey && !audio.paused) playVerse(playingKey);
    });
    $("translationSel").addEventListener("change", (e) => { settings.translation = +e.target.value; saveSettings(); });
  }

  // ---------- misc ----------
  let toastTimer;
  function toast(msg) {
    const t = $("toast");
    t.textContent = msg;
    t.classList.add("show");
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => t.classList.remove("show"), 1800);
  }

  function bindEvents() {
    $("menuBtn").addEventListener("click", () => openPanel("drawer"));
    $("searchBtn").addEventListener("click", () => openPanel("searchPanel"));
    $("settingsBtn").addEventListener("click", () => openPanel("settingsPanel"));
    $("bookmarkBtn").addEventListener("click", togglePageBookmark);
    $("nextBtn").addEventListener("click", nextPage);
    $("prevBtn").addEventListener("click", prevPage);
    $("playBtn").addEventListener("click", togglePlay);
    $("scrim").addEventListener("click", closePanels);
    document.querySelectorAll("[data-close]").forEach((b) => b.addEventListener("click", () => { closePanels(); closePopover(); }));

    document.querySelectorAll(".tab").forEach((t) => t.addEventListener("click", () => {
      activeTab = t.dataset.tab;
      document.querySelectorAll(".tab").forEach((x) => x.classList.toggle("active", x === t));
      renderIndex();
      scrollIndexToCurrent();
    }));
    $("surahFilter").addEventListener("input", renderIndex);

    $("gotoForm").addEventListener("submit", (e) => {
      e.preventDefault();
      const n = parseInt($("gotoInput").value, 10);
      if (n) goTo(n);
      $("gotoInput").blur();
    });

    let searchTimer;
    $("searchInput").addEventListener("input", (e) => {
      clearTimeout(searchTimer);
      searchTimer = setTimeout(() => runSearch(e.target.value), 350);
    });
    $("searchForm").addEventListener("submit", (e) => { e.preventDefault(); clearTimeout(searchTimer); runSearch($("searchInput").value); });

    // Word interactions: hover highlights the whole ayah, click opens it.
    const spread = $("spread");
    spread.addEventListener("mouseover", (e) => {
      const w = e.target.closest(".word");
      document.querySelectorAll(".word.hover").forEach((x) => x.classList.remove("hover"));
      if (w) document.querySelectorAll(`.word[data-key="${w.dataset.key}"]`).forEach((x) => x.classList.add("hover"));
    });
    spread.addEventListener("mouseleave", () => document.querySelectorAll(".word.hover").forEach((x) => x.classList.remove("hover")));
    spread.addEventListener("click", (e) => {
      const w = e.target.closest(".word");
      if (!w) return closePopover();
      if (popKey === w.dataset.key) return closePopover();
      openPopover(w.dataset.key);
    });

    $("popPlay").addEventListener("click", () => { if (popKey) playVerse(popKey); });
    $("popBookmark").addEventListener("click", () => { if (popKey) toggleAyahBookmark(popKey); });
    $("popCopy").addEventListener("click", async () => {
      if (!popKey) return;
      const text = `${$("popArabic").textContent}\n\n${$("popTrans").textContent}\n— ${verseLabel(popKey)}`;
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
      if (e.key === "Escape") { closePanels(); closePopover(); return; }
      if (anyPanelOpen()) return;
      if (e.key === "ArrowLeft") { e.preventDefault(); nextPage(); }
      else if (e.key === "ArrowRight") { e.preventDefault(); prevPage(); }
      else if (e.key === " ") { e.preventDefault(); togglePlay(); }
      else if (e.key === "b" || e.key === "B") togglePageBookmark();
      else if (e.key === "/") { e.preventDefault(); openPanel("searchPanel"); }
    });

    window.addEventListener("hashchange", () => {
      const p = parseInt(location.hash.slice(1), 10);
      if (p && !visiblePages.includes(p)) goTo(p, { push: false });
    });

    let resizeTimer, wasDouble = isDouble();
    window.addEventListener("resize", () => {
      clearTimeout(resizeTimer);
      resizeTimer = setTimeout(() => {
        const d = isDouble();
        if (d !== wasDouble) { wasDouble = d; render(); } else sizePages();
      }, 120);
    });
  }

  // ---------- boot ----------
  applyTheme();
  initSettings();
  bindEvents();
  goTo(currentPage);

  if ("serviceWorker" in navigator && /^https:|^http:\/\/localhost/.test(location.href)) {
    navigator.serviceWorker.register("sw.js").catch(() => {});
  }
})();
