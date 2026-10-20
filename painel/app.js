/* ZON Charge · Consumo de clientes — lógica do painel
   Os números vêm prontos do Supabase (função painel_dados), agrupados por semana
   (segunda a domingo). Este arquivo só monta as telas. */
'use strict';
const $ = id => document.getElementById(id);

/* ============================== formatação ============================== */
const nf0 = new Intl.NumberFormat('pt-BR', {maximumFractionDigits: 0});
const nf1 = new Intl.NumberFormat('pt-BR', {minimumFractionDigits: 1, maximumFractionDigits: 1});
const fmtN = n => nf0.format(n || 0);
const fmtKwh = n => (n == null ? '—' : Math.abs(n) >= 1000 ? nf0.format(n) : nf1.format(n));
const fmtCompacto = n => n >= 1e6 ? nf1.format(n / 1e6) + ' mi' : n >= 1e4 ? nf0.format(n / 1e3) + ' mil' : nf0.format(n);
const fmtPct = p => (p > 0 ? '+' : p < 0 ? '−' : '') + nf0.format(Math.abs(p * 100)) + '%';
const dia = s => new Date(s + 'T12:00:00');
const iso = d => d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
const somaDias = (s, n) => { const d = dia(s); d.setDate(d.getDate() + n); return iso(d); };
const difDias = (a, b) => Math.round((dia(a) - dia(b)) / 864e5);
const dataBR = s => s ? dia(s).toLocaleDateString('pt-BR') : '—';
const dataCurta = s => s ? dia(s).toLocaleDateString('pt-BR', {day: '2-digit', month: '2-digit'}) : '—';
const rotSemana = s => `${dataCurta(s)} a ${dataBR(somaDias(s, 6))}`;
const quando = d => d ? new Date(d).toLocaleString('pt-BR', {dateStyle: 'short', timeStyle: 'short'}) : '—';
const semAcento = s => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
function el(tag, attrs, ...filhos) {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v == null || v === false) continue;
    if (k === 'class') e.className = v; else if (k === 'text') e.textContent = v;
    else if (k.startsWith('on')) e.addEventListener(k.slice(2), v); else e.setAttribute(k, v === true ? '' : v);
  }
  for (const f of filhos) if (f != null) e.append(f instanceof Node ? f : document.createTextNode(String(f)));
  return e;
}
const SVG = 'http://www.w3.org/2000/svg';
function sv(tag, attrs) { const e = document.createElementNS(SVG, tag); for (const [k, v] of Object.entries(attrs || {})) e.setAttribute(k, v); return e; }

/* ============================== Supabase ============================== */
const CONFIG = Object.assign({url: '', anonKey: ''}, window.ZON_CONFIG || {});
const mem = {};
const store = {
  get(k) { try { const v = localStorage.getItem(k); return v == null ? (mem[k] ?? null) : v; } catch (e) { return mem[k] ?? null; } },
  set(k, v) { if (v == null) delete mem[k]; else mem[k] = v; try { v == null ? localStorage.removeItem(k) : localStorage.setItem(k, v); } catch (e) {} }
};
let session = null;
const sbUrl = () => String(CONFIG.url || store.get('zon_sb_url') || '').trim().replace(/\/+$/, '');
const sbKey = () => String(CONFIG.anonKey || store.get('zon_sb_key') || '').trim();
function saveSession(x) { session = x; store.set('zon_sb_session', x ? JSON.stringify(x) : null); }
async function authCall(grant, body) {
  const r = await fetch(`${sbUrl()}/auth/v1/token?grant_type=${grant}`, {method: 'POST', headers: {apikey: sbKey(), 'Content-Type': 'application/json'}, body: JSON.stringify(body)});
  const j = await r.json().catch(() => ({}));
  if (!r.ok) { if (grant === 'refresh_token') saveSession(null); throw Error(j.error_description || j.msg || j.message || ('HTTP ' + r.status)); }
  saveSession({access_token: j.access_token, refresh_token: j.refresh_token, expires_at: j.expires_at || Math.floor(Date.now() / 1000) + (j.expires_in || 3600), email: j.user?.email || session?.email || ''});
  return session;
}
async function accessToken() {
  if (!session) throw Error('Sessão expirada. Entre novamente.');
  if ((session.expires_at || 0) - 60 < Date.now() / 1000) await authCall('refresh_token', {refresh_token: session.refresh_token});
  return session.access_token;
}
async function sbFetch(path, opts = {}, retry = true) {
  const tok = await accessToken();
  const r = await fetch(sbUrl() + path, {...opts, headers: {apikey: sbKey(), Authorization: 'Bearer ' + tok, 'Content-Type': 'application/json', ...(opts.headers || {})}});
  if (r.status === 401 && retry && session) { await authCall('refresh_token', {refresh_token: session.refresh_token}); return sbFetch(path, opts, false); }
  if (!r.ok) { const t = await r.text(); let m; try { m = JSON.parse(t).message; } catch (e) {} throw Error(m || t || ('HTTP ' + r.status)); }
  return r;
}
const rpc = async (fn, args = {}) => (await sbFetch('/rest/v1/rpc/' + fn, {method: 'POST', body: JSON.stringify(args)})).json();
async function sbUpsert(tabela, linhas, conflito, progresso) {
  for (let i = 0; i < linhas.length; i += 500) {
    await sbFetch(`/rest/v1/${tabela}?on_conflict=${conflito}`, {method: 'POST', headers: {Prefer: 'resolution=merge-duplicates,return=minimal'}, body: JSON.stringify(linhas.slice(i, i + 500))});
    progresso && progresso(Math.min(linhas.length, i + 500), linhas.length);
  }
}

/* ============================== estado ============================== */
const S = {
  dados: null,        // {ultima, semanas:[iso], tot:[{r,k,c,novos}], clientes:[...]}
  sync: [],
  wi: -1,             // semana escolhida (índice)
  linhas: [],         // situação de cada cliente na semana escolhida
  aba: 'resumo',
  filtroSit: 'todos', busca: '', ordem: {campo: 'k', dir: -1}, limiteCli: 50,
  faixa: null, buscaAus: '', soMkt: false, soRitmo: false, limiteAus: 50
};
const SIT = {
  ativo: {rot: 'Ativo', ordem: 3}, queda: {rot: 'Em queda', ordem: 1}, novo: {rot: 'Novo', ordem: 4},
  ausente: {rot: 'Ausente', ordem: 2}, nunca: {rot: 'Nunca recarregou', ordem: 5}
};
const FAIXAS = [[7, 13, '7 a 13 dias'], [14, 29, '14 a 29 dias'], [30, 59, '30 a 59 dias'], [60, 89, '60 a 89 dias'], [90, Infinity, '90 dias ou mais']];

