import './silenciar-logs.js'; // precisa ser o primeiro import
import express from 'express';
import QRCode from 'qrcode';
import { createHash, randomInt, randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { supabase } from './supabase.js';
import {
  abrirConta, fecharConta, abrirLembrete, fecharLembrete, decifrarTextoEnvio, indice, configurarChaves,
} from './cripto.js';
import { migrarCriptografia } from './migrar-cripto.js';
import { paginaLegal } from './legal.js';
import * as whatsapp from './whatsapp.js';
import { sugerirMensagens, iaConfigurada, TONS } from './ia.js';
import { LIMITE_GRATIS, PRECOS, LINK_PAGAMENTO, situacaoDasContas, ehPremium as ehPremiumAgora } from './planos.js';
import { asaasLigado, ambienteAsaas, assinar, cancelarAssinatura, situacaoAssinatura, rotasWebhookAsaas } from './asaas.js';
import { tratarMensagem, tratarVoto, tratarEscolha } from './respostas.js';
import {
  TIPOS, montarTexto, enviarAviso, ENQUETE_LIGADA, OPCOES, partesDoAviso, textoDoModelo, regenerar, gerarTodos, iniciarAgendador, dispararPendentes, destravar,
  proximoVencimento, hojeBR, pagamentosDe, chavePago, marcarPago, desfazerPago, regenerarConta,
} from './lembretes.js';
import {
  carregarSessao, exigirLoginApi, exigirLoginPagina, exigirAdmin, rotasDeConta, esquecerUsuario,
} from './auth.js';

const PORT = process.env.PORT || 3000;
const raiz = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const pagina = (nome) => path.join(raiz, 'public', nome);

// Sem a chave da criptografia o servidor não sobe (melhor parar do que gravar dado pessoal aberto)
try {
  console.log(`Criptografia dos dados ligada (chave ${configurarChaves()}).`);
} catch (e) {
  console.error(`\n*** ${e.message} ***\n`);
  process.exit(1);
}

const app = express();
app.set('trust proxy', 1);
// rawBody: o webhook da API oficial confere a assinatura da Meta sobre o corpo original
app.use(express.json({ limit: '1mb', verify: (req, _res, buf) => { if (req.originalUrl.startsWith('/webhook/')) req.rawBody = buf; } }));

// ---- Pública (UptimeRobot) ----
app.get('/health', (_req, res) => res.json({ ok: true, whatsapp: whatsapp.getStatus().status }));

app.use('/marca', express.static(path.join(raiz, 'public', 'marca'), { maxAge: '7d' })); // logo e ícones
// favicon e ícones que navegadores e celulares procuram na raiz do site
const marca = (arq) => (req, res) => res.sendFile(path.join(raiz, 'public', 'marca', arq), { maxAge: '7d' });
app.get('/favicon.ico', marca('favicon.ico'));
app.get('/apple-touch-icon.png', marca('apple-touch-icon.png'));
app.get('/apple-touch-icon-precomposed.png', marca('apple-touch-icon.png'));
app.get('/site.webmanifest', (req, res) => res.type('application/manifest+json').sendFile(path.join(raiz, 'public', 'marca', 'site.webmanifest')));

// Webhook da API oficial do WhatsApp (só existe com WHATSAPP_PROVEDOR=oficial)
whatsapp.rotasWebhook(app);

// Webhook do Asaas: pagamento entrou -> liga o Premium; estorno -> desliga
const dataBR = (iso) => new Date(iso).toLocaleDateString('pt-BR', { timeZone: 'America/Sao_Paulo' });
rotasWebhookAsaas(app, async (contaId, { tipo, premium_ate, jid, primeiro }) => {
  esquecerUsuario(contaId);
  await regenerarConta(contaId).catch((e) => console.error('Regenerar depois do pagamento:', e.message));
  console.log(`Asaas: Premium ${tipo} pra conta ${contaId.slice(0, 8)}${premium_ate ? ` (até ${premium_ate.slice(0, 10)})` : ''}`);
  if (!jid || !whatsapp.online()) return;
  const texto = tipo === 'liberado'
    ? (primeiro
      ? `👑 *Pagamento confirmado!* Seu Lembra Aí Premium está liberado${premium_ate ? ` até ${dataBR(premium_ate)} (renova sozinho)` : ''}. Agora todos os seus lembretes funcionam, com vários avisos por conta. Obrigado! 💚`
      : `👑 Pagamento da renovação confirmado! Seu Premium segue valendo${premium_ate ? ` até ${dataBR(premium_ate)}` : ''}. 💚`)
    : 'Seu pagamento do Premium foi estornado, então a conta voltou pro plano Grátis. Qualquer dúvida, é só responder aqui.';
  await whatsapp.enviarTexto(jid, texto).catch(() => {}); // na API oficial, fora da janela de 24h, não chega (sem problema)
});

// Termos de uso e Política de privacidade (públicas)
app.get(['/termos', '/termos-de-uso'], (_req, res) => res.type('html').send(paginaLegal('termos.html')));
app.get(['/privacidade', '/politica-de-privacidade'], (_req, res) => res.type('html').send(paginaLegal('privacidade.html')));

app.use(carregarSessao);

// ---- Páginas ----
app.get('/login', (req, res) => (req.usuario ? res.redirect('/') : res.sendFile(pagina('login.html'))));
// Logado vê o painel; quem não está logado vê a página de apresentação
app.get(['/', '/index.html'], (req, res) => res.sendFile(pagina(req.usuario ? 'index.html' : 'lp.html')));
app.get('/painel', exigirLoginPagina, (_req, res) => res.sendFile(pagina('index.html')));

rotasDeConta(app);

// Preços e limites (público: a página de apresentação também usa)
app.get('/api/planos', (_req, res) => res.json({
  precos: PRECOS, limite_gratis: LIMITE_GRATIS, link_pagamento: LINK_PAGAMENTO, pagamento_online: asaasLigado,
}));

app.use('/api', exigirLoginApi);

const erroPadrao = (res, e, status = 500) => res.status(status).json({ erro: e.message || String(e) });

// O sistema está no ar? E qual o número dele (pra pessoa salvar o contato e o aviso não cair como spam)
app.get('/api/sistema', (_req, res) => res.json({ online: whatsapp.online(), numero: whatsapp.getStatus().numero }));

// =============== CONFIRMAR O NÚMERO ===============
const hashCodigo = (contaId, codigo) =>
  createHash('sha256').update(`${process.env.SUPABASE_SERVICE_ROLE_KEY}:${contaId}:${codigo}`).digest('hex');
const pedidosDeCodigo = new Map(); // contaId -> [timestamps] (limite por hora)

app.post('/api/telefone/codigo', async (req, res) => {
  try {
    if (!whatsapp.online()) return res.status(503).json({ erro: 'O sistema está fora do ar agora. Tente de novo mais tarde.' });
    const conta = req.usuario;

    const recentes = (pedidosDeCodigo.get(conta.id) || []).filter((t) => t > Date.now() - 3600_000);
    if (recentes.length && recentes.at(-1) > Date.now() - 60_000) {
      return res.status(429).json({ erro: 'Espere 1 minuto pra pedir outro código.' });
    }
    if (recentes.length >= 5) return res.status(429).json({ erro: 'Muitos códigos pedidos. Tente de novo em 1 hora.' });

    const telefone = String(req.body?.telefone || '').replace(/\D/g, '');
    const jid = await whatsapp.resolverNumero(telefone).catch((e) => { throw Object.assign(e, { status: 400 }); });

    const { data: dono } = await supabase
      .from('contas').select('id').eq('telefone_jid_indice', indice('jid', jid)).not('telefone_verificado_em', 'is', null).neq('id', conta.id)
      .maybeSingle();
    if (dono) return res.status(409).json({ erro: 'Esse número já está em outra conta.' });

    const codigo = String(randomInt(0, 10_000)).padStart(4, '0'); // 4 dígitos (vale 10 min, até 5 tentativas)
    const { error } = await supabase.from('contas').update({
      ...fecharConta(conta.id, { telefone_pendente: telefone, jid_pendente: jid }),
      codigo_hash: hashCodigo(conta.id, codigo),
      codigo_expira: new Date(Date.now() + 10 * 60_000).toISOString(),
      codigo_tentativas: 0,
    }).eq('id', conta.id);
    if (error) throw error;

    await whatsapp.enviarCodigo(jid, codigo);
    pedidosDeCodigo.set(conta.id, [...recentes, Date.now()]);
    res.json({ ok: true });
  } catch (e) {
    erroPadrao(res, e, e.status || 500);
  }
});

app.post('/api/telefone/confirmar', async (req, res) => {
  try {
    const codigo = String(req.body?.codigo || '').replace(/\D/g, '');
    if (codigo.length !== 4) return res.status(400).json({ erro: 'O código tem 4 números' });
    const { data: linha, error } = await supabase
      .from('contas')
      .select('id, telefone_pendente, jid_pendente, codigo_hash, codigo_expira, codigo_tentativas')
      .eq('id', req.usuario.id).single();
    if (error) throw error;
    const conta = abrirConta(linha);

    if (!conta.codigo_hash || !conta.codigo_expira || new Date(conta.codigo_expira) < new Date()) {
      return res.status(400).json({ erro: 'Código expirado. Peça um novo.' });
    }
    if (conta.codigo_tentativas >= 5) return res.status(429).json({ erro: 'Muitas tentativas erradas. Peça um novo código.' });

    if (hashCodigo(conta.id, codigo) !== conta.codigo_hash) {
      await supabase.from('contas').update({ codigo_tentativas: conta.codigo_tentativas + 1 }).eq('id', conta.id);
      return res.status(400).json({ erro: `Código incorreto. Você tem mais ${4 - conta.codigo_tentativas} tentativa(s).` });
    }

    const { error: erroUpd } = await supabase.from('contas').update({
      ...fecharConta(conta.id, { telefone: conta.telefone_pendente, telefone_jid: conta.jid_pendente, telefone_pendente: null, jid_pendente: null }),
      telefone_verificado_em: new Date().toISOString(),
      codigo_hash: null, codigo_expira: null, codigo_tentativas: 0,
    }).eq('id', conta.id);
    if (erroUpd) throw erroUpd;
    esquecerUsuario(conta.id);
    res.json({ ok: true, telefone: conta.telefone_pendente });
  } catch (e) {
    erroPadrao(res, e);
  }
});

// =============== LEMBRETES ===============
const AVISOS_PERMITIDOS = [0, 1, 2, 3, 5, 7, 10, 15];
const ICONES = ['luz', 'agua', 'internet', 'aluguel', 'cartao', 'boleto', 'gas', 'telefone', 'celular', 'carro', 'saude', 'escola',
  'academia', 'streaming', 'mercado', 'condominio', 'seguro', 'imposto', 'pet', 'presente', 'investimento', 'outro', 'sino'];
const CORES = ['amarelo', 'azul', 'roxo', 'laranja', 'rosa', 'ciano', 'verde', 'vermelho', 'cinza'];

// Número de cartão (13 a 19 dígitos que passam no teste de Luhn), mesmo com espaços ou traços
function temNumeroDeCartao(texto) {
  for (const m of String(texto || '').matchAll(/\d(?:[ .-]?\d){12,18}/g)) {
    const d = m[0].replace(/\D/g, '');
    let soma = 0;
    for (let i = 0; i < d.length; i++) {
      let n = Number(d[d.length - 1 - i]);
      if (i % 2 === 1) { n *= 2; if (n > 9) n -= 9; }
      soma += n;
    }
    if (soma % 10 === 0 && !/^(\d)\1+$/.test(d)) return true;
  }
  return false;
}
const AVISO_CARTAO = 'Por segurança, não coloque o número do cartão aqui. Use só um apelido, tipo "Fatura Nubank".';

function validarLembrete(b) {
  const tipo = TIPOS[b.tipo] ? b.tipo : 'outro';
  const titulo = String(b.titulo || '').trim() || TIPOS[tipo].titulo;
  if (titulo.length > 60) throw new Error('Nome muito longo (máx. 60 letras)');
  if (temNumeroDeCartao(titulo)) throw new Error(AVISO_CARTAO);

  let valor = null;
  if (b.valor !== undefined && b.valor !== null && String(b.valor).trim() !== '') {
    valor = Number(String(b.valor).replace(/[R$\s.]/g, '').replace(',', '.'));
    if (!Number.isFinite(valor) || valor < 0 || valor > 1e9) throw new Error('Valor inválido');
  }

  const frequencia = b.frequencia === 'unica' ? 'unica' : 'mensal';
  let dia = null;
  let data = null;
  if (frequencia === 'mensal') {
    dia = Number(b.dia);
    if (!Number.isInteger(dia) || dia < 1 || dia > 31) throw new Error('Escolha o dia do vencimento (1 a 31)');
  } else {
    data = String(b.data || '');
    if (!/^\d{4}-\d{2}-\d{2}$/.test(data) || Number.isNaN(Date.parse(data))) throw new Error('Escolha a data do vencimento');
    if (data < hojeBR().str) throw new Error('A data do vencimento já passou');
  }

  const avisos = [...new Set((Array.isArray(b.avisos) ? b.avisos : [0]).map(Number))]
    .filter((d) => AVISOS_PERMITIDOS.includes(d)).sort((x, y) => y - x);
  if (!avisos.length) throw new Error('Escolha pelo menos um aviso');

  const horario = String(b.horario || '09:00').slice(0, 5);
  if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(horario)) throw new Error('Horário inválido');

  const mensagem = String(b.mensagem || '').trim() || null;
  if (mensagem && mensagem.length > 600) throw new Error('Mensagem muito longa (máx. 600 caracteres)');
  if (temNumeroDeCartao(mensagem)) throw new Error(AVISO_CARTAO);

  const icone = ICONES.includes(b.icone) ? b.icone : null; // vazio = segue o tipo
  const cor = CORES.includes(b.cor) ? b.cor : null;

  return { tipo, titulo, valor, frequencia, dia, data, avisos, horario, mensagem, icone, cor };
}

