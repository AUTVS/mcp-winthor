# Como contribuir

Obrigado por olhar o wt.ai. O caminho mais curto para uma mudança:

1. Rode o servidor em desenvolvimento (instruções no [README](README.md)).
2. Faça a alteração no menor recorte possível.
3. Cubra o comportamento com teste em `server/` (`npm test` e, se tocar HTTP ou MCP, `npm run test:e2e`).
4. Abra um pull request descrevendo o *porquê*.

## Desenvolvimento

```bash
cd server
cp .env.example .env
npm install
npm run start:dev
```

Abra http://127.0.0.1:8787. O endpoint MCP fica em http://127.0.0.1:8787/mcp.

App de desktop:

```bash
cd desktop
npm install
npm run dev
```

Arquitetura, ingestão e paginação: [docs/arquitetura.md](docs/arquitetura.md). Perguntas que as tools já atendem: [docs/casos-de-uso.md](docs/casos-de-uso.md).

## Testes

Dentro de `server/`:

```bash
npm test
npm run test:e2e
```

## Precisa falar antes de contribuir?

WhatsApp, e-mail ou formulário: [docs/contato.md](docs/contato.md).
