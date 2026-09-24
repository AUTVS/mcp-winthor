#!/usr/bin/env bash
#
# Build dos instaladores do wt.ai.
#
#   Windows (.exe NSIS) e Linux (.AppImage) são construídos dentro da imagem
#   definida no Dockerfile — o código entra por COPY, não por bind mount, e os
#   artefatos só são exportados depois de passarem na validação.
#   macOS (.dmg/.zip) exige build nativo: Docker não empacota nem assina .dmg.
#
# Em todos os caminhos, source maps e declarações de tipo são removidos antes do
# empacotamento e scripts/verify-artifacts.sh confere o resultado.
#
# Artefatos saem em desktop/release/.

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
RELEASE_DIR="$ROOT_DIR/desktop/release"
VERIFY="$ROOT_DIR/scripts/verify-artifacts.sh"
ASAR_CLI="$ROOT_DIR/desktop/node_modules/@electron/asar/bin/asar.js"

BUILD_WIN=false
BUILD_LINUX=false
BUILD_MAC=false
VERIFY_ONLY=false
FRESH=false
CLEAN=false

# Todo build gera um instalador novo, e instalador sem versão própria é
# indistinguível do anterior — no disco do usuário e no suporte. Por isso o
# incremento é o padrão, e não um passo que alguém precisa lembrar de fazer.
BUMP=patch
SET_VERSION=""

usage() {
  cat <<'EOF'
Uso: ./build-installer.sh [opções]

Alvos:
  --win        instalador Windows (NSIS .exe) via Docker
  --linux      AppImage Linux via Docker
  --mac        .dmg/.zip via build nativo (apenas em macOS)
  --all        --win --linux --mac
  (sem alvo)   equivale a --win --linux

Opções:
  --verify     apenas revalida o que já existe em desktop/release/
  --clean      apaga desktop/release/ antes de construir
  --fresh      ignora o cache de camadas do Docker (--no-cache)
  -h, --help   esta ajuda

Versão (incrementada automaticamente antes do build):
  --patch          0.1.0 -> 0.1.1  (padrão)
  --minor          0.1.0 -> 0.2.0
  --major          0.1.0 -> 1.0.0
  --set-version X.Y.Z   define a versão exata
  --no-bump        mantém a versão atual (útil para refazer um build que falhou)

  O número sai de desktop/package.json e é propagado para server/package.json.
  O servidor MCP lê o seu do package.json em runtime, então wt_ping e
  wt_server_info respondem a mesma versão que está no instalador.
  Nada é commitado nem tagueado — o incremento fica no diretório de trabalho.

Variáveis:
  SKIP_ROSETTA_CHECK=1   pula a checagem de Rosetta exigida pelo alvo --win em Apple Silicon

Exemplos:
  ./build-installer.sh                     # Windows + Linux, patch +1
  ./build-installer.sh --win --minor       # só o .exe, minor +1
  ./build-installer.sh --all --clean       # tudo, do zero
  ./build-installer.sh --win --no-bump     # refaz o .exe na mesma versão
  ./build-installer.sh --set-version 1.0.0 # release marcada à mão
EOF
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --win)    BUILD_WIN=true ;;
    --linux)  BUILD_LINUX=true ;;
    --mac)    BUILD_MAC=true ;;
    --all)    BUILD_WIN=true; BUILD_LINUX=true; BUILD_MAC=true ;;
    --verify) VERIFY_ONLY=true ;;
    --clean)  CLEAN=true ;;
    --fresh)  FRESH=true ;;
    --patch)  BUMP=patch ;;
    --minor)  BUMP=minor ;;
    --major)  BUMP=major ;;
    --no-bump) BUMP=none ;;
    --set-version)
      SET_VERSION="${2:-}"
      [[ -n "$SET_VERSION" ]] || { echo "Erro: --set-version exige X.Y.Z" >&2; exit 2; }
      shift ;;
    --set-version=*) SET_VERSION="${1#*=}" ;;
    -h|--help) usage; exit 0 ;;
    *) echo "Opção desconhecida: $1" >&2; echo >&2; usage >&2; exit 2 ;;
  esac
  shift