// O que o plano grátis não deixa salvar. Devolve a mensagem de erro (ou null se pode).
function bloqueioDoPlano(usuario, campos) {
  if (usuario.premium) return null;
  if (campos.avisos.length > LIMITE_GRATIS.avisos) return 'No plano Grátis é 1 aviso por lembrete. Vários avisos são do Premium.';
  if (campos.mensagem) return 'Mensagem personalizada é do Premium. No Grátis vai a mensagem padrão.';
  if (campos.icone || campos.cor) return 'Ícone e cor personalizados são do Premium.';
  return null;
}
const pedirPremium = (res, erro) => res.status(403).json({ erro, premium: true });

// Junta informações úteis pra tela: vencimento atual (pago ou não), próximo em aberto e próximo aviso
async function enriquecer(lembretes) {
  if (!lembretes.length) return [];
  const pagos = await pagamentosDe(lembretes.map((l) => l.id));
  const situacoes = await situacaoDasContas(lembretes.map((l) => l.conta_id));
  const { data: proximos } = await supabase
    .from('envios').select('lembrete_id, enviar_em, dias_antes, vencimento')
    .in('lembrete_id', lembretes.map((l) => l.id)).eq('status', 'pendente')
    .order('enviar_em', { ascending: true });
  const proximoPor = new Map();
  for (const e of proximos || []) if (!proximoPor.has(e.lembrete_id)) proximoPor.set(e.lembrete_id, e);
  return lembretes.map((l) => {
    const atual = proximoVencimento(l); // ignorando pagamentos
    const s = situacoes.get(l.conta_id);
    return {
      ...l,
      travado: Boolean(s && !s.premium && s.liberados && !s.liberados.has(l.id)), // grátis: além dos 3 primeiros
      vencimento_atual: atual,
      atual_pago: Boolean(atual && pagos.has(chavePago(l.id, atual))),
      proximo_vencimento: proximoVencimento(l, new Date(), pagos), // próximo ainda em aberto
      proximo_aviso: proximoPor.get(l.id)?.enviar_em || null,
    };
  });
}

