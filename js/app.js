import { h, $, icon, idb, fmtBytes, fmtDate } from './util.js';
import { S, isSetUp, hasPasscode, createArchive, unlock, lock, parseCode, backupCode, pairingCode,
  saveImages, deleteMedia, deletePosts, saveLinkOrImage, urls, saveB2, testB2, changePasscode, eraseDevice, LIMIT } from './core.js';
import { Store, onStoreEvent, monthDownloads, cachePolicy } from './store.js';
import { toast, sheet, askText, confirmBox, pickGallery, createGallery, progressBar, tagSheet, editTags } from './ui.js';
import { tagKey, cleanTag } from './log.js';
import { openViewer, labelFor } from './viewer.js';

const VERSION = '0.2.0';
const app = $('#app');
const ui = {
  tab: 'capture',
  libStack: [],          // [{filter, title, key}]
  editing: false,
  selecting: null,       // Set of media ids when selecting
  gallery: '',           // current capture gallery ('' = Unsorted)
  source: '',            // sticky source link for capture
  recent: [],            // media ids saved this session
  capTags: [],           // tags applied to the next saves
  sort: 'new',           // grid order: 'new' | 'old'
  lastSync: null,
  syncing: false,
};

// ---------------------------------------------------------------- boot
async function boot() {
  if ('serviceWorker' in navigator) navigator.serviceWorker.register('./sw.js').catch(() => {});
  if (!(await isSetUp())) return renderSetup();
  if (await hasPasscode()) return renderLock();
  await unlock(null);
  enterApp();
}

async function enterApp() {
  ui.gallery = (await idb.get('kv', 'lastGallery')) || '';
  const g = S.archive.galleries.get(ui.gallery);
  if (!g || g.deleted) ui.gallery = '';
  ui.source = (await idb.get('kv', 'lastSource')) || '';
  ui.capTags = (await idb.get('kv', 'capTags')) || [];
  ui.sort = (await idb.get('kv', 'sort')) || 'new';
  S.archive.onChange(() => scheduleRender());
  renderMain();
  syncNow();
}

let renderQueued = false;
function scheduleRender() {
  if (renderQueued) return;
  renderQueued = true;
  requestAnimationFrame(() => { renderQueued = false; if (S.archive) renderMain({ keepScroll: true }); });
}

// ---------------------------------------------------------------- lock timing
let hiddenAt = null;
document.addEventListener('visibilitychange', async () => {
  if (document.visibilityState === 'hidden') { hiddenAt = Date.now(); return; }
  if (!S.archive) return;
  const after = (await idb.get('kv', 'lockAfter')) ?? 5 * 60000;
  if (S.hasPass && hiddenAt && after >= 0 && Date.now() - hiddenAt >= after) {
    lock();
    document.querySelectorAll('.viewer,.sheet,.sheet-back').forEach(n => n.remove());
    document.body.classList.remove('no-scroll');
    return renderLock();
  }
  syncNow();
});
setInterval(() => { if (document.visibilityState === 'visible' && S.archive) syncNow(); }, 60000);

// ---------------------------------------------------------------- sync
async function syncNow(manual = false) {
  if (!Store.remote || !S.archive || ui.syncing) return;
  ui.syncing = true;
  try {
    await Store.flush();
    await S.archive.pull();
    ui.lastSync = Date.now();
    if (manual) toast('Up to date');
  } catch (e) {
    if (manual) toast(e.message, { ms: 5000, kind: 'err' });
  } finally {
    ui.syncing = false;
    if (ui.tab === 'settings') scheduleRender();
  }
}
onStoreEvent(ev => { if (ev.type === 'outbox' && ui.tab === 'settings') scheduleRender(); });

// ---------------------------------------------------------------- setup
function renderSetup() {
  const step = (content) => app.replaceChildren(h('div', { class: 'setup' }, content));

  const welcome = () => step([
    h('div', { class: 'brand' }, icon('photos', 44)),
    h('h1', null, 'Your private image archive'),
    h('p', { class: 'muted' }, 'Everything is encrypted on this iPhone before it’s stored anywhere. Only you can see it.'),
    h('button', { class: 'btn primary block', onclick: () => passStep({}) }, 'Create a new archive'),
    h('button', { class: 'btn block ghost', onclick: restoreStep }, 'Restore from a backup or pairing code'),
    installHint(),
  ]);

  const restoreStep = () => {
    const ta = h('textarea', { class: 'field mono', rows: 4, placeholder: 'ARCH1-… or ARCHP1-…', autocapitalize: 'off', autocomplete: 'off', spellcheck: false });
    const err = h('p', { class: 'err' });
    step([
      h('h1', null, 'Restore'),
      h('p', { class: 'muted' }, 'Paste the backup code from your password manager. A pairing code also brings your Backblaze settings.'),
      ta, err,
      h('button', { class: 'btn primary block', onclick: () => {
        try { const parsed = parseCode(ta.value); passStep(parsed); } catch (e) { err.textContent = e.message; }
      } }, 'Continue'),
      h('button', { class: 'btn block ghost', onclick: welcome }, 'Back'),
    ]);
  };

  const passStep = (restore) => {
    const a = h('input', { class: 'field pin', type: 'password', inputmode: 'numeric', autocomplete: 'off', placeholder: 'Passcode (6+ digits)' });
    const b = h('input', { class: 'field pin', type: 'password', inputmode: 'numeric', autocomplete: 'off', placeholder: 'Repeat passcode' });
    const err = h('p', { class: 'err' });
    const go = async (pass) => {
      if (pass !== null) {
        if (!/^\d{6,}$/.test(a.value)) return (err.textContent = 'Use at least 6 digits.');
        if (a.value !== b.value) return (err.textContent = 'The passcodes don’t match.');
      }
      err.textContent = 'Setting up…';
      await createArchive({ raw: restore.raw, pass: pass === null ? null : a.value, b2: restore.b2 });
      if (restore.raw) return finishRestore();
      backupStep();
    };
    step([
      h('h1', null, 'Set a passcode'),
      h('p', { class: 'muted' }, 'It unlocks the archive on this phone and encrypts the key that protects it.'),
      a, b, err,
      h('button', { class: 'btn primary block', onclick: () => go('') }, 'Continue'),
      h('button', { class: 'btn block ghost', onclick: () => go(null) }, 'Skip: no lock on this phone'),
    ]);
    setTimeout(() => a.focus(), 100);
  };

  const backupStep = () => {
    const code = backupCode();
    const ok = h('input', { type: 'checkbox', onchange: e => { cont.disabled = !e.target.checked; } });
    const cont = h('button', { class: 'btn primary block', disabled: true, onclick: () => { ui.tab = 'capture'; enterApp(); } }, 'Start saving');
    step([
      h('h1', null, 'Save your backup code'),
      h('p', { class: 'muted' }, 'This is the only key to your archive. If this phone is lost or the app is removed from the Home Screen, you need it to get your images back. Keep it in your password manager. Never screenshot it.'),
      h('div', { class: 'code' }, code),
      h('button', { class: 'btn block', onclick: async () => { await copy(code); toast('Copied'); } }, 'Copy code'),
      h('label', { class: 'check' }, ok, h('span', null, 'I saved it in my password manager')),
      cont,
    ]);
  };

  const finishRestore = async () => {
    if (Store.remote) {
      const bar = progressBar();
      step([h('h1', null, 'Restoring'), h('p', { class: 'muted' }, 'Downloading your archive’s index from Backblaze…'), bar.el]);
      try {
        await S.archive.reconcileRemote();
        await S.archive.pull();
        await Store.flush();
      } catch (e) {
        toast(e.message, { ms: 6000, kind: 'err' });
      }
    }
    ui.tab = 'library';
    enterApp();
  };

  welcome();
}

