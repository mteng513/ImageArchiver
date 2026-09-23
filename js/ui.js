// Shared UI pieces: sheets, dialogs, toasts, gallery picker.
import { h, icon } from './util.js';
import { S } from './core.js';

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
