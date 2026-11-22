import './silenciar-logs.js'; // precisa ser o primeiro import
import express from 'express';
import QRCode from 'qrcode';
import { createHash, randomInt } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { supabase } from './supabase.js';
import * as whatsapp from './whatsapp.js';
import { sugerirMensagens, iaConfigurada, TONS } from './ia.js';
import { tratarMensagem } from './respostas.js';
import {
  TIPOS, montarTexto, regenerar, gerarTodos, iniciarAgendador, dispararPendentes, destravar,
  proximoVencimento, hojeBR, pagamentosDe, chavePago, marcarPago, desfazerPago,
} from './lembretes.js';
import {
  carregarSessao, exigirLoginApi, exigirLoginPagina, exigirAdmin, rotasDeConta, esquecerUsuario,
} from './auth.js';

const PORT = process.env.PORT || 3000;
const raiz = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const pagina = (nome) => path.join(raiz, 'public', nome);

const app = express();
app.set('trust proxy', 1);
app.use(express.json());

// ---- Pública (UptimeRobot) ----
app.get('/health', (_req, res) => res.json({ ok: true, whatsapp: whatsapp.getStatus().status }));

app.use(carregarSessao);

// ---- Páginas ----
app.get('/login', (req, res) => (req.usuario ? res.redirect('/') : res.sendFile(pagina('login.html'))));
app.get(['/', '/index.html'], exigirLoginPagina, (_req, res) => res.sendFile(pagina('index.html')));

rotasDeConta(app);
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
      .from('contas').select('id').eq('telefone_jid', jid).not('telefone_verificado_em', 'is', null).neq('id', conta.id)
      .maybeSingle();
    if (dono) return res.status(409).json({ erro: 'Esse número já está em outra conta.' });

    const codigo = String(randomInt(0, 1_000_000)).padStart(6, '0');
    const { error } = await supabase.from('contas').update({
      telefone_pendente: telefone,
      jid_pendente: jid,
      codigo_hash: hashCodigo(conta.id, codigo),
      codigo_expira: new Date(Date.now() + 10 * 60_000).toISOString(),
      codigo_tentativas: 0,
    }).eq('id', conta.id);
    if (error) throw error;

    await whatsapp.enviarTexto(jid, `🔐 Seu código de confirmação é *${codigo}*.\n\nEle vale por 10 minutos. Se não foi você que pediu, pode ignorar esta mensagem.`);
    pedidosDeCodigo.set(conta.id, [...recentes, Date.now()]);
    res.json({ ok: true });
  } catch (e) {
    erroPadrao(res, e, e.status || 500);
  }
});