function installHint() {
  const standalone = window.matchMedia('(display-mode: standalone)').matches || navigator.standalone;
  if (standalone) return null;
  return h('div', { class: 'note' }, h('b', null, 'Add to Home Screen first. '),
    'In Safari tap Share → Add to Home Screen, then open it from there. The Home Screen app keeps its own storage, so set it up there.');
}

// ---------------------------------------------------------------- lock
function renderLock() {
  const input = h('input', { class: 'field pin', type: 'password', inputmode: 'numeric', autocomplete: 'off', placeholder: 'Passcode' });
  const err = h('p', { class: 'err' });
  const go = async () => {
    err.textContent = '';
    try {
      await unlock(input.value);
      enterApp();
    } catch {
      err.textContent = 'Wrong passcode';
      input.value = '';
      input.classList.add('shake');
      setTimeout(() => input.classList.remove('shake'), 400);
    }
  };
  input.addEventListener('keydown', e => { if (e.key === 'Enter') go(); });
  input.addEventListener('input', () => { if (input.value.length >= 6) clearTimeout(input._t), input._t = setTimeout(go, 350); });
  app.replaceChildren(h('div', { class: 'setup lock' },
    h('div', { class: 'brand' }, icon('lock', 40)),
    h('h1', null, 'Locked'),
    input, err,
    h('button', { class: 'btn primary block', onclick: go }, 'Unlock'),
    h('button', { class: 'btn block ghost small', onclick: forgot }, 'Forgot passcode?'),
  ));
  setTimeout(() => input.focus(), 150);
}

async function forgot() {
  const ok = await confirmBox({ title: 'Erase this phone’s copy?',
    body: 'The passcode can’t be recovered. You can erase this phone’s copy and restore with your backup or pairing code. Anything not yet uploaded to Backblaze will be lost.',
    ok: 'Erase and restore', danger: true });
  if (!ok) return;
  await eraseDevice();
  renderSetup();
}

// ---------------------------------------------------------------- main shell
function renderMain({ keepScroll = false } = {}) {
  const prev = $('.content');
  const scroll = keepScroll && prev ? prev.scrollTop : 0;
  let header, content, footer;
  if (ui.tab === 'library') {
    const top = ui.libStack[ui.libStack.length - 1];
    [header, content, footer] = !top ? libraryHome() : top.filter.type === 'links' ? linksView() : gridView();
  }
  else if (ui.tab === 'capture') [header, content] = captureView();
  else [header, content] = settingsView();
  const main = h('main', { class: 'content' }, content);
  app.replaceChildren(h('div', { class: 'screen' }, header, main, footer || tabBar()));
  if (scroll) main.scrollTop = scroll;
}

function tabBar() {
  const tab = (id, ic, label) => h('button', { class: 'tab' + (ui.tab === id ? ' on' : ''), onclick: () => {
    if (ui.tab === id && id === 'library') { ui.libStack = []; ui.selecting = null; }
    ui.tab = id; ui.editing = false; renderMain();
  } }, icon(ic, 24), h('span', null, label));
  return h('nav', { class: 'tabs' }, tab('library', 'library', 'Library'), tab('capture', 'clip', 'Save'), tab('settings', 'gear', 'Settings'));
}

function topBar(title, { back, actions = [] } = {}) {
  return h('header', { class: 'top' },
    back ? h('button', { class: 'icon-btn', 'aria-label': 'Back', onclick: back }, icon('back')) : null,
    h('h2', null, title), h('span', { class: 'grow' }), ...actions);
}

// ---------------------------------------------------------------- thumbnails
const io = 'IntersectionObserver' in window ? new IntersectionObserver(entries => {
  for (const e of entries) {
    if (!e.isIntersecting) continue;
    io.unobserve(e.target);
    const m = e.target._m;
    urls.thumb(m).then(u => { e.target.style.backgroundImage = `url("${u}")`; e.target.classList.add('loaded'); })
      .catch(() => e.target.classList.add('missing'));
  }
}, { rootMargin: '800px 0px' }) : null;

function thumbEl(m, cls = 'thumb') {
  const el = h('div', { class: cls });
  el._m = m;
  if (io) io.observe(el); else urls.thumb(m).then(u => { el.style.backgroundImage = `url("${u}")`; });
  return el;
}

