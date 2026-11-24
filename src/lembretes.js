// Regras dos lembretes: calcula quando cada aviso sai, monta o texto e dispara.
// Datas sempre no horário de Brasília (UTC-3, sem horário de verão).
import cron from 'node-cron';
import { supabase } from './supabase.js';
import { online, enviarTexto, enviarEnquete, enviarModeloAviso, MODO } from './whatsapp.js';
import { situacaoDasContas, noPlano } from './planos.js';
import { abrirConta, abrirLembrete, cifrarTextoEnvio, cifrar, ctx } from './cripto.js';

const FUSO = '-03:00';
const HORIZONTE_DIAS = 45; // gera os avisos dos próximos 45 dias
const MAX_ATRASO_MIN = Number(process.env.MAX_ATRASO_MIN || 720); // se atrasar mais que isso, não manda

export const TIPOS = {
  luz: { emoji: '💡', titulo: 'Conta de luz' },
  agua: { emoji: '💧', titulo: 'Conta de água' },
  internet: { emoji: '🌐', titulo: 'Internet' },
  aluguel: { emoji: '🏠', titulo: 'Aluguel' },
  cartao: { emoji: '💳', titulo: 'Fatura do cartão' },
  boleto: { emoji: '🧾', titulo: 'Boleto' },
  outro: { emoji: '📌', titulo: 'Lembrete' },
};

// ---------- datas ----------
const doisDig = (n) => String(n).padStart(2, '0');
const dataStr = (a, m, d) => `${a}-${doisDig(m)}-${doisDig(d)}`;
const ultimoDia = (a, m) => new Date(Date.UTC(a, m, 0)).getUTCDate(); // m de 1 a 12

export function hojeBR(agora = new Date()) {
  const br = new Date(agora.getTime() - 3 * 3600_000);
  return { a: br.getUTCFullYear(), m: br.getUTCMonth() + 1, d: br.getUTCDate(), str: br.toISOString().slice(0, 10) };
}

// Dia 31 em mês de 30 dias (ou fevereiro) vira o último dia do mês
export function vencimentosMensais(dia, agora = new Date(), meses = 3) {
  const { a, m } = hojeBR(agora);
  const lista = [];
  for (let k = 0; k < meses; k++) {
    const mes = ((m - 1 + k) % 12) + 1;
    const ano = a + Math.floor((m - 1 + k) / 12);
    lista.push(dataStr(ano, mes, Math.min(dia, ultimoDia(ano, mes))));
  }
  return lista;
}

export function momentoDoAviso(vencimento, diasAntes, horario) {
  const [h, min] = String(horario || '09:00').split(':');
  const base = new Date(`${vencimento}T${doisDig(h)}:${doisDig(min)}:00${FUSO}`);
  return new Date(base.getTime() - diasAntes * 86_400_000);
}

export function vencimentosDo(lembrete, agora = new Date()) {
  return lembrete.frequencia === 'unica' ? [lembrete.data] : vencimentosMensais(lembrete.dia, agora);
}

// pagos: Set com "lembreteId|AAAA-MM-DD" das contas já pagas (pula esses vencimentos)
export function proximoVencimento(lembrete, agora = new Date(), pagos = new Set()) {
  const hoje = hojeBR(agora).str;
  return vencimentosDo(lembrete, agora).find((v) => v >= hoje && !pagos.has(`${lembrete.id}|${v}`)) || null;
}

export const chavePago = (lembreteId, vencimento) => `${lembreteId}|${vencimento}`;

export async function pagamentosDe(lembreteIds) {
  if (!lembreteIds.length) return new Set();
  const { data, error } = await supabase.from('pagamentos').select('lembrete_id, vencimento').in('lembrete_id', lembreteIds);
  if (error) throw error;
  return new Set((data || []).map((p) => chavePago(p.lembrete_id, p.vencimento)));
}

// ---------- texto ----------
const fmtValor = (v) =>
  v === null || v === undefined || v === '' ? '' : Number(v).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
