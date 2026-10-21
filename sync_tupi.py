#!/usr/bin/env python3
"""
ZON Charge · Sincronização semanal Tupi → Supabase
=================================================

O que faz, em cada execução:
  1. Faz login na Tupi (mesmo login do painel cpms.tupimob.com) e gera o
     Bearer token automaticamente. Não é mais preciso copiar o token do navegador.
  2. Pede à Tupi o histórico de recargas das estações CPZON00 a CPZON200
     (as que não existirem são ignoradas).
  3. Grava as recargas no Supabase sem duplicar (chave: estação + conector + início + e-mail).

Roda toda segunda-feira e, por padrão, baixa os últimos 8 dias completos (a semana
de segunda a domingo + o domingo anterior). O dia repetido garante que recargas
que estavam em andamento na virada da semana entrem completas.

Variáveis de ambiente (no GitHub Actions ficam em Settings > Secrets):
  TUPI_EMAIL, TUPI_SENHA           login da Tupi (de preferência um usuário técnico)
  SUPABASE_URL                     ex.: https://abcd1234.supabase.co
  SUPABASE_SERVICE_ROLE_KEY        chave service_role do Supabase (secreta)
Opcionais:
  ESTACAO_PREFIXO=CPZON  ESTACAO_INICIO=0  ESTACAO_FIM=200  ESTACAO_DIGITOS=2
  JANELA_DIAS=8                    quantos dias para trás baixar por padrão
  TUPI_BEARER_TOKEN                usa um token fixo em vez de fazer login (testes)
  TUPI_FIREBASE_API_KEY            força a chave pública do Firebase da Tupi

Exemplos:
  python sync_tupi.py                                   # rotina semanal (últimos 8 dias)
  python sync_tupi.py --inicio 2026-01-01 --fim 2026-10-14   # carga histórica
  python sync_tupi.py --somente-baixar --inicio 2026-10-01 --fim 2026-10-07
  python sync_tupi.py --testar-login
"""
from __future__ import annotations

import argparse
import base64
import csv
import io
import json
import logging
import math
import os
import re
import sys
import time
from datetime import date, datetime, time as dtime, timedelta, timezone
from pathlib import Path
from urllib.parse import urlparse
from zoneinfo import ZoneInfo

import requests

TZ = ZoneInfo("America/Sao_Paulo")
CPMS_CONFIG_URL = "https://cpms.tupimob.com/config.js"
CPMS_API = "https://tupi-cpms-api.tupinrg.app/api/v1"
FIREBASE_LOGIN_URL = "https://identitytoolkit.googleapis.com/v1/accounts:signInWithPassword"
PASTA_DADOS = Path(__file__).resolve().parent / "dados"

# Colunas do CSV da Tupi (as mesmas que o painel HTML já usa)
COL_EMAIL = "E-mail"
COL_INICIO = "Início (Horário Local)"
COL_FIM = "Fim (Horário Local)"
COL_KWH = "Energia em kWh"
COLS_NOME = ("Usuário", "Nome")
# No relatório da Tupi a coluna "ID" é o código da estação (CPZON01…), não o da recarga.
COLS_ESTACAO = ("ID", "Id", "Código da estação", "Station ID", "Estação")
COLS_CONECTOR = ("Conector", "ID do conector", "Id do conector", "Connector", "Connector ID", "Porta")
# Campos extras (outubro/2026). Atenção: NÃO entram na chave da recarga — mudar a chave duplicaria o histórico.
COLS_NOME_ESTACAO = ("Estação", "Nome da estação", "Station")
COLS_PLUG = ("Plug", "Conector", "Connector")
COLS_VALOR = ("Valor Total", "Valor total", "Valor")
CAMPOS_NOVOS = ("estacao_nome", "plug", "valor")

log = logging.getLogger("sync_tupi")


class ErroSync(RuntimeError):
    """Erro com mensagem já explicada para quem vai ler o log."""


