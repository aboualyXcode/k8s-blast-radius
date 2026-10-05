/* ui.js — the browser front end: incident pass, cluster map, terminal, file editor and dialogs.
   The simulation (engine.js, kubectl.js, game.js) never touches the DOM; this file only renders it. */
(function (K) {
  'use strict';

  const d = document;
  const $ = (sel, root) => (root || d).querySelector(sel);

  function h(tag, props) {
    const e = d.createElement(tag);
    if (props) {
      for (const k in props) {
        const v = props[k];
        if (v == null || v === false) continue;
        if (k === 'class') e.className = v;
        else if (k === 'text') e.textContent = v;
        else if (k === 'html') e.innerHTML = v;
        else if (k.slice(0, 2) === 'on' && typeof v === 'function') e.addEventListener(k.slice(2), v);
        else e.setAttribute(k, v === true ? '' : String(v));
      }
    }
    for (let i = 2; i < arguments.length; i++) add(e, arguments[i]);
    return e;
  }
  function add(e, kid) {
    if (kid == null || kid === false) return;
    if (Array.isArray(kid)) { kid.forEach(k => add(e, k)); return; }
    e.append(kid.nodeType ? kid : d.createTextNode(String(kid)));
  }
  const setText = (el, t) => { if (el.textContent !== t) el.textContent = t; };
  const setClass = (el, c) => { if (el.className !== c) el.className = c; };
  const motionOK = () => !(window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches);
  const finePointer = () => !(window.matchMedia && window.matchMedia('(pointer: coarse)').matches);
  const plain = html => { const t = d.createElement('template'); t.innerHTML = html; return t.content.textContent.replace(/\s+/g, ' ').trim(); };
  function sync(parent, kids) {
    const cur = parent.children;
    let same = cur.length === kids.length;
    for (let i = 0; same && i < kids.length; i++) if (cur[i] !== kids[i]) same = false;
    if (!same) parent.replaceChildren(...kids);
  }
  const later = fn => Promise.resolve().then(fn); // run after the current command or tick has printed
  function announce(text) {
    const a = $('#announce');
    a.textContent = '';
    setTimeout(() => { a.textContent = text; }, 40);
  }

  /* ---------- icons ---------- */
  const ICON = {
    run: '<svg viewBox="0 0 12 12" aria-hidden="true"><circle cx="6" cy="6" r="4.6" fill="currentColor"/></svg>',
    wait: '<svg viewBox="0 0 12 12" aria-hidden="true"><circle cx="6" cy="6" r="4.3" fill="none" stroke="currentColor" stroke-opacity=".35" stroke-width="1.7"/><path d="M6 1.7a4.3 4.3 0 0 1 4.3 4.3" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"/></svg>',
    fail: '<svg viewBox="0 0 12 12" aria-hidden="true"><path d="M2.8 2.8l6.4 6.4M9.2 2.8L2.8 9.2" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>',
    term: '<svg viewBox="0 0 12 12" aria-hidden="true"><path d="M2.5 6h7" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>',
    unknown: '<svg viewBox="0 0 12 12" aria-hidden="true"><path d="M4.2 4.3a1.9 1.9 0 1 1 2.7 1.7c-.6.3-.9.7-.9 1.3" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/><circle cx="6" cy="9.6" r="1" fill="currentColor"/></svg>',
    done: '<svg viewBox="0 0 12 12" aria-hidden="true"><path d="M2.6 6.4l2.3 2.3 4.5-5" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>',
  };
  const ICON_FILE = '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M3.5 1.5h5.5l3.5 3.5v9.5h-9z" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linejoin="round"/><path d="M9 1.5V5h3.5" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linejoin="round"/></svg>';
  const ICON_PAGER = '<svg viewBox="0 0 20 20" aria-hidden="true"><rect x="2.5" y="5" width="15" height="10" rx="2" fill="none" stroke="currentColor" stroke-width="1.7"/><path d="M5.5 8.5h6M5.5 11.5h4" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"/><circle cx="14.4" cy="10" r="1.3" fill="currentColor"/></svg>';
  const STAR = '<svg viewBox="0 0 12 12" aria-hidden="true"><path d="M6 .8l1.6 3.3 3.6.5-2.6 2.5.6 3.6L6 9 2.8 10.7l.6-3.6L.8 4.6l3.6-.5z"/></svg>';

  function starsEl(n, cls, decorative) {
    const wrap = h('span', decorative ? { class: 'stars ' + (cls || ''), 'aria-hidden': 'true' } : { class: 'stars ' + (cls || ''), role: 'img', 'aria-label': `${n} of 3 stars` });
    for (let i = 0; i < 3; i++) wrap.append(h('span', { class: i < n ? 'star is-on' : 'star', html: STAR }));
    return wrap;
  }
  const starsFor = reveals => (reveals === 0 ? 3 : reveals <= 2 ? 2 : 1);

  /* ---------- progress, saved in this browser ---------- */
  const KEY = 'blast-radius:v1';
  const progress = (() => {
    const blank = () => ({ stars: {}, quiz: {}, last: 0, intro: false });
    let data = blank();
    try { const raw = localStorage.getItem(KEY); if (raw) data = Object.assign(blank(), JSON.parse(raw)); } catch (e) { /* private mode: play without saving */ }
    return {
      get data() { return data; },
      save() { try { localStorage.setItem(KEY, JSON.stringify(data)); } catch (e) { /* ignore */ } },
      reset() { data = blank(); data.intro = true; this.save(); },
    };
  })();

  /* ---------- the game ---------- */
  const params = new URLSearchParams(location.search);
  const BASE_TICK = Math.max(40, Number(params.get('tick')) || 1000);
  const game = new K.Game({ seed: params.has('seed') ? Number(params.get('seed')) : undefined });

  /* ---------- pod helpers ---------- */
  const HUES = [262, 172, 32, 330, 205, 120, 290, 12];
  const hueMap = new Map();
  const hue = name => { if (!hueMap.has(name)) hueMap.set(name, HUES[hueMap.size % HUES.length]); return hueMap.get(name); };
  const statusOf = p => K.podStatus(p);
  function stClass(p) {
    const s = statusOf(p);
    if (s === 'Terminating' || s === 'Evicted' || s === 'Completed') return 'term';
    if (s === 'Unknown') return 'unknown';
    if (s === 'Running') return p.ready ? 'run' : 'wait';
    if (/^(Pending|ContainerCreating|PodInitializing)$/.test(s) || /^Init:\d/.test(s)) return 'wait';
    return 'fail';
  }
  const shortStatus = p => { const s = statusOf(p); return s === 'Running' && !p.ready ? 'Running, not ready' : s; };
  const tagOf = image => K.sim.parseImage(image).tag;
  const appOf = (c, p) => c.workloadOf(p);
  const byAge = (a, b) => a.created - b.created || (a.name < b.name ? -1 : 1);
  const pct = (a, b) => (b ? Math.max(0, Math.min(100, (a / b) * 100)) : 0);
  function summarize(items) {
    const counts = new Map();
    items.forEach(n => counts.set(n, (counts.get(n) || 0) + 1));
    return Array.from(counts, ([n, k]) => (k > 1 ? `${n} ×${k}` : n)).join(', ');
  }
  const fmtN = n => (n >= 10000 ? Math.round(n / 1000) + 'k' : n >= 1000 ? (n / 1000).toFixed(1) + 'k' : String(Math.round(n)));

  /* ================= cluster map ================= */
  const MapView = (() => {
    const root = $('#map'), nodesBox = $('#nodes'), pendBox = $('#pending'), pendPods = $('#pending-pods');
    const wlBox = $('#workloads'), svcBox = $('#svc-list'), sloBox = $('#slo');
    const cpEls = {};
    d.querySelectorAll('[data-cp]').forEach(el => { cpEls[el.dataset.cp] = el; });
    d.querySelectorAll('.lg-icon[data-icon]').forEach(el => { el.innerHTML = ICON[el.dataset.icon]; });
    let nodeEls, podEls, ghosts, svcEls, prev, hl, hlSvc, sloEls;

    function reset() {
      if (ghosts) ghosts.forEach(g => clearTimeout(g.timer));
      nodeEls = new Map(); podEls = new Map(); ghosts = new Map(); svcEls = new Map(); sloEls = new Map();
      prev = null; hl = null; hlSvc = null;
      nodesBox.replaceChildren(); pendPods.replaceChildren(); svcBox.replaceChildren(); sloBox.replaceChildren();
      root.classList.remove('has-hl');
      hueMap.clear();
      const c = game.cluster;
      c.list('Deployment').filter(x => !c.isSystemNs(x.namespace)).sort((a, b) => (a.name < b.name ? -1 : 1)).forEach(x => hue(x.name));
      render();
    }
    function blink(el) { if (!el) return; el.classList.remove('blink'); void el.offsetWidth; el.classList.add('blink'); }
    function activity(c) {
      const a = c.activity;
      if (prev) ['apiserver', 'etcd', 'scheduler', 'controllers'].forEach(k => { if (a[k] > prev[k]) blink(cpEls[k]); });
      prev = { apiserver: a.apiserver, etcd: a.etcd, scheduler: a.scheduler, controllers: a.controllers };
    }

    function slo(c) {
      sloBox.hidden = !c.flows.length;
      const kids = c.flows.map(f => {
        let el = sloEls.get(f.id);
        if (!el) {
          el = { root: h('div', { class: 'slo-flow' }), name: h('span', { class: 'slo-name' }), rps: h('span', { class: 'slo-rps' }), pct: h('span', { class: 'slo-pct' }), ok: h('span', { class: 'meter-ok' }), drop: h('span', { class: 'meter-drop' }), note: h('p', { class: 'slo-note' }) };
          el.meter = h('div', { class: 'meter', role: 'img' }, el.ok, el.drop);
          el.root.append(h('div', { class: 'slo-top' }, el.name, el.rps, el.pct), el.meter, el.note);
          sloEls.set(f.id, el);
        }
        const s = c.flowStats[f.id] || { rps: f.rps, served: f.rps, failed: 0, ok: 1 };
        const okPct = s.ok * 100;
        setText(el.name, f.label);
        setText(el.rps, `${s.rps} req/s`);
        setText(el.pct, okPct >= 99.95 ? '100%' : okPct.toFixed(1) + '%');
        setClass(el.root, 'slo-flow ' + (s.ok >= 0.99 ? 'is-good' : s.ok >= 0.9 ? 'is-warn' : 'is-bad'));
        el.ok.style.width = okPct + '%'; el.drop.style.width = (100 - okPct) + '%';
        el.meter.setAttribute('aria-label', `${f.label}: ${s.served} of ${s.rps} requests per second succeed`);
        setText(el.note, s.failed ? `${s.failed} req/s failing: ${s.cause || 'errors'}` : `All requests succeeding across ${s.healthy} pods`);
        return el.root;
      });
      const imp = c.impact;
      if (!sloEls.total) sloEls.total = h('p', { class: 'slo-total' });
      setText(sloEls.total, imp.failed ? `Customer impact since you were paged: ${fmtN(imp.failed)} failed requests of ${fmtN(imp.total)}` : 'No failed customer requests since you were paged.');
      sync(sloBox, kids.length ? kids.concat(sloEls.total) : []);
    }

    function workloads(c) {
      const deps = c.list('Deployment').filter(x => !c.isSystemNs(x.namespace) || !c.rolloutComplete(x) || c.podsOfDeployment(x).some(p => !p.ready));
      if (!deps.length) { wlBox.replaceChildren(h('p', { class: 'map-empty', text: 'No deployments.' })); return; }
      wlBox.replaceChildren(...deps.map(dep => {
        const s = c.deploymentStatus(dep);
        const live = c.rsOf(dep).filter(rs => c.podsOfRS(rs).length > 0);
        const rolling = !c.rolloutComplete(dep) && (live.length > 1 || (live.length === 1 && live[0].hash !== c.templateHash(dep.template)));
        const bad = s.ready < dep.replicas;
        return h('div', { class: 'wl' + (bad ? ' is-bad' : ''), style: `--hue:${hue(dep.name)}` },
          h('span', { class: 'wl-swatch', 'aria-hidden': 'true' }),
          h('span', { class: 'wl-name', text: dep.name }),
          h('span', { class: 'wl-ns', text: dep.namespace }),
          h('span', { class: 'wl-meta', text: `${tagOf(dep.template.spec.containers[0].image)}, ${s.ready}/${dep.replicas} ready` }),
          rolling ? h('span', { class: 'wl-roll', text: dep.deadlineExceeded ? 'rollout stuck' : dep.paused ? 'rollout paused' : `rolling out, ${s.updated} of ${dep.replicas} updated` }) : null);
      }));
    }

    function bar(cls, value, label) {
      return [h('span', { text: label }), h('span', { class: 'bar' + (value > 95 ? ' is-hot' : value > 80 ? ' is-warm' : '') }, h('i', { style: `width:${value}%` })), h('span', { text: Math.round(value) + '%' })];
    }
    function nodeEl(n) {
      let ne = nodeEls.get(n.name);
      if (ne) return ne;
      const el = h('div', { class: 'node', 'data-node': n.name });
      const state = h('span', { class: 'node-state' });
      const taints = h('span');
      const bars = h('div', { class: 'node-bars' });
      const pods = h('div', { class: 'pods' });
      const sys = h('p', { class: 'node-sys' });
      el.append(h('div', { class: 'node-head' }, h('span', { class: 'node-name', text: n.name }), state, taints), bars, pods, sys);
      nodesBox.append(el);
      ne = { el, state, taints, bars, pods, sys, key: '' };
      nodeEls.set(n.name, ne);
      return ne;
    }
    function podEl(c, p) {
      let el = podEls.get(p.uid);
      if (!el) {
        el = h('button', { type: 'button', class: 'pod' }, h('span', { class: 'pod-icon' }), h('span', { class: 'pod-name' }), h('span', { class: 'pod-tag' }), h('span', { class: 'pod-status' }));
        el.dataset.uid = p.uid;
        el.addEventListener('click', () => {
          const pod = game.cluster.list('Pod').find(x => x.uid === el.dataset.uid);
          if (pod) Term.insert(pod.name + (pod.namespace !== game.cluster.currentNamespace ? ' -n ' + pod.namespace : ''));
        });
        el._new = true;
        podEls.set(p.uid, el);
      }
      const st = stClass(p), status = shortStatus(p), app = appOf(c, p);
      setClass(el, 'pod st-' + st + (hl && hl.has(p.uid) ? ' is-endpoint' : ''));
      el.style.setProperty('--hue', hue(app));
      const kids = el.children;
      if (el.dataset.st !== st) { kids[0].innerHTML = ICON[st]; el.dataset.st = st; }
      setText(kids[1], app);
      setText(kids[2], tagOf(p.spec.containers[0].image));
      setText(kids[3], status + (p.restarts ? ` · ${p.restarts}↻` : ''));
      el.dataset.node = p.node || '';
      const tip = `${p.name}\nnamespace: ${p.namespace}\n${status}${p.node ? ' on ' + p.node : ''}${p.ip ? ', IP ' + p.ip : ''}${p.restarts ? `\n${p.restarts} restarts` : ''}${p.memMi ? `\nmemory: ${p.memMi}Mi` : ''}\nClick to paste the name into the terminal`;
      if (el.title !== tip) el.title = tip;
      el.setAttribute('aria-label', `Pod ${p.name} in ${p.namespace}, ${status}${p.node ? ' on ' + p.node : ''}. Paste name into terminal.`);
      return el;
    }
    function ghost(uid, el) {
      el.classList.add('is-gone'); el.disabled = true; el.setAttribute('aria-hidden', 'true');
      const timer = setTimeout(() => { ghosts.delete(uid); podEls.delete(uid); el.remove(); render(); }, motionOK() ? 340 : 0);
      ghosts.set(uid, { el, node: el.dataset.node || null, timer });
    }
    function pods(c) {
      const list = c.list('Pod').filter(p => !c.isSystemNs(p.namespace));
      const live = new Set(list.map(p => p.uid));
      podEls.forEach((el, uid) => { if (!live.has(uid) && !ghosts.has(uid)) ghost(uid, el); });
      list.forEach(p => podEl(c, p));
      const withGhosts = (arr, node) => arr.concat(Array.from(ghosts.values()).filter(g => g.node === node && g.el.parentNode).map(g => g.el));
      const pend = list.filter(p => !p.node).sort(byAge).map(p => podEls.get(p.uid));
      sync(pendPods, withGhosts(pend, ''));
      pendBox.hidden = pend.length === 0;
      c.nodes.forEach(n => {
        const ne = nodeEl(n);
        const mine = list.filter(p => p.node === n.name).sort((a, b) => (appOf(c, a) < appOf(c, b) ? -1 : appOf(c, a) > appOf(c, b) ? 1 : byAge(a, b)));
        sync(ne.pods, withGhosts(mine.map(p => podEls.get(p.uid)), n.name));
        setClass(ne.el, 'node' + (!n.ready ? ' is-down' : '') + (n.unschedulable ? ' is-cordoned' : '') + (n.memPressure ? ' is-pressure' : ''));
        setText(ne.state, !n.ready ? 'NotReady' : n.unschedulable ? 'cordoned' : n.memPressure ? 'MemoryPressure' : 'Ready');
        const tk = (n.taints || []).map(t => `${t.key}=${t.value || ''}:${t.effect}`).join(' ');
        if (ne.taints.dataset.k !== tk) { ne.taints.dataset.k = tk; ne.taints.replaceChildren(...(n.taints || []).map(t => h('span', { class: 'node-taint', title: `Taint ${t.key}=${t.value || ''}:${t.effect}`, text: `${t.key}=${t.value || ''}` }))); }
        const a = c.nodeAllocated(n);
        const memUse = n.ready ? pct(n.memUsage, n.memMi) : 0;
        const bk = [Math.round(pct(a.cpu, n.allocCpu)), Math.round(pct(a.mem, n.allocMem)), Math.round(memUse)].join('|');
        if (ne.key !== bk) {
          ne.key = bk;
          ne.bars.replaceChildren(...bar('', pct(a.cpu, n.allocCpu), 'CPU requested'), ...bar('', pct(a.mem, n.allocMem), 'Memory requested'), ...bar('', memUse, 'Memory in use'));
          ne.bars.title = `Requests are what the scheduler reserves; in use is what the node's memory actually holds (${n.memUsage}Mi of ${n.memMi}Mi including system).`;
        }
        const sysPods = c.list('Pod').filter(p => p.node === n.name && c.isSystemNs(p.namespace) && !p.deleting);
        const badSys = sysPods.filter(p => statusOf(p) !== 'Running');
        const txt = sysPods.length ? 'System: ' + summarize(sysPods.map(p => appOf(c, p) + (statusOf(p) !== 'Running' ? ` (${statusOf(p)})` : ''))) : '';
        setText(ne.sys, txt); setClass(ne.sys, 'node-sys' + (badSys.length ? ' is-bad' : ''));
        if (ne.sys.title !== txt) ne.sys.title = txt;
      });
      const anim = motionOK();
      podEls.forEach(el => {
        if (!el._new) return;
        el._new = false;
        if (anim && el.isConnected) el.animate([{ opacity: 0, transform: 'scale(.85)' }, { opacity: 1, transform: 'none' }], { duration: 260, easing: 'cubic-bezier(.2,.8,.2,1)' });
      });
    }

    function refreshHl() {
      const c = game.cluster;
      const s = hlSvc ? c.list('Service').find(x => x.uid === hlSvc) : null;
      hl = s ? new Set(c.endpointsFor(s).map(p => p.uid)) : null;
      root.classList.toggle('has-hl', !!hl);
      podEls.forEach((el, uid) => el.classList.toggle('is-endpoint', !!hl && hl.has(uid)));
    }
    function services(c) {
      const svcs = c.list('Service').filter(s => !c.isSystemNs(s.namespace) && !(s.namespace === 'default' && s.name === 'kubernetes'));
      const seen = new Set();
      const kids = svcs.map(s => {
        seen.add(s.uid);
        let row = svcEls.get(s.uid);
        if (!row) {
          const btn = h('button', { type: 'button', class: 'svc' }, h('span', { class: 'svc-name' }), h('span', { class: 'svc-port' }), h('span', { class: 'svc-ep' }));
          const uid = s.uid;
          const on = () => { hlSvc = uid; refreshHl(); };
          const off = () => { if (hlSvc === uid) { hlSvc = null; refreshHl(); } };
          btn.addEventListener('mouseenter', on); btn.addEventListener('focus', on);
          btn.addEventListener('mouseleave', off); btn.addEventListener('blur', off);
          btn.addEventListener('click', () => { const x = game.cluster.list('Service').find(q => q.uid === uid); if (x) Term.insert(`${x.name} -n ${x.namespace}`); });
          row = h('li', null, btn); row._btn = btn;
          svcEls.set(s.uid, row);
        }
        const eps = c.endpointsFor(s).length, p = s.ports[0];
        const [name, port, ep] = row._btn.children;
        setText(name, `${s.name}.${s.namespace}`);
        setText(port, p ? `${p.port} → ${p.targetPort}` : '');
        setText(ep, eps === 0 ? 'no endpoints' : eps === 1 ? '1 endpoint' : `${eps} endpoints`);
        setClass(ep, 'svc-ep' + (eps === 0 ? ' is-zero' : ''));
        const sel = s.selector ? Object.keys(s.selector).map(k => k + '=' + s.selector[k]).join(', ') : 'nothing';
        row._btn.title = `Service ${s.name} in ${s.namespace} selects pods labelled ${sel}.\nHover to highlight its endpoints. Click to paste its name.`;
        row._btn.setAttribute('aria-label', `Service ${s.name} in ${s.namespace}, ${eps} endpoints. Paste name into terminal.`);
        return row;
      });
      svcEls.forEach((row, uid) => { if (!seen.has(uid)) { svcEls.delete(uid); if (hlSvc === uid) hlSvc = null; } });
      sync(svcBox, kids);
      refreshHl();
    }
    function storage(c) {
      const pvcs = c.list('PersistentVolumeClaim');
      $('#storage').hidden = !pvcs.length;
      $('#pvc-list').replaceChildren(...pvcs.map(p => {
        const used = p.phase === 'Bound' ? pct(p.usedMi, p.capacityMi) : 0;
        const state = p.terminating ? 'Terminating' : p.phase !== 'Bound' ? 'Pending' : p.resizing ? 'resizing' : `${K.qty.fmtMem(p.capacityMi)}, ${Math.round(used)}% used`;
        return h('li', { title: `${p.namespace}/${p.name}, class ${p.spec.storageClassName || p.storageClassResolved || 'default'}` },
          h('span', { class: 'svc-name', text: `${p.name}.${p.namespace}` }), h('span', { class: 'pvc-state' + (p.terminating || p.phase !== 'Bound' || used >= 99 ? ' is-bad' : ''), text: state }),
          p.phase === 'Bound' ? h('span', { class: 'bar' + (used >= 99 ? ' is-hot' : used > 85 ? ' is-warm' : '') }, h('i', { style: `width:${used}%` })) : null);
      }));
      const hpas = c.list('HorizontalPodAutoscaler').filter(x => !c.isSystemNs(x.namespace));
      $('#hpas').hidden = !hpas.length;
      $('#hpa-list').replaceChildren(...hpas.map(x => {
        const dep = c.get('Deployment', x.namespace, x.target.name);
        return h('p', { class: 'hpa-line', text: `${x.name}: CPU ${x.current == null ? 'unknown' : x.current + '%'} of ${x.targetCPU}% target, ${dep ? dep.replicas : 0} replicas (${x.min} to ${x.max})` });
      }));
    }

    function render() {
      const c = game.cluster;
      activity(c); slo(c); workloads(c); pods(c); services(c); storage(c);
    }
    return { reset, render };
  })();

  /* ================= terminal ================= */
  const Term = (() => {
    const out = $('#term-out'), input = $('#term-input'), promptEl = $('#term-prompt'), stopBtn = $('#term-stop');
    const history = [];
    let hIdx = 0, draft = '', stream = null;
    const MAX_LINES = 1500;
    const PLACEHOLDER = input.placeholder;

    const promptText = () => `${K.CONST.CONTEXT}:${game.cluster.currentNamespace}$`;
    function updatePrompt() { setText(promptEl, promptText()); }
    const nearBottom = () => out.scrollHeight - out.scrollTop - out.clientHeight < 48;
    function print(lines, force) {
      if (!lines || !lines.length) return;
      const stick = force || nearBottom();
      const frag = d.createDocumentFragment();
      lines.forEach(l => frag.append(h('div', { class: 't-line' + (l.c ? ' t-' + l.c : '') + (l.wrap ? ' t-wrap' : ''), text: l.t === '' ? '\u00a0' : l.t })));
      out.append(frag);
      while (out.childElementCount > MAX_LINES) out.firstElementChild.remove();
      if (stick) out.scrollTop = out.scrollHeight;
    }
    function echo(cmd) {
      out.append(h('div', { class: 't-line t-cmd' }, h('span', { class: 't-prompt', text: promptText() }), ' ' + cmd));
      out.scrollTop = out.scrollHeight;
    }
    function run(cmd) {
      echo(cmd);
      if (cmd.trim() && history[history.length - 1] !== cmd) history.push(cmd);
      hIdx = history.length; draft = '';
      let res;
      try { res = game.run(cmd); } catch (e) {
        console.error(e);
        res = { lines: [{ t: 'The simulator hit an internal error running that command: ' + e.message, c: 'err' }] };
      }
      if (res.clear) out.replaceChildren();
      print(res.lines, true);
      if (res.stream) startStream(res.stream);
      if (res.suggest) setInput(res.suggest);
      updatePrompt();
      MapView.render();
      Slip.renderSteps();
      Slip.renderFiles();
      if (res.editor) Editor.open(res.editor);
    }
    function startStream(s) {
      stream = s;
      input.readOnly = true;
      input.value = '';
      input.placeholder = 'watching… press Ctrl+C to stop';
      stopBtn.hidden = false;
    }
    function stopStream(showInterrupt) {
      if (!stream) return;
      stream = null;
      input.readOnly = false;
      input.placeholder = PLACEHOLDER;
      stopBtn.hidden = true;
      if (showInterrupt) print([{ t: '^C', c: 'dim' }], true);
    }
    function onTick() {
      if (!stream) return;
      let r;
      try { r = stream.tick(); } catch (e) { console.error(e); r = { lines: [], done: true }; }
      print(r.lines);
      if (r.done) stopStream(false);
    }
    function setInput(v, focusIt) {
      if (stream) stopStream(true);
      input.value = v;
      const n = v.length;
      input.setSelectionRange(n, n);
      if (focusIt) input.focus();
    }
    function insert(text) {
      if (stream) return;
      const v = input.value, s = input.selectionStart == null ? v.length : input.selectionStart, e = input.selectionEnd == null ? v.length : input.selectionEnd;
      const before = v.slice(0, s), after = v.slice(e);
      const ins = (before && !/[\s/=]$/.test(before) ? ' ' : '') + text + (after.startsWith(' ') ? '' : ' ');
      input.value = before + ins + after;
      const pos = (before + ins).length;
      input.focus();
      input.setSelectionRange(pos, pos);
    }
    function insertRaw(ch) {
      if (stream) return;
      const v = input.value, s = input.selectionStart == null ? v.length : input.selectionStart, e = input.selectionEnd == null ? v.length : input.selectionEnd;
      input.value = v.slice(0, s) + ch + v.slice(e);
      input.setSelectionRange(s + ch.length, s + ch.length);
    }
    function complete() {
      const caret = input.selectionStart == null ? input.value.length : input.selectionStart;
      const head = input.value.slice(0, caret), tail = input.value.slice(caret);
      const cands = K.shellUtil.completions(game, head);
      if (!cands.length) return;
      const cur = head.split(/\s+/).pop();
      let pre = cands.reduce((a, b) => { let i = 0; while (i < a.length && i < b.length && a[i] === b[i]) i++; return a.slice(0, i); });
      if (cands.length === 1) pre = cands[0] + (/[/=]$/.test(cands[0]) ? '' : ' ');
      if (pre.length > cur.length) {
        const nv = head.slice(0, head.length - cur.length) + pre;
        input.value = nv + tail;
        input.setSelectionRange(nv.length, nv.length);
        return;
      }
      echo(input.value);
      const shown = cands.slice(0, 48);
      const w = Math.max(...shown.map(x => x.length)) + 3;
      const per = Math.max(1, Math.floor(88 / w));
      const rows = [];
      for (let i = 0; i < shown.length; i += per) rows.push({ t: shown.slice(i, i + per).map(x => x.padEnd(w)).join('').trimEnd(), c: 'dim' });
      if (cands.length > shown.length) rows.push({ t: `…and ${cands.length - shown.length} more`, c: 'dim' });
      print(rows, true);
    }
    function interrupt() {
      if (stream) { stopStream(true); return; }
      echo(input.value + '^C');
      input.value = '';
    }
    function historyMove(dir) {
      if (stream || !history.length) return;
      if (dir < 0) {
        if (hIdx === history.length) draft = input.value;
        hIdx = Math.max(0, hIdx - 1);
        setInput(history[hIdx]);
      } else {
        if (hIdx < history.length) hIdx++;
        setInput(hIdx === history.length ? draft : history[hIdx]);
      }
    }

    input.addEventListener('keydown', e => {
      const ctrl = e.ctrlKey && !e.metaKey && !e.altKey;
      if (e.key === 'Enter') {
        e.preventDefault();
        if (stream) return;
        const v = input.value;
        input.value = '';
        run(v);
      } else if (e.key === 'Tab' && !e.shiftKey) {
        if (!input.value.trim()) return; // let Tab move focus when the line is empty
        e.preventDefault();
        if (!stream) complete();
      } else if (e.key === 'ArrowUp') { e.preventDefault(); historyMove(-1); }
      else if (e.key === 'ArrowDown') { e.preventDefault(); historyMove(1); }
      else if (ctrl && (e.key === 'c' || e.key === 'C')) {
        if (!stream && input.selectionStart !== input.selectionEnd) return; // allow copying selected input text
        e.preventDefault();
        interrupt();
      } else if (ctrl && (e.key === 'l' || e.key === 'L')) { e.preventDefault(); out.replaceChildren(); }
      else if (ctrl && (e.key === 'u' || e.key === 'U')) { e.preventDefault(); if (!stream) input.value = ''; }
    });
    stopBtn.addEventListener('click', () => { stopStream(true); input.focus(); });
    $('#term-help').addEventListener('click', () => { if (stream) stopStream(true); run('help'); input.focus(); });
    $('#terminal').addEventListener('mouseup', e => {
      if (e.target.closest('button')) return;
      if (!String(window.getSelection() || '')) input.focus({ preventScroll: true });
    });
    d.querySelectorAll('.keybar [data-key]').forEach(b => {
      b.addEventListener('pointerdown', e => e.preventDefault()); // keep the on-screen keyboard open
      b.addEventListener('click', () => {
        const k = b.dataset.key;
        if (k === 'Tab') complete();
        else if (k === 'ArrowUp') historyMove(-1);
        else if (k === 'ArrowDown') historyMove(1);
        else if (k === 'ctrl-c') interrupt();
        else insertRaw(k);
        input.focus();
      });
    });

    function reset() {
      stopStream(false);
      out.replaceChildren();
      input.value = '';
      const L = game.level;
      print([
        { t: `${L.ticket} ${L.sev}: ${L.title}`, c: 'hint' },
        { t: L.alert, c: 'warn', wrap: true },
        { t: `oncall@${K.CONST.CONTEXT}. This debug shell runs in the default namespace; add -n <namespace> to reach the rest.`, c: 'dim', wrap: true },
        { t: "'runbook' shows the triage loop, 'help' lists commands, 'hint' gives a nudge.", c: 'dim', wrap: true },
      ], true);
      updatePrompt();
    }
    return { reset, print, run, onTick, insert, setInput, updatePrompt, focus: () => input.focus({ preventScroll: true }) };
  })();

  /* ================= file editor ================= */
  const Editor = (() => {
    const panel = $('#editor'), ta = $('#ed-text'), gutter = $('#ed-gutter'), title = $('#ed-file'), status = $('#ed-status');
    let file = null, saved = '', timer = 0;

    function lines() {
      const n = ta.value.split('\n').length;
      let s = '';
      for (let i = 1; i <= n; i++) s += i + '\n';
      gutter.textContent = s;
      gutter.scrollTop = ta.scrollTop;
    }
    function setStatus(t, kind) { status.textContent = t; status.className = 'ed-status' + (kind ? ' is-' + kind : ''); }
    function validate() {
      if (!file) return;
      const dirty = ta.value !== saved;
      if (!/\.ya?ml$/i.test(file)) { setStatus(dirty ? 'Unsaved changes' : '', ''); return; }
      try {
        const docs = K.yaml.parseAll(ta.value);
        const what = docs.map(x => (x && x.kind ? x.kind + (x.metadata && x.metadata.name ? ' ' + x.metadata.name : '') : 'a document')).join(', ');
        setStatus((dirty ? 'Unsaved. ' : '') + (docs.length ? 'Valid YAML: ' + what : 'Empty file'), dirty ? '' : 'ok');
      } catch (e) { setStatus('YAML problem, ' + e.message, 'bad'); }
    }
    function open(name) {
      if (!game.files.has(name)) game.files.set(name, '');
      file = name;
      saved = game.files.get(name);
      ta.value = saved;
      title.textContent = name;
      panel.hidden = false;
      ta.scrollTop = 0; ta.scrollLeft = 0;
      lines(); validate();
      ta.focus();
      ta.setSelectionRange(0, 0);
      Slip.renderFiles();
    }
    function hide() { panel.hidden = true; file = null; }
    function save(andClose) {
      if (!file) return;
      let v = ta.value;
      if (v && !v.endsWith('\n')) v += '\n';
      game.files.set(file, v);
      saved = ta.value;
      game.fact('saved:' + file);
      Slip.renderFiles();
      const f = file;
      if (andClose) {
        hide();
        Term.print([{ t: /\.ya?ml$/i.test(f) ? `Saved ${f}. Apply it with: kubectl apply -f ${f}` : `Saved ${f}.`, c: 'dim', wrap: true }], true);
        Term.focus();
      } else {
        validate();
        setStatus('Saved. ' + status.textContent, 'ok');
      }
    }
    async function close() {
      if (!file) return;
      if (ta.value !== saved) {
        const ok = await Dialog.ask('Discard your changes?', `${file} has changes you haven't saved.`, 'Discard changes', 'Keep editing');
        if (!ok) { ta.focus(); return; }
      }
      hide();
      Term.focus();
    }
    function replaceRange(s, e, text, select) {
      ta.focus();
      ta.setSelectionRange(s, e);
      let ok = false;
      try { ok = d.execCommand('insertText', false, text); } catch (x) { ok = false; }
      if (!ok) ta.setRangeText(text, s, e, 'end');
      if (select) ta.setSelectionRange(s, s + text.length);
      lines();
      clearTimeout(timer); timer = setTimeout(validate, 200);
    }

    ta.addEventListener('keydown', e => {
      const mod = e.ctrlKey || e.metaKey;
      if (mod && (e.key === 's' || e.key === 'S')) { e.preventDefault(); save(false); return; }
      if (e.key === 'Escape') { e.preventDefault(); close(); return; }
      if (e.key === 'Tab') {
        e.preventDefault();
        const v = ta.value, s = ta.selectionStart, en = ta.selectionEnd;
        if (s === en && !e.shiftKey) { replaceRange(s, en, '  '); return; }
        const ls = v.lastIndexOf('\n', s - 1) + 1;
        let le = v.indexOf('\n', en > s && v[en - 1] === '\n' ? en - 1 : en);
        if (le < 0) le = v.length;
        const block = v.slice(ls, le);
        replaceRange(ls, le, e.shiftKey ? block.replace(/^ {1,2}/gm, '') : block.replace(/^/gm, '  '), true);
        return;
      }
      if (e.key === 'Enter' && !mod && !e.shiftKey) {
        const v = ta.value, s = ta.selectionStart;
        const line = v.slice(v.lastIndexOf('\n', s - 1) + 1, s);
        const m = /^(\s*)(- )?/.exec(line);
        let ind = m[1] + (m[2] ? '  ' : '');
        if (/:\s*$/.test(line)) ind += '  ';
        e.preventDefault();
        replaceRange(s, ta.selectionEnd, '\n' + ind);
      }
    });
    ta.addEventListener('input', () => { lines(); clearTimeout(timer); timer = setTimeout(validate, 200); });
    ta.addEventListener('scroll', () => { gutter.scrollTop = ta.scrollTop; });
    $('#ed-save').addEventListener('click', () => save(true));
    $('#ed-close').addEventListener('click', () => close());
    return { open, close, forceClose: hide, isOpen: () => !panel.hidden };
  })();

  /* ================= dialogs ================= */
  const Dialog = (() => {
    const dlg = $('#dlg'), body = $('#dlg-body');
    let onClose = null, skipClose = 0;
    const runClose = () => { const f = onClose; onClose = null; if (f) f(); };
    dlg.addEventListener('cancel', e => { e.preventDefault(); close(); });
    dlg.addEventListener('close', () => { if (skipClose > 0) { skipClose--; return; } runClose(); });
    dlg.addEventListener('click', e => { if (e.target === dlg) close(); });
    function close() {
      if (!dlg.open) return;
      skipClose++;
      dlg.close();
      runClose();
    }
    function show(content, opts) {
      close();
      body.replaceChildren(content);
      onClose = (opts && opts.onClose) || null;
      dlg.showModal();
      dlg.scrollTop = 0;
      const f = body.querySelector('[data-autofocus]');
      if (f) f.focus();
    }
    function ask(title, text, okLabel, cancelLabel) {
      return new Promise(resolve => {
        const content = h('div', null,
          h('h2', { text: title }),
          h('p', { text }),
          h('div', { class: 'dlg-actions' },
            h('button', { class: 'btn btn-ghost', type: 'button', 'data-autofocus': '', onclick: () => { resolve(false); close(); } }, cancelLabel || 'Cancel'),
            h('button', { class: 'btn', type: 'button', onclick: () => { resolve(true); close(); } }, okLabel)));
        show(content, { onClose: () => resolve(false) });
      });
    }
    return { show, close, ask, isOpen: () => dlg.open };
  })();

  /* ================= pager ================= */
  const Pager = (() => {
    const el = $('#pager');
    let t = 0;
    el.addEventListener('click', () => hide());
    function show(p) {
      el.replaceChildren(h('span', { html: ICON_PAGER }), h('span', null, h('strong', { text: p.title }), h('span', { text: p.body })));
      el.setAttribute('aria-label', `Page: ${p.title}. ${p.body} Select to dismiss.`);
      el.hidden = false;
      el.classList.remove('in'); void el.offsetWidth;
      if (motionOK()) el.classList.add('in');
      clearTimeout(t); t = setTimeout(hide, 8000);
    }
    function hide() { el.hidden = true; clearTimeout(t); }
    return { show, hide };
  })();

  /* ================= incident rail ================= */
  const Rail = {
    render() {
      const ol = $('#rail');
      const items = [];
      K.LEVELS.forEach((L, i) => {
        if (i && K.LEVELS[i - 1].tier !== L.tier) items.push(h('li', { class: 'rail-tier', 'aria-hidden': 'true' }));
        const stars = progress.data.stars[L.id] || 0, cur = i === game.index;
        items.push(h('li', null, h('button', {
          type: 'button',
          class: 'rail-btn' + (cur ? ' is-current' : '') + (stars ? ' is-done' : ''),
          'aria-current': cur ? 'step' : null,
          'aria-label': `${L.ticket}: ${L.title}, ${K.TIERS[L.tier]}${stars ? `, resolved with ${stars} of 3 stars` : ''}`,
          title: `${L.ticket} · ${L.sev} · ${L.title}\nTier ${L.tier}: ${K.TIERS[L.tier]}${stars ? `\nResolved, ${stars} of 3 stars` : ''}`,
          onclick: () => switchLevel(i),
        }, h('span', { class: 'rail-num', text: L.ticket.replace(/^\D+-/, '') }), h('span', { class: 'rail-band', 'aria-hidden': 'true' }))));
      });
      ol.replaceChildren(...items);
      const cur = ol.querySelector('.is-current');
      if (cur) {
        const wrap = ol.parentElement, r = cur.getBoundingClientRect(), w = wrap.getBoundingClientRect();
        if (r.left < w.left || r.right > w.right) wrap.scrollLeft += r.left - w.left - w.width / 2 + r.width / 2;
      }
    },
  };

  async function switchLevel(i) {
    if (i === game.index && !game.completed) {
      if (game.objIndex === 0) return;
      if (!(await Dialog.ask('Restart this incident?', 'The cluster goes back to the moment you were paged.', 'Restart incident', 'Keep going'))) return false;
    } else if (game.objIndex > 0 && !game.completed) {
      if (!(await Dialog.ask('Leave this incident?', `Your progress on ${game.level.ticket} will reset.`, `Open ${K.LEVELS[i].ticket}`, 'Stay here'))) return false;
    }
    game.loadLevel(i);
    Term.focus();
    return true;
  }
  // Links like .../#oomkilled open that incident, even when only the hash changes.
  window.addEventListener('hashchange', async () => {
    const i = K.LEVELS.findIndex(L => '#' + L.id === location.hash);
    if (i < 0 || i === game.index) return;
    if (!(await switchLevel(i))) { try { history.replaceState(null, '', '#' + game.level.id); } catch (e) { /* ignore */ } }
  });

  /* ================= the incident pass ================= */
  const Slip = (() => {
    let key = '', lastStep = -1;
    function render() {
      const L = game.level;
      $('#pass').dataset.sev = L.sev;
      setText($('#pass-sev'), L.sev);
      setText($('#pass-num'), L.ticket);
      setText($('#pass-title'), L.title);
      setText($('#pass-tier'), `Tier ${L.tier}: ${K.TIERS[L.tier]}`);
      $('#pass-tags').replaceChildren(...L.tags.map(t => h('li', { text: t })));
      setText($('#alert'), L.alert);
      setText($('#story-text'), L.story);
      setText($('#concept-title'), L.concept.title);
      $('#concept-body').innerHTML = L.concept.body;
      $('#concept').open = L.tier <= 2;
      const st = $('#stamp'); st.hidden = true; st.classList.remove('in');
      $('#pass-col').scrollTop = 0;
      key = ''; lastStep = -1;
      renderSteps(); renderFiles();
    }
    function renderSteps() {
      const L = game.level, n = L.objectives.length, cur = Math.min(game.objIndex, n - 1);
      const k = [game.index, game.objIndex, game.completed, Array.from(game.hinted).join(','), Array.from(game.revealed).join(','), game.feedback || ''].join('|');
      if (k === key) return;
      key = k;
      const active = d.activeElement && $('#steps').contains(d.activeElement) ? d.activeElement.dataset.act : null;
      $('#pass-stars').replaceChildren(starsEl(game.stars));
      setText($('#steps-count'), game.completed ? `All ${n} done` : `Step ${cur + 1} of ${n}`);
      $('#term-goal').replaceChildren(...(game.completed
        ? [h('b', { text: 'Resolved.' }), `${L.ticket} is closed.`]
        : [h('b', { text: `Step ${cur + 1} of ${n}` }), h('span', { html: L.objectives[cur].text })]));
      const items = [];
      for (let i = 0; i <= cur; i++) {
        const ob = L.objectives[i];
        const done = i < game.objIndex;
        const body = h('div', { class: 'step-body' }, h('p', { class: 'step-text', html: ob.text }));
        if (!done) {
          if (game.feedback) body.append(h('p', { class: 'nudge', text: game.feedback }));
          const actions = h('div', { class: 'step-actions' });
          if (game.hinted.has(i)) body.append(h('p', { class: 'hint', text: ob.hint }));
          else actions.append(h('button', { type: 'button', class: 'btn-paper', 'data-act': 'hint', onclick: () => { game.hinted.add(i); renderSteps(); } }, 'Show hint'));
          if (game.revealed.has(i)) {
            const cmd = game.solutionCommand() || '';
            body.append(h('pre', { class: 'cmd' }, h('code', { text: cmd })));
            const pastable = cmd.split('\n').filter(l => l && !l.startsWith('(')).pop();
            if (pastable) actions.append(h('button', { type: 'button', class: 'btn-paper', 'data-act': 'paste', onclick: () => Term.setInput(pastable, true) }, 'Paste into terminal'));
          } else {
            const costs = starsFor(game.revealed.size + 1) < game.stars;
            actions.append(h('button', { type: 'button', class: 'btn-paper', 'data-act': 'reveal', onclick: () => game.reveal() }, costs ? 'Show command (−1 star)' : 'Show command'));
          }
          body.append(actions);
        }
        items.push(h('li', { class: 'step ' + (done ? 'is-done' : 'is-current') },
          h('span', { class: 'step-mark', 'aria-hidden': 'true', html: done ? ICON.done : String(i + 1) }),
          h('span', { class: 'sr-only', text: done ? 'Done: ' : 'Current step: ' }), body));
      }
      $('#steps').replaceChildren(...items);
      const more = n - cur - 1;
      setText($('#steps-more'), !game.completed && more > 0 ? (more === 1 ? 'One more step after this.' : `${more} more steps after this.`) : '');
      const after = $('#steps-after');
      after.hidden = !game.completed;
      if (game.completed) {
        const last = game.index === K.LEVELS.length - 1;
        after.replaceChildren(
          h('button', { type: 'button', class: 'btn', onclick: () => (last ? showFinale() : game.loadLevel(game.index + 1)) }, last ? 'End the shift' : 'Next incident'),
          h('button', { type: 'button', class: 'btn-paper', onclick: () => showComplete(game.index) }, 'Open the postmortem'));
      }
      if (active) { const b = $(`#steps [data-act="${active}"]`) || $('#steps .step-actions button'); if (b) b.focus(); }
      if (game.objIndex !== lastStep) { const moved = lastStep !== -1; lastStep = game.objIndex; if (moved) scrollToCurrent(); }
    }
    function scrollToCurrent() {
      const col = $('#pass-col');
      if (getComputedStyle(col).overflowY !== 'auto') return;
      const target = $('#steps .is-current') || $('#steps-after');
      if (!target) return;
      const cr = col.getBoundingClientRect(), tr = target.getBoundingClientRect();
      if (tr.top < cr.top || tr.bottom > cr.bottom) col.scrollTo({ top: col.scrollTop + tr.top - cr.top - 72, behavior: motionOK() ? 'smooth' : 'auto' });
    }
    function renderFiles() {
      const names = Array.from(game.files.keys()).sort();
      $('#files-wrap').hidden = !names.length;
      const ul = $('#files'), k = names.join('|');
      if (ul.dataset.k === k) return;
      ul.dataset.k = k;
      ul.replaceChildren(...names.map(n => h('li', null, h('button', { type: 'button', class: 'file-btn', onclick: () => Editor.open(n), 'aria-label': `Edit ${n}` },
        h('span', { html: ICON_FILE }), h('span', { text: n }), h('span', { class: 'file-act', text: 'Edit' })))));
    }
    function stamp() { const s = $('#stamp'); s.hidden = false; s.classList.remove('in'); void s.offsetWidth; if (motionOK()) s.classList.add('in'); }
    return { render, renderSteps, renderFiles, stamp };
  })();

  /* ================= dialogs: intro, postmortem, finale, about ================= */
  const LOGO = '<svg viewBox="0 0 32 32" aria-hidden="true"><circle cx="16" cy="16" r="4" fill="#e8364f"/><path d="M16 7.5a8.5 8.5 0 0 1 8.5 8.5M7.5 16A8.5 8.5 0 0 1 16 7.5" fill="none" stroke="#f08a24" stroke-width="2.4" stroke-linecap="round"/><path d="M16 3a13 13 0 0 1 13 13M3 16A13 13 0 0 1 16 3" fill="none" stroke="#6b3fc4" stroke-width="2.4" stroke-linecap="round"/></svg>';
  const mins = s => (s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${String(s % 60).padStart(2, '0')}s`);
  function showIntro() {
    const counts = {}; K.LEVELS.forEach(L => { counts[L.tier] = (counts[L.tier] || 0) + 1; });
    Dialog.show(h('div', null,
      h('p', { class: 'intro-mark', html: LOGO + '<span>Blast Radius</span>' }),
      h('h2', { text: 'You\'re on call for Stagedoor tonight' }),
      h('p', { text: 'Stagedoor sells tickets for concerts and festivals, and everything runs on Kubernetes. Each incident is a real production failure: something is broken, customers notice, and you have a terminal.' }),
      h('p', { text: 'Use kubectl the way you would on a real cluster. The cluster is simulated in your browser, so nothing you type can break anything real.' }),
      h('ul', { class: 'tiers' }, Object.keys(K.TIERS).map(t => h('li', null, h('b', { text: t }), h('span', { text: `${K.TIERS[t]}: ${counts[t]} incident${counts[t] > 1 ? 's' : ''}` })))),
      h('p', { class: 'dlg-fine', text: 'Early incidents walk you through the triage loop. Later ones only tell you what is on fire. Progress stays in this browser.' }),
      h('div', { class: 'dlg-actions' }, h('button', { class: 'btn', type: 'button', 'data-autofocus': '', onclick: () => Dialog.close() }, 'Take the pager'))),
    { onClose: () => { progress.data.intro = true; progress.save(); Term.focus(); } });
  }
  function showComplete(index) {
    if (index !== game.index || !game.completed) return;
    const L = K.LEVELS[index], stars = game.stars, last = index === K.LEVELS.length - 1;
    const imp = game.cluster.impact;
    const next = h('button', { class: 'btn', type: 'button', onclick: () => { Dialog.close(); if (last) showFinale(); else game.loadLevel(index + 1); } }, last ? 'End the shift' : 'Next incident');
    const q = L.postmortem;
    const result = h('p', { class: 'quiz-result', 'aria-live': 'polite' });
    const opts = h('div', { class: 'quiz-opts', role: 'group', 'aria-label': 'Answers' });
    q.options.forEach((o, i) => opts.append(h('button', {
      class: 'quiz-opt', type: 'button',
      onclick: () => {
        const ok = i === q.answer;
        Array.from(opts.children).forEach((b, j) => { b.disabled = true; if (j === q.answer) b.classList.add('is-right'); else if (j === i) b.classList.add('is-wrong'); });
        result.textContent = (ok ? 'Right. ' : 'Not quite. ') + q.explain;
        if (progress.data.quiz[L.id] == null) { progress.data.quiz[L.id] = ok; progress.save(); }
        next.focus();
      },
    }, o)));
    Dialog.show(h('div', null,
      h('div', { class: 'done-head' },
        h('div', null, h('p', { class: 'done-num', text: `${L.ticket} · ${L.sev} · ${L.title}` }), h('h2', { text: 'Postmortem', tabindex: '-1', 'data-autofocus': '' })),
        starsEl(stars, 'done-stars')),
      h('div', { class: 'stats' },
        h('div', { class: 'stat' }, h('b', { text: mins(game.elapsed) }), h('span', { text: 'time to resolve (cluster time)' })),
        h('div', { class: 'stat' }, h('b', { text: fmtN(imp.failed) }), h('span', { text: 'failed customer requests' })),
        h('div', { class: 'stat' }, h('b', { text: String(game.commands) }), h('span', { text: 'commands you ran' }))),
      h('p', { text: stars === 3 ? 'Resolved without revealing a single command.' : stars === 2 ? 'Resolved with a little help.' : 'Resolved with help. Replay it later to go for three stars.' }),
      h('h3', { text: 'What to remember' }),
      h('ul', null, L.learned.map(t => h('li', { text: t }))),
      h('div', { class: 'quiz' }, h('h3', { text: 'Root-cause review' }), h('p', { class: 'quiz-q', text: q.q }), opts, result),
      h('div', { class: 'dlg-actions' },
        h('button', { class: 'btn btn-ghost', type: 'button', onclick: () => { Dialog.close(); game.loadLevel(index); } }, 'Replay incident'),
        next)));
  }
  function showFinale() {
    const total = K.LEVELS.reduce((s, L) => s + (progress.data.stars[L.id] || 0), 0);
    const closed = K.LEVELS.filter(L => progress.data.stars[L.id]).length;
    const link = (href, text, note) => h('li', null, h('a', { href, target: '_blank', rel: 'noopener' }, text), ' ' + note);
    Dialog.show(h('div', null,
      h('p', { class: 'intro-mark', html: LOGO + '<span>Shift over</span>' }),
      h('p', { text: `You resolved ${closed} of ${K.LEVELS.length} incidents and earned ${total} of ${K.LEVELS.length * 3} stars. The farewell tour sold out, and checkout held.` }),
      h('p', { text: 'You worked the same loop every time: confirm the symptom, find what is unhealthy, ask Kubernetes why, ask the app why, follow the request path, mitigate, fix, verify.' }),
      h('h3', { text: 'Practise on a real cluster' }),
      h('ul', null,
        link('https://kind.sigs.k8s.io/docs/user/quick-start/', 'kind', 'runs a whole cluster inside Docker on your laptop.'),
        link('https://kubernetes.io/docs/tasks/debug/', 'Kubernetes: Monitoring, Logging, and Debugging', 'is the official troubleshooting guide.'),
        link('https://sre.google/sre-book/postmortem-culture/', 'Postmortem culture', 'from the Google SRE book, on learning from incidents.')),
      h('div', { class: 'dlg-actions' }, h('button', { class: 'btn', type: 'button', 'data-autofocus': '', onclick: () => Dialog.close() }, 'Back to the incidents'))));
  }
  function showAbout() {
    const keys = [['Enter', 'Run the command'], ['Tab', 'Complete commands and names'], ['↑ ↓', 'Browse earlier commands'], ['Ctrl+C', 'Stop watching, or clear the line'], ['Ctrl+L', 'Clear the screen'], ['Ctrl+S', 'Save the file you are editing'], ['Esc', 'Close the editor or this dialog']];
    Dialog.show(h('div', null,
      h('h2', { text: 'About Blast Radius' }),
      h('p', { text: 'Each incident starts with a healthy production cluster that something has broken. Read the alert and Rhea\'s briefing, work in the terminal, and watch the map and the customer-traffic meters react. Click a pod or a Service on the map to paste its name; hover a Service to see its endpoints.' }),
      h('h3', { text: 'Stuck?' }),
      h('p', { text: 'Type runbook for the triage loop, or hint for a nudge. Show command reveals the answer but lowers the incident\'s stars.' }),
      h('h3', { text: 'Keys' }),
      h('dl', null, keys.map(([k, v]) => [h('dt', { text: k }), h('dd', { text: v })])),
      h('h3', { text: 'How real is it?' }),
      h('p', { text: 'Nothing is scripted. The scheduler packs pods by requests and honours taints; the kubelet runs probes, enforces memory limits and evicts under pressure; Services, NetworkPolicies, DNS and the Ingress decide every request, including the simulated customer traffic. Output and error messages follow real kubectl. It is still a simulation: there is one container per pod that matters, and StatefulSets, Jobs and CRDs are not modelled.' }),
      h('p', { class: 'dlg-fine', text: 'Progress is saved in this browser only. Stagedoor is fictional. Kubernetes is a registered trademark of the Linux Foundation; this game is an independent project.' }),
      h('div', { class: 'dlg-actions' },
        h('button', { class: 'btn btn-ghost', type: 'button', onclick: async () => {
          if (await Dialog.ask('Reset all progress?', 'Stars and review answers for every incident will be cleared from this browser.', 'Reset progress', 'Cancel')) { progress.reset(); game.loadLevel(0); }
        } }, 'Reset progress'),
        h('button', { class: 'btn', type: 'button', 'data-autofocus': '', onclick: () => Dialog.close() }, 'Back to the incident'))),
    { onClose: () => { if (!Editor.isOpen()) Term.focus(); } });
  }

  /* ================= wiring ================= */
  game.on('level', () => {
    progress.data.last = game.index;
    progress.save();
    try { history.replaceState(null, '', '#' + game.level.id); } catch (e) { /* file:// in some browsers */ }
    d.title = `${game.level.ticket}: ${game.level.title} | Blast Radius`;
    Editor.forceClose();
    Pager.hide();
    Slip.render();
    Rail.render();
    MapView.reset();
    Term.reset();
  });
  game.on('objective', i => {
    Slip.renderSteps();
    const L = game.level;
    if (i < L.objectives.length - 1) {
      const next = plain(L.objectives[i + 1].text);
      later(() => {
        Term.print([{ t: `✓ Step ${i + 1} done. Next: ${next}`, c: 'ok', wrap: true }]);
        announce(`Step ${i + 1} done. Next: ${next}`);
      });
    }
  });
  game.on('complete', info => {
    const L = K.LEVELS[info.index];
    progress.data.stars[L.id] = Math.max(progress.data.stars[L.id] || 0, info.stars);
    progress.save();
    later(() => {
      Term.print([{ t: `✓ Resolved. ${L.ticket} is closed. Open the postmortem when you're ready.`, c: 'ok', wrap: true }]);
      announce(`${L.ticket} resolved with ${info.stars} of 3 stars.`);
    });
    Slip.renderSteps();
    Slip.stamp();
    Rail.render();
    setTimeout(() => { if (!Dialog.isOpen()) showComplete(info.index); }, 1400);
  });
  game.on('feedback', () => Slip.renderSteps());
  game.on('reveal', () => Slip.renderSteps());
  game.on('page', p => {
    Pager.show(p);
    later(() => {
      Term.print([{ t: `[page] ${p.title}. ${p.body}`, c: 'warn', wrap: true }]);
      announce(`Page: ${p.title}. ${p.body}`);
    });
  });

  let fast = false, timer = 0;
  function schedule() { clearInterval(timer); timer = setInterval(tick, fast ? Math.round(BASE_TICK / 3) : BASE_TICK); }
  function tick() {
    if (d.hidden) return;
    try { game.tick(); } catch (e) { console.error(e); }
    Term.onTick();
    MapView.render();
    Slip.renderSteps();
  }
  $('#ff').addEventListener('click', e => {
    fast = !fast;
    e.currentTarget.setAttribute('aria-pressed', String(fast));
    schedule();
  });
  $('#about-btn').addEventListener('click', showAbout);

  let start = Math.min(Number(progress.data.last) || 0, K.LEVELS.length - 1);
  const fromHash = K.LEVELS.findIndex(L => '#' + L.id === location.hash);
  if (fromHash >= 0) start = fromHash;
  game.loadLevel(start);
  schedule();
  if (!progress.data.intro) showIntro();
  else if (finePointer()) Term.focus();

  window.blastRadius = { game, tick, render: () => MapView.render() };
  $('#term-runbook').addEventListener('click', () => { Term.run('runbook'); Term.focus(); });
})(window.K = window.K || {});
