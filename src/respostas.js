// Entende o que a pessoa responde no WhatsApp:
//   "paguei" (ou "paguei a luz", ou respondendo em cima do aviso) -> marca a conta como paga
//   "desfazer"  -> desfaz o último "paguei" (até 24h depois)
//   "parar"     -> pausa todos os lembretes da pessoa
//   "ajuda"     -> explica os comandos
// Número sem conta recebe um convite pra se cadastrar, no máximo 1 vez por semana por número
// e com limite por hora no total (responder estranhos demais aumenta o risco de o chip ser marcado como spam).
import { supabase } from './supabase.js';
import { enviarTexto, enviarEnquete, lerVoto, enviarLista, enviarBotoes, MODO } from './whatsapp.js';
import { abrirConta, abrirLembrete, indice, decifrar, ctx } from './cripto.js';
import {
  TIPOS, hojeBR, proximoVencimento, pagamentosDe, chavePago, marcarPago, desfazerPago,
  OPCOES, guardarEnquete, adiarAviso,
} from './lembretes.js';

const ESCOLHA_VALE_MIN = 30;
const CONVITE_A_CADA_DIAS = 7;
const CONVITES_POR_HORA = 30;
let convitesRecentes = [];

// Endereço do site pro convite. No Render, RENDER_EXTERNAL_URL já vem preenchida sozinha.
const SITE = (process.env.SITE_URL || process.env.RENDER_EXTERNAL_URL || '').trim().replace(/\/+$/, '');
const escolhasPendentes = new Map(); // contaId -> { opcoes: [{lembrete, vencimento}], ate }
const respostasRecentes = new Map(); // contaId -> [timestamps] (trava contra loop com robôs)
const ultimaAjuda = new Map(); // contaId -> timestamp

const normalizar = (t) => String(t || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '')
  .replace(/[^a-z0-9\s]/g, ' ').replace(/\s+/g, ' ').trim();
const dataBR = (iso) => `${iso.slice(8, 10)}/${iso.slice(5, 7)}`;
const somaDias = (iso, n) => new Date(Date.parse(`${iso}T12:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);

const INTENCOES = [
  ['pago', /^(eu )?(ja )?(paguei|pago|paga|quitei|quitado|quitada|pagamento feito|conta paga|ta pago|esta pago|foi pago)\b/],
  ['desfazer', /^(desfazer|desfaz|desfaca|errei|nao paguei|ainda nao paguei|me enganei)\b/],
  ['parar', /^(parar|pare|para de|sair|stop|cancelar lembretes|nao quero mais)\b/],
  ['ajuda', /^(ajuda|menu|help|comandos|oi|ola|bom dia|boa tarde|boa noite|\?)\b/],
];

function entender(texto) {
  const t = normalizar(texto);
  if (/^\d{1,2}$/.test(t)) return { intencao: 'numero', numero: Number(t), t };
  for (const [nome, re] of INTENCOES) if (re.test(t)) return { intencao: nome, t };
  return { intencao: 'outro', t };
}

function podeResponder(contaId) {
  const agora = Date.now();
  const lista = (respostasRecentes.get(contaId) || []).filter((x) => x > agora - 3600_000);
  if (lista.length >= 20) return false;
  respostasRecentes.set(contaId, [...lista, agora]);
  return true;
}

// Celular brasileiro pode chegar com ou sem o 9 na frente (ex.: 55 45 9 9988-7766 ou 55 45 9988-7766)
function variantesBR(numero) {
  const n = String(numero || '');
  const lista = [n];
  if (/^55\d{2}9\d{8}$/.test(n)) lista.push(n.slice(0, 4) + n.slice(5));
  else if (/^55\d{2}[6-9]\d{7}$/.test(n)) lista.push(`${n.slice(0, 4)}9${n.slice(4)}`);
  return lista;
}
export const indicesDoNumero = (numero) => variantesBR(numero).map((v) => indice('jid', `${v}@s.whatsapp.net`));

// Conta criada, mas que ainda não digitou o código de confirmação deste número
async function contaPendentePeloNumero(numero) {
  if (!numero) return null;
  const { data } = await supabase
    .from('contas').select('id, nome').in('jid_pendente_indice', indicesDoNumero(numero)).limit(1).maybeSingle();
  return abrirConta(data) || null;
}

function textoConvite() {
  const linhas = [
    'Oi! 👋 Aqui é o *Lembra Aí*, o assistente que te avisa pelo WhatsApp antes das contas vencerem: luz, água, aluguel, cartão e o que mais você quiser.',
    '',
    'Ainda não encontrei uma conta com este número.',
  ];
  if (SITE) {
    linhas.push('', `Crie a sua em poucos minutos: ${SITE}/login#cadastro`);
    linhas.push('', 'Depois é só cadastrar suas contas que eu cuido de lembrar. 🔔');
  } else {
    linhas.push('', 'Peça o link de cadastro pra quem te indicou e comece a receber seus lembretes. 🔔');
  }
  return linhas.join('\n');
}

