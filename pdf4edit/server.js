'use strict';
const path = require('node:path');
const express = require('express');
const cookieParser = require('cookie-parser');
const multer = require('multer');
const db = require('./lib/db');
const { exportEdited, exportFillable, exportDocx } = require('./lib/exporter');

const PORT = Number(process.env.PORT) || 3000;
const PROD = process.env.NODE_ENV === 'production';
const BASE_URL = (process.env.BASE_URL || `http://localhost:${PORT}`).replace(/\/$/, '');
const STRIPE_KEY = process.env.STRIPE_SECRET_KEY || '';
const STRIPE_PRICE = process.env.STRIPE_PRICE_ID || '';
const WEBHOOK_SECRET = process.env.STRIPE_WEBHOOK_SECRET || '';
const stripe = STRIPE_KEY ? require('stripe')(STRIPE_KEY) : null;
// Without Stripe keys (local development) subscribing is simulated so the
// whole flow can be tried. Production refuses to run that way.
const DEMO_BILLING = !stripe;
if (PROD && DEMO_BILLING) {
  console.error('STRIPE_SECRET_KEY must be set in production.');
  process.exit(1);
}

const COOKIE = 'p4e_session';
const ACTIVE = new Set(['active', 'trialing']);
const MAX_MB = 50;

const app = express();
app.disable('x-powered-by');
app.set('trust proxy', 1);

app.use((req, res, next) => {
  res.set({
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'same-origin',
    'X-Frame-Options': 'DENY',
  });
  next();
});

// Stripe needs the raw body to verify the signature, so this route comes
// before the JSON parser.
app.post('/api/stripe/webhook', express.raw({ type: 'application/json' }), async (req, res) => {
  if (!stripe || !WEBHOOK_SECRET) return res.status(400).send('Webhooks not configured');
  let event;
  try {
    event = stripe.webhooks.constructEvent(req.body, req.headers['stripe-signature'], WEBHOOK_SECRET);
  } catch (err) {
    return res.status(400).send(`Bad signature: ${err.message}`);
  }
  try {
    const obj = event.data.object;
    if (event.type === 'checkout.session.completed') {
      await syncCheckout(obj);
    } else if (event.type.startsWith('customer.subscription.')) {
      const user = db.findUserByCustomer(obj.customer);
      if (user) applySubscription(user.id, obj);
    }
    res.json({ received: true });
  } catch (err) {
    console.error('webhook', err);
    res.status(500).send('Webhook handler failed');
  }
});

app.use(express.json({ limit: '1mb' }));
app.use(cookieParser());

// Cross-site requests may not change state.
app.use((req, res, next) => {
  if (req.method === 'GET' || req.method === 'HEAD') return next();
  const origin = req.get('origin');
  let host = null;
  try { host = origin && new URL(origin).host; } catch { host = 'invalid'; }
  if (origin && host !== req.get('host')) return res.status(403).json({ error: 'Bad origin' });
  next();
});

app.use((req, res, next) => {
  req.user = db.userForSession(req.cookies[COOKIE]);
  next();
});

function publicUser(u) {
  if (!u) return null;
  return {
    email: u.email,
    subscribed: ACTIVE.has(u.subscription_status),
    status: u.subscription_status,
    renews: u.current_period_end,
    hasBilling: !!u.stripe_customer_id && !DEMO_BILLING,
  };
}

function signIn(res, user) {
  res.cookie(COOKIE, db.createSession(user.id), {
    httpOnly: true, sameSite: 'lax', secure: PROD, maxAge: db.SESSION_DAYS * 864e5, path: '/',
  });
}

function requireUser(req, res, next) {
  if (!req.user) return res.status(401).json({ error: 'Please sign in first.' });
  next();
}

function requireSubscription(req, res, next) {
  if (!req.user) return res.status(401).json({ error: 'Please sign in first.', code: 'auth' });
  if (!ACTIVE.has(req.user.subscription_status)) {
    return res.status(402).json({ error: 'An active subscription is needed to download.', code: 'subscribe' });
  }
  next();
}

