// Login, cadastro e sessão por cookie.
// Senhas: Argon2id (recomendação atual da OWASP). Contas antigas com scrypt passam pro Argon2id no próximo login.
// Nome, e-mail e telefone ficam cifrados no banco (cripto.js); o login acha a conta pelo índice cego do e-mail.
// Sessão: cookie assinado (HMAC) com validade de 30 dias.
import { scrypt as scryptCb, timingSafeEqual, createHmac, createHash, randomUUID } from 'node:crypto';
import { promisify } from 'node:util';
import { promises as dns } from 'node:dns';
import argon2 from 'argon2';
import { supabase } from './supabase.js';
import { abrirConta, fecharConta, indice } from './cripto.js';
import { TERMOS_VERSAO } from './legal.js';
import { criarLimite, recusar } from './limites.js';
import { ehPremium } from './planos.js';
import { cancelarAssinatura } from './asaas.js';

const scrypt = promisify(scryptCb);
const COOKIE = 'lembretes_sessao';
const VALIDADE_MS = 30 * 24 * 60 * 60 * 1000;

// Segredo que assina os cookies. Se não for definido, deriva da chave do Supabase (fica estável entre restarts).
const SEGREDO = process.env.SESSAO_SEGREDO
  || createHash('sha256').update(`sessao:${process.env.SUPABASE_SERVICE_ROLE_KEY}`).digest('hex');

// E-mails de quem administra (pode conectar o número do sistema). Separe vários por vírgula.
const ADMINS = (process.env.ADMIN_EMAIL || '').split(',').map((e) => e.trim().toLowerCase()).filter(Boolean);
export const ehAdmin = (email) => ADMINS.includes(String(email).toLowerCase());

// ---------- senha ----------
// Argon2id com os parâmetros mínimos da OWASP (19 MiB de memória, 2 passadas): leve pro servidor,
// caro pra quem tentar adivinhar senhas em massa.
const ARGON = { type: argon2.argon2id, memoryCost: 19456, timeCost: 2, parallelism: 1 };
export const gerarHash = (senha) => argon2.hash(senha, ARGON);
const precisaAtualizar = (guardado) => !String(guardado).startsWith('$argon2id$') || argon2.needsRehash(guardado, ARGON);

async function conferirSenha(senha, guardado) {
  const g = String(guardado || '');
  if (g.startsWith('$argon2')) {
    try { return await argon2.verify(g, senha); } catch { return false; }
  }
  // formato antigo (scrypt), das contas criadas antes
  const [alg, salB64, hashB64] = g.split('$');
  if (alg !== 'scrypt' || !salB64 || !hashB64) return false;
  const esperado = Buffer.from(hashB64, 'base64');
  const calculado = await scrypt(senha, Buffer.from(salB64, 'base64'), esperado.length);
  return timingSafeEqual(esperado, calculado);
}
// Conta inexistente também gasta o tempo de uma conferência (não dá pra descobrir e-mails cadastrados pelo tempo)
let hashFalso = null;
const conferirFalso = async (senha) => { hashFalso ||= await gerarHash('senha-que-ninguem-tem'); await conferirSenha(senha, hashFalso); return false; };

// ---------- token da sessão ----------
const assinar = (dados) => createHmac('sha256', SEGREDO).update(dados).digest('base64url');

export function criarToken(usuarioId) {
  const dados = Buffer.from(JSON.stringify({ u: usuarioId, e: Date.now() + VALIDADE_MS })).toString('base64url');
  return `${dados}.${assinar(dados)}`;
}

function lerToken(token) {
  const [dados, assinatura] = String(token || '').split('.');
  if (!dados || !assinatura) return null;
  const esperado = Buffer.from(assinar(dados));
  const recebido = Buffer.from(assinatura);
  if (esperado.length !== recebido.length || !timingSafeEqual(esperado, recebido)) return null;
  try {
    const { u, e } = JSON.parse(Buffer.from(dados, 'base64url').toString());
    return e > Date.now() ? { id: u, emitido: e - VALIDADE_MS } : null;
  } catch {
    return null;
  }
}