// Responde quem não tem conta, no máximo 1 vez por semana por número
async function convidarDesconhecido({ jid, numero }) {
  if (!(numero || jid)) return;
  const chave = indice('contato', numero || jid); // guarda só o índice, não o número de quem escreveu
  const agora = Date.now();
  convitesRecentes = convitesRecentes.filter((t) => t > agora - 3600_000);
  if (convitesRecentes.length >= CONVITES_POR_HORA) return;

  const { data: anterior } = await supabase
    .from('contatos_desconhecidos').select('respondido_em, vezes').eq('chave', chave).maybeSingle();
  if (anterior && Date.parse(anterior.respondido_em) > agora - CONVITE_A_CADA_DIAS * 86_400_000) return;

  // anota antes de enviar: se duas mensagens chegarem juntas, só uma recebe o convite
  const { error } = await supabase.from('contatos_desconhecidos').upsert({
    chave, respondido_em: new Date(agora).toISOString(), vezes: (anterior?.vezes || 0) + 1,
  });
  if (error) throw error;
  convitesRecentes.push(agora);

  const pendente = await contaPendentePeloNumero(numero);
  const texto = pendente
    ? `Oi, ${String(pendente.nome).split(' ')[0]}! 👋 Falta só um passo: digite no site o código de 4 números que te mandei aqui pra confirmar este WhatsApp.${SITE ? `\n\n${SITE}` : ''}\n\n_Se o código expirou, peça outro por lá._`
    : textoConvite();
  await enviarTexto(jid, texto);
  console.log(`Convite enviado pra número sem conta (${pendente ? 'confirmação pendente' : 'novo'}).`);
}

async function contaPeloNumero(numero) {
  if (!numero) return null;
  const { data } = await supabase
    .from('contas').select('id, nome, telefone_jid, telefone_verificado_em')
    .in('telefone_jid_indice', indicesDoNumero(numero)).not('telefone_verificado_em', 'is', null).limit(1).maybeSingle();
  return abrirConta(data) || null;
}

// Contas que podem estar sendo pagas: avisadas nos últimos 20 dias (vencimento até 7 dias atrás)
// ou que vencem nos próximos 10 dias, e que ainda não foram marcadas como pagas.
async function contasEmAberto(contaId) {
  const hoje = hojeBR().str;
  const [{ data: lembretes }, { data: avisados }] = await Promise.all([
    supabase.from('lembretes').select('*').eq('conta_id', contaId),
    supabase.from('envios').select('lembrete_id, vencimento, msg_id')
      .eq('conta_id', contaId).eq('status', 'enviado')
      .gte('enviado_em', new Date(Date.now() - 20 * 86_400_000).toISOString())
      .gte('vencimento', somaDias(hoje, -7)),
  ]);
  const porId = new Map((lembretes || []).map(abrirLembrete).map((l) => [l.id, l]));
  const pagos = await pagamentosDe([...porId.keys()]);
  const vistos = new Map();
  const adicionar = (lembrete, vencimento, msgId = null) => {
    if (!lembrete || !vencimento || pagos.has(chavePago(lembrete.id, vencimento))) return;
    const k = chavePago(lembrete.id, vencimento);
    const atual = vistos.get(k) || { lembrete, vencimento, msgIds: [] };
    if (msgId) atual.msgIds.push(msgId);
    vistos.set(k, atual);
  };
  for (const a of avisados || []) adicionar(porId.get(a.lembrete_id), a.vencimento, a.msg_id);
  for (const l of lembretes || []) {
    if (!l.ativo) continue;
    const v = proximoVencimento(l, new Date(), pagos);
    if (v && v <= somaDias(hoje, 10)) adicionar(l, v);
  }
  return [...vistos.values()].sort((x, y) => x.vencimento.localeCompare(y.vencimento));
}

