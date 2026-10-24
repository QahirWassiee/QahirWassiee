(() => {
  "use strict";

  const API = "https://api.quran.com/api/v4";
  const ALQURAN = "https://api.alquran.cloud/v1";
  const AUDIO_BASE = "https://everyayah.com/data";
  const GLYPH_FONT = (p) => `https://static.qurancdn.com/fonts/quran/hafs/v2/woff2/p${p}.woff2`;
  const TOTAL_PAGES = 604;
  const LINES_PER_PAGE = 15;
  const PAGE_RATIO = 0.64; // width / height
  const BISMILLAH = "بِسْمِ ٱللَّهِ ٱلرَّحْمَٰنِ ٱلرَّحِيمِ";

  const { SURAHS, JUZ, RECITERS, DEFAULT_TRANSLATIONS } = window;
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
    fs: 100,
    script: "text",
    reciter: RECITERS[0][0],
    translation: DEFAULT_TRANSLATIONS[0][0],
    autoAdvance: true,
  }, store.get("settings", {}));
  const saveSettings = () => store.set("settings", settings);

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
  const pageCache = new Map();

  async function fetchJSON(url) {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return res.json();
  }

  function loadPage(p) {
    const cacheKey = `${p}|${settings.translation}`;
    if (!pageCache.has(cacheKey)) {
      const promise = (async () => {
        const verses = [];
        let next = 1;
        while (next) {
          const url = `${API}/verses/by_page/${p}?words=true` +
            `&word_fields=text_uthmani,code_v2,line_number,page_number` +
            `&fields=text_uthmani,page_number,juz_number` +
            `&translations=${settings.translation}&per_page=50&page=${next}`;
          const data = await fetchJSON(url);
          verses.push(...data.verses);
          next = data.pagination && data.pagination.next_page;
        }
        return verses;
      })();
      promise.catch(() => pageCache.delete(cacheKey));
      pageCache.set(cacheKey, promise);
    }
    return pageCache.get(cacheKey);
  }

  const glyphFonts = new Map();
  function loadGlyphFont(p) {
    if (!glyphFonts.has(p)) {
      const face = new FontFace(`qcf-p${p}`, `url(${GLYPH_FONT(p)})`, { display: "block" });
      const promise = face.load().then((f) => { document.fonts.add(f); return true; }, () => false);
      glyphFonts.set(p, promise);
    }
    return glyphFonts.get(p);
  }

  async function findVersePage(key) {
    try {
      const data = await fetchJSON(`${API}/verses/by_key/${key}?fields=page_number`);
      if (data.verse && data.verse.page_number) return data.verse.page_number;
    } catch { /* fall through to the secondary API */ }
    const data = await fetchJSON(`${ALQURAN}/ayah/${key}`);
    if (!data.data || !data.data.page) throw new Error("Verse not found");
    return data.data.page;
  }

  // ---------- state ----------
  let currentPage = clampPage(parseInt(location.hash.slice(1), 10) || store.get("lastPage", 1));
  let visiblePages = [];
  const verseIndex = new Map(); // verse key -> verse object for visible pages
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
    const pw = Math.min(w / pages.length, h * PAGE_RATIO);
    pages.forEach((pg) => {
      pg.style.width = `${Math.floor(pw)}px`;
      pg.style.height = `${Math.floor(pw / PAGE_RATIO)}px`;
    });
  }

  function pageShell(p) {
    const page = el("section", "page");
    page.dataset.page = p;
    const head = el("div", "page-head");
    head.append(el("span", "head-surah", "سورة " + SURAHS[surahForPage(p) - 1][0]),
      el("span", "head-juz", "الجزء " + arabicDigits(juzForPage(p))));
    const body = el("div", "page-loading");
    body.append(el("div", "spinner"));
    const foot = el("div", "page-foot");
    foot.append(el("span", "page-num", arabicDigits(p)));
    page.append(head, body, foot);
    return page;
  }

  function surahHeader(s) {
    return el("div", "surah-header", "سورة " + SURAHS[s - 1][0]);
  }

  function buildLines(p, verses, glyph) {
    const byLine = new Map();
    verses.forEach((v) => {
      v.words.forEach((w) => {
        if (w.page_number && w.page_number !== p) return;
        if (!byLine.has(w.line_number)) byLine.set(w.line_number, []);
        byLine.get(w.line_number).push({ w, v });
      });
    });

    const short = p <= 2;
    const slots = [];
    for (let l = 1; l <= LINES_PER_PAGE; l++) slots.push(byLine.has(l) ? { line: byLine.get(l) } : { gap: true });

    // Gaps are where surah headers and the basmala sit in the printed mushaf.
    const lastVerse = verses[verses.length - 1];
    const out = [];
    for (let i = 0; i < slots.length;) {
      if (!slots[i].gap) { out.push(slots[i]); i++; continue; }
      let j = i;
      while (j < slots.length && slots[j].gap) j++;
      const gapLen = j - i;
      let surah = null;
      if (j < slots.length) {
        const first = slots[j].line[0];
        if (first.v.verse_number === 1 && first.w.position === 1) surah = first.v.chapter_id || splitKey(first.v.verse_key)[0];
      } else if (lastVerse && !short && p < TOTAL_PAGES) {
        const [s, a] = splitKey(lastVerse.verse_key);
        if (a === SURAHS[s - 1][3] && s < 114) surah = s + 1;
      }
      if (surah) {
        out.push({ header: surah });
        if (gapLen >= 2 && surah !== 1 && surah !== 9) out.push({ bismillah: true });
        for (let k = (gapLen >= 2 && surah !== 1 && surah !== 9) ? 2 : 1; k < gapLen && !short; k++) out.push({ spacer: true });
      } else if (!short) {
        for (let k = 0; k < gapLen; k++) out.push({ spacer: true });
      }
      i = j;
    }

    const textOf = (x) => (glyph ? x.w.code_v2 : x.w.text_uthmani) || "";
    const lengths = out.filter((o) => o.line).map((o) => o.line.reduce((n, x) => n + textOf(x).length, 0));
    const maxLen = Math.max(1, ...lengths);

    const frag = document.createDocumentFragment();
    out.forEach((o, idx) => {
      if (o.header) { frag.append(surahHeader(o.header)); return; }
      if (o.bismillah) { frag.append(el("div", "bismillah", BISMILLAH)); return; }
      if (o.spacer) { frag.append(el("div", "line")); return; }
      const line = el("div", "line");
      if (glyph) line.style.fontFamily = `qcf-p${p}`;
      const len = o.line.reduce((n, x) => n + textOf(x).length, 0);
      const nextIsBreak = !out[idx + 1] || out[idx + 1].header || out[idx + 1].spacer;
      if (short || (len < maxLen * 0.7 && nextIsBreak)) line.classList.add("center");
      o.line.forEach(({ w, v }) => {
        const isEnd = w.char_type_name === "end";
        const span = el("span", "word" + (isEnd ? " end" : ""));
        span.dataset.key = v.verse_key;
        span.textContent = glyph ? w.code_v2 : (isEnd ? arabicDigits(v.verse_number) : w.text_uthmani);
        line.append(span);
      });
      frag.append(line);
    });
    return { frag, short };
  }

  async function renderPage(p, pageEl, token) {
    try {
      const verses = await loadPage(p);
      let glyph = settings.script === "glyph";
      if (glyph) glyph = await loadGlyphFont(p);
      if (token !== renderToken) return;
      verses.forEach((v) => verseIndex.set(v.verse_key, v));
      const { frag, short } = buildLines(p, verses, glyph);
      const lines = el("div", "lines");
      lines.append(frag);
      pageEl.classList.toggle("short", short);
      pageEl.classList.toggle("glyph", glyph);
      if (verses[0]) {
        pageEl.querySelector(".head-surah").textContent = "سورة " + SURAHS[splitKey(verses[0].verse_key)[0] - 1][0];
        if (verses[0].juz_number) pageEl.querySelector(".head-juz").textContent = "الجزء " + arabicDigits(verses[0].juz_number);
      }
      pageEl.children[1].replaceWith(lines);
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
  const spinnerBox = () => { const b = el("div", "page-loading"); b.append(el("div", "spinner")); return b; };

  function render() {
    const token = ++renderToken;
    visiblePages = spreadPages(currentPage);
    verseIndex.clear();
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
    try {
      const p = await findVersePage(key);
      if (!visiblePages.includes(p)) await goTo(p);
      document.querySelectorAll(`.word[data-key="${key}"]`).forEach((w) => {
        w.classList.remove("flash"); void w.offsetWidth; w.classList.add("flash");
      });
    } catch {
      toast("Couldn't find that verse");
    }
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
    const v = verseIndex.get(key);
    if (!v) return;
    popKey = key;
    document.querySelectorAll(".word.selected").forEach((w) => w.classList.remove("selected"));
    document.querySelectorAll(`.word[data-key="${key}"]`).forEach((w) => w.classList.add("selected"));
    $("popKey").textContent = verseLabel(key);
    $("popArabic").textContent = v.text_uthmani;
    const tr = v.translations && v.translations[0];
    $("popTrans").textContent = tr ? cleanTranslation(tr.text) : "";
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
      const v = verseIndex.get(key);
      bookmarks.unshift({ key, page: (v && v.page_number) || visiblePages[0], time: Date.now() });
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
  function applyFontSize() { document.documentElement.style.setProperty("--fs", settings.fs / 100); }

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
    fillSelect(scriptSel, [["text", "Uthmani text"], ["glyph", "Madani page glyphs (QCF)"]], settings.script);
    const scriptLabel = el("label", null, "Script");
    scriptLabel.append(scriptSel);
    $("layoutSel").closest("label").after(scriptLabel);

    $("themeSel").value = settings.theme;
    $("layoutSel").value = settings.layout;
    $("fontSize").value = settings.fs;
    $("autoAdvance").checked = settings.autoAdvance;
    fillSelect($("reciterSel"), RECITERS, settings.reciter);
    fillSelect($("translationSel"), DEFAULT_TRANSLATIONS, settings.translation);
    loadTranslationList();

    $("themeSel").addEventListener("change", (e) => { settings.theme = e.target.value; saveSettings(); applyTheme(); });
    $("layoutSel").addEventListener("change", (e) => { settings.layout = e.target.value; saveSettings(); render(); });
    scriptSel.addEventListener("change", (e) => { settings.script = e.target.value; saveSettings(); render(); });
    $("fontSize").addEventListener("input", (e) => { settings.fs = +e.target.value; saveSettings(); applyFontSize(); });
    $("autoAdvance").addEventListener("change", (e) => { settings.autoAdvance = e.target.checked; saveSettings(); });
    $("reciterSel").addEventListener("change", (e) => {
      settings.reciter = e.target.value; saveSettings();
      if (playingKey && !audio.paused) playVerse(playingKey);
    });
    $("translationSel").addEventListener("change", (e) => { settings.translation = +e.target.value; saveSettings(); render(); });
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
  applyFontSize();
  initSettings();
  bindEvents();
  goTo(currentPage);

  if ("serviceWorker" in navigator && /^https:|^http:\/\/localhost/.test(location.href)) {
    navigator.serviceWorker.register("sw.js").catch(() => {});
  }
})();