function lerCookie(req) {
  for (const parte of (req.headers.cookie || '').split(';')) {
    const [nome, ...valor] = parte.trim().split('=');
    if (nome === COOKIE) return decodeURIComponent(valor.join('='));
  }
  return null;
}

function gravarCookie(req, res, valor, maxAgeMs) {
  const seguro = req.secure ? '; Secure' : '';
  res.append('Set-Cookie',
    `${COOKIE}=${encodeURIComponent(valor)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${Math.floor(maxAgeMs / 1000)}${seguro}`);
}

// ---------- limites de tentativas (contra chute de senha e cadastro em massa) ----------
const falhasPorEmail = criarLimite({ max: 5, janelaMin: 15 });   // 5 senhas erradas na mesma conta -> espera 15 min
const falhasPorIp = criarLimite({ max: 20, janelaMin: 15 });     // 20 erros do mesmo IP (qualquer e-mail) -> espera
const cadastrosPorIp = criarLimite({ max: 5, janelaMin: 60 });   // 5 contas novas por hora do mesmo IP
const espera = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------- middlewares ----------
const cacheUsuarios = new Map(); // id -> { usuario, ate } (evita ir no banco a cada requisição)

async function buscarUsuario(id) {
  const c = cacheUsuarios.get(id);
  if (c && c.ate > Date.now()) return c.usuario;
  const { data: linha } = await supabase
    .from('contas').select('id, nome, email, telefone, telefone_verificado_em, plano, premium_ate, sessoes_desde').eq('id', id).maybeSingle();
  const data = abrirConta(linha);
  const usuario = data // nunca expõe hash de senha nem código
    ? {
      id: data.id, nome: data.nome, email: data.email, admin: ehAdmin(data.email),
      telefone: data.telefone_verificado_em ? data.telefone : null,
      premium: ehPremium(data),
      premium_ate: ehPremium(data) ? data.premium_ate : null,
    }
    : null;
  const sessoesDesde = data?.sessoes_desde ? Date.parse(data.sessoes_desde) : 0;
  if (usuario) cacheUsuarios.set(id, { usuario, sessoesDesde, ate: Date.now() + 60_000 });
  return usuario;
}

// Login aceito: grava o cookie da sessão
export function entrar(req, res, usuarioId) {
  gravarCookie(req, res, criarToken(usuarioId), VALIDADE_MS);
}

// Coloca req.usuario quando há sessão válida (não bloqueia nada)
export async function carregarSessao(req, _res, next) {
  const token = lerToken(lerCookie(req));
  req.usuario = token ? await buscarUsuario(token.id).catch(() => null) : null;
  // Senha trocada depois que esta sessão foi aberta: a sessão antiga não vale mais
  if (req.usuario && token.emitido < (cacheUsuarios.get(token.id)?.sessoesDesde || 0)) req.usuario = null;
  next();
}

export function exigirLoginApi(req, res, next) {
  if (req.usuario) return next();
  res.status(401).json({ erro: 'Faça login de novo', login: true });
}

export const esquecerUsuario = (id) => cacheUsuarios.delete(id); // depois de mudar o telefone

export function exigirAdmin(req, res, next) {
  if (req.usuario?.admin) return next();
  res.status(403).json({ erro: 'Só quem administra o sistema pode fazer isso' });
}

export function exigirLoginPagina(req, res, next) {
  if (req.usuario) return next();
  res.redirect('/login');
}

// ---------- rotas ----------
const emailValido = (e) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e);

// O domínio do e-mail existe e recebe mensagens? (pega "gmial.com", "hotmail.con"...)
// Na dúvida (DNS lento ou fora), deixa passar: melhor do que barrar um e-mail certo.
const CONHECIDOS = ['gmail.com', 'hotmail.com', 'hotmail.com.br', 'outlook.com', 'outlook.com.br', 'live.com', 'msn.com',
  'yahoo.com', 'yahoo.com.br', 'icloud.com', 'me.com', 'bol.com.br', 'uol.com.br', 'terra.com.br', 'ig.com.br', 'globo.com', 'proton.me', 'protonmail.com'];
