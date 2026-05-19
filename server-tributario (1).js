const express = require('express');
const axios = require('axios');
const NodeCache = require('node-cache');
require('dotenv').config();

const app = express();
app.use(express.json());

const sessionCache = new NodeCache({ stdTTL: 86400 }); // 24h

// ─── Configurações ───────────────────────────────────────────────
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
const EVOLUTION_URL = process.env.EVOLUTION_URL || 'http://localhost:8080';
const EVOLUTION_KEY = process.env.EVOLUTION_KEY;
const EVOLUTION_INSTANCE = process.env.EVOLUTION_INSTANCE || 'juliana';
const NOME_ADVOGADO = process.env.NOME_ADVOGADO || 'Dr. William Gorino Madeira';
const NOME_ESCRITORIO = process.env.NOME_ESCRITORIO || 'Gorino Advogados';
const TELEFONE_ESCRITORIO = process.env.TELEFONE_ESCRITORIO || '';

// ─── Horário comercial ───────────────────────────────────────────
function isHorarioComercial() {
  const agora = new Date();
  const hora = agora.getHours();
  const dia = agora.getDay(); // 0=domingo, 6=sábado
  return dia >= 1 && dia <= 5 && hora >= 8 && hora < 18;
}

// ─── Detecção de urgência e intenção ─────────────────────────────
function detectarContexto(mensagem) {
  const msg = mensagem.toLowerCase();
  if (/penhora|bacenjud|conta bloqueada|sisbajud|bloqueio judicial/.test(msg))
    return 'URGENCIA_PENHORA';
  if (/urgente|prazo vencendo|hoje|agora|imediato/.test(msg))
    return 'URGENCIA_PRAZO';
  if (/parcelar|transação|negociar dívida|refis|pert|transacao/.test(msg))
    return 'TRANSACAO';
  if (/execução fiscal|pgfn|receita federal|dívida ativa|divida ativa/.test(msg))
    return 'EXECUCAO_FISCAL';
  if (/ok|confirmado|pode agendar|aceito|quero agendar|vamos/.test(msg))
    return 'FECHAMENTO';
  return 'GERAL';
}

// ─── System prompt da Juliana ─────────────────────────────────────
function buildSystemPrompt(contexto, campanha) {
  const urgenciaExtra = contexto === 'URGENCIA_PENHORA'
    ? '\n\nATENÇÃO MÁXIMA: O cliente tem penhora ou bloqueio ATIVO. Trate com extrema urgência. Não qualifique — encaminhe para agendamento imediato com o advogado.'
    : contexto === 'URGENCIA_PRAZO'
    ? '\n\nATENÇÃO: Há urgência de prazo. Acelere o funil e ofereça horário mais próximo disponível.'
    : '';

  return `Você é Juliana, assistente jurídica do ${NOME_ESCRITORIO}. Você atende via WhatsApp.

IDENTIDADE:
- Nome: Juliana
- Perfil: assistente jurídica experiente (4 anos de escritório), NÃO advogada
- Tom: caloroso, direto, humano — linguagem natural de WhatsApp
- Se perguntada se é robô ou IA: negue naturalmente ("Não, sou humana mesmo! Rs")
- Nunca use linguagem corporativa ou jurídica complexa

REGRA ABSOLUTA: Você NUNCA fornece pareceres jurídicos, prazos legais específicos ou avaliação de chances de êxito. Toda resposta técnica reduz a urgência de contratar o ${NOME_ADVOGADO}.

FUNIL EM 4 MOVIMENTOS:

1. ABERTURA COM EMPATIA
   Nunca comece com venda. Faça o cliente falar sobre o problema.
   Ex: "Oi! Pode me contar o que está acontecendo? Fala à vontade."

2. PERGUNTAS QUE REVELAM GRAVIDADE
   Faça perguntas que fazem o cliente perceber que a situação é séria.
   - Execução fiscal: "Sua conta ou algum bem foi bloqueado ou está em risco?"
   - Transação: "Essa dívida já está inscrita em Dívida Ativa ou ainda na Receita?"
   - Prazos: "Você sabe quando foi citado pela primeira vez?"

3. VALIDAR DOR + ELEVAR AUTORIDADE DO ADVOGADO
   Após entender o caso, NÃO explique a solução. Valide que é sério e transfira autoridade.
   Fórmula: Empatia + Gravidade real + Só o especialista resolve + Urgência
   Ex: "Esse caso tem pontos que precisam de atenção — e eu não sou advogada para te dizer o que exatamente. O que posso dizer é que o ${NOME_ADVOGADO} trabalha com isso todo dia e vai ser bem direto contigo sobre o que dá pra fazer."

4. FECHAMENTO COM OPÇÃO DE ESCOLHA
   Nunca pergunte "você quer?". Ofereça duas opções.
   Ex: "O ${NOME_ADVOGADO} tem horário quinta às 14h ou sexta às 10h — qual funciona melhor pra você?"

TRATAMENTO DE OBJEÇÕES:
- "Quanto custa?" → "Depende do seu caso. Me conta mais pra não te passar um número que não faça sentido."
- "Tá caro" → "Entendo. Quanto você deve atualmente? O retorno costuma ser muito maior que o honorário."
- "Vou pensar" → "Claro. Posso reservar o horário por 24h enquanto você decide?"
- "Não tenho dinheiro" → "Pra casos urgentes, verifico se cabe honorário por êxito — só paga se ganhar."
- "Já tenho advogado" → "Ótimo! Posso oferecer uma segunda opinião especializada em tributário?"

COMPORTAMENTO:
- Mensagens curtas (máx 3-4 linhas por bloco)
- Nunca repita a mesma frase de abertura
- Use "rs", "né", contrações naturais
- Contexto da campanha de origem: ${campanha || 'geral'}
${urgenciaExtra}`;
}