# =============================================================================
# Utilidades
# =============================================================================
def env(nome: str, padrao: str | None = None, obrigatorio: bool = False) -> str | None:
    valor = os.getenv(nome, "").strip() or padrao
    if obrigatorio and not valor:
        raise ErroSync(f"Variável de ambiente {nome} não definida.")
    return valor


def iso_z(dt: datetime) -> str:
    dt = dt.astimezone(timezone.utc)
    return dt.strftime("%Y-%m-%dT%H:%M:%S.") + f"{dt.microsecond // 1000:03d}Z"


def limites_utc(inicio: date, fim: date) -> tuple[datetime, datetime]:
    """Do início do dia `inicio` ao fim do dia `fim`, no horário de Brasília, em UTC."""
    a = datetime.combine(inicio, dtime.min, TZ)
    b = datetime.combine(fim + timedelta(days=1), dtime.min, TZ) - timedelta(milliseconds=1)
    return a.astimezone(timezone.utc), b.astimezone(timezone.utc)


def lotes_de_datas(inicio: date, fim: date, dias_por_lote: int):
    atual = inicio
    while atual <= fim:
        ate = min(fim, atual + timedelta(days=dias_por_lote - 1))
        yield atual, ate
        atual = ate + timedelta(days=1)


def gerar_ids_estacoes(prefixo: str, primeiro: int, ultimo: int, digitos: int) -> list[str]:
    return [f"{prefixo}{n:0{digitos}d}" for n in range(primeiro, ultimo + 1)]


# =============================================================================
# Login automático na Tupi (Firebase Authentication)
# =============================================================================
def chave_publica_firebase(sessao: requests.Session) -> str:
    """Lê a chave pública do Firebase no próprio site da Tupi (é a mesma que o
    navegador usa). Assim, se a Tupi trocar a chave, o script acompanha."""
    fixa = env("TUPI_FIREBASE_API_KEY")
    if fixa:
        return fixa
    r = sessao.get(CPMS_CONFIG_URL, timeout=30)
    r.raise_for_status()
    m = re.search(r'"?VITE_FIREBASE_CONFIG"?\s*:\s*"([^"]+)"', r.text)
    if not m:
        raise ErroSync("Não encontrei a configuração de login em cpms.tupimob.com/config.js. "
                       "Defina TUPI_FIREBASE_API_KEY manualmente.")
    bruto = m.group(1)
    try:
        cfg = json.loads(base64.b64decode(bruto + "=" * (-len(bruto) % 4)))
    except Exception:
        cfg = json.loads(bruto.encode().decode("unicode_escape"))
    return cfg["apiKey"]


def login_tupi(sessao: requests.Session, email: str, senha: str) -> str:
    chave = chave_publica_firebase(sessao)
    r = sessao.post(FIREBASE_LOGIN_URL, params={"key": chave},
                    json={"email": email, "password": senha, "returnSecureToken": True},
                    timeout=30)
    try:
        dados = r.json()
    except ValueError:
        dados = {}
    if r.status_code != 200:
        msg = str(dados.get("error", {}).get("message", r.text[:200]))
        explicacoes = {
            "INVALID_LOGIN_CREDENTIALS": "e-mail ou senha incorretos",
            "INVALID_PASSWORD": "senha incorreta",
            "EMAIL_NOT_FOUND": "e-mail não cadastrado na Tupi",
            "USER_DISABLED": "usuário desativado na Tupi",
            "TOO_MANY_ATTEMPTS": "muitas tentativas; a Tupi bloqueou temporariamente",
            "referer": "a chave do Firebase da Tupi só aceita chamadas do navegador; "
                       "peça à Tupi um acesso de API (ex.: token OCPI) para integração",
        }
        motivo = next((v for k, v in explicacoes.items() if k.lower() in msg.lower()), msg)
        raise ErroSync(f"Falha no login da Tupi: {motivo}.")
    if "mfaPendingCredential" in dados:
        raise ErroSync("O usuário da Tupi tem verificação em duas etapas. "
                       "Use um usuário técnico sem 2FA para a rotina automática.")
    return dados["idToken"]


