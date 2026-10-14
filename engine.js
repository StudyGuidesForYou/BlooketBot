/* ============================================================
   Blooket Control Panel — engine.js
   Match-side logic. Binds to index.html's data-* contract.

   Architecture layered on community-standard techniques:
     • React fiber traversal (reactHandler pattern)
     • Firebase RTDB writes via liveGameController.setVal()
     • Webpack auth extraction (blooketBuild + secret)
     • AES-GCM payload encryption for API calls
     • Rate-limited API requests (750ms default)
     • Mode detection from URL path
     • Dual-path answer access (memoizedState → memoizedProps)
     • Multi-client bot spam (parallel join workers)

   Public surface: window.BP
     BP.state              live state
     BP.log / BP.toast     UI feedback
     BP.actions            action registry
     BP.react              React helpers
     BP.firebase           RTDB helpers
     BP.auth               webpack extraction + encryption
     BP.mode               current game mode
     BP.blooks             catalog helpers
     BP.overrides          direct manipulation
     BP.spam               multi-client join workers
     BP.doctor()           diagnostic
   ============================================================ */

(() => {
  'use strict';

  const $  = (s, r = document) => r.querySelector(s);
  const $$ = (s, r = document) => [...r.querySelectorAll(s)];
  const sleep = ms => new Promise(r => setTimeout(r, ms));

  const safe = (label, fn, fb) => {
    try { return fn(); }
    catch (e){ try { log('err', label, String(e.message || e)); } catch {} return fb; }
  };

  const store = {
    get(k){ try { return localStorage.getItem(k); } catch { return null; } },
    set(k,v){ try { localStorage.setItem(k,v); } catch {} },
    del(k){ try { localStorage.removeItem(k); } catch {} }
  };

  /* ============================================================
     1. STATE
     ============================================================ */
  const state = {
    inGame: false,
    session: { pin:'', name:'', blook:null, hostId:'' },
    running: { autoAnswer:false, autoBot:false, grind:false, unkickable:false, realtime:false },
    timers:  { autoAnswer:null, realtime:null, spam:null },
    logFilter: 'all',
    logSearch: '',
    catalog: [],
    catalogSource: '',
    pickedBlook: null,
    reactPath: '',
    mode: 'unknown',
    spamWorkers: [],
    startedAt: Date.now()
  };

  /* ============================================================
     2. LOGGER + TOASTS
     ============================================================ */
  const logEl   = $('[data-role="log"]');
  const toastEl = $('[data-role="toasts"]');

  function stamp(){
    const d = new Date();
    return [d.getHours(), d.getMinutes(), d.getSeconds()]
      .map(n => String(n).padStart(2,'0')).join(':');
  }

  function log(kind, tag, msg){
    try {
      if (!logEl) throw 0;
      const p = document.createElement('p');
      p.dataset.kind = kind;
      p.dataset.text = `${tag} ${msg}`.toLowerCase();
      p.innerHTML = `<span class="t">${stamp()}</span><span class="tag ${kind}">[${tag}]</span>${msg}`;
      logEl.appendChild(p);
      logEl.scrollTop = logEl.scrollHeight;
      applyFilter();
    } catch {
      const fn = kind === 'err' ? 'error' : kind === 'warn' ? 'warn' : 'log';
      try { console[fn](`[${tag}]`, msg); } catch {}
    }
  }

  function toast(kind, title, body){
    try {
      if (!toastEl) throw 0;
      const el = document.createElement('div');
      el.className = `toast ${kind}`;
      el.innerHTML = `<strong>${title}</strong><span>${body || ''}</span>`;
      toastEl.appendChild(el);
      setTimeout(() => {
        el.style.opacity = '0';
        el.style.transform = 'translateX(20px)';
        setTimeout(() => el.remove(), 220);
      }, 3600);
    } catch { try { console.log(`[toast:${kind}] ${title}`); } catch {} }
  }

  function applyFilter(){
    try {
      const f = state.logFilter, q = state.logSearch;
      $$('[data-role="log"] p').forEach(p => {
        const kindOk   = (f === 'all' || p.dataset.kind === f);
        const searchOk = !q || (p.dataset.text || '').includes(q);
        p.style.display = (kindOk && searchOk) ? '' : 'none';
      });
    } catch {}
  }

  /* ============================================================
     3. STATS
     ============================================================ */
  function setStat(key, val){
    const el = $(`[data-stat="${key}"]`);
    if (el) el.textContent = val;
  }

  setInterval(() => {
    const s  = Math.floor((Date.now() - state.startedAt) / 1000);
    const hh = String(Math.floor(s / 3600)).padStart(2,'0');
    const mm = String(Math.floor(s % 3600 / 60)).padStart(2,'0');
    const ss = String(s % 60).padStart(2,'0');
    setStat('uptime', `${hh}:${mm}:${ss}`);
  }, 1000);

  /* ============================================================
     4. MODE DETECTION
     ============================================================ */
  const MODE_MAP = {
    'gold':        { currency:['gold','gold2'],      label:'Gold Quest' },
    'crypto':      { currency:['crypto','crypto2'],  label:'Crypto Hack' },
    'factory':     { currency:['cash'],              label:'Factory' },
    'fishing':     { currency:['weight','weight2'],  label:'Fishing Frenzy' },
    'cafe':        { currency:['cafeCash'],          label:'Café' },
    'kingdom':     { currency:['materials','gold'],  label:'Crazy Kingdom' },
    'tower':       { currency:['cash'],              label:'Tower Defense' },
    'racing':      { currency:['progress'],          label:'Racing' },
    'rush':        { currency:['defense','blooks'],  label:'Blook Rush' },
    'brawl':       { currency:[],                    label:'Brawl' },
    'dino':        { currency:['fossils'],           label:'Deceptive Dinos' }
  };

  function detectMode(){
    try {
      const path = location.pathname.toLowerCase();
      for (const key of Object.keys(MODE_MAP)){
        if (path.includes(key)){ state.mode = key; return MODE_MAP[key]; }
      }
      const g = getGameState();
      const client = g?.client;
      if (client?.gameMode) for (const key of Object.keys(MODE_MAP)){
        if (String(client.gameMode).toLowerCase().includes(key)){ state.mode = key; return MODE_MAP[key]; }
      }
    } catch {}
    state.mode = 'unknown';
    return null;
  }

  function modeInfo(){ return MODE_MAP[state.mode] || null; }

  /* ============================================================
     5. REACT FIBER ACCESS
     ============================================================ */

  let _cachedNode = null;
  let _lastScan   = 0;

  const REACT_ROOTS = ['#app', '#root', '[data-reactroot]', '#__next', 'main', 'body > div', 'body'];

  function findFiber(el){
    if (!el) return null;
    try {
      for (const k in el){
        if (k.startsWith('__reactFiber$') || k.startsWith('__reactInternalInstance$'))
          return el[k];
      }
    } catch {}
    return null;
  }

  function looksLikeGameNode(sn){
    if (!sn || typeof sn !== 'object') return false;
    try {
      if (typeof sn.onAnswer === 'function') return true;
      if (sn.props?.client) return true;
      if (sn.props?.game)   return true;
      if (sn.props?.liveGameController) return true;
      if (sn.state?.client) return true;
      if (sn.state?.game)   return true;
    } catch {}
    return false;
  }

  function walkUpFromFiber(fiber, maxHops = 200){
    let cur = fiber, hops = 0;
    while (cur && hops++ < maxHops){
      if (looksLikeGameNode(cur.stateNode)) return cur.stateNode;
      cur = cur.return;
    }
    return null;
  }

  function scanAllElements(){
    try {
      const all = document.querySelectorAll('*');
      for (let i = 0; i < all.length; i++){
        const fiber = findFiber(all[i]);
        if (!fiber) continue;
        const sn = walkUpFromFiber(fiber);
        if (sn) return sn;
      }
    } catch {}
    return null;
  }

  function tryDevtoolsHook(){
    try {
      const hook = window.__REACT_DEVTOOLS_GLOBAL_HOOK__;
      if (!hook?.renderers) return null;
      for (const [id, renderer] of hook.renderers){
        const roots = renderer?.getFiberRoots?.(id);
        if (!roots) continue;
        for (const r of roots){
          const sn = walkUpFromFiber(r.current);
          if (sn) return sn;
        }
      }
    } catch {}
    return null;
  }

  // Community-standard reactHandler pattern: #app > div > div → children[0]._owner.stateNode
  function tryClassicPath(){
    try {
      const el = Object.values(document.querySelector('#app > div > div'))[1]?.children?.[0]?._owner?.stateNode;
      if (looksLikeGameNode(el)) return el;
    } catch {}
    try {
      const el = Object.values(document.querySelector('body div[id] > div > div'))[1]
        ?.children?.[0]?._owner?.stateNode;
      if (looksLikeGameNode(el)) return el;
    } catch {}
    return null;
  }

  function getReactNode(opts = {}){
    if (_cachedNode && looksLikeGameNode(_cachedNode)) return _cachedNode;
    _cachedNode = null;

    // 1. classic community path (fastest)
    const classic = tryClassicPath();
    if (classic){ _cachedNode = classic; state.reactPath = 'classic'; return classic; }

    // 2. known roots
    for (const sel of REACT_ROOTS){
      const el = document.querySelector(sel);
      if (!el) continue;
      const fiber = findFiber(el);
      if (!fiber) continue;
      const sn = walkUpFromFiber(fiber);
      if (sn){ _cachedNode = sn; state.reactPath = `root:${sel}`; return sn; }
    }

    // 3. devtools hook
    const dev = tryDevtoolsHook();
    if (dev){ _cachedNode = dev; state.reactPath = 'devtools'; return dev; }

    // 4. full scan (throttled)
    if (opts.scan !== false && Date.now() - _lastScan > 4000){
      _lastScan = Date.now();
      const sn = scanAllElements();
      if (sn){ _cachedNode = sn; state.reactPath = 'scan'; return sn; }
    }
    return null;
  }

  function getGameState(){
    const node = getReactNode();
    if (!node) return null;
    return {
      node,
      client: node.state?.client || node.props?.client || null,
      game:   node.state?.game   || node.props?.game   || null,
      controller: node.props?.liveGameController || node.state?.liveGameController || null
    };
  }

  /* ============================================================
     6. FIREBASE RTDB  —  the layer that actually syncs multiplayer
     ============================================================ */
  const firebase = {
    _getController(){
      const g = getGameState();
      return g?.controller || g?.node?.props?.liveGameController || null;
    },

    available(){
      return !!this._getController();
    },

    setVal(path, val){
      const ctrl = this._getController();
      if (!ctrl?.setVal){ log('warn','firebase','No liveGameController.setVal.'); return false; }
      try {
        ctrl.setVal({ path, val });
        return true;
      } catch (e){ log('err','firebase', e.message); return false; }
    },

    removeVal(path){
      const ctrl = this._getController();
      if (!ctrl?.removeVal) return false;
      try { ctrl.removeVal(path); return true; }
      catch (e){ log('err','firebase', e.message); return false; }
    },

    getDatabaseVal(path){
      const ctrl = this._getController();
      if (!ctrl?.getDatabaseVal) return Promise.resolve(null);
      return new Promise(resolve => {
        try {
          ctrl.getDatabaseVal(path, data => resolve(data));
          setTimeout(() => resolve(null), 3000);
        } catch { resolve(null); }
      });
    },

    // Player self-write: pushes a subset of {b, cr, g, d, bs, p, tat} under c/<name>
    writeSelf(fields){
      const g = getGameState();
      const name = g?.client?.name;
      if (!name){ log('err','firebase','No client name.'); return false; }
      const payload = { b: g.client.blook || 'Chick', ...fields };
      return this.setVal(`c/${name}`, payload);
    },

    // Full player write for arbitrary target: builds a merged record
    writePlayer(targetName, fields){
      if (!targetName){ log('err','firebase','No target.'); return false; }
      return this.setVal(`c/${targetName}`, fields);
    },

    async listPlayers(){
      const data = await this.getDatabaseVal('c');
      return data ? Object.keys(data) : [];
    }
  };

  /* ============================================================
     7. WEBPACK AUTH EXTRACTION + ENCRYPTION
     ============================================================ */
  const auth = {
    _cache: null,

    async extract(force){
      if (this._cache && !force) return this._cache;
      try {
        let blooketBuild = '', secret = '';

        // Strategy 1: webpackJsonp module scan
        try {
          const chunks = window.webpackJsonp || [];
          const modules = chunks.map(c => Object.keys(c[1] || {}).map(k => c[1][k]))
                                .reduce((a,b) => [...a, ...b], []);
          const hit = modules.find(m => {
            try {
              const s = m.toString();
              return /\w{8}-\w{4}-\w{4}-\w{4}-\w{12}/.test(s)
                  && /\(new TextEncoder\)\.encode\("(.+?)"\)/.test(s);
            } catch { return false; }
          });
          if (hit){
            const s = hit.toString();
            blooketBuild = s.match(/\w{8}-\w{4}-\w{4}-\w{4}-\w{12}/)?.[0] || '';
            secret       = s.match(/\(new TextEncoder\)\.encode\("(.+?)"\)/)?.[1] || '';
          }
        } catch {}

        // Strategy 2: script text scan
        if (!blooketBuild || !secret){
          const text = [...document.scripts].map(s => s.textContent || '').join('\n');
          blooketBuild = blooketBuild || text.match(/"blooketBuild"\s*:\s*"([^"]+)"/)?.[1] || '';
          secret       = secret       || text.match(/"secret"\s*:\s*"([^"]+)"/)?.[1] || '';
        }

        // Strategy 3: HTML scan
        if (!blooketBuild || !secret){
          const html = document.documentElement.innerHTML;
          blooketBuild = blooketBuild || html.match(/"blooketBuild"\s*:\s*"([^"]+)"/)?.[1] || '';
          secret       = secret       || html.match(/"secret"\s*:\s*"([^"]+)"/)?.[1] || '';
        }

        if (blooketBuild && secret){
          this._cache = { blooketBuild, secret };
          log('ok','auth',`Extracted build ${blooketBuild.slice(0,8)}…`);
          return this._cache;
        }
        log('warn','auth','Could not extract build/secret.');
        return null;
      } catch (e){ log('err','auth', e.message); return null; }
    },

    async encrypt(payload){
      const v = await this.extract();
      if (!v) return null;
      const iv = crypto.getRandomValues(new Uint8Array(12));
      const kb = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(v.secret));
      const key = await crypto.subtle.importKey('raw', kb, { name:'AES-GCM' }, false, ['encrypt']);
      const data = new TextEncoder().encode(JSON.stringify(payload));
      const enc = new Uint8Array(await crypto.subtle.encrypt({ name:'AES-GCM', iv }, key, data));
      const out = new Uint8Array(iv.length + enc.length);
      out.set(iv, 0); out.set(enc, iv.length);
      return {
        build: v.blooketBuild,
        data: btoa(String.fromCharCode(...out))
      };
    }
  };

  /* ============================================================
     8. RATE-LIMITED API CLIENT
     ============================================================ */
  const api = {
    _lastCall: 0,
    _minGap: 750,

    async put(url, payload){
      const wait = Math.max(0, this._minGap - (Date.now() - this._lastCall));
      if (wait > 0) await sleep(wait);
      this._lastCall = Date.now();

      const enc = await auth.encrypt(payload);
      if (!enc){ log('err','api','Encryption failed.'); return null; }

      try {
        const r = await fetch(url, {
          method: 'PUT',
          credentials: 'include',
          headers: {
            'Content-Type':'application/json',
            'X-Blooket-Build': enc.build
          },
          body: JSON.stringify({ data: enc.data })
        });
        if (!r.ok){ log('warn','api',`${url} → ${r.status}`); return null; }
        return await r.json().catch(() => ({}));
      } catch (e){ log('err','api', e.message); return null; }
    }
  };

  /* ============================================================
     9. ANSWER —  dual-path (memoizedState + memoizedProps)
     ============================================================ */
  function pickCorrect(q){
    if (!q) return null;
    const list = q.correctAnswers || q.correct || q.answers || q.options;
    if (Array.isArray(list) && list.length){
      const first = list[0];
      return typeof first === 'string' ? first : (first?.text || first?.answer || null);
    }
    return q.answer || q.correct || null;
  }

  function getQuestion(){
    const g = getGameState();
    if (!g) return null;
    // Racing pattern: check memoizedState first
    try {
      const ms = g.node.memoizedState;
      if (ms?.question?.correctAnswers?.length) return ms.question;
    } catch {}
    try {
      const mp = g.node.memoizedProps;
      if (mp?.client?.question?.correctAnswers?.length) return mp.client.question;
    } catch {}
    return g.client?.question || null;
  }

  function clickAnswerInDom(ans){
    if (!ans) return false;
    const target = String(ans).trim();
    const btns = document.querySelectorAll('button, [role="button"], [class*="answer"], [class*="choice"]');
    for (const b of btns){
      if ((b.textContent || '').trim() === target){ b.click(); return true; }
    }
    return false;
  }

  function tryAnswer(){
    const g = getGameState();
    if (!g) return false;
    const q   = getQuestion();
    const ans = pickCorrect(q);
    if (!ans) return false;

    // 1. node.onAnswer
    if (typeof g.node.onAnswer === 'function'){
      try { g.node.onAnswer(true, ans); return ans; } catch {}
    }
    // 2. props.onAnswer
    if (typeof g.node.props?.onAnswer === 'function'){
      try { g.node.props.onAnswer(true, ans); return ans; } catch {}
    }
    // 3. client.onAnswer
    if (typeof g.client?.onAnswer === 'function'){
      try { g.client.onAnswer(true, ans); return ans; } catch {}
    }
    // 4. game.onAnswer
    if (typeof g.game?.onAnswer === 'function'){
      try { g.game.onAnswer(g.client?.name, ans); return ans; } catch {}
    }
    // 5. DOM click
    if (clickAnswerInDom(ans)) return ans;
    return false;
  }

  /* ============================================================
     10. STATE POLLER + REAL-TIME LEADERBOARD
     ============================================================ */
  setInterval(() => {
    const g = getGameState();
    if (!g){ state.inGame = false; return; }

    state.inGame = true;
    if (state.mode === 'unknown') detectMode();

    const me = g.game?.players?.[g.client?.name] || g.client;
    if (me?.score != null) setStat('score', me.score);

    const players = Object.values(g.game?.players || {});
    if (players.length){
      const sorted = players.slice().sort((a,b) => (b.score||0) - (a.score||0));
      const idx = sorted.findIndex(p => p.name === g.client?.name);
      setStat('rank', idx >= 0 ? `#${idx + 1}` : '—');
    }

    const q = getQuestion();
    if (q){
      const total = q.answers?.length || q.options?.length || 0;
      setStat('question', total ? `${q.answeredCount || 0}/${total}` : '—');
    }

    const s = $('[data-role="status"]');
    if (s && state.session.name) s.textContent = `In game — ${state.session.name}`;
  }, 1000);

  async function refreshLeaderboard(){
    const players = await firebase.listPlayers();
    if (!players.length) return;
    const data = await firebase.getDatabaseVal('c');
    const rows = Object.entries(data || {}).map(([name, v]) => ({
      name,
      crypto: Number(v.cr) || 0,
      blooks: Number(v.bs) || 0,
      defense: Number(v.d) || 0
    })).sort((a,b) => b.crypto - a.crypto);

    if (rows.length){
      setStat('rank', `#${rows.findIndex(r => r.name === state.session.name) + 1 || '—'}`);
      if (rows[0]?.name === state.session.name) setStat('score', rows[0].crypto);
    }
  }

  function startRealtime(){
    if (state.timers.realtime) clearInterval(state.timers.realtime);
    state.running.realtime = true;
    state.timers.realtime = setInterval(() => {
      refreshLeaderboard().catch(() => {});
    }, 2000);
    log('info','realtime','Live leaderboard polling every 2s.');
  }

  function stopRealtime(){
    clearInterval(state.timers.realtime);
    state.timers.realtime = null;
    state.running.realtime = false;
    log('warn','realtime','Stopped.');
  }

  /* ============================================================
     11. BLOOK CATALOG
     ============================================================ */
  const STATIC_BLOOKS = [
    { name:'Chick',pack:'Farm',rarity:'Common' },{ name:'Chicken',pack:'Farm',rarity:'Uncommon' },
    { name:'Cow',pack:'Farm',rarity:'Rare' },{ name:'Pig',pack:'Farm',rarity:'Uncommon' },
    { name:'Sheep',pack:'Farm',rarity:'Rare' },{ name:'Goat',pack:'Farm',rarity:'Epic' },
    { name:'Horse',pack:'Farm',rarity:'Epic' },{ name:'Duck',pack:'Farm',rarity:'Legendary' },
    { name:'Dog',pack:'Pets',rarity:'Common' },{ name:'Cat',pack:'Pets',rarity:'Uncommon' },
    { name:'Rabbit',pack:'Pets',rarity:'Rare' },{ name:'Fox',pack:'Pets',rarity:'Epic' },
    { name:'Owl',pack:'Pets',rarity:'Legendary' },{ name:'Penguin',pack:'Arctic',rarity:'Rare' },
    { name:'Polar Bear',pack:'Arctic',rarity:'Epic' },{ name:'Snowman',pack:'Arctic',rarity:'Legendary' },
    { name:'Panda',pack:'Animals',rarity:'Epic' },{ name:'Tiger',pack:'Animals',rarity:'Epic' },
    { name:'Lion',pack:'Animals',rarity:'Legendary' },{ name:'King',pack:'Medieval',rarity:'Chromatic' },
    { name:'Frog',pack:'Aquatic',rarity:'Common' },{ name:'Fish',pack:'Aquatic',rarity:'Rare' },
    { name:'Octopus',pack:'Aquatic',rarity:'Epic' },{ name:'Whale',pack:'Aquatic',rarity:'Legendary' }
  ];

  async function tryApiCatalog(){
    const urls = [
      'https://api.blooket.com/api/blooks',
      'https://api.blooket.com/api/blooks/all',
      'https://api.blooket.com/api/store'
    ];
    for (const url of urls){
      for (const creds of ['omit','include']){
        try {
          const r = await fetch(url, { credentials: creds });
          if (!r.ok) continue;
          const j = await r.json();
          const out = normalizeCatalog(j);
          if (out.length) return { source:`api:${url}:${creds}`, items: out };
        } catch {}
      }
    }
    return null;
  }

  function tryEmbeddedCatalog(){
    try {
      const scripts = [...document.scripts].map(s => s.textContent || '').join('\n');
      const m = scripts.match(/["']blooks["']\s*:\s*(\{[\s\S]{50,20000}?\})\s*[,}]/);
      if (!m) return null;
      const obj = JSON.parse(m[1]);
      const out = normalizeCatalog(obj);
      if (out.length) return { source:'embedded', items: out };
    } catch {}
    return null;
  }

  function tryCachedCatalog(){
    const raw = store.get('blk-catalog-cache');
    if (!raw) return null;
    try { const out = JSON.parse(raw); if (Array.isArray(out) && out.length) return { source:'cache', items: out }; }
    catch {}
    return null;
  }

  function normalizeCatalog(j){
    const out = [], seen = new Set();
    for (const [pack, arr] of Object.entries(j || {})){
      if (!Array.isArray(arr)) continue;
      for (const b of arr){
        if (!b || typeof b !== 'object') continue;
        const name = b.name || b.blook || b.id;
        if (!name || seen.has(name)) continue;
        seen.add(name);
        out.push({
          id: b._id || b.id || name, name,
          pack: b.pack || pack,
          rarity: b.rarity || b.quality || b.tier || '',
          color: b.color || b.hex || '#7d8899'
        });
      }
    }
    out.sort((a,b) => a.name.localeCompare(b.name));
    return out;
  }

  async function loadCatalog(){
    let result = await tryApiCatalog();
    if (!result) result = tryEmbeddedCatalog();
    if (!result) result = tryCachedCatalog();
    if (!result){
      result = { source:'static', items: normalizeCatalog({ 'Built-in': STATIC_BLOOKS }) };
      log('warn','blooks','Live catalog unavailable — using built-in list.');
    } else {
      store.set('blk-catalog-cache', JSON.stringify(result.items));
    }
    state.catalog = result.items;
    state.catalogSource = result.source;
    renderBlooks();
    log('ok','blooks',`Catalog — ${result.items.length} (${result.source}).`);
    toast('ok','Catalog',`${result.items.length} blooks · ${result.source}`);
  }

  function renderBlooks(){
    const grid = $('[data-role="blook-grid"]');
    if (!grid) return;
    const q = ($('[data-field="blookSearch"]')?.value || '').toLowerCase().trim();
    const items = state.catalog.filter(b =>
      !q || b.name.toLowerCase().includes(q) || (b.pack || '').toLowerCase().includes(q));

    grid.innerHTML = '';
    for (const b of items.slice(0, 500)){
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'blook' + (state.pickedBlook?.id === b.id ? ' is-picked' : '');
      btn.dataset.action = 'pick';
      btn.dataset.blookId = b.id;
      btn.dataset.blookName = b.name;
      btn.innerHTML = `
        <span class="blook-dot" style="--c:${b.color}"></span>
        <span>${b.name}</span>
        ${b.rarity ? `<small>${b.rarity}</small>` : ''}
      `;
      grid.appendChild(btn);
    }
  }

  function setPickedBlook(id, name){
    state.pickedBlook = { id, name };
    const label = $('[data-role="blook-selected"]');
    if (label) label.textContent = name;
    const joinField = $('[data-field="blook"]');
    if (joinField) joinField.value = name;
    renderBlooks();
  }

  /* ============================================================
     12. IDENTITY GENERATOR
     ============================================================ */
  const WORDS = ['Falcon','Tiger','Comet','Nova','Ember','Echo','Rogue','Zenith',
                 'Pixel','Vortex','Quark','Lynx','Onyx','Rift','Cinder','Saber',
                 'Prism','Halo','Kite','Wisp','Drift','Frost','Bolt','Rune'];
  const LEET  = { a:'4', e:'3', i:'1', o:'0', s:'5', t:'7' };

  function generateIdentity(pattern){
    try {
      const w = WORDS[Math.floor(Math.random() * WORDS.length)] || 'Blook';
      if (pattern === 'leetword') return w.toLowerCase().split('').map(c => LEET[c] || c).join('');
      if (pattern === 'short'){
        const chars = 'abcdefghijklmnopqrstuvwxyz';
        let s = '';
        for (let i = 0; i < 6; i++) s += chars[Math.floor(Math.random() * chars.length)];
        return s;
      }
      return `${w}${Math.floor(Math.random() * 9000 + 1000)}`;
    } catch { return `Blook${Date.now() % 100000}`; }
  }

  /* ============================================================
     13. OVERRIDES  —  Firebase-first, React second, DOM last
     ============================================================ */
  function currentClient(g){ return g.node.state?.client || g.node.props?.client; }
  function currentGame(g)  { return g.node.state?.game   || g.node.props?.game;   }
  function currentPlayers(g){
    const game = currentGame(g);
    return game?.players || game?.playerMap || {};
  }

  function setScore(target, value){
    const g = getGameState();
    if (!g){ log('err','score','No game attached.'); return false; }
    const players = currentPlayers(g);
    const key = String(target || currentClient(g)?.name || '').trim();
    if (!key || !players[key]){ log('err','score',`Player "${key || '?'}" not found.`); return false; }
    const n = Number(value);
    const v = Number.isFinite(n) ? n : value;

    // Firebase write first — everyone sees it
    const client = currentClient(g);
    if (firebase.available() && client?.name){
      firebase.writeSelf({ b: client.blook, cr: v, tat: `${key}:${v}` });
    }
    // React setState for local UI
    try {
      players[key].score = v;
      g.node.setState({ game: { ...currentGame(g), players } });
      log('ok','score',`${key} → ${v}`); return true;
    } catch {}
    try {
      const gp = g.node.props?.game;
      if (gp?.players?.[key]){ gp.players[key].score = v; log('ok','score',`${key} → ${v} (props)`); return true; }
    } catch {}
    log('err','score','All methods failed.'); return false;
  }

  function setName(value){
    const g = getGameState();
    if (!g) return false;
    const client = currentClient(g);
    const oldName = client?.name;

    try {
      g.node.setState?.({ client: { ...client, name: value } });
      state.session.name = value;
      log('ok','name',`→ ${value}`); return true;
    } catch {}

    // Firebase path migration: move c/<oldName> → c/<newName>
    if (firebase.available() && oldName){
      (async () => {
        try {
          const data = await firebase.getDatabaseVal(`c/${oldName}`);
          if (data){
            await firebase.setVal(`c/${value}`, data);
            firebase.removeVal(`c/${oldName}`);
          }
        } catch {}
      })();
    }

    if (typeof g.node.setName === 'function'){
      try { g.node.setName(value); log('ok','name',`→ ${value} (method)`); return true; } catch {}
    }
    const inp = document.querySelector('input[name="name"], input[placeholder*="name" i]');
    if (inp){
      inp.value = value;
      inp.dispatchEvent(new Event('input', { bubbles:true }));
      log('ok','name',`→ ${value} (DOM)`); return true;
    }
    log('err','name','All methods failed.'); return false;
  }

  function setCurrency(target, value){
    const g = getGameState();
    if (!g) return false;
    const players = currentPlayers(g);
    const key = String(target || currentClient(g)?.name || '').trim();
    if (!key || !players[key]){ log('err','currency',`Player "${key || '?'}" not found.`); return false; }

    const n = Number(value);
    const v = Number.isFinite(n) ? n : value;
    const fields = ['crypto','crypto2','gold','gold2','cash','weight','weight2',
                    'cafeCash','materials','points','coins','money','fossils'];

    let touched = false;
    for (const f of fields){
      if (f in players[key]){ players[key][f] = v; touched = true; }
    }
    if (!touched) players[key].gold = v;

    // Firebase write — critical for multiplayer visibility
    const client = currentClient(g);
    if (firebase.available() && client?.name){
      const info = modeInfo();
      const primary = info?.currency?.[0] || 'cr';
      const pathKey = { crypto:'cr', gold:'g', cash:'ca', weight:'w',
                        cafeCash:'cc', materials:'m', fossils:'fo' }[primary] || primary;
      firebase.writeSelf({ b: client.blook, [pathKey]: v });
    }

    try {
      g.node.setState({ game: { ...currentGame(g), players } });
      log('ok','currency',`${key} → ${v}`); return true;
    } catch {}
    try {
      const gp = g.node.props?.game;
      if (gp?.players?.[key]){ for (const f of fields) if (f in gp.players[key]) gp.players[key][f] = v; return true; }
    } catch {}
    log('err','currency','All methods failed.'); return false;
  }

  function sendChat(value){
    const g = getGameState();
    if (!g) return false;
    if (typeof g.node.sendChat === 'function'){
      try { g.node.sendChat(value); log('ok','chat', value); return true; } catch {}
    }
    if (typeof g.node.props?.sendChat === 'function'){
      try { g.node.props.sendChat(value); log('ok','chat', value); return true; } catch {}
    }
    try {
      const game = currentGame(g);
      if (game){
        game.chat = [...(game.chat || []), { name: currentClient(g)?.name, text: value }];
        g.node.setState({ game: { ...game } });
        log('ok','chat', value); return true;
      }
    } catch {}
    const inp = document.querySelector('input[placeholder*="chat" i], input[placeholder*="message" i]');
    if (inp){
      inp.value = value;
      inp.dispatchEvent(new Event('input', { bubbles:true }));
      const form = inp.closest('form');
      if (form) form.requestSubmit?.();
      else inp.dispatchEvent(new KeyboardEvent('keydown', { key:'Enter', bubbles:true }));
      log('ok','chat',`${value} (DOM)`); return true;
    }
    log('warn','chat','No chat handler — logged only.');
    return false;
  }

  function kickPlayer(name){
    const g = getGameState();
    if (!g) return false;
    const players = currentPlayers(g);
    if (!players[name]){ log('err','kick',`"${name}" not found.`); return false; }

    if (typeof g.node.kickPlayer === 'function'){
      try { g.node.kickPlayer(name); log('ok','kick',`Removed ${name}`); return true; } catch {}
    }
    try {
      const copy = { ...players };
      delete copy[name];
      g.node.setState({ game: { ...currentGame(g), players: copy } });
      log('ok','kick',`Removed ${name}`); return true;
    } catch {}
    try {
      const gp = g.node.props?.game;
      if (gp?.players){ delete gp.players[name]; log('ok','kick',`Removed ${name} (props)`); return true; }
    } catch {}
    log('err','kick','All methods failed.'); return false;
  }

  function setTimer(seconds){
    const g = getGameState();
    if (!g) return false;
    const n = Number(seconds) || 0;
    try { g.node.setState?.({ time: n }); log('ok','timer',`→ ${n}s`); return true; } catch {}
    if (typeof g.node.setTime === 'function'){
      try { g.node.setTime(n); log('ok','timer',`→ ${n}s (method)`); return true; } catch {}
    }
    const cl = currentClient(g);
    if (cl){ cl.time = n; log('ok','timer',`→ ${n}s (property)`); return true; }
    log('err','timer','All methods failed.'); return false;
  }

  function forceEndRound(){
    const g = getGameState();
    if (!g) return false;
    for (const m of ['endRound','finishRound','nextRound','endGame']){
      if (typeof g.node[m] === 'function'){
        try { g.node[m](); log('ok','round',`Called ${m}()`); return true; } catch {}
      }
    }
    for (const m of ['endRound','endGame']){
      if (typeof g.node.props?.[m] === 'function'){
        try { g.node.props[m](); log('ok','round',`Called props.${m}()`); return true; } catch {}
      }
    }
    try {
      g.node.setState?.({ ended:true, showResults:true, gameOver:true });
      log('ok','round','Flagged ended.'); return true;
    } catch {}
    log('err','round','All methods failed.'); return false;
  }

  function swapBlook(value){
    const g = getGameState();
    if (!g) return false;
    const client = currentClient(g);

    // Firebase first — makes swap visible to everyone
    if (firebase.available() && client?.name){
      firebase.writeSelf({ b: value });
    }
    try {
      g.node.setState?.({ client: { ...client, blook: value } });
      log('ok','blook',`→ ${value}`); return true;
    } catch {}
    const players = currentPlayers(g);
    if (client){ client.blook = value; }
    if (players[client?.name]) players[client.name].blook = value;
    const node = document.querySelector(`[data-blook="${value}"], [alt="${value}"]`);
    if (node){ node.click(); log('ok','blook',`→ ${value} (DOM)`); return true; }
    log('err','blook','All methods failed.'); return false;
  }

  /* ============================================================
     14. UNKICKABLE  —  re-add self to Firebase if removed
     ============================================================ */
  function startUnkickable(){
    if (state.timers._unkickable) clearInterval(state.timers._unkickable);
    state.running.unkickable = true;
    state.timers._unkickable = setInterval(async () => {
      const g = getGameState();
      if (!g) return;
      const name = currentClient(g)?.name;
      if (!name) return;
      const players = await firebase.listPlayers();
      if (players.length && !players.includes(name)){
        log('warn','unkickable','Removed — re-adding…');
        firebase.writeSelf({
          b: currentClient(g)?.blook || 'Chick',
          cr: 0, g: 0, d: 0, bs: 0
        });
      }
    }, 1500);
    log('info','unkickable','Active — polls every 1.5s.');
  }

  function stopUnkickable(){
    clearInterval(state.timers._unkickable);
    state.timers._unkickable = null;
    state.running.unkickable = false;
    log('warn','unkickable','Stopped.');
  }

  /* ============================================================
     15. JOIN  +  BOT SPAM
     ============================================================ */
  async function joinMatch(pin, name, blook){
    if (!pin || !name){ toast('warn','Join','Need a PIN and a name.'); return false; }

    const endpoints = [
      { url:'https://fb.blooket.com/c/firebase/join',  body:{ id: pin, name } },
      { url:'https://api.blooket.com/api/firebase/join', body:{ id: pin, name } },
      { url:'https://api.blooket.com/api/games/join',  body:{ id: pin, name } }
    ];

    let token = null;
    for (const ep of endpoints){
      try {
        const r = await fetch(ep.url, {
          method:'PUT',
          credentials:'include',
          headers:{ 'Content-Type':'application/json' },
          body: JSON.stringify(ep.body)
        });
        if (r.ok){
          const j = await r.json().catch(() => ({}));
          token = j.fbToken || j.token;
          log('ok','join',`API join via ${ep.url}`);
          break;
        }
        log('warn','join',`${ep.url} → ${r.status}`);
      } catch (e){ log('warn','join',`${ep.url} unreachable: ${e.message}`); }
    }

    state.session = { pin, name, blook, hostId: token || '' };
    const s = $('[data-role="status"]');
    if (s) s.textContent = `In game — ${name}`;

    try {
      window.open(`https://play.blooket.com/play?pin=${encodeURIComponent(pin)}`, '_blank', 'noopener');
    } catch { log('warn','join','Popup blocked.'); }
    return true;
  }

  // Parallel bot spam — fires N join requests as fast as the API allows
  async function spawnBots(pin, count, pattern){
    if (!pin){ toast('warn','Spam','Need a PIN.'); return; }
    count = Math.min(Math.max(1, count), 30);
    log('info','spam',`Spawning ${count} workers on ${pin}…`);

    const workers = [];
    for (let i = 0; i < count; i++){
      const name = generateIdentity(pattern || 'word+num');
      workers.push((async () => {
        try {
          await fetch('https://fb.blooket.com/c/firebase/join', {
            method:'PUT', credentials:'include',
            headers:{ 'Content-Type':'application/json' },
            body: JSON.stringify({ id: pin, name })
          });
          log('ok','spam',`${name} joined`);
        } catch (e){ log('warn','spam',`${name}: ${e.message}`); }
      })());
    }
    await Promise.allSettled(workers);
    log('ok','spam',`All ${count} workers dispatched.`);
  }

  /* ============================================================
     16. LOOPS
     ============================================================ */
  function startAutoAnswer(delay){
    if (state.timers.autoAnswer) clearInterval(state.timers.autoAnswer);
    state.running.autoAnswer = true;
    log('info','auto-answer','Armed.');
    state.timers.autoAnswer = setInterval(() => {
      const a = tryAnswer();
      if (a) log('ok','auto-answer',`Answered: ${a}`);
    }, Math.max(50, delay || 250));
  }

  function stopAutoAnswer(){
    clearInterval(state.timers.autoAnswer);
    state.timers.autoAnswer = null;
    state.running.autoAnswer = false;
    log('warn','auto-answer','Stopped.');
  }

  function startGrind(cfg){
    state.running.grind = true;
    let played = 0;
    log('info','grind','Loop started.');
    const tick = () => {
      if (!state.running.grind) return;
      try {
        const a = tryAnswer();
        if (a) log('ok','grind',`Game ${played+1}: ${a}`);
        const g = getGameState();
        const finished = !g || !getQuestion();
        if (finished){
          played++;
          log('info','grind',`Cycle ${played}/${cfg.games} — cooling ${cfg.cooldown}s`);
          if (played >= cfg.games){ log('ok','grind','Target reached.'); stopGrind(); return; }
          setTimeout(tick, cfg.cooldown * 1000);
        } else setTimeout(tick, 300);
      } catch (e){
        log('err','grind', e.message);
        if (cfg.stopOnError !== false) stopGrind();
        else setTimeout(tick, 1000);
      }
    };
    tick();
  }

  function stopGrind(){ state.running.grind = false; log('warn','grind','Killed.'); }

  /* ============================================================
     17. UI HELPERS
     ============================================================ */
  function setBadge(mod, cls, txt){
    try {
      const b = mod?.querySelector?.('[data-role="state"]');
      if (!b) return;
      b.className = 'badge' + (cls ? ' ' + cls : '');
      b.textContent = txt;
    } catch {}
  }

  function readField(mod, name){
    try {
      const el = mod?.querySelector?.(`[data-field="${name}"]`);
      if (!el) return undefined;
      if (el.type === 'checkbox') return el.checked;
      if (el.type === 'number'){ const n = +el.value; return Number.isFinite(n) ? n : 0; }
      return el.value;
    } catch { return undefined; }
  }

  /* ============================================================
     18. ACTION REGISTRY
     ============================================================ */
  const actions = {

    async join(mod){
      const pin = readField(mod,'pin'), name = readField(mod,'name');
      setBadge(mod,'warn','Joining');
      try { await joinMatch(pin, name, state.pickedBlook?.name); setBadge(mod,'live','Joined'); }
      catch (e){ log('err','join', e.message); setBadge(mod,'err','Failed'); }
    },

    leave(mod){
      state.session = { pin:'', name:'', blook:null, hostId:'' };
      setBadge(mod,'','Idle');
      const s = $('[data-role="status"]');
      if (s) s.textContent = 'Not in a game';
      log('warn','join','Left.');
    },

    generate(mod){
      const pattern = readField(mod,'pattern') || 'word+num';
      const name = generateIdentity(pattern);
      const out = mod.querySelector('[data-field="output"]');
      if (out) out.value = name;
      log('info','identity',`Generated: ${name}`);
    },

    'use-identity'(mod){
      const out = mod.querySelector('[data-field="output"]')?.value;
      if (!out){ log('warn','identity','Generate one first.'); return; }
      const joinName = $('[data-field="name"]');
      if (joinName) joinName.value = out;
      toast('ok','Name set', out);
    },

    'load-blooks'(){ loadCatalog(); },

    pick(_, btn){
      setPickedBlook(btn.dataset.blookId, btn.dataset.blookName);
      toast('info','Picked', btn.dataset.blookName);
    },

    'use-blook'(){
      if (!state.pickedBlook){ toast('warn','Blook','Pick one first.'); return; }
      const joinField = $('[data-field="blook"]');
      if (joinField) joinField.value = state.pickedBlook.name;
      toast('ok','Blook ready', state.pickedBlook.name);
    },

    go(mod){
      const id = mod.dataset.module;
      const target = readField(mod,'target') || '';
      const value  = readField(mod,'value')  ?? '';
      const fns = {
        'cmd-score':    () => setScore(target, value),
        'cmd-name':     () => setName(value),
        'cmd-chat':     () => sendChat(value),
        'cmd-currency': () => setCurrency(target, value),
        'cmd-blook':    () => swapBlook(value),
        'cmd-kick':     () => kickPlayer(target),
        'cmd-time':     () => setTimer(value),
        'cmd-force':    () => forceEndRound()
      };
      const fn = fns[id];
      if (!fn){ log('warn','override',`No handler for ${id}`); return; }
      safe('override', fn, false);
    },

    start(mod){
      const id = mod.dataset.module;
      if (id === 'auto-answer'){ startAutoAnswer(readField(mod,'delay') || 250); setBadge(mod,'live','Running'); }
      if (id === 'grind'){
        startGrind({
          games: readField(mod,'gamesPerCycle') || 10,
          cooldown: readField(mod,'cooldown') || 5,
          stopOnError: readField(mod,'stopOnError')
        });
        setBadge(mod,'live','Running');
      }
    },

    stop(mod){
      if (mod.dataset.module === 'auto-answer'){ stopAutoAnswer(); setBadge(mod,'','Idle'); }
    },

    deploy(mod){
      startAutoAnswer(readField(mod,'delayMin') || 180);
      state.running.autoBot = true;
      setBadge(mod,'live','Deployed');
      log('ok','auto-bot','Deployed.');
    },

    recall(mod){
      stopAutoAnswer();
      state.running.autoBot = false;
      setBadge(mod,'','Idle');
    },

    kill(mod){
      stopGrind();
      setBadge(mod,'err','Killed');
      setTimeout(() => setBadge(mod,'','Idle'), 1200);
    },

    'toggle-unkickable'(mod){
      if (state.running.unkickable){ stopUnkickable(); setBadge(mod,'','Off'); }
      else { startUnkickable(); setBadge(mod,'live','On'); }
    },

    'toggle-realtime'(mod){
      if (state.running.realtime){ stopRealtime(); setBadge(mod,'','Off'); }
      else { startRealtime(); setBadge(mod,'live','On'); }
    },

    spam(mod){
      const pin = readField(mod,'pin');
      const count = readField(mod,'count') || 5;
      const pattern = readField(mod,'pattern') || 'word+num';
      spawnBots(pin, count, pattern);
    },

    filter(_, btn){
      state.logFilter = btn.dataset.filter;
      $$('.chip[data-action="filter"]').forEach(c => c.classList.toggle('is-active', c === btn));
      applyFilter();
    },

    clear(){ try { if (logEl) logEl.innerHTML = ''; } catch {} log('info','panel','Log cleared.'); }
  };

  /* ============================================================
     19. WIRING
     ============================================================ */
  document.addEventListener('click', e => {
    const btn = e.target.closest('[data-action]');
    if (!btn) return;
    const mod = btn.closest('[data-module]') || btn.closest('.picker') || btn.closest('.console') || document.body;
    const fn = actions[btn.dataset.action];
    if (typeof fn === 'function') safe('action', () => fn(mod, btn));
  });

  const blookSearch = $('[data-field="blookSearch"]');
  if (blookSearch) blookSearch.addEventListener('input', renderBlooks);

  const logSearch = $('[data-field="search"]');
  if (logSearch) logSearch.addEventListener('input', () => {
    state.logSearch = logSearch.value.toLowerCase().trim();
    applyFilter();
  });

  $$('.switch').forEach(sw => {
    try {
      const modId = sw.closest('[data-module]')?.dataset.module || 'global';
      const key = `blk-${modId}-${sw.dataset.field}`;
      const saved = store.get(key);
      if (saved !== null) sw.checked = saved === '1';
      sw.addEventListener('change', () => {
        store.set(key, sw.checked ? '1' : '0');
        log('info','panel',`${sw.dataset.field} → ${sw.checked ? 'on' : 'off'}`);
      });
    } catch {}
  });

  const themeBox = $('#theme-toggle');
  if (themeBox){
    try {
      if (store.get('blk-theme') === 'light') themeBox.checked = true;
      themeBox.addEventListener('change', () => store.set('blk-theme', themeBox.checked ? 'light' : 'dark'));
    } catch {}
  }

  /* ============================================================
     20. DOCTOR
     ============================================================ */
  function doctor(){
    const g = getGameState();
    const report = {
      host: location.hostname,
      onBlooket: /blooket\.com$/.test(location.hostname),
      mode: state.mode,
      react: {
        node: !!g?.node,
        path: state.reactPath,
        game: !!g?.game,
        client: !!g?.client,
        controller: !!g?.controller
      },
      firebase: { available: firebase.available() },
      auth: { cached: !!auth._cache, ...(auth._cache || {}) },
      catalog: { count: state.catalog.length, source: state.catalogSource },
      session: { ...state.session },
      running: { ...state.running }
    };
    log('info','doctor', JSON.stringify(report, null, 2));
    return report;
  }

  /* ============================================================
     21. BOOT
     ============================================================ */
  async function boot(){
    log('ok','panel','Engine online.');

    if (/blooket\.com$/.test(location.hostname)){
      log('info','panel','On Blooket — game hooks live.');
      detectMode();
      loadCatalog().catch(e => log('err','blooks', e.message));
      auth.extract().catch(() => {});
    } else {
      log('warn','panel','Not on blooket.com — hooks idle.');
      loadCatalog().catch(() => {});
    }

    renderBlooks();

    setTimeout(() => {
      const n = getReactNode({ scan:true });
      log(n ? 'ok' : 'warn', 'react',
          n ? `Node via ${state.reactPath}.` : 'No React node yet — retrying.');
      if (n){
        if (state.mode === 'unknown') detectMode();
        log(firebase.available() ? 'ok' : 'warn', 'firebase',
            firebase.available() ? 'liveGameController attached.' : 'liveGameController not found.');
      }
    }, 1200);
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();

  /* ============================================================
     22. PUBLIC SURFACE
     ============================================================ */
  window.BP = {
    state, actions, log, toast, doctor,
    modules: { setBadge, readField },
    react:   { getReactNode, getGameState, tryAnswer, pickCorrect, getQuestion },
    firebase,
    auth,
    mode:    { detect: detectMode, current: () => state.mode, info: modeInfo },
    blooks:  { loadCatalog, setPickedBlook, renderBlooks },
    overrides: { setScore, setName, setCurrency, sendChat, kickPlayer, setTimer, forceEndRound, swapBlook },
    loops:   { startAutoAnswer, stopAutoAnswer, startGrind, stopGrind, startUnkickable, stopUnkickable, startRealtime, stopRealtime },
    spam:    { spawn: spawnBots }
  };

})();
