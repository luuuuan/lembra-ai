// Entrar com código no WhatsApp e "Esqueci minha senha".
// Os dois usam o WhatsApp já confirmado da conta: o sistema manda um código de 6 números, que vale 10 minutos.
//   POST /api/acesso/codigo  { motivo: 'login' | 'senha', valor }   valor = WhatsApp (login) ou e-mail/WhatsApp (senha)
//   POST /api/acesso/entrar  { valor, codigo }                       -> abre a sessão
//   POST /api/acesso/senha   { valor, codigo, senha }                -> troca a senha, derruba as outras sessões e entra
// A resposta do pedido de código é sempre a mesma, exista a conta ou não (não dá pra descobrir quem tem conta).
import { createHash, randomInt } from 'node:crypto';
import { supabase } from './supabase.js';
import { abrirConta, indice } from './cripto.js';
import * as whatsapp from './whatsapp.js';
import { indicesDoNumero } from './respostas.js';
import { criarLimite, recusar } from './limites.js';
import { gerarHash, entrar, esquecerUsuario, ehAdmin } from './auth.js';

const VALIDADE_MIN = 10;
const MAX_TENTATIVAS = 5;
const pedidosPorIp = criarLimite({ max: 10, janelaMin: 60 });    // pedidos de código por IP
const pedidosPorConta = criarLimite({ max: 5, janelaMin: 60 });  // códigos por conta por hora
const errosPorIp = criarLimite({ max: 20, janelaMin: 15 });      // códigos errados por IP
const ultimoPedido = new Map();                                   // contaId -> quando (1 por minuto)
const espera = (ms) => new Promise((r) => setTimeout(r, ms));

const hashCodigo = (contaId, motivo, codigo) =>
  createHash('sha256').update(`${process.env.SUPABASE_SERVICE_ROLE_KEY}:acesso:${motivo}:${contaId}:${codigo}`).digest('hex');

function normalizarTelefone(valor) {
  let n = String(valor || '').replace(/\D/g, '');
  if (n.length === 10 || n.length === 11) n = `55${n}`;
  return n.length >= 12 && n.length <= 13 ? n : null;
}

// Acha a conta pelo e-mail ou pelo WhatsApp confirmado. Só serve conta com WhatsApp confirmado.
async function acharConta(valor) {
  const texto = String(valor || '').trim().toLowerCase();
  const colunas = 'id, nome, email, telefone_jid, telefone_verificado_em, acesso_codigo_hash, acesso_codigo_expira, acesso_tentativas, acesso_motivo';
  let consulta = supabase.from('contas').select(colunas).not('telefone_verificado_em', 'is', null).limit(1);
  if (texto.includes('@')) {
    consulta = consulta.eq('email_indice', indice('email', texto));
  } else {
    const numero = normalizarTelefone(texto);
    if (!numero) return { invalido: true };
    consulta = consulta.in('telefone_jid_indice', indicesDoNumero(numero));
  }
  const { data, error } = await consulta.maybeSingle();
  if (error) throw error;
  return { conta: abrirConta(data) };
}

async function conferirCodigo(req, res, motivo) {
  const porIp = errosPorIp.checar(req.ip);
  if (!porIp.liberado) { recusar(res, porIp.esperaSeg); return null; }
  const codigo = String(req.body?.codigo || '').replace(/\D/g, '');
  if (codigo.length !== 6) { res.status(400).json({ erro: 'O código tem 6 números.' }); return null; }

  const { conta } = await acharConta(req.body?.valor);
  const valido = conta?.acesso_codigo_hash && conta.acesso_motivo === motivo
    && conta.acesso_codigo_expira && Date.parse(conta.acesso_codigo_expira) > Date.now();
  if (!valido) {
    errosPorIp.registrar(req.ip);
    res.status(400).json({ erro: 'Código expirado ou inválido. Peça um novo.' });
    return null;
  }
  if (conta.acesso_tentativas >= MAX_TENTATIVAS) {
    res.status(429).json({ erro: 'Muitas tentativas erradas. Peça um novo código.' });
    return null;
  }
  if (hashCodigo(conta.id, motivo, codigo) !== conta.acesso_codigo_hash) {
    errosPorIp.registrar(req.ip);
    await supabase.from('contas').update({ acesso_tentativas: conta.acesso_tentativas + 1 }).eq('id', conta.id);
    await espera(300 + Math.random() * 300);
    const restam = MAX_TENTATIVAS - 1 - conta.acesso_tentativas;
    res.status(400).json({ erro: restam > 0 ? `Código incorreto. Você tem mais ${restam} tentativa(s).` : 'Código incorreto. Peça um novo código.' });
    return null;
  }
  return conta;
}