// ---------------------------------------------------------------- library
function libraryHome() {
  const A = S.archive;
  const all = A.list({ type: 'all' });
  const open = (filter, title, key) => { ui.libStack = [{ filter, title, key }]; renderMain(); };
  const card = (title, list, filter, key) => h('button', { class: 'card', onclick: () => open(filter, title, key) },
    list.length ? thumbEl(list[0], 'cover') : h('div', { class: 'cover empty' }, icon('photos', 28)),
    h('div', { class: 'card-meta' }, h('span', { class: 'name' }, title), h('span', { class: 'count' }, list.length)));

  const galleries = A.galleryList();
  let galleriesEl;
  if (ui.editing) {
    galleriesEl = h('div', { class: 'edit-list' }, ...galleries.map((g, i) => h('div', { class: 'edit-row' },
      h('span', { class: 'name' }, g.name),
      h('button', { class: 'icon-btn', 'aria-label': 'Move up', disabled: i === 0, onclick: () => reorder(galleries, i, -1) }, icon('up', 20)),
      h('button', { class: 'icon-btn', 'aria-label': 'Move down', disabled: i === galleries.length - 1, onclick: () => reorder(galleries, i, 1) }, icon('down', 20)),
      h('button', { class: 'icon-btn', 'aria-label': 'Rename', onclick: async () => {
        const name = await askText({ title: 'Rename gallery', value: g.name });
        if (name && name !== g.name) await A.commit([{ op: 'gallery.rename', id: g.id, name }]);
      } }, icon('edit', 20)),
      h('button', { class: 'icon-btn danger', 'aria-label': 'Delete', onclick: async () => {
        if (await confirmBox({ title: `Delete “${g.name}”?`, body: 'Only the gallery is removed. Its images stay in your archive (in Unsorted if they’re in no other gallery).', ok: 'Delete gallery', danger: true }))
          await A.commit([{ op: 'gallery.delete', id: g.id }]);
      } }, icon('trash', 20)))));
    if (!galleries.length) galleriesEl.append(h('p', { class: 'muted' }, 'No galleries yet.'));
  } else {
    galleriesEl = h('div', { class: 'cards' }, ...galleries.map(g => card(g.name, A.list({ type: 'gallery', id: g.id }), { type: 'gallery', id: g.id }, 'g:' + g.id)));
    if (!galleries.length) galleriesEl = h('p', { class: 'muted' }, 'Create galleries here or while saving.');
  }

  const sources = [['paste', 'Pasted'], ['photos', 'From Photos']].map(([via, t]) => [{ type: 'via', via }, t, 'via:' + via])
    .concat(['x', 'instagram', 'reddit'].map(s => [{ type: 'source', source: s }, labelFor({ source: s }), 'src:' + s]))
    .map(([f, t, k]) => [f, t, k, A.list(f)]).filter(x => x[3].length);

  const links = A.links();
  const tags = A.tagList();
  const untagged = tags.length ? A.list({ type: 'untagged' }).length : 0;
  const content = [
    !all.length ? h('div', { class: 'empty-state' }, icon('photos', 40), h('p', null, 'Nothing saved yet.'),
      h('button', { class: 'btn primary', onclick: () => { ui.tab = 'capture'; renderMain(); } }, 'Save your first image')) : null,
    h('div', { class: 'cards' },
      card('All', all, { type: 'all' }, 'all'),
      card('Unsorted', A.list({ type: 'unsorted' }), { type: 'unsorted' }, 'unsorted'),
      card('Favorites', A.list({ type: 'fav' }), { type: 'fav' }, 'fav')),
    h('div', { class: 'section-head' }, h('h3', null, 'Galleries'), h('span', { class: 'grow' }),
      h('button', { class: 'link-btn', onclick: async () => {
        const name = await askText({ title: 'New gallery', placeholder: 'Name', ok: 'Create' });
        if (name) await createGallery(name);
      } }, 'New'),
      galleries.length ? h('button', { class: 'link-btn', onclick: () => { ui.editing = !ui.editing; renderMain(); } }, ui.editing ? 'Done' : 'Edit') : null),
    galleriesEl,
    h('div', { class: 'section-head' }, h('h3', null, 'Tags'), h('span', { class: 'grow' }),
      tags.length ? h('button', { class: 'link-btn', onclick: async () => { await manageTags(); renderMain(); } }, 'Edit') : null),
    tags.length ? h('div', { class: 'chips wrap tag-cloud' },
      ...tags.map(t => h('button', { class: 'chip tag', onclick: () => open({ type: 'tags', tags: [t.key] }, '#' + t.name, 'tags:' + t.key) },
        '#' + t.name, h('span', { class: 'n' }, t.count))),
      untagged ? h('button', { class: 'chip ghost tag', onclick: () => open({ type: 'untagged' }, 'Untagged', 'untagged') }, 'Untagged', h('span', { class: 'n' }, untagged)) : null)
      : h('p', { class: 'muted small' }, all.length ? 'No tags yet. Tag images from the viewer’s ⓘ button, or tap Select in any gallery and use Tags.' : 'Tags you add show up here.'),
    links.length ? h('div', { class: 'section-head' }, h('h3', null, 'Links')) : null,
    links.length ? h('button', { class: 'list-row', onclick: () => open({ type: 'links' }, 'Saved links', 'links') },
      icon('link', 20), h('span', { class: 'grow' }, 'Saved links'), h('span', { class: 'muted' }, links.length), icon('back', 16)) : null,
    sources.length ? h('div', { class: 'section-head' }, h('h3', null, 'By source')) : null,
    sources.length ? h('div', { class: 'cards' }, ...sources.map(([f, t, k, l]) => card(t, l, f, k))) : null,
  ];
  return [topBar('Library'), content];
}

async function reorder(galleries, i, d) {
  const ids = galleries.map(g => g.id);
  [ids[i], ids[i + d]] = [ids[i + d], ids[i]];
  await S.archive.commit([{ op: 'gallery.reorder', ids }]);
}

function linksView() {
  const A = S.archive;
  const links = A.links();
  const back = () => { ui.libStack.pop(); renderMain(); };
  const rows = links.map(p => {
    let host = p.sourceURL, path = '';
    try { const u = new URL(p.sourceURL); host = u.hostname.replace(/^www\./, ''); path = u.pathname + u.search; } catch {}
    const g = p.gallery && A.galleries.get(p.gallery);
    return h('div', { class: 'link-item' },
      h('a', { href: p.sourceURL, target: '_blank', rel: 'noopener noreferrer', class: 'link-main' },
        h('div', { class: 'link-host' }, labelFor({ source: p.source }) + ' \u00b7 ' + host),
        h('div', { class: 'link-path' }, path || p.sourceURL),
        h('div', { class: 'muted tiny' }, fmtDate(p.savedAt), g && !g.deleted ? ' \u00b7 for ' + g.name : '')),
      h('button', { class: 'icon-btn', 'aria-label': 'Copy link', onclick: async () => { await copy(p.sourceURL); toast('Link copied'); } }, icon('clip', 20)),
      h('button', { class: 'icon-btn danger', 'aria-label': 'Delete link', onclick: async () => {
        if (await confirmBox({ title: 'Delete this link?', ok: 'Delete', danger: true })) await deletePosts([p.id]);
      } }, icon('trash', 20)));
  });
  const content = [
    h('p', { class: 'muted small' }, 'Links you pasted. A later step (the Mac helper) will fetch their images into the gallery you picked. To save a picture now, open the link and use Copy Image.'),
    rows.length ? h('div', null, rows) : h('div', { class: 'empty-state' }, h('p', null, 'No saved links.')),
  ];
  return [topBar('Saved links', { back }), content];
}

