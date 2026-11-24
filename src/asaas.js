// Pagamento do Premium pelo Asaas (assinatura mensal ou anual).
//
// Como funciona:
//   1. A pessoa clica em "Assinar" e informa o CPF (ou CNPJ). O documento vai direto pro Asaas, pra criar o
//      cliente lá. O Lembra Aí NÃO guarda o CPF: guarda só o código do cliente e da assinatura no Asaas.
//   2. O sistema cria a assinatura e manda a pessoa pra fatura do Asaas, onde ela paga com Pix, boleto ou cartão.
//   3. Quando o pagamento entra, o Asaas avisa no webhook (/webhook/asaas) e o Premium liga sozinho até o fim
//      do período (+3 dias de folga pra renovação). Estorno ou chargeback desliga.
//   4. Cancelar a assinatura para as próximas cobranças; o Premium vale até o fim do que já foi pago.
//
// Variáveis: ASAAS_API_KEY, ASAAS_AMBIENTE (sandbox | producao), ASAAS_WEBHOOK_TOKEN.
import { timingSafeEqual } from 'node:crypto';
import { supabase } from './supabase.js';
import { abrirConta, decifrar, ctx } from './cripto.js';
import { PRECOS } from './planos.js';

const CHAVE = process.env.ASAAS_API_KEY?.trim() || '';
const AMBIENTE = String(process.env.ASAAS_AMBIENTE || (CHAVE.startsWith('$aact_prod_') ? 'producao' : 'sandbox')).trim().toLowerCase();
const PRODUCAO = ['producao', 'produção', 'production', 'prod'].includes(AMBIENTE);
const URL_API = process.env.ASAAS_API_URL?.trim() || (PRODUCAO ? 'https://api.asaas.com/v3' : 'https://api-sandbox.asaas.com/v3'); // ASAAS_API_URL só pra teste
const TOKEN_WEBHOOK = process.env.ASAAS_WEBHOOK_TOKEN?.trim() || '';

export const asaasLigado = Boolean(CHAVE);
export const ambienteAsaas = PRODUCAO ? 'producao' : 'sandbox';

const FOLGA_DIAS = 3; // depois do fim do período, o Premium segura mais 3 dias esperando a renovação cair
const CICLO = { mensal: 'MONTHLY', anual: 'YEARLY' };

// ---------- chamada à API ----------
async function chamar(metodo, caminho, corpo) {
  const r = await fetch(URL_API + caminho, {
    method: metodo,
    headers: { access_token: CHAVE, 'Content-Type': 'application/json', 'User-Agent': 'LembraAi/1.0 (Node.js)' },
    body: corpo ? JSON.stringify(corpo) : undefined,
  });
  const texto = await r.text();
  let j = null;
  try { j = texto ? JSON.parse(texto) : null; } catch { /* resposta sem JSON */ }
  if (!r.ok) {
    const msg = j?.errors?.map((e) => e.description).join(' ') || `Asaas respondeu ${r.status}`;
    throw Object.assign(new Error(msg), { status: r.status === 400 ? 400 : 502, asaas: true });
  }
  return j;
}

// ---------- CPF / CNPJ ----------
function digitoOk(nums, pesos) {
  const soma = pesos.reduce((s, p, i) => s + Number(nums[i]) * p, 0);
  const resto = soma % 11;
  return resto < 2 ? 0 : 11 - resto;
}
export function documentoValido(doc) {
  const d = String(doc || '').replace(/\D/g, '');
  if (d.length === 11) {
    if (/^(\d)\1{10}$/.test(d)) return null;
    const d1 = digitoOk(d, [10, 9, 8, 7, 6, 5, 4, 3, 2]);
    const d2 = digitoOk(d, [11, 10, 9, 8, 7, 6, 5, 4, 3, 2]);
    return Number(d[9]) === d1 && Number(d[10]) === d2 ? d : null;
  }
  if (d.length === 14) {
    if (/^(\d)\1{13}$/.test(d)) return null;
    const d1 = digitoOk(d, [5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2]);
    const d2 = digitoOk(d, [6, 5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2]);
    return Number(d[12]) === d1 && Number(d[13]) === d2 ? d : null;
  }
  return null;
}

