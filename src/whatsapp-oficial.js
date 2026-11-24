// Motor "oficial": WhatsApp Cloud API da Meta (WhatsApp Business Platform).
// Sem risco de bloqueio por automação, com botões de verdade. Cobra por aviso (mensagem de modelo de utilidade).
// Ligue com WHATSAPP_PROVEDOR=oficial. O passo a passo da configuração está no README.
//
// Como funciona:
//  - Avisos e código de confirmação saem por MODELOS aprovados pela Meta (obrigatório pra puxar conversa).
//  - O aviso tem 2 botões de resposta rápida: "Já paguei" e "Me lembra mais tarde".
//  - As respostas (texto, "paguei", toques nos botões) chegam pelo webhook /webhook/whatsapp.
//  - Responder dentro de 24h depois da pessoa escrever pode ser texto livre e lista de opções.
import { createHmac, timingSafeEqual } from 'node:crypto';

const env = (k, padrao = '') => String(process.env[k] ?? padrao).trim();
const VERSAO = env('WHATSAPP_API_VERSAO', 'v25.0');
const BASE = env('WHATSAPP_API_URL', 'https://graph.facebook.com').replace(/\/+$/, '');
const TOKEN = env('WHATSAPP_TOKEN');
const PHONE_ID = env('WHATSAPP_PHONE_ID');
const VERIFY = env('WHATSAPP_VERIFY_TOKEN');
const APP_SECRET = env('WHATSAPP_APP_SECRET');
const IDIOMA = env('WHATSAPP_IDIOMA', 'pt_BR');
export const MODELOS = {
  aviso: env('WHATSAPP_MODELO_AVISO', 'lembrete_conta'),
  personalizado: env('WHATSAPP_MODELO_PERSONALIZADO'), // opcional (mensagem personalizada do Premium)
  codigo: env('WHATSAPP_MODELO_CODIGO', 'codigo_confirmacao'),
};

const faltando = [['WHATSAPP_TOKEN', TOKEN], ['WHATSAPP_PHONE_ID', PHONE_ID], ['WHATSAPP_VERIFY_TOKEN', VERIFY]].filter(([, v]) => !v).map(([k]) => k);
const configurado = faltando.length === 0;
if (!configurado) console.error(`API oficial do WhatsApp: faltam as variáveis ${faltando.join(', ')}.`);
if (configurado && !APP_SECRET) console.warn('API oficial do WhatsApp: sem WHATSAPP_APP_SECRET o webhook não confere a assinatura da Meta (recomendado preencher).');

export const getStatus = () => ({
  status: configurado ? 'conectado' : 'desconectado',
  aviso: configurado ? null : `Faltam variáveis no Render: ${faltando.join(', ')}`,
  numero: env('WHATSAPP_NUMERO').replace(/\D/g, '') || null,
  temQr: false,
  oficial: true,
});
export const getQr = () => null;
export const online = () => configurado;
export async function iniciar() { return configurado; }
export async function conectar() { if (!configurado) throw new Error(getStatus().aviso); }
export async function desconectar() { /* na API oficial o número fica no painel da Meta */ }

let aoReceber = null;
export const quandoChegarMensagem = (fn) => { aoReceber = fn; };
let aoEscolher = null;
export const quandoChegarEscolha = (fn) => { aoEscolher = fn; };

// ---------- envio ----------
const paraNumero = (jid) => String(jid).split('@')[0].split(':')[0].replace(/\D/g, '');

async function chamar(corpo) {
  if (!configurado) throw new Error('API oficial do WhatsApp não configurada');
  const r = await fetch(`${BASE}/${VERSAO}/${PHONE_ID}/messages`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ messaging_product: 'whatsapp', recipient_type: 'individual', ...corpo }),
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok || j.error) {
    const e = j.error || {};
    throw new Error(`WhatsApp (API oficial): ${e.error_user_msg || e.message || `erro ${r.status}`}${e.code ? ` [${e.code}]` : ''}`);
  }
  return j.messages?.[0]?.id || null;
}

// A Meta não aceita quebra de linha, tab nem 4+ espaços seguidos dentro das variáveis do modelo
const variavel = (t) => String(t ?? '').replace(/[\r\n\t]+/g, ' · ').replace(/ {4,}/g, '   ').trim().slice(0, 1000) || '-';
const textoParam = (t) => ({ type: 'text', text: variavel(t) });

export const enviarTexto = (jid, texto) => chamar({ to: paraNumero(jid), type: 'text', text: { body: texto, preview_url: false } });

// Código de confirmação/login/senha: modelo de autenticação (com botão "copiar código"). O texto é o do modelo aprovado.
export const enviarCodigo = (jid, codigo, _motivo) => chamar({
  to: paraNumero(jid),
  type: 'template',
  template: {
    name: MODELOS.codigo, language: { code: IDIOMA },
    components: [
      { type: 'body', parameters: [textoParam(codigo)] },
      { type: 'button', sub_type: 'url', index: '0', parameters: [textoParam(codigo)] },
    ],
  },
});