const PAGE = 180;
function filterTitle(top) {
  const A = S.archive;
  if (top.filter.type === 'gallery') return A.galleries.get(top.filter.id).name;
  if (top.filter.type === 'tags') return top.filter.tags.map(k => '#' + (A.tagNames.get(k) || k)).join(' + ');
  return top.title;
}

function gridView() {
  const A = S.archive;
  const top = ui.libStack[ui.libStack.length - 1];
  if (top.filter.type === 'gallery' && (!A.galleries.get(top.filter.id) || A.galleries.get(top.filter.id).deleted)) {
    ui.libStack = []; return libraryHome();
  }
  if (top.filter.type === 'tags') {
    top.filter.tags = top.filter.tags.filter(k => A.tagNames.has(k));
    if (!top.filter.tags.length) { ui.libStack.pop(); return ui.libStack.length ? gridView() : libraryHome(); }
    top.key = 'tags:' + top.filter.tags.join(',');
  }
  const title = filterTitle(top);
  let list = A.list(top.filter);
  if (ui.sort === 'old') list = list.slice().reverse();
  const sel = ui.selecting;
  const back = () => { ui.libStack.pop(); ui.selecting = null; renderMain(); };

  const grid = h('div', { class: 'grid' });
  let shown = 0;
  const more = () => {
    const slice = list.slice(shown, shown + PAGE);
    slice.forEach((m, j) => {
      const i = shown + j;
      const cell = thumbEl(m, 'cell');
      if (sel && sel.has(m.id)) cell.classList.add('sel');
      if (A.favorites.has(m.id)) cell.append(h('span', { class: 'badge fav' }, icon('heartFill', 14)));
      cell.addEventListener('click', () => {
        if (ui.selecting) {
          ui.selecting.has(m.id) ? ui.selecting.delete(m.id) : ui.selecting.add(m.id);
          cell.classList.toggle('sel');
          const c = $('.sel-count'); if (c) c.textContent = `${ui.selecting.size} selected`;
        } else openViewer(list, i, { viewKey: top.key });
      });
      grid.append(cell);
    });
    shown += slice.length;
    if (shown < list.length) {
      const s = h('div', { class: 'sentinel' });
      grid.append(s);
      const ob = new IntersectionObserver(es => { if (es[0].isIntersecting) { ob.disconnect(); s.remove(); more(); } }, { rootMargin: '1200px 0px' });
      ob.observe(s);
    }
  };
  more();

  const actions = sel
    ? [h('button', { class: 'link-btn', onclick: () => {
        const allOn = list.every(m => sel.has(m.id));
        ui.selecting = allOn ? new Set() : new Set(list.map(m => m.id));
        renderMain({ keepScroll: true });
      } }, list.every(m => sel.has(m.id)) ? 'Deselect all' : 'Select all'),
      h('button', { class: 'link-btn', onclick: () => { ui.selecting = null; renderMain({ keepScroll: true }); } }, 'Cancel')]
    : [list.length > 1 ? h('button', { class: 'icon-btn', 'aria-label': ui.sort === 'old' ? 'Showing oldest first' : 'Showing newest first', onclick: async () => {
        ui.sort = ui.sort === 'old' ? 'new' : 'old';
        await idb.put('kv', 'sort', ui.sort);
        toast(ui.sort === 'old' ? 'Oldest first' : 'Newest first', { ms: 1200 });
        renderMain();
      } }, icon(ui.sort === 'old' ? 'sortUp' : 'sortDown')) : null,
      list.length ? h('button', { class: 'icon-btn', 'aria-label': 'Play slideshow', onclick: () => openViewer(list, 0, { viewKey: top.key, autoplay: true }) }, icon('play')) : null,
      list.length ? h('button', { class: 'link-btn', onclick: () => { ui.selecting = new Set(); renderMain({ keepScroll: true }); } }, 'Select') : null];

  // Tag views: the active tags, tap to drop one, "+ Tag" to narrow further (images must have all of them).
  const tagBar = top.filter.type === 'tags' ? h('div', { class: 'chips' },
    ...top.filter.tags.map(k => h('button', { class: 'chip tag on', onclick: () => {
      top.filter.tags = top.filter.tags.filter(x => x !== k);
      if (!top.filter.tags.length) ui.libStack.pop();
      renderMain();
    } }, '#' + (A.tagNames.get(k) || k), h('span', { class: 'x' }, '×'))),
    h('button', { class: 'chip ghost', onclick: async () => {
      await tagSheet({
        title: 'Show images tagged',
        hint: 'Images must have every highlighted tag.',
        state: key => top.filter.tags.includes(key) ? 'on' : 'off',
        toggle: (name, st) => {
          const key = tagKey(name);
          top.filter.tags = st === 'on' ? top.filter.tags.filter(x => x !== key) : [...top.filter.tags, key];
        },
      });
      if (!top.filter.tags.length) ui.libStack.pop();
      renderMain();
    } }, '+ Tag')) : null;

  const content = [
    tagBar,
    h('div', { class: 'grid-meta muted' }, `${list.length} image${list.length === 1 ? '' : 's'}${list.length > 1 ? ' · ' + (ui.sort === 'old' ? 'oldest first' : 'newest first') : ''}`),
    list.length ? grid : h('div', { class: 'empty-state' }, h('p', null, 'Nothing here yet.')),
  ];
  const footer = sel ? selectionBar(top) : null;
  return [topBar(title, { back, actions }), content, footer];
}