/* ============================== carga dos dados ============================== */
function montarDados(bruto) {
  const desde = bruto.desde, ultima = bruto.ultima_data;
  if (!desde || !ultima) return {vazio: true, clientes: [], semanas: [], tot: [], totalRecargas: 0};
  const W = Math.floor(difDias(ultima, desde) / 7) + 1;
  const semanas = Array.from({length: W}, (_, i) => somaDias(desde, i * 7));
  const tot = semanas.map(() => ({r: 0, k: 0, c: 0, novos: 0}));
  for (const [s, r, k, c, novos] of bruto.semanas || []) {
    const i = Math.round(difDias(s, desde) / 7);
    if (i >= 0 && i < W) tot[i] = {r: +r, k: +k, c: +c, novos: +novos};
  }
  let totalRecargas = 0;
  const clientes = (bruto.clientes || []).map(a => {
    const c = {email: a[0], nome: a[1] || a[0].split('@')[0], cadastro: a[2] === '1', primeira: a[3] || null, ultima: a[4] || null,
      n: +a[5] || 0, kwh: +a[6] || 0, mkt: a[7] === '1', k: null, r: null, d: null};
    totalRecargas += c.n;
    if (c.primeira && c.ultima) {
      const dias = difDias(c.ultima, c.primeira) + 1;
      c.mediaAtiva = c.kwh / Math.max(4, Math.ceil(dias / 7));          // kWh por semana enquanto ativo (mínimo 4 semanas)
      c.intervalo = c.n >= 2 ? Math.max(1, Math.round((dias - 1) / (c.n - 1))) : null; // dias entre recargas
    }
    return c;
  });
  const txt = bruto.series || '';
  if (txt) for (const item of txt.split(';')) {
    const p = item.split(',');
    const c = clientes[+p[0]], w = +p[1];
    if (!c || w < 0 || w >= W) continue;
    if (!c.k) { c.k = new Float32Array(W); c.r = new Uint16Array(W); c.d = new Int8Array(W).fill(-1); }
    c.r[w] = +p[2]; c.k[w] = +p[3]; c.d[w] = +p[4];
  }
  return {vazio: false, desde, ultima, semanas, tot, clientes, totalRecargas,
    ultimaCompleta: dia(ultima).getDay() === 0};
}

function avaliarSemana(wi) {
  const D = S.dados, ini = D.semanas[wi];
  const parcial = wi === D.semanas.length - 1 && !D.ultimaCompleta;
  const ref = parcial ? D.ultima : somaDias(ini, 6);
  const out = [];
  for (const c of D.clientes) {
    if (c.primeira && c.primeira > ref) continue; // ainda não era cliente nessa semana
    const k = c.k ? c.k[wi] : 0, n = c.r ? c.r[wi] : 0;
    let soma = 0, qtd = 0;
    for (let j = wi - 4; j < wi; j++) if (j >= 0) { soma += c.k ? c.k[j] : 0; qtd++; }
    const media = qtd ? soma / qtd : null;
    const k8 = []; for (let j = wi - 7; j <= wi; j++) k8.push(j >= 0 && c.k ? c.k[j] : 0);
    let ultima = null, maisDe = false;
    if (c.ultima && c.ultima <= ref) ultima = c.ultima;
    else if (c.d) { for (let j = wi; j >= 0; j--) if (c.d[j] >= 0) { ultima = somaDias(D.semanas[j], c.d[j]); break; } }
    if (!ultima && c.primeira && c.primeira <= ref) { ultima = null; maisDe = true; }
    let sit, dias = null;
    if (!c.primeira) sit = 'nunca';
    else if (c.primeira >= ini) sit = 'novo';
    else if (n > 0) sit = (media != null && media >= 10 && k < 0.5 * media) ? 'queda' : 'ativo';
    else { sit = 'ausente'; dias = ultima ? difDias(ref, ultima) : difDias(ref, D.semanas[0]); }
    const nAnt = wi > 0 && c.r ? c.r[wi - 1] : 0;
    out.push({c, k, n, media, var: media > 0 ? (k - media) / media : null, k8, ultima, maisDe, dias, sit,
      sumiu: sit === 'ausente' && nAnt > 0,
      foraRitmo: sit === 'ausente' && c.intervalo != null && dias > Math.max(7, 2 * c.intervalo)});
  }
  return out;
}

async function carregar() {
  $('app').classList.add('carregando');
  $('notaDados').textContent = 'Carregando dados…';
  try {
    const [bruto, sync] = await Promise.all([rpc('painel_dados', {p_semanas: 17}), rpc('painel_sync', {p_limite: 30})]);
    S.dados = montarDados(bruto || {});
    S.sync = sync || [];
    const D = S.dados;
    if (D.vazio || !D.clientes.length) {
      const q = await rpc('painel_quem_sou').catch(() => null);
      mostrarAviso(q && q.liberado === false
        ? `Seu login (${q.email || 'sem e-mail'}) ainda não está liberado. No Supabase, em SQL Editor, rode: insert into public.equipe (email) values ('${String(q.email || '').toLowerCase()}'); e depois clique em Atualizar.`
        : 'O banco ainda não tem recargas. Veja a aba Sincronização para conferir se a carga já rodou.');
      S.wi = -1;
    } else {
      if (S.wi < 0 || S.wi >= D.semanas.length) S.wi = D.ultimaCompleta || D.semanas.length < 2 ? D.semanas.length - 1 : D.semanas.length - 2;
      mostrarAviso(D.totalRecargas < 2000 && D.clientes.length > 5000
        ? `O banco tem só ${fmtN(D.totalRecargas)} recargas para ${fmtN(D.clientes.length)} clientes. O histórico ainda não foi carregado por completo: rode a carga do histórico no GitHub (Actions → Sincronizar Tupi → Run workflow, com a data inicial lá atrás).`
        : '');
    }
    montarSeletor();
    recalcular();
  } catch (e) {
    if (!session || /sess|jwt|token|refresh/i.test(e.message)) { saveSession(null); mostrarLogin('Sua sessão expirou. Entre novamente.'); return; }
    mostrarAviso('Não foi possível carregar os dados: ' + e.message);
    $('notaDados').textContent = '';
  } finally { $('app').classList.remove('carregando'); }
}
function mostrarAviso(t) { $('aviso').textContent = t || ''; $('aviso').classList.toggle('hidden', !t); }