const fmtData = (iso) => `${iso.slice(8, 10)}/${iso.slice(5, 7)}`;
const quando = (d) => (d < 0 ? 'já venceu' : d === 0 ? 'hoje' : d === 1 ? 'amanhã' : `em ${d} dias`);

export const RODAPE = '\n\n_Já pagou? Responda *paguei* que eu paro de lembrar._';

export function montarTexto({ lembrete, nome, vencimento, diasAntes, rodape = true }) {
  return montarCorpo({ lembrete, nome, vencimento, diasAntes }) + (rodape ? RODAPE : '');
}

function montarCorpo({ lembrete, nome, vencimento, diasAntes }) {
  const tipo = TIPOS[lembrete.tipo] || TIPOS.outro;
  const primeiroNome = String(nome || '').trim().split(/\s+/)[0] || '';
  const valor = fmtValor(lembrete.valor);
  const data = fmtData(vencimento);

  if (lembrete.mensagem?.trim()) {
    return lembrete.mensagem
      .replaceAll('{nome}', primeiroNome)
      .replaceAll('{conta}', lembrete.titulo)
      .replaceAll('{valor}', valor)
      .replaceAll('{vencimento}', data)
      .replaceAll('{quando}', quando(diasAntes))
      .replace(/[ \t]{2,}/g, ' ') // marcador vazio (ex.: sem valor) não deixa espaço sobrando
      .replace(/ ([.,!?)])/g, '$1')
      .trim();
  }

  const oi = primeiroNome ? `Oi, ${primeiroNome}!` : 'Oi!';
  const deValor = valor ? ` de *${valor}*` : '';
  if (diasAntes < 0) { // lembrete adiado que chegou depois do vencimento
    return `${tipo.emoji} ${oi} Passando de novo: *${lembrete.titulo}*${deValor} venceu dia ${data}.`;
  }
  if (diasAntes === 0) {
    return `${tipo.emoji} ${oi} Hoje é o dia: *${lembrete.titulo}*${deValor} vence *hoje* (${data}). Não esquece! 😉`;
  }
  return `${tipo.emoji} ${oi} Lembrete: *${lembrete.titulo}*${deValor} vence *${quando(diasAntes)}*, dia ${data}.`;
}

// ---------- enquete no aviso ----------
// O aviso sai como enquete: a pessoa toca numa opção em vez de digitar. "paguei" digitado continua valendo.
// Pra voltar ao aviso só de texto, coloque AVISO_COM_ENQUETE=0 no Render.
export const ENQUETE_LIGADA = MODO === 'oficial' || process.env.AVISO_COM_ENQUETE !== '0';

// API oficial: o aviso sai pelo modelo aprovado "Oi, {{1}}! Lembrete da conta *{{2}}*: {{3}}."
export function partesDoAviso({ lembrete, nome, vencimento, diasAntes }) {
  const primeiroNome = String(nome || '').trim().split(/\s+/)[0] || 'tudo bem';
  const valor = fmtValor(lembrete.valor);
  const data = fmtData(vencimento);
  const situacao = diasAntes < 0 ? `venceu dia ${data}` : diasAntes === 0 ? `vence hoje, dia ${data}`
    : diasAntes === 1 ? `vence amanhã, dia ${data}` : `vence em ${diasAntes} dias, dia ${data}`;
  return { nome: primeiroNome, conta: `${lembrete.titulo}${valor ? ` de ${valor}` : ''}`, situacao };
}
export const textoDoModelo = (p) => `Oi, ${p.nome}! Lembrete da conta *${p.conta}*: ${p.situacao}.`;
export const OPCOES = {
  aviso: { pago: '✅ Já paguei', adiar: '⏰ Me lembra mais tarde' },
  adiar: { h1: 'Daqui 1 hora', h3: 'Daqui 3 horas', noite: 'Hoje à noite (20h)', amanha: 'Amanhã de manhã (9h)' },
  pago: { desfazer: '↩️ Desfazer' }, // botão depois do "Pagamento anotado" (API oficial)
};
const semFormatacao = (t) => t.replace(/[*_~]/g, '');

