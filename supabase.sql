-- Rode este script inteiro no Supabase: SQL Editor -> New query -> Run
-- Os nomes das tabelas não batem com os do Agendador, então dá pra usar um projeto novo
-- ou o mesmo projeto do Agendador, sem conflito.

-- 1) Contas
create table if not exists public.contas (
  id                     uuid primary key default gen_random_uuid(),
  nome                   text not null,
  email                  text not null unique,
  senha_hash             text not null,
  telefone               text,          -- como a pessoa digitou (só números)
  telefone_jid           text,          -- id do WhatsApp, preenchido depois de confirmar
  telefone_verificado_em timestamptz,
  telefone_pendente      text,          -- número esperando confirmação (troca de número)
  jid_pendente           text,
  codigo_hash            text,          -- código de confirmação (hash), temporário
  codigo_expira          timestamptz,
  codigo_tentativas      int not null default 0,
  criado_em              timestamptz not null default now()
);
create unique index if not exists contas_telefone_unico
  on public.contas (telefone_jid) where telefone_verificado_em is not null;

-- 2) Lembretes (a "conta de luz", o "aluguel"...)
create table if not exists public.lembretes (
  id            uuid primary key default gen_random_uuid(),
  conta_id      uuid not null references public.contas (id) on delete cascade,
  tipo          text not null default 'outro'
                check (tipo in ('luz', 'agua', 'internet', 'aluguel', 'cartao', 'boleto', 'outro')),
  titulo        text not null,
  valor         numeric(12, 2),
  frequencia    text not null default 'mensal' check (frequencia in ('mensal', 'unica')),
  dia           int check (dia between 1 and 31),   -- mensal: dia do vencimento
  data          date,                                -- única: data do vencimento
  avisos        int[] not null default '{0}',        -- dias de antecedência (0 = no dia)
  horario       time not null default '09:00',
  mensagem      text,                                -- vazio = mensagem padrão
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
  texto       text,
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
  chave         text primary key,
  respondido_em timestamptz not null default now(),
  vezes         int not null default 1
);

-- 4) Sessão do WhatsApp do sistema (o seu chip)
create table if not exists public.sistema_auth (
  id         text primary key,
  data       jsonb not null,
  updated_at timestamptz not null default now()
);

-- 5) Segurança: RLS ligado e sem políticas = ninguém acessa pela chave pública.
--    O servidor usa a secret key, que passa por cima do RLS.
alter table public.contas       enable row level security;
alter table public.lembretes    enable row level security;
alter table public.envios       enable row level security;
alter table public.pagamentos   enable row level security;
alter table public.contatos_desconhecidos enable row level security;
alter table public.sistema_auth enable row level security;

grant usage on schema public to service_role;
grant all on table public.contas, public.lembretes, public.envios, public.pagamentos, public.contatos_desconhecidos, public.sistema_auth to service_role;