function montarSeletor() {
  const D = S.dados, sel = $('semana');
  sel.replaceChildren();
  if (!D || D.vazio) { sel.disabled = true; $('notaDados').textContent = ''; return; }
  sel.disabled = false;
  for (let i = D.semanas.length - 1; i >= 0; i--) {
    const parcial = i === D.semanas.length - 1 && !D.ultimaCompleta;
    sel.append(el('option', {value: i, text: rotSemana(D.semanas[i]) + (parcial ? ' (em andamento)' : '')}));
  }
  sel.value = S.wi;
  $('notaDados').textContent = `Recargas registradas até ${dataBR(D.ultima)}. Atualização automática toda segunda-feira.`;
}

function recalcular() {
  if (S.dados && !S.dados.vazio && S.wi >= 0) S.linhas = avaliarSemana(S.wi); else S.linhas = [];
  S.limiteCli = 50; S.limiteAus = 50;
  renderTudo();
}
function renderTudo() { renderResumo(); renderClientes(); renderAusentes(); renderSync(); }

/* ============================== gráfico de barras ============================== */
function niceMax(v) {
  if (v <= 0) return 1;
  const p = Math.pow(10, Math.floor(Math.log10(v))), f = v / p;
  return (f <= 1 ? 1 : f <= 2 ? 2 : f <= 2.5 ? 2.5 : f <= 5 ? 5 : 10) * p;
}
function barras(alvo, itens, op = {}) {
  // itens: [{rotulo, valor, dica:[forte, linha2], acessivel}]
  alvo.replaceChildren();
  const largura = Math.max(280, alvo.clientWidth || 600), altura = op.altura || 230;
  const m = {t: 24, r: 8, b: 28, l: 52};
  const pw = largura - m.l - m.r, ph = altura - m.t - m.b;
  const svg = sv('svg', {viewBox: `0 0 ${largura} ${altura}`, height: altura, role: 'img', 'aria-label': op.titulo || 'Gráfico de barras'});
  const maxV = niceMax(Math.max(0, ...itens.map(i => i.valor)) * 1.05);
  const y = v => m.t + ph - (v / maxV) * ph;
  const ticks = 4;
  for (let t = 0; t <= ticks; t++) {
    const v = maxV * t / ticks, yy = y(v);
    svg.append(sv('line', {x1: m.l, x2: largura - m.r, y1: yy, y2: yy, class: t === 0 ? 'base' : 'grade'}));
    const tx = sv('text', {x: m.l - 6, y: yy + 4, 'text-anchor': 'end', class: 'eixo'}); tx.textContent = fmtCompacto(v); svg.append(tx);
  }
  if (!itens.length || itens.every(i => !i.valor)) {
    const tx = sv('text', {x: m.l + pw / 2, y: m.t + ph / 2, 'text-anchor': 'middle', class: 'vazio'}); tx.textContent = 'Sem consumo no período'; svg.append(tx);
  }
  const banda = pw / Math.max(1, itens.length), bw = Math.min(24, Math.max(3, banda - 2));
  const passo = banda < 22 ? 4 : banda < 40 ? 2 : 1;
  itens.forEach((it, i) => {
    const cx = m.l + banda * i + banda / 2, sel = i === op.selecionado;
    if (sel) svg.append(sv('rect', {x: m.l + banda * i, y: m.t, width: banda, height: ph, class: 'col-sel', rx: 4}));
    const h = Math.max(0, m.t + ph - y(it.valor));
    const alvoHit = sv('rect', {x: m.l + banda * i, y: m.t, width: banda, height: ph, class: 'alvo', tabindex: 0, role: op.aoEscolher ? 'button' : 'img', 'aria-label': it.acessivel || ''});
    svg.append(alvoHit);
    let barra = null;
    if (h > 0.5) {
      const r = Math.min(4, bw / 2, h), x0 = cx - bw / 2, y0 = m.t + ph - h, x1 = cx + bw / 2, yb = m.t + ph;
      barra = sv('path', {class: 'bar' + (it.parcial ? ' parcial' : ''), d: `M${x0},${yb}V${y0 + r}Q${x0},${y0} ${x0 + r},${y0}H${x1 - r}Q${x1},${y0} ${x1},${y0 + r}V${yb}Z`});
      svg.append(barra);
    }
    if (sel && it.valor > 0) {
      const tx = sv('text', {x: cx, y: Math.max(12, y(it.valor) - 6), 'text-anchor': 'middle', class: 'rotulo'}); tx.textContent = fmtCompacto(it.valor); svg.append(tx);
    }
    if (sel || i % passo === 0 || i === itens.length - 1) {
      const tx = sv('text', {x: cx, y: altura - 8, 'text-anchor': 'middle', class: 'eixo' + (sel ? ' sel' : '')}); tx.textContent = it.rotulo; svg.append(tx);
    }
    const mostrar = ev => { barra && barra.classList.add('hover'); dica(it.dica, ev, alvoHit); };
    const esconder = () => { barra && barra.classList.remove('hover'); dica(null); };
    alvoHit.addEventListener('pointermove', mostrar); alvoHit.addEventListener('pointerleave', esconder);
    alvoHit.addEventListener('focus', mostrar); alvoHit.addEventListener('blur', esconder);
    if (op.aoEscolher) {
      alvoHit.addEventListener('click', () => op.aoEscolher(i));
      alvoHit.addEventListener('keydown', ev => { if (ev.key === 'Enter' || ev.key === ' ') { ev.preventDefault(); op.aoEscolher(i); } });
    }
  });
  alvo.append(svg);
}
function dica(conteudo, ev, ancora) {
  const d = $('dica');
  if (!conteudo) { d.hidden = true; return; }
  d.replaceChildren(el('strong', {text: conteudo[0]}), el('span', {text: conteudo[1] || ''}));
  d.hidden = false;
  let x, y;
  if (ev && ev.clientX != null && ev.type !== 'focus') { x = ev.clientX; y = ev.clientY; }
  else { const r = ancora.getBoundingClientRect(); x = r.left + r.width / 2; y = r.top + 20; }
  const w = d.offsetWidth, h = d.offsetHeight;
  d.style.left = Math.min(window.innerWidth - w - 8, Math.max(8, x + 12)) + 'px';
  d.style.top = Math.max(8, y - h - 12) + 'px';
}
function spark(valores, rotulo) {
  const w = 8 * 7, h = 20, max = Math.max(...valores, 0);
  const s = sv('svg', {class: 'spark', width: w, height: h, viewBox: `0 0 ${w} ${h}`, role: 'img', 'aria-label': rotulo});
  valores.forEach((v, i) => {
    const bh = max > 0 && v > 0 ? Math.max(2, (v / max) * (h - 2)) : 1;
    s.append(sv('rect', {x: i * 7, y: h - bh, width: 5, height: bh, rx: 1, class: i === valores.length - 1 ? 'atual' : ''}));
  });
  return s;
}