// Guarda a enquete (com o segredo cifrado) pra conseguir ler o voto depois
export async function guardarEnquete({ id, segredo, tipo, contaId, lembreteId, vencimento }) {
  const { error } = await supabase.from('enquetes').insert({
    id, tipo, conta_id: contaId, lembrete_id: lembreteId, vencimento, segredo: cifrar(segredo, ctx('enquetes', 'segredo', id)),
  });
  if (error) throw error;
}

// Manda um aviso. Com enquete: a pergunta já é o próprio aviso (se couber); se a mensagem for longa,
// vai o texto e logo depois a enquete "Já pagou?". Devolve { msgId, texto } (texto = o que a pessoa leu).
export async function enviarAviso({ jid, contaId, lembrete, nome, vencimento, diasAntes, prefixo = '' }) {
  if (!ENQUETE_LIGADA) {
    const texto = prefixo + montarTexto({ lembrete, nome, vencimento, diasAntes });
    return { msgId: await enviarTexto(jid, texto), texto };
  }
  if (MODO === 'oficial') {
    // modelo aprovado pela Meta com os botões; mensagem personalizada do Premium vai num 2º modelo (se configurado)
    const partes = partesDoAviso({ lembrete, nome, vencimento, diasAntes });
    const personalizada = lembrete.mensagem?.trim() ? montarTexto({ lembrete, nome, vencimento, diasAntes, rodape: false }) : null;
    const id = await enviarModeloAviso(jid, { ...partes, personalizada });
    await guardarEnquete({ id, segredo: 'botoes', tipo: 'aviso', contaId, lembreteId: lembrete.id, vencimento });
    return { msgId: id, texto: personalizada || textoDoModelo(partes) };
  }
  const corpo = prefixo + montarTexto({ lembrete, nome, vencimento, diasAntes, rodape: false });
  const opcoes = Object.values(OPCOES.aviso);
  try {
    let msgId = null;
    let pergunta = semFormatacao(corpo);
    if (pergunta.length > 250) { // não cabe como pergunta da enquete
      msgId = await enviarTexto(jid, corpo);
      pergunta = 'Já pagou essa conta?';
    }
    const enquete = await enviarEnquete(jid, { pergunta, opcoes });
    await guardarEnquete({ ...enquete, tipo: 'aviso', contaId, lembreteId: lembrete.id, vencimento });
    return { msgId: msgId || enquete.id, texto: corpo };
  } catch (e) {
    console.error('Enquete falhou, mandando só texto:', e.message);
    const texto = prefixo + montarTexto({ lembrete, nome, vencimento, diasAntes });
    return { msgId: await enviarTexto(jid, texto), texto };
  }
}

// "Me lembra mais tarde": cria um aviso extra pra esse vencimento.
// dias_antes negativo marca o aviso adiado (e, por ser o horário em segundos, nunca repete).
export async function adiarAviso({ lembrete, vencimento, quando }) {
  const { error } = await supabase.from('envios').insert({
    lembrete_id: lembrete.id, conta_id: lembrete.conta_id, vencimento,
    dias_antes: -Math.floor(quando.getTime() / 1000), enviar_em: quando.toISOString(),
  });
  if (error) throw error;
}
export const ehAdiado = (envio) => envio.dias_antes < 0;
const diasAte = (vencimento) => Math.round((Date.parse(vencimento) - Date.parse(hojeBR().str)) / 86_400_000);

// ---------- geração dos avisos ----------
export function avisosPrevistos(lembrete, agora = new Date(), pagos = new Set()) {
  if (!lembrete.ativo) return [];
  const limite = agora.getTime() + HORIZONTE_DIAS * 86_400_000;
  const linhas = [];
  for (const vencimento of vencimentosDo(lembrete, agora)) {
    if (pagos.has(chavePago(lembrete.id, vencimento))) continue; // já paga: não avisa
    for (const diasAntes of [...new Set(lembrete.avisos || [0])]) {
      const quandoEnviar = momentoDoAviso(vencimento, diasAntes, lembrete.horario);
      if (quandoEnviar.getTime() <= agora.getTime() || quandoEnviar.getTime() > limite) continue; // só futuros
      linhas.push({
        lembrete_id: lembrete.id,
        conta_id: lembrete.conta_id,
        vencimento,
        dias_antes: diasAntes,
        enviar_em: quandoEnviar.toISOString(),
      });
    }
  }
  return linhas;
}

