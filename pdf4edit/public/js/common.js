// Shared by every page: account state, sign-in and subscribe dialogs, toasts.

export async function api(path, body) {
  const res = await fetch(path, {
    method: body === undefined ? 'GET' : 'POST',
    headers: body === undefined ? {} : { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
    credentials: 'same-origin',
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw Object.assign(new Error(data.error || 'Request failed'), { status: res.status, code: data.code });
  return data;
}

let meCache = null;
export async function me(refresh = false) {
  if (!meCache || refresh) meCache = await api('/api/me');
  return meCache;
}

let toastTimer;
export function toast(msg, isError = false) {
  let el = document.querySelector('.toast');
  if (!el) {
    el = document.createElement('div');
    el.className = 'toast';
    el.setAttribute('role', 'status');
    document.body.append(el);
  }
  el.textContent = msg;
  el.classList.toggle('error', isError);
  el.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('show'), 3800);
}

const MODALS = `
<div class="modal" id="auth-modal" role="dialog" aria-modal="true" aria-labelledby="auth-title">
  <form class="panel" novalidate>
    <button type="button" class="btn ghost x" data-close aria-label="Close">✕</button>
    <h2 id="auth-title">Create your account</h2>
    <p class="muted" data-sub>Your documents stay in your browser while you edit.</p>
    <label class="field"><span>Email</span><input type="email" name="email" autocomplete="email" required></label>
    <label class="field"><span>Password</span><input type="password" name="password" autocomplete="new-password" minlength="8" required></label>
    <p class="form-error" aria-live="polite"></p>
    <button class="btn primary big" style="width:100%" type="submit">Create account</button>
    <p class="switch"><span data-q>Already have an account?</span> <button type="button" data-switch>Sign in</button></p>
  </form>
</div>
<div class="modal" id="sub-modal" role="dialog" aria-modal="true" aria-labelledby="sub-title">
  <div class="panel">
    <button type="button" class="btn ghost x" data-close aria-label="Close">✕</button>
    <h2 id="sub-title">Unlock unlimited downloads</h2>
    <p class="muted">Edit and export as many PDFs as you like.</p>
    <div class="price-line"><b>$4.99</b><span>/ month · cancel anytime</span></div>
    <p class="form-error" aria-live="polite"></p>
    <button class="btn primary big" style="width:100%" data-checkout>Subscribe for $4.99/month</button>
    <p class="switch" data-demo hidden>Demo mode: no Stripe keys are configured, so this activates a test subscription.</p>
  </div>
</div>`;

function ensureModals() {
  if (document.getElementById('auth-modal')) return;
  document.body.insertAdjacentHTML('beforeend', MODALS);
  document.querySelectorAll('.modal').forEach((m) => {
    m.addEventListener('click', (e) => {
      if (e.target === m || e.target.closest('[data-close]')) close(m, null);
    });
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') document.querySelectorAll('.modal.open').forEach((m) => close(m, null));
  });
}

const resolvers = new WeakMap();
function open(m) {
  m.classList.add('open');
  return new Promise((r) => resolvers.set(m, r));
}
function close(m, value) {
  m.classList.remove('open');
  const r = resolvers.get(m);
  resolvers.delete(m);
  if (r) r(value);
}

// Resolves with the signed-in user, or null if the dialog was dismissed.
export async function signIn(mode = 'signup') {
  ensureModals();
  const m = document.getElementById('auth-modal');
  const form = m.querySelector('form');
  const err = m.querySelector('.form-error');
  const set = (md) => {
    mode = md;
    const up = md === 'signup';
    m.querySelector('h2').textContent = up ? 'Create your account' : 'Welcome back';
    form.querySelector('[type=submit]').textContent = up ? 'Create account' : 'Sign in';
    m.querySelector('[data-q]').textContent = up ? 'Already have an account?' : 'New to PDF 4 Edit?';
    m.querySelector('[data-switch]').textContent = up ? 'Sign in' : 'Create an account';
    form.password.autocomplete = up ? 'new-password' : 'current-password';
    err.textContent = '';
  };
  set(mode);
  m.querySelector('[data-switch]').onclick = () => set(mode === 'signup' ? 'login' : 'signup');
  form.onsubmit = async (e) => {
    e.preventDefault();
    err.textContent = '';
    const btn = form.querySelector('[type=submit]');
    btn.disabled = true;
    try {
      const { user } = await api(mode === 'signup' ? '/api/signup' : '/api/login', {
        email: form.email.value, password: form.password.value,
      });
      await me(true);
      form.reset();
      close(m, user);
    } catch (ex) {
      err.textContent = ex.message;
    } finally {
      btn.disabled = false;
    }
  };
  const p = open(m);
  setTimeout(() => form.email.focus(), 30);
  return p;
}

// Sends the user to checkout. Calls beforeRedirect first so callers can
// save work that would otherwise be lost on navigation.
export async function subscribe(beforeRedirect) {
  ensureModals();
  let info = await me();
  if (!info.user) {
    if (!(await signIn('signup'))) return false;
    info = await me(true);
  }
  if (info.user.subscribed) return true;
  const m = document.getElementById('sub-modal');
  m.querySelector('[data-demo]').hidden = !info.demoBilling;
  const err = m.querySelector('.form-error');
  err.textContent = '';
  const btn = m.querySelector('[data-checkout]');
  btn.onclick = async () => {
    btn.disabled = true;
    try {
      const { url } = await api('/api/billing/checkout', {});
      if (beforeRedirect) await beforeRedirect();
      location.href = url;
    } catch (ex) {
      err.textContent = ex.message;
      btn.disabled = false;
    }
  };
  btn.disabled = false;
  open(m);
  return false;
}

export async function signOut() {
  await api('/api/logout', {});
  await me(true);
}
