// Shared UI pieces: sheets, dialogs, toasts, gallery picker.
import { h, icon } from './util.js';
import { S } from './core.js';
import { cleanTag, tagKey } from './log.js';

export function toast(msg, { ms = 2200, kind = '' } = {}) {
  let wrap = document.getElementById('toasts');
  if (!wrap) { wrap = h('div', { id: 'toasts' }); document.body.append(wrap); }
  const t = h('div', { class: 'toast ' + kind, role: 'status' }, msg);
  wrap.append(t);
  requestAnimationFrame(() => t.classList.add('in'));
  setTimeout(() => { t.classList.remove('in'); setTimeout(() => t.remove(), 300); }, ms);
}

// Bottom sheet. build(close) returns content nodes. Resolves with close(value).
export function sheet(build, { title, onClose, tall = false } = {}) {
  return new Promise(resolve => {
    const back = h('div', { class: 'sheet-back' });
    const panel = h('div', { class: 'sheet' + (tall ? ' tall' : ''), role: 'dialog', 'aria-modal': 'true' });
    let done = false;
    const close = (v) => {
      if (done) return; done = true;
      back.classList.remove('in'); panel.classList.remove('in');
      setTimeout(() => { back.remove(); panel.remove(); }, 250);
      onClose && onClose(v);
      resolve(v);
    };
    back.addEventListener('click', () => close(undefined));
    panel.append(h('div', { class: 'grab' }));
    if (title) panel.append(h('div', { class: 'sheet-title' }, h('span', null, title),
      h('button', { class: 'icon-btn', 'aria-label': 'Close', onclick: () => close(undefined) }, icon('close', 20))));
    const body = h('div', { class: 'sheet-body' });
    body.append(...[].concat(build(close)).filter(Boolean));
    panel.append(body);
    document.body.append(back, panel);
    requestAnimationFrame(() => { back.classList.add('in'); panel.classList.add('in'); });
  });
}

export function askText({ title, value = '', placeholder = '', ok = 'Save' }) {
  return sheet(close => {
    const input = h('input', { class: 'field', value, placeholder, autocapitalize: 'sentences', enterkeyhint: 'done' });
    const submit = () => { const v = input.value.trim(); if (v) close(v); };
    input.addEventListener('keydown', e => { if (e.key === 'Enter') submit(); });
    setTimeout(() => input.focus(), 250);
    return [input, h('button', { class: 'btn primary block', onclick: submit }, ok)];
  }, { title });
}

export function confirmBox({ title, body, ok = 'OK', danger = false }) {
  return sheet(close => [
    body ? h('p', { class: 'muted' }, body) : null,
    h('button', { class: 'btn block ' + (danger ? 'danger' : 'primary'), onclick: () => close(true) }, ok),
    h('button', { class: 'btn block ghost', onclick: () => close(false) }, 'Cancel'),
  ], { title }).then(v => !!v);
}

// Resolves to a gallery id, '' for Unsorted (when allowUnsorted), or undefined if cancelled.
export function pickGallery({ title = 'Choose gallery', allowUnsorted = false, exclude = null } = {}) {
  return sheet(close => {
    const list = h('div', { class: 'pick-list' });
    if (allowUnsorted) list.append(h('button', { class: 'row', onclick: () => close('') }, 'Unsorted'));
    for (const g of S.archive.galleryList()) {
      if (g.id === exclude) continue;
      list.append(h('button', { class: 'row', onclick: () => close(g.id) }, g.name));
    }
    const add = h('button', { class: 'row accent', onclick: async () => {
      const name = await askText({ title: 'New gallery', placeholder: 'Name', ok: 'Create' });
      if (!name) return;
      const id = await createGallery(name);
      close(id);
    } }, icon('plus', 18), ' New gallery');
    return [list, add];
  }, { title, tall: true });
}

export async function createGallery(name) {
  const id = S.archive.newId();
  await S.archive.commit([{ op: 'gallery.create', id, name }]);
  return id;
}

export function progressBar() {
  const fill = h('div', { class: 'bar-fill' });
  const label = h('div', { class: 'bar-label' });
  const el = h('div', { class: 'progress' }, h('div', { class: 'bar' }, fill), label);
  return {
    el,
    set(done, total, text) {
      fill.style.width = total ? Math.round(done / total * 100) + '%' : '0';
      label.textContent = text || `${done} / ${total}`;
    },
  };
}

// Tag chooser. state(key) -> 'on' | 'some' | 'off'; toggle(name, state) applies a tap.
// extra() lists tag names to show even if no image has them yet.
export function tagSheet({ title = 'Tags', state, toggle, extra = () => [], hint }) {
  return sheet(close => {
    const input = h('input', { class: 'field', placeholder: 'Find or create a tag', autocapitalize: 'off', autocomplete: 'off', enterkeyhint: 'done' });
    const list = h('div', { class: 'chips wrap tag-chips' });
    const all = () => {
      const out = S.archive.tagList();
      for (const name of extra()) if (!out.some(t => t.key === tagKey(name))) out.push({ key: tagKey(name), name, count: 0 });
      return out;
    };
    const draw = () => {
      const q = tagKey(input.value);
      const tags = all();
      const shown = q ? tags.filter(t => t.key.includes(q)) : tags;
      const nodes = shown.map(t => {
        const st = state(t.key);
        return h('button', { class: 'chip tag' + (st === 'on' ? ' on' : st === 'some' ? ' some' : ''), onclick: async () => { await toggle(t.name, st); draw(); } },
          '#' + t.name, t.count ? h('span', { class: 'n' }, t.count) : null);
      });
      if (q && !tags.some(t => t.key === q)) nodes.unshift(h('button', { class: 'chip ghost', onclick: create }, `+ Create \u201c${cleanTag(input.value)}\u201d`));
      if (!nodes.length) nodes.push(h('p', { class: 'muted small' }, 'No tags yet. Type one above.'));
      list.replaceChildren(...nodes);
    };
    const create = async () => {
      const name = cleanTag(input.value);
      if (!name) return;
      if (state(tagKey(name)) !== 'on') await toggle(name, 'off');
      input.value = '';
      draw();
    };
    input.addEventListener('input', draw);
    input.addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); create(); } });
    draw();
    return [hint ? h('p', { class: 'muted small' }, hint) : null, input, list,
      h('button', { class: 'btn primary block', onclick: () => close(true) }, 'Done')];
  }, { title, tall: true });
}

// Add/remove tags on a set of images. Tapping a tag some of them have adds it to all.
export function editTags(mids, title) {
  const A = S.archive;
  return tagSheet({
    title: title || (mids.length === 1 ? 'Tags' : `Tags for ${mids.length} images`),
    hint: mids.length > 1 ? 'Highlighted = on all selected images; outlined = on some. Tap to add to all, tap again to remove from all.' : null,
    state: key => {
      let n = 0;
      for (const id of mids) if (A.tags.get(id)?.has(key)) n++;
      return n === 0 ? 'off' : n === mids.length ? 'on' : 'some';
    },
    toggle: (name, st) => A.commit([{ op: st === 'on' ? 'tag.remove' : 'tag.add', tag: name, media: mids }]),
  });
}