function selectionBar(top) {
  const ids = () => [...ui.selecting];
  const need = fn => async () => { if (!ui.selecting.size) return toast('Select some images first'); await fn(); };
  const done = () => { ui.selecting = null; renderMain({ keepScroll: true }); };
  const inGallery = top.filter.type === 'gallery';
  const galleryActions = async () => {
    const choice = await sheet(close => [
      h('div', { class: 'pick-list' },
        h('button', { class: 'row', onclick: () => close('add') }, 'Add to a gallery…'),
        inGallery ? h('button', { class: 'row', onclick: () => close('move') }, 'Move to another gallery…') : null,
        inGallery ? h('button', { class: 'row', onclick: () => close('remove') }, `Remove from “${S.archive.galleries.get(top.filter.id).name}”`) : null),
    ], { title: `${ui.selecting.size} selected` });
    if (!choice) return;
    if (choice === 'remove') {
      await S.archive.commit([{ op: 'membership.remove', gallery: top.filter.id, media: ids() }]);
      toast('Removed from gallery'); return done();
    }
    const gid = await pickGallery({ title: choice === 'move' ? 'Move to gallery' : 'Add to gallery', exclude: inGallery ? top.filter.id : null });
    if (!gid) return;
    const ops = [{ op: 'membership.add', gallery: gid, media: ids() }];
    if (choice === 'move') ops.push({ op: 'membership.remove', gallery: top.filter.id, media: ids() });
    await S.archive.commit(ops);
    toast(choice === 'move' ? 'Moved' : 'Added'); done();
  };
  return h('nav', { class: 'selbar' },
    h('span', { class: 'sel-count' }, `${ui.selecting.size} selected`),
    h('button', { class: 'link-btn', onclick: need(galleryActions) }, 'Gallery'),
    h('button', { class: 'link-btn', onclick: need(async () => { await editTags(ids()); done(); }) }, 'Tags'),
    h('button', { class: 'icon-btn', 'aria-label': 'Favorite', onclick: need(async () => {
      const all = ids().every(id => S.archive.favorites.has(id));
      await S.archive.commit([{ op: 'favorite.set', media: ids(), value: !all }]);
      done();
    }) }, icon('heart')),
    h('button', { class: 'icon-btn danger', 'aria-label': 'Delete', onclick: need(async () => {
      const n = ui.selecting.size;
      if (!(await confirmBox({ title: `Delete ${n} image${n === 1 ? '' : 's'}?`, body: 'They’re removed from every gallery and from storage.', ok: 'Delete', danger: true }))) return;
      await deleteMedia(ids());
      toast('Deleted'); done();
    }) }, icon('trash')));
}

// Rename or delete tags everywhere.
function manageTags() {
  const A = S.archive;
  return sheet(() => {
    const box = h('div');
    const draw = () => box.replaceChildren(...A.tagList().map(t => h('div', { class: 'edit-row' },
      h('span', { class: 'name' }, '#' + t.name, h('span', { class: 'muted small' }, ' · ' + t.count)),
      h('button', { class: 'icon-btn', 'aria-label': 'Rename tag', onclick: async () => {
        const name = await askText({ title: 'Rename tag', value: t.name });
        if (name && cleanTag(name) && cleanTag(name) !== t.name) { await A.commit([{ op: 'tag.rename', from: t.name, to: name }]); draw(); }
      } }, icon('edit', 20)),
      h('button', { class: 'icon-btn danger', 'aria-label': 'Delete tag', onclick: async () => {
        if (await confirmBox({ title: `Delete #${t.name}?`, body: `Removes the tag from ${t.count} image${t.count === 1 ? '' : 's'}. The images stay.`, ok: 'Delete tag', danger: true })) {
          await A.commit([{ op: 'tag.delete', tag: t.name }]); draw();
        }
      } }, icon('trash', 20)))));
    draw();
    return [h('p', { class: 'muted small' }, 'Renaming to an existing tag merges the two.'), box];
  }, { title: 'Manage tags', tall: true });
}

// ---------------------------------------------------------------- capture
const pasteLog = [];   // recent paste attempts, shown under "What happened?"
function logPaste(entry) {
  pasteLog.unshift({ at: new Date().toLocaleTimeString(), ...entry });
  pasteLog.length = Math.min(pasteLog.length, 8);
  const el = $('.paste-log'); if (el) el.replaceChildren(...pasteLogRows());
}
function pasteLogRows() {
  if (!pasteLog.length) return [h('div', null, 'No paste attempts yet.')];
  return pasteLog.map(e => h('div', { class: 'log-row' }, `${e.at} · ${e.via} · ${e.msg}`));
}
function setStatus(msg) {
  ui.capStatus = msg;
  const el = $('.cap-status'); if (el) el.textContent = msg;
}