// ---------- datas ----------
const hojeBR = () => new Date(Date.now() - 3 * 3600_000).toISOString().slice(0, 10);
function somarPeriodo(dataISO, periodo) {
  const [a, m, d] = dataISO.slice(0, 10).split('-').map(Number);
  const dt = new Date(Date.UTC(periodo === 'anual' ? a + 1 : a, periodo === 'anual' ? m - 1 : m, d, 23, 59, 59));
  // 31/01 + 1 mês não pode virar 03/03: segura no último dia do mês
  if (periodo !== 'anual' && dt.getUTCDate() !== d) dt.setUTCDate(0);
  return new Date(dt.getTime() + 3 * 3600_000); // 23:59:59 no horário de Brasília
}

// ---------- assinatura ----------
const COLUNAS = 'id, nome, email, plano, premium_ate, asaas_cliente_id, asaas_assinatura_id, assinatura_periodo, assinatura_status';

async function lerConta(id) {
  const { data, error } = await supabase.from('contas').select(COLUNAS).eq('id', id).maybeSingle();
  if (error) throw error;
  return abrirConta(data);
}

// Fatura em aberto da assinatura (pra quem fechou a aba sem pagar)
async function faturaAberta(assinaturaId) {
  const j = await chamar('GET', `/payments?subscription=${encodeURIComponent(assinaturaId)}&status=PENDING&limit=5`);
  const abertas = (j?.data || []).concat();
  if (!abertas.length) {
    const vencidas = await chamar('GET', `/payments?subscription=${encodeURIComponent(assinaturaId)}&status=OVERDUE&limit=5`);
    abertas.push(...(vencidas?.data || []));
  }
  abertas.sort((x, y) => String(x.dueDate).localeCompare(String(y.dueDate)));
  return abertas[0] ? { url: abertas[0].invoiceUrl, vencimento: abertas[0].dueDate, valor: abertas[0].value } : null;
}

// Situação pro painel
export async function situacaoAssinatura(contaId) {
  const c = await lerConta(contaId);
  const base = { pagamento_online: asaasLigado, ativa: false };
  if (!c?.asaas_assinatura_id || !['ativa', 'aguardando'].includes(c.assinatura_status)) return base;
  let fatura = null;
  if (asaasLigado) fatura = await faturaAberta(c.asaas_assinatura_id).catch(() => null);
  return { ...base, ativa: true, status: c.assinatura_status, periodo: c.assinatura_periodo, fatura };
}

export async function assinar(contaId, { periodo, documento }) {
  if (!asaasLigado) throw Object.assign(new Error('O pagamento online ainda não está ligado.'), { status: 503 });
  periodo = periodo === 'mensal' ? 'mensal' : 'anual';
  const c = await lerConta(contaId);
  if (!c) throw Object.assign(new Error('Conta não encontrada'), { status: 404 });

  // Já tem assinatura? Devolve a fatura em aberto em vez de criar outra (evita cobrança dobrada)
  if (c.asaas_assinatura_id && ['ativa', 'aguardando'].includes(c.assinatura_status)) {
    const fatura = await faturaAberta(c.asaas_assinatura_id).catch(() => null);
    if (fatura?.url) return { url: fatura.url, existente: true };
    if (c.assinatura_status === 'ativa') {
      throw Object.assign(new Error('Você já tem uma assinatura ativa. Pra trocar de plano, cancele a atual primeiro.'), { status: 409 });
    }
  }

  // Cliente no Asaas (o documento só é pedido na primeira vez)
  let cliente = c.asaas_cliente_id;
  if (!cliente) {
    const doc = documentoValido(documento);
    if (!doc) throw Object.assign(new Error('CPF ou CNPJ inválido. Confira os números.'), { status: 400, pedirDocumento: true });
    const novo = await chamar('POST', '/customers', {
      name: c.nome, email: c.email, cpfCnpj: doc, externalReference: c.id, notificationDisabled: false,
    });
    cliente = novo.id;
    await supabase.from('contas').update({ asaas_cliente_id: cliente }).eq('id', c.id);
  }

  const assinatura = await chamar('POST', '/subscriptions', {
    customer: cliente,
    billingType: 'UNDEFINED', // a pessoa escolhe Pix, boleto ou cartão na fatura
    value: PRECOS[periodo],
    nextDueDate: hojeBR(),
    cycle: CICLO[periodo],
    description: `Lembra Aí Premium (${periodo})`,
    externalReference: c.id,
  });
  const { error } = await supabase.from('contas').update({
    asaas_assinatura_id: assinatura.id, assinatura_periodo: periodo, assinatura_status: 'aguardando',
  }).eq('id', c.id);
  if (error) throw error;

  const fatura = await faturaAberta(assinatura.id);
  if (!fatura?.url) throw Object.assign(new Error('O Asaas não devolveu a fatura. Tente de novo em instantes.'), { status: 502 });
  return { url: fatura.url };
}