const usar = { acesso_codigo_hash: null, acesso_codigo_expira: null, acesso_tentativas: 0, acesso_motivo: null };

export function rotasDeAcesso(app) {
  app.post('/api/acesso/codigo', async (req, res) => {
    try {
      const motivo = req.body?.motivo === 'senha' ? 'senha' : 'login';
      const porIp = pedidosPorIp.checar(req.ip);
      if (!porIp.liberado) return recusar(res, porIp.esperaSeg, 'Muitos códigos pedidos');
      if (!whatsapp.online()) return res.status(503).json({ erro: 'O WhatsApp do sistema está fora do ar agora. Tente de novo mais tarde.' });

      const { conta, invalido } = await acharConta(req.body?.valor);
      if (invalido) return res.status(400).json({ erro: 'Digite o WhatsApp com DDD, ex.: (45) 99999-9999' });
      pedidosPorIp.registrar(req.ip);
      const resposta = { ok: true, validadeMin: VALIDADE_MIN };

      if (conta) {
        const ultimo = ultimoPedido.get(conta.id) || 0;
        if (ultimo > Date.now() - 60_000) return res.status(429).json({ erro: 'Espere 1 minuto pra pedir outro código.' });
        const porConta = pedidosPorConta.checar(conta.id);
        if (!porConta.liberado) return recusar(res, porConta.esperaSeg, 'Muitos códigos pedidos');

        const codigo = String(randomInt(0, 1_000_000)).padStart(6, '0');
        const { error } = await supabase.from('contas').update({
          acesso_codigo_hash: hashCodigo(conta.id, motivo, codigo),
          acesso_codigo_expira: new Date(Date.now() + VALIDADE_MIN * 60_000).toISOString(),
          acesso_tentativas: 0, acesso_motivo: motivo,
        }).eq('id', conta.id);
        if (error) throw error;
        ultimoPedido.set(conta.id, Date.now());
        pedidosPorConta.registrar(conta.id);
        await whatsapp.enviarCodigo(conta.telefone_jid, codigo, motivo).catch((e) => {
          console.error('Código de acesso não enviado:', e.message);
        });
      } else {
        await espera(250 + Math.random() * 400); // mesmo tempo de resposta de quando a conta existe
      }
      res.json(resposta);
    } catch (e) {
      res.status(500).json({ erro: e.message });
    }
  });

  app.post('/api/acesso/entrar', async (req, res) => {
    try {
      const conta = await conferirCodigo(req, res, 'login');
      if (!conta) return;
      await supabase.from('contas').update(usar).eq('id', conta.id);
      ultimoPedido.delete(conta.id);
      entrar(req, res, conta.id);
      res.json({ id: conta.id, nome: conta.nome, email: conta.email, admin: ehAdmin(conta.email) });
    } catch (e) {
      res.status(500).json({ erro: e.message });
    }
  });

  app.post('/api/acesso/senha', async (req, res) => {
    try {
      const senha = String(req.body?.senha || '');
      if (senha.length < 8) return res.status(400).json({ erro: 'A senha nova precisa ter pelo menos 8 caracteres.' });
      const conta = await conferirCodigo(req, res, 'senha');
      if (!conta) return;
      // Troca a senha e derruba as sessões abertas em outros aparelhos
      const { error } = await supabase.from('contas').update({
        ...usar, senha_hash: await gerarHash(senha), sessoes_desde: new Date().toISOString(),
      }).eq('id', conta.id);
      if (error) throw error;
      esquecerUsuario(conta.id);
      ultimoPedido.delete(conta.id);
      await espera(5); // a sessão nova nasce depois do corte
      entrar(req, res, conta.id);
      console.log(`Senha redefinida pelo WhatsApp: ${conta.id.slice(0, 8)}`);
      res.json({ id: conta.id, nome: conta.nome, email: conta.email, admin: ehAdmin(conta.email) });
    } catch (e) {
      res.status(500).json({ erro: e.message });
    }
  });
}
