(() => {
  'use strict';
  const params = new URLSearchParams(location.search);
  let token = params.get('token') || '';
  try {
    if (token) localStorage.setItem('wink.token', token);
    else token = localStorage.getItem('wink.token') || '';
  } catch (_) { /* storage blocked */ }
  // Credentials always stay on the Worker origin, even if a shared link has an api parameter.
  const api = location.origin;
  if (params.has('token')) {
    params.delete('token');
    history.replaceState(null, '', location.pathname + (params.size ? '?' + params : '') + location.hash);
  }

  const $ = (id) => document.getElementById(id);
  const el = (tag, cls, text) => {
    const node = document.createElement(tag);
    if (cls) node.className = cls;
    if (text !== undefined && text !== null) node.textContent = text;
    return node;
  };

  const memories = new Map(); // id -> Memory
  let order = [];             // ids, newest first
  let openId = null;
  let hoverId = null;
  let matchTimer = null;
  let paused = false;
  let revision = 0;
  let loadSequence = 0;
  const changes = new Map(); // Changes received while a list request is in flight.
  const deleting = new Set();
  let returnFocus = null;
  let memoryFilter = 'all';
  let searchTerm = '';
  let asking = false;

  function validMemory(m) {
    return m && typeof m.id === 'string' && typeof m.title === 'string' && typeof m.imageUrl === 'string';
  }
  function imageSource(value) {
    try {
      const url = new URL(value, api);
      return url.origin === api && url.pathname.startsWith('/v1/images/') ? url.href : '';
    } catch (_) { return ''; }
  }
  async function request(path, options = {}) {
    const response = await fetch(api + path, { ...options, headers: { ...options.headers, ...authHeaders() }, signal: options.signal || AbortSignal.timeout(15000) });
    if (response.status === 401) throw new Error('Wrong or missing token. Open /tv?token=<WINK_TOKEN>');
    if (!response.ok) {
      let message = 'HTTP ' + response.status;
      try { message = (await response.json()).error?.message || message; } catch (_) {}
      throw new Error(message);
    }
    return response;
  }

  // ---------- helpers ----------
  function ago(iso) {
    const s = Math.max(0, (Date.now() - Date.parse(iso)) / 1000);
    if (!isFinite(s)) return '';
    if (s < 45) return 'just now';
    const m = Math.round(s / 60);
    if (m < 60) return m + ' min ago';
    const h = Math.round(m / 60);
    if (h < 24) return h + ' hr ago';
    return Math.round(h / 24) + ' d ago';
  }
  function meters(d) {
    if (d === null || d === undefined) return '';
    return d < 1000 ? Math.round(d / 10) * 10 + ' m' : (d / 1000).toFixed(1) + ' km';
  }
  let toastTimer = null;
  function toast(text, ms = 2200) {
    const t = $('toast');
    t.textContent = text;
    t.classList.add('on');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => t.classList.remove('on'), ms);
  }
  function banner(text) {
    $('banner').textContent = text || '';
    $('banner').classList.toggle('on', !!text);
  }
  function authHeaders() {
    return token ? { Authorization: 'Bearer ' + token } : {};
  }

  // ---------- clock ----------
  function tick() {
    $('clock').textContent = new Date().toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
    document.querySelectorAll('.card').forEach((card) => {
      const m = memories.get(card.dataset.id);
      if (m) card.querySelector('.when').textContent = ago(m.createdAt);
    });
  }
  setInterval(tick, 15000);
  tick();

  // ---------- status + transcript ----------
  const STATE_TEXT = { idle: 'Idle', listening: 'Listening', thinking: 'Thinking', speaking: 'Speaking', paused: 'Paused' };
  let idleTimer = null;
  function setStatus(state, text) {
    if (!Object.hasOwn(STATE_TEXT, state)) return;
    paused = state === 'paused';
    if (paused) {
      hidePreview();
      clearPointer();
    }
    $('previewEmpty').textContent = paused ? 'Privacy paused · live preview is off' : 'Through your eyes · waiting for a live preview';
    $('pill').dataset.state = state;
    $('pillText').textContent = text ? STATE_TEXT[state] + ' · ' + text : STATE_TEXT[state] || state;
    clearTimeout(idleTimer);
    if (state === 'speaking' || state === 'thinking') idleTimer = setTimeout(() => setStatus('idle'), 20000);
  }
  function setTranscript(text) {
    if (typeof text !== 'string' || !text.trim()) return;
    const t = $('transcript');
    const prev = t.classList.contains('empty') ? '' : t.textContent;
    if (prev) {
      const h = $('history');
      h.prepend(el('div', '', '“' + prev + '”'));
      while (h.children.length > 4) h.lastChild.remove();
    }
    t.classList.remove('empty');
    t.textContent = text;
  }

  // ---------- memory wall ----------
  function card(m) {
    const c = el('button', 'card');
    c.type = 'button';
    c.setAttribute('aria-label', 'Open ' + m.title);
    c.dataset.id = m.id;
    const img = el('img');
    img.src = imageSource(m.imageUrl);
    img.alt = m.title;
    img.loading = 'lazy';
    c.append(img);
    if (m.note) c.append(el('div', 'note', '“' + m.note + '”'));
    const meta = el('div', 'meta');
    meta.append(el('div', 'title', m.title));
    const sub = el('div', 'sub');
    sub.append(el('span', 'when', ago(m.createdAt)));
    if (m.place) sub.append(document.createTextNode(' · ' + m.place.name));
    else if (m.objects && m.objects.length) sub.append(document.createTextNode(' · ' + m.objects.slice(0, 3).join(', ')));
    meta.append(sub);
    c.append(meta);
    c.addEventListener('click', () => openMemory(m.id));
    return c;
  }
  function visibleIds() {
    const today = new Date().toDateString();
    return order.filter((id) => {
      const memory = memories.get(id);
      if (!memory) return false;
      if (memoryFilter === 'today' && new Date(memory.createdAt).toDateString() !== today) return false;
      const text = [memory.title, memory.summary, memory.visibleText, memory.note, ...(memory.objects || [])].join(' ').toLowerCase();
      return !searchTerm || text.includes(searchTerm);
    });
  }
  function renderCount() {
    $('count').textContent = order.length ? order.length + (order.length === 1 ? ' memory' : ' memories') : '';
    const grid = $('grid');
    const empty = grid.querySelector('.empty-wall');
    const visible = visibleIds();
    if (!visible.length && !empty) {
      const e = el('div', 'empty-wall');
      if (order.length) e.textContent = 'No moments match this search. Try a different word or choose All memories.';
      else e.innerHTML = 'Your next favorite memory starts here.<br>Just say <b>“Hey Wink, save this.”</b>';
      grid.append(e);
    } else if (visible.length && empty) empty.remove();
  }
  function renderAll() {
    // A rebuilt/filtered wall invalidates the pointed-at card and its delete target.
    clearPointer();
    const grid = $('grid');
    grid.textContent = '';
    visibleIds().forEach((id) => grid.append(card(memories.get(id))));
    renderCount();
  }
  function addMemory(m, animate) {
    if (!validMemory(m)) return;
    changes.set(m.id, { revision: ++revision, memory: m });
    const existing = $('grid').querySelector('.card[data-id="' + CSS.escape(m.id) + '"]');
    memories.set(m.id, m);
    if (searchTerm || memoryFilter !== 'all') {
      if (!order.includes(m.id)) order.unshift(m.id);
      renderAll();
      return;
    }
    if (existing) { existing.replaceWith(card(m)); return; }
    order.unshift(m.id);
    const c = card(m);
    if (animate) c.classList.add('new');
    $('grid').prepend(c);
    $('grid').scrollTo({ top: 0, behavior: 'smooth' });
    renderCount();
  }
  function removeMemory(id) {
    if (typeof id !== 'string') return;
    changes.set(id, { revision: ++revision, memory: null });
    memories.delete(id);
    order = order.filter((x) => x !== id);
    const c = $('grid').querySelector('.card[data-id="' + CSS.escape(id) + '"]');
    if (c) {
      c.classList.add('leaving');
      setTimeout(() => { c.remove(); renderCount(); }, 600);
    } else renderCount();
    if (openId === id) closeMemory();
    if (hoverId === id) setHover(null);
    document.querySelectorAll('.thumb[data-id]').forEach((thumb) => { if (thumb.dataset.id === id) thumb.remove(); });
  }
  async function loadMemories() {
    const sequence = ++loadSequence;
    const startedAt = revision;
    try {
      const res = await request('/v1/memories?limit=50');
      const body = await res.json();
      if (sequence !== loadSequence) return;
      if (!Array.isArray(body.memories)) throw new Error('Invalid memory response');
      memories.clear();
      body.memories.filter(validMemory).forEach((m) => memories.set(m.id, m));
      for (const [id, change] of changes) {
        if (change.revision > startedAt) {
          if (change.memory) memories.set(id, change.memory); else memories.delete(id);
        } else changes.delete(id);
      }
      order = [...memories.values()].sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt)).map((m) => m.id);
      if (openId && !memories.has(openId)) closeMemory();
      renderAll();
      banner('');
    } catch (err) {
      if (sequence !== loadSequence) return;
      banner('Could not load memories (' + err.message + ')');
      renderCount();
    }
  }
  function highlight(ids) {
    document.querySelectorAll('.card.match').forEach((c) => c.classList.remove('match'));
    ids.forEach((id) => {
      const c = $('grid').querySelector('.card[data-id="' + CSS.escape(id) + '"]');
      if (c) c.classList.add('match');
    });
    const first = ids[0] && $('grid').querySelector('.card[data-id="' + CSS.escape(ids[0]) + '"]');
    if (first) first.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    clearTimeout(matchTimer);
    matchTimer = setTimeout(() => document.querySelectorAll('.card.match').forEach((c) => c.classList.remove('match')), 15000);
  }

  // ---------- modal ----------
  function openMemory(id) {
    const m = memories.get(id);
    if (!m) return;
    if (!openId) returnFocus = document.activeElement;
    openId = id;
    $('mImg').src = imageSource(m.imageUrl);
    $('mImg').alt = m.title;
    $('mWhen').textContent = 'Saved ' + ago(m.createdAt) + (m.note ? ' · “' + m.note + '”' : '');
    $('mTitle').textContent = m.title;
    $('mSummary').textContent = m.summary;
    $('mText').textContent = m.visibleText || '';
    $('mText').style.display = m.visibleText ? '' : 'none';
    const chips = $('mChips');
    chips.textContent = '';
    (m.objects || []).forEach((o) => chips.append(el('span', 'chip', o)));
    $('mPlace').textContent = m.place ? m.place.name + (m.place.address ? ' · ' + m.place.address : '') : '';
    $('modal').classList.add('on');
    $('modal').setAttribute('aria-hidden', 'false');
    $('mDelete').disabled = deleting.has(id);
    $('mClose').focus();
  }
  function closeMemory() {
    openId = null;
    $('modal').classList.remove('on');
    $('modal').setAttribute('aria-hidden', 'true');
    if (returnFocus?.isConnected) returnFocus.focus();
  }
  async function forget(id) {
    if (!id || deleting.has(id)) return;
    deleting.add(id);
    $('mDelete').disabled = true;
    const m = memories.get(id);
    toast('Forgetting ' + (m ? m.title : 'memory') + '…');
    try {
      await request('/v1/memories/' + encodeURIComponent(id), { method: 'DELETE' });
      removeMemory(id);
      toast('Forgotten');
    } catch (err) {
      toast('Could not forget this memory');
      banner(err.message);
    } finally {
      deleting.delete(id);
      $('mDelete').disabled = false;
    }
  }
  $('mClose').addEventListener('click', closeMemory);
  $('mDelete').addEventListener('click', () => forget(openId));
  $('modal').addEventListener('click', (e) => { if (e.target === $('modal')) closeMemory(); });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') closeMemory();
    if (e.key === 'Tab' && openId) {
      const first = $('mDelete').disabled ? $('mClose') : $('mDelete');
      const last = $('mClose');
      if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
      else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
    }
    if (e.key === 'f' && !e.metaKey && !e.ctrlKey && !['INPUT', 'TEXTAREA'].includes(e.target?.tagName) && !e.target?.isContentEditable) {
      if (document.fullscreenElement) document.exitFullscreen(); else document.documentElement.requestFullscreen().catch(() => {});
    }
  });

  // ---------- answer / glance / nearby ----------
  function flash(id) {
    const p = $(id);
    p.classList.remove('flash');
    void p.offsetWidth;
    p.classList.add('flash');
  }
  function showAnswer(ev) {
    selectPanel('answer');
    $('answerLabel').textContent = 'Answer';
    $('answerQ').textContent = ev.question ? '“' + ev.question + '”' : '';
    $('answerSpeech').textContent = ev.speech;
    $('answerChips').textContent = '';
    const thumbs = $('answerThumbs');
    thumbs.textContent = '';
    (ev.memories || []).filter(validMemory).forEach((m) => {
      if (!memories.has(m.id)) memories.set(m.id, m);
      const img = el('img');
      img.src = imageSource(m.imageUrl);
      img.alt = m.title;
      img.title = m.title;
      const button = el('button', 'thumb');
      button.dataset.id = m.id;
      button.setAttribute('aria-label', 'Open ' + m.title);
      button.addEventListener('click', () => openMemory(m.id));
      button.append(img);
      thumbs.append(button);
    });
    highlight((ev.memories || []).map((m) => m.id));
    flash('answer');
  }
  function showGlance(ev) {
    selectPanel('answer');
    $('answerLabel').textContent = 'Glance';
    $('answerQ').textContent = ev.title;
    $('answerSpeech').textContent = ev.speech;
    const chips = $('answerChips');
    chips.textContent = '';
    (ev.objects || []).forEach((o) => chips.append(el('span', 'chip', o)));
    $('answerThumbs').textContent = '';
    flash('answer');
  }
  function showNearby(ev) {
    selectPanel('nearbyPanel');
    $('nearbySpeech').textContent = ev.speech;
    const list = $('places');
    list.textContent = '';
    (ev.places || []).forEach((p, i) => {
      const row = el('div', 'place');
      row.style.animationDelay = i * 90 + 'ms';
      row.append(el('div', 'n', String(i + 1)));
      const mid = el('div');
      mid.style.minWidth = '0';
      mid.append(el('div', 'name', p.name));
      mid.append(el('div', 'addr', [String(p.category || '').replace(/_/g, ' '), p.address, p.phone].filter(Boolean).join(' · ')));
      row.append(mid);
      row.append(el('div', 'dist', meters(p.distanceMeters)));
      list.append(row);
    });
  }

  // ---------- POV preview ----------
  let povTimer = null;
  let boxTimer = null;
  $('povImg').addEventListener('load', () => {
    const img = $('povImg');
    if (img.naturalWidth && img.naturalHeight) $('pov').style.aspectRatio = img.naturalWidth + ' / ' + img.naturalHeight;
  });
  $('povImg').addEventListener('error', hidePreview);
  function hidePreview() {
    clearTimeout(povTimer);
    clearTimeout(boxTimer);
    $('pov').classList.remove('on');
    $('povImg').removeAttribute('src');
    $('povBox').style.display = 'none';
  }
  function showFrame(b64) {
    if (paused || typeof b64 !== 'string' || b64.length > 350000 || !/^[A-Za-z0-9+/]+={0,2}$/.test(b64)) return;
    $('pov').classList.add('on');
    $('povImg').src = 'data:image/jpeg;base64,' + b64;
    clearTimeout(povTimer);
    povTimer = setTimeout(hidePreview, 5000);
  }
  function showBox(box) {
    const b = $('povBox');
    clearTimeout(boxTimer);
    if (!box || !['x', 'y', 'w', 'h'].every((key) => Number.isFinite(box[key]) && box[key] >= 0 && box[key] <= 1) || box.x + box.w > 1 || box.y + box.h > 1 || !$('pov').classList.contains('on')) { b.style.display = 'none'; return; }
    Object.assign(b.style, { display: 'block', left: box.x * 100 + '%', top: box.y * 100 + '%', width: box.w * 100 + '%', height: box.h * 100 + '%' });
    boxTimer = setTimeout(() => { b.style.display = 'none'; }, 2500);
  }

  // ---------- gestures + pointer ----------
  const GESTURE_TEXT = {
    point: '👉 Point', frame: '🖼️ Frame', lasso: '➰ Lasso', palm: '✋ Palm detected', thumbsUp: '👍 Got it',
    fingers: '🖐️ Fingers', pinch: '🤏 Pinch', flick: '💨 Flick',
  };
  function onGesture(ev) {
    if (!Object.hasOwn(GESTURE_TEXT, ev.gesture)) return;
    let text = GESTURE_TEXT[ev.gesture] || ev.gesture;
    if (ev.gesture === 'fingers' && typeof ev.value === 'number') text = '🖐️ ' + ev.value;
    toast(text, 1600);
    if (ev.box) showBox(ev.box);
    if (ev.gesture === 'flick' && !paused) {
      const target = openId || hoverId;
      if (target) forget(target);
    }
    if (ev.gesture === 'palm' && openId) closeMemory();
  }

  const cursor = $('cursor');
  let wasPinching = false;
  let cursorTimer = null;
  function clearPointer() {
    clearTimeout(cursorTimer);
    cursor.classList.remove('on', 'pinch');
    wasPinching = false;
    setHover(null);
  }
  function cardAt(x, y) {
    const hit = document.elementFromPoint(x, y);
    const c = hit && hit.closest && hit.closest('.card');
    return c ? c.dataset.id : null;
  }
  function onPointer(ev) {
    if (paused || !Number.isFinite(ev.x) || !Number.isFinite(ev.y)) return;
    const x = Math.min(1, Math.max(0, ev.x)) * innerWidth;
    const y = Math.min(1, Math.max(0, ev.y)) * innerHeight;
    cursor.style.transform = 'translate(' + x + 'px,' + y + 'px)';
    cursor.classList.add('on');
    cursor.classList.toggle('pinch', !!ev.pinching);
    clearTimeout(cursorTimer);
    cursorTimer = setTimeout(clearPointer, 1500);
    const id = openId ? null : cardAt(x, y);
    setHover(id);
    if (ev.pinching && !wasPinching) {
      if (openId) closeMemory();
      else if (id) openMemory(id);
    }
    wasPinching = !!ev.pinching;
  }
  function setHover(id) {
    if (id === hoverId) return;
    if (hoverId) {
      const old = $('grid').querySelector('.card[data-id="' + CSS.escape(hoverId) + '"]');
      if (old) old.classList.remove('hover');
    }
    hoverId = id;
    if (id) {
      const c = $('grid').querySelector('.card[data-id="' + CSS.escape(id) + '"]');
      if (c) c.classList.add('hover');
    }
  }

  // ---------- browsing and asking ----------
  function selectPanel(id) {
    for (const panel of ['answer', 'livePanel', 'nearbyPanel']) $(panel).hidden = panel !== id;
    document.querySelectorAll('[data-panel]').forEach((button) => {
      const selected = button.dataset.panel === id;
      button.classList.toggle('active', selected);
      button.setAttribute('aria-selected', String(selected));
      button.setAttribute('tabindex', selected ? '0' : '-1');
    });
  }
  function visit(target) {
    const section = target === 'memories' ? $('memoriesSection') : $('companion');
    if (target !== 'memories') selectPanel(target);
    section.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    section.focus({ preventScroll: true });
    document.querySelectorAll('[data-nav]').forEach((button) => {
      const selected = button.dataset.nav === target;
      button.classList.toggle('active', selected);
      button.setAttribute('aria-current', selected ? 'location' : 'false');
    });
  }
  document.querySelectorAll('[data-panel]').forEach((button, index, buttons) => {
    button.addEventListener('click', () => selectPanel(button.dataset.panel));
    button.addEventListener('keydown', (event) => {
      if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
      event.preventDefault();
      const next = event.key === 'Home' ? 0 : event.key === 'End' ? buttons.length - 1
        : (index + (event.key === 'ArrowRight' ? 1 : -1) + buttons.length) % buttons.length;
      selectPanel(buttons[next].dataset.panel);
      buttons[next].focus();
    });
  });
  document.querySelectorAll('[data-nav]').forEach((button) => button.addEventListener('click', () => visit(button.dataset.nav)));
  $('exploreMemories').addEventListener('click', () => visit('memories'));
  $('memorySearch').addEventListener('input', (event) => {
    searchTerm = event.target.value.trim().toLowerCase();
    renderAll();
  });
  document.querySelectorAll('[data-filter]').forEach((button) => button.addEventListener('click', () => {
    memoryFilter = button.dataset.filter;
    document.querySelectorAll('[data-filter]').forEach((item) => {
      const selected = item.dataset.filter === memoryFilter;
      item.classList.toggle('active', selected);
      item.setAttribute('aria-pressed', String(selected));
    });
    renderAll();
  }));
  $('fullscreen').addEventListener('click', () => {
    if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
    else document.documentElement.requestFullscreen().catch(() => toast('Fullscreen is unavailable in this browser.'));
  });
  $('askForm').addEventListener('submit', async (event) => {
    event.preventDefault();
    const question = $('askInput').value.trim();
    if (!question || asking) return;
    asking = true;
    $('askSubmit').disabled = true;
    $('askForm').setAttribute('aria-busy', 'true');
    $('askHint').textContent = 'Looking through your saved moments…';
    selectPanel('answer');
    try {
      const response = await request('/v1/ask', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ question, location: null }), signal: AbortSignal.timeout(70000),
      });
      const answer = await response.json();
      if (typeof answer.speech !== 'string' || !Array.isArray(answer.memories)) throw new Error('Invalid answer response');
      showAnswer({ question, ...answer });
      if ($('askInput').value.trim() === question) $('askInput').value = '';
      $('askHint').textContent = 'Answers grounded in your saved moments.';
    } catch (error) {
      $('askHint').textContent = 'Could not find an answer. ' + error.message;
    } finally {
      asking = false;
      $('askSubmit').disabled = false;
      $('askForm').setAttribute('aria-busy', 'false');
    }
  });
  selectPanel('answer');

  // ---------- live socket ----------
  function handle(ev) {
    if (!ev || typeof ev.type !== 'string') return;
    switch (ev.type) {
      case 'status': setStatus(ev.state, ev.text); break;
      case 'transcript': setTranscript(ev.text); break;
      case 'gesture': onGesture(ev); break;
      case 'pointer': onPointer(ev); break;
      case 'frame': showFrame(ev.jpegBase64); break;
      case 'memory.saved': if (validMemory(ev.memory)) { addMemory(ev.memory, true); toast('Saved · ' + ev.memory.title, 2600); } break;
      case 'memory.deleted': removeMemory(ev.id); break;
      case 'glance': showGlance(ev); break;
      case 'answer': showAnswer(ev); break;
      case 'nearby': showNearby(ev); break;
    }
  }
  let backoff = 500;
  let reconnectTimer = null;
  let socket = null;
  let heartbeat = null;
  let stopped = false;
  function reconnect() {
    if (stopped) return;
    clearTimeout(reconnectTimer);
    $('conn').classList.remove('live');
    $('connText').textContent = navigator.onLine ? 'reconnecting' : 'offline';
    hidePreview();
    clearPointer();
    reconnectTimer = setTimeout(connect, backoff + Math.random() * 250);
    backoff = Math.min(backoff * 2, 8000);
  }
  function connect() {
    if (stopped) return;
    const wsUrl = api.replace(/^http/, 'ws') + '/v1/live?role=tv' + (token ? '&token=' + encodeURIComponent(token) : '');
    let ws;
    try { ws = new WebSocket(wsUrl); socket = ws; } catch (_) { reconnect(); return; }
    ws.onopen = () => {
      backoff = 500;
      $('conn').classList.add('live');
      $('connText').textContent = 'live';
      clearInterval(heartbeat);
      heartbeat = setInterval(() => { try { ws.send('ping'); } catch (_) { ws.close(); } }, 25000);
      loadMemories(); // catch up on anything missed while offline
    };
    ws.onmessage = (msg) => {
      if (msg.data === 'pong') return;
      try { handle(JSON.parse(msg.data)); } catch (err) { console.warn('bad event', err); }
    };
    ws.onclose = () => {
      clearInterval(heartbeat);
      reconnect();
    };
    ws.onerror = () => { try { ws.close(); } catch (_) {} };
  }

  window.addEventListener('pagehide', () => {
    stopped = true;
    clearTimeout(reconnectTimer);
    clearInterval(heartbeat);
    socket?.close();
    hidePreview();
    clearPointer();
  });
  window.addEventListener('pageshow', (event) => {
    if (event.persisted) { stopped = false; connect(); }
  });

  renderCount();
  loadMemories(); // Also reports authentication errors when the socket cannot connect.
  fetch(api + '/v1/health', { signal: AbortSignal.timeout(10000) })
    .then((res) => res.ok ? res.json() : null)
    .then((health) => {
      if (!health) return;
      $('mode').hidden = false;
      $('mode').textContent = health.mock ? 'Demo · mock data' : 'Live mode';
    }).catch(() => {});
  connect();
  window.wink = { handle }; // debugging: wink.handle({ type: 'pointer', x: 0.5, y: 0.5, pinching: false })
})();