class ClienteTupi:
    def __init__(self, email: str | None, senha: str | None, token_fixo: str | None = None):
        self.email, self.senha, self.token_fixo = email, senha, token_fixo
        self.s = requests.Session()
        self.s.headers["User-Agent"] = "ZONCharge-Sync/1.0"
        self._token: str | None = None
        self._token_em = 0.0
        self.estacoes_ignoradas: list[str] = []

    def autenticar(self, forcar: bool = False) -> None:
        if self.token_fixo:
            self._token = self.token_fixo
        elif forcar or not self._token or time.time() - self._token_em > 50 * 60:
            if not (self.email and self.senha):
                raise ErroSync("Defina TUPI_EMAIL e TUPI_SENHA (ou TUPI_BEARER_TOKEN).")
            log.info("Fazendo login na Tupi como %s…", self.email)
            self._token = login_tupi(self.s, self.email, self.senha)
            self._token_em = time.time()
        self.s.headers["Authorization"] = f"Bearer {self._token}"

    def req(self, metodo: str, url: str, **kw) -> requests.Response:
        self.autenticar()
        kw.setdefault("timeout", 90)
        r = self.s.request(metodo, url, **kw)
        if r.status_code == 401 and not self.token_fixo:
            log.info("Token expirado; renovando…")
            self.autenticar(forcar=True)
            r = self.s.request(metodo, url, **kw)
        return r

    # ---- download do histórico (mesmo fluxo do script original) ----
    def baixar_csv(self, station_ids: list[str], inicio: datetime, fim: datetime,
                   espera_max: int = 600, intervalo: int = 3) -> bytes:
        payload = {"station_ids": station_ids, "startAt": iso_z(inicio), "endAt": iso_z(fim)}
        r = self.req("POST", f"{CPMS_API}/charges/chargerHistory", json=payload,
                     params={"page": 1, "perPage": 10, "download": "true"})
        if r.status_code >= 400:
            raise requests.HTTPError(f"HTTP {r.status_code}: {r.text[:300]}", response=r)
        if "text/csv" in r.headers.get("Content-Type", ""):
            return r.content
        job = r.json()
        job_id = job.get("id") if isinstance(job, dict) else None
        if not job_id:
            raise ErroSync(f"Resposta inesperada da Tupi ao pedir o relatório: {str(job)[:300]}")

        limite = time.time() + espera_max
        info = None
        while time.time() < limite:
            st = self.req("GET", f"{CPMS_API}/download/active")
            st.raise_for_status()
            lista = st.json()
            itens = lista if isinstance(lista, list) else [lista]
            info = next((i for i in itens if isinstance(i, dict) and i.get("id") == job_id), None)
            status = (info or {}).get("status")
            if status == "completed":
                break
            if status in ("failed", "expired"):
                raise ErroSync(f"A Tupi não gerou o relatório: {info.get('error_message', 'erro desconhecido')}")
            time.sleep(intervalo)
        else:
            raise ErroSync(f"A Tupi não terminou o relatório em {espera_max}s.")

        url = info.get("url")
        if not url:
            raise ErroSync("Relatório concluído, mas a Tupi não informou o link do arquivo.")
        # Link em outro domínio (ex.: S3 assinado) é baixado sem enviar o token da Tupi.
        mesmo_host = urlparse(url).netloc == urlparse(CPMS_API).netloc
        arq = self.req("GET", url) if mesmo_host else requests.get(url, timeout=120)
        if arq.status_code in (400, 401, 403):
            arq = requests.get(url, timeout=120) if mesmo_host else self.req("GET", url)
        arq.raise_for_status()
        return arq.content

    def baixar_com_divisao(self, ids: list[str], inicio: datetime, fim: datetime) -> list[bytes]:
        """Tenta todas as estações de uma vez. Se a Tupi recusar (ex.: código
        inexistente), divide a lista ao meio até isolar e pular as inválidas."""
        try:
            return [self.baixar_csv(ids, inicio, fim)]
        except requests.HTTPError as e:
            codigo = e.response.status_code if e.response is not None else 0
            if not (400 <= codigo < 500) or codigo == 401:
                raise
            if len(ids) == 1:
                self.estacoes_ignoradas.append(ids[0])
                return []
            meio = len(ids) // 2
            log.debug("Tupi recusou %d estações juntas (HTTP %s); dividindo o pedido.", len(ids), codigo)
            return (self.baixar_com_divisao(ids[:meio], inicio, fim)
                    + self.baixar_com_divisao(ids[meio:], inicio, fim))