// Cancela as próximas cobranças. O Premium já pago continua valendo até premium_ate.
export async function cancelarAssinatura(contaId) {
  const c = await lerConta(contaId);
  if (!c?.asaas_assinatura_id || !['ativa', 'aguardando'].includes(c.assinatura_status)) return { ok: true, nada: true };
  if (asaasLigado) {
    await chamar('DELETE', `/subscriptions/${encodeURIComponent(c.asaas_assinatura_id)}`).catch((e) => {
      if (!String(e.message).match(/not found|não encontrad/i)) throw e;
    });
  }
  await supabase.from('contas').update({ assinatura_status: 'cancelada' }).eq('id', c.id);
  return { ok: true, premium_ate: c.premium_ate };
}

// ---------- webhook ----------
function tokenConfere(recebido) {
  if (!TOKEN_WEBHOOK) return false;
  const a = Buffer.from(String(recebido || ''));
  const b = Buffer.from(TOKEN_WEBHOOK);
  return a.length === b.length && timingSafeEqual(a, b);
}

async function contaDoPagamento(p) {
  const tentar = async (col, val) => {
    if (!val) return null;
    const { data } = await supabase.from('contas').select('id, plano, premium_ate, assinatura_periodo, telefone_jid, telefone_verificado_em')
      .eq(col, val).maybeSingle();
    return data;
  };
  return (await tentar('asaas_assinatura_id', p.subscription))
    || (await tentar('asaas_cliente_id', p.customer))
    || (/^[0-9a-f-]{36}$/i.test(p.externalReference || '') ? await tentar('id', p.externalReference) : null);
}

const PAGO = new Set(['PAYMENT_CONFIRMED', 'PAYMENT_RECEIVED']);
const DESFEITO = new Set(['PAYMENT_REFUNDED', 'PAYMENT_PARTIALLY_REFUNDED', 'PAYMENT_CHARGEBACK_REQUESTED', 'PAYMENT_CHARGEBACK_DISPUTE', 'PAYMENT_DELETED']);
const FIM_ASSINATURA = new Set(['SUBSCRIPTION_DELETED', 'SUBSCRIPTION_INACTIVATED']);

// depois: (contaId, { tipo: 'liberado' | 'desfeito', premium_ate, jid }) — o index.js limpa cache, refaz avisos e avisa no WhatsApp
export function rotasWebhookAsaas(app, depois = async () => {}) {
  app.post('/webhook/asaas', async (req, res) => {
    if (!tokenConfere(req.get('asaas-access-token'))) return res.status(401).json({ erro: 'token inválido' });
    const ev = req.body || {};
    try {
      // Mesmo evento pode chegar mais de uma vez: guarda o id e ignora repetido
      if (ev.id) {
        const { error } = await supabase.from('asaas_eventos').insert({ id: String(ev.id), evento: String(ev.event || '') });
        if (error?.code === '23505') return res.json({ ok: true, repetido: true });
        if (error) throw error;
      }
      await tratarEvento(ev, depois);
      res.json({ ok: true });
    } catch (e) {
      console.error('Webhook Asaas:', e.message);
      // apaga o registro do evento pra deixar o Asaas tentar de novo
      if (ev.id) await supabase.from('asaas_eventos').delete().eq('id', String(ev.id)).then(() => {}, () => {});
      res.status(500).json({ erro: 'falhou, tente de novo' });
    }
  });
}

