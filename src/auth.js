// Login, cadastro e sessão por cookie — sem dependências externas (mesma base do Agendador).
// Senhas: scrypt com sal. Sessão: cookie assinado (HMAC) com validade de 30 dias.
import { scrypt as scryptCb, randomBytes, timingSafeEqual, createHmac, createHash } from 'node:crypto';
import { promisify } from 'node:util';
import { supabase } from './supabase.js';
import { criarLimite, recusar } from './limites.js';
import { ehPremium } from './planos.js';

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
async function gerarHash(senha) {
  const sal = randomBytes(16);
  const hash = await scrypt(senha, sal, 64);
  return `scrypt$${sal.toString('base64')}$${hash.toString('base64')}`;
}

async function conferirSenha(senha, guardado) {
  const [alg, salB64, hashB64] = String(guardado).split('$');
  if (alg !== 'scrypt' || !salB64 || !hashB64) return false;
  const esperado = Buffer.from(hashB64, 'base64');
  const calculado = await scrypt(senha, Buffer.from(salB64, 'base64'), esperado.length);
  return timingSafeEqual(esperado, calculado);
}

// ---------- token da sessão ----------
const assinar = (dados) => createHmac('sha256', SEGREDO).update(dados).digest('base64url');

function criarToken(usuarioId) {
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
    return e > Date.now() ? u : null;
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
  const { data } = await supabase
    .from('contas').select('id, nome, email, telefone, telefone_verificado_em, plano, premium_ate').eq('id', id).maybeSingle();
  const usuario = data // nunca expõe hash de senha nem código
    ? {
      id: data.id, nome: data.nome, email: data.email, admin: ehAdmin(data.email),
      telefone: data.telefone_verificado_em ? data.telefone : null,
      premium: ehPremium(data),
      premium_ate: ehPremium(data) ? data.premium_ate : null,
    }
    : null;
  if (usuario) cacheUsuarios.set(id, { usuario, ate: Date.now() + 60_000 });
  return usuario;
}

// Coloca req.usuario quando há sessão válida (não bloqueia nada)
export async function carregarSessao(req, _res, next) {
  const id = lerToken(lerCookie(req));
  req.usuario = id ? await buscarUsuario(id).catch(() => null) : null;
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
      if (senha.length < 8) return res.status(400).json({ erro: 'A senha precisa ter pelo menos 8 caracteres' });

      const { data: existe } = await supabase.from('contas').select('id').eq('email', email).maybeSingle();
      if (existe) return res.status(409).json({ erro: 'Já existe uma conta com esse e-mail' });

      const { data: usuario, error } = await supabase
        .from('contas')
        .insert({ nome, email, senha_hash: await gerarHash(senha) })
        .select('id, nome, email')
        .single();
      if (error) throw error;
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

      const { data: usuario } = await supabase
        .from('contas').select('id, nome, email, senha_hash').eq('email', email).maybeSingle();
      if (!usuario || !(await conferirSenha(senha, usuario.senha_hash))) {
        falhasPorEmail.registrar(email);
        falhasPorIp.registrar(req.ip);
        await espera(400 + Math.random() * 300); // deixa o chute de senha mais lento
        const travou = !falhasPorEmail.checar(email).liberado;
        return res.status(401).json({
          erro: travou ? 'E-mail ou senha incorretos. Por segurança, espere 15 minutos pra tentar de novo.' : 'E-mail ou senha incorretos',
        });
      }
      falhasPorEmail.zerar(email);
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
}
