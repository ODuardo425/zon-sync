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
const semAcento = s => String(s || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
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
let _renovando = null;   // uma renovação de sessão por vez (as consultas saem em paralelo)
function renovarSessao() {
  if (!_renovando) _renovando = authCall('refresh_token', {refresh_token: session.refresh_token}).finally(() => { _renovando = null; });
  return _renovando;
}
async function accessToken() {
  if (!session) throw Error('Sessão expirada. Entre novamente.');
  if ((session.expires_at || 0) - 60 < Date.now() / 1000) await renovarSessao();
  return session.access_token;
}
async function sbFetch(path, opts = {}, retry = true) {
  const tok = await accessToken();
  const r = await fetch(sbUrl() + path, {...opts, headers: {apikey: sbKey(), Authorization: 'Bearer ' + tok, 'Content-Type': 'application/json', ...(opts.headers || {})}});
  if (r.status === 401 && retry && session) { await renovarSessao(); return sbFetch(path, opts, false); }
  if (!r.ok) { const t = await r.text(); let m; try { m = JSON.parse(t).message; } catch (e) {} throw Error(m || t || ('HTTP ' + r.status)); }
  return r;
}
const DEMOROU = /statement timeout|canceling statement|timed out|timeout/i;
const FALTA_FUNCAO = /could not find the function|PGRST202|function .* does not exist/i;
async function rpc(fn, args = {}) {
  const chamar = async () => (await sbFetch('/rest/v1/rpc/' + fn, {method: 'POST', body: JSON.stringify(args)})).json();
  try { return await chamar(); }
  catch (e) {
    // O Supabase corta consultas que passam de alguns segundos; a segunda tentativa costuma ser rápida (cache já aquecido).
    if (DEMOROU.test(e.message)) return chamar();
    throw e;
  }
}
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
  faixa: null, buscaAus: '', soMkt: false, soRitmo: false, limiteAus: 50,
  estacao: '',            // filtro de estação do painel ('' = todas)
  nomesEst: new Map(),    // código da estação -> nome
  cacheDados: new Map(),  // painel_dados já baixado, por estação
  semFuncoesNovas: false, // o banco ainda não tem o schema.sql de outubro/2026
  est: {periodo: '12s', cache: new Map(), dados: null, sel: null, todas: false, ordem: {campo: 'clientes', dir: -1}},
  fal: {periodo: '4s', cache: new Map(), dados: null, limiar: 3, filtro: 'todos', busca: '', soMkt: false, limite: 50}
};
const PERIODOS = {'1s': ['Última semana', 7], '4s': ['Últimas 4 semanas', 28], '12s': ['Últimas 12 semanas', 84],
  '12m': ['Últimos 12 meses', 365], 'tudo': ['Todo o histórico', null]};
const desdePeriodo = id => { const d = PERIODOS[id] && PERIODOS[id][1]; return d && S.dados && S.dados.ultima ? somaDias(S.dados.ultima, -(d - 1)) : null; };
const nomeEst = cod => S.nomesEst.get(cod) || '';
const rotEst = cod => cod ? (nomeEst(cod) ? `${cod} · ${nomeEst(cod)}` : cod) : '—';
const fmtPct1 = p => (p * 100 >= 10 || p === 0 ? nf0 : nf1).format(p * 100) + '%';
const brl = new Intl.NumberFormat('pt-BR', {style: 'currency', currency: 'BRL'});
const AVISO_SQL = 'O banco ainda não tem as funções de estações e tentativas frustradas. No Supabase, em SQL Editor, rode o arquivo supabase/schema.sql atualizado e depois clique em Atualizar.';
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
  $('notaDados').textContent = 'Carregando dados… pode levar alguns segundos.';
  try {
    S.cacheDados.clear(); S.est.cache.clear(); S.fal.cache.clear(); S.est.dados = null; S.fal.dados = null;
    // as três consultas saem juntas; a tela principal aparece assim que o consumo chega
    const pEst = rpc('painel_estacoes', {}).catch(e => ({erro: e.message}));
    const pSync = rpc('painel_sync', {p_limite: 30}).catch(() => []);
    const pDados = buscarDados(S.estacao).catch(async e => {
      if (!S.estacao || !FALTA_FUNCAO.test(e.message)) throw e;
      S.estacao = ''; return buscarDados('');   // banco sem o filtro de estação: volta para todas
    });
    const [bruto, sync] = await Promise.all([pDados, pSync]);
    S.dados = montarDados(bruto || {});
    S.sync = sync || [];
    const D = S.dados, avisos = [];
    if (D.vazio || (!D.clientes.length && !S.estacao)) {
      const q = await rpc('painel_quem_sou').catch(() => null);
      avisos.push(q && q.liberado === false
        ? `Seu login (${q.email || 'sem e-mail'}) ainda não está liberado. No Supabase, em SQL Editor, rode: insert into public.equipe (email) values ('${String(q.email || '').toLowerCase()}'); e depois clique em Atualizar.`
        : 'O banco ainda não tem recargas. Veja a aba Sincronização para conferir se a carga já rodou.');
      S.wi = -1;
    } else {
      if (S.wi < 0 || S.wi >= D.semanas.length) S.wi = D.ultimaCompleta || D.semanas.length < 2 ? D.semanas.length - 1 : D.semanas.length - 2;
      if (!S.estacao && D.totalRecargas < 2000 && D.clientes.length > 5000)
        avisos.push(`O banco tem só ${fmtN(D.totalRecargas)} recargas para ${fmtN(D.clientes.length)} clientes. O histórico ainda não foi carregado por completo: rode a carga do histórico no GitHub (Actions → Sincronizar Tupi → Run workflow, com a data inicial lá atrás).`);
    }
    mostrarAviso(avisos.join(' '));
    montarSeletor();
    mostrarFiltroAtivo();
    recalcular();
    $('app').classList.remove('carregando');
    // lista de estações (filtro, abas Estações e Tentativas) chega em seguida, sem travar a tela
    const est = await pEst;
    if (est.erro) {
      S.semFuncoesNovas = FALTA_FUNCAO.test(est.erro);
      montarListaEstacoes([]);
      avisos.push(S.semFuncoesNovas ? AVISO_SQL : 'A lista de estações demorou para carregar. Clique em Atualizar para tentar de novo.');
    } else {
      S.semFuncoesNovas = false;
      S.est.cache.set('tudo', est);
      montarListaEstacoes(est.estacoes || []);
      if (S.nomesEst.size === 0 && (est.estacoes || []).length)
        avisos.push('Os nomes das estações e os valores em R$ ainda não estão no banco. Eles chegam quando a carga do histórico rodar de novo (GitHub → Actions → Sincronizar Tupi → Run workflow, data inicial 2025-01-01). Até lá, tentativas frustradas são identificadas só pelo 0 kWh.');
    }
    mostrarAviso(avisos.join(' '));
    mostrarFiltroAtivo();
    if (S.aba === 'estacoes') carregarEstacoes();
    if (S.aba === 'falhas') carregarFalhas();
  } catch (e) {
    if (!session || /sess|jwt|refresh|invalid.*token|token.*(expired|invalid)/i.test(e.message)) { saveSession(null); mostrarLogin('Sua sessão expirou. Entre novamente.'); return; }
    mostrarAviso(DEMOROU.test(e.message)
      ? 'O banco demorou demais para responder (o Supabase corta consultas longas). Clique em Atualizar para tentar de novo; a segunda vez costuma ser rápida.'
      : 'Não foi possível carregar os dados: ' + e.message);
    $('notaDados').textContent = '';
  } finally { $('app').classList.remove('carregando'); }
}
function mostrarAviso(t) { $('aviso').textContent = t || ''; $('aviso').classList.toggle('hidden', !t); }

