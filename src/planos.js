// Planos: Grátis e Premium. Tudo que muda entre eles está aqui.
import { supabase } from './supabase.js';

export const LIMITE_GRATIS = {
  lembretes: 3,          // quantos lembretes a conta pode ter
  avisos: 1,             // quantos avisos por lembrete (ex.: só "no dia")
};

// Preços e link de pagamento ficam nas variáveis do Render (dá pra mudar sem mexer no código)
const preco = (v, padrao) => {
  const n = Number(String(v ?? '').replace(',', '.'));
  return Number.isFinite(n) && n > 0 ? n : padrao;
};
export const PRECOS = {
  mensal: preco(process.env.PRECO_MENSAL, 9.9),
  anual: preco(process.env.PRECO_ANUAL, 79.9),
};
export const LINK_PAGAMENTO = process.env.PREMIUM_LINK?.trim() || null; // ex.: link de assinatura do Asaas

// Premium valendo agora? (premium_ate vazio = sem prazo)
export function ehPremium(conta) {
  if (!conta || conta.plano !== 'premium') return false;
  return !conta.premium_ate || Date.parse(conta.premium_ate) > Date.now();
}

// Pra conta grátis, só os 3 lembretes mais antigos funcionam (os outros ficam parados até virar Premium).
// Devolve: Map contaId -> { premium, liberados: Set(lembreteId) | null (null = todos) }
export async function situacaoDasContas(contaIds) {
  const ids = [...new Set(contaIds)].filter(Boolean);
  const mapa = new Map();
  if (!ids.length) return mapa;
  const { data: contas, error } = await supabase.from('contas').select('id, plano, premium_ate').in('id', ids);
  if (error) throw error;
  const gratis = [];
  for (const c of contas || []) {
    const premium = ehPremium(c);
    mapa.set(c.id, { premium, liberados: null });
    if (!premium) gratis.push(c.id);
  }
  if (gratis.length) {
    const { data: lembretes, error: erro2 } = await supabase
      .from('lembretes').select('id, conta_id, criado_em').in('conta_id', gratis).order('criado_em', { ascending: true });
    if (erro2) throw erro2;
    for (const id of gratis) mapa.get(id).liberados = new Set();
    for (const l of lembretes || []) {
      const s = mapa.get(l.conta_id);
      if (s.liberados.size < LIMITE_GRATIS.lembretes) s.liberados.add(l.id);
    }
  }
  return mapa;
}

// Como o lembrete funciona no plano da conta: no grátis, 1 aviso (o mais perto do vencimento),
// mensagem padrão e ícone/cor do tipo. Os dados guardados não mudam: se virar Premium de novo, volta tudo.
export function noPlano(lembrete, situacao) {
  if (!situacao || situacao.premium) return lembrete;
  const permitido = !situacao.liberados || situacao.liberados.has(lembrete.id);
  return {
    ...lembrete,
    ativo: lembrete.ativo && permitido,
    avisos: [Math.min(...(lembrete.avisos?.length ? lembrete.avisos : [0]))],
    mensagem: null,
    icone: null,
    cor: null,
  };
}