const lembreteDoUsuario = async (req) => abrirLembrete(
  (await supabase.from('lembretes').select('*').eq('id', req.params.id).eq('conta_id', req.usuario.id).maybeSingle()).data,
);

app.get('/api/lembretes', async (req, res) => {
  const { data, error } = await supabase
    .from('lembretes').select('*').eq('conta_id', req.usuario.id).order('criado_em', { ascending: true });
  if (error) return erroPadrao(res, error);
  res.json(await enriquecer((data || []).map(abrirLembrete)));
});

app.post('/api/lembretes', async (req, res) => {
  try {
    if (!req.usuario.telefone) return res.status(403).json({ erro: 'Confirme seu número de WhatsApp antes de criar lembretes' });
    let campos;
    try { campos = validarLembrete(req.body || {}); } catch (e) { return erroPadrao(res, e, 400); }
    if (!req.usuario.premium) {
      const { count } = await supabase.from('lembretes').select('id', { count: 'exact', head: true }).eq('conta_id', req.usuario.id);
      if ((count ?? 0) >= LIMITE_GRATIS.lembretes) {
        return pedirPremium(res, `No plano Grátis dá pra ter até ${LIMITE_GRATIS.lembretes} lembretes. Com o Premium é ilimitado.`);
      }
    }
    const bloqueio = bloqueioDoPlano(req.usuario, campos);
    if (bloqueio) return pedirPremium(res, bloqueio);
    const id = randomUUID(); // o id entra na cifra, por isso é gerado aqui
    const { data: linha, error } = await supabase
      .from('lembretes').insert({ id, ...fecharLembrete(id, campos), conta_id: req.usuario.id }).select().single();
    if (error) throw error;
    const data = abrirLembrete(linha);
    await regenerar(data);
    res.status(201).json((await enriquecer([data]))[0]);
  } catch (e) {
    erroPadrao(res, e);
  }
});