/* ============================== filtro de estação ============================== */
async function buscarDados(cod) {
  if (!S.cacheDados.has(cod)) S.cacheDados.set(cod, await rpc('painel_dados', cod ? {p_semanas: 17, p_estacao: cod} : {p_semanas: 17}));
  return S.cacheDados.get(cod);
}
function montarListaEstacoes(linhas) {
  S.nomesEst = new Map(linhas.filter(a => a[1]).map(a => [a[0], a[1]]));
  const sel = $('estacao');
  sel.replaceChildren(el('option', {value: '', text: 'Todas as estações'}));
  const lista = linhas.map(a => a[0]).sort((a, b) => a.localeCompare(b, 'pt-BR', {numeric: true}));
  for (const cod of lista) sel.append(el('option', {value: cod, text: rotEst(cod)}));
  sel.disabled = !lista.length;
  sel.title = S.semFuncoesNovas ? AVISO_SQL : '';
  if (S.estacao && !lista.includes(S.estacao)) S.estacao = '';
  sel.value = S.estacao;
}
function mostrarFiltroAtivo() {
  const box = $('filtroAtivo');
  box.replaceChildren();
  const visivel = !!S.estacao && S.aba !== 'sync' && S.aba !== 'estacoes';
  box.classList.toggle('hidden', !visivel);
  if (!visivel) return;
  const n = S.dados && !S.dados.vazio ? S.dados.clientes.length : 0;
  const b = el('button', {type: 'button', class: 'sec', text: 'Ver todas as estações'});
  b.addEventListener('click', () => trocarEstacao(''));
  box.append(el('span', {}, 'Mostrando só a estação ', el('b', {text: rotEst(S.estacao)}),
    ` · ${fmtN(n)} ${n === 1 ? 'cliente já recarregou' : 'clientes já recarregaram'} nela. Situação, consumo e ausência contam só as recargas desta estação.`), b);
}
async function trocarEstacao(cod) {
  S.estacao = cod || '';
  $('estacao').value = S.estacao;
  $('app').classList.add('carregando');
  try {
    S.dados = montarDados(await buscarDados(S.estacao) || {});
    if (S.wi >= S.dados.semanas.length) S.wi = S.dados.semanas.length - 1;
    mostrarFiltroAtivo();
    recalcular();
    if (S.aba === 'falhas') await carregarFalhas();
    if (S.aba === 'estacoes' && S.estacao && S.est.dados && S.est.dados.mapa.has(S.estacao)) { S.est.sel = S.estacao; renderEstacoes(); }
  } catch (e) { mostrarAviso('Não foi possível filtrar pela estação: ' + e.message); }
  finally { $('app').classList.remove('carregando'); }
}

