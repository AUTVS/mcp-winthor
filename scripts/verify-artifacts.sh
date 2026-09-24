#!/usr/bin/env bash
#
# Valida que o app empacotado não carrega informação sensível.
#
# Uso: verify-artifacts.sh <dir-do-release> [caminho-do-asar-cli]
#
# Inspeciona os diretórios *-unpacked gerados pelo electron-builder:
#   - resources/server/**  (código do servidor + assets, fora do asar)
#   - resources/app.asar   (código do processo Electron)
#
# Falha (exit 1) ao encontrar source maps, declarações de tipo, fontes .ts,
# arquivos de credencial (.env, data/config.json) ou endereços de rede privada.
# node_modules de terceiros fica fora da varredura de conteúdo — só a checagem
# de source maps se aplica a ele, pois é o que permite reconstruir código.
#
# Nota: nenhum pipe termina em `head`. Sob `set -o pipefail`, o SIGPIPE que o
# head provoca no produtor derruba o script; `sed -n '1,Np'` lê até o fim.

set -euo pipefail

RELEASE_DIR="${1:-}"
ASAR_CLI="${2:-}"

if [[ -z "$RELEASE_DIR" || ! -d "$RELEASE_DIR" ]]; then
  echo "Uso: $0 <dir-do-release> [asar-cli]" >&2
  exit 2
fi

FAILURES=0

# Imprime as primeiras linhas de uma lista, indentadas, em stderr.
sample() {
  printf '%s\n' "$1" | sed -n '1,5s/^/      /p' >&2
}

count_lines() {
  [[ -z "$1" ]] && { echo 0; return; }
  printf '%s\n' "$1" | grep -c . || true
}

fail() {
  echo "  ✗ $1" >&2
  FAILURES=$((FAILURES + 1))
}

ok() {
  echo "  ✓ $1"
}

# Diretórios de app empacotado: linux-unpacked, win-unpacked e
# mac-*/wt.ai.app/Contents/Resources (maiúsculo, daí o -iname).
# Sem mapfile: o bash 3.2 do macOS não tem.
RESOURCE_DIRS=()
while IFS= read -r dir; do
  RESOURCE_DIRS+=("$dir")
done < <(find "$RELEASE_DIR" -maxdepth 4 -type d -iname resources 2>/dev/null | sort)

if [[ ${#RESOURCE_DIRS[@]} -eq 0 ]]; then
  cat >&2 <<EOF
Nenhum app desempacotado em $RELEASE_DIR — nada a inspecionar.

Esta validação lê os diretórios *-unpacked / .app, que só existem no host após um
build nativo (./build-installer.sh --mac). Nos alvos Windows e Linux ela roda
dentro da imagem, antes da exportação: o build falha se algo sensível vazar.
EOF
  exit 2
fi

for resources in "${RESOURCE_DIRS[@]}"; do
  echo "==> ${resources#"$RELEASE_DIR"/}"

  # 1. Source maps: reconstroem estrutura e nomes do código original.
  maps=$(find "$resources" -name '*.map' 2>/dev/null || true)
  n=$(count_lines "$maps")
  if [[ "$n" -gt 0 ]]; then
    fail "$n source map(s) empacotados:"
    sample "$maps"
  else
    ok "nenhum source map"
  fi

  # 2. Declarações e fontes TypeScript do nosso código.
  if [[ -d "$resources/server/dist" ]]; then
    types=$(find "$resources/server/dist" \
      \( -name '*.d.ts' -o -name '*.ts' -o -name '*.tsbuildinfo' \) 2>/dev/null || true)
    n=$(count_lines "$types")
    if [[ "$n" -gt 0 ]]; then
      fail "$n arquivo(s) .d.ts/.ts/.tsbuildinfo em server/dist:"
      sample "$types"
    else
      ok "server/dist sem declarações ou fontes TypeScript"
    fi
  fi

  # 3. Arquivos de credencial e estado local.
  #    vendas.db é a base local de vendas: não é credencial, mas é dado de
  #    cliente (pedidos, nomes, valores) e não pode viajar dentro do instalador.
  #    Os sufixos -wal e -shm carregam páginas ainda não integradas ao .db.
  leaks=$(find "$resources" \
    \( -name '.env' -o -name '.env.*' -o -path '*/data/config.json' \
       -o -name 'vendas.db' -o -name 'vendas.db-*' \) 2>/dev/null || true)
  if [[ -n "$leaks" ]]; then
    fail "arquivo(s) de credencial ou dado de cliente empacotados:"
    sample "$leaks"
  else
    ok "sem .env, data/config.json ou vendas.db"
  fi

  # 4. Endereços de rede privada (RFC 1918) no nosso código e nas views.
  #    127.0.0.1 é legítimo (bind local) e não casa com os padrões abaixo.
  scan_paths=()
  for p in "$resources/server/dist" "$resources/server/views" "$resources/server/public"; do
    [[ -d "$p" ]] && scan_paths+=("$p")
  done
  if [[ ${#scan_paths[@]} -gt 0 ]]; then
    hits=$(grep -rEoh '\b(10\.[0-9]{1,3}|192\.168|172\.(1[6-9]|2[0-9]|3[01]))\.[0-9]{1,3}\.[0-9]{1,3}\b' \
      "${scan_paths[@]}" 2>/dev/null | sort -u || true)
    if [[ -n "$hits" ]]; then
      fail "endereço(s) de rede privada no código empacotado:"
      sample "$hits"
    else
      ok "sem endereços de rede privada"
    fi
  fi

  # 5. Conteúdo do asar (código do processo Electron).
  asar_file="$resources/app.asar"
  if [[ -f "$asar_file" ]]; then
    if [[ -n "$ASAR_CLI" && -f "$ASAR_CLI" ]]; then
      listing=$(node "$ASAR_CLI" list "$asar_file")
      asar_maps=$(printf '%s\n' "$listing" | grep -E '\.map$' || true)
      if [[ -n "$asar_maps" ]]; then
        fail "source map dentro do app.asar:"
        sample "$asar_maps"
      else
        ok "app.asar sem source maps"
      fi
      asar_secrets=$(printf '%s\n' "$listing" | grep -E '\.(env|d\.ts)$|/data/config\.json$' || true)
      if [[ -n "$asar_secrets" ]]; then
        fail "arquivo sensível dentro do app.asar:"
        sample "$asar_secrets"
      else
        ok "app.asar sem credenciais ou declarações"
      fi
    else
      echo "  ! asar CLI indisponível — conteúdo do app.asar não inspecionado" >&2
    fi
  fi
done

echo
if [[ "$FAILURES" -eq 0 ]]; then
  echo "Validação OK: nenhum dado sensível encontrado nos artefatos."
  exit 0
fi

echo "Validação FALHOU: $FAILURES problema(s)." >&2
exit 1