/* ============================== aba Resumo ============================== */
function kpi(rotulo, valor, unidade, delta, explicacao, aoClicar) {
  const d = el('div', {class: 'kpi' + (aoClicar ? ' clicavel' : ''), tabindex: aoClicar ? 0 : null, role: aoClicar ? 'button' : null});
  d.append(el('span', {class: 'rot', text: rotulo}));
  const v = el('span', {class: 'val', text: valor}); if (unidade) v.append(el('small', {text: unidade})); d.append(v);
  if (delta) d.append(el('span', {class: 'delta ' + delta.classe, text: delta.texto}));
  if (explicacao) d.append(el('span', {class: 'exp', text: explicacao}));
  if (aoClicar) { d.addEventListener('click', aoClicar); d.addEventListener('keydown', e => { if (e.key === 'Enter') aoClicar(); }); }
  return d;
}
function delta(atual, anterior, rot = 'vs semana anterior') {
  if (anterior == null || !(anterior > 0)) return null;
  const p = (atual - anterior) / anterior;
  if (Math.abs(p) < 0.005) return {classe: 'igual', texto: '= igual à semana anterior'};
  return {classe: p > 0 ? 'sobe' : 'desce', texto: (p > 0 ? '▲ ' : '▼ ') + fmtPct(p).replace(/^[+−]/, '') + ' ' + rot};
}
function linhaLista(r, valorTxt, sub) {
  const li = el('li', {tabindex: 0},
    el('span', {class: 'quem'}, el('b', {text: r.c.nome}), el('small', {text: r.c.email})),
    el('span', {class: 'v', text: valorTxt}, sub ? el('small', {text: sub}) : null));
  li.addEventListener('click', () => abrirFicha(r));
  li.addEventListener('keydown', e => { if (e.key === 'Enter') abrirFicha(r); });
  return li;
}
function renderResumo() {
  const D = S.dados, k = $('kpis');
  k.replaceChildren();
  if (!D || D.vazio || S.wi < 0) { $('grafSemanas').replaceChildren(); $('topConsumo').replaceChildren(); $('topQueda').replaceChildren(); return; }
  const t = D.tot[S.wi], a = S.wi > 0 ? D.tot[S.wi - 1] : null;
  const sumiram = S.linhas.filter(r => r.sumiu).length;
  k.append(
    kpi('Energia consumida', fmtN(t.k), 'kWh', delta(t.k, a && a.k), 'soma de todas as recargas'),
    kpi('Recargas', fmtN(t.r), '', delta(t.r, a && a.r), 'sessões de carga na semana'),
    kpi('Clientes que recarregaram', fmtN(t.c), '', delta(t.c, a && a.c), 'pelo menos uma recarga'),
    kpi('Clientes novos', fmtN(t.novos), '', null, 'primeira recarga da vida', () => irPara('clientes', 'novo')),
    kpi('Pararam de recarregar', fmtN(sumiram), '', null, 'recarregaram na semana anterior, mas não nesta', () => irPara('ausentes'))
  );
  const itens = D.semanas.map((s, i) => {
    const x = D.tot[i], parcial = i === D.semanas.length - 1 && !D.ultimaCompleta;
    return {rotulo: dataCurta(s), valor: x.k, parcial,
      dica: [fmtN(x.k) + ' kWh', `${rotSemana(s)}${parcial ? ' (em andamento)' : ''} · ${fmtN(x.r)} recargas · ${fmtN(x.c)} clientes`],
      acessivel: `Semana de ${rotSemana(s)}: ${fmtN(x.k)} kWh, ${fmtN(x.r)} recargas`};
  });
  barras($('grafSemanas'), itens, {selecionado: S.wi, titulo: 'Energia consumida por semana', aoEscolher: i => escolherSemana(i)});
  $('notaGraf').textContent = 'Total da rede em kWh. Clique numa barra para ver aquela semana.' + (D.ultimaCompleta ? '' : ' A última barra, mais clara, é a semana em andamento.');

  const top = S.linhas.filter(r => r.k > 0).sort((x, y) => y.k - x.k).slice(0, 10);
  $('topConsumo').replaceChildren(...(top.length ? top.map(r => linhaLista(r, fmtKwh(r.k) + ' kWh', r.n + (r.n === 1 ? ' recarga' : ' recargas'))) : [el('li', {class: 'vazia', text: 'Nenhuma recarga nesta semana.'})]));
  const pararam = S.linhas.filter(r => r.sumiu).sort((x, y) => (y.media || 0) - (x.media || 0)).slice(0, 10);
  $('topQueda').replaceChildren(...(pararam.length ? pararam.map(r => linhaLista(r, 'média ' + fmtKwh(r.media || 0) + ' kWh', 'última recarga ' + dataBR(r.ultima))) : [el('li', {class: 'vazia', text: 'Ninguém parou de recarregar nesta semana.'})]));
}