// "paguei a luz" -> procura palavras do nome do lembrete ou do tipo no texto
function filtrarPeloTexto(opcoes, t) {
  const palavrasDoTipo = { luz: ['luz', 'energia', 'copel'], agua: ['agua', 'sanepar'], internet: ['internet', 'wifi', 'net'], aluguel: ['aluguel'], cartao: ['cartao', 'fatura'], boleto: ['boleto'] };
  const achou = opcoes.filter((o) => {
    const doTitulo = normalizar(o.lembrete.titulo).split(' ').filter((p) => p.length > 3);
    return [...doTitulo, ...(palavrasDoTipo[o.lembrete.tipo] || [])].some((p) => new RegExp(`\\b${p}\\b`).test(t));
  });
  return achou.length ? achou : opcoes;
}

async function avisoPeloId(contaId, msgId) {
  const { data } = await supabase
    .from('envios').select('lembrete_id, vencimento').eq('conta_id', contaId).eq('msg_id', msgId).limit(1).maybeSingle();
  if (data) return data;
  // respondeu "paguei" em cima da enquete
  const { data: enq } = await supabase
    .from('enquetes').select('lembrete_id, vencimento').eq('conta_id', contaId).eq('id', msgId).maybeSingle();
  return enq || null;
}

async function confirmarPagamento(conta, { lembrete, vencimento }) {
  await marcarPago({ lembrete, vencimento, origem: 'whatsapp' });
  const pagos = await pagamentosDe([lembrete.id]);
  const proximo = lembrete.frequencia === 'mensal' ? proximoVencimento(lembrete, new Date(), pagos) : null;
  const depois = proximo ? ` Te aviso de novo no próximo vencimento, dia ${dataBR(proximo)}.` : ' Não vou mais lembrar dessa. 🙌';
  return { texto: `✅ Pagamento anotado: *${lembrete.titulo}*, vencimento ${dataBR(vencimento)}.${depois}`, lembrete, vencimento };
}

// Manda uma resposta. Na API oficial, as ações viram botões; no chip, vai a dica de qual palavra responder.
//   pagamento: { texto, lembrete, vencimento } -> botão "Desfazer"
//   adiado:    { texto, lembrete, vencimento } -> botões "Já paguei" e "Me lembra mais tarde"
async function responder(jid, conta, resposta) {
  if (typeof resposta === 'string') return enviarTexto(jid, resposta);
  const { tipo, texto, lembrete, vencimento } = resposta;
  if (MODO !== 'oficial') {
    const dica = tipo === 'pagamento' ? '_Se foi engano, responda *desfazer*._' : '_Se pagar antes, é só tocar em "Já paguei" ou responder *paguei*._';
    return enviarTexto(jid, `${texto}\n\n${dica}`);
  }
  const botoes = tipo === 'pagamento'
    ? [{ id: 'desfazer', titulo: OPCOES.pago.desfazer }]
    : [{ id: 'pago', titulo: 'Já paguei' }, { id: 'adiar', titulo: 'Me lembra mais tarde' }];
  const id = await enviarBotoes(jid, { texto, botoes });
  await guardarEnquete({ id, segredo: 'botoes', tipo: tipo === 'pagamento' ? 'pago' : 'aviso', contaId: conta.id, lembreteId: lembrete.id, vencimento });
}

