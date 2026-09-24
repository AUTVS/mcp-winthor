# Arquitetura

O aplicativo de desktop sobe o servidor na máquina do usuário; as credenciais ficam só nesse computador. Consultas pesadas de vendas e estoque leem uma base local; o restante vai direto à API do WinThor.

Há dois modos de uso. No dia a dia, o app Electron inicia o servidor, mostra a bandeja e abre a janela em `http://127.0.0.1:8787`. Em desenvolvimento, o servidor sobe sozinho com `npm run start:dev` dentro de `server/`.

## Visão geral

```mermaid
flowchart LR
  subgraph maquina["Máquina do usuário"]
    assistente["Assistente de IA<br/>Cursor, Claude, ChatGPT"]
    desktop["App desktop<br/>Electron"]
    servidor["Servidor NestJS<br/>127.0.0.1:8787"]
    ui["Interface web<br/>/ setup"]
    dados[("Dados locais<br/>config.json<br/>SQLite + DuckDB")]
    desktop -->|sobe o processo| servidor
    ui -->|HTTP| servidor
    assistente -->|"MCP /mcp"| servidor
    servidor --> dados
  end

  winthor["WinThor WTA<br/>autenticação, API e mobile"]
  servidor -->|"login e consultas ao vivo"| winthor
  servidor -->|"ingestão em segundo plano"| winthor
```

## Subida do aplicativo

```mermaid
sequenceDiagram
  actor Usuario
  participant App as Electron
  participant Filho as Processo Node
  participant HTTP as NestJS :8787

  Usuario->>App: abre o wt.ai
  App->>App: trava de instância única
  App->>App: bandeja e splash
  App->>Filho: spawn com ELECTRON_RUN_AS_NODE
  Note over Filho: cwd = pasta do servidor<br/>WTA_DATA_DIR = userData
  Filho->>HTTP: escuta 127.0.0.1:8787
  HTTP-->>App: porta respondendo
  App->>Usuario: fecha o splash e abre a janela
```

Ao sair, o Electron manda o processo filho encerrar antes de fechar, para a porta 8787 não ficar presa. Uma segunda abertura do app só traz a janela que já existe.

No pacote instalado, o JavaScript do servidor viaja em `extraResources` e os dados vão para o `userData` do Electron. Em desenvolvimento, os arquivos ficam em `server/data/`.

## Configuração e login

A página inicial pede a URL base do WinThor, o login e a senha. A senha vira MD5 em maiúsculas, no padrão WTA, e o texto puro não é gravado.

```mermaid
sequenceDiagram
  actor Usuario
  participant UI as Página /
  participant Setup as SetupController
  participant Auth as WinthorAuthService
  participant WTA as WinThor
  participant Disco as config.json

  Usuario->>UI: URL, login e senha
  UI->>Setup: POST /setup
  Setup->>Auth: testConnection
  Auth->>Auth: MD5 maiúsculo da senha
  Auth->>WTA: POST /winthor/autenticacao/v1/login
  WTA-->>Auth: accessToken
  Auth->>WTA: GET /winthor/autenticacao/v1/logado
  WTA-->>Auth: sessão válida
  Setup->>Disco: grava URL, login e senhaMd5
  Setup-->>Usuario: página configurada e URL do MCP
```

Enquanto não houver `config.json` válido, `POST /mcp` responde `503`. A página configurada também grava o servidor `wt.ai` no arquivo de MCP do Cursor, Claude Desktop, Claude Code ou ChatGPT.

O token fica em memória. Ele é reutilizado por uma janela curta e renovado quando expira ou quando a URL ou o login mudam.

## Caminho de uma pergunta

O assistente fala JSON-RPC em `http://127.0.0.1:8787/mcp`. Cada chamada marca vendas e estoque como ocupados, para a ingestão em segundo plano esperar e não disputar o ERP com a pergunta.