# =============================================================================
# Leitura e normalização do CSV (mesmas regras do painel HTML)
# =============================================================================
def decodificar(conteudo: bytes) -> str:
    if conteudo[:2] == b"PK":
        raise ErroSync("A Tupi devolveu uma planilha Excel em vez de CSV.")
    for codificacao in ("utf-8-sig", "cp1252", "latin-1"):
        try:
            return conteudo.decode(codificacao)
        except UnicodeDecodeError:
            continue
    return conteudo.decode("utf-8", errors="replace")


def ler_csv(texto: str) -> list[dict[str, str]]:
    texto = texto.lstrip("﻿")
    primeira = texto.split("\n", 1)[0]
    sep = ";" if primeira.count(";") > primeira.count(",") else ","
    linhas = []
    for row in csv.DictReader(io.StringIO(texto, newline=""), delimiter=sep):
        limpa = {(k or "").strip(): (v or "").strip() for k, v in row.items()
                 if k is not None and isinstance(v, str)}
        if any(limpa.values()):
            linhas.append(limpa)
    return linhas


def parse_data(valor: str) -> str | None:
    v = (valor or "").strip()
    m = re.match(r"^(\d{2})/(\d{2})/(\d{4})", v)
    if m:
        return f"{m[3]}-{m[2]}-{m[1]}"
    m = re.match(r"^(\d{4})-(\d{2})-(\d{2})", v)
    return f"{m[1]}-{m[2]}-{m[3]}" if m else None


def parse_data_hora(valor: str) -> str | None:
    v = (valor or "").strip()
    m = re.match(r"^(\d{2})/(\d{2})/(\d{4})[ T,]+(\d{1,2}):(\d{2})(?::(\d{2}))?", v)
    if m:
        return f"{m[3]}-{m[2]}-{m[1]}T{int(m[4]):02d}:{m[5]}:{m[6] or '00'}"
    m = re.match(r"^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})(?::(\d{2}))?", v)
    if m:
        return f"{m[1]}-{m[2]}-{m[3]}T{m[4]}:{m[5]}:{m[6] or '00'}"
    return None


def numero(valor) -> float:
    v = str(valor if valor is not None else "0").strip()
    if "," in v:
        v = v.replace(".", "").replace(",", ".")
    try:
        n = float(v) if v else 0.0
    except ValueError:
        return 0.0
    return n if math.isfinite(n) else 0.0


def dinheiro(l: dict[str, str], colunas) -> float | None:
    """Valor em reais ("R$ 1.234,56", "12,30", "0") -> número. None se a coluna não existe no relatório."""
    col = next((c for c in colunas if c in l), None)
    if col is None:
        return None
    return round(numero(re.sub(r"[^0-9,.\-]", "", l.get(col) or "")), 2)


def primeiro(l: dict[str, str], colunas) -> str:
    return next((l[c].strip() for c in colunas if l.get(c) and l[c].strip()), "")