async function gravarAvisos(linhas) {
  if (!linhas.length) return 0;
  const { error } = await supabase
    .from('envios')
    .upsert(linhas, { onConflict: 'lembrete_id,vencimento,dias_antes', ignoreDuplicates: true });
  if (error) throw error;
  return linhas.length;
}

// Depois de criar/alterar/pausar um lembrete: refaz os avisos que ainda não saíram
export async function regenerar(lembrete) {
  const { error } = await supabase.from('envios').delete().eq('lembrete_id', lembrete.id).eq('status', 'pendente');
  if (error) throw error;
  const situacao = (await situacaoDasContas([lembrete.conta_id])).get(lembrete.conta_id);
  return gravarAvisos(avisosPrevistos(noPlano(lembrete, situacao), new Date(), await pagamentosDe([lembrete.id])));
}

// Depois de mudar o plano de uma conta: refaz os avisos de todos os lembretes dela
export async function regenerarConta(contaId) {
  const { data, error } = await supabase.from('lembretes').select('*').eq('conta_id', contaId);
  if (error) throw error;
  for (const l of data || []) await regenerar(abrirLembrete(l));
}

// De tempos em tempos: garante que os avisos dos próximos meses existam
export async function gerarTodos() {
  // enquetes com mais de 40 dias não recebem mais voto útil
  await supabase.from('enquetes').delete().lt('criado_em', new Date(Date.now() - 40 * 86_400_000).toISOString());
  const { data: linhas, error } = await supabase.from('lembretes').select('*').eq('ativo', true).limit(10000);
  if (error) throw error;
  const data = (linhas || []).map(abrirLembrete);
  const pagos = await pagamentosDe((data || []).map((l) => l.id));
  const situacoes = await situacaoDasContas((data || []).map((l) => l.conta_id));
  return gravarAvisos((data || []).flatMap((l) => avisosPrevistos(noPlano(l, situacoes.get(l.conta_id)), new Date(), pagos)));
}

// ---------- pagamento ----------
// Marca a conta daquele vencimento como paga e cancela os avisos que ainda iam sair
export async function marcarPago({ lembrete, vencimento, origem }) {
  const { error } = await supabase.from('pagamentos').upsert(
    { lembrete_id: lembrete.id, conta_id: lembrete.conta_id, vencimento, origem },
    { onConflict: 'lembrete_id,vencimento', ignoreDuplicates: true },
  );
  if (error) throw error;
  const { error: erro2 } = await supabase.from('envios')
    .update({ status: 'cancelado', erro: 'Conta paga' })
    .eq('lembrete_id', lembrete.id).eq('vencimento', vencimento).eq('status', 'pendente');
  if (erro2) throw erro2;
}

export async function desfazerPago({ lembrete, vencimento }) {
  const { error } = await supabase.from('pagamentos').delete().eq('lembrete_id', lembrete.id).eq('vencimento', vencimento);
  if (error) throw error;
  // os avisos cancelados que ainda estão no futuro voltam pra fila
  const { error: erro2 } = await supabase.from('envios')
    .update({ status: 'pendente', erro: null })
    .eq('lembrete_id', lembrete.id).eq('vencimento', vencimento).eq('status', 'cancelado')
    .gt('enviar_em', new Date().toISOString());
  if (erro2) throw erro2;
  await regenerar(lembrete);
}

// ---------- disparo ----------
let rodando = false;

async function marcar(id, campos) {
  const { error } = await supabase.from('envios').update(campos).eq('id', id);
  if (error) console.error(`Erro ao atualizar envio ${id}:`, error.message);
}

