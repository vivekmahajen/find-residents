// Login widget — posts to the existing cookie-session endpoint, refreshes the
// store, then routes to the intended (or default) view.
export default {
  title: 'Log in',
  requiresAuth: false,
  mount(el, ctx) {
    el.innerHTML = `
      <div class="panel auth-inline">
        <h1>Log in</h1>
        <p class="auth-msg" id="lm" aria-live="polite"></p>
        <form id="lf" class="auth-form" autocomplete="on">
          <label for="li">User ID or email</label>
          <input id="li" type="text" autocomplete="username" required />
          <label for="lp">Password</label>
          <input id="lp" type="password" autocomplete="current-password" required />
          <button class="primary-btn full" type="submit">Log in</button>
        </form>
        <p class="muted">No account yet? <a href="/">Create one or reset your password</a>.</p>
      </div>`;
    const form = el.querySelector('#lf');
    const msg = el.querySelector('#lm');
    async function onSubmit(e) {
      e.preventDefault();
      msg.textContent = 'Signing in…';
      msg.className = 'auth-msg';
      try {
        const r = await fetch('/api/auth/login', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ identifier: el.querySelector('#li').value.trim(), password: el.querySelector('#lp').value }),
        });
        const d = await r.json().catch(() => ({}));
        if (!r.ok) { msg.textContent = d.error || 'Sign in failed.'; msg.className = 'auth-msg error'; return; }
        await ctx.refreshSession();
        const next = sessionStorage.getItem('shell:next');
        sessionStorage.removeItem('shell:next');
        ctx.navigate(next || 'home', { replace: true });
      } catch {
        msg.textContent = 'Network error — try again.';
        msg.className = 'auth-msg error';
      }
    }
    form.addEventListener('submit', onSubmit);
    return () => form.removeEventListener('submit', onSubmit);
  },
};