def chave_recarga(l: dict[str, str], email: str) -> str:
    """Identificador estável de uma recarga: estação + conector + início + e-mail.
    Um mesmo conector não inicia duas recargas no mesmo segundo, então a chave é única
    e não muda quando a mesma recarga é baixada de novo."""
    inicio = parse_data_hora(l.get(COL_INICIO, "")) or l.get(COL_INICIO, "").strip()
    return "|".join([primeiro(l, COLS_ESTACAO).upper(), primeiro(l, COLS_CONECTOR), inicio, email])


def normalizar(linhas: list[dict[str, str]], hoje: date, origem: str = "sync"):
    """Devolve (recargas, clientes, ignoradas)."""
    if linhas and (COL_EMAIL not in linhas[0] or COL_INICIO not in linhas[0]):
        raise ErroSync("O CSV da Tupi não tem as colunas esperadas "
                       f"('{COL_EMAIL}', '{COL_INICIO}'). Colunas recebidas: {list(linhas[0])}")
    recargas: dict[str, dict] = {}
    clientes: dict[str, dict] = {}
    ignoradas = 0
    ontem = (hoje - timedelta(days=1)).isoformat()
    for l in linhas:
        email = l.get(COL_EMAIL, "").strip().lower()
        dia = parse_data(l.get(COL_INICIO, ""))
        if not dia:
            ignoradas += 1
            continue
        fim_txt = l.get(COL_FIM, "")
        if COL_FIM in l and not fim_txt and dia >= ontem:
            ignoradas += 1  # recarga ainda em andamento: entra completa na próxima execução
            continue
        rid = chave_recarga(l, email)
        nome = primeiro(l, COLS_NOME)
        recargas[rid] = {
            "id": rid,
            "email": email or None,
            "nome": nome or None,
            "estacao": primeiro(l, COLS_ESTACAO).upper() or None,
            "inicio": parse_data_hora(l.get(COL_INICIO, "")),
            "fim": parse_data_hora(fim_txt),
            "data": dia,
            "kwh": round(numero(l.get(COL_KWH)), 3),
            "origem": origem,
            "estacao_nome": primeiro(l, COLS_NOME_ESTACAO) or None,
            "plug": primeiro(l, COLS_PLUG) or None,
            "valor": dinheiro(l, COLS_VALOR),
        }
        if email and email not in clientes:
            clientes[email] = {"email": email, "nome": nome or None, "origem": "recarga"}
    validas = len(linhas) - ignoradas
    if validas >= 20 and len(recargas) < 0.9 * validas:
        raise ErroSync(f"Só {len(recargas)} de {validas} recargas tiveram identificador único. "
                       "O formato do relatório da Tupi deve ter mudado; nada foi gravado.")
    return list(recargas.values()), list(clientes.values()), ignoradas


# =============================================================================
# Supabase (API REST, sem dependências extras)
# =============================================================================
class Supabase:
    def __init__(self, url: str, chave: str):
        self.url = url.rstrip("/")
        self.s = requests.Session()
        self.s.headers.update({"apikey": chave, "Content-Type": "application/json"})
        if chave.startswith("eyJ"):  # chave antiga (JWT service_role); as novas sb_secret_ vão só no apikey
            self.s.headers["Authorization"] = f"Bearer {chave}"

    def _ok(self, r: requests.Response, acao: str) -> requests.Response:
        if r.status_code >= 300:
            raise ErroSync(f"Supabase recusou {acao}: HTTP {r.status_code} {r.text[:300]}")
        return r

    def upsert(self, tabela: str, linhas: list[dict], conflito: str,
               ignorar_existentes: bool = False, lote: int = 500) -> None:
        modo = "ignore" if ignorar_existentes else "merge"
        for i in range(0, len(linhas), lote):
            r = self.s.post(f"{self.url}/rest/v1/{tabela}", params={"on_conflict": conflito},
                            headers={"Prefer": f"resolution={modo}-duplicates,return=minimal"},
                            data=json.dumps(linhas[i:i + lote], default=str), timeout=120)
            self._ok(r, f"gravar em {tabela}")

    def manter_ativo(self) -> None:
        """Consulta leve para o plano gratuito do Supabase não pausar o projeto."""
        r = self.s.get(f"{self.url}/rest/v1/sync_log", params={"select": "id", "limit": "1"}, timeout=30)
        self._ok(r, "responder à verificação")

    def novo_log(self, dados: dict) -> int | None:
        r = self.s.post(f"{self.url}/rest/v1/sync_log", headers={"Prefer": "return=representation"},
                        data=json.dumps(dados, default=str), timeout=30)
        return self._ok(r, "abrir o registro de sincronização").json()[0]["id"]

    def atualizar_log(self, log_id: int | None, dados: dict) -> None:
        if log_id is None:
            return
        r = self.s.patch(f"{self.url}/rest/v1/sync_log", params={"id": f"eq.{log_id}"},
                         data=json.dumps(dados, default=str), timeout=30)
        self._ok(r, "fechar o registro de sincronização")