done

# --verify não constrói nada, então não pode mexer na versão.
if $VERIFY_ONLY; then
  exec bash "$VERIFY" "$RELEASE_DIR" "$ASAR_CLI"
fi

versao_atual() {
  node -p "require('$ROOT_DIR/desktop/package.json').version"
}

# `desktop/package.json` é a fonte: é dele que o electron-builder tira o número
# que vai para o nome do arquivo, o instalador NSIS e o Info.plist. O server é
# alinhado a ele, nunca incrementado por conta própria — dois contadores
# independentes divergiriam no primeiro build que tocasse só um dos lados.
#
# `npm version` em vez de editar o JSON na mão porque ele atualiza também o
# package-lock.json. `npm ci` no Dockerfile tolera a divergência (verificado),
# mas um lock desencontrado é ruído de diff e mentira sobre o que foi publicado.
# `--no-git-tag-version` mantém o build fora do git: commitar e taguear é decisão
# de quem publica, não efeito colateral de compilar.
aplicar_versao() {
  local nova="$1"
  (cd "$ROOT_DIR/desktop" && npm version "$nova" --no-git-tag-version --allow-same-version >/dev/null)
  local efetiva
  efetiva="$(versao_atual)"
  (cd "$ROOT_DIR/server" && npm version "$efetiva" --no-git-tag-version --allow-same-version >/dev/null)
  echo "$efetiva"
}

VERSAO_ANTERIOR="$(versao_atual)"

if [[ -n "$SET_VERSION" ]]; then
  if [[ ! "$SET_VERSION" =~ ^[0-9]+\.[0-9]+\.[0-9]+([-+].+)?$ ]]; then
    echo "Erro: --set-version espera X.Y.Z (recebido: '$SET_VERSION')" >&2
    exit 2
  fi
  VERSAO="$(aplicar_versao "$SET_VERSION")"
  echo "==> Versão fixada em $VERSAO (era $VERSAO_ANTERIOR)"
elif [[ "$BUMP" == "none" ]]; then
  VERSAO="$VERSAO_ANTERIOR"
  # Refazer um build na mesma versão sobrescreve o artefato anterior. É o que se
  # quer ao repetir um build que falhou, e é por isso que não é o padrão.
  echo "==> Versão mantida em $VERSAO (--no-bump)"
else
  VERSAO="$(aplicar_versao "$BUMP")"
  echo "==> Versão $VERSAO_ANTERIOR -> $VERSAO ($BUMP)"
fi

if ! $BUILD_WIN && ! $BUILD_LINUX && ! $BUILD_MAC; then
  BUILD_WIN=true
  BUILD_LINUX=true
fi

need_docker() { $BUILD_WIN || $BUILD_LINUX; }

check_docker() {
  if ! command -v docker >/dev/null 2>&1; then
    echo "Erro: docker não encontrado no PATH. Instale o Docker Desktop." >&2
    exit 1
  fi
  if ! docker compose version >/dev/null 2>&1; then
    echo "Erro: 'docker compose' (v2) não disponível. Atualize o Docker." >&2
    exit 1
  fi
  if ! docker info >/dev/null 2>&1; then
    echo "Erro: o daemon do Docker não está rodando. Abra o Docker Desktop e tente de novo." >&2
    exit 1
  fi
}