const dominiosOk = new Map(CONHECIDOS.map((d) => [d, true]));
let dnsFunciona = null, dnsConferidoEm = 0; // se nem o gmail.com resolve, o problema é o DNS do servidor, não o e-mail
async function dominioRecebeEmail(email) {
  const dominio = email.split('@')[1];
  if (dominiosOk.has(dominio)) return dominiosOk.get(dominio);
  const comPrazo = (p) => Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(Object.assign(new Error('demorou'), { code: 'TIMEOUT' })), 3000))]);
  if (dnsFunciona === null || Date.now() - dnsConferidoEm > 5 * 60_000) {
    dnsFunciona = await comPrazo(dns.resolveMx('gmail.com')).then(() => true, () => false);
    dnsConferidoEm = Date.now();
  }
  if (!dnsFunciona) return true;
  let ok = true;
  try {
    const mx = await comPrazo(dns.resolveMx(dominio));
    ok = mx.some((m) => m.exchange && m.exchange !== '.'); // MX "." = domínio que declara não receber e-mail
  } catch (e) {
    if (e.code === 'ENOTFOUND' || e.code === 'NXDOMAIN') ok = false;
    else if (e.code === 'ENODATA') ok = await comPrazo(dns.resolve4(dominio)).then((l) => l.length > 0, () => false); // sem MX, mas com endereço
  }
  if (dominiosOk.size > 5000) dominiosOk.clear();
  dominiosOk.set(dominio, ok);
  return ok;
}