export async function dispararPendentes() {
  if (rodando || !online()) return; // fora do ar: os avisos esperam, e saem quando voltar (até o atraso máximo)
  rodando = true;
  try {
    const { data: envios, error } = await supabase
      .from('envios')
      .update({ status: 'enviando' })
      .eq('status', 'pendente')
      .lte('enviar_em', new Date().toISOString())
      .select('*');
    if (error) throw error;
    if (!envios?.length) return;

    const idsLembretes = [...new Set(envios.map((e) => e.lembrete_id))];
    const idsContas = [...new Set(envios.map((e) => e.conta_id))];
    const [{ data: lembretes }, { data: contas }] = await Promise.all([
      supabase.from('lembretes').select('*').in('id', idsLembretes),
      supabase.from('contas').select('id, nome, telefone_jid, telefone_verificado_em').in('id', idsContas),
    ]);
    const situacoes = await situacaoDasContas(idsContas);
    const lembretePor = new Map((lembretes || []).map(abrirLembrete).map((l) => [l.id, noPlano(l, situacoes.get(l.conta_id))]));
    const contaPor = new Map((contas || []).map((c) => [c.id, abrirConta(c)]));

    for (const envio of envios.sort((x, y) => x.enviar_em.localeCompare(y.enviar_em))) {
      const atrasoMin = (Date.now() - new Date(envio.enviar_em).getTime()) / 60_000;
      const lembrete = lembretePor.get(envio.lembrete_id);
      const conta = contaPor.get(envio.conta_id);

      if (atrasoMin > MAX_ATRASO_MIN) {
        await marcar(envio.id, { status: 'expirado', erro: `Atrasou ${Math.round(atrasoMin)} min (sistema fora do ar)` });
        continue;
      }
      if (!lembrete || !lembrete.ativo) {
        const motivo = lembrete && situacoes.get(lembrete.conta_id)?.premium === false
          ? 'Plano grátis: só os 3 primeiros lembretes funcionam' : 'Lembrete pausado ou apagado';
        await marcar(envio.id, { status: 'expirado', erro: motivo });
        continue;
      }
      if (!ehAdiado(envio) && !lembrete.avisos.includes(envio.dias_antes)) { // plano grátis: só 1 aviso por lembrete
        await marcar(envio.id, { status: 'cancelado', erro: 'Plano grátis: só 1 aviso por lembrete' });
        continue;
      }
      if (!conta?.telefone_verificado_em || !conta.telefone_jid) {
        await marcar(envio.id, { status: 'erro', erro: 'Número de WhatsApp não confirmado' });
        continue;
      }

      const diasAntes = ehAdiado(envio) ? diasAte(envio.vencimento) : envio.dias_antes;
      let texto = montarTexto({ lembrete, nome: conta.nome, vencimento: envio.vencimento, diasAntes });
      try {
        const enviado = await enviarAviso({ jid: conta.telefone_jid, contaId: conta.id, lembrete, nome: conta.nome, vencimento: envio.vencimento, diasAntes });
        const msgId = enviado.msgId; texto = enviado.texto;
        await marcar(envio.id, { status: 'enviado', texto: cifrarTextoEnvio(envio.id, texto), msg_id: msgId, erro: null, enviado_em: new Date().toISOString() });
        console.log(`Lembrete enviado: ${lembrete.tipo} -> ${conta.id.slice(0, 8)}`); // sem dado pessoal no log
      } catch (e) {
        await marcar(envio.id, { status: 'erro', texto: cifrarTextoEnvio(envio.id, texto), erro: e.message });
      }
      await new Promise((r) => setTimeout(r, 2000 + Math.random() * 2000)); // intervalo entre envios
    }
  } catch (e) {
    console.error('Erro no disparo:', e.message);
  } finally {
    rodando = false;
  }
}

export async function destravar() {
  await supabase.from('envios').update({ status: 'pendente' }).eq('status', 'enviando');
}

export function iniciarAgendador() {
  cron.schedule('* * * * *', dispararPendentes);
  cron.schedule('*/30 * * * *', () => gerarTodos().catch((e) => console.error('Erro ao gerar avisos:', e.message)));
  console.log('Agendador de lembretes rodando.');
}