# O alvo Windows usa Wine (amd64). Em Apple Silicon sem Rosetta, o Wine roda sob QEMU
# e aborta no rcedit ("anon_mmap_fixed: Assertion failed" / "uncaught target signal 6"),
# já depois de todo o empacotamento. Melhor barrar antes.
check_rosetta() {
  $BUILD_WIN || return 0
  [[ "$(uname -s)" == "Darwin" && "$(uname -m)" == "arm64" ]] || return 0
  [[ "${SKIP_ROSETTA_CHECK:-}" == "1" ]] && return 0

  local settings="$HOME/Library/Group Containers/group.com.docker/settings-store.json"
  if [[ -f "$settings" ]] \
    && grep -qE '"UseVirtualizationFramework"[[:space:]]*:[[:space:]]*true' "$settings" \
    && grep -qE '"UseVirtualizationFrameworkRosetta"[[:space:]]*:[[:space:]]*true' "$settings"; then
    return 0
  fi

  cat >&2 <<'EOF'
Erro: o build Windows precisa de Rosetta neste Mac (Apple Silicon).

  Docker Desktop → Settings → General:
    1. Virtual Machine Options: "Apple Virtualization framework"
    2. marque "Use Rosetta for x86_64/amd64 emulation on Apple Silicon"
    3. Apply & restart

Sem isso o Wine roda sob QEMU e o empacotamento NSIS falha no rcedit.
Alternativas: ./build-installer.sh --linux (não usa Wine) ou build em runner Windows/CI.
Para ignorar esta checagem: SKIP_ROSETTA_CHECK=1 ./build-installer.sh --win
EOF
  exit 1
}

# Source maps e declarações reconstroem o código original — fora do pacote.
# São saída de build, então removê-las do dist local não custa nada.
strip_build_output() {
  local dir="$1"
  [[ -d "$dir" ]] || return 0
  find "$dir" \( -name '*.map' -o -name '*.d.ts' -o -name '*.tsbuildinfo' \) -delete
  find "$dir" -name '*.js' -exec sed -i '' '/^\/\/# sourceMappingURL=/d' {} +
}

if $CLEAN && [[ -d "$RELEASE_DIR" ]]; then
  echo "==> Limpando $RELEASE_DIR"
  rm -rf "$RELEASE_DIR"
fi
mkdir -p "$RELEASE_DIR"

if need_docker; then
  check_docker
  check_rosetta

  TARGETS=""
  $BUILD_WIN && TARGETS="$TARGETS --win"
  $BUILD_LINUX && TARGETS="$TARGETS --linux"

  BUILD_ARGS=()
  $FRESH && BUILD_ARGS+=(--no-cache)

  echo "==> Build e validação na imagem:$TARGETS"
  (cd "$ROOT_DIR" && TARGETS="$TARGETS" docker compose build "${BUILD_ARGS[@]}" installer)

  echo "==> Exportando instaladores para desktop/release/"
  (cd "$ROOT_DIR" && TARGETS="$TARGETS" docker compose run --rm installer)

  # Em hosts Linux os arquivos copiados pelo container saem como root.
  if [[ "$(uname -s)" == "Linux" ]]; then
    (cd "$ROOT_DIR" && docker compose run --rm --entrypoint sh installer \
      -c "chown -R $(id -u):$(id -g) /export")
  fi
fi

if $BUILD_MAC; then
  if [[ "$(uname -s)" != "Darwin" ]]; then
    echo "Erro: --mac exige macOS (o .dmg não pode ser gerado em container)." >&2
    exit 1
  fi

  echo "==> Build nativo macOS: servidor"
  (cd "$ROOT_DIR/server" && npm run build)
  strip_build_output "$ROOT_DIR/server/dist"

  echo "==> Build nativo macOS: desktop"
  (cd "$ROOT_DIR/desktop" && npm run build)
  strip_build_output "$ROOT_DIR/desktop/dist"

  echo "==> Empacotando .dmg/.zip"
  (cd "$ROOT_DIR/desktop" && npx electron-builder --config electron-builder.yml --mac --publish never)

  echo "==> Validando artefatos macOS"
  bash "$VERIFY" "$RELEASE_DIR" "$ASAR_CLI"
fi

echo
echo "==> Artefatos em desktop/release/ (versão $VERSAO)"
ls -lh "$RELEASE_DIR"