async function tratarEvento(ev, depois) {
  const tipo = String(ev.event || '');

  if (FIM_ASSINATURA.has(tipo) && ev.subscription?.id) {
    await supabase.from('contas').update({ assinatura_status: 'cancelada' })
      .eq('asaas_assinatura_id', ev.subscription.id).in('assinatura_status', ['ativa', 'aguardando']);
    return;
  }

  const p = ev.payment;
  if (!p?.id) return;

  if (PAGO.has(tipo)) {
    // Confirmado (cartão) e Recebido (quando o dinheiro cai) são o mesmo pagamento: libera uma vez só
    const { data: ja } = await supabase.from('asaas_pagamentos').select('id, status').eq('id', p.id).maybeSingle();
    if (ja?.status === 'pago') return;
    const conta = await contaDoPagamento(p);
    if (!conta) { console.warn(`Asaas: pagamento ${p.id} sem conta ligada`); return; }

    const periodo = conta.assinatura_periodo || (Number(p.value) >= PRECOS.anual * 0.9 ? 'anual' : 'mensal');
    const fimPeriodo = somarPeriodo(p.dueDate || hojeBR(), periodo);
    const novoFim = new Date(fimPeriodo.getTime() + FOLGA_DIAS * 86_400_000);
    const atual = conta.plano === 'premium' && conta.premium_ate ? Date.parse(conta.premium_ate) : 0;
    const premium_ate = new Date(Math.max(novoFim.getTime(), atual || 0)).toISOString();
    const semPrazo = conta.plano === 'premium' && !conta.premium_ate; // liberado à mão sem prazo: não mexe

    if (!semPrazo) {
      const { error } = await supabase.from('contas').update({ plano: 'premium', premium_ate }).eq('id', conta.id);
      if (error) throw error;
    }
    await supabase.from('contas').update({ assinatura_status: 'ativa' }).eq('id', conta.id).eq('asaas_assinatura_id', p.subscription || '');
    const { error: e2 } = await supabase.from('asaas_pagamentos').upsert({
      id: p.id, conta_id: conta.id, assinatura_id: p.subscription || null, valor: p.value ?? null, forma: p.billingType || null,
      vencimento: p.dueDate || null, status: 'pago', liberado_ate: semPrazo ? null : premium_ate, atualizado_em: new Date().toISOString(),
    });
    if (e2) throw e2;
    await depois(conta.id, { tipo: 'liberado', premium_ate: semPrazo ? null : premium_ate, jid: jidDa(conta), primeiro: !atual });
    return;
  }

  if (DESFEITO.has(tipo)) {
    const { data: reg } = await supabase.from('asaas_pagamentos').select('id, conta_id, status').eq('id', p.id).maybeSingle();
    if (!reg || reg.status !== 'pago' || !reg.conta_id) return; // nunca liberou nada: não há o que desfazer
    await supabase.from('asaas_pagamentos').update({ status: tipo === 'PAYMENT_DELETED' ? 'apagado' : 'estornado', atualizado_em: new Date().toISOString() }).eq('id', p.id);
    // Volta pro que valia antes deste pagamento: se ainda houver outro pagamento valendo, mantém até o fim dele
    const { data: outros } = await supabase.from('asaas_pagamentos').select('liberado_ate')
      .eq('conta_id', reg.conta_id).eq('status', 'pago').neq('id', p.id).order('liberado_ate', { ascending: false }).limit(1);
    const resto = outros?.[0]?.liberado_ate && Date.parse(outros[0].liberado_ate) > Date.now() ? outros[0].liberado_ate : null;
    const { data: conta } = await supabase.from('contas').select('id, plano, premium_ate, telefone_jid, telefone_verificado_em').eq('id', reg.conta_id).maybeSingle();
    if (!conta || (conta.plano === 'premium' && !conta.premium_ate)) return; // premium sem prazo (dado à mão): não mexe
    await supabase.from('contas').update(resto ? { plano: 'premium', premium_ate: resto } : { plano: 'gratis', premium_ate: null }).eq('id', conta.id);
    await depois(conta.id, { tipo: 'desfeito', premium_ate: resto, jid: jidDa(conta) });
  }
}

function jidDa(conta) {
  if (!conta?.telefone_verificado_em || !conta.telefone_jid) return null;
  try { return decifrar(conta.telefone_jid, ctx('contas', 'telefone_jid', conta.id)); } catch { return null; }
}
