// Sugestões de mensagem com o Gemini.
// Privacidade: pro Gemini vai só o TIPO da conta e o tom. Nunca nome, número, valor ou data da pessoa:
// a IA escreve com marcadores ({nome}, {conta}...) e o sistema troca pelos dados reais na hora de enviar.
// Sem chave, sem cota ou se a IA falhar, cai em mensagens prontas (o botão sempre funciona).

const CHAVE = process.env.GEMINI_API_KEY?.trim() || null;
const URL_BASE = 'https://generativelanguage.googleapis.com/v1beta/models';

// O Google troca os modelos com frequência: tenta nesta ordem até um responder.
// Dá pra forçar um com a variável GEMINI_MODELO.
const MODELOS = [
  process.env.GEMINI_MODELO?.trim(),
  'gemini-3.5-flash-lite',
  'gemini-3.1-flash-lite',
  'gemini-3.8-flash',
  'gemini-2.5-flash-lite',
  'gemini-2.5-flash',
].filter(Boolean);
let modeloQueFunciona = null;

export const iaConfigurada = () => Boolean(CHAVE);

export const TONS = {
  amigavel: 'amigável e leve, como uma amiga lembrando',
  divertido: 'divertido e bem-humorado, com uma piadinha leve',
  direto: 'direto e curto, sem enrolação',
  formal: 'educado e mais formal, sem gírias',
};

const DESCRICAO_TIPO = {
  luz: 'conta de luz', agua: 'conta de água', internet: 'conta de internet', aluguel: 'aluguel',
  cartao: 'fatura do cartão de crédito', boleto: 'boleto', outro: 'conta ou compromisso',
};

const MARCADORES = ['{nome}', '{conta}', '{valor}', '{vencimento}', '{quando}'];

// ---------- mensagens prontas (reserva) ----------
const PRONTAS = {
  amigavel: [
    'Oi, {nome}! Passando pra lembrar que *{conta}* vence {quando} ({vencimento}). 💚',
    '{nome}, não esquece: *{conta}* vence {quando}, dia {vencimento}. 😉',
    'Lembrete carinhoso: *{conta}* {valor} vence {quando}. Bora deixar em dia, {nome}!',
  ],
  divertido: [
    '🚨 Alerta, {nome}! *{conta}* vence {quando} ({vencimento}). Paga antes que ela venha te cobrar pessoalmente 😅',
    '{nome}, a *{conta}* mandou avisar que vence {quando}. Ela tá contando com você! 😂',
    'Plim plim! 🔔 *{conta}* {valor} vence {quando}. Seu eu do futuro agradece, {nome}!',
  ],
  direto: [
    '*{conta}* vence {quando} ({vencimento}).',
    '{nome}, *{conta}* {valor} vence {quando}.',
    'Lembrete: *{conta}* — vencimento {vencimento} ({quando}).',
  ],
  formal: [
    'Olá, {nome}. Lembramos que *{conta}* vence {quando}, em {vencimento}.',
    'Prezado(a) {nome}, *{conta}* no valor de {valor} tem vencimento {quando} ({vencimento}).',
    'Olá, {nome}. Este é um lembrete: *{conta}* vence {quando}. Evite juros mantendo o pagamento em dia.',
  ],
};

// Sem valor cadastrado: tira os trechos de {valor} pra frase não ficar quebrada
const semValor = (t) => t.replace(' no valor de {valor}', '').replace(' {valor}', '').replace('{valor}', '');
const prontas = (tom, temValor) => (PRONTAS[tom] || PRONTAS.amigavel).map((t) => (temValor ? t : semValor(t)));

// ---------- limites (cota grátis do Gemini é por projeto, então limita aqui também) ----------
const porConta = new Map(); // contaId -> [timestamps]
let chamadasGlobais = [];

function podeChamar(contaId) {
  const agora = Date.now();
  const minhas = (porConta.get(contaId) || []).filter((t) => t > agora - 3600_000);
  chamadasGlobais = chamadasGlobais.filter((t) => t > agora - 60_000);
  if (minhas.length >= 15) return 'Você pediu muitas sugestões. Tente de novo em 1 hora.';
  if (chamadasGlobais.length >= 8) return null; // muita gente ao mesmo tempo: usa as prontas, sem erro
  porConta.set(contaId, [...minhas, agora]);
  chamadasGlobais.push(agora);
  return true;
}

