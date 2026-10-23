// The "Picodev Lab" view: lays out what the extension sends (every string already translated), in tabs as the
// Claude Code plugin's Lab pane. Text goes in with textContent only; a press sends {type, arg} and the extension
// checks both.
(() => {
  const vscode = acquireVsCodeApi();
  // tab: the one last picked (none yet: Défi when a challenge is open, else Session); shut: the sections folded
  const st = Object.assign({ shut: {}, hints: 0, hintLevel: '' }, vscode.getState());
  delete st.open; // the folds of 0.1.2 and before: every section was folded by default then
  const save = () => vscode.setState(st);
  let L = {};
  let M = null;
  let IMG = {}; // data: URIs of the schema and the chart, sent apart from the model
  let last = '';

  const send = (type, arg) => vscode.postMessage({ type, arg });
  const str = (v) => (v == null ? '' : String(v));
  const fmt = (s, ...a) => str(s).replace(/\{(\d)\}/g, (_, i) => str(a[i]));
  const h = (tag, props, ...kids) => {
    const e = document.createElement(tag);
    for (const [k, v] of Object.entries(props || {})) {
      if (k === 'on') e.addEventListener('click', (ev) => { ev.preventDefault(); v(); });
      else if (v != null && v !== false) e.setAttribute(k, v);
    }
    for (const k of kids.flat(Infinity)) if (k != null && k !== false && k !== '') e.append(k instanceof Node ? k : str(k));
    return e;
  };
  const btn = (label, type, arg, main, title) => h('button', { class: main ? 'main' : null, title, on: () => send(type, arg) }, label);
  const link = (label, type, arg) => h('a', { href: '#', on: () => send(type, arg) }, label);
  const row = (k, v, help) => h('div', { class: 'row', title: help }, h('span', { class: 'subtle' }, k), h('span', {}, v));

  const section = (id, title, body, { badge, badgeClass = '', closedBadge } = {}) => {
    const d = h('details', { id },
      h('summary', {}, h('span', { class: 'head' }, title),
        badge && h('span', { class: `badge ${badgeClass}` }, badge),
        closedBadge && h('span', { class: 'badge closed-only' }, closedBadge)),
      h('div', { class: 'body' }, body));
    d.open = !st.shut[id];
    d.addEventListener('toggle', () => {
      st.shut[id] = !d.open;
      save();
    });
    return d;
  };

  const MARKS = { done: '✓', current: '●', todo: '○' };
  const img = (src, alt) => typeof src === 'string' && src.startsWith('data:image/') && h('img', { src, alt, title: alt });

  const MARK = { passed: '✓', failed: '✗' };

  function build() {
    const m = M || {};
    const tab = { session: [], project: [] }; // a tab left out has nothing to show
    const s = m.session;
    if (!s) {
      // the three parts, each with its button
      tab.session.push(h('div', { class: 'empty' }, h('p', {}, L.noSession),
        h('ol', { class: 'need' },
          h('li', {}, L.need1, h('div', { class: 'actions' }, !m.folder && btn(L.openFolder, 'openFolder'), btn(L.starter, 'starter'))),
          h('li', {}, L.need2),
          h('li', {}, L.need3)),
        h('div', { class: 'actions' }, btn(L.openChallenge, 'challenge', null, true), btn(L.openSession, 'open')),
        h('p', {}, link(L.getStarted, 'walkthrough'))));
    } else {
      tab.session.push(section('session', L.session, [
        row(L.setup, s.setup, L.setupHelp),
        row(L.mode, s.mode),
        row(L.browser, h('span', { class: s.browser ? 'ok' : 'subtle' }, (s.browser ? '● ' : '○ ') + str(s.browserText)), L.benchHelp),
        row(L.ends, s.end),
        h('div', { class: 'subtle label' }, L.visibility),
        h('div', { class: 'seg', role: 'group', title: L.visHint, 'aria-label': L.visibility },
          ['private', 'link', 'public'].map((v) => h('button', {
            class: v === s.visibility ? 'on' : null, 'aria-pressed': String(v === s.visibility),
            on: () => v !== s.visibility && send('visibility', v),
          }, L[v]))),
        h('div', { class: 'row', title: L.viewersHelp }, h('span', { class: 'subtle' }, s.viewers), s.viewerUrl && link(L.copyLink, 'copy', 'viewer')),
        m.sim && m.sim.ok !== null && row(L.compilation, h('span', { class: m.sim.ok ? 'ok' : 'ko' }, m.sim.compile, m.sim.origin && ` · ${m.sim.origin}`)),
        m.sim && m.sim.log && [h('pre', {}, m.sim.log), h('div', { class: 'actions' }, btn(L.fix, 'fix'), btn(L.showLog, 'log'))],
        s.circuit && h('p', { class: 'warn' }, s.circuit),
        s.circuitError && h('p', { class: 'ko' }, s.circuitError),
        h('div', { class: 'actions' }, btn(L.openBench, 'openBench', null, m.main === 'openBench', L.benchHelp),
          btn(L.copilot, 'copilot', null, m.main === 'copilot'),
          s.free && btn(L.push, 'push', null, m.main === 'push', L.pushHelp)),
        h('div', { class: 'actions' }, btn(L.panel, 'panel'), btn(L.end, 'end')),
      ], { closedBadge: s.short }));
    }

    const su = m.setup;
    if (s && su) {
      const parts = Array.isArray(su.parts) ? su.parts : [];
      const probes = Array.isArray(su.probes) ? su.probes : [];
      tab.session.push(section('setup', L.setup, [
        h('p', { class: 'title' }, su.title),
        h('p', { class: 'subtle' }, L.setupHelp),
        img(IMG.schema, L.schemaAlt),
        h('div', { class: 'subtle label' }, L.parts),
        h('ul', { class: 'parts' }, parts.map((p) => h('li', {}, h('code', {}, p.id), ' ', h('span', { class: 'subtle' }, p.type), p.props && [' ', h('span', { class: 'detail' }, p.props)]))),
        probes.length > 0 && [h('div', { class: 'subtle label' }, L.probes), h('p', { class: 'subtle' }, L.probesHelp),
          h('ul', { class: 'parts' }, probes.map((p) => h('li', {}, h('code', {}, p.label), ' ', h('span', { class: 'subtle' }, p.kind))))],
      ], { closedBadge: String(parts.length) }));
    }

    const c = m.challenge;
    if (c) {
      if (st.hintLevel !== c.head) Object.assign(st, { hints: 0, hintLevel: c.head }), save();
      const hints = Array.isArray(c.hints) ? c.hints : [];
      tab.challenge = [section('challenge', c.head, [
        c.waiting && h('p', { class: 'subtle' }, L.waiting),
        c.title && h('p', { class: 'title' }, c.title),
        c.brief && h('p', { class: 'muted' }, c.brief),
        h('ul', { class: 'tests' }, (Array.isArray(c.tests) ? c.tests : []).map((t) =>
          h('li', { class: MARK[t.s] ? t.s : 'pending' }, h('span', { class: 'mark' }, MARK[t.s] || '…'), h('code', {}, t.id), t.detail && h('span', { class: 'detail' }, t.detail)))),
        c.done && h('p', { class: 'subtle' }, c.done),
        c.next === 'last' && h('p', { class: 'subtle' }, L.lastPassed, ' ', link(L.openBench, 'openBench')),
        hints.slice(0, st.hints).map((x, i) => h('p', { class: 'muted' }, fmt(L.hintN, i + 1, x))),
        h('div', { class: 'actions' }, c.next === 'next' && btn(L.nextLevel, 'next', null, m.main === 'next'),
          btn(L.pushTest, 'push', null, m.main === 'push', L.pushHelp),
          st.hints < hints.length && h('button', { on: () => { st.hints++; save(); render(); } }, fmt(L.hint, st.hints + 1, hints.length))),
      ], { badge: c.passed && L.passed, badgeClass: 'passed' })];
    }

    // the real bench (contract 0.20): the setup's offers, the session's place or turn; the video is in the bench and the Lab panel
    const b = m.bench;
    if (b) {
      const offers = Array.isArray(b.offers) ? b.offers : [];
      tab.bench = [section('bench', L.realBench, [
        h('p', { class: 'subtle' }, L.realBenchHelp),
        b.state && h('p', { class: b.turn ? 'title' : null }, b.state),
        b.turn && h('div', { class: 'actions' }, btn(L.openBench, 'openBench', null, m.main === 'openBench', L.benchHelp), btn(L.camera, 'panel')),
        b.queued && h('div', { class: 'actions' }, btn(b.turn ? L.giveBack : L.leave, 'queueLeave')),
        h('div', { class: 'subtle label' }, L.offers),
        offers.length ? h('ul', { class: 'parts' }, offers.map((o) => h('li', {}, h('code', {}, o.kind), ' ', h('span', { class: 'subtle' }, o.text),
          !b.queued && !o.soon && [' ', link(L.join, 'queueJoin', o.kind)])))
          : h('p', { class: 'subtle' }, L.noOffer),
      ])];
    }

    const sh = m.share;
    if (sh) {
      tab.share = [section('share', L.share, [
        h('p', { class: 'subtle' }, sh.summary),
        h('blockquote', {}, sh.text),
        h('div', { class: 'actions' }, btn('LinkedIn', 'link', 'linkedin'), btn('X', 'link', 'x'), btn(L.copyLink, 'copy', 'share')),
        h('code', { class: 'url' }, sh.link),
      ])];
    }

    // the Project tab, as the Claude Code plugin's: what the spec is, its sections, then sending it
    const pr = m.project || {};
    const secs = Array.isArray(pr.sections) ? pr.sections : [];
    tab.project.push(
      section('about', L.project, [h('p', { class: 'muted' }, L.projectText), h('p', { class: 'subtle' }, L.projectKeep)]),
      section('spec', L.spec, [
        !pr.exists && h('p', { class: 'subtle' }, L.noSpec),
        h('ul', { class: 'spec' }, secs.map((x) => h('li', { class: x.s }, h('span', { class: 'mark' }, MARKS[x.s] || '○'), ' ', x.name,
          x.s === 'current' && h('span', { class: 'subtle' }, ` · ${str(L.inProgress)}`)))),
        pr.exists && h('p', { class: 'subtle' }, fmt(pr.figures === 1 ? L.figure1 : L.figuresN, pr.figures ?? 0), ' · ', pr.contact ? L.contactYes : L.contactNo),
        h('div', { class: 'actions' }, btn(pr.exists ? L.resume : L.describe, 'brief', null, true), btn(L.interview, 'interview')),
        h('div', { class: 'actions' }, pr.exists && btn(L.specPdf, 'specPdf'),
          pr.count > 0 ? btn(L.specSend, 'specSend') : h('span', { class: 'subtle' }, L.specSendNeeds)),
        h('p', { class: 'subtle' }, L.aiNote, ' · ', L.consentNote),
      ], { badge: `${str(pr.count ?? 0)} / ${secs.length}` }),
      section('direct', L.direct, [h('div', { class: 'row' }, link(L.meeting, 'meeting'), link('picodev.fr', 'link', 'picodev'))]),
    );

    if (s) {
      const j = Array.isArray(m.journal) ? m.journal : [];
      tab.journal = [section('journal', L.journal, [
        j.length ? h('ul', { class: 'log' }, j.slice(-12).map((e) => h('li', { class: e.ok ? null : 'ko' }, h('span', { class: 'subtle' }, e.at), ' ', h('code', {}, e.tool))))
          : h('p', { class: 'subtle' }, L.noCalls),
        h('p', { class: 'subtle' }, L.copilotCalls),
      ], { closedBadge: j.length ? String(j.length) : null })];
    }

    // the setting of the save push, and the editor's credit (AGPLv3): at the bottom of the Session tab
    tab.session.push(h('div', { class: 'tab-foot' },
      h('a', { href: '#', on: () => send('autoPush'), 'aria-pressed': String(!!m.autoPush), title: L.autoPushHelp }, `${str(L.autoPush)} ${m.autoPush ? '✓' : '✗'}`),
      h('p', { class: 'subtle' }, L.simIn, ' ', link(L.velxio, 'link', 'velxio'))));
    return tab;
  }

  const TABS = ['session', 'challenge', 'bench', 'journal', 'project', 'share'];
  let tabs = ['session']; // the tabs of the current model, in order
  const current = () => {
    const t = st.tab ?? (M && M.challenge ? 'challenge' : 'session');
    return tabs.includes(t) ? t : 'session';
  };

  /** Shows the current tab, without rebuilding anything (the focus stays where it is, or goes to the tab). */
  function show(focus) {
    const c = current();
    for (const b of document.querySelectorAll('[role=tab]')) {
      const on = b.dataset.tab === c;
      b.setAttribute('aria-selected', String(on));
      b.tabIndex = on ? 0 : -1;
      if (on && focus) b.focus();
    }
    for (const p of document.querySelectorAll('[role=tabpanel]')) p.hidden = p.dataset.tab !== c;
  }

  function pick(id, focus) {
    st.tab = id;
    save();
    show(focus);
  }

  function render() {
    const panels = build();
    tabs = TABS.filter((id) => panels[id]);
    const strip = h('div', { class: 'tabs', role: 'tablist', 'aria-label': 'Picodev Lab' },
      tabs.map((id) => h('button', {
        role: 'tab', id: `tab-${id}`, 'data-tab': id, 'aria-controls': `panel-${id}`,
        title: L.tabTitles?.[id], 'aria-label': L.tabTitles?.[id], on: () => pick(id),
      }, str(L.tabs?.[id]))));
    strip.addEventListener('keydown', (e) => {
      const i = tabs.indexOf(current());
      const j = { ArrowRight: i + 1, ArrowLeft: i - 1, Home: 0, End: tabs.length - 1 }[e.key];
      if (j === undefined) return;
      e.preventDefault();
      pick(tabs[(j + tabs.length) % tabs.length], true);
    });
    const focused = document.activeElement?.getAttribute('role') === 'tab';
    // the next step, in words, whatever the tab; and whether what is shown may be old
    const m = M || {};
    document.getElementById('root').replaceChildren(strip,
      ...[m.stale && h('p', { class: 'warn step' }, m.stale), m.step && h('p', { class: 'step' }, m.step)].filter(Boolean),
      ...tabs.map((id) => h('div', { role: 'tabpanel', id: `panel-${id}`, 'data-tab': id, 'aria-labelledby': `tab-${id}` }, panels[id])));
    show(focused);
  }

  addEventListener('message', ({ data }) => {
    if (!data || typeof data !== 'object') return;
    if (data.type === 'init' && data.l && typeof data.l === 'object') L = data.l;
    else if (data.type === 'state' && data.m && typeof data.m === 'object') {
      const j = JSON.stringify(data.m);
      if (j === last) return;
      last = j;
      M = data.m;
    } else if (data.type === 'images' && data.i && typeof data.i === 'object') IMG = data.i;
    else if (data.type === 'tab' && TABS.includes(data.tab)) return pick(data.tab);
    else if (data.type === 'dump') {
      // for the integration test: every tab's text, folded sections too, each image's size once decoded, the tab shown
      const shut = [...document.querySelectorAll('details:not([open]), [role=tabpanel][hidden]')];
      shut.forEach((d) => (d.tagName === 'DETAILS' ? (d.open = true) : (d.hidden = false)));
      const text = document.body.innerText + [...document.images].map((i) => `\n[image ${i.alt} ${i.naturalWidth}x${i.naturalHeight}]`).join('') + `\n[tab ${current()}]`;
      shut.forEach((d) => (d.tagName === 'DETAILS' ? (d.open = false) : (d.hidden = true)));
      return send('dump', text);
    }
    else return;
    render();
  });
  send('ready');
})();