/* ============================== aba Clientes ============================== */
function selo(r) {
  const s = el('span', {class: 'sit ' + r.sit + (r.sit === 'ausente' && r.dias >= 30 ? ' longo' : '')}, SIT[r.sit].rot);
  if (r.sit === 'ausente') s.append(el('small', {text: (r.maisDe ? 'mais de ' : '') + r.dias + ' dias'}));
  return s;
}
function varCelula(r) {
  if (r.var == null) return el('span', {class: 'mut', text: '—'});
  const c = Math.abs(r.var) < 0.005 ? 'igual' : r.var > 0 ? 'sobe' : 'desce';
  return el('span', {class: 'var ' + c, text: (c === 'sobe' ? '▲ ' : c === 'desce' ? '▼ ' : '') + fmtPct(r.var)});
}
function ultimaTxt(r) {
  if (!r.ultima) return r.maisDe ? 'antes de ' + dataBR(S.dados.semanas[0]) : '—';
  return dataBR(r.ultima);
}
function filtrarClientes() {
  const q = semAcento(S.busca);
  return S.linhas.filter(r => (S.filtroSit === 'todos' || r.sit === S.filtroSit) && (!q || semAcento(r.c.nome + ' ' + r.c.email).includes(q)));
}
function ordenar(lista) {
  const {campo, dir} = S.ordem;
  const v = r => campo === 'nome' ? semAcento(r.c.nome) : campo === 'sit' ? SIT[r.sit].ordem : campo === 'ultima' ? (r.ultima || '') : campo === 'var' ? (r.var ?? -Infinity) : campo === 'media' ? (r.media ?? -1) : r[campo];
  return lista.sort((a, b) => { const x = v(a), y = v(b); return (x < y ? -1 : x > y ? 1 : 0) * dir || (b.k - a.k) || (b.ultima || '').localeCompare(a.ultima || ''); });
}
function renderClientes() {
  const corpo = $('tabClientes').tBodies[0];
  const chips = $('chips');
  chips.replaceChildren();
  const cont = {todos: S.linhas.length}; for (const r of S.linhas) cont[r.sit] = (cont[r.sit] || 0) + 1;
  for (const [id, rot] of [['todos', 'Todos'], ['ativo', 'Ativos'], ['queda', 'Em queda'], ['novo', 'Novos'], ['ausente', 'Ausentes'], ['nunca', 'Nunca recarregaram']]) {
    const b = el('button', {type: 'button', class: 'chip', 'aria-pressed': String(S.filtroSit === id)}, rot, el('span', {class: 'n', text: fmtN(cont[id] || 0)}));
    b.addEventListener('click', () => { S.filtroSit = id; S.limiteCli = 50; renderClientes(); });
    chips.append(b);
  }
  for (const th of $('tabClientes').tHead.rows[0].cells) {
    if (!th.dataset.ord) continue;
    th.setAttribute('aria-sort', th.dataset.ord === S.ordem.campo ? (S.ordem.dir < 0 ? 'descending' : 'ascending') : 'none');
  }
  const lista = ordenar(filtrarClientes());
  const parte = lista.slice(0, S.limiteCli);
  corpo.replaceChildren();
  if (!parte.length) corpo.append(el('tr', {}, el('td', {colspan: 8, class: 'vazio', text: S.linhas.length ? 'Nenhum cliente com esse filtro.' : 'Sem dados.'})));
  for (const r of parte) {
    const tr = el('tr', {tabindex: 0},
      el('td', {}, el('span', {class: 'quem'}, el('b', {text: r.c.nome}), el('small', {text: r.c.email}))),
      el('td', {}, selo(r)),
      el('td', {class: 'num', text: r.k > 0 ? fmtKwh(r.k) : '—'}),
      el('td', {class: 'num', text: r.n > 0 ? fmtN(r.n) : '—'}),
      el('td', {class: 'num', text: r.media != null && r.media > 0 ? fmtKwh(r.media) : '—'}),
      el('td', {class: 'num'}, varCelula(r)),
      el('td', {}, spark(r.k8, 'kWh nas últimas 8 semanas: ' + r.k8.map(v => fmtKwh(v)).join(', '))),
      el('td', {text: ultimaTxt(r)}));
    tr.addEventListener('click', () => abrirFicha(r));
    tr.addEventListener('keydown', e => { if (e.key === 'Enter') abrirFicha(r); });
    corpo.append(tr);
  }
  $('contClientes').textContent = lista.length ? `Mostrando ${fmtN(parte.length)} de ${fmtN(lista.length)} clientes` : '';
  $('maisClientes').classList.toggle('hidden', parte.length >= lista.length);
}

/* ============================== aba Ausentes ============================== */
function ausentes() { return S.linhas.filter(r => r.sit === 'ausente'); }
function renderAusentes() {
  const todos = ausentes();
  const fx = $('faixas');
  fx.replaceChildren();
  const mk = (id, rot, n) => {
    const b = el('button', {type: 'button', class: 'faixa', 'aria-pressed': String(S.faixa === id)}, el('b', {text: fmtN(n)}), el('span', {text: rot}));
    b.addEventListener('click', () => { S.faixa = S.faixa === id ? null : id; S.limiteAus = 50; renderAusentes(); });
    fx.append(b);
  };
  mk(null, 'Todos os ausentes', todos.length);
  FAIXAS.forEach(([a, b, rot], i) => mk(i, rot, todos.filter(r => r.dias >= a && r.dias <= b).length));
  const q = semAcento(S.buscaAus);
  const lista = todos.filter(r => (S.faixa == null || (r.dias >= FAIXAS[S.faixa][0] && r.dias <= FAIXAS[S.faixa][1]))
      && (!S.soMkt || r.c.mkt) && (!S.soRitmo || r.foraRitmo) && (!q || semAcento(r.c.nome + ' ' + r.c.email).includes(q)))
    .sort((x, y) => (y.c.mediaAtiva || 0) - (x.c.mediaAtiva || 0));
  const parte = lista.slice(0, S.limiteAus), corpo = $('tabAusentes').tBodies[0];
  corpo.replaceChildren();
  if (!parte.length) corpo.append(el('tr', {}, el('td', {colspan: 7, class: 'vazio', text: 'Nenhum cliente ausente com esse filtro.'})));
  for (const r of parte) {
    const tr = el('tr', {tabindex: 0},
      el('td', {}, el('span', {class: 'quem'}, el('b', {text: r.c.nome}), el('small', {text: r.c.email}))),
      el('td', {class: 'num', text: (r.maisDe ? 'mais de ' : '') + fmtN(r.dias) + ' dias'}),
      el('td', {text: ultimaTxt(r)}),
      el('td', {class: 'num', text: r.c.intervalo ? `${r.c.intervalo} dias` : '—'}),
      el('td', {class: 'num', text: r.c.mediaAtiva != null ? fmtKwh(r.c.mediaAtiva) : '—'}),
      el('td', {class: 'num', text: fmtN(r.c.n)}),
      el('td', {text: r.c.mkt ? 'Sim' : 'Não informado'}));
    tr.addEventListener('click', () => abrirFicha(r));
    tr.addEventListener('keydown', e => { if (e.key === 'Enter') abrirFicha(r); });
    corpo.append(tr);
  }
  $('contAusentes').textContent = lista.length ? `Mostrando ${fmtN(parte.length)} de ${fmtN(lista.length)} clientes` : '';
  $('maisAusentes').classList.toggle('hidden', parte.length >= lista.length);
  S._ausentesFiltrados = lista;
}