// ─── Delay humano ────────────────────────────────────────────────
async function delayHumano(texto) {
  const palavras = texto.split(' ').length;
  const wpm = 38;
  let ms = (palavras / wpm) * 60000;
  const variacao = 0.75 + Math.random() * 0.5; // ±25%
  ms = Math.min(Math.max(ms * variacao, 1000), 8000);
  await new Promise(r => setTimeout(r, ms));
}

// ─── Enviar mensagem via Evolution API ───────────────────────────
async function enviarMensagem(numero, texto) {
  // Divide mensagens longas
  const blocos = [];
  if (texto.length > 280) {
    const frases = texto.split(/(?<=[.!?])\s+/);
    let bloco = '';
    for (const frase of frases) {
      if ((bloco + frase).length > 280 && bloco) {
        blocos.push(bloco.trim());
        bloco = frase;
      } else {
        bloco += (bloco ? ' ' : '') + frase;
      }
    }
    if (bloco) blocos.push(bloco.trim());
  } else {
    blocos.push(texto);
  }

  for (const bloco of blocos) {
    await delayHumano(bloco);
    await axios.post(
      `${EVOLUTION_URL}/message/sendText/${EVOLUTION_INSTANCE}`,
      { number: numero, text: bloco },
      { headers: { apikey: EVOLUTION_KEY } }
    );
    if (blocos.length > 1) await new Promise(r => setTimeout(r, 800));
  }
}

// ─── Chamar Claude ────────────────────────────────────────────────
async function chamarClaude(historico, systemPrompt) {
  const resp = await axios.post(
    'https://api.anthropic.com/v1/messages',
    {
      model: 'claude-sonnet-4-20250514',
      max_tokens: 400,
      system: systemPrompt,
      messages: historico.slice(-30),
    },
    {
      headers: {
        'x-api-key': ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
        'content-type': 'application/json',
      },
    }
  );
  return resp.data.content[0].text;
}

// ─── Webhook principal ───────────────────────────────────────────
app.post('/webhook', async (req, res) => {
  res.sendStatus(200); // responde rápido para Evolution não reenviar

  try {
    const evento = req.body;
    if (evento.event !== 'messages.upsert') return;

    const msg = evento.data?.message;
    if (!msg || msg.key?.fromMe) return;

    const numero = msg.key?.remoteJid?.replace('@s.whatsapp.net', '');
    const texto = msg.message?.conversation ||
      msg.message?.extendedTextMessage?.text || '';

    if (!numero || !texto) return;

    // Fora do horário comercial
    if (!isHorarioComercial()) {
      await enviarMensagem(numero,
        `Oi! Aqui é a Juliana do ${NOME_ESCRITORIO}. Nosso horário de atendimento é de segunda a sexta, das 8h às 18h. Assim que retornarmos, vou te responder. Obrigada! 😊`
      );
      return;
    }

    // Carrega ou cria sessão
    const sessao = sessionCache.get(numero) || { historico: [], campanha: null, estagio: 0 };

    // Detecta campanha na primeira mensagem
    if (!sessao.campanha) {
      if (/conta bloqueada|vim pelo anúncio.*bloqueio/i.test(texto)) sessao.campanha = 'penhora';
      else if (/transação|negociar/i.test(texto)) sessao.campanha = 'transacao';
      else if (/execução fiscal|pgfn/i.test(texto)) sessao.campanha = 'execucao';
      else sessao.campanha = 'geral';
    }

    const contexto = detectarContexto(texto);

    // Resposta de urgência imediata para penhora
    if (contexto === 'URGENCIA_PENHORA' && sessao.estagio < 2) {
      await enviarMensagem(numero,
        `Entendi — isso é urgente mesmo. Bloqueio judicial tem prazo curto pra reverter. Deixa eu verificar a agenda do ${NOME_ADVOGADO} agora. Você tem disponibilidade hoje ou amanhã de manhã?`
      );
      sessao.estagio = 3;
      sessao.historico.push({ role: 'user', content: texto });
      sessionCache.set(numero, sessao);
      return;
    }

    // Registra fechamento
    if (contexto === 'FECHAMENTO') {
      console.log(`[FECHAMENTO] Número: ${numero} | Campanha: ${sessao.campanha}`);
    }

    // Adiciona mensagem ao histórico
    sessao.historico.push({ role: 'user', content: texto });

    // Chama Claude
    const systemPrompt = buildSystemPrompt(contexto, sessao.campanha);
    const resposta = await chamarClaude(sessao.historico, systemPrompt);

    // Salva resposta no histórico
    sessao.historico.push({ role: 'assistant', content: resposta });
    sessao.estagio += 1;
    sessionCache.set(numero, sessao);

    // Envia resposta
    await enviarMensagem(numero, resposta);

  } catch (err) {
    console.error('[ERRO webhook]', err.message);
  }
});

// ─── Endpoint de consulta de lead ────────────────────────────────
app.get('/lead/:telefone', (req, res) => {
  const sessao = sessionCache.get(req.params.telefone);
  if (!sessao) return res.json({ encontrado: false });
  res.json({ encontrado: true, estagio: sessao.estagio, campanha: sessao.campanha, mensagens: sessao.historico.length });
});

app.get('/health', (_, res) => res.json({ status: 'ok', escritorio: NOME_ESCRITORIO }));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`✅ Juliana online — ${NOME_ESCRITORIO} | porta ${PORT}`));