// Aviso de conta: modelo de utilidade com os botões "Já paguei" (pago) e "Me lembra mais tarde" (adiar).
//   lembrete_conta:         "Oi, {{1}}! Lembrete da conta *{{2}}*: {{3}}."
//   lembrete_personalizado: "Lembrete do Lembra Aí: {{1}} Use os botões abaixo pra responder."  (opcional)
export function enviarModeloAviso(jid, { nome, conta, situacao, personalizada }) {
  const usarPersonalizado = personalizada && MODELOS.personalizado;
  const corpo = usarPersonalizado ? [textoParam(personalizada)] : [textoParam(nome), textoParam(conta), textoParam(situacao)];
  return chamar({
    to: paraNumero(jid),
    type: 'template',
    template: {
      name: usarPersonalizado ? MODELOS.personalizado : MODELOS.aviso,
      language: { code: IDIOMA },
      components: [
        { type: 'body', parameters: corpo },
        { type: 'button', sub_type: 'quick_reply', index: '0', parameters: [{ type: 'payload', payload: 'pago' }] },
        { type: 'button', sub_type: 'quick_reply', index: '1', parameters: [{ type: 'payload', payload: 'adiar' }] },
      ],
    },
  });
}

// Lista de opções (só dentro das 24h depois da pessoa escrever, que é o caso do "Me lembra mais tarde")
export const enviarLista = (jid, { texto, botao, opcoes }) => chamar({
  to: paraNumero(jid),
  type: 'interactive',
  interactive: {
    type: 'list',
    body: { text: texto.slice(0, 1024) },
    action: { button: botao.slice(0, 20), sections: [{ title: 'Opções', rows: opcoes.map((o) => ({ id: o.id.slice(0, 200), title: o.titulo.slice(0, 24) })) }] },
  },
});

// Botões de resposta (até 3), dentro das 24h depois da pessoa escrever
export const enviarBotoes = (jid, { texto, botoes }) => chamar({
  to: paraNumero(jid),
  type: 'interactive',
  interactive: {
    type: 'button',
    body: { text: texto.slice(0, 1024) },
    action: { buttons: botoes.slice(0, 3).map((b) => ({ type: 'reply', reply: { id: b.id.slice(0, 256), title: b.titulo.slice(0, 20) } })) },
  },
});

// Sem consulta de "tem WhatsApp?" na API oficial: só ajeita o número (o código de confirmação prova que existe)
export async function resolverNumero(telefone) {
  let numero = String(telefone).replace(/\D/g, '');
  if (numero.length === 10 || numero.length === 11) numero = `55${numero}`;
  if (numero.length < 12 || numero.length > 13) throw new Error('Número inválido. Use DDD + número, ex.: 45 99999-9999');
  return `${numero}@s.whatsapp.net`;
}

// ---------- webhook (o que a Meta manda pra gente) ----------
const jaVistas = new Set(); // a Meta pode reenviar o mesmo evento
function primeiraVez(id) {
  if (!id || jaVistas.has(id)) return false;
  jaVistas.add(id);
  if (jaVistas.size > 2000) jaVistas.delete(jaVistas.values().next().value);
  return true;
}

function assinaturaOk(req) {
  if (!APP_SECRET) return true;
  const recebida = String(req.get('x-hub-signature-256') || '');
  const esperada = `sha256=${createHmac('sha256', APP_SECRET).update(req.rawBody || Buffer.alloc(0)).digest('hex')}`;
  return recebida.length === esperada.length && timingSafeEqual(Buffer.from(recebida), Buffer.from(esperada));
}

async function tratarEvento(corpo) {
  for (const entrada of corpo?.entry || []) {
    for (const mudanca of entrada.changes || []) {
      const v = mudanca.value || {};
      for (const st of v.statuses || []) {
        if (st.status === 'failed') console.error(`Aviso não entregue (${st.id?.slice(-8)}):`, st.errors?.[0]?.title || st.errors?.[0]?.message || 'erro');
      }
      for (const m of v.messages || []) {
        if (!primeiraVez(m.id)) continue;
        const numero = String(m.from || '').replace(/\D/g, '');
        const jid = `${numero}@s.whatsapp.net`;
        try {
          if (m.type === 'text' && aoReceber) {
            await aoReceber({ jid, numero, texto: m.text?.body || '', citadaId: m.context?.id || null });
          } else if (m.type === 'button' && aoEscolher) { // botão do modelo
            await aoEscolher({ jid, numero, mensagemId: m.context?.id || null, payload: m.button?.payload || '', texto: m.button?.text || '' });
          } else if (m.type === 'interactive' && aoEscolher) { // lista ou botão interativo
            const r = m.interactive?.list_reply || m.interactive?.button_reply || {};
            await aoEscolher({ jid, numero, mensagemId: m.context?.id || null, payload: r.id || '', texto: r.title || '' });
          }
        } catch (e) {
          console.error('Erro ao tratar mensagem recebida (API oficial):', e.message);
        }
      }
    }
  }
}

export function rotasWebhook(app) {
  // A Meta confere o endereço uma vez, quando você cadastra o webhook
  app.get('/webhook/whatsapp', (req, res) => {
    if (req.query['hub.mode'] === 'subscribe' && VERIFY && req.query['hub.verify_token'] === VERIFY) return res.send(String(req.query['hub.challenge'] || ''));
    res.sendStatus(403);
  });
  app.post('/webhook/whatsapp', (req, res) => {
    if (!assinaturaOk(req)) return res.sendStatus(401);
    res.sendStatus(200); // responde na hora; a Meta reenvia se demorar
    tratarEvento(req.body).catch((e) => console.error('Erro no webhook do WhatsApp:', e.message));
  });
}
