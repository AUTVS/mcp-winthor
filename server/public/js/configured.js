(() => {
  const statusEl = document.getElementById('mcp-config-status');
  const buttons = document.querySelectorAll('.mcp-config-btn');

  if (statusEl && buttons.length > 0) {
    const clientLabels = {
      cursor: 'Cursor',
      'claude-desktop': 'Claude Desktop',
      'claude-code': 'Claude Code',
      chatgpt: 'ChatGPT',
    };

    buttons.forEach((button) => {
      button.addEventListener('click', async () => {
        const client = button.getAttribute('data-client');
        if (!client) {
          return;
        }

        setMcpStatus(
          'loading',
          `Configurando ${clientLabels[client] ?? client}...`,
        );
        button.setAttribute('disabled', 'true');

        try {
          const response = await fetch(`/setup/mcp/${client}`, {
            method: 'POST',
            headers: { Accept: 'application/json' },
          });
          const result = await response.json();

          if (result.ok) {
            const hint = result.restartHint ? ` ${result.restartHint}` : '';
            setMcpStatus('ok', `${result.message}.${hint}`, result.configPath);
          } else {
            setMcpStatus(
              'error',
              result.message ?? 'Falha ao configurar o cliente MCP.',
            );
          }
        } catch {
          setMcpStatus('error', 'Não foi possível conectar ao servidor wt.ai.');
        } finally {
          button.removeAttribute('disabled');
        }
      });
    });

    function setMcpStatus(kind, message, configPath) {
      statusEl.hidden = false;
      statusEl.className = `mcp-config-status mcp-config-status--${kind}`;
      statusEl.innerHTML = '';

      const text = document.createElement('p');
      text.textContent = message;
      statusEl.appendChild(text);

      if (configPath) {
        const path = document.createElement('p');
        path.className = 'mcp-config-path';
        path.textContent = configPath;
        statusEl.appendChild(path);
      }
    }
  }

  // ---------------------------------------------------------------------------
  // Desconectar: confirmação em dois passos.
  //
  // Antes era um `onsubmit="return confirm(...)"` — um clique e um Enter apagavam
  // o login salvo. Digitar o login é a barreira que separa "quis desconectar" de
  // "esbarrei no botão", e o formulário só aparece depois do primeiro clique.
  // ---------------------------------------------------------------------------
  (() => {
    const iniciar = document.getElementById('logout-iniciar');
    const form = document.getElementById('logout-form');
    const campo = document.getElementById('logout-confirmacao');
    const confirmar = document.getElementById('logout-confirmar');
    const cancelar = document.getElementById('logout-cancelar');
    if (!iniciar || !form || !campo || !confirmar || !cancelar) return;

    const esperado = (campo.dataset.login ?? '').trim().toLowerCase();

    const fechar = () => {
      form.hidden = true;
      iniciar.hidden = false;
      campo.value = '';
      confirmar.disabled = true;
    };

    iniciar.addEventListener('click', () => {
      iniciar.hidden = true;
      form.hidden = false;
      campo.focus();
    });

    cancelar.addEventListener('click', fechar);

    campo.addEventListener('input', () => {
      confirmar.disabled = campo.value.trim().toLowerCase() !== esperado;
    });

    // Enter num campo de texto submete o formulário: sem esta guarda, digitar
    // qualquer coisa e apertar Enter passaria por cima do botão desabilitado.
    form.addEventListener('submit', (evento) => {
      if (campo.value.trim().toLowerCase() !== esperado) evento.preventDefault();
    });

    campo.addEventListener('keydown', (evento) => {
      if (evento.key === 'Escape') fechar();
    });
  })();

  // ---------------------------------------------------------------------------
  // Painel "Base local de vendas".
  // ---------------------------------------------------------------------------

  // Painel ausente = outra página. Silêncio aqui é correto; abaixo, não é.
  if (!document.getElementById('vendas-cache-panel')) return;

  const el = {
    zonas: document.getElementById('vendas-zonas'),
    meses: document.getElementById('vendas-meses'),
    mesesAnos: document.getElementById('vendas-meses-anos'),
    status: document.getElementById('vendas-sync-status'),
    anuncio: document.getElementById('vendas-sync-anuncio'),
    btnAtualizacao: document.getElementById('vendas-sync-atualizacao'),
    btnHistorico: document.getElementById('vendas-sync-historico'),
    btnCancelar: document.getElementById('vendas-sync-cancelar'),
    logPanel: document.getElementById('vendas-sync-log-panel'),
    logLista: document.getElementById('vendas-sync-log'),
  };

  // Guarda em dois níveis: id faltando DENTRO de um painel presente é bug de
  // template, e antes isso desligava o painel inteiro sem deixar rastro nenhum.
  const ausentes = Object.keys(el).filter((chave) => !el[chave]);
  if (ausentes.length) {
    console.error(
      `[wt.ai] painel de vendas desativado — ids ausentes em configured.hbs: ${ausentes.join(', ')}`,
    );
    return;
  }

  const ESTADO_ROTULO = {
    completo: 'Cacheado',
    parcial: 'Parcial',
    vazio: 'Sem cache',
  };
  const ZONA_ACAO = {
    atualizacao: 'Atualizar cache',
    historico: 'Sync histórico',
  };
  const MES_ABREV = ['jan','fev','mar','abr','mai','jun','jul','ago','set','out','nov','dez'];
  const MES_NOME = ['janeiro','fevereiro','março','abril','maio','junho','julho',
                    'agosto','setembro','outubro','novembro','dezembro'];

  const POLL_ATIVO = 1500;
  const POLL_OCIOSO = 8000;
  const POLL_ERRO_MIN = 5000;
  const POLL_ERRO_MAX = 60000;
  /**
   * `sincronizar()` só ENFILEIRA no servidor: o status logo após o POST ainda traz
   * `rodando: false`. Sem esta carência os botões re-habilitam e o painel escreve
   * "N pedidos na base local" um frame depois do clique.
   */
  const CARENCIA_INICIO_MS = 15000;

  let pollTimer = null;
  let emVoo = false;
  let falhasSeguidas = 0;
  let assinaturaCobertura = '';
  let ultimoAnuncio = '';
  let ultimoIniciadoEm = null;
  let inicioPendente = null;
  let ultimoTrabalhoLen = 0;
  let rodandoAnterior = false;

  function horaCurta(iso) {
    if (typeof iso !== 'string') return '';
    try {
      return new Date(iso).toLocaleTimeString('pt-BR', {
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
      });
    } catch {
      return '';
    }
  }

  function renderTrabalho(trabalho, rodando) {
    if (!el.logPanel || !el.logLista) return;
    const linhas = Array.isArray(trabalho) ? trabalho : [];
    const temConteudo = linhas.length > 0 || rodando;
    el.logPanel.hidden = !temConteudo;
    if (!temConteudo) {
      el.logLista.replaceChildren();
      ultimoTrabalhoLen = 0;
      return;
    }

    if (linhas.length !== ultimoTrabalhoLen) {
      const novas = linhas.slice(ultimoTrabalhoLen);
      for (const linha of novas) {
        console.log(`[wt.ai sync] ${linha.mensagem ?? ''}`);
      }
      ultimoTrabalhoLen = linhas.length;
    }

    el.logLista.replaceChildren(
      ...linhas.map((linha) => {
        const item = document.createElement('li');
        item.className = `vendas-sync-log-linha vendas-sync-log-linha--${linha.nivel ?? 'info'}`;
        const hora = document.createElement('time');
        hora.dateTime = linha.em ?? '';
        hora.textContent = horaCurta(linha.em);
        const texto = document.createElement('span');
        texto.textContent = linha.mensagem ?? '';
        item.append(hora, texto);
        return item;
      }),
    );
    el.logLista.scrollTop = el.logLista.scrollHeight;
    if (rodando) el.logPanel.open = true;
  }

  function texto(tag, classe, conteudo) {
    const node = document.createElement(tag);
    if (classe) node.className = classe;
    // textContent, nunca innerHTML: tudo aqui vem do servidor.
    if (conteudo !== undefined) node.textContent = conteudo;
    return node;
  }

  function dataCurta(iso) {
    return typeof iso === 'string' && iso.length >= 10
      ? `${iso.slice(8, 10)}/${iso.slice(5, 7)}/${iso.slice(0, 4)}`
      : '—';
  }

  /** Página de erro do Express é HTML: json() lança e levaria a causa junto. */
  async function lerJson(resposta) {
    try {
      return await resposta.json();
    } catch {
      return null;
    }
  }

  function mensagemHttp(rota, resposta, dados) {
    if (dados && dados.configurado === false) {
      return dados.message ?? 'wt.ai ainda não está configurado.';
    }
    if (resposta.status === 404) {
      return `Este servidor não conhece ${rota} (HTTP 404). A versão em execução está desatualizada — reinicie o wt.ai.`;
    }
    if (typeof dados?.message === 'string' && dados.message) {
      return `${dados.message} (HTTP ${resposta.status})`;
    }
    return `O servidor respondeu HTTP ${resposta.status} em ${rota}.`;
  }

  function backoffMs() {
    const passo = Math.min(Math.max(falhasSeguidas - 1, 0), 8);
    return Math.min(POLL_ERRO_MAX, POLL_ERRO_MIN * 2 ** passo);
  }

  function agendarPoll(ms) {
    if (pollTimer) clearTimeout(pollTimer);
    pollTimer = setTimeout(carregarStatus, ms);
  }

  function mostrarAviso(mensagem, proximoMs) {
    const aviso = texto('div', 'vendas-aviso');
    aviso.append(
      texto('p', 'vendas-aviso-texto', mensagem),
      texto(
        'p',
        'vendas-aviso-detalhe',
        `Nova tentativa em ${Math.round(proximoMs / 1000)} s.`,
      ),
    );
    el.zonas.replaceChildren(aviso);
    el.meses.hidden = true;
    assinaturaCobertura = '';
    anunciar(mensagem);
  }

  async function carregarStatus() {
    // Quem já está em voo re-arma o timer no finally; sair aqui evita duas cadeias.
    if (emVoo) return;
    emVoo = true;
    let proximo = POLL_OCIOSO;

    try {
      const resposta = await fetch('/vendas/status', {
        headers: { Accept: 'application/json' },
      });
      const dados = await lerJson(resposta);

      if (!resposta.ok) {
        falhasSeguidas++;
        proximo = backoffMs();
        mostrarAviso(mensagemHttp('/vendas/status', resposta, dados), proximo);
        definirAcoesHabilitadas(dados?.configurado !== false);
        return;
      }

      if (!dados || dados.ok !== true) {
        falhasSeguidas++;
        proximo = backoffMs();
        mostrarAviso(
          dados?.message ?? 'Resposta inesperada do servidor ao ler a cobertura.',
          proximo,
        );
        return;
      }

      falhasSeguidas = 0;
      renderCobertura(dados);
      proximo = renderSync(dados.sincronizacao, dados.pedidos);
    } catch (erro) {
      falhasSeguidas++;
      proximo = backoffMs();
      console.error('[wt.ai] falha ao ler /vendas/status', erro);
      mostrarAviso(
        'Sem resposta do servidor wt.ai. Verifique se ele continua em execução.',
        proximo,
      );
    } finally {
      emVoo = false;
      // Re-arma SEMPRE — inclusive nas saídas de erro. Antes o painel congelava
      // até dar reload na primeira falha transitória.
      agendarPoll(proximo);
    }
  }

  function renderCobertura(dados) {
    const hoje = typeof dados.hoje === 'string' ? dados.hoje : diaLocal();
    const zonas = Array.isArray(dados.zonas) ? dados.zonas : null;
    const meses = Array.isArray(dados.meses) ? dados.meses : [];

    // Payload idêntico ao anterior: não mexe no DOM (evita piscar a cada 8 s).
    const assinatura = JSON.stringify([hoje, zonas, meses]);
    if (assinatura === assinaturaCobertura) return;
    assinaturaCobertura = assinatura;

    renderZonas(zonas);
    renderMeses(meses, hoje);
  }

  function renderZonas(zonas) {
    if (!zonas) {
      // Servidor antigo: degrada com honestidade em vez de quebrar.
      const aviso = texto('div', 'vendas-aviso');
      aviso.append(
        texto(
          'p',
          'vendas-aviso-texto',
          'O servidor em execução ainda não informa as zonas de cache.',
        ),
        texto(
          'p',
          'vendas-aviso-detalhe',
          'Reinicie o wt.ai para ver a cobertura da janela quente e do histórico.',
        ),
      );
      el.zonas.replaceChildren(aviso);
      return;
    }

    if (!zonas.length) {
      el.zonas.replaceChildren(
        texto(
          'p',
          'vendas-periodos-loading',
          'Nenhuma zona de cache informada pelo servidor.',
        ),
      );
      return;
    }

    el.zonas.replaceChildren(...zonas.map(cardZona));
  }

  function cardZona(zona) {
    const estado = ESTADO_ROTULO[zona.estado] ? zona.estado : 'vazio';
    const card = texto('div', `vendas-periodo vendas-periodo--${estado}`);
    card.id = `vendas-zona-${zona.escopo}`;

    const pct =
      zona.diasEsperados > 0
        ? Math.min(100, Math.round((zona.diasCobertos / zona.diasEsperados) * 100))
        : 0;
    const barra = texto('div', 'vendas-periodo-barra');
    const preenchido = document.createElement('i');
    preenchido.style.width = `${pct}%`;
    barra.appendChild(preenchido);

    card.append(
      texto('span', 'vendas-periodo-rotulo', zona.rotulo),
      texto('span', 'vendas-periodo-estado', ESTADO_ROTULO[estado]),
      barra,
      texto(
        'span',
        'vendas-periodo-meta',
        zona.diasEsperados > 0
          ? `${zona.diasCobertos}/${zona.diasEsperados} dias · ${dataCurta(zona.dataInicio)} → ${dataCurta(zona.dataFim)}`
          : '—',
      ),
      texto('span', 'vendas-periodo-acao', ZONA_ACAO[zona.escopo] ?? ''),
    );

    card.title = zona.atualizadoEm
      ? `Atualizado em ${new Date(zona.atualizadoEm).toLocaleString('pt-BR')}`
      : 'Nunca sincronizado';
    return card;
  }

  /** Só usado se o servidor não mandar `hoje` — o dele vem no fuso do ERP. */
  function diaLocal() {
    const agora = new Date();
    const mm = String(agora.getMonth() + 1).padStart(2, '0');
    const dd = String(agora.getDate()).padStart(2, '0');
    return `${agora.getFullYear()}-${mm}-${dd}`;
  }

  function diasEsperadosDoMes(mes, hoje) {
    // Mês corrente só espera os dias que já aconteceram.
    if (mes === hoje.slice(0, 7)) return Number(hoje.slice(8, 10));
    const [ano, m] = mes.split('-').map(Number);
    return new Date(Date.UTC(ano, m, 0)).getUTCDate();
  }

  function renderMeses(meses, hoje) {
    const porMes = new Map(meses.map((m) => [m.mes, m]));
    const anoAtual = Number(hoje.slice(0, 4));
    const frag = document.createDocumentFragment();

    for (const ano of [anoAtual - 1, anoAtual]) {
      const linha = texto('div', 'vendas-ano');
      linha.appendChild(texto('span', 'vendas-ano-rotulo', String(ano)));

      const lista = texto('ul', 'vendas-ano-meses');
      // list-style:none apaga o role de lista no Safari; devolver explicitamente.
      lista.setAttribute('role', 'list');
      lista.setAttribute('aria-label', `Cobertura mensal de ${ano}`);
      for (let m = 1; m <= 12; m++) {
        lista.appendChild(
          celulaMes(`${ano}-${String(m).padStart(2, '0')}`, porMes, hoje),
        );
      }
      linha.appendChild(lista);
      frag.appendChild(linha);
    }

    el.mesesAnos.replaceChildren(frag);
    el.meses.hidden = false;
  }

  function celulaMes(mes, porMes, hoje) {
    const indice = Number(mes.slice(5, 7)) - 1;
    const item = document.createElement('li');
    const rotulo = texto('span', null, MES_ABREV[indice]);
    rotulo.setAttribute('aria-hidden', 'true');
    item.appendChild(rotulo);

    if (mes > hoje.slice(0, 7)) {
      item.className = 'vendas-mes vendas-mes--futuro';
      item.setAttribute('aria-hidden', 'true');
      return item;
    }

    const dado = porMes.get(mes);
    const esperados = diasEsperadosDoMes(mes, hoje);
    const cobertos = Math.min(Number(dado?.diasCobertos ?? 0), esperados);
    const estado =
      cobertos <= 0 ? 'vazio' : cobertos >= esperados ? 'completo' : 'parcial';
    item.className = `vendas-mes vendas-mes--${estado}`;

    const pedidos = Number(dado?.pedidos ?? 0);
    const descricao =
      `${MES_NOME[indice]} de ${mes.slice(0, 4)}: ${cobertos} de ${esperados} dias` +
      (pedidos > 0
        ? `, ${pedidos.toLocaleString('pt-BR')} pedidos`
        : ', sem pedidos');

    item.title = descricao;
    item.appendChild(texto('span', 'visually-hidden', descricao));
    return item;
  }

  function definirStatus(tipo, mensagem) {
    el.status.hidden = false;
    el.status.className = tipo
      ? `vendas-sync-status vendas-sync-status--${tipo}`
      : 'vendas-sync-status';
    el.status.textContent = mensagem;
  }

  function definirAcoesHabilitadas(habilitado) {
    el.btnAtualizacao.disabled = !habilitado;
    el.btnHistorico.disabled = !habilitado;
  }

  /** Região viva polite não pode narrar cada poll: só fala em transição. */
  function anunciar(mensagem) {
    if (mensagem === ultimoAnuncio) return;
    ultimoAnuncio = mensagem;
    el.anuncio.textContent = mensagem;
  }

  function faseDeInicio(sincronizacao) {
    if (!inicioPendente) return 'nao';
    if ((sincronizacao?.iniciadoEm ?? null) !== inicioPendente.iniciadoEmAntes) {
      inicioPendente = null;
      return 'nao';
    }
    if (Date.now() < inicioPendente.ate) return 'iniciando';
    inicioPendente = null;
    return 'expirou';
  }

  /** Devolve o intervalo do próximo poll; quem agenda é `carregarStatus`. */
  function renderSync(sincronizacao, pedidos) {
    const rodando = Boolean(sincronizacao?.rodando);
    if (rodando !== rodandoAnterior) {
      console.log(
        `[wt.ai] sincronização ${rodando ? 'iniciada' : 'encerrada'}`,
        sincronizacao ?? {},
      );
      rodandoAnterior = rodando;
      if (!rodando) ultimoTrabalhoLen = 0;
    }
    renderTrabalho(sincronizacao?.trabalho, rodando);

    const fase = faseDeInicio(sincronizacao);
    ultimoIniciadoEm = sincronizacao?.iniciadoEm ?? null;

    el.btnCancelar.hidden = !rodando;
    // Derivado da verdade do servidor a cada render: os botões se auto-curam
    // mesmo se `disparar` morrer no meio.
    definirAcoesHabilitadas(!rodando && fase !== 'iniciando');

    if (rodando) {
      const progresso =
        sincronizacao.itensTotal > 0
          ? ` ${sincronizacao.itensConcluidos}/${sincronizacao.itensTotal}`
          : '';
      const item = sincronizacao.itemAtual ? ` · ${sincronizacao.itemAtual}` : '';
      const linhas = Number(sincronizacao.linhas ?? 0).toLocaleString('pt-BR');
      definirStatus(
        'running',
        `Sincronizando${progresso}${item} · ${linhas} pedidos gravados`,
      );
      anunciar('Sincronização em andamento.');
      return POLL_ATIVO;
    }

    if (fase === 'iniciando') return POLL_ATIVO;

    if (fase === 'expirou') {
      definirStatus('error', 'A sincronização não iniciou. Verifique os logs do wt.ai.');
      anunciar('A sincronização não iniciou.');
      return POLL_OCIOSO;
    }

    const erros = sincronizacao?.erros ?? [];
    if (erros.length) {
      const ultimo = String(erros[erros.length - 1]);
      definirStatus(
        'error',
        erros.length > 1
          ? `${erros.length} erros na última sincronização. Último: ${ultimo}`
          : `Último erro: ${ultimo}`,
      );
      anunciar(`Falha na sincronização: ${ultimo}`);
    } else if (sincronizacao?.cancelado) {
      definirStatus('', 'Sincronização cancelada.');
      anunciar('Sincronização cancelada.');
    } else if (typeof pedidos === 'number') {
      definirStatus(
        '',
        pedidos > 0
          ? `${pedidos.toLocaleString('pt-BR')} pedidos na base local.`
          : 'Base local vazia. Clique em Atualizar cache para começar.',
      );
      anunciar(
        pedidos > 0
          ? `Base local com ${pedidos.toLocaleString('pt-BR')} pedidos.`
          : 'Base local vazia.',
      );
    } else {
      el.status.hidden = true;
    }

    return POLL_OCIOSO;
  }

  async function disparar(escopo) {
    definirAcoesHabilitadas(false);
    definirStatus(
      'running',
      escopo === 'historico' ? 'Iniciando sync histórico…' : 'Iniciando atualização…',
    );
    anunciar(
      escopo === 'historico'
        ? 'Iniciando sincronização do histórico.'
        : 'Iniciando atualização do cache.',
    );
    inicioPendente = {
      ate: Date.now() + CARENCIA_INICIO_MS,
      iniciadoEmAntes: ultimoIniciadoEm,
    };

    try {
      const resposta = await fetch('/vendas/sincronizar', {
        method: 'POST',
        headers: {
          Accept: 'application/json',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ escopo }),
      });
      const resultado = await lerJson(resposta);

      // 409 antes de !ok: "já existe sincronização em curso" não é falha.
      if (resposta.status === 409) {
        inicioPendente = null;
        definirStatus('running', 'Já existe uma sincronização em curso.');
        anunciar('Já existe uma sincronização em curso.');
        agendarPoll(POLL_ATIVO);
        return;
      }

      if (!resposta.ok || !resultado || resultado.ok !== true) {
        inicioPendente = null;
        const mensagem = !resposta.ok
          ? mensagemHttp('/vendas/sincronizar', resposta, resultado)
          : (resultado?.message ??
            resultado?.motivo ??
            'Falha ao iniciar a sincronização.');
        definirStatus('error', mensagem);
        anunciar(mensagem);
        definirAcoesHabilitadas(true);
        agendarPoll(POLL_OCIOSO);
        return;
      }

      agendarPoll(600);
    } catch (erro) {
      inicioPendente = null;
      console.error('[wt.ai] falha ao iniciar /vendas/sincronizar', erro);
      definirStatus(
        'error',
        'Não foi possível iniciar a sincronização. O servidor wt.ai respondeu?',
      );
      anunciar('Não foi possível iniciar a sincronização.');
      definirAcoesHabilitadas(true);
      agendarPoll(POLL_OCIOSO);
    }
  }

  el.btnAtualizacao.addEventListener('click', () => disparar('atualizacao'));
  el.btnHistorico.addEventListener('click', () => disparar('historico'));

  el.btnCancelar.addEventListener('click', async () => {
    el.btnCancelar.disabled = true;
    try {
      const resposta = await fetch('/vendas/sincronizar', {
        method: 'POST',
        headers: {
          Accept: 'application/json',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ cancelar: true }),
      });
      const resultado = await lerJson(resposta);
      if (!resposta.ok || !resultado || resultado.ok !== true) {
        definirStatus(
          'error',
          !resposta.ok
            ? mensagemHttp('/vendas/sincronizar', resposta, resultado)
            : 'Não foi possível solicitar o cancelamento.',
        );
      } else {
        definirStatus('running', resultado.message ?? 'Cancelamento solicitado.');
        anunciar('Cancelamento solicitado.');
      }
    } catch (erro) {
      console.error('[wt.ai] falha ao cancelar sincronização', erro);
      definirStatus('error', 'Não foi possível solicitar o cancelamento.');
    } finally {
      // Visibilidade continua sendo decidida por renderSync.
      el.btnCancelar.disabled = false;
      agendarPoll(POLL_ATIVO);
    }
  });

  // Voltar para a aba não deve esperar o fim de um backoff de 60 s.
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') {
      falhasSeguidas = 0;
      agendarPoll(0);
    }
  });

  carregarStatus();
})();