// ---------- limpeza do que a IA devolve ----------
function limpar(texto) {
  let t = String(texto || '').replace(/\s+/g, ' ').trim();
  t = t.replace(/^["'“”]+|["'“”]+$/g, '').trim();
  if ((t.match(/\{[^}]*\}/g) || []).some((m) => !MARCADORES.includes(m))) return null; // inventou marcador ({link}...): descarta
  t = t.replace(/\*{2,}/g, '*').replace(/\s{2,}/g, ' ').trim();
  if (t.length < 15 || t.length > 320) return null;
  if (!t.includes('{conta}') || !t.includes('{quando}')) return null; // precisa dizer o quê e quando
  return t;
}

function extrairLista(resposta) {
  const partes = resposta?.candidates?.[0]?.content?.parts || [];
  const texto = partes.filter((p) => !p.thought && typeof p.text === 'string').map((p) => p.text).join('').trim();
  const semCerca = texto.replace(/^```(?:json)?\s*|\s*```$/g, '');
  try {
    const json = JSON.parse(semCerca);
    return Array.isArray(json) ? json : json.sugestoes || [];
  } catch {
    const lista = semCerca.match(/\[[\s\S]*\]/);
    if (lista) try { return JSON.parse(lista[0]); } catch { /* segue */ }
    return [];
  }
}

async function chamarGemini(modelo, prompt, sistema) {
  const r = await fetch(`${URL_BASE}/${modelo}:generateContent`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-goog-api-key': CHAVE },
    body: JSON.stringify({
      systemInstruction: { parts: [{ text: sistema }] },
      contents: [{ role: 'user', parts: [{ text: prompt }] }],
      generationConfig: { responseMimeType: 'application/json', maxOutputTokens: 2048 },
    }),
    signal: AbortSignal.timeout(20_000),
  });
  const corpo = await r.json().catch(() => ({}));
  if (!r.ok) {
    const erro = new Error(corpo?.error?.message || `HTTP ${r.status}`);
    erro.status = r.status;
    throw erro;
  }
  return corpo;
}

// ---------- função principal ----------
export async function sugerirMensagens({ contaId, tipo, tom = 'amigavel', temValor = false }) {
  const tomOk = TONS[tom] ? tom : 'amigavel';
  const reserva = { sugestoes: prontas(tomOk, temValor), origem: 'prontas' };
  if (!CHAVE) return { ...reserva, aviso: 'IA não configurada — mostrando sugestões prontas.' };

  const pode = podeChamar(contaId);
  if (pode === null) return reserva;
  if (pode !== true) throw Object.assign(new Error(pode), { status: 429 });

  const sistema = [
    'Você escreve mensagens curtas de lembrete de contas que serão enviadas por WhatsApp, em português do Brasil.',
    'Regras:',
    '- Use exatamente estes marcadores, com as chaves, que o sistema troca pelos dados reais: {nome} (primeiro nome da pessoa), {conta} (nome da conta), {quando} (ex.: "hoje", "amanhã", "em 3 dias"), {vencimento} (data, ex.: 10/12)' + (temValor ? ', {valor} (ex.: R$ 180,00)' : '') + '.',
    '- Toda mensagem precisa ter {conta} e {quando}. Não invente valores, datas, nomes nem links.',
    '- No máximo 2 frases e 220 caracteres. No máximo 1 emoji. Pode usar *negrito* do WhatsApp em {conta}.',
    '- Não peça dados, senhas nem pagamentos por link.',
    '- Responda só com JSON no formato {"sugestoes": ["...", "...", "..."]}, com 3 mensagens diferentes entre si.',
  ].join('\n');
  const prompt = `Tipo de conta: ${DESCRICAO_TIPO[tipo] || DESCRICAO_TIPO.outro}.\nTom: ${TONS[tomOk]}.\nEscreva 3 sugestões.`;

  const candidatos = modeloQueFunciona ? [modeloQueFunciona] : MODELOS;
  for (const modelo of candidatos) {
    try {
      const resposta = await chamarGemini(modelo, prompt, sistema);
      const sugestoes = [...new Set(extrairLista(resposta).map(limpar).filter(Boolean)
        .map((t) => (temValor ? t : semValor(t))))].slice(0, 3);
      modeloQueFunciona = modelo;
      if (!sugestoes.length) return { ...reserva, aviso: 'A IA não caprichou dessa vez — mostrando sugestões prontas.' };
      return { sugestoes, origem: 'ia', modelo };
    } catch (e) {
      if (e.status === 404 || (e.status === 400 && /model|not found|not supported/i.test(e.message))) {
        if (modelo === modeloQueFunciona) modeloQueFunciona = null;
        continue; // modelo não existe mais: tenta o próximo
      }
      console.error(`Gemini (${modelo}):`, e.message);
      const aviso = e.status === 429
        ? 'A cota grátis da IA acabou por agora — mostrando sugestões prontas.'
        : 'A IA não respondeu agora — mostrando sugestões prontas.';
      return { ...reserva, aviso };
    }
  }
  console.error('Gemini: nenhum modelo da lista respondeu. Defina GEMINI_MODELO com um modelo atual.');
  return { ...reserva, aviso: 'A IA está indisponível — mostrando sugestões prontas.' };
}
