# PDF 4 Edit

Upload a PDF, click any word, number or sentence and change it. Nothing else on the page moves. Download the result as a PDF, a Word document or a fillable PDF. One plan: **$4.99/month, unlimited**.

## Why layouts don't shift

Most PDF editors convert the page into their own editable format and then rebuild it, and that's where text jumps around. PDF 4 Edit never rebuilds the page:

1. The original page is shown exactly as it is (rendered with PDF.js).
2. Every text run is mapped to its exact baseline, size, rotation and width.
3. When you change a run, the export keeps the original page content as it is and adds two things on top: a patch in the paper colour sampled from behind the old text, and the new text drawn with the original text matrix, stretched to the same character width as the original font.
4. Numbers are anchored on the right by default, so a longer figure in a right-aligned column stays aligned. You can switch any run between left and right anchoring.

Anything you don't edit comes out byte-for-byte the same. `npm test` checks this by rendering the original and the export and comparing pixels: with no edits nothing differs, and with an edit only the pixels on that line change.

## Features

- Edit text: click any run and type. Tab or Enter moves to the next run. You can change the font (sans, serif or mono), bold, italic, size, colour and anchoring.
- Add text anywhere on the page.
- Erase: drag a box over anything (stamps, lines, scans) and it's painted over in the surrounding colour.
- Exports:
  - **PDF**: the original with your edits applied.
  - **Word (.docx)**: each page's graphics as a background, with every line as real, positioned Word text.
  - **Editable PDF**: every text run becomes a form field that can be edited in any PDF reader.
- PDFs that are encrypted with only an editing restriction are unlocked automatically. Password-protected PDFs ask for their password.
- Work is saved in the browser (IndexedDB), so a refresh or the trip to Stripe checkout loses nothing. After paying, the download you asked for starts automatically.
- Privacy: files are edited in the browser. They're sent to the server only to build a download, processed in memory and never stored.

## Run it locally

Requires Node.js 22.13 or later (it uses the built-in `node:sqlite`).

```bash
cd pdf4edit
npm install
npm start          # http://localhost:3000
npm test
```

Without Stripe keys the server runs in **demo billing** mode: clicking Subscribe activates a test subscription straight away, so you can try the whole flow. Production refuses to start without a key.

## Going live

1. Create a [Stripe](https://dashboard.stripe.com) account. Optionally, create a product with a $4.99/month recurring price and copy its `price_...` id.
2. Add a webhook endpoint at `https://YOUR-SITE/api/stripe/webhook` for `checkout.session.completed` and `customer.subscription.created/updated/deleted`, and copy the signing secret.
3. Turn on the [customer portal](https://dashboard.stripe.com/settings/billing/portal) so subscribers can cancel themselves.
4. Deploy to any Node host (Render, Railway, Fly.io, a VPS) with the variables from `.env.example` set and `DATABASE_FILE` on a persistent disk. Serve it over HTTPS.
5. Have the placeholder Terms and Privacy pages (`public/terms.html`, `public/privacy.html`) reviewed before launch.

## Layout

```
server.js            Express app: accounts, Stripe billing, export endpoints, static files
lib/exporter.js      Applies edits to PDFs (pdf-lib) and builds .docx files (docx)
lib/db.js            SQLite users and sessions (scrypt password hashes)
public/index.html    Landing page and pricing
public/app.html      Editor
public/js/editor.js  PDF rendering, text mapping, editing tools, exports
public/js/common.js  Sign-in and subscribe dialogs
test/                Export tests and a sample PDF
```

## Known limits

- Replacement text uses the standard PDF fonts (Helvetica, Times or Courier), stretched to match the original's width. For documents in Arial, Helvetica or Times, the match is very close. For unusual brand fonts, an edited word can look slightly different from the text around it. Text you don't edit is never affected.
- Standard fonts cover Western European characters. Other scripts, such as Arabic or Chinese, show up as `?` in edited runs.
- Scanned pages have no text layer to click. Use Erase, then Add text.
- The original words are hidden under the patch rather than removed from the file, which is the same approach most PDF editors take.