app.put('/api/lembretes/:id', async (req, res) => {
  try {
    const atual = await lembreteDoUsuario(req);
    if (!atual) return res.status(404).json({ erro: 'Lembrete não encontrado' });
    let campos;
    try { campos = validarLembrete(req.body || {}); } catch (e) { return erroPadrao(res, e, 400); }
    const bloqueio = bloqueioDoPlano(req.usuario, campos);
    if (bloqueio) return pedirPremium(res, bloqueio);
    const { data: linha, error } = await supabase
      .from('lembretes').update({ ...fecharLembrete(atual.id, campos), atualizado_em: new Date().toISOString() })
      .eq('id', atual.id).select().single();
    if (error) throw error;
    const data = abrirLembrete(linha);
    await regenerar(data);
    res.json((await enriquecer([data]))[0]);
  } catch (e) {
    erroPadrao(res, e);
  }
});

app.post('/api/lembretes/:id/ativo', async (req, res) => {
  try {
    const atual = await lembreteDoUsuario(req);
    if (!atual) return res.status(404).json({ erro: 'Lembrete não encontrado' });
    const { data: linha, error } = await supabase
      .from('lembretes').update({ ativo: Boolean(req.body?.ativo), atualizado_em: new Date().toISOString() })
      .eq('id', atual.id).select().single();
    if (error) throw error;
    const data = abrirLembrete(linha);
    await regenerar(data); // pausado: apaga os avisos futuros; ativado: recria
    res.json((await enriquecer([data]))[0]);
  } catch (e) {
    erroPadrao(res, e);
  }
});

