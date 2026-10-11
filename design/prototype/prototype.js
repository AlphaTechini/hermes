/* Hermes prototype runtime.
   Injects icons and the app shell (sidebar + top bar), and wires small behaviors:
   theme toggle, copy, reveal, mobile nav, onboarding steps, countdowns, landing animation.
   The shell markup below is the reference for the React <Sidebar> and <TopBar>. */
(function () {
  const ICONS = window.HERMES_ICONS || {};
  const svg = (name, cls = 'i') =>
    `<svg class="${cls}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICONS[name] || ''}</svg>`;

  const MARK = `<svg class="brand-mark" viewBox="0 0 22 22" aria-hidden="true">
    <rect width="22" height="22" rx="6" fill="var(--text)"/>
    <path d="M6.5 5.75v10.5M12.25 5.75v10.5M6.5 11h9.25M13.5 8.25 16.25 11l-2.75 2.75" fill="none" stroke="var(--canvas)" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"/>
  </svg>`;
  window.HERMES_MARK = MARK;

  /* Minimal JSON highlighter for <pre data-json>. Supports // comments and {{placeholders}}. */
  function esc(s) { return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); }
  function highlightJson(src) {
    return src.split('\n').map((line) => {
      let out = '', rest = line, comment = '';
      const ci = rest.indexOf('  //');
      if (ci >= 0) { comment = rest.slice(ci); rest = rest.slice(0, ci); }
      out = esc(rest).replace(/("(?:[^"\\]|\\.)*")(\s*:)?|(-?\b\d+(?:\.\d+)?\b)|\b(true|false|null)\b|([{}\[\],:])/g, (m, str, colon, num, lit, p) => {
        if (str) {
          const body = str.replace(/\{\{[^}]+\}\}/g, (v) => `<span class="v">${v}</span>`);
          return colon ? `<span class="k">${body}</span><span class="p">${colon}</span>` : `<span class="s">${body}</span>`;
        }
        if (num) return `<span class="n">${num}</span>`;
        if (lit) return `<span class="l">${lit}</span>`;
        return `<span class="p">${p}</span>`;
      });
      return out + (comment ? `<span class="c">${esc(comment)}</span>` : '');
    }).join('\n');
  }
  window.hermesJson = highlightJson;

  function hydrateIcons(root = document) {
    root.querySelectorAll('pre[data-json]').forEach((el) => { el.classList.add('hm-code'); el.innerHTML = highlightJson(el.textContent.replace(/^\n/, '')); });
    root.querySelectorAll('[data-i]').forEach((el) => {
      const name = el.getAttribute('data-i');
      if (el.tagName.toLowerCase() === 'svg') {
        el.setAttribute('viewBox', '0 0 24 24');
        el.setAttribute('fill', 'none');
        el.setAttribute('stroke', 'currentColor');
        el.setAttribute('stroke-linecap', 'round');
        el.setAttribute('stroke-linejoin', 'round');
        el.setAttribute('aria-hidden', 'true');
        if (!el.classList.length) el.classList.add('i');
        el.innerHTML = ICONS[name] || '';
      } else {
        el.outerHTML = svg(name, el.className || 'i');
      }
    });
    root.querySelectorAll('[data-mark]').forEach((el) => (el.outerHTML = MARK));
  }

  /* ---------- Sidebar ---------- */
  const NAV = [
    { id: 'live', label: 'Live', icon: 'activity', href: 'dashboard.html' },
    { id: 'strategies', label: 'Strategies', icon: 'webhook', href: 'strategies.html' },
    { id: 'approvals', label: 'Approvals', icon: 'hand', href: 'approvals.html', count: 2 },
    { id: 'limits', label: 'Risk limits', icon: 'shield', href: 'limits.html' },
    { id: 'report', label: 'Report card', icon: 'chart-column', href: 'report.html' },
  ];
  const NAV2 = [
    { id: 'setup', label: 'Wallet and keys', icon: 'key-round', href: 'onboarding.html?step=1' },
    { id: 'states', label: 'Components', icon: 'layers', href: 'states.html' },
  ];
  function navItem(n, active) {
    return `<a class="nav-item" href="${n.href}" ${n.id === active ? 'aria-current="page"' : ''} title="${n.label}">
      ${svg(n.icon)}<span>${n.label}</span>${n.count ? `<em class="nav-count">${n.count}</em><i class="dot-badge"></i>` : ''}</a>`;
  }
  function renderSidebar(el) {
    const active = el.getAttribute('data-active');
    el.innerHTML = `
      <div class="sb-head">
        <a class="brand" href="index.html">${MARK}<span class="brand-name">Hermes</span></a>
        <span class="env-tag">testnet</span>
      </div>
      <nav class="sb-nav" aria-label="Main">
        ${NAV.map((n) => navItem(n, active)).join('')}
        <div class="nav-label">Account</div>
        ${NAV2.map((n) => navItem(n, active)).join('')}
      </nav>
      <div class="sb-foot">
        <a class="account" href="onboarding.html?step=1" title="ifeoma@example.com">
          <span class="avatar">IO</span>
          <span class="account-text"><span class="e truncate">ifeoma@example.com</span><span class="w">0x7a3F…91c2</span></span>
        </a>
      </div>`;
  }

  /* ---------- Top bar ---------- */
  function renderTopbar(el) {
    const conn = el.getAttribute('data-conn') || 'ok';
    const connPill =
      conn === 'ok'
        ? `<button class="tb-item tb-conn" title="Trading socket: connected. Heartbeat 18,204. Market data: connected." style="order:1">
             <span class="hm-dot" data-tone="positive"></span><span class="v" style="font-family:var(--font-ui)">Perpl</span><span class="s">38 ms</span></button>`
        : `<button class="tb-item tb-conn" style="order:1;border-color:var(--warning-border)">
             <span class="hm-dot" data-tone="warning" data-live="true"></span><span class="v" style="font-family:var(--font-ui)">Reconnecting</span><span class="s">2/5</span></button>`;
    el.innerHTML = `
      <div class="tb-row1">
        <button class="btn btn-ghost btn-icon tb-menu" aria-label="Open navigation" data-nav-open style="order:0">${svg('menu')}</button>
        <a class="brand tb-brand" href="index.html" style="order:0">${MARK}</a>
        ${connPill}
        <div class="tb-right" style="order:3">
          <label class="toggle positive" title="Pause trading stops Hermes from sending any new order. Open positions stay open.">
            <span class="hide-sm">Trading</span>
            <input type="checkbox" checked aria-label="Trading on"><span class="track"></span>
          </label>
          <span class="vdiv hide-sm"></span>
          <button class="btn btn-ghost btn-icon btn-sm" data-theme-toggle aria-label="Switch theme">${svg('sun')}</button>
        </div>
      </div>
      <div class="tb-strip">
        <span class="vdiv tb-hide-sm" style="order:2"></span>
        <div class="tb-item tb-hide-sm tb-hide-md" style="order:2"><span class="l">Head</span><span class="v">41,822,907</span><span class="s">0.4s</span></div>
        <span class="vdiv tb-hide-md tb-hide-sm" style="order:2"></span>
        <div class="tb-item" style="order:2"><span class="l">Equity</span><span class="v">$10,482.16</span></div>
        <span class="vdiv" style="order:2"></span>
        <div class="tb-item" style="order:2"><span class="l">Today</span><span class="v neg">&minus;$137.20</span></div>
        <span class="vdiv" style="order:2"></span>
        <div class="tb-item" style="order:2" title="Daily loss stop: Hermes blocks new orders once today's loss reaches $500. Resets 00:00 UTC.">
          <span class="l">Loss stop</span>
          <span class="tb-stop"><span class="meter" data-tone="ok"><i style="width:27.4%"></i></span><span class="v">$137 <span class="s">/ $500</span></span></span>
        </div>
      </div>`;
  }

  /* ---------- Theme ---------- */
  function getTheme() {
    try { return localStorage.getItem('hermes-theme'); } catch (e) { return null; }
  }
  function setTheme(t) {
    document.documentElement.setAttribute('data-theme', t);
    try { localStorage.setItem('hermes-theme', t); } catch (e) {}
    document.querySelectorAll('[data-theme-toggle]').forEach((b) => (b.innerHTML = svg(t === 'light' ? 'moon' : 'sun')));
  }
  const params = new URLSearchParams(location.search);
  if (params.has('freeze')) document.documentElement.setAttribute('data-freeze', '');
  const urlTheme = params.get('theme');
  document.documentElement.setAttribute('data-theme', urlTheme || getTheme() || 'dark');

  /* ---------- Toast ---------- */
  function toast(title, body, tone = 'positive', icon = 'circle-check') {
    let stack = document.querySelector('.toasts');
    if (!stack) { stack = document.createElement('div'); stack.className = 'toasts'; stack.setAttribute('role', 'status'); document.body.appendChild(stack); }
    const t = document.createElement('div');
    t.className = `toast ${tone}`;
    t.innerHTML = `${svg(icon)}<div><div class="tt">${title}</div>${body ? `<div class="tb">${body}</div>` : ''}</div><button class="x" aria-label="Dismiss">${svg('x')}</button>`;
    t.querySelector('.x').onclick = () => t.remove();
    stack.appendChild(t);
    setTimeout(() => t.remove(), 4000);
  }
  window.hermesToast = toast;

  /* Pipeline markup helper. stages: [[state, ms], ...] x6, size: 'row' | 'lg' */
  const STAGES = ['Received', 'Verified', 'Checked', 'Sent', 'Accepted', 'Filled'];
  window.hermesPipe = function (stages, size = 'row', labels = false) {
    return `<div class="hm-pipe" data-size="${size}" role="img" aria-label="${stages.map((s, k) => STAGES[k] + ' ' + s[0]).join(', ')}">${stages
      .map((s, k) => `<div class="hm-pipe__stage" data-state="${s[0]}"><span class="hm-pipe__seg"></span>${labels ? `<span class="hm-pipe__label">${STAGES[k]}</span>` : ''}<span class="hm-pipe__ms">${s[1] ?? ''}</span></div>`)
      .join('')}</div>`;
  };
  window.hermesSvg = svg;

  document.addEventListener('DOMContentLoaded', () => {
    document.querySelectorAll('[data-shell="sidebar"]').forEach(renderSidebar);
    document.querySelectorAll('[data-shell="topbar"]').forEach(renderTopbar);
    hydrateIcons();
    setTheme(document.documentElement.getAttribute('data-theme'));

    document.addEventListener('click', (e) => {
      const tt = e.target.closest('[data-theme-toggle]');
      if (tt) setTheme(document.documentElement.getAttribute('data-theme') === 'light' ? 'dark' : 'light');

      if (e.target.closest('[data-nav-open]')) document.body.classList.add('nav-open');
      if (e.target.closest('.nav-scrim')) document.body.classList.remove('nav-open');

      const cp = e.target.closest('[data-copy]');
      if (cp) {
        const text = cp.getAttribute('data-copy');
        try { navigator.clipboard && navigator.clipboard.writeText(text); } catch (err) {}
        const prev = cp.innerHTML;
        cp.innerHTML = svg('check') + (cp.dataset.label ? `<span>Copied</span>` : '');
        setTimeout(() => (cp.innerHTML = prev), 1400);
      }

      const rv = e.target.closest('[data-reveal]');
      if (rv) {
        const target = document.getElementById(rv.getAttribute('data-reveal'));
        const shown = target.dataset.shown === 'true';
        target.textContent = shown ? target.dataset.masked : target.dataset.secret;
        target.dataset.shown = String(!shown);
        rv.innerHTML = svg(shown ? 'eye' : 'eye-off');
      }

      const tz = e.target.closest('[data-toast]');
      if (tz) {
        const [title, body, tone, icon] = tz.getAttribute('data-toast').split('|');
        toast(title, body, tone, icon);
      }

      const segBtn = e.target.closest('.seg button');
      if (segBtn) segBtn.parentElement.querySelectorAll('button').forEach((b) => b.setAttribute('aria-pressed', String(b === segBtn)));

      const tab = e.target.closest('.tabs .tab[data-tab]');
      if (tab) {
        const group = tab.closest('[data-tabs]');
        group.querySelectorAll('.tab').forEach((t) => t.setAttribute('aria-selected', String(t === tab)));
        group.querySelectorAll('[data-panel]').forEach((p) => (p.hidden = p.getAttribute('data-panel') !== tab.getAttribute('data-tab')));
      }
    });

    /* Onboarding steps: ?step=1..4 */
    const steps = document.querySelectorAll('[data-step]');
    if (steps.length) {
      const n = new URLSearchParams(location.search).get('step') || '2';
      steps.forEach((s) => (s.hidden = s.getAttribute('data-step') !== n));
      document.querySelectorAll('[data-stepper] [data-n]').forEach((li) => {
        const k = +li.getAttribute('data-n');
        li.setAttribute('data-state', k < +n ? 'done' : k === +n ? 'current' : 'upcoming');
      });
      const label = document.querySelector('[data-step-label]');
      if (label) label.textContent = `Step ${n} of 4`;
    }

    /* Countdowns (approvals): data-countdown="seconds" data-total="seconds" */
    const cds = document.querySelectorAll('[data-countdown]');
    if (cds.length && !document.documentElement.hasAttribute('data-freeze')) {
      setInterval(() => {
        cds.forEach((el) => {
          let s = Math.max(0, +el.getAttribute('data-countdown') - 1);
          el.setAttribute('data-countdown', s);
          const total = +el.getAttribute('data-total');
          const txt = el.querySelector('.cd-text');
          if (txt) txt.textContent = `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
          const bar = el.querySelector('.meter > i');
          if (bar) bar.style.width = `${(s / total) * 100}%`;
        });
      }, 1000);
    }

    /* Landing hero: replay the pipeline */
    const demo = document.querySelector('[data-demo-pipe]');
    if (demo && !document.documentElement.hasAttribute('data-freeze')) {
      const stages = [...demo.querySelectorAll('.hm-pipe__stage')];
      const ms = ['0 ms', '+4 ms', '+2 ms', '+11 ms', '+184 ms', '+411 ms'];
      const result = document.querySelector('[data-demo-result]');
      let i = 0;
      const tick = () => {
        stages.forEach((s, k) => {
          s.removeAttribute('data-animate');
          s.setAttribute('data-state', k < i ? (k === 5 ? 'final' : 'done') : k === i ? 'active' : 'pending');
          s.querySelector('.hm-pipe__ms').textContent = k < i ? ms[k] : k === i ? '…' : '';
          if (k === i - 1) s.setAttribute('data-animate', 'fill');
        });
        if (i === 6) stages[5].setAttribute('data-state', 'final');
        if (result) result.style.opacity = i === 6 ? '1' : '0.35';
        i = i === 6 ? 0 : i + 1;
        setTimeout(tick, i === 0 ? 2600 : i >= 5 ? 700 : 380);
      };
      tick();
    }
  });
})();
