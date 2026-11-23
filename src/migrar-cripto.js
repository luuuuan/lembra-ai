// Roda toda vez que o servidor sobe, antes de atender ninguém:
//  - cifra o que ainda estiver aberto no banco (contas criadas antes da criptografia existir);
//  - regrava com a chave nova o que estiver cifrado com uma chave antiga (troca de chave);
//  - preenche os índices de busca (e-mail e WhatsApp).
// Pode rodar quantas vezes for: o que já está certo é pulado.
import { BufferJSON } from 'baileys';
import { supabase } from './supabase.js';
import {
  abrirConta, fecharConta, abrirLembrete, fecharLembrete, cifradoComAtual, indice, ehIndice,
  cifrarTextoEnvio, decifrarTextoEnvio, cifrar, decifrar, ctx,
} from './cripto.js';

const POR_VEZ = 500;

// Lê a tabela inteira em páginas (o Supabase devolve no máximo 1000 linhas por consulta)
async function todas(tabela, colunas) {
  const linhas = [];
  for (let de = 0; ; de += POR_VEZ) {
    const { data, error } = await supabase.from(tabela).select(colunas).order('id').range(de, de + POR_VEZ - 1);
    if (error) throw error;
    linhas.push(...(data || []));
    if (!data || data.length < POR_VEZ) break;
  }
  return linhas;
}

const precisa = (v) => v !== null && v !== undefined && !cifradoComAtual(v);

async function migrarContas() {
  const cols = ['nome', 'email', 'telefone', 'telefone_jid', 'telefone_pendente', 'jid_pendente'];
  let n = 0;
  for (const linha of await todas('contas', `id, ${cols.join(', ')}, email_indice, telefone_jid_indice, jid_pendente_indice`)) {
    const aberta = abrirConta(linha);
    const faltaIndice = linha.email_indice !== indice('email', aberta.email)
      || (linha.telefone_jid_indice ?? null) !== indice('jid', aberta.telefone_jid)
      || (linha.jid_pendente_indice ?? null) !== indice('jid', aberta.jid_pendente);
    if (!cols.some((c) => precisa(linha[c])) && !faltaIndice) continue;
    const campos = Object.fromEntries(cols.map((c) => [c, aberta[c] ?? null]));
    const { error } = await supabase.from('contas').update(fecharConta(linha.id, campos)).eq('id', linha.id);
    if (error) throw error;
    n++;
  }
  return n;
}

async function migrarLembretes() {
  let n = 0;
  for (const linha of await todas('lembretes', 'id, titulo, mensagem, valor, valor_cifrado')) {
    const valorAberto = linha.valor !== null && linha.valor !== undefined;
    if (!precisa(linha.titulo) && !precisa(linha.mensagem) && !precisa(linha.valor_cifrado) && !valorAberto) continue;
    const aberto = abrirLembrete(linha);
    const { error } = await supabase.from('lembretes')
      .update(fecharLembrete(linha.id, { titulo: aberto.titulo, mensagem: aberto.mensagem, valor: aberto.valor }))
      .eq('id', linha.id);
    if (error) throw error;
    n++;
  }
  return n;
}

async function migrarEnvios() {
  let n = 0;
  for (const linha of await todas('envios', 'id, texto')) {
    if (!precisa(linha.texto)) continue;
    const { error } = await supabase.from('envios')
      .update({ texto: cifrarTextoEnvio(linha.id, decifrarTextoEnvio(linha.id, linha.texto)) }).eq('id', linha.id);
    if (error) throw error;
    n++;
  }
  return n;
}

// Números de quem escreveu sem ter conta: viram índice (não precisa saber o número, só se já foi convidado)
async function migrarDesconhecidos() {
  const { data, error } = await supabase.from('contatos_desconhecidos').select('chave, respondido_em, vezes');
  if (error) throw error;
  let n = 0;
  for (const linha of data || []) {
    if (ehIndice(linha.chave)) continue;
    const { error: e1 } = await supabase.from('contatos_desconhecidos')
      .upsert({ chave: indice('contato', linha.chave), respondido_em: linha.respondido_em, vezes: linha.vezes });
    if (e1) throw e1;
    const { error: e2 } = await supabase.from('contatos_desconhecidos').delete().eq('chave', linha.chave);
    if (e2) throw e2;
    n++;
  }
  return n;
}

// Segredos das enquetes (só regrava quando troca de chave; já nascem cifrados)
async function migrarEnquetes() {
  let n = 0;
  for (const linha of await todas('enquetes', 'id, segredo')) {
    if (!precisa(linha.segredo)) continue;
    const contexto = ctx('enquetes', 'segredo', linha.id);
    const { error } = await supabase.from('enquetes').update({ segredo: cifrar(decifrar(linha.segredo, contexto), contexto) }).eq('id', linha.id);
    if (error) throw error;
    n++;
  }
  return n;
}

// Sessão do WhatsApp do sistema
async function migrarSessao() {
  let n = 0;
  for (const linha of await todas('sistema_auth', 'id, data')) {
    if (linha.data && typeof linha.data.c === 'string' && cifradoComAtual(linha.data.c)) continue;
    const contexto = ctx('sistema_auth', 'data', linha.id);
    const valor = linha.data && typeof linha.data.c === 'string' ? JSON.parse(decifrar(linha.data.c, contexto)) : linha.data;
    const { error } = await supabase.from('sistema_auth')
      .update({ data: { c: cifrar(JSON.stringify(valor, BufferJSON.replacer), contexto) } }).eq('id', linha.id);
    if (error) throw error;
    n++;
  }
  return n;
}

export async function migrarCriptografia() {
  const r = {
    contas: await migrarContas(),
    lembretes: await migrarLembretes(),
    avisos: await migrarEnvios(),
    desconhecidos: await migrarDesconhecidos(),
    sessao: await migrarSessao(),
    enquetes: await migrarEnquetes(),
  };
  const total = Object.values(r).reduce((a, b) => a + b, 0);
  if (total) console.log(`Criptografia: ${Object.entries(r).filter(([, v]) => v).map(([k, v]) => `${v} ${k}`).join(', ')} cifrado(s) agora.`);
  return r;
}
