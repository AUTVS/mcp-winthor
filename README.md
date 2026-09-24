<p align="center">
  <img src="assets/icone.png" alt="wt.ai" width="96" height="96" />
</p>

<h1 align="center">wt.ai</h1>

<p align="center">
  <a href="LICENSE"><img src="https://img.shields.io/badge/License-MIT-yellow.svg" alt="License: MIT" /></a>
</p>

Servidor MCP local que liga o ERP WinThor a assistentes de IA (Cursor, Claude, ChatGPT). O app sobe na sua máquina; as credenciais não saem desse computador. Consultas pesadas de vendas e estoque leem uma base local; o restante vai direto à API do WinThor.

## Documentação

- [Casos de uso](docs/casos-de-uso.md) — perguntas reais e as tools que as atendem
- [Arquitetura](docs/arquitetura.md) — fluxo, bases locais e módulos
- [Fale comigo](docs/contato.md) — WhatsApp, e-mail e formulário
- [Como contribuir](CONTRIBUTING.md)

## Para quem é

Quem opera WinThor e já conversa com um assistente de IA. Em vez de exportar planilha, você pergunta:

- como foram as vendas deste mês por filial
- quais produtos estão sem saldo numa filial
- quanto está a receber na carteira
- quais RCAs venderam com melhor margem
- quem é o cliente X e quais pedidos dele estão ativos

Exemplos completos em [casos de uso](docs/casos-de-uso.md).

## Como rodar

Servidor (desenvolvimento):

```bash
cd server
cp .env.example .env
npm install
npm run start:dev
```

Abra http://127.0.0.1:8787, grave a URL do WinThor e as credenciais, e aponte o cliente MCP para http://127.0.0.1:8787/mcp.

App de desktop, a partir de `desktop/`:

```bash
npm install
npm run dev
```

`npm test` e `npm run test:e2e`, dentro de `server/`, cobrem autenticação, ingestão, paginação e o contrato HTTP.

Detalhes de setup, ingestão e paginação: [arquitetura](docs/arquitetura.md).

## Tools MCP

| Grupo | Tools | Origem dos dados |
| --- | --- | --- |
| Servidor | `wt_ping`, `wt_test_connection`, `wt_server_info` | processo local e login WTA |
| Cadastro | `wt_list_filiais`, `wt_buscar_clientes`, `wt_buscar_pedidos_venda` | API WinThor, com cache curto de filiais |
| Vendas | `wt_vendas_base_local`, `wt_vendas_sincronizar` | DuckDB e SQLite locais |
| Estoque | `wt_estoque_base_local`, `wt_estoque_por_filial`, `wt_estoque_sincronizar` | DuckDB, SQLite e, no detalhe, a API |
| Mobile | inadimplência, lucratividade, faturamento agregado e pesquisas auxiliares | rotinas mobile do WinThor |

## Fale comigo

Implantação, tools sob medida ou suporte WinThor:

- WhatsApp: [wa.me/55XXXXXXXXXXX](https://wa.me/55XXXXXXXXXXX)
- E-mail: [seu-email@exemplo.com](mailto:seu-email@exemplo.com)
- Formulário: [exemplo.com/contato](https://exemplo.com/contato)

Canais e o que enviar na mensagem: [contato](docs/contato.md).

## Licença

[MIT](LICENSE).
