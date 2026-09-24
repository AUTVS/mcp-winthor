# syntax=docker/dockerfile:1
#
# Build dos instaladores Windows (NSIS) e Linux (AppImage) do wt.ai.
#
# O código entra por COPY explícito, nunca por bind mount: só chega à imagem o
# que está listado abaixo e sobrevive ao .dockerignore. Credenciais (server/.env,
# server/data/config.json) ficam fora do contexto de build por construção.
#
# Antes de exportar, a imagem valida os artefatos com scripts/verify-artifacts.sh
# — o build falha se algum source map, declaração de tipo ou endereço interno
# tiver sido empacotado.

ARG BUILDER_IMAGE=electronuserland/builder:wine

# ---------------------------------------------------------------------------
# 1. Servidor: dependências completas (devDeps são necessárias para o nest build)
# ---------------------------------------------------------------------------
FROM --platform=linux/amd64 ${BUILDER_IMAGE} AS server-build
WORKDIR /build/server

COPY server/package.json server/package-lock.json ./
RUN --mount=type=cache,target=/root/.npm,sharing=locked \
    npm ci

COPY server/tsconfig.json server/tsconfig.build.json server/nest-cli.json ./
COPY server/src ./src
RUN npm run build

# Remove o que permite reconstruir o código-fonte a partir do bundle.
# O comentário sourceMappingURL também sai, para não deixar referência órfã.
RUN find dist -name '*.map' -delete \
 && find dist -name '*.d.ts' -delete \
 && find dist -name '*.tsbuildinfo' -delete \
 && find dist -name '*.js' -exec sed -i '/^\/\/# sourceMappingURL=/d' {} + \
 && echo "server/dist limpo: $(find dist -type f | wc -l) arquivos"

# ---------------------------------------------------------------------------
# 2. Servidor: apenas dependências de runtime, sem source maps de terceiros
# ---------------------------------------------------------------------------
FROM --platform=linux/amd64 ${BUILDER_IMAGE} AS server-runtime-deps
WORKDIR /build/server

COPY server/package.json server/package-lock.json ./
RUN --mount=type=cache,target=/root/.npm,sharing=locked \
    npm ci --omit=dev \
 && find node_modules -name '*.map' -delete

# ---------------------------------------------------------------------------
# 3. Empacotamento: monta o layout que o electron-builder espera e valida
# ---------------------------------------------------------------------------
FROM --platform=linux/amd64 ${BUILDER_IMAGE} AS packager

# Layout espelha o repositório: extraResources aponta para ../server/*
COPY --from=server-build         /build/server/dist         /build/server/dist
COPY --from=server-runtime-deps  /build/server/node_modules /build/server/node_modules
COPY server/package.json /build/server/package.json
COPY server/views        /build/server/views
COPY server/public       /build/server/public

WORKDIR /build/desktop
COPY desktop/package.json desktop/package-lock.json ./
RUN --mount=type=cache,target=/root/.npm,sharing=locked \
    npm ci

COPY desktop/tsconfig.json desktop/electron-builder.yml ./
COPY desktop/src   ./src
COPY desktop/build ./build
RUN npm run build \
 && find dist -name '*.map' -delete \
 && find dist -name '*.js' -exec sed -i '/^\/\/# sourceMappingURL=/d' {} +

ARG TARGETS="--win --linux"
RUN --mount=type=cache,target=/root/.cache/electron,sharing=locked \
    --mount=type=cache,target=/root/.cache/electron-builder,sharing=locked \
    ELECTRON_CACHE=/root/.cache/electron \
    ELECTRON_BUILDER_CACHE=/root/.cache/electron-builder \
    npx electron-builder --config electron-builder.yml ${TARGETS} --publish never

# Validação: falha o build se algo sensível tiver entrado no pacote.
COPY scripts/verify-artifacts.sh /usr/local/bin/verify-artifacts.sh
RUN bash /usr/local/bin/verify-artifacts.sh \
      /build/desktop/release \
      /build/desktop/node_modules/@electron/asar/bin/asar.js

# Só os instaladores seguem adiante; linux-unpacked/win-unpacked ficam para trás.
RUN mkdir -p /out \
 && find /build/desktop/release -maxdepth 1 -type f \
      \( -name '*.AppImage' -o -name '*.exe' -o -name '*.blockmap' -o -name 'latest*.yml' \) \
      -exec cp -v {} /out/ \;

# ---------------------------------------------------------------------------
# 4. Imagem final: carrega apenas os instaladores validados
# ---------------------------------------------------------------------------
FROM --platform=linux/amd64 alpine:3.21 AS export
COPY --from=packager /out /out
CMD ["sh", "-c", "cp -v /out/* /export/"]
