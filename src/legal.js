// Termos de uso e Política de privacidade.
// Os dados de quem responde pelo serviço vêm das variáveis do Render (dá pra ajustar sem mexer no HTML):
//   RESPONSAVEL_NOME       nome da pessoa ou empresa (ex.: "Nicole Caroline Bilatto" ou a razão social)
//   RESPONSAVEL_DOCUMENTO  opcional, ex.: "CNPJ 00.000.000/0001-00"
//   CONTATO_EMAIL          e-mail pra dúvidas, reembolso e pedidos de privacidade
//   CIDADE                 ex.: "Toledo, PR"
// Ao mudar o texto de forma importante, aumente a VERSAO e a DATA: as contas novas guardam qual versão aceitaram.
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { LIMITE_GRATIS, PRECOS } from './planos.js';

export const TERMOS_VERSAO = '1.0';
const TERMOS_DATA = '23/11/2026';

const raiz = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const esc = (t) => String(t).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const reais = (v) => v.toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });

function valores() {
  const admin = String(process.env.ADMIN_EMAIL || '').split(',')[0].trim();
  const doc = String(process.env.RESPONSAVEL_DOCUMENTO || '').trim();
  return {
    RESPONSAVEL: esc(process.env.RESPONSAVEL_NOME?.trim() || 'Lembra Aí'),
    DOCUMENTO: doc ? `, ${esc(doc)}` : '',
    CONTATO: esc(process.env.CONTATO_EMAIL?.trim() || admin || 'contato@lembraai.com.br'),
    CIDADE: esc(process.env.CIDADE?.trim() || 'Toledo, PR'),
    VERSAO: TERMOS_VERSAO,
    ATUALIZADO: TERMOS_DATA,
    ANO: String(new Date().getFullYear()),
    LIMITE: String(LIMITE_GRATIS.lembretes),
    PRECO_MENSAL: `${reais(PRECOS.mensal)} por mês`,
    PRECO_ANUAL: `${reais(PRECOS.anual)} por ano`,
  };
}

const cache = new Map();
export function paginaLegal(arquivo) {
  if (!cache.has(arquivo)) {
    const v = valores();
    const html = readFileSync(path.join(raiz, 'public', arquivo), 'utf8').replace(/\{\{([A-Z_]+)\}\}/g, (m, k) => (k in v ? v[k] : m));
    cache.set(arquivo, html);
  }
  return cache.get(arquivo);
}
