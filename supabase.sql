-- Rode este script inteiro no Supabase: SQL Editor -> New query -> Run
-- Os nomes das tabelas não batem com os do Agendador, então dá pra usar um projeto novo
-- ou o mesmo projeto do Agendador, sem conflito.

-- Dados pessoais (nome, e-mail, telefone, nome/valor/mensagem dos lembretes, texto dos avisos e a sessão
-- do WhatsApp) ficam CIFRADOS pelo servidor com AES-256-GCM antes de chegar aqui. O banco só vê "c1.xxxx".
-- As colunas *_indice são índices cegos (HMAC-SHA256): servem pra achar a conta sem guardar o dado aberto.
-- A chave fica só no servidor (variável CHAVE_DADOS no Render), nunca no banco.

-- 1) Contas
create table if not exists public.contas (
  id                     uuid primary key default gen_random_uuid(),
  nome                   text not null, -- cifrado
  email                  text not null unique, -- cifrado
  email_indice           text,          -- índice cego do e-mail (login)
  senha_hash             text not null, -- Argon2id
  telefone               text,          -- cifrado
  telefone_jid           text,          -- cifrado (id do WhatsApp, depois de confirmar)
  telefone_jid_indice    text,          -- índice cego do WhatsApp (achar a conta quando a pessoa responde)
  telefone_verificado_em timestamptz,
  telefone_pendente      text,          -- cifrado (número esperando confirmação)
  jid_pendente           text,          -- cifrado
  jid_pendente_indice    text,
  codigo_hash            text,          -- código de confirmação (hash), temporário
  codigo_expira          timestamptz,
  codigo_tentativas      int not null default 0,
  plano                  text not null default 'gratis' check (plano in ('gratis', 'premium')),
  premium_ate            timestamptz,   -- vazio = premium sem prazo
  criado_em              timestamptz not null default now()
);
-- (pra quem já tinha rodado uma versão anterior deste script)
alter table public.contas add column if not exists plano text not null default 'gratis';
alter table public.contas add column if not exists premium_ate timestamptz;

alter table public.contas add column if not exists email_indice text;
alter table public.contas add column if not exists telefone_jid_indice text;
alter table public.contas add column if not exists jid_pendente_indice text;
alter table public.contas add column if not exists termos_versao text;        -- versão dos termos aceita no cadastro
alter table public.contas add column if not exists termos_aceitos_em timestamptz;

-- buscas e unicidade pelos índices cegos (o dado cifrado muda a cada gravação, então não serve pra isso)
drop index if exists public.contas_telefone_unico;
create unique index if not exists contas_email_indice_unico on public.contas (email_indice);
create unique index if not exists contas_telefone_indice_unico
  on public.contas (telefone_jid_indice) where telefone_verificado_em is not null;
create index if not exists contas_jid_pendente_indice_idx on public.contas (jid_pendente_indice);

-- 2) Lembretes (a "conta de luz", o "aluguel"...)
create table if not exists public.lembretes (
  id            uuid primary key default gen_random_uuid(),
  conta_id      uuid not null references public.contas (id) on delete cascade,
  tipo          text not null default 'outro'
                check (tipo in ('luz', 'agua', 'internet', 'aluguel', 'cartao', 'boleto', 'outro')),
  titulo        text not null,                       -- cifrado
  valor         numeric(12, 2),                      -- não usado mais (fica vazio): o valor vai cifrado em valor_cifrado
  valor_cifrado text,
  frequencia    text not null default 'mensal' check (frequencia in ('mensal', 'unica')),
  dia           int check (dia between 1 and 31),   -- mensal: dia do vencimento
  data          date,                                -- única: data do vencimento
  avisos        int[] not null default '{0}',        -- dias de antecedência (0 = no dia)
  horario       time not null default '09:00',
  mensagem      text,                                -- cifrado (vazio = mensagem padrão)
  icone         text,                                -- ícone escolhido (vazio = o do tipo)
  cor           text,                                -- cor escolhida (vazio = a do tipo)
  ativo         boolean not null default true,
  criado_em     timestamptz not null default now(),
  atualizado_em timestamptz not null default now(),
  constraint vencimento_ok check (
    (frequencia = 'mensal' and dia is not null) or (frequencia = 'unica' and data is not null)
  )
);
create index if not exists lembretes_conta_idx on public.lembretes (conta_id);
-- (pra quem já tinha rodado uma versão anterior deste script)
alter table public.lembretes add column if not exists icone text;
alter table public.lembretes add column if not exists cor text;
alter table public.lembretes add column if not exists valor_cifrado text;

-- 3) Envios (cada aviso que vai sair: "conta de luz, vencimento 10/12, 3 dias antes")
create table if not exists public.envios (
  id          uuid primary key default gen_random_uuid(),
  lembrete_id uuid not null references public.lembretes (id) on delete cascade,
  conta_id    uuid not null references public.contas (id) on delete cascade,
  vencimento  date not null,
  dias_antes  int not null,
  enviar_em   timestamptz not null,
  status      text not null default 'pendente'
              check (status in ('pendente', 'enviando', 'enviado', 'erro', 'expirado', 'cancelado')),
  texto       text,                -- cifrado
  msg_id      text,                -- id da mensagem no WhatsApp (pra saber qual aviso a pessoa respondeu)
  erro        text,
  enviado_em  timestamptz,
  criado_em   timestamptz not null default now(),
  unique (lembrete_id, vencimento, dias_antes)
);
create index if not exists envios_pendentes_idx on public.envios (enviar_em) where status = 'pendente';
create index if not exists envios_conta_idx on public.envios (conta_id, enviar_em desc);
create index if not exists envios_msg_idx on public.envios (msg_id);

