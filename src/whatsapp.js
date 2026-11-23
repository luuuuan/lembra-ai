// O WhatsApp do sistema: um número só (o seu chip), que manda os lembretes pra todo mundo.
// A sessão fica no Supabase (tabela sistema_auth), porque o disco do Render free é apagado a cada restart.
import makeWASocket, {
  Browsers,
  BufferJSON,
  DisconnectReason,
  fetchLatestBaileysVersion,
  initAuthCreds,
  makeCacheableSignalKeyStore,
  proto,
  isJidGroup,
  isJidBroadcast,
  isLidUser,
  isPnUser,
  decryptPollVote,
  jidNormalizedUser,
} from 'baileys';
import { createHash, randomBytes } from 'node:crypto';
import pino from 'pino';
import { supabase } from './supabase.js';
import { cifrar, decifrar, ctx } from './cripto.js';

const logger = pino({ level: process.env.LOG_LEVEL || 'warn' });
const TABELA = 'sistema_auth';

// ---------- sessão no Supabase ----------
// As chaves da sessão do WhatsApp (quem tiver isso controla o número) ficam cifradas: { c: "c1...." }
export const fecharSessao = (id, valor) => ({ c: cifrar(JSON.stringify(valor, BufferJSON.replacer), ctx('sistema_auth', 'data', id)) });
export const abrirSessao = (id, data) => (data && typeof data.c === 'string'
  ? JSON.parse(decifrar(data.c, ctx('sistema_auth', 'data', id)), BufferJSON.reviver)
  : JSON.parse(JSON.stringify(data), BufferJSON.reviver)); // formato antigo, ainda aberto

async function gravar(linhas) {
  if (!linhas.length) return;
  const { error } = await supabase.from(TABELA).upsert(
    linhas.map(({ id, valor }) => ({ id, data: fecharSessao(id, valor), updated_at: new Date().toISOString() })),
  );
  if (error) throw error;
}

async function apagar(ids) {
  if (!ids.length) return;
  const { error } = await supabase.from(TABELA).delete().in('id', ids);
  if (error) throw error;
}

async function apagarSessao() {
  const { error } = await supabase.from(TABELA).delete().neq('id', '');
  if (error) throw error;
}

async function carregarSessao() {
  const { data, error } = await supabase.from(TABELA).select('data').eq('id', 'creds').maybeSingle();
  if (error) throw error;
  const creds = data ? abrirSessao('creds', data.data) : initAuthCreds();
  return {
    temSessao: Boolean(data),
    state: {
      creds,
      keys: {
        get: async (tipo, ids) => {
          const resultado = {};
          if (!ids.length) return resultado;
          const { data: linhas, error: erro } = await supabase
            .from(TABELA).select('id, data').in('id', ids.map((id) => `${tipo}-${id}`));
          if (erro) throw erro;
          const mapa = new Map((linhas || []).map((l) => [l.id, abrirSessao(l.id, l.data)]));
          for (const id of ids) {
            let valor = mapa.get(`${tipo}-${id}`) ?? null;
            if (tipo === 'app-state-sync-key' && valor) valor = proto.Message.AppStateSyncKeyData.fromObject(valor);
            resultado[id] = valor;
          }
          return resultado;
        },
        set: async (dados) => {
          const salvar = [];
          const remover = [];
          for (const tipo in dados) {
            for (const id in dados[tipo]) {
              const valor = dados[tipo][id];
              if (valor) salvar.push({ id: `${tipo}-${id}`, valor });
              else remover.push(`${tipo}-${id}`);
            }
          }
          await Promise.all([gravar(salvar), apagar(remover)]);
        },
      },
    },
    saveCreds: () => gravar([{ id: 'creds', valor: creds }]),
  };
}

// ---------- conexão ----------
// status: desconectado | iniciando | aguardando_qr | conectado
const sistema = { sock: null, status: 'desconectado', qr: null, aviso: null, tentativas: 0, encerrado: false, numero: null };

export const getStatus = () => ({
  status: sistema.status, aviso: sistema.aviso, numero: sistema.numero, temQr: Boolean(sistema.qr),
});
export const getQr = () => sistema.qr;

// Quem quer saber das mensagens que chegam (o "paguei" etc.) e dos votos nas enquetes
let aoReceber = null;
export const quandoChegarMensagem = (fn) => { aoReceber = fn; };
let aoVotar = null;
export const quandoChegarVoto = (fn) => { aoVotar = fn; };