function captureView() {
  const A = S.archive;
  const galleries = A.galleryList();
  const setGallery = async (id) => { ui.gallery = id; await idb.put('kv', 'lastGallery', id); renderMain({ keepScroll: true }); };
  const chips = h('div', { class: 'chips' },
    h('button', { class: 'chip' + (!ui.gallery ? ' on' : ''), onclick: () => setGallery('') }, 'Unsorted'),
    ...galleries.map(g => h('button', { class: 'chip' + (ui.gallery === g.id ? ' on' : ''), onclick: () => setGallery(g.id) }, g.name)),
    h('button', { class: 'chip ghost', onclick: async () => {
      const name = await askText({ title: 'New gallery', placeholder: 'Name', ok: 'Create' });
      if (name) setGallery(await createGallery(name));
    } }, '+ New'));

  const setCapTags = async (tags) => { ui.capTags = tags; await idb.put('kv', 'capTags', tags); };
  const capTagRow = h('div', { class: 'chips' },
    h('span', { class: 'chip-label' }, 'Tags'),
    ...ui.capTags.map(t => h('button', { class: 'chip tag on', 'aria-label': `Remove tag ${t}`, onclick: async () => {
      await setCapTags(ui.capTags.filter(x => x !== t)); renderMain({ keepScroll: true });
    } }, '#' + t, h('span', { class: 'x' }, '×'))),
    h('button', { class: 'chip ghost', onclick: async () => {
      await tagSheet({
        title: 'Tags for the next saves',
        hint: 'Every image you save gets these tags until you remove them.',
        state: key => ui.capTags.some(t => tagKey(t) === key) ? 'on' : 'off',
        toggle: (name, st) => setCapTags(st === 'on' ? ui.capTags.filter(t => tagKey(t) !== tagKey(name)) : [...ui.capTags, cleanTag(name)]),
        extra: () => ui.capTags,
      });
      renderMain({ keepScroll: true });
    } }, ui.capTags.length ? '+' : '+ Tag'));
  const status = h('div', { class: 'cap-status', 'aria-live': 'polite' }, ui.capStatus || '');
  const bar = progressBar();
  bar.el.hidden = true;

  const pasteBtn = h('button', { class: 'paste-btn', onclick: () => pasteFromClipboard() },
    icon('clip', 34), h('span', { class: 'big' }, 'Paste'),
    h('span', { class: 'small' }, 'Copy Image (or Copy Link) in Chrome, tap here, then tap the Paste bubble'));

  // Fallback: the system paste menu. Long-press the box and choose Paste.
  const zone = h('div', { class: 'paste-zone', contenteditable: 'true', inputmode: 'none', role: 'textbox',
    'aria-label': 'Paste box', autocapitalize: 'off', spellcheck: 'false' });
  zone.addEventListener('paste', e => onPasteEvent(e, 'box'));
  zone.addEventListener('input', () => rescueInsertedImages(zone));

  const file = h('input', { type: 'file', accept: 'image/*', multiple: true, hidden: true, onchange: async e => {
    const files = [...e.target.files];
    e.target.value = '';
    if (!files.length) return;
    bar.el.hidden = false;
    const res = await saveImages(files, { via: 'photos', source: 'import', gallery: ui.gallery || null, tags: ui.capTags },
      (d, t) => bar.set(d, t, `Saving ${Math.min(d + 1, t)} of ${t}…`));
    bar.el.hidden = true;
    reportSave(res, true);
  } });

  const srcInput = h('input', { class: 'field', type: 'url', placeholder: 'Page link for the next saves (optional)', value: ui.source,
    autocapitalize: 'off', autocomplete: 'off', onchange: e => { ui.source = e.target.value.trim(); idb.put('kv', 'lastSource', ui.source); } });
  const srcRow = h('div', { class: 'src-row' }, srcInput,
    ui.source ? h('button', { class: 'icon-btn', 'aria-label': 'Clear page link', onclick: () => { ui.source = ''; idb.put('kv', 'lastSource', ''); renderMain({ keepScroll: true }); } }, icon('close', 18)) : null);

  const usage = A.usage();
  const recent = ui.recent.map(id => A.media.get(id)).filter(m => m && !m.deleted);
  const content = [
    h('div', { class: 'label' }, 'Save to'), chips,
    capTagRow,
    pasteBtn,
    zone,
    status,
    h('button', { class: 'btn block', onclick: () => file.click() }, icon('photos', 20), ' Import from Photos'), file,
    bar.el,
    recent.length ? h('div', { class: 'section-head' }, h('h3', null, `Saved this session · ${recent.length}`)) : null,
    recent.length ? h('div', { class: 'strip' }, ...recent.slice(0, 24).map((m, i) => {
      const t = thumbEl(m, 'strip-item');
      t.addEventListener('click', () => openViewer(recent, i, { viewKey: 'recent' }));
      return t;
    })) : null,
    h('details', { class: 'more' }, h('summary', null, 'Page link (optional)'),
      h('p', { class: 'muted small' }, 'Attached to every image you save until you clear it. Handy when saving several images from one page.'), srcRow),
    h('details', { class: 'more' }, h('summary', null, 'What happened? (paste log)'),
      h('div', { class: 'paste-log' }, ...pasteLogRows())),
    h('p', { class: 'muted tiny center' }, `${fmtBytes(usage)} of 9 GB used`, Store.remote ? '' : ' · stored on this phone only'),
  ];
  return [topBar('Save'), content];
}

const isURL = t => /^https?:\/\/\S+$/i.test(t || '');

// Tap-to-paste via the async clipboard API (iOS shows a "Paste" bubble).
async function pasteFromClipboard() {
  if (!navigator.clipboard?.read) {
    logPaste({ via: 'button', msg: 'clipboard.read not available' });
    setStatus('This browser can’t read the clipboard from a button. Long-press the box below and tap Paste.');
    return;
  }
  setStatus('Tap the Paste bubble…');
  let items;
  try { items = await navigator.clipboard.read(); }
  catch (e) {
    logPaste({ via: 'button', msg: `read failed: ${e.name} ${e.message || ''}`.trim() });
    setStatus('Couldn’t read the clipboard. Long-press the box below and tap Paste instead.');
    return;
  }
  const blobs = [];
  let text = '';
  const types = [];
  for (const it of items) {
    types.push(...it.types);
    const t = it.types.find(t => t.startsWith('image/'));
    if (t) { try { blobs.push(await it.getType(t)); } catch (e) { logPaste({ via: 'button', msg: `getType(${t}) failed: ${e.name}` }); } }
    for (const tt of ['text/uri-list', 'text/plain']) {
      if (!text && it.types.includes(tt)) { try { text = (await (await it.getType(tt)).text()).trim().split(/\s+/)[0]; } catch {} }
    }
  }
  logPaste({ via: 'button', msg: `types [${types.join(', ') || 'none'}]` });
  await handleClip(blobs, text, types);
}

// Paste events (the paste box, or a hardware keyboard).
function onPasteEvent(e, via) {
  const dt = e.clipboardData;
  const blobs = [];
  for (const f of dt?.files || []) if (f.type.startsWith('image/')) blobs.push(f);
  if (!blobs.length) for (const it of dt?.items || []) {
    if (it.kind === 'file' && it.type.startsWith('image/')) { const f = it.getAsFile(); if (f) blobs.push(f); }
  }
  const text = ((dt?.getData('text/uri-list') || dt?.getData('text/plain') || '').trim().split(/\s+/)[0]) || '';
  const types = [...(dt?.types || [])];
  logPaste({ via, msg: `types [${types.join(', ') || 'none'}], ${blobs.length} image file(s)` });
  if (blobs.length || isURL(text)) {
    e.preventDefault();
    e.target.blur?.();
    handleClip(blobs, text, types);
  }
  // Otherwise let the paste land in the box; rescueInsertedImages() checks it.
}

// Some iOS versions insert a pasted image as an <img> instead of exposing a file.
async function rescueInsertedImages(zone) {
  const imgs = [...zone.querySelectorAll('img')];
  const text = zone.innerText.trim();
  zone.replaceChildren();
  zone.blur();
  const blobs = [];
  for (const img of imgs) {
    try {
      if (/^(blob|data):/.test(img.src)) blobs.push(await (await fetch(img.src)).blob());
      else logPaste({ via: 'box', msg: `pasted image not readable (${img.src.slice(0, 30)}…)` });
    } catch (e) { logPaste({ via: 'box', msg: `inserted image failed: ${e.name}` }); }
  }
  if (blobs.length || text) await handleClip(blobs, isURL(text) ? text : '', ['(inserted)']);
}

async function handleClip(blobs, text, types) {
  if (blobs.length) return savePasted(blobs, isURL(text) ? text : null);
  if (isURL(text)) return saveLink(text);
  setStatus(types.length ? 'Nothing to save: the clipboard had no image or link.' : 'The clipboard looks empty.');
}

