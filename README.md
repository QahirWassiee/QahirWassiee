# Mushaf Quran

A web app for reading the Quran page by page in the 604-page Madani Mushaf layout, with recitation, translation, bookmarks and search. It is plain HTML, CSS and JavaScript, with no build step.

## Features

The app has five tabs on a floating bottom bar:

- **Home:**
  - a السلام عليكم greeting
  - a **Continue reading** card that resumes where you left off
  - your **day streak**, **juz done** and **% completed**
  - a **daily verse** that changes each day
- **Quran:** a **Full Mushaf** shortcut, a surah filter, and a Surah / Juz / Bookmarks switch. Tapping a surah opens the verse-by-verse reader.
- **Mushaf:** a **Continue Reading** card for the printed-page view, and **Go to** a page, a juz or a surah (by number or name).
- **Saved:** your **Saved Ayahs** (with Arabic and translation) and your **Notes**.
- **Search:** English or Arabic text, surah names, page numbers, or a reference such as `2:255`.

Reading:

- **Mushaf reader:** a full-screen page in the King Fahd Complex Madinah Mushaf lettering (QCF4, 1441H), with the same 15 lines as the printed copy. Tap the page to show or hide the controls. Swipe or use the arrow keys to turn pages. On wide screens two pages show side by side.
- **Verse-by-verse reader:** surah tabs, then one card per ayah with the Mushaf lettering, transliteration, translation, a **Mark** checkbox and a bookmark button.
- **Ayah sheet:** tap any ayah to share, play, mark as read, bookmark, add a note, or copy it.
- **Audio:** 10 reciters, repeat-ayah, highlighting and auto-scroll for the ayah being recited, and the option to keep playing into the next page or surah.
- **Progress:** tick verses as read, or mark a whole Mushaf page with ✓. This feeds the streak, the juz count and the completion percentage.
- **Themes:** Light, Sepia and Night. Settings can also switch the script to plain Uthmani text, and change the translation and reciter.
- **Installable PWA:** pages and surahs you have opened stay available offline. Progress, bookmarks, notes and settings are saved in the browser.

Links: `#/home`, `#/quran`, `#/mushaf`, `#/saved` and `#/search` open a tab; `#p6` opens Mushaf page 6; `#s2:255` opens a verse.

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
| Mushaf page layout and glyph fonts | [quran-qcf4](https://github.com/MohamadHajjRabee/quran-qcf4), loaded from jsDelivr |
| Translations and Uthmani text | [Quran.com API v4](https://api-docs.quran.com/) |
| Text search | [AlQuran.cloud API](https://alquran.cloud/api) |
| Recitation audio | [EveryAyah.com](https://everyayah.com/) |
| UI fonts | Amiri / Amiri Quran / Inter (Google Fonts) |

Surah, juz and page metadata, and the first verse on each page, are built into `data.js`.

The QCF4 Mushaf fonts are © King Fahd Glorious Qur'an Printing Complex and are not open source. They are loaded at runtime from the published npm package and are deliberately not copied into this repository.

## Files

- `index.html` – page structure
- `styles.css` – layout and themes
- `app.js` – tabs and routing, reading progress, Mushaf and verse-by-verse rendering, audio, search, bookmarks, notes, settings
- `data.js` – surah, juz and reciter metadata
- `sw.js`, `manifest.webmanifest`, `icon.svg` – PWA support