# =============================================================================
# Execução
# =============================================================================
def argumentos(argv=None):
    p = argparse.ArgumentParser(description="Sincroniza o histórico de recargas da Tupi com o Supabase.")
    p.add_argument("--inicio", help="data inicial AAAA-MM-DD (padrão: hoje - JANELA_DIAS)")
    p.add_argument("--fim", help="data final AAAA-MM-DD (padrão: ontem)")
    p.add_argument("--estacoes", help="lista separada por vírgula (padrão: CPZON00 a CPZON200)")
    p.add_argument("--dias-por-lote", type=int, default=31, help="tamanho de cada pedido à Tupi em dias")
    p.add_argument("--somente-baixar", action="store_true", help="só salva os CSVs em ./dados, sem gravar no Supabase")
    p.add_argument("--testar-login", action="store_true", help="só testa o login na Tupi")
    p.add_argument("--manter-ativo", action="store_true",
                   help="só faz uma consulta leve no Supabase (evita a pausa do plano gratuito)")
    return p.parse_args(argv)


def main(argv=None) -> int:
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s",
                        datefmt="%d/%m %H:%M:%S")
    a = argumentos(argv)
    hoje = datetime.now(TZ).date()
    try:
        janela = int(env("JANELA_DIAS", "8"))
        inicio = date.fromisoformat(a.inicio) if a.inicio else hoje - timedelta(days=janela)
        fim = date.fromisoformat(a.fim) if a.fim else hoje - timedelta(days=1)
    except ValueError as e:
        log.error("Data inválida (use AAAA-MM-DD): %s", e)
        return 2
    if fim < inicio:
        log.error("A data final (%s) é anterior à inicial (%s).", fim, inicio)
        return 2

    if a.manter_ativo:
        try:
            Supabase(env("SUPABASE_URL", obrigatorio=True),
                     env("SUPABASE_SERVICE_ROLE_KEY", obrigatorio=True)).manter_ativo()
            log.info("Supabase respondeu; projeto mantido ativo.")
            return 0
        except (ErroSync, requests.RequestException) as e:
            log.error("%s", e)
            return 1

    tupi = ClienteTupi(env("TUPI_EMAIL"), env("TUPI_SENHA"), env("TUPI_BEARER_TOKEN"))
    if a.testar_login:
        try:
            tupi.autenticar(forcar=True)
            log.info("Login na Tupi OK.")
            return 0
        except (ErroSync, requests.RequestException) as e:
            log.error("%s", e)
            return 1

    if a.estacoes:
        estacoes = [x.strip() for x in re.split(r"[,\s]+", a.estacoes) if x.strip()]
    else:
        estacoes = gerar_ids_estacoes(env("ESTACAO_PREFIXO", "CPZON"), int(env("ESTACAO_INICIO", "0")),
                                      int(env("ESTACAO_FIM", "200")), int(env("ESTACAO_DIGITOS", "2")))

    sb = None
    log_id = None
    if not a.somente_baixar:
        try:
            sb = Supabase(env("SUPABASE_URL", obrigatorio=True), env("SUPABASE_SERVICE_ROLE_KEY", obrigatorio=True))
            log_id = sb.novo_log({"janela_inicio": inicio, "janela_fim": fim, "estacoes": len(estacoes)})
        except (ErroSync, requests.RequestException) as e:
            log.error("Não consegui conectar ao Supabase: %s", e)
            return 1

    log.info("Janela: %s a %s · %d estações (%s … %s)", inicio.strftime("%d/%m/%Y"),
             fim.strftime("%d/%m/%Y"), len(estacoes), estacoes[0], estacoes[-1])
    try:
        PASTA_DADOS.mkdir(exist_ok=True)
        linhas: list[dict[str, str]] = []
        colunas: list[str] = []
        for de, ate in lotes_de_datas(inicio, fim, max(1, a.dias_por_lote)):
            ini_utc, fim_utc = limites_utc(de, ate)
            log.info("Pedindo histórico de %s a %s…", de.strftime("%d/%m/%Y"), ate.strftime("%d/%m/%Y"))
            arquivos = tupi.baixar_com_divisao(estacoes, ini_utc, fim_utc)
            if not arquivos:
                raise ErroSync("Nenhuma estação retornou dados. Confira os códigos e as permissões do usuário.")
            for n, conteudo in enumerate(arquivos, 1):
                destino = PASTA_DADOS / f"historico_{de:%Y%m%d}_{ate:%Y%m%d}_{n}.csv"
                destino.write_bytes(conteudo)
                novas = ler_csv(decodificar(conteudo))
                log.info("  %s: %d linhas", destino.name, len(novas))
                if novas and not colunas:
                    colunas = list(novas[0])
                    log.info("  Colunas do relatório: %s", ", ".join(colunas))
                linhas += novas

        if tupi.estacoes_ignoradas:
            ign = sorted(set(tupi.estacoes_ignoradas))
            log.info("%d códigos recusados pela Tupi (provavelmente ainda não existem): %s",
                     len(ign), ", ".join(ign[:5]) + (" …" if len(ign) > 5 else ""))

        recargas, clientes, ignoradas = normalizar(linhas, hoje)
        log.info("%d linhas lidas · %d recargas válidas · %d ignoradas", len(linhas), len(recargas), ignoradas)

        if sb:
            try:
                sb.upsert("recargas", recargas, "id")
            except ErroSync as e:
                # Banco ainda sem as colunas novas (schema.sql não foi rodado): grava sem elas.
                if not any(c in str(e) for c in CAMPOS_NOVOS):
                    raise
                log.warning("O banco ainda não tem as colunas %s. Rode o supabase/schema.sql atualizado. "
                            "Gravando sem elas por enquanto.", ", ".join(CAMPOS_NOVOS))
                sb.upsert("recargas", [{k: v for k, v in r.items() if k not in CAMPOS_NOVOS} for r in recargas], "id")
            sb.upsert("clientes", clientes, "email", ignorar_existentes=True)
            sb.atualizar_log(log_id, {"status": "ok", "finalizado_em": datetime.now(timezone.utc),
                                      "linhas_csv": len(linhas), "recargas_gravadas": len(recargas),
                                      "ignoradas": ignoradas,
                                      "mensagem": (f"{len(clientes)} clientes nas recargas · colunas: "
                                                   + ", ".join(colunas))[:1000]})
            log.info("Supabase atualizado.")
        return 0
    except Exception as e:  # registra qualquer falha no log do banco antes de sair
        msg = str(e) if isinstance(e, ErroSync) else f"{type(e).__name__}: {e}"
        log.error("Sincronização falhou: %s", msg)
        if sb:
            try:
                sb.atualizar_log(log_id, {"status": "erro", "finalizado_em": datetime.now(timezone.utc),
                                          "mensagem": msg[:1000]})
            except Exception:
                log.exception("Também não consegui registrar o erro no Supabase.")
        return 1


if __name__ == "__main__":
    sys.exit(main())