/* ============================== aba Sincronização ============================== */
function renderSync() {
  const log = S.sync || [], ult = log[0], ok = log.find(x => x.status === 'ok');
  const pill = $('syncPill');
  const atrasado = !ok || (Date.now() - new Date(ok.iniciado_em).getTime()) > 8 * 864e5;
  if (!ult) { pill.textContent = 'Sem execuções'; pill.className = 'pill'; }
  else if (ult.status === 'executando') { pill.textContent = 'Em execução'; pill.className = 'pill'; }
  else if (ult.status === 'erro') { pill.textContent = 'Última execução falhou'; pill.className = 'pill ruim'; }
  else if (atrasado) { pill.textContent = 'Atrasado'; pill.className = 'pill ruim'; }
  else { pill.textContent = 'Em dia'; pill.className = 'pill ok'; }
  $('syncTexto').textContent = ult
    ? `Última execução: ${quando(ult.iniciado_em)}, baixando de ${dataBR(ult.janela_inicio)} a ${dataBR(ult.janela_fim)}.` + (ok && ok !== ult ? ` Último sucesso: ${quando(ok.iniciado_em)}.` : '') + (S.dados && S.dados.ultima ? ` Recarga mais recente no banco: ${dataBR(S.dados.ultima)}.` : '')
    : 'A sincronização ainda não rodou. Confira o GitHub Actions.';
  const corpo = $('tabSync').tBodies[0];
  corpo.replaceChildren();
  if (!log.length) corpo.append(el('tr', {}, el('td', {colspan: 5, class: 'vazio', text: 'Nenhuma execução registrada.'})));
  for (const x of log) corpo.append(el('tr', {style: 'cursor:default'},
    el('td', {text: quando(x.iniciado_em)}), el('td', {text: `${dataBR(x.janela_inicio)} a ${dataBR(x.janela_fim)}`}),
    el('td', {}, el('span', {class: 'sit ' + (x.status === 'ok' ? 'ativo' : x.status === 'erro' ? 'ausente longo' : 'nunca'), text: x.status === 'ok' ? 'ok' : x.status})),
    el('td', {class: 'num', text: x.recargas_gravadas == null ? '—' : fmtN(x.recargas_gravadas)}),
    el('td', {class: 'mut', text: x.mensagem || ''})));
}

/* ============================== ficha do cliente ============================== */
async function abrirFicha(r) {
  const c = r.c, dlg = $('ficha');
  $('fichaNome').textContent = c.nome;
  $('fichaEmail').textContent = c.email + (c.mkt ? ' · aceita receber e-mail' : '');
  const mini = $('fichaMini');
  const item = (rot, val) => el('div', {}, el('span', {text: rot}), el('b', {text: val}));
  mini.replaceChildren(
    item('Situação na semana', r.sit === 'ausente' ? `Ausente há ${r.dias} dias` : SIT[r.sit].rot),
    item('Total consumido', fmtKwh(c.kwh) + ' kWh'),
    item('Recargas no total', fmtN(c.n)),
    item('Cliente desde', dataBR(c.primeira)),
    item('Recarrega a cada', c.intervalo ? `${c.intervalo} ${c.intervalo === 1 ? 'dia' : 'dias'}` : '—'));
  $('fichaGraf').replaceChildren(el('p', {class: 'nota', text: 'Carregando…'}));
  $('fichaTab').tBodies[0].replaceChildren();
  if (!dlg.open) dlg.showModal();
  try {
    const f = await rpc('painel_cliente', {p_email: c.email});
    const porSemana = new Map((f.semanas || []).map(([s, n, k]) => [s, {n: +n, k: +k}]));
    const fimS = S.dados && S.dados.semanas.length ? S.dados.semanas[S.dados.semanas.length - 1] : iso(new Date());
    const itens = [];
    for (let i = 51; i >= 0; i--) {
      const s = somaDias(fimS, -7 * i), x = porSemana.get(s) || {n: 0, k: 0};
      itens.push({rotulo: dataCurta(s), valor: x.k, dica: [fmtKwh(x.k) + ' kWh', `${rotSemana(s)} · ${x.n} ${x.n === 1 ? 'recarga' : 'recargas'}`], acessivel: `Semana de ${rotSemana(s)}: ${fmtKwh(x.k)} kWh`});
    }
    barras($('fichaGraf'), itens, {altura: 200, titulo: 'kWh por semana do cliente'});
    const corpo = $('fichaTab').tBodies[0];
    const hora = t => t ? t.slice(11, 16) : '';
    const recs = f.recargas || [];
    if (!recs.length) corpo.append(el('tr', {}, el('td', {colspan: 4, class: 'vazio', text: 'Nenhuma recarga registrada.'})));
    for (const [d, ini, fim, est, k] of recs) corpo.append(el('tr', {style: 'cursor:default'},
      el('td', {text: dataBR(d)}), el('td', {text: ini ? `${hora(ini)}${fim ? ' – ' + hora(fim) : ''}` : '—'}),
      el('td', {text: est || '—'}), el('td', {class: 'num', text: fmtKwh(+k)})));
  } catch (e) {
    $('fichaGraf').replaceChildren(el('p', {class: 'nota', text: 'Não foi possível carregar a ficha: ' + e.message}));
  }
}

