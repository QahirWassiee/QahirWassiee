# Mushaf Quran

A web app for reading the Quran page by page in the 604-page Madani Mushaf layout, with recitation, translation, bookmarks and search. It is plain HTML, CSS and JavaScript, with no build step.

## Features

- **Khatam home:**
  - progress toward completing the Quran, shown as a percentage, juz completed and verses completed
  - a Continue card that reopens the last reading position
  - a weekly reading streak
  - a log of recent activity
- **Two reading modes**, switched with the ⇄ button:
  - **Mushaf:** pages use the King Fahd Complex Madinah Mushaf lettering (QCF4, 1441H). Each page has the same 15 lines as the printed copy, with ornate ayah markers and surah banners, and the text is scaled so every line fills the page. On wide screens two pages show side by side like an open book.
  - **Verse by verse:** scrollable surah tabs, then one card per ayah with the Mushaf lettering, transliteration, translation, a Mark checkbox and a bookmark button.
- **Tracking what you've read:** tick verses as read, or mark a whole Mushaf page with the ✓ button. This feeds the khatam progress and the streak.
- **Ayah sheet:** tap any ayah to share, play, mark as read, bookmark or copy it.
- **Floating audio player:** 10 reciters, repeat-ayah, highlighting and auto-scroll for the ayah being recited, and the option to keep playing into the next page or surah.
- **Navigation:** a surah, juz and bookmark index; search by English or Arabic text, surah name, page number or a reference such as `2:255`; swipe and keyboard page turns; shareable links (`#p6` opens page 6 and `#s2:255` opens a verse).
- **Themes:** Light, Sepia and Night. Settings can also switch the script to plain Uthmani text in the Amiri font.
- **Installable PWA:** pages and surahs you have opened stay available offline. Progress, bookmarks and settings are saved in the browser.

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
- `app.js` – khatam tracking, Mushaf and verse-by-verse rendering, audio, search, bookmarks, settings
- `data.js` – surah, juz and reciter metadata
- `sw.js`, `manifest.webmanifest`, `icon.svg` – PWA support