export function rotasDeConta(app) {
  app.post('/api/cadastro', async (req, res) => {
    try {
      const limiteIp = cadastrosPorIp.checar(req.ip);
      if (!limiteIp.liberado) return recusar(res, limiteIp.esperaSeg, 'Muitas contas criadas daqui');
      const nome = String(req.body?.nome || '').trim();
      const email = String(req.body?.email || '').trim().toLowerCase();
      const senha = String(req.body?.senha || '');

      if (nome.length < 2) return res.status(400).json({ erro: 'Digite seu nome' });
      if (!emailValido(email)) return res.status(400).json({ erro: 'E-mail inválido' });
      if (!(await dominioRecebeEmail(email))) {
        return res.status(400).json({ erro: `O endereço "@${email.split('@')[1]}" não recebe e-mails. Confira se digitou certo.`, campo: 'email' });
      }
      if (senha.length < 8) return res.status(400).json({ erro: 'A senha precisa ter pelo menos 8 caracteres' });
      if (req.body?.aceite !== true) return res.status(400).json({ erro: 'Pra criar a conta, aceite os Termos de uso e a Política de privacidade' });

      const { data: existe } = await supabase.from('contas').select('id').eq('email_indice', indice('email', email)).maybeSingle();
      if (existe) return res.status(409).json({ erro: 'Já existe uma conta com esse e-mail' });

      const id = randomUUID(); // o id entra na cifra, por isso é gerado aqui
      const { error } = await supabase
        .from('contas')
        .insert({
          id, ...fecharConta(id, { nome, email }), senha_hash: await gerarHash(senha),
          termos_versao: TERMOS_VERSAO, termos_aceitos_em: new Date().toISOString(), // prova do aceite (LGPD)
        });
      if (error) throw error;
      const usuario = { id, nome, email };
      cadastrosPorIp.registrar(req.ip);

      gravarCookie(req, res, criarToken(usuario.id), VALIDADE_MS);
      res.status(201).json({ id: usuario.id, nome: usuario.nome, email: usuario.email, admin: ehAdmin(usuario.email) });
    } catch (e) {
      res.status(500).json({ erro: e.message });
    }
  });

  app.post('/api/login', async (req, res) => {
    try {
      const email = String(req.body?.email || '').trim().toLowerCase();
      const senha = String(req.body?.senha || '');
      if (!email || !senha) return res.status(400).json({ erro: 'Preencha e-mail e senha' });

      const porIp = falhasPorIp.checar(req.ip);
      if (!porIp.liberado) return recusar(res, porIp.esperaSeg);
      const porEmail = falhasPorEmail.checar(email);
      if (!porEmail.liberado) return recusar(res, porEmail.esperaSeg, 'Muitas senhas erradas nesta conta');

      const { data: linha } = await supabase
        .from('contas').select('id, nome, email, senha_hash').eq('email_indice', indice('email', email)).maybeSingle();
      const usuario = abrirConta(linha);
      const certa = usuario ? await conferirSenha(senha, usuario.senha_hash) : await conferirFalso(senha);
      if (!certa) {
        falhasPorEmail.registrar(email);
        falhasPorIp.registrar(req.ip);
        await espera(400 + Math.random() * 300); // deixa o chute de senha mais lento
        const travou = !falhasPorEmail.checar(email).liberado;
        return res.status(401).json({
          erro: travou ? 'E-mail ou senha incorretos. Por segurança, espere 15 minutos pra tentar de novo.' : 'E-mail ou senha incorretos',
        });
      }
      falhasPorEmail.zerar(email);
      if (precisaAtualizar(usuario.senha_hash)) { // scrypt antigo -> Argon2id, sem a pessoa perceber
        await supabase.from('contas').update({ senha_hash: await gerarHash(senha) }).eq('id', usuario.id);
      }
      gravarCookie(req, res, criarToken(usuario.id), VALIDADE_MS);
      res.json({ id: usuario.id, nome: usuario.nome, email: usuario.email, admin: ehAdmin(usuario.email) });
    } catch (e) {
      res.status(500).json({ erro: e.message });
    }
  });

  app.post('/api/logout', (req, res) => {
    gravarCookie(req, res, '', 0);
    res.json({ ok: true });
  });

  app.get('/api/me', exigirLoginApi, (req, res) => res.json(req.usuario));

  // Excluir a conta (LGPD art. 18): pede a senha de novo e apaga tudo. Lembretes, avisos e pagamentos
  // marcados somem junto (o banco apaga em cascata).
  app.post('/api/conta/excluir', exigirLoginApi, async (req, res) => {
    try {
      const chave = `excluir:${req.usuario.id}`;
      const limite = falhasPorEmail.checar(chave);
      if (!limite.liberado) return recusar(res, limite.esperaSeg, 'Muitas senhas erradas');
      const { data: linha } = await supabase.from('contas').select('id, senha_hash').eq('id', req.usuario.id).maybeSingle();
      if (!linha || !(await conferirSenha(String(req.body?.senha || ''), linha.senha_hash))) {
        falhasPorEmail.registrar(chave);
        await espera(400 + Math.random() * 300);
        return res.status(400).json({ erro: 'Senha incorreta' }); // 400 (não 401): o painel trata 401 como sessão expirada
      }
      // Para as cobranças no Asaas antes de apagar (se falhar, não apaga: melhor do que cobrar quem saiu)
      try {
        await cancelarAssinatura(req.usuario.id);
      } catch (e) {
        console.error('Cancelar assinatura ao excluir conta:', e.message);
        return res.status(502).json({ erro: 'Não deu pra cancelar sua assinatura agora. Tente de novo em instantes.' });
      }
      const { error } = await supabase.from('contas').delete().eq('id', req.usuario.id);
      if (error) throw error;
      cacheUsuarios.delete(req.usuario.id);
      gravarCookie(req, res, '', 0);
      console.log(`Conta excluída a pedido: ${req.usuario.id.slice(0, 8)}`);
      res.json({ ok: true });
    } catch (e) {
      res.status(500).json({ erro: e.message });
    }
  });
}