// Voto numa enquete (já vem dentro de ephemeral quando a conversa tem mensagens temporárias)
const votoDa = (m) => m?.pollUpdateMessage || m?.ephemeralMessage?.message?.pollUpdateMessage || null;

const textoDa = (m) =>
  m?.conversation || m?.extendedTextMessage?.text || m?.ephemeralMessage?.message?.extendedTextMessage?.text
  || m?.ephemeralMessage?.message?.conversation || '';
const citadaDa = (m) =>
  m?.extendedTextMessage?.contextInfo?.stanzaId
  || m?.ephemeralMessage?.message?.extendedTextMessage?.contextInfo?.stanzaId || null;

// Descobre o número (só dígitos) de quem mandou. No WhatsApp novo algumas conversas
// chegam com um id "@lid" em vez do número: aí usa o campo alternativo ou a tabela de conversão.
async function numeroDoRemetente(sock, chave) {
  for (const jid of [chave.remoteJid, chave.remoteJidAlt]) {
    if (jid && isPnUser(jid)) return jid.split('@')[0].split(':')[0];
  }
  const lid = [chave.remoteJid, chave.remoteJidAlt].find((j) => j && isLidUser(j));
  if (lid) {
    const pn = await sock.signalRepository?.lidMapping?.getPNForLID?.(lid).catch(() => null);
    if (pn) return pn.split('@')[0].split(':')[0];
  }
  return null;
}
export const online = () => sistema.status === 'conectado';

export async function conectar() {
  if (['iniciando', 'aguardando_qr', 'conectado'].includes(sistema.status)) return;
  Object.assign(sistema, { status: 'iniciando', qr: null, aviso: null, encerrado: false });

  const { state, saveCreds } = await carregarSessao();
  const { version } = await fetchLatestBaileysVersion().catch(() => ({}));
  let teveQr = false;

  const sock = makeWASocket({
    version,
    logger,
    auth: { creds: state.creds, keys: makeCacheableSignalKeyStore(state.keys, logger) },
    browser: Browsers.ubuntu('Lembretes'),
    markOnlineOnConnect: false,
    syncFullHistory: false,
  });
  sistema.sock = sock;
  sock.ev.on('creds.update', saveCreds);

  sock.ev.on('messages.upsert', async ({ messages, type }) => {
    if (type !== 'notify' || !aoReceber) return;
    for (const msg of messages) {
      try {
        const chave = msg.key || {};
        if (chave.fromMe || !chave.remoteJid || isJidGroup(chave.remoteJid) || isJidBroadcast(chave.remoteJid)) continue;
        const voto = votoDa(msg.message);
        if (voto?.pollCreationMessageKey?.id && voto.vote) {
          if (aoVotar) await aoVotar({ jid: chave.remoteJid, enqueteId: voto.pollCreationMessageKey.id, voto: { cifrado: voto.vote, chave } });
          continue;
        }
        const texto = textoDa(msg.message).trim();
        if (!texto) continue; // figurinha, áudio, foto... ignora
        const numero = await numeroDoRemetente(sock, chave);
        await aoReceber({ jid: chave.remoteJid, numero, texto, citadaId: citadaDa(msg.message) });
      } catch (e) {
        console.error('Erro ao tratar mensagem recebida:', e.message);
      }
    }
  });

  sock.ev.on('connection.update', async ({ connection, lastDisconnect, qr }) => {
    if (sistema.sock !== sock) return;

    if (qr) {
      teveQr = true;
      Object.assign(sistema, { qr, status: 'aguardando_qr' });
    }

    if (connection === 'open') {
      const numero = sock.user?.id?.split(':')[0]?.split('@')[0] || null;
      Object.assign(sistema, { qr: null, status: 'conectado', tentativas: 0, aviso: null, numero });
      console.log(`WhatsApp do sistema conectado (${numero}).`);
    }

    if (connection === 'close') {
      Object.assign(sistema, { status: 'desconectado', qr: null });
      if (sistema.encerrado) return;
      const codigo = lastDisconnect?.error?.output?.statusCode;

      if (codigo === DisconnectReason.loggedOut) {
        sistema.aviso = 'O número foi desconectado pelo celular. Gere um QR code novo.';
        console.log('WhatsApp do sistema removido no celular. Sessão apagada.');
        await apagarSessao().catch((e) => console.error('Erro ao limpar sessão:', e.message));
        return;
      }
      if (!state.creds.registered && !state.creds.me) {
        sistema.aviso = teveQr
          ? 'O QR code expirou antes de ser lido. Gere outro e escaneie em até 1 minuto.'
          : 'Não consegui falar com o WhatsApp agora. Tente de novo em instantes.';
        console.log(`Conexão encerrada sem leitura do QR (código ${codigo}).`);
        return;
      }

      sistema.tentativas += 1;
      const espera = Math.min(60_000, 2_000 * sistema.tentativas);
      console.log(`Conexão caiu (código ${codigo}). Reconectando em ${espera / 1000}s...`);
      setTimeout(() => conectar().catch((e) => console.error('Falha ao reconectar:', e.message)), espera);
    }
  });
}