async function savePasted(blobs, imageURL) {
  setStatus('Saving…');
  const res = await saveImages(blobs, { via: 'paste', source: 'web', sourceURL: ui.source || null, imageURL, gallery: ui.gallery || null, tags: ui.capTags });
  logPaste({ via: 'save', msg: `saved ${res.saved}, dup ${res.dup}, failed ${res.failed}${res.errors[0] ? ' (' + res.errors[0] + ')' : ''}` });
  reportSave(res);
}

// A link: try to download it as an image; otherwise keep it as a saved link.
async function saveLink(url) {
  setStatus('Saving link…');
  const r = await saveLinkOrImage(url, { gallery: ui.gallery || null, sourceURL: ui.source || null, tags: ui.capTags });
  logPaste({ via: 'link', msg: r.detail });
  if (r.res) return reportSave(r.res);
  setStatus(r.message);
  toast(r.message, { kind: r.dup ? '' : 'ok', ms: 3200 });
  renderMain({ keepScroll: true });
}

document.addEventListener('paste', e => {
  if (!S.archive || ui.tab !== 'capture') return;
  if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement || e.target.closest?.('.paste-zone')) return;
  onPasteEvent(e, 'keyboard');
});

function reportSave(res, fromPhotos = false) {
  ui.recent.unshift(...res.ids);
  const gname = ui.gallery ? S.archive.galleries.get(ui.gallery)?.name : 'Unsorted';
  const parts = [];
  if (res.saved) parts.push(`Saved ${res.saved > 1 ? res.saved + ' images ' : ''}to ${gname}`);
  if (res.dup) parts.push(`${res.dup} already saved${ui.gallery ? ' (added to ' + gname + ')' : ''}`);
  if (res.full) parts.push(`Archive full: ${res.full} not saved`);
  if (res.failed) parts.push(`${res.failed} couldn\u2019t be read`);
  const msg = parts.join(' \u00b7 ') || 'Nothing saved';
  toast(msg, { kind: res.full || res.failed ? 'err' : 'ok', ms: res.full ? 5000 : 2200 });
  ui.capStatus = fromPhotos && res.saved ? msg + '. Delete them from Photos yourself if you like; a web app can\u2019t.' : msg;
  renderMain({ keepScroll: true });
  if (navigator.vibrate) navigator.vibrate(15);
}

// ---------------------------------------------------------------- settings
function settingsView() {
  const A = S.archive;
  const usage = A.usage();
  const pct = Math.min(100, usage / LIMIT * 100);
  const count = A.sortedMedia().length;
  const body = [];

  const storage = h('div', { class: 'panel' },
    h('div', { class: 'row-between' }, h('b', null, 'Storage'), h('span', { class: 'muted' }, `${fmtBytes(usage)} of 9 GB`)),
    h('div', { class: 'bar' + (pct > 90 ? ' warn' : '') }, h('div', { class: 'bar-fill', style: { width: pct + '%' } })),
    h('div', { class: 'muted small' }, `${count} image${count === 1 ? '' : 's'} · ${A.galleryList().length} galleries`),
    h('div', { class: 'kv' }, h('span', { class: 'k' }, 'Stored on'), h('span', { class: 'v' }, Store.remote ? `Backblaze B2 (${S.b2.bucket})` : 'This iPhone only')),
  );
  const pendingEl = h('span', { class: 'v' }, '…');
  Store.pendingCount().then(n => { pendingEl.textContent = Store.remote ? (n ? `${n} waiting to upload` : 'All uploaded') : `${n} files (upload once B2 is connected)`; });
  storage.append(h('div', { class: 'kv' }, h('span', { class: 'k' }, 'Sync'), pendingEl));
  if (Store.lastError && Store.remote) storage.append(h('p', { class: 'err small' }, Store.lastError.message));
  if (Store.remote) {
    const dl = h('span', { class: 'v' }, '…');
    monthDownloads().then(n => {
      dl.textContent = `${fmtBytes(n)} (free up to about ${fmtBytes(usage * 3)})`;
      if (usage && n > usage * 2) dl.classList.add('warn');
    });
    storage.append(h('div', { class: 'kv' }, h('span', { class: 'k' }, 'Downloads this month'), dl));
    storage.append(h('div', { class: 'kv' }, h('span', { class: 'k' }, 'Last sync'), h('span', { class: 'v' }, ui.lastSync ? fmtDate(ui.lastSync) : 'Not yet')));
    storage.append(h('button', { class: 'btn block', disabled: ui.syncing, onclick: () => syncNow(true) }, icon('sync', 18), ui.syncing ? ' Syncing…' : ' Sync now'));
  }
  body.push(storage);

  body.push(h('div', { class: 'panel' },
    h('b', null, 'Backblaze B2'),
    Store.remote
      ? [h('p', { class: 'muted small' }, `${S.b2.endpoint} · key ${S.b2.keyId.slice(0, 6)}…`),
         h('button', { class: 'btn block', onclick: () => connectB2(S.b2) }, 'Edit connection'),
         h('button', { class: 'btn block ghost', onclick: async () => {
           if (await confirmBox({ title: 'Disconnect B2?', body: 'Nothing is deleted. This phone stops syncing until you connect again.', ok: 'Disconnect' })) { await saveB2(null); renderMain(); }
         } }, 'Disconnect')]
      : [h('p', { class: 'muted small' }, 'Connect your bucket to back up everything and use it from anywhere. Until then, images live only on this phone.'),
         h('button', { class: 'btn primary block', onclick: () => connectB2() }, icon('cloud', 18), ' Connect Backblaze B2')],
  ));

  const lockSel = h('select', { class: 'field', onchange: e => idb.put('kv', 'lockAfter', +e.target.value) },
    ...[[0, 'Immediately'], [60000, 'After 1 minute'], [300000, 'After 5 minutes'], [900000, 'After 15 minutes'], [-1, 'Only when reopened']]
      .map(([v, t]) => h('option', { value: v }, t)));
  idb.get('kv', 'lockAfter').then(v => { lockSel.value = String(v ?? 300000); });
  body.push(h('div', { class: 'panel' },
    h('b', null, 'Security'),
    h('div', { class: 'kv' }, h('span', { class: 'k' }, 'Passcode'), h('span', { class: 'v' }, S.hasPass ? 'On' : 'Off')),
    S.hasPass ? [h('div', { class: 'label' }, 'Lock when in background'), lockSel] : null,
    h('button', { class: 'btn block', onclick: setPasscode }, S.hasPass ? 'Change or remove passcode' : 'Set a passcode'),
    h('button', { class: 'btn block', onclick: () => showCode('Backup code', backupCode(), 'Your archive key. Keep it in your password manager.') }, 'Show backup code'),
    h('button', { class: 'btn block', onclick: () => showCode('Pairing code', pairingCode(), 'Backup code plus your B2 settings, to set up a reinstall in one step. It contains your B2 key: store it like a password and never share it.') }, 'Show pairing code'),
  ));

  const cacheSel = h('select', { class: 'field', onchange: async e => { cachePolicy.limit = +e.target.value; await idb.put('kv', 'cacheLimit', +e.target.value); } },
    ...[[1, '1 GB'], [2, '2 GB'], [5, '5 GB'], [10, '10 GB']].map(([g, t]) => h('option', { value: g * 1024 ** 3 }, t)));
  cacheSel.value = String(cachePolicy.limit);
  const localEl = h('span', { class: 'v' }, '…');
  Store.localBytes().then(n => { localEl.textContent = fmtBytes(n); });
  body.push(h('div', { class: 'panel' },
    h('b', null, 'On this phone'),
    h('div', { class: 'kv' }, h('span', { class: 'k' }, 'Space used'), localEl),
    Store.remote ? [h('div', { class: 'label' }, 'Full-size image cache limit'), cacheSel,
      h('p', { class: 'muted small' }, 'Thumbnails and favorites always stay on the phone.')] : null,
    h('button', { class: 'btn block danger ghost', onclick: async () => {
      const ok = await confirmBox({ title: 'Erase this phone’s copy?', body: Store.remote
        ? 'Removes everything from this phone. Your B2 copy stays. Files not yet uploaded are lost. You need your backup or pairing code to get back in.'
        : 'Your images are stored only on this phone. Erasing deletes them permanently.', ok: 'Erase', danger: true });
      if (!ok) return;
      if (!Store.remote && !(await confirmBox({ title: 'Really delete everything?', ok: 'Delete everything', danger: true }))) return;
      await eraseDevice();
      renderSetup();
    } }, 'Erase this phone’s copy'),
  ));
  body.push(h('p', { class: 'muted tiny center' }, `Version ${VERSION} · encrypted on this iPhone (AES-256-GCM)`));
  return [topBar('Settings'), body];
}