app.delete('/api/lembretes/:id', async (req, res) => {
  const { error } = await supabase.from('lembretes').delete().eq('id', req.params.id).eq('conta_id', req.usuario.id);
  if (error) return erroPadrao(res, error);
  res.json({ ok: true });
});

// Marcar como paga pelo site (o mesmo que responder "paguei" no WhatsApp)
app.post('/api/lembretes/:id/pago', async (req, res) => {
  try {
    const lembrete = await lembreteDoUsuario(req);
    if (!lembrete) return res.status(404).json({ erro: 'Lembrete não encontrado' });
    const pagos = await pagamentosDe([lembrete.id]);
    const vencimento = req.body?.vencimento || proximoVencimento(lembrete, new Date(), pagos);
    if (!vencimento || !/^\d{4}-\d{2}-\d{2}$/.test(vencimento)) return res.status(400).json({ erro: 'Nenhum vencimento em aberto' });
    await marcarPago({ lembrete, vencimento, origem: 'site' });
    res.json((await enriquecer([lembrete]))[0]);
  } catch (e) {
    erroPadrao(res, e);
  }
});

app.delete('/api/lembretes/:id/pago', async (req, res) => {
  try {
    const lembrete = await lembreteDoUsuario(req);
    if (!lembrete) return res.status(404).json({ erro: 'Lembrete não encontrado' });
    const vencimento = String(req.body?.vencimento || '');
    if (!/^\d{4}-\d{2}-\d{2}$/.test(vencimento)) return res.status(400).json({ erro: 'Vencimento inválido' });
    await desfazerPago({ lembrete, vencimento });
    res.json((await enriquecer([lembrete]))[0]);
  } catch (e) {
    erroPadrao(res, e);
  }
});

// Prévia do texto, pra tela mostrar enquanto a pessoa preenche
app.post('/api/lembretes/previa', (req, res) => {
  try {
    const campos = validarLembrete({ ...req.body, data: req.body?.data || hojeBR().str });
    const vencimento = proximoVencimento(campos) || hojeBR().str;
    const args = { lembrete: campos, nome: req.usuario.nome, vencimento, diasAntes: campos.avisos[0] };
    if (whatsapp.MODO === 'oficial') { // modelo aprovado da Meta + botões
      const texto = campos.mensagem && process.env.WHATSAPP_MODELO_PERSONALIZADO ? montarTexto({ ...args, rodape: false }) : textoDoModelo(partesDoAviso(args));
      return res.json({ texto, enquete: ['Já paguei', 'Me lembra mais tarde'], botoes: true });
    }
    res.json(ENQUETE_LIGADA
      ? { texto: montarTexto({ ...args, rodape: false }), enquete: Object.values(OPCOES.aviso) }
      : { texto: montarTexto(args), enquete: null });
  } catch (e) {
    erroPadrao(res, e, 400);
  }
});