app.post('/api/telefone/confirmar', async (req, res) => {
  try {
    const codigo = String(req.body?.codigo || '').replace(/\D/g, '');
    const { data: conta, error } = await supabase
      .from('contas')
      .select('id, telefone_pendente, jid_pendente, codigo_hash, codigo_expira, codigo_tentativas')
      .eq('id', req.usuario.id).single();
    if (error) throw error;

    if (!conta.codigo_hash || !conta.codigo_expira || new Date(conta.codigo_expira) < new Date()) {
      return res.status(400).json({ erro: 'Código expirado. Peça um novo.' });
    }
    if (conta.codigo_tentativas >= 5) return res.status(429).json({ erro: 'Muitas tentativas erradas. Peça um novo código.' });

    if (hashCodigo(conta.id, codigo) !== conta.codigo_hash) {
      await supabase.from('contas').update({ codigo_tentativas: conta.codigo_tentativas + 1 }).eq('id', conta.id);
      return res.status(400).json({ erro: `Código incorreto. Você tem mais ${4 - conta.codigo_tentativas} tentativa(s).` });
    }

    const { error: erroUpd } = await supabase.from('contas').update({
      telefone: conta.telefone_pendente,
      telefone_jid: conta.jid_pendente,
      telefone_verificado_em: new Date().toISOString(),
      telefone_pendente: null, jid_pendente: null, codigo_hash: null, codigo_expira: null, codigo_tentativas: 0,
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

function validarLembrete(b) {
  const tipo = TIPOS[b.tipo] ? b.tipo : 'outro';
  const titulo = String(b.titulo || '').trim() || TIPOS[tipo].titulo;
  if (titulo.length > 60) throw new Error('Nome muito longo (máx. 60 letras)');

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

  return { tipo, titulo, valor, frequencia, dia, data, avisos, horario, mensagem };
}

// Junta informações úteis pra tela: vencimento atual (pago ou não), próximo em aberto e próximo aviso
async function enriquecer(lembretes) {
  if (!lembretes.length) return [];
  const pagos = await pagamentosDe(lembretes.map((l) => l.id));
  const { data: proximos } = await supabase
    .from('envios').select('lembrete_id, enviar_em, dias_antes, vencimento')
    .in('lembrete_id', lembretes.map((l) => l.id)).eq('status', 'pendente')
    .order('enviar_em', { ascending: true });
  const proximoPor = new Map();
  for (const e of proximos || []) if (!proximoPor.has(e.lembrete_id)) proximoPor.set(e.lembrete_id, e);
  return lembretes.map((l) => {
    const atual = proximoVencimento(l); // ignorando pagamentos
    return {
      ...l,
      vencimento_atual: atual,
      atual_pago: Boolean(atual && pagos.has(chavePago(l.id, atual))),
      proximo_vencimento: proximoVencimento(l, new Date(), pagos), // próximo ainda em aberto
      proximo_aviso: proximoPor.get(l.id)?.enviar_em || null,
    };
  });
}

const doUsuario = (req) => supabase.from('lembretes').select('*').eq('id', req.params.id).eq('conta_id', req.usuario.id);

app.get('/api/lembretes', async (req, res) => {
  const { data, error } = await supabase
    .from('lembretes').select('*').eq('conta_id', req.usuario.id).order('criado_em', { ascending: true });
  if (error) return erroPadrao(res, error);
  res.json(await enriquecer(data || []));
});

app.post('/api/lembretes', async (req, res) => {
  try {
    if (!req.usuario.telefone) return res.status(403).json({ erro: 'Confirme seu número de WhatsApp antes de criar lembretes' });
    let campos;
    try { campos = validarLembrete(req.body || {}); } catch (e) { return erroPadrao(res, e, 400); }
    const { data, error } = await supabase
      .from('lembretes').insert({ ...campos, conta_id: req.usuario.id }).select().single();
    if (error) throw error;
    await regenerar(data);
    res.status(201).json((await enriquecer([data]))[0]);
  } catch (e) {
    erroPadrao(res, e);
  }
});

app.put('/api/lembretes/:id', async (req, res) => {
  try {
    const { data: atual } = await doUsuario(req).maybeSingle();
    if (!atual) return res.status(404).json({ erro: 'Lembrete não encontrado' });
    let campos;
    try { campos = validarLembrete(req.body || {}); } catch (e) { return erroPadrao(res, e, 400); }
    const { data, error } = await supabase
      .from('lembretes').update({ ...campos, atualizado_em: new Date().toISOString() })
      .eq('id', atual.id).select().single();
    if (error) throw error;
    await regenerar(data);
    res.json((await enriquecer([data]))[0]);
  } catch (e) {
    erroPadrao(res, e);
  }
});

app.post('/api/lembretes/:id/ativo', async (req, res) => {
  try {
    const { data: atual } = await doUsuario(req).maybeSingle();
    if (!atual) return res.status(404).json({ erro: 'Lembrete não encontrado' });
    const { data, error } = await supabase
      .from('lembretes').update({ ativo: Boolean(req.body?.ativo), atualizado_em: new Date().toISOString() })
      .eq('id', atual.id).select().single();
    if (error) throw error;
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
    const { data: lembrete } = await doUsuario(req).maybeSingle();
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
    const { data: lembrete } = await doUsuario(req).maybeSingle();
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
    res.json({ texto: montarTexto({ lembrete: campos, nome: req.usuario.nome, vencimento, diasAntes: campos.avisos[0] }) });
  } catch (e) {
    erroPadrao(res, e, 400);
  }
});

// Sugestões de mensagem com IA (Gemini). Só o tipo e o tom vão pra IA; nada da pessoa.
app.post('/api/lembretes/sugerir', async (req, res) => {
  try {
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
    const { data: lembrete } = await doUsuario(req).maybeSingle();
    if (!lembrete) return res.status(404).json({ erro: 'Lembrete não encontrado' });
    const { data: conta } = await supabase
      .from('contas').select('nome, telefone_jid, telefone_verificado_em').eq('id', req.usuario.id).single();
    if (!conta.telefone_verificado_em) return res.status(400).json({ erro: 'Confirme seu número antes' });
    const hoje = hojeBR().str;
    const vencimento = proximoVencimento(lembrete) || hoje;
    const diasAntes = Math.max(0, Math.round((Date.parse(vencimento) - Date.parse(hoje)) / 86_400_000)); // dias reais até vencer
    const texto = montarTexto({ lembrete, nome: conta.nome, vencimento, diasAntes });
    await whatsapp.enviarTexto(conta.telefone_jid, `🧪 *Teste*\n\n${texto}`);
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
  res.json(data);
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
  });
});

app.use((err, _req, res, _next) => {
  console.error(err);
  res.status(500).json({ erro: err.message });
});

// =============== SUBIDA ===============
app.listen(PORT, async () => {
  console.log(`Servidor na porta ${PORT}`);
  await destravar().catch(() => {});
  whatsapp.quandoChegarMensagem(tratarMensagem); // "paguei", "desfazer", "parar", "ajuda"
  whatsapp.iniciar()
    .then((tinha) => console.log(tinha ? 'Reconectando o WhatsApp do sistema...' : 'WhatsApp do sistema ainda não conectado (admin precisa ler o QR).'))
    .catch((e) => console.error('Erro ao iniciar o WhatsApp:', e.message));
  gerarTodos().then((n) => console.log(`${n} aviso(s) conferido(s).`)).catch((e) => console.error('Erro ao gerar avisos:', e.message));
  iniciarAgendador();
  setTimeout(dispararPendentes, 20_000);
});