// Small in-memory limiter for the auth endpoints.
const attempts = new Map();
function limit(req, res, next) {
  const key = req.ip;
  const now = Date.now();
  const rec = attempts.get(key) || { n: 0, t: now };
  if (now - rec.t > 15 * 60e3) { rec.n = 0; rec.t = now; }
  rec.n += 1;
  attempts.set(key, rec);
  if (rec.n > 30) return res.status(429).json({ error: 'Too many attempts. Try again in a few minutes.' });
  next();
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

app.post('/api/signup', limit, (req, res) => {
  const email = String(req.body.email || '').trim().toLowerCase();
  const password = String(req.body.password || '');
  if (!EMAIL_RE.test(email) || email.length > 254) return res.status(400).json({ error: 'Enter a valid email address.' });
  if (password.length < 8) return res.status(400).json({ error: 'Use a password of at least 8 characters.' });
  if (db.findUserByEmail(email)) return res.status(409).json({ error: 'That email already has an account. Sign in instead.' });
  const user = db.createUser(email, password);
  signIn(res, user);
  res.json({ user: publicUser(user) });
});

app.post('/api/login', limit, (req, res) => {
  const email = String(req.body.email || '').trim().toLowerCase();
  const user = db.findUserByEmail(email);
  if (!user || !db.verifyPassword(String(req.body.password || ''), user.password_hash)) {
    return res.status(401).json({ error: 'Wrong email or password.' });
  }
  signIn(res, user);
  res.json({ user: publicUser(user) });
});

app.post('/api/logout', (req, res) => {
  db.deleteSession(req.cookies[COOKIE]);
  res.clearCookie(COOKIE, { path: '/' });
  res.json({ ok: true });
});

app.get('/api/me', (req, res) => {
  res.json({ user: publicUser(req.user), demoBilling: DEMO_BILLING, price: '4.99' });
});

// ---- Billing -------------------------------------------------------------

function applySubscription(userId, sub) {
  const end = sub.current_period_end || sub.items?.data?.[0]?.current_period_end || null;
  db.setSubscription(userId, sub.id, sub.status, end ? end * 1000 : null);
}

async function syncCheckout(session) {
  const userId = Number(session.client_reference_id);
  const user = userId && db.findUserById(userId);
  if (!user) return null;
  if (session.customer) db.setCustomer(user.id, session.customer);
  if (session.subscription) {
    const sub = typeof session.subscription === 'string'
      ? await stripe.subscriptions.retrieve(session.subscription)
      : session.subscription;
    applySubscription(user.id, sub);
  }
  return db.findUserById(user.id);
}

app.post('/api/billing/checkout', requireUser, async (req, res) => {
  if (ACTIVE.has(req.user.subscription_status)) return res.json({ url: '/app.html' });
  if (DEMO_BILLING) {
    db.setSubscription(req.user.id, 'demo', 'active', Date.now() + 30 * 864e5);
    return res.json({ url: '/app.html?subscribed=1' });
  }
  try {
    const session = await stripe.checkout.sessions.create({
      mode: 'subscription',
      line_items: [STRIPE_PRICE
        ? { price: STRIPE_PRICE, quantity: 1 }
        : {
          quantity: 1,
          price_data: {
            currency: 'usd',
            unit_amount: 499,
            recurring: { interval: 'month' },
            product_data: { name: 'PDF 4 Edit Unlimited' },
          },
        }],
      client_reference_id: String(req.user.id),
      ...(req.user.stripe_customer_id
        ? { customer: req.user.stripe_customer_id }
        : { customer_email: req.user.email }),
      allow_promotion_codes: true,
      success_url: `${BASE_URL}/app.html?checkout={CHECKOUT_SESSION_ID}`,
      cancel_url: `${BASE_URL}/#pricing`,
    });
    res.json({ url: session.url });
  } catch (err) {
    console.error('checkout', err);
    res.status(502).json({ error: 'Could not start checkout. Please try again.' });
  }
});

// Called when Stripe sends the customer back, so access starts immediately
// even if the webhook is still on its way.
app.post('/api/billing/confirm', requireUser, async (req, res) => {
  if (DEMO_BILLING) return res.json({ user: publicUser(req.user) });
  try {
    const session = await stripe.checkout.sessions.retrieve(String(req.body.sessionId || ''));
    if (String(session.client_reference_id) !== String(req.user.id)) return res.status(403).json({ error: 'Not your checkout.' });
    const user = await syncCheckout(session);
    res.json({ user: publicUser(user) });
  } catch (err) {
    console.error('confirm', err);
    res.status(400).json({ error: 'Could not confirm payment.' });
  }
});

app.post('/api/billing/portal', requireUser, async (req, res) => {
  if (DEMO_BILLING) {
    db.setSubscription(req.user.id, null, 'canceled', null);
    return res.json({ url: '/app.html' });
  }
  if (!req.user.stripe_customer_id) return res.status(400).json({ error: 'No billing account yet.' });
  try {
    const portal = await stripe.billingPortal.sessions.create({
      customer: req.user.stripe_customer_id,
      return_url: `${BASE_URL}/app.html`,
    });
    res.json({ url: portal.url });
  } catch (err) {
    console.error('portal', err);
    res.status(502).json({ error: 'Could not open billing.' });
  }
});

// ---- Exports -------------------------------------------------------------
// Files are processed in memory and never written to disk or kept.

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: MAX_MB * 1024 * 1024, files: 400 } });