function showCode(title, code, note) {
  sheet(() => [
    h('p', { class: 'muted' }, note),
    h('div', { class: 'code' }, code),
    h('button', { class: 'btn primary block', onclick: async () => { await copy(code); toast('Copied'); } }, 'Copy'),
  ], { title });
}

async function setPasscode() {
  const a = h('input', { class: 'field pin', type: 'password', inputmode: 'numeric', autocomplete: 'off', placeholder: 'New passcode (6+ digits)' });
  const b = h('input', { class: 'field pin', type: 'password', inputmode: 'numeric', autocomplete: 'off', placeholder: 'Repeat' });
  const err = h('p', { class: 'err' });
  await sheet(close => [a, b, err,
    h('button', { class: 'btn primary block', onclick: async () => {
      if (!/^\d{6,}$/.test(a.value)) return (err.textContent = 'Use at least 6 digits.');
      if (a.value !== b.value) return (err.textContent = 'The passcodes don’t match.');
      await changePasscode(a.value); toast('Passcode set'); close(); renderMain();
    } }, 'Save passcode'),
    S.hasPass ? h('button', { class: 'btn block ghost', onclick: async () => {
      await changePasscode(null); toast('Passcode removed'); close(); renderMain();
    } }, 'Remove passcode') : null,
  ], { title: S.hasPass ? 'Change passcode' : 'Set a passcode' });
}

function connectB2(existing) {
  const f = (name, label, ph, val, type = 'text') => {
    const input = h('input', { class: 'field', name, placeholder: ph, value: val || '', type, autocapitalize: 'off', autocomplete: 'off', spellcheck: false });
    return [h('div', { class: 'label' }, label), input];
  };
  sheet(close => {
    const err = h('p', { class: 'err' });
    const bar = progressBar(); bar.el.hidden = true;
    const btn = h('button', { class: 'btn primary block', onclick: async () => {
      const get = n => panel.querySelector(`[name=${n}]`).value.trim();
      const cfg = { endpoint: get('endpoint'), bucket: get('bucket'), keyId: get('keyId'), secret: get('secret') || existing?.secret || '' };
      if (!cfg.endpoint || !cfg.bucket || !cfg.keyId || !cfg.secret) return (err.textContent = 'Fill in all four fields.');
      err.textContent = ''; btn.disabled = true; btn.textContent = 'Testing…';
      try {
        const state = await testB2(cfg);
        if (state === 'foreign') throw new Error('This bucket holds an archive made with a different key. Use an empty bucket, or restore with that archive’s code.');
        await saveB2(cfg);
        btn.textContent = 'Syncing…';
        if (state === 'ours') await S.archive.reconcileRemote();
        bar.el.hidden = false;
        await Store.flush((d, t) => bar.set(d, t, `Uploading ${d} of ${t}`));
        await S.archive.pull();
        ui.lastSync = Date.now();
        toast('Connected to B2', { kind: 'ok' });
        close(); renderMain();
      } catch (e) {
        err.textContent = e.message;
        btn.disabled = false; btn.textContent = 'Test and connect';
      }
    } }, 'Test and connect');
    const panel = h('div', null,
      h('p', { class: 'muted small' }, 'From your bucket’s page and the application key you created. The key is stored encrypted on this phone.'),
      f('endpoint', 'S3 endpoint', 's3.us-west-004.backblazeb2.com', existing?.endpoint),
      f('bucket', 'Bucket name', 'my-bucket', existing?.bucket),
      f('keyId', 'keyID', '004abc…', existing?.keyId),
      f('secret', 'applicationKey', existing ? '(unchanged)' : 'K004…', '', 'password'),
      err, bar.el, btn);
    return panel;
  }, { title: 'Connect Backblaze B2', tall: true });
}

async function copy(text) {
  try { await navigator.clipboard.writeText(text); }
  catch {
    const ta = h('textarea', { style: { position: 'fixed', opacity: 0 } }, text);
    document.body.append(ta); ta.select(); document.execCommand('copy'); ta.remove();
  }
}

boot().catch(e => {
  console.error(e);
  app.replaceChildren(h('div', { class: 'setup' }, h('h1', null, 'Something went wrong'), h('p', { class: 'err' }, e.message)));
});