/* ============================== períodos (abas Estações e Tentativas) ============================== */
function chipsPeriodo(alvo, ids, atual, aoEscolher) {
  alvo.replaceChildren(el('span', {class: 'rot', text: 'Período'}));
  for (const id of ids) {
    const b = el('button', {type: 'button', class: 'chip', 'aria-pressed': String(id === atual), text: PERIODOS[id][0]});
    b.addEventListener('click', () => aoEscolher(id));
    alvo.append(b);
  }
  const desde = desdePeriodo(atual);
  if (S.dados && S.dados.ultima) alvo.append(el('span', {class: 'nota', text: desde ? `${dataBR(desde)} a ${dataBR(S.dados.ultima)}` : `até ${dataBR(S.dados.ultima)}`}));
}

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
// eixo com 3 a 5 divisões "redondas" (1, 2, 2,5 ou 5 × 10ⁿ), escolhendo a que sobra menos espaço
function escala(bruto) {
  const teto = v => { const p = Math.pow(10, Math.floor(Math.log10(v))), f = v / p; return (f <= 1 ? 1 : f <= 2 ? 2 : f <= 2.5 ? 2.5 : f <= 5 ? 5 : 10) * p; };
  if (!(bruto > 0)) return {max: 4, n: 4};
  let melhor = null;
  for (const n of [4, 5, 3]) { const passo = Math.max(1, teto(bruto / n)), max = passo * n; if (!melhor || max < melhor.max) melhor = {max, n}; }
  return melhor;
}
function barras(alvo, itens, op = {}) {
  // itens: [{rotulo, valor, dica:[forte, linha2], acessivel}]
  alvo.replaceChildren();
  const largura = Math.max(280, alvo.clientWidth || 600), altura = op.altura || 230;
  const m = {t: 24, r: 8, b: 28, l: 52};
  const pw = largura - m.l - m.r, ph = altura - m.t - m.b;
  const svg = sv('svg', {viewBox: `0 0 ${largura} ${altura}`, height: altura, role: 'img', 'aria-label': op.titulo || 'Gráfico de barras'});
  const {max: maxV, n: ticks} = escala(Math.max(0, ...itens.map(i => i.valor)) * 1.05);
  const y = v => m.t + ph - (v / maxV) * ph;
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
    const ultimo = i === itens.length - 1;
    if (sel || ultimo || (i % passo === 0 && itens.length - 1 - i >= passo && (!(op.selecionado >= 0) || Math.abs(i - op.selecionado) >= passo))) {
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

/* barras horizontais em HTML: uma linha por item, com 1 ou 2 segmentos */
function hbarras(alvo, itens, op = {}) {
  // itens: [{chave, rotulo, sub, segs:[...], total, texto, dica:[forte, linha2], sel, alerta}]
  alvo.replaceChildren();
  if (!itens.length) { alvo.append(el('p', {class: 'nota', text: op.vazio || 'Nada para mostrar no período.'})); return; }
  const max = Math.max(1, ...itens.map(i => i.total));
  const lista = el('div', {class: 'hb-lista'});
  for (const it of itens) {
    const trilho = el('span', {class: 'hb-trilho', 'aria-hidden': 'true'});
    it.segs.forEach((v, k) => { if (v > 0) trilho.append(el('span', {class: 'hb-seg s' + (k + 1), style: `width:${(v / max * 100).toFixed(2)}%`})); });
    const rot = el('span', {class: 'hb-rot'}, el('b', {text: it.rotulo}), it.sub ? el('small', {text: ' ' + it.sub}) : null);
    const val = el('span', {class: 'hb-val'}, it.texto ?? fmtN(it.total));
    if (it.alerta) val.append(el('span', {class: 'hb-alerta', text: it.alerta}));
    const linha = el(op.aoEscolher ? 'button' : 'div', {type: op.aoEscolher ? 'button' : null,
      class: 'hb-linha' + (it.sel ? ' sel' : ''), 'aria-pressed': op.aoEscolher ? String(!!it.sel) : null,
      'aria-label': `${it.rotulo} ${it.sub || ''}: ${it.dica ? it.dica.join(', ') : it.texto || it.total}`}, rot, trilho, val);
    if (it.dica) {
      linha.addEventListener('pointermove', ev => dica(it.dica, ev, linha));
      linha.addEventListener('pointerleave', () => dica(null));
      linha.addEventListener('focus', ev => dica(it.dica, ev, linha));
      linha.addEventListener('blur', () => dica(null));
    }
    if (op.aoEscolher) linha.addEventListener('click', () => op.aoEscolher(it));
    lista.append(linha);
  }
  alvo.append(lista);
}
function legenda(alvo, itens) {
  alvo.replaceChildren(...itens.map(([classe, texto]) => el('span', {class: 'leg'}, el('i', {class: classe}), texto)));
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
    kpi('Clientes novos', fmtN(t.novos), '', null, S.estacao ? 'primeira recarga nesta estação' : 'primeira recarga da vida', () => irPara('clientes', 'novo')),
    kpi('Pararam de recarregar', fmtN(sumiram), '', null, 'recarregaram na semana anterior, mas não nesta', () => irPara('ausentes'))
  );
  const itens = D.semanas.map((s, i) => {
    const x = D.tot[i], parcial = i === D.semanas.length - 1 && !D.ultimaCompleta;
    return {rotulo: dataCurta(s), valor: x.k, parcial,
      dica: [fmtN(x.k) + ' kWh', `${rotSemana(s)}${parcial ? ' (em andamento)' : ''} · ${fmtN(x.r)} recargas · ${fmtN(x.c)} clientes`],
      acessivel: `Semana de ${rotSemana(s)}: ${fmtN(x.k)} kWh, ${fmtN(x.r)} recargas`};
  });
  barras($('grafSemanas'), itens, {selecionado: S.wi, titulo: 'Energia consumida por semana', aoEscolher: i => escolherSemana(i)});
  $('notaGraf').textContent = (S.estacao ? `Só a estação ${rotEst(S.estacao)}, em kWh.` : 'Total da rede em kWh.') + ' Clique numa barra para ver aquela semana.' + (D.ultimaCompleta ? '' : ' A última barra, mais clara, é a semana em andamento.');

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

/* ============================== aba Estações ============================== */
function indisponivel(ids) { for (const id of ids) $(id).replaceChildren(el('p', {class: 'aviso', text: AVISO_SQL})); }
async function carregarEstacoes() {
  chipsPeriodo($('perEst'), ['4s', '12s', '12m', 'tudo'], S.est.periodo, id => { S.est.periodo = id; carregarEstacoes(); });
  if (S.semFuncoesNovas) { indisponivel(['grafEst']); return; }
  let d = S.est.cache.get(S.est.periodo);
  if (!d) {
    $('grafEst').replaceChildren(el('p', {class: 'nota', text: 'Carregando…'}));
    const desde = desdePeriodo(S.est.periodo);
    try { d = await rpc('painel_estacoes', desde ? {p_desde: desde} : {}); S.est.cache.set(S.est.periodo, d); }
    catch (e) { $('grafEst').replaceChildren(el('p', {class: 'nota', text: DEMOROU.test(e.message) ? 'O banco demorou demais para responder. Escolha o período de novo ou clique em Atualizar.' : 'Não foi possível carregar as estações: ' + e.message})); return; }
  }
  const lista = (d.estacoes || []).map(a => {
    const x = {cod: a[0], nome: a[1] || nomeEst(a[0]), clientes: +a[2], exclusivos: +a[3], recargas: +a[4], kwh: +a[5], frustradas: +a[6], primeira: a[7], ultima: a[8]};
    x.taxa = x.recargas + x.frustradas ? x.frustradas / (x.recargas + x.frustradas) : 0;
    return x;
  });
  const comum = new Map();
  for (const [a, b, n] of d.pares || []) {
    if (!comum.has(a)) comum.set(a, []); if (!comum.has(b)) comum.set(b, []);
    comum.get(a).push([b, +n]); comum.get(b).push([a, +n]);
  }
  S.est.dados = {lista, mapa: new Map(lista.map(x => [x.cod, x])), comum, total: +d.clientes_total || 0};
  if (!S.est.sel || !S.est.dados.mapa.has(S.est.sel)) {
    const comCli = lista.filter(x => x.clientes > 0);
    S.est.sel = S.estacao && S.est.dados.mapa.has(S.estacao) ? S.estacao : (comCli[0] || lista[0] || {}).cod || null;
  }
  renderEstacoes();
}
function renderEstacoes() {
  const E = S.est.dados;
  if (!E) return;
  const ativas = E.lista.filter(x => x.clientes > 0).sort((a, b) => b.clientes - a.clientes || a.cod.localeCompare(b.cod));
  const multi = Math.max(0, E.total - ativas.reduce((s, x) => s + x.exclusivos, 0));
  const top = ativas[0];
  $('kpisEst').replaceChildren(
    kpi('Estações com recarga', fmtN(ativas.length), '', null, 'no período escolhido'),
    kpi('Clientes únicos na rede', fmtN(E.total), '', null, 'recarregaram pelo menos uma vez'),
    kpi('Usam mais de uma estação', fmtN(multi), '', null, E.total ? `${fmtPct1(multi / E.total)} dos clientes únicos` : ''),
    kpi('Estação com mais clientes', top ? top.cod : '—', '', null, top ? `${fmtN(top.clientes)} clientes · ${top.nome || ''}` : ''));
  legenda($('legEst'), [['s1', 'Só usam esta estação'], ['s2', 'Também usam outras']]);
  const mostrar = S.est.todas ? ativas : ativas.slice(0, 15);
  hbarras($('grafEst'), mostrar.map(x => ({chave: x.cod, rotulo: x.cod, sub: x.nome, segs: [x.exclusivos, x.clientes - x.exclusivos], total: x.clientes,
    texto: fmtN(x.clientes), sel: x.cod === S.est.sel,
    dica: [`${rotEst(x.cod)}`, `${fmtN(x.clientes)} clientes únicos · ${fmtN(x.exclusivos)} só usam esta · ${fmtN(x.clientes - x.exclusivos)} também usam outras · ${fmtN(x.recargas)} recargas`]})),
    {aoEscolher: it => { S.est.sel = it.chave; renderEstacoes(); if (window.innerWidth < 900) $('cardComum').scrollIntoView({behavior: 'smooth', block: 'start'}); }, vazio: 'Nenhuma recarga no período.'});
  if (ativas.length > 15) {
    const b = el('button', {type: 'button', class: 'sec mais-est', text: S.est.todas ? 'Mostrar só as 15 maiores' : `Mostrar todas as ${ativas.length} estações`});
    b.addEventListener('click', () => { S.est.todas = !S.est.todas; renderEstacoes(); });
    $('grafEst').append(b);
  }
  renderComum();
  renderTabelaEst();
}
function renderComum() {
  const E = S.est.dados, x = E && E.mapa.get(S.est.sel);
  $('filtrarPorEst').classList.toggle('hidden', !x);
  if (!x) { $('tituloComum').textContent = 'Clientes em comum'; $('notaComum').textContent = 'Escolha uma estação ao lado.'; $('grafComum').replaceChildren(); return; }
  $('tituloComum').textContent = `Quem recarrega no ${x.cod} também usa…`;
  const outras = (E.comum.get(x.cod) || []).sort((a, b) => b[1] - a[1]);
  const compart = x.clientes - x.exclusivos;
  $('notaComum').textContent = x.clientes
    ? `${rotEst(x.cod)}: ${fmtN(x.clientes)} clientes no período. ${fmtN(compart)} (${fmtPct1(compart / x.clientes)}) também recarregaram em outra estação; ${fmtN(x.exclusivos)} só usam esta.`
    : `${rotEst(x.cod)} não teve recargas com sucesso no período.`;
  hbarras($('grafComum'), outras.slice(0, 12).map(([cod, n]) => ({chave: cod, rotulo: cod, sub: nomeEst(cod), segs: [n], total: n,
    texto: `${fmtN(n)} · ${fmtPct1(n / Math.max(1, x.clientes))}`,
    dica: [`${fmtN(n)} clientes em comum`, `usaram ${x.cod} e ${cod} no período (${fmtPct1(n / Math.max(1, x.clientes))} dos clientes do ${x.cod})`]})),
    {vazio: x.clientes ? 'Todos os clientes desta estação só usam ela.' : ''});
  $('filtrarPorEst').textContent = `Ver o painel só do ${x.cod}`;
}
function renderTabelaEst() {
  const E = S.est.dados, {campo, dir} = S.est.ordem;
  for (const th of $('tabEst').tHead.rows[0].cells) th.setAttribute('aria-sort', th.dataset.ord === campo ? (dir < 0 ? 'descending' : 'ascending') : 'none');
  const v = x => campo === 'cod' ? x.cod : campo === 'ultima' ? (x.ultima || '') : x[campo];
  const lista = [...E.lista].sort((a, b) => { const p = v(a), q = v(b); return (p < q ? -1 : p > q ? 1 : 0) * dir || a.cod.localeCompare(b.cod, 'pt-BR', {numeric: true}); });
  const corpo = $('tabEst').tBodies[0];
  corpo.replaceChildren();
  if (!lista.length) corpo.append(el('tr', {}, el('td', {colspan: 7, class: 'vazio', text: 'Nenhuma estação com recargas no período.'})));
  for (const x of lista) {
    const fr = el('td', {class: 'num'}, x.frustradas ? `${fmtN(x.frustradas)} (${fmtPct1(x.taxa)})` : '—');
    if (x.taxa >= 0.1 && x.frustradas >= 5) fr.append(el('span', {class: 'hb-alerta', text: 'verificar'}));
    const tr = el('tr', {tabindex: 0, class: x.cod === S.est.sel ? 'sel' : null},
      el('td', {}, el('span', {class: 'quem'}, el('b', {text: x.cod}), el('small', {text: x.nome || ''}))),
      el('td', {class: 'num', text: fmtN(x.clientes)}), el('td', {class: 'num', text: fmtN(x.exclusivos)}),
      el('td', {class: 'num', text: fmtN(x.recargas)}), el('td', {class: 'num', text: fmtKwh(x.kwh)}), fr,
      el('td', {text: dataBR(x.ultima)}));
    const escolher = () => { S.est.sel = x.cod; renderEstacoes(); $('cardComum').scrollIntoView({behavior: 'smooth', block: 'nearest'}); };
    tr.addEventListener('click', escolher);
    tr.addEventListener('keydown', e => { if (e.key === 'Enter') escolher(); });
    corpo.append(tr);
  }
  S._estOrdenadas = lista;
}

/* ============================== aba Tentativas frustradas ============================== */
async function carregarFalhas() {
  chipsPeriodo($('perFal'), ['1s', '4s', '12s', 'tudo'], S.fal.periodo, id => { S.fal.periodo = id; carregarFalhas(); });
  if (S.semFuncoesNovas) { indisponivel(['grafFal', 'grafFalEst']); $('kpisFal').replaceChildren(); $('tabFal').tBodies[0].replaceChildren(); return; }
  const chave = S.fal.periodo + '|' + S.estacao;
  let d = S.fal.cache.get(chave);
  if (!d) {
    $('tabFal').tBodies[0].replaceChildren(el('tr', {}, el('td', {colspan: 7, class: 'vazio', text: 'Carregando…'})));
    const desde = desdePeriodo(S.fal.periodo), args = {};
    if (desde) args.p_desde = desde;
    if (S.estacao) args.p_estacao = S.estacao;
    try { d = await rpc('painel_falhas', args); S.fal.cache.set(chave, d); }
    catch (e) { $('tabFal').tBodies[0].replaceChildren(el('tr', {}, el('td', {colspan: 7, class: 'vazio', text: DEMOROU.test(e.message) ? 'O banco demorou demais para responder. Escolha o período de novo ou clique em Atualizar.' : 'Não foi possível carregar: ' + e.message}))); return; }
  }
  const seq = (n, ini, fim, est) => ({n: +n || 0, ini, fim, est: est || ''});
  const fimS = d.ultima_data ? somaDias(d.ultima_data, -((dia(d.ultima_data).getDay() + 6) % 7)) : null;
  const porSem = new Map((d.semanas || []).map(([s, t, f, c]) => [s, {t: +t, f: +f, c: +c}]));
  const semanas = fimS ? Array.from({length: 26}, (_, i) => { const s = somaDias(fimS, -7 * (25 - i)); return {s, ...(porSem.get(s) || {t: 0, f: 0, c: 0})}; }) : [];
  const estacoes = (d.estacoes || []).map(a => ({cod: a[0], nome: a[1] || nomeEst(a[0]), t: +a[2], f: +a[3], c: +a[4], taxa: +a[2] ? +a[3] / +a[2] : 0}));
  const clientes = (d.clientes || []).map(a => ({email: a[0], nome: a[1] || a[0].split('@')[0], fr: +a[2], maior: seq(a[3], a[4], a[5], a[6]),
    atual: seq(a[7], a[8], a[9], a[10]), ultimoOk: a[11], nOk: +a[12] || 0, mkt: a[13] === '1'}));
  S.fal.dados = {semanas, estacoes, clientes, ultima: d.ultima_data, totF: +d.frustradas || 0, totT: +d.tentativas || 0};
  S.fal.limite = 50;
  renderFalhas();
}
function situacaoFalha(x, L) {
  if (x.nOk === 0) return {classe: 'ausente longo', rot: 'Nunca conseguiu recarregar', sub: `${x.atual.n} ${x.atual.n === 1 ? 'tentativa' : 'tentativas'}`, nivel: 3};
  if (x.atual.n >= L) return {classe: 'ausente longo', rot: 'Não conseguiu recarregar', sub: `${x.atual.n} seguidas, sem sucesso depois`, nivel: 3};
  if (x.atual.n >= 1) return {classe: 'ausente', rot: 'Última tentativa falhou', sub: `${x.atual.n} ${x.atual.n === 1 ? 'tentativa' : 'seguidas'}, sem sucesso depois`, nivel: 2};
  if (x.maior.n >= L) return {classe: 'queda', rot: 'Conseguiu depois', sub: `após ${x.maior.n} seguidas`, nivel: 1};
  return {classe: 'nunca', rot: 'Tentativa isolada', sub: '', nivel: 0};
}
function quandoSeq(q) {
  if (!q || !q.ini) return '—';
  const di = q.ini.slice(0, 10), df = (q.fim || q.ini).slice(0, 10), hi = q.ini.slice(11, 16), hf = (q.fim || q.ini).slice(11, 16);
  if (di === df) {
    const min = Math.round((new Date(q.fim || q.ini) - new Date(q.ini)) / 6e4);
    return `${dataBR(di)} ${hi}${hf !== hi ? '–' + hf : ''}${min > 0 ? ` (${min} min)` : ''}`;
  }
  return `${dataBR(di)} ${hi} a ${dataBR(df)} ${hf}`;
}
function filtrarFalhas() {
  const F = S.fal, L = F.limiar, q = semAcento(F.busca);
  return (F.dados ? F.dados.clientes : []).filter(x => (F.filtro === 'todos' || (F.filtro === 'seguidas' ? x.maior.n >= L : (x.atual.n >= L || x.nOk === 0)))
    && (!F.soMkt || x.mkt) && (!q || semAcento(x.nome + ' ' + x.email).includes(q)));
}
function renderFalhas() {
  const F = S.fal, D = F.dados;
  if (!D) return;
  const L = F.limiar, cl = D.clientes;
  const nSeg = cl.filter(x => x.maior.n >= L).length, nSem = cl.filter(x => x.atual.n >= L || x.nOk === 0).length;
  const sufixo = F.periodo === 'tudo' ? 'de todo o histórico' : 'do período';
  $('kpisFal').replaceChildren(
    kpi('Tentativas frustradas', fmtN(D.totF), '', null, D.totT ? `${fmtPct1(D.totF / D.totT)} das ${fmtN(D.totT)} tentativas ${sufixo}` : '0 kWh e R$ 0,00'),
    kpi('Clientes afetados', fmtN(cl.length), '', null, 'tiveram pelo menos uma'),
    kpi(`Tentaram ${L} ou mais vezes seguidas`, fmtN(nSeg), '', null, 'sem recarga com sucesso no meio', () => { F.filtro = 'seguidas'; F.limite = 50; renderFalhas(); $('tabFal').scrollIntoView({behavior: 'smooth', block: 'start'}); }),
    kpi('Ainda sem conseguir', fmtN(nSem), '', null, `${L}+ seguidas (ou nunca conseguiram) e nenhuma recarga depois`, () => { F.filtro = 'semSucesso'; F.limite = 50; renderFalhas(); $('tabFal').scrollIntoView({behavior: 'smooth', block: 'start'}); }));
  const parcial = S.dados && !S.dados.ultimaCompleta;
  barras($('grafFal'), D.semanas.map((x, i) => ({rotulo: dataCurta(x.s), valor: x.f, parcial: parcial && i === D.semanas.length - 1,
    dica: [`${fmtN(x.f)} tentativas frustradas`, `${rotSemana(x.s)} · ${x.t ? fmtPct1(x.f / x.t) : '0%'} das ${fmtN(x.t)} tentativas · ${fmtN(x.c)} clientes`],
    acessivel: `Semana de ${rotSemana(x.s)}: ${fmtN(x.f)} tentativas frustradas`})), {selecionado: -1, altura: 210, titulo: 'Tentativas frustradas por semana'});
  $('notaGrafFal').textContent = 'Últimas 26 semanas' + (S.estacao ? ` · só ${rotEst(S.estacao)}` : '') + '. Uma tentativa frustrada é uma recarga registrada com 0 kWh e R$ 0,00.';
  hbarras($('grafFalEst'), D.estacoes.slice(0, 10).map(x => ({chave: x.cod, rotulo: x.cod, sub: x.nome, segs: [x.f], total: x.f,
    texto: `${fmtN(x.f)} · ${fmtPct1(x.taxa)}`, alerta: x.taxa >= 0.1 && x.f >= 5 ? 'verificar' : null,
    dica: [`${rotEst(x.cod)}`, `${fmtN(x.f)} frustradas de ${fmtN(x.t)} tentativas (${fmtPct1(x.taxa)}) · ${fmtN(x.c)} clientes afetados` + (x.taxa >= 0.1 && x.f >= 5 ? ' · taxa alta: vale conferir o carregador' : '')]})),
    {vazio: 'Nenhuma tentativa frustrada no período.'});

  const chips = $('chipsFal');
  chips.replaceChildren();
  for (const [id, rot, n] of [['todos', 'Todos', cl.length], ['seguidas', `${L}+ seguidas`, nSeg], ['semSucesso', 'Ainda sem conseguir', nSem]]) {
    const b = el('button', {type: 'button', class: 'chip', 'aria-pressed': String(F.filtro === id)}, rot, el('span', {class: 'n', text: fmtN(n)}));
    b.addEventListener('click', () => { F.filtro = id; F.limite = 50; renderFalhas(); });
    chips.append(b);
  }
  const lista = filtrarFalhas(), parte = lista.slice(0, F.limite), corpo = $('tabFal').tBodies[0];
  corpo.replaceChildren();
  if (!parte.length) corpo.append(el('tr', {}, el('td', {colspan: 7, class: 'vazio', text: cl.length ? 'Nenhum cliente com esse filtro.' : 'Nenhuma tentativa frustrada no período.'})));
  for (const x of parte) {
    const s = situacaoFalha(x, L), foco = x.atual.n > 0 ? x.atual : x.maior;
    const ests = foco.est.split(', ').filter(Boolean);
    const tr = el('tr', {tabindex: 0, class: s.nivel >= 3 ? 'destaque critico' : x.maior.n >= L ? 'destaque' : null},
      el('td', {}, el('span', {class: 'quem'}, el('b', {text: x.nome}), el('small', {text: x.email}))),
      el('td', {class: 'sit-cel'}, el('span', {class: 'sit ' + s.classe}, s.rot), s.sub ? el('small', {text: s.sub}) : null),
      el('td', {class: 'num'}, el('b', {class: x.maior.n >= L ? 'forte' : '', text: `${x.maior.n}×`})),
      el('td', {class: 'quando-cel'}, el('span', {class: 'quem'}, el('span', {text: quandoSeq(foco)}), el('small', {text: ests.map(rotEst).join(' / ')}))),
      el('td', {class: 'num', text: fmtN(x.fr)}),
      el('td', {text: x.ultimoOk ? dataBR(x.ultimoOk.slice(0, 10)) : 'nunca'}),
      el('td', {text: x.mkt ? 'Sim' : 'Não informado'}));
    const abrir = () => abrirFichaEmail(x.email, x.nome);
    tr.addEventListener('click', abrir);
    tr.addEventListener('keydown', e => { if (e.key === 'Enter') abrir(); });
    corpo.append(tr);
  }
  $('contFal').textContent = lista.length ? `Mostrando ${fmtN(parte.length)} de ${fmtN(lista.length)} clientes` : '';
  $('maisFal').classList.toggle('hidden', parte.length >= lista.length);
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
const DIAS = ['Seg', 'Ter', 'Qua', 'Qui', 'Sex', 'Sáb', 'Dom'];
const DIAS_LONGO = ['Segundas', 'Terças', 'Quartas', 'Quintas', 'Sextas', 'Sábados', 'Domingos'];
const FAIXAS_H = [[0, '0h–4h'], [4, '4h–8h'], [8, '8h–12h'], [12, '12h–16h'], [16, '16h–20h'], [20, '20h–24h']];
function abrirFichaEmail(email, nome) {
  const r = S.linhas.find(x => x.c.email === email);
  abrirFicha(r || {c: {email, nome: nome || email.split('@')[0], mkt: false}, sit: null});
}
function fraseEstacoes(est, total) {
  if (!total) return 'Nenhuma recarga com sucesso registrada.';
  const com = est.filter(x => x.n > 0);
  const parte = x => `${fmtN(x.n)} no ${x.cod}${x.nome ? ` (${x.nome})` : ''}`;
  if (com.length === 1) return `${total === 1 ? 'A única recarga foi' : `Todas as ${fmtN(total)} recargas foram`} no ${com[0].cod}${com[0].nome ? ` (${com[0].nome})` : ''}.`;
  const mostra = com.slice(0, 3), resto = com.slice(3), nResto = resto.reduce((s, x) => s + x.n, 0);
  const partes = mostra.map(parte);
  if (resto.length) partes.push(`${fmtN(nResto)} em outras ${resto.length} ${resto.length === 1 ? 'estação' : 'estações'}`);
  return `De ${fmtN(total)} recargas, ${partes.slice(0, -1).join(', ')} e ${partes[partes.length - 1]}.`;
}
function mapaHorario(alvo, recs) {
  const cont = Array.from({length: 7}, () => new Array(6).fill(0));
  let max = 0, n = 0;
  for (const x of recs) {
    if (x.fr || !x.ini) continue;
    const d = new Date(x.ini), dw = (d.getDay() + 6) % 7, b = Math.min(5, Math.floor(d.getHours() / 4));
    max = Math.max(max, ++cont[dw][b]); n++;
  }
  alvo.replaceChildren();
  if (!n) { alvo.append(el('p', {class: 'nota', text: 'Sem horários registrados.'})); return; }
  const grade = el('div', {class: 'mapa-grade', role: 'table', 'aria-label': 'Recargas por dia da semana e horário'});
  grade.append(el('span', {class: 'mapa-cab'}), ...FAIXAS_H.map(([, rot]) => el('span', {class: 'mapa-cab', text: rot})));
  cont.forEach((linha, dw) => {
    grade.append(el('span', {class: 'mapa-dia', text: DIAS[dw]}));
    linha.forEach((v, b) => {
      const nivel = v ? Math.min(5, 1 + Math.floor((v / max) * 4.999)) : 0;
      const txt = [`${fmtN(v)} ${v === 1 ? 'recarga' : 'recargas'}`, `${DIAS_LONGO[dw]}, ${FAIXAS_H[b][1]} · ${fmtPct1(v / n)} do total`];
      const c = el('span', {class: 'mapa-cel n' + nivel, tabindex: v ? 0 : null, role: 'cell', 'aria-label': txt.join(', '), text: v ? fmtN(v) : ''});
      if (v) {
        c.addEventListener('pointermove', ev => dica(txt, ev, c)); c.addEventListener('pointerleave', () => dica(null));
        c.addEventListener('focus', ev => dica(txt, ev, c)); c.addEventListener('blur', () => dica(null));
      }
      grade.append(c);
    });
  });
  const top = cont.flatMap((l, dw) => l.map((v, b) => [v, dw, b])).sort((a, b) => b[0] - a[0])[0];
  alvo.append(grade, el('p', {class: 'nota', text: `Mais comum: ${DIAS_LONGO[top[1]].toLowerCase()}, ${FAIXAS_H[top[2]][1]} (${fmtN(top[0])} de ${fmtN(n)} recargas). Quanto mais forte a cor, mais recargas.`}));
}
function linhaTempo(alvo, recs, estOrdem) {
  alvo.replaceChildren();
  const comData = recs.filter(x => x.ini || x.data);
  if (!comData.length) { alvo.append(el('p', {class: 'nota', text: 'Nenhuma recarga registrada.'})); return; }
  const linhas = estOrdem.slice(0, 6).map(x => x.cod);
  const temOutras = estOrdem.length > 6;
  if (temOutras) linhas.push('Outras');
  const linhaDe = cod => { const i = linhas.indexOf(cod); return i >= 0 && i < 6 ? i : (temOutras ? linhas.length - 1 : 0); };
  const t = x => new Date(x.ini || (x.data + 'T12:00:00')).getTime();
  let t0 = Math.min(...comData.map(t)), t1 = Math.max(...comData.map(t), S.dados && S.dados.ultima ? dia(S.dados.ultima).getTime() : 0);
  if (t1 - t0 < 30 * 864e5) t0 = t1 - 30 * 864e5;
  const pad = (t1 - t0) * 0.02; t0 -= pad; t1 += pad;
  const largura = Math.max(320, alvo.clientWidth || 700), estreito = largura < 560;
  const m = {t: 8, r: 10, b: 26, l: estreito ? 76 : 190}, alt = 30, altura = m.t + m.b + alt * linhas.length;
  const pw = largura - m.l - m.r, x = v => m.l + (v - t0) / (t1 - t0) * pw;
  const svg = sv('svg', {viewBox: `0 0 ${largura} ${altura}`, height: altura, role: 'img', 'aria-label': 'Linha do tempo das recargas por estação'});
  // meses no eixo
  const d = new Date(t0); d.setDate(1); d.setHours(0, 0, 0, 0); d.setMonth(d.getMonth() + 1);
  const meses = []; for (; d.getTime() <= t1; d.setMonth(d.getMonth() + 1)) meses.push(new Date(d));
  const passo = Math.max(1, Math.ceil(meses.length / Math.max(2, Math.floor(pw / 70))));
  meses.forEach((md, i) => {
    const xx = x(md.getTime());
    svg.append(sv('line', {x1: xx, x2: xx, y1: m.t, y2: altura - m.b, class: 'grade'}));
    if (i % passo === 0) { const tx = sv('text', {x: xx, y: altura - 8, 'text-anchor': 'middle', class: 'eixo'}); tx.textContent = md.toLocaleDateString('pt-BR', {month: 'short', year: '2-digit'}).replace('. de ', '/').replace(' de ', '/').replace('.', ''); svg.append(tx); }
  });
  linhas.forEach((cod, i) => {
    const y = m.t + alt * i + alt / 2;
    svg.append(sv('line', {x1: m.l, x2: largura - m.r, y1: y, y2: y, class: 'trilho'}));
    const tx = sv('text', {x: m.l - 8, y: y + 4, 'text-anchor': 'end', class: 'eixo rot-est'});
    const nome = cod === 'Outras' ? '' : nomeEst(cod);
    tx.textContent = estreito || !nome ? cod : `${cod} · ${nome.length > 16 ? nome.slice(0, 15) + '…' : nome}`;
    svg.append(tx);
  });
  const pontos = [];
  for (const r of [...comData].sort((a, b) => a.fr - b.fr)) {
    const cx = x(t(r)), cy = m.t + alt * linhaDe(r.est) + alt / 2;
    svg.append(sv('circle', r.fr ? {cx, cy, r: 4, class: 'pt-fr'} : {cx, cy, r: 4.5, class: 'pt-ok'}));
    pontos.push({cx, cy, r});
  }
  const alvoHit = sv('rect', {x: m.l, y: m.t, width: pw, height: alt * linhas.length, class: 'alvo-lt'});
  svg.append(alvoHit);
  alvoHit.addEventListener('pointermove', ev => {
    const caixa = svg.getBoundingClientRect(), esc = largura / caixa.width;
    const px = (ev.clientX - caixa.left) * esc, py = (ev.clientY - caixa.top) * esc;
    let melhor = null, dist = 12;
    for (const p of pontos) { const dd = Math.hypot(p.cx - px, (p.cy - py) * 1.5); if (dd < dist) { dist = dd; melhor = p; } }
    if (!melhor) { dica(null); return; }
    const r = melhor.r, h = r.ini ? r.ini.slice(11, 16) : '';
    dica([r.fr ? 'Tentativa frustrada' : `${fmtKwh(r.kwh)} kWh${r.valor != null ? ' · ' + brl.format(r.valor) : ''}`, `${dataBR(r.data)}${h ? ' às ' + h : ''} · ${rotEst(r.est)}`], ev, alvoHit);
  });
  alvoHit.addEventListener('pointerleave', () => dica(null));
  alvo.append(svg);
}
async function abrirFicha(r) {
  const c = r.c, dlg = $('ficha');
  $('fichaNome').textContent = c.nome;
  $('fichaEmail').textContent = c.email + (c.mkt ? ' · aceita receber e-mail' : '');
  const mini = $('fichaMini');
  const item = (rot, val, sub) => el('div', {}, el('span', {text: rot}), el('b', {text: val}), sub ? el('small', {text: sub}) : null);
  const sitTxt = !r.sit ? '—' : r.sit === 'ausente' ? `Ausente há ${r.dias} dias` : SIT[r.sit].rot;
  mini.replaceChildren(item('Situação na semana', sitTxt, S.estacao ? 'nesta estação' : ''), item('Total consumido', '…'), item('Recargas', '…'),
    item('Estação preferida', '…'), item('Recarrega a cada', '…'), item('Tentativas frustradas', '…'));
  for (const id of ['fichaGraf', 'fichaEst', 'fichaMapa', 'fichaLinha']) $(id).replaceChildren(el('p', {class: 'nota', text: 'Carregando…'}));
  $('fichaFrase').textContent = '';
  $('fichaTab').tBodies[0].replaceChildren();
  if (!dlg.open) dlg.showModal();
  try {
    const f = await rpc('painel_cliente', {p_email: c.email});
    const recs = (f.recargas || []).map(a => ({data: a[0], ini: a[1], fim: a[2], est: a[3] || '?', kwh: +a[4] || 0,
      valor: a[5] == null ? null : +a[5], fr: a[6] == null ? (+a[4] || 0) < 0.01 : !!a[6]}));
    for (const a of f.recargas || []) if (a[7] && a[3] && !S.nomesEst.has(a[3])) S.nomesEst.set(a[3], a[7]);
    let est = (f.estacoes || []).map(a => ({cod: a[0], nome: a[1] || nomeEst(a[0]), n: +a[2], kwh: +a[3], fr: +a[4], primeira: a[5], ultima: a[6]}));
    if (!f.estacoes) {   // banco com a função antiga: calcula aqui
      const m = new Map();
      for (const x of recs) { const e = m.get(x.est) || {cod: x.est, nome: nomeEst(x.est), n: 0, kwh: 0, fr: 0}; if (x.fr) e.fr++; else { e.n++; e.kwh += x.kwh; } m.set(x.est, e); }
      est = [...m.values()].sort((a, b) => b.n - a.n);
    }
    const total = est.reduce((s, x) => s + x.n, 0), kwh = est.reduce((s, x) => s + x.kwh, 0), nFr = est.reduce((s, x) => s + x.fr, 0);
    const ok = recs.filter(x => !x.fr), datas = ok.map(x => x.data).sort();
    const prim = datas[0], ult = datas[datas.length - 1];
    const intervalo = total >= 2 && prim ? Math.max(1, Math.round(difDias(ult, prim) / (total - 1))) : null;
    const pref = est[0] && est[0].n ? est[0] : null;
    $('fichaEmail').textContent = c.email + (prim ? ` · cliente desde ${dataBR(prim)}` : '') + (c.mkt ? ' · aceita receber e-mail' : '');
    mini.replaceChildren(item('Situação na semana', sitTxt, S.estacao ? 'nesta estação' : ''),
      item('Total consumido', fmtKwh(kwh) + ' kWh'),
      item('Recargas', fmtN(total), ult ? `última em ${dataBR(ult)}` : ''),
      item('Estação preferida', pref ? pref.cod : '—', pref ? `${fmtPct1(pref.n / total)} das recargas${pref.nome ? ' · ' + pref.nome : ''}` : ''),
      item('Recarrega a cada', intervalo ? `${intervalo} ${intervalo === 1 ? 'dia' : 'dias'}` : '—', intervalo ? 'em média' : ''),
      item('Tentativas frustradas', fmtN(nFr), nFr ? `em ${est.filter(x => x.fr).map(x => x.cod).join(', ')}` : 'nenhuma'));
    $('fichaFrase').textContent = fraseEstacoes(est, total) + (nFr ? ` Teve ${fmtN(nFr)} ${nFr === 1 ? 'tentativa frustrada' : 'tentativas frustradas'}.` : '');
    hbarras($('fichaEst'), est.map(x => ({chave: x.cod, rotulo: x.cod, sub: x.nome, segs: [x.n], total: x.n,
      texto: x.n ? `${fmtN(x.n)} · ${fmtPct1(x.n / Math.max(1, total))}` : 'só frustradas',
      alerta: x.fr ? `${fmtN(x.fr)} frustr.` : null,
      dica: [`${rotEst(x.cod)}`, `${fmtN(x.n)} ${x.n === 1 ? 'recarga' : 'recargas'} (${fmtPct1(x.n / Math.max(1, total))}) · ${fmtKwh(x.kwh)} kWh` + (x.fr ? ` · ${fmtN(x.fr)} tentativas frustradas` : '') + (x.ultima ? ` · última em ${dataBR(x.ultima)}` : '')]})),
      {vazio: 'Nenhuma recarga registrada.'});
    mapaHorario($('fichaMapa'), recs);
    linhaTempo($('fichaLinha'), recs, est);
    S._fichaAtual = {recs, est};
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
    if (!recs.length) corpo.append(el('tr', {}, el('td', {colspan: 5, class: 'vazio', text: 'Nenhuma recarga registrada.'})));
    for (const x of recs.slice(0, 200)) corpo.append(el('tr', {style: 'cursor:default', class: x.fr ? 'frustrada' : null},
      el('td', {text: dataBR(x.data)}), el('td', {text: x.ini ? `${hora(x.ini)}${x.fim ? ' – ' + hora(x.fim) : ''}` : '—'}),
      el('td', {}, el('span', {class: 'quem'}, el('b', {text: x.est}), el('small', {text: nomeEst(x.est)}))),
      el('td', {class: 'num'}, x.fr ? el('span', {class: 'sit ausente longo', text: 'frustrada'}) : fmtKwh(x.kwh)),
      el('td', {class: 'num', text: x.valor == null ? '—' : brl.format(x.valor)})));
  } catch (e) {
    $('fichaGraf').replaceChildren(el('p', {class: 'nota', text: 'Não foi possível carregar a ficha: ' + e.message}));
    for (const id of ['fichaEst', 'fichaMapa', 'fichaLinha']) $(id).replaceChildren();
  }
}

/* ============================== exportação ============================== */
function baixarCsv(linhas, nome) {
  const num = v => typeof v === 'number' ? String(Math.round(v * 100) / 100).replace('.', ',') : v;
  const s = '\ufeff' + linhas.map(l => l.map(x => '"' + String(num(x) ?? '').replace(/"/g, '""') + '"').join(';')).join('\r\n');
  const a = el('a', {href: URL.createObjectURL(new Blob([s], {type: 'text/csv;charset=utf-8'})), download: nome});
  document.body.append(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 3000);
}
const semanaArq = () => S.dados.semanas[S.wi];

/* ============================== importação manual ============================== */
function csv(texto) {
  texto = texto.replace(/^\ufeff/, '');
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
const valorTotal = l => { const c = ['Valor Total', 'Valor total', 'Valor'].find(k => k in l); return c ? Math.round(numero(String(l[c] || '').replace(/[^0-9,.\-]/g, '')) * 100) / 100 : null; };
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
          kwh: Math.round(numero(l['Energia em kWh']) * 1000) / 1000, origem: 'upload',
          estacao_nome: primeiro(l, ['Estação', 'Nome da estação']) || null, plug: primeiro(l, ['Plug', 'Conector']) || null, valor: valorTotal(l)});
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
  $('filtroSemana').classList.toggle('hidden', aba === 'estacoes' || aba === 'falhas');
  mostrarFiltroAtivo();
  dica(null);
  if (aba === 'resumo') renderResumo();
  if (aba === 'estacoes') carregarEstacoes();
  if (aba === 'falhas') carregarFalhas();
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
  saveSession(null); S.dados = null; S.linhas = []; S.sync = []; S.wi = -1; S.estacao = '';
  S.cacheDados.clear(); S.est.cache.clear(); S.fal.cache.clear(); S.est.dados = null; S.fal.dados = null;
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
$('estacao').addEventListener('change', e => trocarEstacao(e.target.value));
$('filtrarPorEst').addEventListener('click', () => { if (S.est.sel) { trocarEstacao(S.est.sel); irPara('resumo'); window.scrollTo({top: 0, behavior: 'smooth'}); } });
for (const th of $('tabEst').tHead.rows[0].cells) {
  th.querySelector('button').addEventListener('click', () => {
    const c = th.dataset.ord;
    S.est.ordem = S.est.ordem.campo === c ? {campo: c, dir: -S.est.ordem.dir} : {campo: c, dir: c === 'cod' ? 1 : -1};
    if (S.est.dados) renderTabelaEst();
  });
}
$('exportEst').addEventListener('click', () => {
  const l = S._estOrdenadas || [];
  if (!l.length) return;
  const per = PERIODOS[S.est.periodo][0];
  baixarCsv([['Estação', 'Nome', 'Clientes únicos', 'Só usam esta', 'Também usam outras', 'Recargas', 'kWh', 'Tentativas frustradas', '% frustradas', 'Primeira recarga', 'Última recarga', 'Período'],
    ...l.map(x => [x.cod, x.nome || '', x.clientes, x.exclusivos, x.clientes - x.exclusivos, x.recargas, x.kwh, x.frustradas, Math.round(x.taxa * 1000) / 10, dataBR(x.primeira), dataBR(x.ultima), per])],
  `estacoes_${S.est.periodo}.csv`);
});
$('limiarFal').addEventListener('change', e => { S.fal.limiar = +e.target.value; S.fal.limite = 50; renderFalhas(); });
$('buscaFal').addEventListener('input', e => { S.fal.busca = e.target.value; S.fal.limite = 50; renderFalhas(); });
$('soMktFal').addEventListener('change', e => { S.fal.soMkt = e.target.checked; S.fal.limite = 50; renderFalhas(); });
$('maisFal').addEventListener('click', () => { S.fal.limite += 50; renderFalhas(); });
$('exportFal').addEventListener('click', () => {
  const l = filtrarFalhas(), L = S.fal.limiar;
  if (!l.length) return;
  baixarCsv([['Nome', 'E-mail', 'Situação', 'Maior sequência seguida', 'Início da maior sequência', 'Fim da maior sequência', 'Estações da maior sequência',
      'Frustradas depois da última recarga com sucesso', 'Tentativas frustradas no período', 'Última recarga com sucesso', 'Recargas com sucesso (total)', 'Aceita e-mail', 'Período', 'Estação filtrada'],
    ...l.map(x => [x.nome, x.email, situacaoFalha(x, L).rot, x.maior.n, x.maior.ini ? x.maior.ini.replace('T', ' ') : '', x.maior.fim ? x.maior.fim.replace('T', ' ') : '', x.maior.est,
      x.atual.n, x.fr, x.ultimoOk ? dataBR(x.ultimoOk.slice(0, 10)) : 'nunca', x.nOk, x.mkt ? 'Sim' : 'Não informado', PERIODOS[S.fal.periodo][0], S.estacao || 'todas'])],
  `tentativas_frustradas_${S.fal.periodo}${S.estacao ? '_' + S.estacao : ''}.csv`);
});
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
let _rs; window.addEventListener('resize', () => { clearTimeout(_rs); _rs = setTimeout(() => {
  if (S.aba === 'resumo') renderResumo();
  if (S.aba === 'falhas' && S.fal.dados) renderFalhas();
  if ($('ficha').open && S._fichaAtual) linhaTempo($('fichaLinha'), S._fichaAtual.recs, S._fichaAtual.est);
}, 150); });

(async function iniciar() {
  try { session = JSON.parse(store.get('zon_sb_session') || 'null'); } catch (e) { session = null; }
  if (!sbUrl() || !sbKey() || !session) { mostrarLogin(''); return; }
  mostrarApp(); await carregar();
})();