const AJUDA = [
  'Oi! Eu sou o assistente de lembretes de contas. 🔔',
  '',
  'Você pode me responder:',
  '• *paguei* — marco a conta como paga e paro de lembrar até o próximo vencimento',
  '• *paguei a luz* — se tiver mais de uma conta em aberto',
  '• *desfazer* — desfaz o último "paguei"',
  '• *parar* — pausa todos os seus lembretes',
  '',
  'Pra criar ou mudar lembretes, use o site.',
].join('\n');

export async function tratarMensagem({ jid, numero, texto, citadaId }) {
  const conta = await contaPeloNumero(numero);
  if (!conta) return convidarDesconhecido({ jid, numero });
  const { intencao, numero: escolhido, t } = entender(texto);
  let resposta = null;

  if (intencao === 'numero') {
    const pendente = escolhasPendentes.get(conta.id);
    if (pendente && pendente.ate > Date.now()) {
      const opcao = pendente.opcoes[escolhido - 1];
      if (opcao) {
        escolhasPendentes.delete(conta.id);
        resposta = { tipo: 'pagamento', ...(await confirmarPagamento(conta, opcao)) };
      } else {
        resposta = `Não entendi 🤔 Responda com um número de 1 a ${pendente.opcoes.length}.`;
      }
    }
  } else if (intencao === 'pago') {
    let opcoes = await contasEmAberto(conta.id);
    // Respondeu em cima de um aviso? Então é aquela conta, e só ela.
    const avisoCitado = citadaId ? await avisoPeloId(conta.id, citadaId) : null;
    const respondida = avisoCitado && opcoes.find((o) => o.lembrete.id === avisoCitado.lembrete_id && o.vencimento === avisoCitado.vencimento);
    if (avisoCitado && !respondida) {
      const l = abrirLembrete((await supabase.from('lembretes').select('id, titulo').eq('id', avisoCitado.lembrete_id).maybeSingle()).data);
      opcoes = null;
      resposta = `Essa já estava anotada como paga: *${l?.titulo || 'essa conta'}* (vencimento ${dataBR(avisoCitado.vencimento)}). ✅`;
    } else if (respondida) opcoes = [respondida];
    else opcoes = filtrarPeloTexto(opcoes, t);

    if (!opcoes) {
      // já respondeu acima
    } else if (!opcoes.length) {
      resposta = 'Não achei nenhuma conta em aberto pra marcar como paga. 🤔\n\nSe quiser, confira seus lembretes no site.';
    } else if (opcoes.length === 1) {
      resposta = { tipo: 'pagamento', ...(await confirmarPagamento(conta, opcoes[0])) };
    } else {
      const lista = opcoes.slice(0, 9);
      escolhasPendentes.set(conta.id, { opcoes: lista, ate: Date.now() + ESCOLHA_VALE_MIN * 60_000 });
      resposta = 'Qual delas você pagou? Responda com o número:\n\n'
        + lista.map((o, i) => `*${i + 1}* — ${TIPOS[o.lembrete.tipo]?.emoji || '📌'} ${o.lembrete.titulo} (vence ${dataBR(o.vencimento)})`).join('\n');
    }
  } else if (intencao === 'desfazer') {
    const { data: ultimo } = await supabase
      .from('pagamentos').select('lembrete_id, vencimento, pago_em')
      .eq('conta_id', conta.id).gte('pago_em', new Date(Date.now() - 86_400_000).toISOString())
      .order('pago_em', { ascending: false }).limit(1).maybeSingle();
    if (!ultimo) {
      resposta = 'Não achei nenhum "paguei" nas últimas 24 horas pra desfazer.';
    } else {
      const lembrete = abrirLembrete((await supabase.from('lembretes').select('*').eq('id', ultimo.lembrete_id).single()).data);
      await desfazerPago({ lembrete, vencimento: ultimo.vencimento });
      resposta = `↩️ Pronto, desfiz. *${lembrete.titulo}* (vencimento ${dataBR(ultimo.vencimento)}) voltou a ficar em aberto, e os avisos que faltam vão sair normalmente.`;
    }
  } else if (intencao === 'parar') {
    const { data: pausados } = await supabase
      .from('lembretes').update({ ativo: false, atualizado_em: new Date().toISOString() })
      .eq('conta_id', conta.id).eq('ativo', true).select('id');
    await supabase.from('envios').delete().eq('conta_id', conta.id).eq('status', 'pendente');
    resposta = pausados?.length
      ? `⏸️ Pausei seus ${pausados.length} lembrete(s). Você não vai mais receber avisos.\n\nPra voltar, é só ativar de novo no site.`
      : 'Você não tem nenhum lembrete ativo no momento.';
  } else if (intencao === 'ajuda' || intencao === 'outro') {
    // mensagem que não entendi: manda a ajuda no máximo 1 vez a cada 6h, pra não virar conversa infinita
    const ultima = ultimaAjuda.get(conta.id) || 0;
    if (intencao === 'ajuda' || ultima < Date.now() - 6 * 3600_000) {
      ultimaAjuda.set(conta.id, Date.now());
      resposta = AJUDA;
    }
  }

  if (resposta && podeResponder(conta.id)) {
    await responder(jid, conta, resposta);
    console.log(`Resposta (${intencao}) -> ${conta.id.slice(0, 8)}`);
  }
}