function parseJSON(s) {
  try { return JSON.parse(s || '{}'); } catch { return null; }
}

function sendFile(res, bytes, name, type) {
  res.set({
    'Content-Type': type,
    'Content-Disposition': `attachment; filename="${name.replace(/[^\w.\- ]+/g, '_')}"`,
    'Cache-Control': 'no-store',
  });
  res.send(Buffer.from(bytes));
}

function baseName(req) {
  const n = String(req.body.name || 'document').replace(/\.pdf$/i, '').slice(0, 80);
  return n || 'document';
}

function exportError(res, err) {
  console.error('export', err);
  const msg = err.code === 'password'
    ? 'This PDF is password-protected and could not be unlocked.'
    : 'Could not create the file from this PDF.';
  res.status(422).json({ error: msg });
}

app.post('/api/export/pdf', requireSubscription, upload.single('file'), async (req, res) => {
  const edits = parseJSON(req.body.edits);
  if (!req.file || !edits) return res.status(400).json({ error: 'Missing file or edits.' });
  try {
    sendFile(res, await exportEdited(req.file.buffer, edits, req.body.password), `${baseName(req)}-edited.pdf`, 'application/pdf');
  } catch (err) { exportError(res, err); }
});

app.post('/api/export/fillable', requireSubscription, upload.single('file'), async (req, res) => {
  const data = parseJSON(req.body.data);
  if (!req.file || !data) return res.status(400).json({ error: 'Missing file or data.' });
  try {
    sendFile(res, await exportFillable(req.file.buffer, data, req.body.password), `${baseName(req)}-editable.pdf`, 'application/pdf');
  } catch (err) { exportError(res, err); }
});

app.post('/api/export/docx', requireSubscription, upload.any(), async (req, res) => {
  const layout = parseJSON(req.body.layout);
  if (!layout || !Array.isArray(layout.pages)) return res.status(400).json({ error: 'Missing layout.' });
  const images = new Map((req.files || []).map((f) => [f.fieldname, f.buffer]));
  try {
    const pages = layout.pages.map((p, i) => ({ ...p, image: images.get(`page${i}`) }));
    const buf = await exportDocx({ pages });
    sendFile(res, buf, `${baseName(req)}.docx`, 'application/vnd.openxmlformats-officedocument.wordprocessingml.document');
  } catch (err) { exportError(res, err); }
});

// ---- Static --------------------------------------------------------------

app.use('/vendor/pdfjs', express.static(path.join(__dirname, 'node_modules', 'pdfjs-dist', 'build'), { maxAge: '7d' }));
app.use('/vendor/pdfjs-cmaps', express.static(path.join(__dirname, 'node_modules', 'pdfjs-dist', 'cmaps'), { maxAge: '7d' }));
app.use('/vendor/pdfjs-fonts', express.static(path.join(__dirname, 'node_modules', 'pdfjs-dist', 'standard_fonts'), { maxAge: '7d' }));
app.use(express.static(path.join(__dirname, 'public'), { extensions: ['html'] }));

app.use((err, req, res, next) => {
  if (err instanceof multer.MulterError) {
    return res.status(413).json({ error: err.code === 'LIMIT_FILE_SIZE' ? `Files up to ${MAX_MB} MB are supported.` : err.message });
  }
  console.error(err);
  res.status(500).json({ error: 'Something went wrong.' });
});

setInterval(() => db.purgeSessions(), 6 * 3600e3).unref();

if (require.main === module) {
  app.listen(PORT, () => {
    console.log(`PDF 4 Edit running at ${BASE_URL}${DEMO_BILLING ? ' (demo billing: no Stripe keys set)' : ''}`);
  });
}

module.exports = app;