/* ============================== exportação ============================== */
function baixarCsv(linhas, nome) {
  const num = v => typeof v === 'number' ? String(Math.round(v * 100) / 100).replace('.', ',') : v;
  const s = '﻿' + linhas.map(l => l.map(x => '"' + String(num(x) ?? '').replace(/"/g, '""') + '"').join(';')).join('\r\n');
  const a = el('a', {href: URL.createObjectURL(new Blob([s], {type: 'text/csv;charset=utf-8'})), download: nome});
  document.body.append(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 3000);
}
const semanaArq = () => S.dados.semanas[S.wi];

/* ============================== importação manual ============================== */
function csv(texto) {
  texto = texto.replace(/^﻿/, '');
  const primeira = texto.split(/\r?\n/, 1)[0], sep = (primeira.match(/;/g) || []).length > (primeira.match(/,/g) || []).length ? ';' : ',';
  const linhas = []; let r = [], f = '', q = false;
  for (let i = 0; i < texto.length; i++) {
    const c = texto[i];
    if (c === '"') { if (q && texto[i + 1] === '"') { f += '"'; i++; } else q = !q; }
    else if (!q && (c === sep || c === '\n' || c === '\r')) {
      if (c === sep) { r.push(f); f = ''; }
      else { if (c === '\r' && texto[i + 1] === '\n') i++; r.push(f); f = ''; if (r.some(x => x.trim())) linhas.push(r); r = []; }
    } else f += c;
  }
  r.push(f); if (r.some(x => x.trim())) linhas.push(r);
  const cab = (linhas.shift() || []).map(x => x.trim());
  return linhas.map(l => Object.fromEntries(cab.map((h, i) => [h, (l[i] || '').trim()])));
}
const parseData = v => { v = String(v || '').trim(); let m = v.match(/^(\d{2})\/(\d{2})\/(\d{4})/); if (m) return `${m[3]}-${m[2]}-${m[1]}`; m = v.match(/^(\d{4})-(\d{2})-(\d{2})/); return m ? `${m[1]}-${m[2]}-${m[3]}` : null; };
function parseDataHora(v) {
  v = String(v || '').trim();
  let m = v.match(/^(\d{2})\/(\d{2})\/(\d{4})[ T,]+(\d{1,2}):(\d{2})(?::(\d{2}))?/);
  if (m) return `${m[3]}-${m[2]}-${m[1]}T${m[4].padStart(2, '0')}:${m[5]}:${m[6] || '00'}`;
  m = v.match(/^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})(?::(\d{2}))?/);
  return m ? `${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:${m[6] || '00'}` : null;
}
const numero = v => { v = String(v ?? '0').trim(); if (v.includes(',')) v = v.replace(/\./g, '').replace(',', '.'); const n = Number(v); return isFinite(n) ? n : 0; };
const primeiro = (l, cols) => { for (const c of cols) if (l[c] && l[c].trim()) return l[c].trim(); return ''; };
const COLS_ESTACAO = ['ID', 'Id', 'Código da estação', 'Station ID', 'Estação'];
const COLS_CONECTOR = ['Conector', 'ID do conector', 'Id do conector', 'Connector', 'Connector ID', 'Porta'];
// mesma chave do script de sincronização: estação + conector + início + e-mail
const chaveRecarga = (l, email) => [primeiro(l, COLS_ESTACAO).toUpperCase(), primeiro(l, COLS_CONECTOR), parseDataHora(l['Início (Horário Local)']) || String(l['Início (Horário Local)'] || '').trim(), email].join('|');

async function importar() {
  const cad = $('arqCadastro').files[0], recs = [...$('arqRecargas').files], st = $('statusImport');
  if (!cad && !recs.length) { st.textContent = 'Escolha pelo menos um arquivo.'; return; }
  $('importar').disabled = true;
  try {
    st.textContent = 'Lendo arquivos…';
    const clientes = new Map(), recargas = new Map();
    if (cad) {
      const linhas = csv(await cad.text());
      if (!linhas.length || !('Email' in linhas[0])) throw Error('o cadastro precisa ter a coluna Email');
      for (const u of linhas) { const e = String(u.Email || '').trim().toLowerCase(); if (e) clientes.set(e, {email: e, nome: u.Nome || null, origem: 'cadastro'}); }
    }
    for (const f of recs) {
      const linhas = csv(await f.text());
      if (!linhas.length || !('E-mail' in linhas[0])) throw Error(`o arquivo ${f.name} não tem a coluna E-mail`);
      for (const l of linhas) {
        const e = String(l['E-mail'] || '').trim().toLowerCase(), data = parseData(l['Início (Horário Local)']);
        if (!data) continue;
        const id = chaveRecarga(l, e);
        recargas.set(id, {id, email: e || null, nome: primeiro(l, ['Usuário', 'Nome']) || null, estacao: primeiro(l, COLS_ESTACAO).toUpperCase() || null,
          inicio: parseDataHora(l['Início (Horário Local)']), fim: parseDataHora(l['Fim (Horário Local)']), data,
          kwh: Math.round(numero(l['Energia em kWh']) * 1000) / 1000, origem: 'upload'});
      }
    }
    const prog = (a, b) => st.textContent = `Gravando no banco… ${fmtN(a)} de ${fmtN(b)}`;
    if (clientes.size) await sbUpsert('clientes', [...clientes.values()], 'email', prog);
    if (recargas.size) await sbUpsert('recargas', [...recargas.values()], 'id', prog);
    $('arqCadastro').value = ''; $('arqRecargas').value = '';
    st.textContent = `Pronto: ${fmtN(clientes.size)} clientes e ${fmtN(recargas.size)} recargas gravados.`;
    await carregar();
  } catch (e) { st.textContent = 'Erro na importação: ' + e.message; }
  finally { $('importar').disabled = false; }
}
async function importarPermissoes() {
  const f = $('arqPermissoes').files[0], st = $('statusImport');
  if (!f) { st.textContent = 'Escolha o arquivo de permissões.'; return; }
  try {
    const sim = v => ['sim', 's', 'true', '1'].includes(String(v || '').trim().toLowerCase());
    const lote = new Map();
    for (const r of csv(await f.text())) {
      const e = String(r.Email || r['E-mail'] || '').trim().toLowerCase(); if (!e) continue;
      const desc = sim(r.Descadastrado);
      lote.set(e, {email: e, consentimento: sim(r.Consentimento) && !desc, descadastrado: desc, ultimo_envio: parseData(r.UltimoEnvio)});
    }
    await sbUpsert('permissoes_marketing', [...lote.values()], 'email');
    $('arqPermissoes').value = '';
    st.textContent = `${fmtN(lote.size)} permissões gravadas.`;
    await carregar();
  } catch (e) { st.textContent = 'Erro: ' + e.message; }
}

/* ============================== navegação e login ============================== */
function irPara(aba, filtroSit) {
  S.aba = aba;
  if (filtroSit) { S.filtroSit = filtroSit; S.limiteCli = 50; renderClientes(); }
  for (const b of document.querySelectorAll('[data-aba]')) b.setAttribute('aria-selected', String(b.dataset.aba === aba));
  for (const s of document.querySelectorAll('.aba')) s.classList.toggle('hidden', s.id !== 'aba-' + aba);
  $('filtros').classList.toggle('hidden', aba === 'sync');
  if (aba === 'resumo') renderResumo();
}
function escolherSemana(i) { S.wi = +i; $('semana').value = S.wi; recalcular(); }
function mostrarLogin(msg) {
  $('app').classList.add('hidden'); $('userBox').classList.add('hidden'); $('loginView').classList.remove('hidden');
  $('loginStatus').textContent = msg || '';
  const precisa = !sbUrl() || !sbKey();
  $('setupFields').classList.toggle('hidden', !precisa);
  $('sbUrl').value = sbUrl(); $('sbKey').value = sbKey();
  (precisa ? $('sbUrl') : $('loginEmail')).focus();
}
function mostrarApp() {
  $('loginView').classList.add('hidden'); $('app').classList.remove('hidden'); $('userBox').classList.remove('hidden');
  $('userEmail').textContent = session?.email || '';
}
async function sair() {
  try { if (session) await fetch(sbUrl() + '/auth/v1/logout', {method: 'POST', headers: {apikey: sbKey(), Authorization: 'Bearer ' + session.access_token}}); } catch (e) {}
  saveSession(null); S.dados = null; S.linhas = []; S.sync = []; S.wi = -1;
  mostrarLogin('Você saiu do painel.');
}

$('loginForm').addEventListener('submit', async ev => {
  ev.preventDefault();
  if (!$('setupFields').classList.contains('hidden')) {
    const u = $('sbUrl').value.trim().replace(/\/+$/, ''), k = $('sbKey').value.trim();
    if (!/^https?:\/\/\S+$/.test(u) || !k) { $('loginStatus').textContent = 'Informe a URL do projeto (https://…) e a chave pública.'; return; }
    store.set('zon_sb_url', u); store.set('zon_sb_key', k);
  }
  $('loginBtn').disabled = true; $('loginStatus').textContent = 'Entrando…';
  try {
    await authCall('password', {email: $('loginEmail').value.trim(), password: $('loginPass').value});
    $('loginPass').value = ''; mostrarApp(); await carregar();
  } catch (e) {
    $('loginStatus').textContent = /invalid login|invalid_grant|credentials/i.test(e.message) ? 'E-mail ou senha incorretos.' : /not confirmed/i.test(e.message) ? 'Este usuário ainda não foi confirmado no Supabase.' : 'Não foi possível entrar: ' + e.message;
  } finally { $('loginBtn').disabled = false; }
});
$('changeProject').addEventListener('click', () => { $('setupFields').classList.remove('hidden'); $('sbUrl').value = sbUrl(); $('sbKey').value = sbKey(); $('sbUrl').focus(); });
$('logout').addEventListener('click', sair);
$('recarregar').addEventListener('click', carregar);
$('semana').addEventListener('change', e => escolherSemana(e.target.value));
for (const b of document.querySelectorAll('[data-aba]')) b.addEventListener('click', () => irPara(b.dataset.aba));
$('busca').addEventListener('input', e => { S.busca = e.target.value; S.limiteCli = 50; renderClientes(); });
$('buscaAus').addEventListener('input', e => { S.buscaAus = e.target.value; S.limiteAus = 50; renderAusentes(); });
$('soMkt').addEventListener('change', e => { S.soMkt = e.target.checked; S.limiteAus = 50; renderAusentes(); });
$('soRitmo').addEventListener('change', e => { S.soRitmo = e.target.checked; S.limiteAus = 50; renderAusentes(); });
$('maisClientes').addEventListener('click', () => { S.limiteCli += 50; renderClientes(); });
$('maisAusentes').addEventListener('click', () => { S.limiteAus += 50; renderAusentes(); });
for (const th of $('tabClientes').tHead.rows[0].cells) {
  if (!th.dataset.ord) continue;
  th.querySelector('button').addEventListener('click', () => {
    const c = th.dataset.ord;
    S.ordem = S.ordem.campo === c ? {campo: c, dir: -S.ordem.dir} : {campo: c, dir: c === 'nome' || c === 'sit' ? 1 : -1};
    renderClientes();
  });
}
$('exportClientes').addEventListener('click', () => {
  if (!S.linhas.length) return;
  const l = ordenar(filtrarClientes());
  baixarCsv([['Nome', 'E-mail', 'Situação', 'kWh na semana', 'Recargas na semana', 'Média 4 semanas (kWh)', 'Variação (%)', 'Última recarga', 'Dias sem recarregar', 'Aceita e-mail'],
    ...l.map(r => [r.c.nome, r.c.email, SIT[r.sit].rot, r.k, r.n, r.media ?? '', r.var == null ? '' : Math.round(r.var * 100), r.ultima ? dataBR(r.ultima) : '', r.dias ?? '', r.c.mkt ? 'Sim' : 'Não informado'])],
  `clientes_semana_${semanaArq()}.csv`);
});
$('exportAusentes').addEventListener('click', () => {
  const l = S._ausentesFiltrados || [];
  if (!l.length) return;
  baixarCsv([['Nome', 'E-mail', 'Dias sem recarregar', 'Última recarga', 'Costuma recarregar a cada (dias)', 'Fora do ritmo', 'Consumo médio (kWh/semana)', 'Recargas no total', 'Aceita e-mail'],
    ...l.map(r => [r.c.nome, r.c.email, r.dias, r.ultima ? dataBR(r.ultima) : '', r.c.intervalo ?? '', r.foraRitmo ? 'Sim' : 'Não', r.c.mediaAtiva ?? '', r.c.n, r.c.mkt ? 'Sim' : 'Não informado'])],
  `ausentes_semana_${semanaArq()}.csv`);
});
$('importar').addEventListener('click', importar);
$('importarPerm').addEventListener('click', importarPermissoes);
$('modeloPerm').addEventListener('click', () => baixarCsv([['Email', 'Consentimento', 'Descadastrado', 'UltimoEnvio'], ['exemplo@dominio.com', 'NAO', 'NAO', '']], 'modelo_permissoes.csv'));
$('fichaFechar').addEventListener('click', () => $('ficha').close());
$('ficha').addEventListener('click', e => { if (e.target === $('ficha')) $('ficha').close(); });
$('ficha').addEventListener('close', () => dica(null));
let _rs; window.addEventListener('resize', () => { clearTimeout(_rs); _rs = setTimeout(() => { if (S.aba === 'resumo') renderResumo(); }, 150); });

(async function iniciar() {
  try { session = JSON.parse(store.get('zon_sb_session') || 'null'); } catch (e) { session = null; }
  if (!sbUrl() || !sbKey() || !session) { mostrarLogin(''); return; }
  mostrarApp(); await carregar();
})();