// =============== ENQUETES ("botões") ===============
const horaBR = (d) => d.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit', timeZone: 'America/Sao_Paulo' });
const emBR = (dataStr, hora) => new Date(`${dataStr}T${hora}:00-03:00`);

// Quando volta o aviso, pra cada opção do "mais tarde". Devolve { quando, texto }.
function horarioDoAdiamento(chave, agora = new Date()) {
  const hoje = hojeBR(agora).str, amanha = somaDias(hoje, 1);
  if (chave === 'h1') return { quando: new Date(agora.getTime() + 3600_000), dia: 'hoje' };
  if (chave === 'h3') return { quando: new Date(agora.getTime() + 3 * 3600_000), dia: 'hoje' };
  if (chave === 'noite') {
    const noite = emBR(hoje, '20:00');
    return noite.getTime() - agora.getTime() > 20 * 60_000 ? { quando: noite, dia: 'hoje' } : { quando: emBR(amanha, '20:00'), dia: 'amanhã' };
  }
  return { quando: emBR(amanha, '09:00'), dia: 'amanhã' };
}

// Quem tocou tem que ser o dono do aviso (no chip, se não der pra saber o número, a própria cifra do voto garante)
async function ehDono(enq, numero) {
  if (!numero) return MODO !== 'oficial';
  const dono = await contaPeloNumero(numero);
  return Boolean(dono && dono.id === enq.conta_id);
}

// Chip (Baileys): toque numa enquete. Lê o voto e executa a escolha.
export async function tratarVoto({ jid, numero, enqueteId, voto }) {
  const { data: enq } = await supabase.from('enquetes').select('*').eq('id', enqueteId).maybeSingle();
  if (!enq || !OPCOES[enq.tipo]) return; // enquete que não é nossa (ou muito antiga)
  const opcoes = OPCOES[enq.tipo];
  const nomeEscolhido = lerVoto(voto, { enqueteId, segredo: decifrar(enq.segredo, ctx('enquetes', 'segredo', enq.id)), opcoes: Object.values(opcoes) });
  if (!nomeEscolhido || !(await ehDono(enq, numero))) return; // desmarcou, ou não é de quem votou
  await executarEscolha({ jid, enq, escolha: Object.keys(opcoes).find((k) => opcoes[k] === nomeEscolhido) });
}