```mermaid
sequenceDiagram
  actor Assistente
  participant MCP as /mcp
  participant Factory as McpServerFactory
  participant Tool as Tool wt_*
  participant Local as Base local
  participant WTA as WinThor

  Assistente->>MCP: tools/call
  alt ainda sem config.json
    MCP-->>Assistente: 503 not_configured
  else configurado
    MCP->>Factory: cria o servidor MCP
    Factory->>Tool: handler da tool
    alt vendas ou estoque agregados
      Tool->>Local: lê DuckDB / SQLite
      Local-->>Tool: linhas e cobertura
    else cadastro, filial, mobile
      Tool->>WTA: API com o token
      WTA-->>Tool: JSON
    end
    Tool-->>Assistente: resultado paginado
  end
```

`instalarPaginacao` envolve todas as tools e devolve um envelope com página, tamanho e continuação. O tamanho de página tem teto fixo para a resposta caber no contexto do modelo.

## Bases locais

Vendas e estoque seguem o mesmo desenho: metadados e cobertura em SQLite, fatos em DuckDB. A ingestão mora no módulo WinThor; a leitura mora nos módulos de vendas e estoque. Essa separação evita um ciclo no grafo do Nest.

```mermaid
flowchart TB
  subgraph erp["WinThor"]
    mobile["Rotinas mobile<br/>pedidos de venda"]
    api["API de estoque e cadastros"]
  end

  subgraph ingestao["Segundo plano"]
    ingVendas["VendasIngestaoService<br/>filial × período, página a página"]
    ingEstoque["EstoqueIngestaoService<br/>filial a filial"]
  end

  subgraph disco["WTA_DATA_DIR"]
    metaV[("vendas-meta.db")]
    fatoV[("vendas-fato.duckdb")]
    metaE[("estoque-meta.db")]
    fatoE[("estoque-fato.duckdb")]
  end

  subgraph leitura["Tools de leitura"]
    tv["wt_vendas_base_local"]
    te["wt_estoque_base_local<br/>wt_estoque_por_filial"]
  end

  mobile --> ingVendas
  api --> ingEstoque
  ingVendas --> metaV
  ingVendas --> fatoV
  ingEstoque --> metaE
  ingEstoque --> fatoE
  metaV --> tv
  fatoV --> tv
  metaE --> te
  fatoE --> te
```

A ingestão de vendas percorre o histórico (ano atual e anterior) e, em ciclos mais curtos, o mês atual e o anterior. Estoque refaz a fotografia por filial quando a cópia local passa da validade. As duas pausam enquanto uma tool MCP está em andamento.

Tools de sincronização (`wt_vendas_sincronizar`, `wt_estoque_sincronizar`) disparam o mesmo trabalho sob demanda e devolvem o progresso.

## Módulos do servidor

```mermaid
flowchart TB
  app["AppModule"]
  app --> config["WtConfigModule<br/>config.json e diretório de dados"]
  app --> setup["SetupModule<br/>páginas / e /setup"]
  app --> winthor["WinthorModule"]
  app --> mcp["McpModule<br/>/mcp"]

  winthor --> auth["WinthorAuthService"]
  winthor --> api["WinthorApiService"]
  winthor --> mob["WinthorMobileService"]
  winthor --> ing["ingestão de vendas e estoque"]

  vendas["VendasModule<br/>meta, fato, consulta"]
  estoque["EstoqueModule<br/>meta, fato, consulta"]
  winthor --> vendas
  winthor --> estoque
  mcp --> winthor
```

## Tools MCP

| Grupo | Tools | Origem dos dados |
| --- | --- | --- |
| Servidor | `wt_ping`, `wt_test_connection`, `wt_server_info` | processo local e login WTA |
| Cadastro | `wt_list_filiais`, `wt_buscar_clientes`, `wt_buscar_pedidos_venda` | API WinThor, com cache curto de filiais |
| Vendas | `wt_vendas_base_local`, `wt_vendas_sincronizar` | DuckDB e SQLite locais |
| Estoque | `wt_estoque_base_local`, `wt_estoque_por_filial`, `wt_estoque_sincronizar` | DuckDB, SQLite e, no detalhe, a API |
| Mobile | inadimplência, lucratividade, faturamento agregado e pesquisas auxiliares | rotinas mobile do WinThor |

Perguntas reais que essas tools atendem: [casos de uso](casos-de-uso.md).