// Sugestões de mensagem com IA (Gemini). Só o tipo e o tom vão pra IA; nada da pessoa.
app.post('/api/lembretes/sugerir', async (req, res) => {
  try {
    if (!req.usuario.premium) return pedirPremium(res, 'As sugestões com IA são do Premium.');
    const tipo = String(req.body?.tipo || 'outro');
    const tom = String(req.body?.tom || 'amigavel');
    const temValor = req.body?.valor !== undefined && String(req.body.valor).trim() !== '';
    res.json(await sugerirMensagens({ contaId: req.usuario.id, tipo, tom, temValor }));
  } catch (e) {
    erroPadrao(res, e, e.status || 500);
  }
});

app.get('/api/ia', (_req, res) => res.json({ configurada: iaConfigurada(), tons: Object.keys(TONS) }));

// Manda agora, pra pessoa ver como chega
app.post('/api/lembretes/:id/testar', async (req, res) => {
  try {
    if (!whatsapp.online()) return res.status(503).json({ erro: 'O sistema está fora do ar agora.' });
    const encontrado = await lembreteDoUsuario(req);
    if (!encontrado) return res.status(404).json({ erro: 'Lembrete não encontrado' });
    const lembrete = req.usuario.premium ? encontrado : { ...encontrado, mensagem: null }; // grátis: mensagem padrão
    const conta = abrirConta((await supabase
      .from('contas').select('id, nome, telefone_jid, telefone_verificado_em').eq('id', req.usuario.id).single()).data);
    if (!conta.telefone_verificado_em) return res.status(400).json({ erro: 'Confirme seu número antes' });
    const hoje = hojeBR().str;
    const vencimento = proximoVencimento(lembrete) || hoje;
    const diasAntes = Math.max(0, Math.round((Date.parse(vencimento) - Date.parse(hoje)) / 86_400_000)); // dias reais até vencer
    await enviarAviso({ jid: conta.telefone_jid, contaId: conta.id, lembrete, nome: conta.nome, vencimento, diasAntes, prefixo: '🧪 Teste\n\n' });
    res.json({ ok: true });
  } catch (e) {
    erroPadrao(res, e);
  }
});

// Histórico: últimos avisos enviados (ou com problema)
app.get('/api/envios', async (req, res) => {
  const { data, error } = await supabase
    .from('envios').select('id, lembrete_id, vencimento, dias_antes, enviar_em, status, texto, erro, enviado_em')
    .eq('conta_id', req.usuario.id).neq('status', 'pendente')
    .order('enviar_em', { ascending: false }).limit(30);
  if (error) return erroPadrao(res, error);
  res.json((data || []).map((e) => ({ ...e, texto: decifrarTextoEnvio(e.id, e.texto) })));
});

// =============== ASSINATURA (Asaas) ===============
app.get('/api/assinatura', async (req, res) => {
  try { res.json(await situacaoAssinatura(req.usuario.id)); } catch (e) { erroPadrao(res, e); }
});

const pedidosDeAssinatura = new Map(); // contaId -> último pedido (evita clique duplo criar duas assinaturas)
app.post('/api/assinatura', async (req, res) => {
  try {
    const id = req.usuario.id;
    if ((pedidosDeAssinatura.get(id) || 0) > Date.now() - 8000) return res.status(429).json({ erro: 'Só um instante, já estamos gerando sua fatura.' });
    pedidosDeAssinatura.set(id, Date.now());
    const r = await assinar(id, { periodo: req.body?.periodo, documento: req.body?.documento });
    res.json(r);
  } catch (e) {
    pedidosDeAssinatura.delete(req.usuario.id);
    if (e.pedirDocumento) return res.status(400).json({ erro: e.message, pedirDocumento: true });
    erroPadrao(res, e, e.status || 500);
  }
});

app.post('/api/assinatura/cancelar', async (req, res) => {
  try {
    const r = await cancelarAssinatura(req.usuario.id);
    esquecerUsuario(req.usuario.id);
    res.json(r);
  } catch (e) {
    erroPadrao(res, e, e.status || 500);
  }
});

