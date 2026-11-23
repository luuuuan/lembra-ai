// Criptografia dos dados pessoais guardados no banco.
//
// - Cifra: AES-256-GCM (padrão de mercado, autenticada: se alguém mexer no dado cifrado, a leitura falha
//   em vez de devolver lixo). IV aleatório de 96 bits em cada gravação.
// - Cada valor fica "preso" à sua tabela, coluna e linha (dado associado do GCM): copiar o e-mail cifrado
//   de uma conta pra outra, ou de uma coluna pra outra, não funciona.
// - Busca sem decifrar: e-mail e WhatsApp também ganham um "índice cego" (HMAC-SHA256 com chave própria),
//   que permite achar a conta no login ou pelo número sem guardar o dado aberto.
// - As duas chaves (cifra e índice) são derivadas da CHAVE_DADOS com HKDF-SHA256.
// - Troca de chave: coloque a nova em CHAVE_DADOS e a antiga em CHAVE_DADOS_ANTIGAS. Ao subir, o servidor
//   lê com a antiga e regrava tudo com a nova (veja migrar-cripto.js).
import { createCipheriv, createDecipheriv, createHmac, hkdfSync, randomBytes } from 'node:crypto';

const PREFIXO = 'c1'; // versão do formato: c1.<id da chave>.<iv>.<cifrado>.<tag>
const PREFIXO_INDICE = 'i1.';

function lerChave(texto, nome) {
  const t = String(texto || '').trim();
  let bytes = null;
  if (/^[0-9a-f]{64}$/i.test(t)) bytes = Buffer.from(t, 'hex');
  else if (t) bytes = Buffer.from(t, 'base64');
  if (!bytes || bytes.length !== 32) {
    throw new Error(`${nome} precisa ter 32 bytes (base64 ou hex). Gere uma com: npm run gerar-chave`);
  }
  const derivar = (info) => Buffer.from(hkdfSync('sha256', bytes, Buffer.from('lembra-ai'), Buffer.from(info), 32));
  const id = createHmac('sha256', bytes).update('id-da-chave').digest('hex').slice(0, 8);
  return { id, cifra: derivar('cifra-v1'), indice: derivar('indice-v1') };
}

let ATUAL = null;
let TODAS = new Map();

export function configurarChaves(principal = process.env.CHAVE_DADOS, antigas = process.env.CHAVE_DADOS_ANTIGAS) {
  if (!String(principal || '').trim()) {
    throw new Error('Falta a variável CHAVE_DADOS (chave da criptografia dos dados). Gere uma com: npm run gerar-chave');
  }
  ATUAL = lerChave(principal, 'CHAVE_DADOS');
  TODAS = new Map([[ATUAL.id, ATUAL]]);
  for (const t of String(antigas || '').split(',').map((x) => x.trim()).filter(Boolean)) {
    const k = lerChave(t, 'CHAVE_DADOS_ANTIGAS');
    if (!TODAS.has(k.id)) TODAS.set(k.id, k);
  }
  return ATUAL.id;
}

const chave = () => {
  if (!ATUAL) configurarChaves();
  return ATUAL;
};
export const idChaveAtual = () => chave().id;

// contexto = "tabela.coluna:idDaLinha" (vai como dado associado: amarra o valor ao lugar dele)
export function cifrar(valor, contexto) {
  if (valor === null || valor === undefined) return null;
  const k = chave();
  const iv = randomBytes(12);
  const c = createCipheriv('aes-256-gcm', k.cifra, iv);
  c.setAAD(Buffer.from(String(contexto)));
  const cifrado = Buffer.concat([c.update(String(valor), 'utf8'), c.final()]);
  return [PREFIXO, k.id, iv.toString('base64url'), cifrado.toString('base64url'), c.getAuthTag().toString('base64url')].join('.');
}

export const estaCifrado = (v) => typeof v === 'string' && v.startsWith(`${PREFIXO}.`);
// Cifrado com a chave de agora? (se não, a migração regrava)
export const cifradoComAtual = (v) => typeof v === 'string' && v.startsWith(`${PREFIXO}.${chave().id}.`);

