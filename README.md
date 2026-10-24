# Mushaf Quran

A web app for reading the Quran page by page in the 604-page Madani Mushaf layout, with recitation, translation, bookmarks and search. It is plain HTML, CSS and JavaScript, with no build step.

## Features

- **Mushaf page view:** each page has 15 lines laid out as in the printed Madani Mushaf. Surah headers, the basmala, juz and surah running heads, and page numbers are included.
- **Two-page spread:** on wide screens the right (odd) and left pages show side by side, like an open book. Phones show one page at a time.
- **Navigation:**
  - an index of all 114 surahs and 30 juz
  - a box to go to a page
  - left/right arrows
  - keyboard shortcuts (`←`/`→`)
  - swipe gestures
  - shareable `#page` links
- **Recitation:** ayah-by-ayah audio from 10 reciters. The playing ayah is highlighted, the basmala plays before each surah, and playback can continue to the next page.
- **Tap an ayah:** shows its translation, with buttons to play from that ayah, bookmark it or copy it.
- **Translations:** any translation on quran.com, chosen in Settings.
- **Search:** English or Arabic text, surah names, page numbers, or verse references such as `2:255`.
- **Bookmarks and last read:** saved locally in the browser.
- **Themes:** Classic, Sepia and Night, plus a font-size slider. You can choose Uthmani text or the Madani QCF page glyphs.
- **Installable PWA:** pages you have opened stay available offline.

## Running locally

Serve the folder with any static file server, for example:

```sh
python3 -m http.server 8000
# open http://localhost:8000
```

Opening `index.html` directly also works, but the service worker (offline mode) needs `http://localhost` or HTTPS.

## Deploying

Upload the files to any static host (GitHub Pages, Netlify, Vercel, Cloudflare Pages). No server code is needed.

## Data sources

| What | Source |
| --- | --- |
| Quran text, line layout, translations | [Quran.com API v4](https://api-docs.quran.com/) |
| Text search | [AlQuran.cloud API](https://alquran.cloud/api) |
| Recitation audio | [EveryAyah.com](https://everyayah.com/) |
| Page glyph fonts (optional) | Quran.com CDN (KFGQPC QCF V2) |
| Fonts | Amiri / Amiri Quran (Google Fonts) |

Surah, juz and page metadata are built into `data.js`.

## Files

- `index.html` – page structure
- `styles.css` – layout and themes
- `app.js` – rendering, navigation, audio, search, bookmarks, settings
- `data.js` – surah, juz and reciter metadata
- `sw.js`, `manifest.webmanifest`, `icon.svg` – PWA support