export async function desconectar() {
  sistema.encerrado = true;
  await sistema.sock?.logout().catch(() => {});
  sistema.sock?.end?.(undefined);
  Object.assign(sistema, { sock: null, status: 'desconectado', qr: null, numero: null, aviso: null });
  await apagarSessao();
}

// Na subida do servidor: se já tinha lido o QR antes, reconecta sozinho
export async function iniciar() {
  const { data } = await supabase.from(TABELA).select('id').eq('id', 'creds').maybeSingle();
  if (data) await conectar();
  return Boolean(data);
}

function sockConectado() {
  if (!sistema.sock || sistema.status !== 'conectado') throw new Error('O WhatsApp do sistema está fora do ar');
  return sistema.sock;
}

// Número (com ou sem 55, com ou sem máscara) -> id do WhatsApp. Dá erro se o número não tiver WhatsApp.
export async function resolverNumero(telefone) {
  const sock = sockConectado();
  let numero = String(telefone).replace(/\D/g, '');
  if (numero.length === 10 || numero.length === 11) numero = `55${numero}`;
  if (numero.length < 12 || numero.length > 13) throw new Error('Número inválido. Use DDD + número, ex.: 45 99999-9999');
  const [resultado] = await sock.onWhatsApp(numero);
  if (!resultado?.exists) throw new Error('Esse número não tem WhatsApp');
  return resultado.jid;
}

// ---------- enquetes (o "botão" possível sem a API oficial) ----------
const hashOpcao = (nome) => createHash('sha256').update(Buffer.from(nome)).digest('hex');

// Manda uma enquete de escolha única. Devolve o id e o segredo (precisa guardar pra ler os votos depois).
export async function enviarEnquete(jid, { pergunta, opcoes }) {
  const segredo = randomBytes(32);
  const enviada = await sockConectado().sendMessage(jid, {
    poll: { name: pergunta.slice(0, 255), values: opcoes, selectableCount: 1, messageSecret: segredo },
  });
  return { id: enviada?.key?.id || null, segredo: segredo.toString('base64') };
}

// Abre o voto: o WhatsApp manda cifrado (AES-GCM) com uma chave derivada do segredo da enquete,
// do id dela, de quem criou e de quem votou. Como "quem" pode vir como número ou como @lid,
// tenta as combinações até a cifra fechar. Devolve o nome da opção escolhida (ou null se desmarcou).
export function lerVoto({ cifrado, chave }, { enqueteId, segredo, opcoes }, eu = sistema.sock?.user) {
  const norm = (j) => { try { return j ? jidNormalizedUser(j) : null; } catch { return null; } };
  const criadores = [...new Set([eu?.id, eu?.lid].map(norm).filter(Boolean))];
  const votantes = [...new Set([chave.participant, chave.participantAlt, chave.remoteJid, chave.remoteJidAlt].map(norm).filter(Boolean))];
  const pollEncKey = Buffer.from(segredo, 'base64');
  for (const pollCreatorJid of criadores) {
    for (const voterJid of votantes) {
      try {
        const voto = decryptPollVote(cifrado, { pollCreatorJid, pollMsgId: enqueteId, pollEncKey, voterJid });
        const escolhidas = (voto.selectedOptions || []).map((o) => Buffer.from(o).toString('hex'));
        return opcoes.find((nome) => escolhidas.includes(hashOpcao(nome))) || null;
      } catch { /* combinação errada: tenta a próxima */ }
    }
  }
  throw new Error('Não consegui ler o voto da enquete');
}

// Devolve o id da mensagem enviada (pra saber depois a qual aviso a pessoa respondeu)
export async function enviarTexto(jid, texto) {
  const enviada = await sockConectado().sendMessage(jid, { text: texto });
  return enviada?.key?.id || null;
}