export function decifrar(valor, contexto) {
  if (valor === null || valor === undefined) return null;
  if (!estaCifrado(valor)) return valor; // dado antigo, ainda aberto: a migração cifra na subida
  const [, id, iv, cifrado, tag] = valor.split('.');
  if (!TODAS.size) chave();
  const k = TODAS.get(id);
  if (!k) throw new Error(`Dado cifrado com uma chave que o servidor não tem (${id}). Confira CHAVE_DADOS/CHAVE_DADOS_ANTIGAS.`);
  const d = createDecipheriv('aes-256-gcm', k.cifra, Buffer.from(iv, 'base64url'));
  d.setAAD(Buffer.from(String(contexto)));
  d.setAuthTag(Buffer.from(tag, 'base64url'));
  return Buffer.concat([d.update(Buffer.from(cifrado, 'base64url')), d.final()]).toString('utf8');
}

// Índice cego: mesmo dado -> mesmo índice (dá pra buscar), mas não dá pra voltar ao dado.
export function indice(tipo, valor, k = chave()) {
  if (valor === null || valor === undefined || valor === '') return null;
  const normal = tipo === 'email' ? String(valor).trim().toLowerCase() : String(valor).trim();
  return PREFIXO_INDICE + createHmac('sha256', k.indice).update(`${tipo}:${normal}`).digest('base64url');
}
export const ehIndice = (v) => typeof v === 'string' && v.startsWith(PREFIXO_INDICE);

// ---------- atalhos por tabela ----------
export const ctx = (tabela, coluna, id) => `${tabela}.${coluna}:${id}`;

// Conta: devolve os campos abertos (só os que vieram no select)
export function abrirConta(c) {
  if (!c) return c;
  const out = { ...c };
  for (const col of ['nome', 'email', 'telefone', 'telefone_jid', 'telefone_pendente', 'jid_pendente']) {
    if (col in out) out[col] = decifrar(out[col], ctx('contas', col, c.id));
  }
  for (const col of ['email_indice', 'telefone_jid_indice', 'jid_pendente_indice']) delete out[col];
  return out;
}

// Conta: cifra os campos pessoais que estiverem no objeto e preenche os índices de busca
export function fecharConta(id, campos) {
  const out = { ...campos };
  for (const col of ['nome', 'email', 'telefone', 'telefone_jid', 'telefone_pendente', 'jid_pendente']) {
    if (col in out) out[col] = cifrar(out[col], ctx('contas', col, id));
  }
  if ('email' in campos) out.email_indice = indice('email', campos.email);
  if ('telefone_jid' in campos) out.telefone_jid_indice = indice('jid', campos.telefone_jid);
  if ('jid_pendente' in campos) out.jid_pendente_indice = indice('jid', campos.jid_pendente);
  return out;
}

// Lembrete: nome da conta, valor e mensagem personalizada ficam cifrados
export function abrirLembrete(l) {
  if (!l) return l;
  const out = { ...l };
  if ('titulo' in out) out.titulo = decifrar(out.titulo, ctx('lembretes', 'titulo', l.id));
  if ('mensagem' in out) out.mensagem = decifrar(out.mensagem, ctx('lembretes', 'mensagem', l.id));
  if ('valor_cifrado' in out || 'valor' in out) {
    const v = out.valor_cifrado ? decifrar(out.valor_cifrado, ctx('lembretes', 'valor', l.id)) : out.valor;
    out.valor = v === null || v === undefined || v === '' ? null : Number(v);
    delete out.valor_cifrado;
  }
  return out;
}

export function fecharLembrete(id, campos) {
  const out = { ...campos };
  if ('titulo' in out) out.titulo = cifrar(out.titulo, ctx('lembretes', 'titulo', id));
  if ('mensagem' in out) out.mensagem = cifrar(out.mensagem, ctx('lembretes', 'mensagem', id));
  if ('valor' in out) {
    out.valor_cifrado = out.valor === null || out.valor === undefined ? null : cifrar(String(out.valor), ctx('lembretes', 'valor', id));
    out.valor = null; // a coluna antiga (aberta) fica sempre vazia
  }
  return out;
}

// Texto de um aviso enviado (tem nome, conta e valor)
export const cifrarTextoEnvio = (id, texto) => cifrar(texto, ctx('envios', 'texto', id));
export const decifrarTextoEnvio = (id, texto) => decifrar(texto, ctx('envios', 'texto', id));