// API oficial: toque num botão do aviso ou numa opção da lista. O id da mensagem (context.id) diz qual aviso era.
const semEmoji = (t) => normalizar(t).replace(/\s+/g, ' ').trim();
export async function tratarEscolha({ jid, numero, mensagemId, payload, texto }) {
  if (!mensagemId) return;
  const { data: enq } = await supabase.from('enquetes').select('*').eq('id', mensagemId).maybeSingle();
  if (!enq || !OPCOES[enq.tipo] || !(await ehDono(enq, numero))) return;
  const opcoes = OPCOES[enq.tipo];
  const chave = String(payload || '').replace(/^adiar:/, '');
  const escolha = opcoes[chave] ? chave
    : Object.keys(opcoes).find((k) => semEmoji(opcoes[k]) === semEmoji(texto) || semEmoji(opcoes[k]).endsWith(semEmoji(texto)));
  if (escolha) await executarEscolha({ jid, enq, escolha });
}

async function executarEscolha({ jid, enq, escolha }) {
  const nomeEscolhido = OPCOES[enq.tipo][escolha];
  if (!escolha || nomeEscolhido === enq.resposta) return; // o WhatsApp mandou a mesma escolha de novo
  await supabase.from('enquetes').update({ resposta: nomeEscolhido }).eq('id', enq.id);

  const conta = abrirConta((await supabase.from('contas').select('id, nome').eq('id', enq.conta_id).maybeSingle()).data);
  const lembrete = abrirLembrete((await supabase.from('lembretes').select('*').eq('id', enq.lembrete_id).maybeSingle()).data);
  if (!conta || !lembrete || !podeResponder(conta.id)) return;
  const jaPaga = (await pagamentosDe([lembrete.id])).has(chavePago(lembrete.id, enq.vencimento));

  let resposta = null;
  if (enq.tipo === 'pago') { // botão "Desfazer" depois do pagamento anotado
    if (!jaPaga) resposta = `*${lembrete.titulo}* (vencimento ${dataBR(enq.vencimento)}) já está em aberto. 👍`;
    else {
      await desfazerPago({ lembrete, vencimento: enq.vencimento });
      resposta = `↩️ Pronto, desfiz. *${lembrete.titulo}* (vencimento ${dataBR(enq.vencimento)}) voltou a ficar em aberto, e os avisos que faltam vão sair normalmente.`;
    }
  } else if (jaPaga) {
    resposta = `Essa já está anotada como paga: *${lembrete.titulo}* (vencimento ${dataBR(enq.vencimento)}). ✅`;
  } else if (enq.tipo === 'aviso' && escolha === 'pago') {
    resposta = { tipo: 'pagamento', ...(await confirmarPagamento(conta, { lembrete, vencimento: enq.vencimento })) };
  } else if (enq.tipo === 'aviso' && escolha === 'adiar') {
    // pergunta quando: enquete no chip, lista de opções na API oficial
    const pergunta = `Quando quer que eu te lembre de novo de ${lembrete.titulo}?`;
    const enviada = MODO === 'oficial'
      ? { id: await enviarLista(jid, { texto: pergunta, botao: 'Escolher horário', opcoes: Object.entries(OPCOES.adiar).map(([k, v]) => ({ id: `adiar:${k}`, titulo: v })) }), segredo: 'botoes' }
      : await enviarEnquete(jid, { pergunta, opcoes: Object.values(OPCOES.adiar) });
    await guardarEnquete({ ...enviada, tipo: 'adiar', contaId: conta.id, lembreteId: lembrete.id, vencimento: enq.vencimento });
    console.log(`Escolha (mais tarde) -> ${conta.id.slice(0, 8)}`);
    return;
  } else if (enq.tipo === 'adiar') {
    const { quando, dia } = horarioDoAdiamento(escolha);
    await adiarAviso({ lembrete, vencimento: enq.vencimento, quando });
    resposta = { tipo: 'adiado', texto: `⏰ Combinado! Te lembro de novo ${dia} às ${horaBR(quando)}.`, lembrete, vencimento: enq.vencimento };
  }
  if (resposta) {
    await responder(jid, conta, resposta);
    console.log(`Escolha (${escolha}) -> ${conta.id.slice(0, 8)}`);
  }
}
