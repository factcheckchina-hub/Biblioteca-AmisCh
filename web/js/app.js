/* Biblioteca de la Amistad — aplicación web sin dependencias. */
(() => {
  'use strict';

  /* ───────── Utilidades ───────── */
  const $ = (sel, root = document) => root.querySelector(sel);
  const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const fold = (s) => (s || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
  const enc = encodeURIComponent;
  const collator = new Intl.Collator('es', { sensitivity: 'base', numeric: true });
  const plural = (k, one, many) => `${k.toLocaleString('es')} ${k === 1 ? one : many}`;

  const store = {
    get(key, fallback) {
      try {
        const v = localStorage.getItem('aach:' + key);
        return v == null ? fallback : JSON.parse(v);
      } catch { return fallback; }
    },
    set(key, value) {
      try { localStorage.setItem('aach:' + key, JSON.stringify(value)); } catch { /* sin almacenamiento */ }
    },
  };

  const svg = (d, extra = '') =>
    `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" ${extra}>${d}</svg>`;
  const ICON = {
    sun: svg('<circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/>'),
    moon: svg('<path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z"/>'),
    book: svg('<path d="M2 4h6a4 4 0 0 1 4 4v13a3 3 0 0 0-3-3H2z"/><path d="M22 4h-6a4 4 0 0 0-4 4v13a3 3 0 0 1 3-3h7z"/>'),
    down: svg('<path d="M12 3v12m0 0-4-4m4 4 4-4M4 20h16"/>'),
    heart: svg('<path d="M20.84 4.61a5.5 5.5 0 0 0-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 0 0-7.78 7.78l1.06 1.06L12 21.23l7.78-7.78 1.06-1.06a5.5 5.5 0 0 0 0-7.78z"/>'),
    share: svg('<path d="M12 15V3m0 0L8 7m4-4 4 4M5 12v7a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2v-7"/>'),
    x: svg('<path d="M6 6l12 12M18 6 6 18"/>'),
    prev: svg('<path d="m15 18-6-6 6-6"/>'),
    next: svg('<path d="m9 18 6-6-6-6"/>'),
  };

  /* Colores de las portadas sin imagen (uno por colección). Todos con buen contraste con el blanco. */
  const PALETTE = ['#a3141f', '#2b6072', '#22343e', '#8a6414', '#5b2a3a', '#2f5d3a'];

  const FORMAT_LABEL = { gdoc: 'Documento de Google' };
  const formatLabel = (f) => FORMAT_LABEL[f] || (f || '').toUpperCase();

  /* ───────── Estado ───────── */
  const S = {
    data: null,
    books: [],
    byId: new Map(),
    collections: [],
    authors: [],
    favs: new Set(store.get('favs', [])),
    recent: store.get('recent', []),
    q: '',
    route: { seg: '', arg: '' },
    ui: { sort: 'title', fmt: new Set(), coll: '' },
  };

  const mainWrap = () => $('#main > .wrap');
  const setView = (html) => { mainWrap().innerHTML = html; };

  /* ───────── Datos ───────── */
  async function load() {
    try {
      const res = await fetch('data/catalog.json', { cache: 'no-cache' });
      if (!res.ok) throw new Error(res.status);
      S.data = await res.json();
    } catch {
      setView(`<div class="empty"><h1>No se pudo cargar la biblioteca</h1>
        <p>Comprueba tu conexión a internet y vuelve a intentarlo.</p>
        <button class="btn" type="button" data-retry>Reintentar</button></div>`);
      return;
    }
    index();
    route();
  }

  function index() {
    const { books, collections, title, subtitle } = S.data;
    S.books = books;
    S.byId = new Map(books.map((b) => [b.id, b]));
    for (const b of books) b._s = fold([b.title, b.author, b.collection, b.section].join(' '));

    const known = new Set(collections);
    const names = [...collections, ...[...new Set(books.map((b) => b.collection))].filter((c) => !known.has(c))];
    S.collections = names.map((name) => ({ name, books: books.filter((b) => b.collection === name) })).filter((c) => c.books.length);

    const byAuthor = new Map();
    for (const b of books) {
      if (!b.author) continue;
      if (!byAuthor.has(b.author)) byAuthor.set(b.author, []);
      byAuthor.get(b.author).push(b);
    }
    S.authors = [...byAuthor.entries()]
      .map(([name, list]) => ({ name, books: list }))
      .sort((a, b) => collator.compare(a.name, b.name));

    if (title) $('#brand-name').textContent = title;
    if (subtitle) $('#brand-sub').textContent = subtitle;
  }

  const sorters = {
    title: (a, b) => collator.compare(a.title, b.title),
    author: (a, b) => {
      if (!a.author !== !b.author) return a.author ? -1 : 1;
      return collator.compare(a.author || '', b.author || '') || collator.compare(a.title, b.title);
    },
    recent: (a, b) => (b.added || '').localeCompare(a.added || '') || collator.compare(a.title, b.title),
  };

  /* ───────── Piezas ───────── */
  function phColor(b) {
    let h = 0;
    for (const ch of b.collection || '') h = (h * 31 + ch.charCodeAt(0)) >>> 0;
    return PALETTE[h % PALETTE.length];
  }

  function placeholder(b) {
    return `<span class="ph"><span class="ph-title">${esc(b.title)}</span>${b.author ? `<span class="ph-author">${esc(b.author)}</span>` : ''}</span>`;
  }

  function coverHTML(b, cls = '') {
    const inner = b.cover
      ? `<img src="${esc(b.cover)}" alt="" width="400" height="600" loading="lazy" decoding="async" data-fallback>`
      : placeholder(b);
    return `<span class="cover ${cls}" data-bid="${esc(b.id)}" style="--ph:${phColor(b)}">${inner}</span>`;
  }

  const card = (b) => `<li><button type="button" class="book" data-id="${esc(b.id)}">${coverHTML(b)}<span class="b-title">${esc(b.title)}</span>${b.author ? `<span class="b-author">${esc(b.author)}</span>` : ''}</button></li>`;
  const gridOf = (list) => `<ul class="grid">${list.map(card).join('')}</ul>`;

  function shelf({ title, books, href, count, ribbon }) {
    const head = ribbon
      ? `<h2 class="shelf-title" style="margin:0"><a class="ribbon" href="${href}">${esc(title)}</a></h2>`
      : `<h2 class="shelf-title">${esc(title)}</h2>`;
    const more = href && count > books.length ? `<a class="more" href="${href}">Ver los ${count.toLocaleString('es')}</a>` : '';
    const tools = `<div class="scroll-btns"><button type="button" data-scroll="-1" aria-label="Anteriores">${ICON.prev}</button><button type="button" data-scroll="1" aria-label="Siguientes">${ICON.next}</button></div>`;
    return `<section class="shelf-block"><div class="shelf-head">${head}<div class="shelf-tools">${more}${tools}</div></div><ul class="shelf">${books.map(card).join('')}</ul></section>`;
  }

  const footerNote = () => {
    const g = S.data && S.data.generated ? new Date(S.data.generated) : null;
    const when = g && !isNaN(g) ? g.toLocaleDateString('es-ES', { year: 'numeric', month: 'long', day: 'numeric' }) : '';
    return `<p class="note">${when ? `Catálogo actualizado el ${esc(when)}. ` : ''}Los libros se abren desde Google Drive.</p>`;
  };

  const emptyLibrary = () => setView(`<div class="empty"><h1>La biblioteca todavía está vacía</h1>
    <p>Cuando termine la primera actualización del catálogo, aquí aparecerán los libros.</p></div>`);

  const notFound = (what) => setView(`<div class="empty"><h1>${esc(what)} no encontrado</h1>
    <p>Puede que se haya renombrado o movido de carpeta.</p><a class="btn" href="#/">Volver a las colecciones</a></div>`);

  /* ───────── Vistas ───────── */
  function renderHome() {
    const parts = ['<h1 class="sr-only">Colecciones</h1>'];
    const recent = S.recent.map((id) => S.byId.get(id)).filter(Boolean).slice(0, 10);
    if (recent.length) parts.push(shelf({ title: 'Seguir leyendo', books: recent }));

    if (S.books.length >= 8) {
      const newest = [...S.books].sort(sorters.recent).slice(0, 12);
      parts.push(shelf({ title: 'Añadidos recientemente', books: newest, href: '#/todos/recientes', count: S.books.length }));
    }
    for (const c of S.collections) {
      parts.push(shelf({ title: c.name, books: c.books.slice(0, 14), href: `#/coleccion/${enc(c.name)}`, count: c.books.length, ribbon: true }));
    }
    parts.push(footerNote());
    setView(parts.join(''));
  }

  function renderCollection(name) {
    const c = S.collections.find((x) => x.name === name);
    if (!c) return notFound('Colección');

    const groups = new Map();
    for (const b of c.books) {
      const key = b.author || b.section || '';
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(b);
    }
    const keys = [...groups.keys()].sort((a, b) => (!a !== !b ? (a ? -1 : 1) : collator.compare(a, b)));
    const nAuthors = new Set(c.books.map((b) => b.author).filter(Boolean)).size;
    const sub = plural(c.books.length, 'libro', 'libros') + (nAuthors ? ` de ${plural(nAuthors, 'autor', 'autores')}` : '');

    let body;
    if (keys.length === 1 && keys[0] === '') {
      body = gridOf([...c.books].sort(sorters.title));
    } else {
      body = keys.map((k) => {
        const list = groups.get(k).sort(sorters.title);
        const isAuthor = list.some((b) => b.author === k);
        const head = k === '' ? 'Otros' : isAuthor ? `<a href="#/autor/${enc(k)}">${esc(k)}</a>` : esc(k);
        return `<section class="group"><h2>${head}<small>${plural(list.length, 'libro', 'libros')}</small></h2>${gridOf(list)}</section>`;
      }).join('');
    }
    setView(`<a class="crumb" href="#/">Colecciones</a><h1 class="view-title">${esc(c.name)}</h1><p class="view-sub">${sub}</p>${body}`);
  }

  function renderAuthors() {
    if (!S.authors.length && !S.books.length) return emptyLibrary();
    const groups = new Map();
    for (const a of S.authors) {
      const first = fold(a.name).charAt(0).toUpperCase();
      const letter = /[A-Z]/.test(first) ? first : '#';
      if (!groups.has(letter)) groups.set(letter, []);
      groups.get(letter).push(a);
    }
    const letters = [...groups.keys()].sort();
    const nav = letters.length > 4
      ? `<nav class="letters" aria-label="Ir a la letra">${letters.map((l) => `<button type="button" data-jump="${l}">${l}</button>`).join('')}</nav>`
      : '';
    const list = letters.map((l) => `<section class="author-group" id="letra-${l === '#' ? 'otros' : l}" data-letter="${l}"><h2>${l}</h2><ul class="author-list">${groups.get(l).map((a) => {
      const stack = a.books.filter((b) => b.cover).slice(0, 3);
      const covers = (stack.length ? stack : a.books.slice(0, 1)).map((b) => coverHTML(b)).join('');
      return `<li><a class="author-row" href="#/autor/${enc(a.name)}"><span class="text"><span class="name">${esc(a.name)}</span><span class="count">${plural(a.books.length, 'libro', 'libros')}</span></span><span class="stack" aria-hidden="true">${covers}</span></a></li>`;
    }).join('')}</ul></section>`).join('');

    const rest = S.books.filter((b) => !b.author).length;
    const note = rest ? `<p class="view-sub" style="margin-top:2rem">${plural(rest, 'libro no tiene', 'libros no tienen')} un autor indicado; los encuentras en <a href="#/todos">Todos</a>.</p>` : '';
    setView(`<h1 class="view-title">Autores</h1><p class="view-sub">${plural(S.authors.length, 'autor', 'autores')}</p>${nav}${list}${note}`);
  }

  function renderAuthor(name) {
    const a = S.authors.find((x) => x.name === name);
    if (!a) return notFound('Autor');
    const colls = [...new Set(a.books.map((b) => b.collection))];
    const where = colls.length === 1 ? ` en ${colls[0]}` : ` en ${plural(colls.length, 'colección', 'colecciones')}`;
    const list = [...a.books].sort(sorters.title);
    setView(`<a class="crumb" href="#/autores">Autores</a><h1 class="view-title">${esc(a.name)}</h1><p class="view-sub">${plural(a.books.length, 'libro', 'libros')}${esc(where)}</p>${gridOf(list)}`);
  }

  function controlsHTML(withColl) {
    const formats = [...new Set(S.books.map((b) => b.format))].sort();
    const collSel = withColl && S.collections.length > 1
      ? `<label>Colección <select data-ctl="coll"><option value="">Todas</option>${S.collections.map((c) => `<option value="${esc(c.name)}"${S.ui.coll === c.name ? ' selected' : ''}>${esc(c.name)}</option>`).join('')}</select></label>`
      : '';
    const sortSel = `<label>Ordenar por <select data-ctl="sort">
      <option value="title"${S.ui.sort === 'title' ? ' selected' : ''}>Título</option>
      <option value="author"${S.ui.sort === 'author' ? ' selected' : ''}>Autor</option>
      <option value="recent"${S.ui.sort === 'recent' ? ' selected' : ''}>Más recientes</option></select></label>`;
    const chips = formats.length > 1
      ? formats.map((f) => `<button class="chip" type="button" data-fmt="${esc(f)}" aria-pressed="${S.ui.fmt.has(f)}">${esc(formatLabel(f))}</button>`).join('')
      : '';
    return `<div class="controls">${collSel}${sortSel}</div>${chips ? `<div class="chips" role="group" aria-label="Formato">${chips}</div>` : ''}`;
  }

  function renderAll(arg) {
    if (!S.books.length) return emptyLibrary();
    if (arg === 'recientes') S.ui.sort = 'recent';
    const paint = () => {
      let list = S.books.filter((b) => (!S.ui.coll || b.collection === S.ui.coll) && (!S.ui.fmt.size || S.ui.fmt.has(b.format)));
      list = [...list].sort(sorters[S.ui.sort]);
      setView(`<h1 class="view-title">Todos los libros</h1><p class="view-sub" aria-live="polite">${plural(list.length, 'libro', 'libros')}</p>${controlsHTML(true)}${list.length ? gridOf(list) : '<p class="view-sub">Ningún libro coincide con estos filtros.</p>'}`);
    };
    S.repaint = paint;
    paint();
  }

  function renderFavs() {
    const list = S.books.filter((b) => S.favs.has(b.id)).sort(sorters.title);
    if (!list.length) {
      return setView(`<div class="empty"><h1>Aún no tienes favoritos</h1>
        <p>Abre un libro y toca «Favorito» para guardarlo aquí.</p><a class="btn" href="#/todos">Ver todos los libros</a></div>`);
    }
    setView(`<h1 class="view-title">Favoritos</h1><p class="view-sub">${plural(list.length, 'libro', 'libros')}</p>${gridOf(list)}`);
  }

  function renderSearch() {
    const tokens = fold(S.q).split(/\s+/).filter(Boolean);
    const score = (b) => {
      let s = 0;
      const t = fold(b.title), a = fold(b.author);
      for (const k of tokens) {
        if (t.startsWith(k)) s += 4; else if (t.includes(k)) s += 3;
        if (a.includes(k)) s += 2;
      }
      return s;
    };
    const hits = S.books.filter((b) => tokens.every((k) => b._s.includes(k)))
      .sort((a, b) => score(b) - score(a) || collator.compare(a.title, b.title));
    const authors = S.authors.filter((a) => tokens.every((k) => fold(a.name).includes(k))).slice(0, 6);
    const chips = authors.length
      ? `<div class="chips" aria-label="Autores encontrados">${authors.map((a) => `<a class="chip-link" href="#/autor/${enc(a.name)}">${esc(a.name)}</a>`).join('')}</div>`
      : '';
    setView(`<h1 class="view-title">Resultados</h1><p class="view-sub" aria-live="polite">${hits.length ? plural(hits.length, 'libro', 'libros') : 'Sin resultados'} para «${esc(S.q.trim())}»</p>${chips}${hits.length ? gridOf(hits) : '<p class="view-sub">Prueba con otro título, autor o colección.</p>'}`);
  }

  /* ───────── Rutas ───────── */
  const TAB_OF = { '': '', coleccion: '', autores: 'autores', autor: 'autores', todos: 'todos', favoritos: 'favoritos' };

  function parseHash() {
    const h = location.hash.replace(/^#\/?/, '');
    const [seg, ...rest] = h.split('/');
    let arg = rest.join('/');
    try { arg = decodeURIComponent(arg); } catch { /* deja el texto tal cual */ }
    return { seg: seg || '', arg };
  }

  function route() {
    if (!S.data) return;
    const r = parseHash();
    S.route = r;
    const searching = S.q.trim().length > 0;
    $$('.tabs a').forEach((a) => {
      if (!searching && a.dataset.tab === (TAB_OF[r.seg] ?? '')) a.setAttribute('aria-current', 'page');
      else a.removeAttribute('aria-current');
    });
    const site = S.data.title || 'Biblioteca de la Amistad';
    let label = '';

    if (searching) { renderSearch(); label = 'Búsqueda'; }
    else if (!S.books.length && r.seg !== 'favoritos') emptyLibrary();
    else {
      switch (r.seg) {
        case 'coleccion': renderCollection(r.arg); label = r.arg; break;
        case 'autores': renderAuthors(); label = 'Autores'; break;
        case 'autor': renderAuthor(r.arg); label = r.arg; break;
        case 'todos': renderAll(r.arg); label = 'Todos los libros'; break;
        case 'favoritos': renderFavs(); label = 'Favoritos'; break;
        default: renderHome();
      }
    }
    document.title = label ? `${label} — ${site}` : site;
  }

  /* ───────── Ficha del libro ───────── */
  const sheet = () => $('#sheet');

  function fmtSize(bytes) {
    if (!bytes) return '';
    const mb = bytes / 1048576;
    return mb >= 1 ? `${mb.toFixed(mb >= 10 ? 0 : 1).replace('.', ',')} MB` : `${Math.max(1, Math.round(bytes / 1024))} KB`;
  }

  function openSheet(id, opener) {
    const b = S.byId.get(id);
    if (!b) return;
    S.opener = opener;
    const fav = S.favs.has(id);
    const added = b.added ? new Date(b.added) : null;
    const rows = [
      ['Colección', `<a href="#/coleccion/${enc(b.collection)}" data-close>${esc(b.collection)}</a>`],
      b.section ? ['Sección', esc(b.section)] : null,
      ['Formato', esc(formatLabel(b.format))],
      b.pages ? ['Páginas', b.pages.toLocaleString('es')] : null,
      b.size ? ['Tamaño', fmtSize(b.size)] : null,
      added && !isNaN(added) ? ['Añadido', added.toLocaleDateString('es-ES', { year: 'numeric', month: 'long', day: 'numeric' })] : null,
    ].filter(Boolean);

    sheet().innerHTML = `<div class="sheet-body">
      <button class="icon-btn sheet-close" type="button" data-close aria-label="Cerrar">${ICON.x}</button>
      ${coverHTML(b, 'big')}
      <div>
        <h2 id="sheet-title">${esc(b.title)}</h2>
        ${b.author ? `<p class="sheet-author"><a href="#/autor/${enc(b.author)}" data-close>${esc(b.author)}</a></p>` : ''}
        <dl class="meta">${rows.map(([k, v]) => `<dt>${k}</dt><dd>${v}</dd>`).join('')}</dl>
        <div class="actions">
          ${b.url ? `<a class="btn primary" href="${esc(b.url)}" target="_blank" rel="noopener" data-read="${esc(id)}">${ICON.book}Leer</a>` : ''}
          ${b.download ? `<a class="btn" href="${esc(b.download)}" target="_blank" rel="noopener">${ICON.down}Descargar</a>` : ''}
          <button class="btn" type="button" data-fav="${esc(id)}" aria-pressed="${fav}">${ICON.heart}Favorito</button>
          ${b.url ? `<button class="btn icon" type="button" data-share="${esc(id)}" aria-label="Compartir" title="Compartir">${ICON.share}</button>` : ''}
        </div>
      </div></div>`;
    sheet().setAttribute('aria-labelledby', 'sheet-title');
    if (!sheet().open) sheet().showModal();
  }

  function toast(msg) {
    const t = $('#toast');
    t.textContent = msg;
    t.classList.add('show');
    clearTimeout(toast.timer);
    toast.timer = setTimeout(() => t.classList.remove('show'), 2200);
  }

  function toggleFav(id, btn) {
    if (S.favs.has(id)) S.favs.delete(id); else S.favs.add(id);
    store.set('favs', [...S.favs]);
    btn.setAttribute('aria-pressed', S.favs.has(id));
    toast(S.favs.has(id) ? 'Añadido a favoritos' : 'Quitado de favoritos');
  }

  async function share(id) {
    const b = S.byId.get(id);
    if (!b || !b.url) return;
    if (navigator.share) {
      try { await navigator.share({ title: b.title, text: b.author ? `${b.title}, de ${b.author}` : b.title, url: b.url }); } catch { /* cancelado */ }
    } else if (navigator.clipboard) {
      try { await navigator.clipboard.writeText(b.url); toast('Enlace copiado'); } catch { toast('No se pudo copiar el enlace'); }
    }
  }

  /* ───────── Tema ───────── */
  const darkQuery = window.matchMedia('(prefers-color-scheme: dark)');
  const isDark = () => {
    const t = document.documentElement.dataset.theme;
    return t ? t === 'dark' : darkQuery.matches;
  };
  function paintThemeButton() {
    const dark = isDark();
    $('#theme').innerHTML = dark ? ICON.sun : ICON.moon;
    $('#theme').setAttribute('aria-label', dark ? 'Cambiar a tema claro' : 'Cambiar a tema oscuro');
    const meta = $('meta[name="theme-color"]');
    if (meta) meta.content = dark ? '#0f171b' : '#a3141f';
  }
  darkQuery.addEventListener?.('change', paintThemeButton);

  /* ───────── Eventos ───────── */
  document.addEventListener('click', (e) => {
    const t = e.target;
    const book = t.closest('.book');
    if (book) return openSheet(book.dataset.id, book);

    const read = t.closest('[data-read]');
    if (read) {
      const id = read.dataset.read;
      S.recent = [id, ...S.recent.filter((x) => x !== id)].slice(0, 12);
      store.set('recent', S.recent);
      return;
    }
    const fav = t.closest('[data-fav]');
    if (fav) return toggleFav(fav.dataset.fav, fav);
    const sh = t.closest('[data-share]');
    if (sh) return share(sh.dataset.share);

    if (t.closest('[data-close]')) { sheet().close(); return; }
    if (t === sheet()) { sheet().close(); return; } // clic en el fondo

    const scroller = t.closest('[data-scroll]');
    if (scroller) {
      const list = scroller.closest('.shelf-block').querySelector('.shelf');
      const smooth = !matchMedia('(prefers-reduced-motion: reduce)').matches;
      list.scrollBy({ left: Number(scroller.dataset.scroll) * list.clientWidth * 0.85, behavior: smooth ? 'smooth' : 'auto' });
      return;
    }
    const jump = t.closest('[data-jump]');
    if (jump) {
      const el = $(`.author-group[data-letter="${jump.dataset.jump}"]`);
      if (el) el.scrollIntoView({ behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth', block: 'start' });
      return;
    }
    const fmt = t.closest('[data-fmt]');
    if (fmt) {
      const f = fmt.dataset.fmt;
      if (S.ui.fmt.has(f)) S.ui.fmt.delete(f); else S.ui.fmt.add(f);
      return S.repaint && S.repaint();
    }
    if (t.closest('[data-retry]')) return load();
    if (t.closest('.skip')) { e.preventDefault(); $('#main').focus(); }
  });

  document.addEventListener('change', (e) => {
    const ctl = e.target.closest('[data-ctl]');
    if (!ctl) return;
    S.ui[ctl.dataset.ctl] = ctl.value;
    if (S.repaint) S.repaint();
    const again = $(`[data-ctl="${ctl.dataset.ctl}"]`);
    if (again) again.focus();
  });

  /* Si una portada no carga, se dibuja la de sustitución. */
  document.addEventListener('error', (e) => {
    const img = e.target;
    if (img && img.tagName === 'IMG' && img.hasAttribute('data-fallback')) {
      const cover = img.closest('.cover');
      const b = cover && S.byId.get(cover.dataset.bid);
      if (b) cover.innerHTML = placeholder(b);
    }
  }, true);

  sheet().addEventListener('close', () => {
    if (S.route.seg === 'favoritos' && !S.q.trim()) route();
    if (S.opener && document.contains(S.opener)) S.opener.focus({ preventScroll: true });
  });

  window.addEventListener('hashchange', () => {
    if (S.q) { S.q = ''; $('#q').value = ''; $('#clear').hidden = true; }
    route();
    window.scrollTo(0, 0);
    $('#main').focus({ preventScroll: true });
  });

  const qInput = $('#q');
  let timer;
  qInput.addEventListener('input', () => {
    $('#clear').hidden = !qInput.value;
    clearTimeout(timer);
    timer = setTimeout(() => { S.q = qInput.value; route(); }, 120);
  });
  qInput.addEventListener('keydown', (e) => { if (e.key === 'Escape') clearSearch(); });
  $('#clear').addEventListener('click', () => { clearSearch(); qInput.focus(); });
  function clearSearch() {
    qInput.value = '';
    $('#clear').hidden = true;
    S.q = '';
    route();
  }

  $('#theme').addEventListener('click', () => {
    const next = isDark() ? 'light' : 'dark';
    document.documentElement.dataset.theme = next;
    store.set('theme', next);
    paintThemeButton();
  });

  /* ───────── Arranque ───────── */
  paintThemeButton();
  load();

  if ('serviceWorker' in navigator && location.protocol.startsWith('http')) {
    window.addEventListener('load', () => navigator.serviceWorker.register('sw.js').catch(() => {}));
  }
})();
