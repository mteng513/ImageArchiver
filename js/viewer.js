// Full-screen viewer: swipe, pinch-zoom, double-tap fit/fill, slideshow.
import { h, icon, idb, fmtDate, fmtBytes } from './util.js';
import { S, urls, deleteMedia } from './core.js';
import { sheet, toast, confirmBox, pickGallery, editTags } from './ui.js';

const DEFAULTS = { interval: 5, loop: true, shuffle: false, reverse: false, transition: 'fade' };

export async function openViewer(list, start = 0, { viewKey = 'all', autoplay = false } = {}) {
  if (!list.length) return;
  list = list.slice();
  const settings = { ...DEFAULTS, ...((await idb.get('kv', 'show:' + viewKey)) || {}) };

  let order = list.map((_, i) => i);
  let pos = start;
  // Reverse slideshow started from a grid's Play button begins at the last image.
  if (autoplay && settings.reverse && !settings.shuffle && start === 0) pos = list.length - 1;
  const step = () => (playing && settings.reverse && !settings.shuffle ? -1 : 1);
  let playing = false, timer = null, wake = null;
  let fill = false;
  let zoom = { s: 1, x: 0, y: 0 };
  let chrome = true;
  let stripWhole = false;          // double-tap on a strip shows it whole instead of fit-to-width
  let flingRaf = 0, panTimer = null;

  const counter = h('span', { class: 'v-count' });
  const favBtn = h('button', { class: 'icon-btn', 'aria-label': 'Favorite', onclick: () => toggleFav() });
  const playBtn = h('button', { class: 'icon-btn', 'aria-label': 'Play slideshow', onclick: () => (playing ? stop() : play()) });
  const top = h('div', { class: 'v-top' },
    h('button', { class: 'icon-btn', 'aria-label': 'Close', onclick: () => close() }, icon('close')),
    counter, h('span', { class: 'grow' }),
    favBtn,
    h('button', { class: 'icon-btn', 'aria-label': 'Details', onclick: () => showInfo() }, icon('info')),
    h('button', { class: 'icon-btn', 'aria-label': 'Slideshow settings', onclick: () => showSettings() }, icon('gear')),
    playBtn);
  const caption = h('div', { class: 'v-caption' });
  const track = h('div', { class: 'v-track' });
  const slides = [-1, 0, 1].map(o => {
    const img = h('img', { class: 'v-img', alt: '', draggable: 'false' });
    const s = h('div', { class: 'v-slide' }, img);
    s.style.transform = `translateX(${o * 100}%)`;
    track.append(s);
    return { el: s, img, id: null };
  });
  const stage = h('div', { class: 'v-stage' }, track);
  const vbar = h('div', { class: 'v-bar' }, h('div'));
  const root = h('div', { class: 'viewer', role: 'dialog', 'aria-label': 'Image viewer' }, stage, vbar, top, caption);
  document.body.append(root);
  document.body.classList.add('no-scroll');
  requestAnimationFrame(() => root.classList.add('in'));

  const at = p => {
    const n = order.length;
    if (p < 0 || p >= n) { if (!settings.loop || n < 2) return null; p = ((p % n) + n) % n; }
    return list[order[p]];
  };
  const wrapPos = p => { const n = order.length; return ((p % n) + n) % n; };
  const cur = () => list[order[pos]];

  // ---- strips (long images): fit to width, pan vertically ----
  const isTall = m => !!(m && m.w && m.h && m.h / m.w > (stage.clientHeight / stage.clientWidth) * 1.2);
  const stripH = m => stage.clientWidth * m.h / m.w;
  const minTy = slot => Math.min(0, stage.clientHeight - stripH(slot.m));
  function layoutSlot(slot) {
    const m = slot.m;
    slot.tall = !!m && isTall(m) && !stripWhole;
    slot.ty = 0;
    slot.el.classList.toggle('tall', slot.tall);
    slot.img.style.transition = '';
    slot.img.style.transform = '';
    slot.img.style.height = slot.tall ? stripH(m) + 'px' : '';
    slot.img.classList.toggle('fill', fill && !slot.tall);
    if (slot === slides[1]) updateBar();
  }
  function applyTy(slot) {
    slot.img.style.transform = slot.ty ? `translateY(${slot.ty}px)` : '';
    if (slot === slides[1]) updateBar();
  }
  function updateBar() {
    const sl = slides[1], thumb = vbar.firstChild;
    vbar.classList.toggle('on', !!sl.tall);
    if (!sl.tall) return;
    const H = stripH(sl.m);
    thumb.style.transition = sl.img.style.transition.replace('transform', 'top');
    thumb.style.height = (stage.clientHeight / H * 100) + '%';
    thumb.style.top = (-sl.ty / H * 100) + '%';
  }
  function stopMotion() {
    cancelAnimationFrame(flingRaf); clearTimeout(panTimer);
    const sl = slides[1];
    if (sl.tall && sl.img.style.transition) {   // freeze a slideshow pan where it is
      try { sl.ty = new DOMMatrix(getComputedStyle(sl.img).transform).m42; } catch {}
      sl.img.style.transition = '';
      applyTy(sl);
    }
  }
  function fling(v) {   // v in px/ms
    const sl = slides[1];
    let last = performance.now();
    const tick = now => {
      const dt = now - last; last = now;
      const want = sl.ty + v * dt;
      const next = Math.max(minTy(sl), Math.min(0, want));
      sl.ty = next; applyTy(sl);
      v *= Math.pow(0.997, dt);
      if (next === want && Math.abs(v) > 0.02) flingRaf = requestAnimationFrame(tick);
    };
    flingRaf = requestAnimationFrame(tick);
  }
  // Slideshow: a strip scrolls top to bottom (~2.5 s per screen) instead of sitting as a sliver.
  const panMs = m => Math.max(settings.interval * 1000, (stripH(m) / stage.clientHeight) * 2500 + 2000);
  function autoPan() {
    const sl = slides[1];
    if (!sl.tall) return;
    const ms = panMs(sl.m) - 2000;
    clearTimeout(panTimer);
    panTimer = setTimeout(() => {
      sl.img.style.transition = `transform ${ms}ms linear`;
      sl.ty = minTy(sl); applyTy(sl);
    }, 1000);
  }

  function setImg(slot, m) {
    slot.id = m ? m.id : null;
    slot.m = m;
    layoutSlot(slot);
    if (!m) { slot.img.removeAttribute('src'); return; }
    if (m.status === 'link-only' || isTall(m)) { slot.img.removeAttribute('src'); }
    // A strip's thumbnail is only its top, so it waits for the full image.
    if (!isTall(m)) urls.thumb(m).then(u => { if (slot.id === m.id && !slot.full) slot.img.src = u; }).catch(() => {});
    slot.full = false;
    urls.orig(m).then(u => { if (slot.id === m.id) { slot.img.src = u; slot.full = true; } })
      .catch(() => { if (slot.id === m.id) slot.el.classList.add('missing'); });
  }

  function render() {
    cancelAnimationFrame(flingRaf); clearTimeout(panTimer);
    zoom = { s: 1, x: 0, y: 0 };
    track.style.transition = 'none';
    track.style.transform = 'translateX(0)';
    [-1, 0, 1].forEach((o, i) => { slides[i].el.classList.remove('missing'); setImg(slides[i], at(pos + o)); });
    const m = cur();
    counter.textContent = `${pos + 1} / ${order.length}`;
    favBtn.replaceChildren(icon(S.archive.favorites.has(m.id) ? 'heartFill' : 'heart'));
    favBtn.classList.toggle('on', S.archive.favorites.has(m.id));
    playBtn.replaceChildren(icon(playing ? 'pause' : 'play'));
    const p = S.archive.posts.get(m.postId);
    let host = '';
    try { host = p.sourceURL ? new URL(p.sourceURL).hostname.replace(/^www\./, '') : ''; } catch {}
    const tags = S.archive.mediaTags(m.id).map(t => '#' + t).join(' ');
    caption.textContent = [host || labelFor(p), fmtDate(p.savedAt), tags].filter(Boolean).join(' · ');
    // Preload the next two full images.
    for (const o of [1, 2]) { const n = at(pos + o * step()); if (n) urls.orig(n).catch(() => {}); }
    if (playing) { schedule(); autoPan(); }
  }

  function go(delta, { animate = 'slide' } = {}) {
    const next = pos + delta;
    if ((next < 0 || next >= order.length) && !settings.loop) {
      if (playing) stop();
      snapBack();
      return false;
    }
    if (animate === 'slide') {
      track.style.transition = 'transform .28s ease';
      track.style.transform = `translateX(${-delta * 100}%)`;
      setTimeout(() => { pos = wrapPos(next); render(); }, 280);
    } else {
      pos = wrapPos(next);
      render();
      const img = slides[1].img;
      img.classList.remove('fadein'); void img.offsetWidth; img.classList.add('fadein');
    }
    return true;
  }
  function snapBack() {
    track.style.transition = 'transform .2s ease';
    track.style.transform = 'translateX(0)';
  }

  // ---- slideshow ----
  function schedule() {
    clearTimeout(timer);
    if (!playing) return;
    timer = setTimeout(() => {
      if (go(step(), { animate: settings.transition === 'slide' ? 'slide' : 'fade' })) schedule();
    }, slides[1].tall ? panMs(slides[1].m) : settings.interval * 1000);
  }
  async function play() {
    if (settings.shuffle) {
      const curIdx = order[pos];
      const rest = list.map((_, i) => i).filter(i => i !== curIdx);
      for (let i = rest.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [rest[i], rest[j]] = [rest[j], rest[i]]; }
      order = [curIdx, ...rest];
      pos = 0;
    }
    else if (!settings.loop) {
      // Without looping, start from the end the slideshow moves away from.
      if (settings.reverse && pos === 0) pos = order.length - 1;
      else if (!settings.reverse && pos === order.length - 1) pos = 0;
    }
    playing = true;
    setChrome(false);
    render();
    schedule();
    try { wake = await navigator.wakeLock?.request('screen'); } catch {}
  }
  function stop() {
    playing = false;
    clearTimeout(timer);
    if (settings.shuffle) { const id = order[pos]; order = list.map((_, i) => i); pos = id; }
    try { wake?.release(); } catch {}
    wake = null;
    render();
    setChrome(true);
  }
  const onVis = async () => {
    if (document.visibilityState === 'visible' && playing && !wake) {
      try { wake = await navigator.wakeLock?.request('screen'); } catch {}
    } else if (document.visibilityState === 'hidden') wake = null;
  };
  document.addEventListener('visibilitychange', onVis);

  function setChrome(v) { chrome = v; root.classList.toggle('bare', !v); }

  // ---- gestures ----
  let t0 = null, pinch = null, lastTap = 0, tapTimer = null, dragging = false;
  const applyZoom = () => {
    const img = slides[1].img;
    img.style.transform = zoom.s === 1 ? '' : `translate(${zoom.x}px, ${zoom.y}px) scale(${zoom.s})`;
  };
  const dist = (a, b) => Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY);

  stage.addEventListener('touchstart', e => {
    if (e.touches.length === 2) {
      if (slides[1].tall) return;   // strips: double-tap shows the whole image instead
      pinch = { d: dist(e.touches[0], e.touches[1]), s: zoom.s };
      t0 = null;
    } else if (e.touches.length === 1) {
      const t = e.touches[0];
      stopMotion();
      t0 = { x: t.clientX, y: t.clientY, time: Date.now(), zx: zoom.x, zy: zoom.y, moved: false, axis: null,
        ty0: slides[1].ty || 0, samples: [] };
    }
  }, { passive: true });

  stage.addEventListener('touchmove', e => {
    e.preventDefault();
    if (pinch && e.touches.length === 2) {
      zoom.s = Math.min(6, Math.max(1, pinch.s * dist(e.touches[0], e.touches[1]) / pinch.d));
      if (zoom.s === 1) { zoom.x = zoom.y = 0; }
      applyZoom();
      return;
    }
    if (!t0 || e.touches.length !== 1) return;
    const t = e.touches[0];
    const dx = t.clientX - t0.x, dy = t.clientY - t0.y;
    if (Math.abs(dx) > 6 || Math.abs(dy) > 6) t0.moved = true;
    if (zoom.s > 1) { zoom.x = t0.zx + dx; zoom.y = t0.zy + dy; applyZoom(); return; }
    if (!t0.axis && t0.moved) {
      t0.axis = Math.abs(dx) > Math.abs(dy) ? 'x' : 'y';
      // Pull down to close; on a strip only when it's already at the top.
      t0.pull = t0.axis === 'y' && dy > 0 && (!slides[1].tall || t0.ty0 >= -1);
    }
    if (t0.axis === 'y' && !t0.pull && slides[1].tall) {
      const sl = slides[1];
      sl.ty = Math.max(minTy(sl), Math.min(0, t0.ty0 + dy)); applyTy(sl);
      const now = performance.now();
      t0.samples.push({ y: t.clientY, t: now });
      while (t0.samples.length > 2 && now - t0.samples[0].t > 100) t0.samples.shift();
    } else if (t0.axis === 'x') {
      dragging = true;
      track.style.transition = 'none';
      track.style.transform = `translateX(${dx}px)`;
    } else if (t0.pull && dy > 0) {
      root.style.setProperty('--pull', Math.min(1, dy / 300));
      track.style.transition = 'none';
      track.style.transform = `translateY(${dy}px)`;
    }
  }, { passive: false });

  stage.addEventListener('touchend', e => {
    if (pinch) {
      if (e.touches.length === 0) { pinch = null; if (zoom.s < 1.05) { zoom = { s: 1, x: 0, y: 0 }; applyZoom(); } }
      return;
    }
    if (!t0) return;
    const t = e.changedTouches[0];
    const dx = t.clientX - t0.x, dy = t.clientY - t0.y;
    const quick = Date.now() - t0.time < 300;
    root.style.removeProperty('--pull');
    if (dragging) {
      dragging = false;
      const threshold = quick ? 30 : window.innerWidth * 0.25;
      if (dx < -threshold) { go(1); if (playing) schedule(); }
      else if (dx > threshold) { go(-1); if (playing) schedule(); }
      else snapBack();
    } else if (t0.axis === 'y' && !t0.pull && slides[1].tall) {
      const sm = t0.samples, a = sm[0], b = sm[sm.length - 1];
      if (a && b && b.t - a.t > 10 && performance.now() - b.t < 80) fling((b.y - a.y) / (b.t - a.t));
    } else if (t0.axis === 'y' && zoom.s === 1) {
      if (dy > 110) close(); else snapBack();
    } else if (!t0.moved) {
      handleTap(t.clientX, t.clientY);
    }
    t0 = null;
  });

  function handleTap() {
    const now = Date.now();
    if (now - lastTap < 280) {
      clearTimeout(tapTimer);
      lastTap = 0;
      if (zoom.s > 1) { zoom = { s: 1, x: 0, y: 0 }; applyZoom(); }
      else if (isTall(cur())) { stripWhole = !stripWhole; slides.forEach(layoutSlot); if (playing) { schedule(); autoPan(); } }
      else { fill = !fill; slides.forEach(s => s.img.classList.toggle('fill', fill)); }
      return;
    }
    lastTap = now;
    tapTimer = setTimeout(() => {
      if (playing) { playing = false; clearTimeout(timer); stopMotion(); try { wake?.release(); } catch {} wake = null; playBtn.replaceChildren(icon('play')); setChrome(true); toast('Paused'); }
      else if (!chrome) { setChrome(true); }
      else setChrome(false);
    }, 280);
  }

  // Mouse/keyboard for desktop testing.
  stage.addEventListener('click', e => { if (!('ontouchstart' in window)) (e.clientX < innerWidth / 2 ? go(-1) : go(1)); });
  const onKey = e => {
    if (e.key === 'ArrowRight') { go(1); if (playing) schedule(); }
    else if (e.key === 'ArrowLeft') { go(-1); if (playing) schedule(); }
    else if (e.key === 'Escape') close();
    else if (e.key === ' ') { e.preventDefault(); playing ? stop() : play(); }
  };
  document.addEventListener('keydown', onKey);
  const onResize = () => slides.forEach(layoutSlot);
  window.addEventListener('resize', onResize);

  // ---- actions ----
  async function toggleFav() {
    const m = cur();
    await S.archive.commit([{ op: 'favorite.set', media: [m.id], value: !S.archive.favorites.has(m.id) }]);
    render();
  }

  function showInfo() {
    const m = cur();
    const p = S.archive.posts.get(m.postId);
    const row = (k, v) => v ? h('div', { class: 'kv' }, h('span', { class: 'k' }, k), h('span', { class: 'v' }, v)) : null;
    const link = (url, label) => h('a', { href: url, target: '_blank', rel: 'noopener noreferrer', class: 'link' }, label || url);
    sheet(close => {
      const chips = h('div', { class: 'chips wrap' });
      const drawChips = () => {
        chips.replaceChildren(...S.archive.galleryList().map(g => {
          const on = S.archive.members.get(g.id)?.has(m.id);
          return h('button', { class: 'chip' + (on ? ' on' : ''), onclick: async () => {
            await S.archive.commit([{ op: on ? 'membership.remove' : 'membership.add', gallery: g.id, media: [m.id] }]);
            drawChips();
          } }, g.name);
        }), h('button', { class: 'chip ghost', onclick: async () => {
          const gid = await pickGallery({ title: 'Add to gallery' });
          if (gid) { await S.archive.commit([{ op: 'membership.add', gallery: gid, media: [m.id] }]); drawChips(); }
        } }, '+ Gallery'));
      };
      drawChips();
      const tagChips = h('div', { class: 'chips wrap' });
      const drawTags = () => tagChips.replaceChildren(
        ...S.archive.mediaTags(m.id).map(t => h('span', { class: 'chip tag on' }, '#' + t)),
        h('button', { class: 'chip ghost', onclick: async () => { await editTags([m.id]); drawTags(); render(); } }, 'Edit tags'));
      drawTags();
      return [
        row('Saved', fmtDate(p.savedAt)),
        row('From', labelFor(p)),
        p.pageTitle ? row(p.via === 'pdf' ? 'File' : 'Page', p.pageTitle) : null,
        p.author ? row('Author', p.author) : null,
        p.caption ? h('p', { class: 'caption' }, p.caption) : null,
        p.sourceURL ? h('div', { class: 'kv' }, h('span', { class: 'k' }, 'Source'), link(p.sourceURL, 'Open original')) : null,
        p.imageURL ? h('div', { class: 'kv' }, h('span', { class: 'k' }, 'Image'), link(p.imageURL, 'Open image link')) : null,
        row('Size', `${m.w} × ${m.h} · ${fmtBytes(m.size)}`),
        h('div', { class: 'label' }, 'Tags'), tagChips,
        h('div', { class: 'label' }, 'Galleries'), chips,
        h('button', { class: 'btn block danger', onclick: async () => {
          if (!(await confirmBox({ title: 'Delete this image?', body: 'It’s removed from every gallery and from storage.', ok: 'Delete', danger: true }))) return;
          close();
          await deleteMedia([m.id]);
          list.splice(order[pos], 1);
          order = list.map((_, i) => i);
          if (!list.length) return closeViewer();
          pos = Math.min(pos, list.length - 1);
          render();
        } }, icon('trash', 18), ' Delete'),
      ];
    }, { title: 'Details' });
  }

  function showSettings() {
    sheet(() => {
      const val = h('span', { class: 'val' }, settings.interval + 's');
      const range = h('input', { type: 'range', min: 1, max: 60, value: settings.interval, class: 'range',
        oninput: e => { settings.interval = +e.target.value; val.textContent = settings.interval + 's'; save(); } });
      const toggle = (key, label) => h('label', { class: 'toggle' }, h('span', null, label),
        h('input', { type: 'checkbox', checked: settings[key], onchange: e => { settings[key] = e.target.checked; save(); } }));
      const seg = h('div', { class: 'seg' }, ...['fade', 'slide'].map(t => h('button', {
        class: settings.transition === t ? 'on' : '', onclick: e => {
          settings.transition = t; save();
          [...seg.children].forEach(b => b.classList.toggle('on', b === e.currentTarget));
        } }, t === 'fade' ? 'Fade' : 'Slide')));
      const dir = h('div', { class: 'seg' }, ...[[false, 'Forward'], [true, 'Reverse']].map(([v, t]) => h('button', {
        class: settings.reverse === v ? 'on' : '', onclick: e => {
          settings.reverse = v; save();
          [...dir.children].forEach(b => b.classList.toggle('on', b === e.currentTarget));
        } }, t)));
      return [
        h('div', { class: 'row-between' }, h('span', null, 'Interval'), val), range,
        toggle('loop', 'Loop'), toggle('shuffle', 'Shuffle'),
        h('div', { class: 'row-between' }, h('span', null, 'Direction'), dir),
        h('p', { class: 'muted tiny' }, 'Reverse plays from the last image back to the first, without changing the gallery\u2019s order. Shuffle ignores direction.'),
        h('div', { class: 'row-between' }, h('span', null, 'Transition'), seg),
        h('button', { class: 'btn primary block', onclick: () => { document.querySelector('.sheet-back')?.click(); play(); } }, icon('play', 18), ' Play'),
      ];
    }, { title: 'Slideshow' });
    const save = () => idb.put('kv', 'show:' + viewKey, { ...settings });
  }

  function closeViewer() { close(); }
  function close() {
    clearTimeout(timer); playing = false;
    cancelAnimationFrame(flingRaf); clearTimeout(panTimer);
    try { wake?.release(); } catch {}
    document.removeEventListener('keydown', onKey);
    window.removeEventListener('resize', onResize);
    document.removeEventListener('visibilitychange', onVis);
    document.body.classList.remove('no-scroll');
    root.classList.remove('in');
    setTimeout(() => root.remove(), 200);
  }

  render();
  if (autoplay) play();
  return { close };
}

export function labelFor(p) {
  if (!p) return '';
  if (p.via === 'paste') return 'Pasted';
  if (p.via === 'photos') return 'From Photos';
  if (p.via === 'pdf') return 'From a PDF';
  return { x: 'X', instagram: 'Instagram', reddit: 'Reddit', web: 'Web', import: 'Imported' }[p.source] || p.source;
}