// =============== MEUS DADOS (LGPD art. 18: acesso e portabilidade) ===============
app.get('/api/conta/dados', async (req, res) => {
  try {
    const id = req.usuario.id;
    const conta = abrirConta((await supabase.from('contas')
      .select('id, nome, email, telefone, telefone_verificado_em, plano, premium_ate, criado_em, termos_versao, termos_aceitos_em')
      .eq('id', id).single()).data);
    const lembretes = ((await supabase.from('lembretes').select('*').eq('conta_id', id).order('criado_em')).data || []).map(abrirLembrete);
    const nomeDo = new Map(lembretes.map((l) => [l.id, l.titulo]));
    const pagamentos = (await supabase.from('pagamentos').select('lembrete_id, vencimento, origem, pago_em').eq('conta_id', id).order('pago_em')).data || [];
    const envios = (await supabase.from('envios').select('id, lembrete_id, vencimento, dias_antes, enviar_em, status, texto, enviado_em')
      .eq('conta_id', id).order('enviar_em').limit(10000)).data || [];
    const arquivo = {
      sobre: 'Cópia dos seus dados no Lembra Aí (LGPD, art. 18). Gerada a seu pedido.',
      gerado_em: new Date().toISOString(),
      conta: {
        nome: conta.nome, email: conta.email,
        whatsapp: conta.telefone_verificado_em ? conta.telefone : null, whatsapp_confirmado_em: conta.telefone_verificado_em,
        plano: ehPremiumAgora(conta) ? 'premium' : 'gratis', premium_ate: conta.premium_ate,
        criada_em: conta.criado_em, termos_versao: conta.termos_versao, termos_aceitos_em: conta.termos_aceitos_em,
      },
      lembretes: lembretes.map((l) => ({
        nome: l.titulo, tipo: l.tipo, valor: l.valor, frequencia: l.frequencia, dia: l.dia, data: l.data,
        avisos_dias_antes: l.avisos, horario: l.horario, mensagem: l.mensagem, icone: l.icone, cor: l.cor, ativo: l.ativo, criado_em: l.criado_em,
      })),
      pagamentos_marcados: pagamentos.map((p) => ({ lembrete: nomeDo.get(p.lembrete_id) || null, vencimento: p.vencimento, por: p.origem, em: p.pago_em })),
      avisos: envios.map((e) => ({
        lembrete: nomeDo.get(e.lembrete_id) || null, vencimento: e.vencimento, dias_antes: e.dias_antes,
        previsto_para: e.enviar_em, status: e.status, enviado_em: e.enviado_em, texto: decifrarTextoEnvio(e.id, e.texto),
      })),
    };
    res.set('Content-Disposition', `attachment; filename="lembra-ai-meus-dados-${new Date().toISOString().slice(0, 10)}.json"`);
    res.set('Cache-Control', 'no-store');
    res.type('application/json').send(JSON.stringify(arquivo, null, 2));
  } catch (e) {
    erroPadrao(res, e);
  }
});

// =============== ADMIN: NÚMERO DO SISTEMA ===============
app.get('/api/admin/whatsapp', exigirAdmin, async (_req, res) => {
  const st = whatsapp.getStatus();
  const qr = whatsapp.getQr();
  res.json({ ...st, qr: qr ? await QRCode.toDataURL(qr, { width: 300, margin: 1 }) : null });
});

app.post('/api/admin/whatsapp/conectar', exigirAdmin, async (_req, res) => {
  try {
    await whatsapp.conectar();
    res.json({ ok: true });
  } catch (e) {
    erroPadrao(res, e);
  }
});

app.post('/api/admin/whatsapp/desconectar', exigirAdmin, async (_req, res) => {
  await whatsapp.desconectar();
  res.json({ ok: true });
});

// Admin: ver e mudar o plano de uma conta pelo e-mail (até o pagamento automático existir)
app.get('/api/admin/conta', exigirAdmin, async (req, res) => {
  const email = String(req.query.email || '').trim().toLowerCase();
  const data = abrirConta((await supabase.from('contas').select('id, nome, email, plano, premium_ate, telefone_verificado_em, criado_em, assinatura_status, assinatura_periodo')
    .eq('email_indice', indice('email', email)).maybeSingle()).data);
  if (!data) return res.status(404).json({ erro: 'Nenhuma conta com esse e-mail' });
  const { count } = await supabase.from('lembretes').select('id', { count: 'exact', head: true }).eq('conta_id', data.id);
  const { id, nome, email: mail, plano, premium_ate, telefone_verificado_em, criado_em, assinatura_status, assinatura_periodo } = data; // só o necessário
  res.json({ id, nome, email: mail, plano, premium_ate, telefone_verificado_em, criado_em, lembretes: count ?? 0, premium: ehPremiumAgora(data), assinatura_status, assinatura_periodo });
});