-- 3b) Contas marcadas como pagas (pelo "paguei" no WhatsApp ou pelo site)
create table if not exists public.pagamentos (
  id          uuid primary key default gen_random_uuid(),
  lembrete_id uuid not null references public.lembretes (id) on delete cascade,
  conta_id    uuid not null references public.contas (id) on delete cascade,
  vencimento  date not null,
  origem      text not null default 'site' check (origem in ('whatsapp', 'site')),
  pago_em     timestamptz not null default now(),
  unique (lembrete_id, vencimento)
);
create index if not exists pagamentos_conta_idx on public.pagamentos (conta_id, pago_em desc);

-- 3c) Números sem conta que já receberam o convite de cadastro (no máximo 1 vez por semana)
create table if not exists public.contatos_desconhecidos (
  chave         text primary key,   -- índice cego do número (o número em si não fica guardado)
  respondido_em timestamptz not null default now(),
  vezes         int not null default 1
);

-- 3d) Enquetes mandadas nos avisos ("Já paguei" / "Me lembra mais tarde"). O segredo vai cifrado:
--     sem ele não dá pra ler o voto. Enquetes com mais de 40 dias são apagadas sozinhas.
create table if not exists public.enquetes (
  id          text primary key,      -- id da mensagem da enquete no WhatsApp
  tipo        text not null check (tipo in ('aviso', 'adiar', 'pago')),
  conta_id    uuid not null references public.contas (id) on delete cascade,
  lembrete_id uuid not null references public.lembretes (id) on delete cascade,
  vencimento  date not null,
  segredo     text not null,         -- cifrado
  resposta    text,                  -- última opção escolhida
  criado_em   timestamptz not null default now()
);
create index if not exists enquetes_criado_idx on public.enquetes (criado_em);
-- (pra quem criou a tabela antes do botão "Desfazer")
alter table public.enquetes drop constraint if exists enquetes_tipo_check;
alter table public.enquetes add constraint enquetes_tipo_check check (tipo in ('aviso', 'adiar', 'pago'));

-- 3e) Pagamento pelo Asaas. O CPF NÃO fica aqui: vai direto pro Asaas. Aqui só os códigos de lá.
alter table public.contas add column if not exists asaas_cliente_id    text;
alter table public.contas add column if not exists asaas_assinatura_id text;
alter table public.contas add column if not exists assinatura_periodo  text;   -- mensal | anual
alter table public.contas add column if not exists assinatura_status   text;   -- aguardando | ativa | cancelada
create index if not exists contas_asaas_assinatura_idx on public.contas (asaas_assinatura_id);
create index if not exists contas_asaas_cliente_idx on public.contas (asaas_cliente_id);

-- Eventos do webhook já recebidos (o Asaas pode mandar o mesmo mais de uma vez)
create table if not exists public.asaas_eventos (
  id          text primary key,
  evento      text,
  recebido_em timestamptz not null default now()
);
-- Pagamentos do Premium (ficam mesmo se a conta for excluída: a lei fiscal pede guardar por 5 anos)
create table if not exists public.asaas_pagamentos (
  id            text primary key,          -- id do pagamento no Asaas
  conta_id      uuid references public.contas (id) on delete set null,
  assinatura_id text,
  valor         numeric(10,2),
  forma         text,                      -- PIX, BOLETO, CREDIT_CARD
  vencimento    date,
  status        text not null,             -- pago | estornado | apagado
  liberado_ate  timestamptz,
  criado_em     timestamptz not null default now(),
  atualizado_em timestamptz not null default now()
);
create index if not exists asaas_pagamentos_conta_idx on public.asaas_pagamentos (conta_id);

-- 4) Sessão do WhatsApp do sistema (o seu chip)
create table if not exists public.sistema_auth (
  id         text primary key,
  data       jsonb not null,  -- { "c": "c1...." }: chaves da sessão cifradas
  updated_at timestamptz not null default now()
);

-- 5) Segurança: RLS ligado e sem políticas = ninguém acessa pela chave pública.
--    O servidor usa a secret key, que passa por cima do RLS.
alter table public.contas       enable row level security;
alter table public.lembretes    enable row level security;
alter table public.envios       enable row level security;
alter table public.pagamentos   enable row level security;
alter table public.contatos_desconhecidos enable row level security;
alter table public.enquetes     enable row level security;
alter table public.sistema_auth enable row level security;
alter table public.asaas_eventos    enable row level security;
alter table public.asaas_pagamentos enable row level security;

grant usage on schema public to service_role;
grant all on table public.contas, public.lembretes, public.envios, public.pagamentos, public.contatos_desconhecidos, public.sistema_auth, public.enquetes, public.asaas_eventos, public.asaas_pagamentos to service_role;