app.post('/api/admin/plano', exigirAdmin, async (req, res) => {
  try {
    const email = String(req.body?.email || '').trim().toLowerCase();
    const plano = req.body?.plano === 'premium' ? 'premium' : 'gratis';
    const dias = Number(req.body?.dias) || null; // vazio = sem prazo
    const { data: conta } = await supabase.from('contas').select('id, plano, premium_ate').eq('email_indice', indice('email', email)).maybeSingle();
    if (!conta) return res.status(404).json({ erro: 'Nenhuma conta com esse e-mail' });

    let premium_ate = null;
    if (plano === 'premium' && dias) {
      // renovação soma a partir do fim do período atual, se ainda estiver valendo
      const base = conta.plano === 'premium' && conta.premium_ate && Date.parse(conta.premium_ate) > Date.now()
        ? Date.parse(conta.premium_ate) : Date.now();
      premium_ate = new Date(base + dias * 86_400_000).toISOString();
    }
    const { error } = await supabase.from('contas').update({ plano, premium_ate }).eq('id', conta.id);
    if (error) throw error;
    esquecerUsuario(conta.id);
    await regenerarConta(conta.id); // libera ou limita os avisos na hora
    res.json({ ok: true, plano, premium_ate });
  } catch (e) {
    erroPadrao(res, e);
  }
});

app.get('/api/admin/resumo', exigirAdmin, async (_req, res) => {
  const contar = async (tabela, filtro = (q) => q) => {
    const { count } = await filtro(supabase.from(tabela).select('id', { count: 'exact', head: true }));
    return count ?? 0;
  };
  const inicioDoDia = new Date(`${hojeBR().str}T00:00:00-03:00`).toISOString();
  res.json({
    contas: await contar('contas'),
    lembretes_ativos: await contar('lembretes', (q) => q.eq('ativo', true)),
    enviados_hoje: await contar('envios', (q) => q.eq('status', 'enviado').gte('enviado_em', inicioDoDia)),
    pendentes: await contar('envios', (q) => q.eq('status', 'pendente')),
    premium: await contar('contas', (q) => q.eq('plano', 'premium').or(`premium_ate.is.null,premium_ate.gt.${new Date().toISOString()}`)),
  });
});

// Qualquer endereço que não existe: API responde JSON, o resto vê a página 404
app.use((req, res) => {
  if (req.path.startsWith('/api/')) return res.status(404).json({ erro: 'Rota não encontrada' });
  res.status(404).sendFile(pagina('404.html'));
});

app.use((err, _req, res, _next) => {
  console.error(err);
  res.status(500).json({ erro: err.message });
});

// =============== SUBIDA ===============
// Antes de atender: cifra o que ainda estiver aberto no banco (ou regrava com a chave nova)
try {
  await migrarCriptografia();
} catch (e) {
  console.error('Erro ao cifrar os dados existentes:', e.message);
  process.exit(1);
}

app.listen(PORT, async () => {
  console.log(`Servidor na porta ${PORT}`);
  console.log(asaasLigado ? `Asaas ligado (${ambienteAsaas}). Webhook: /webhook/asaas` : 'Asaas desligado (sem ASAAS_API_KEY): o botão de assinar usa o PREMIUM_LINK, se houver.');
  await destravar().catch(() => {});
  whatsapp.quandoChegarMensagem(tratarMensagem); // "paguei", "desfazer", "parar", "ajuda"
  whatsapp.quandoChegarVoto(tratarVoto); // chip: toque nas enquetes ("Já paguei", "Me lembra mais tarde")
  whatsapp.quandoChegarEscolha(tratarEscolha); // API oficial: toque nos botões e na lista
  whatsapp.iniciar()
    .then((tinha) => console.log(whatsapp.MODO === 'oficial'
      ? (tinha ? 'API oficial do WhatsApp pronta.' : 'API oficial do WhatsApp sem configuração (veja as variáveis WHATSAPP_*).')
      : (tinha ? 'Reconectando o WhatsApp do sistema...' : 'WhatsApp do sistema ainda não conectado (admin precisa ler o QR).')))
    .catch((e) => console.error('Erro ao iniciar o WhatsApp:', e.message));
  gerarTodos().then((n) => console.log(`${n} aviso(s) conferido(s).`)).catch((e) => console.error('Erro ao gerar avisos:', e.message));
  iniciarAgendador();
  setTimeout(dispararPendentes, 20_000);
});

