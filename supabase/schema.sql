-- =====================================================================
-- LevelUp Hub · MVP · Banco de dados (Supabase)
-- Cole tudo isto no Supabase > SQL Editor > New query > Run.
-- Pode rodar de novo sem problema (é idempotente na maior parte).
-- =====================================================================

-- ---------- Lista de quem pode entrar (grupo fechado) ----------
create table if not exists public.allowlist (
  email     text primary key,
  added_at  timestamptz not null default now()
);

-- ---------- Perfis ----------
create table if not exists public.profiles (
  id          uuid primary key references auth.users on delete cascade,
  email       text not null,
  nome        text,
  role        text not null default 'candidato' check (role in ('candidato','rh')),
  consentiu   boolean not null default false,
  created_at  timestamptz not null default now(),
  last_seen   timestamptz
);

-- É RH? (usado nas regras abaixo)
create or replace function public.is_rh()
returns boolean language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.profiles where id = auth.uid() and role = 'rh');
$$;

-- Bloqueia cadastro de quem não está na allowlist
create or replace function public.check_allowlist()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if not exists (select 1 from public.allowlist where lower(email) = lower(new.email)) then
    raise exception 'EMAIL_NAO_AUTORIZADO';
  end if;
  return new;
end $$;

drop trigger if exists levelup_check_allowlist on auth.users;
create trigger levelup_check_allowlist
  before insert on auth.users
  for each row execute function public.check_allowlist();

-- Cria o perfil automaticamente no primeiro login
create or replace function public.handle_new_user()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  insert into public.profiles (id, email) values (new.id, lower(new.email))
  on conflict (id) do nothing;
  return new;
end $$;

drop trigger if exists levelup_on_auth_user_created on auth.users;
create trigger levelup_on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

-- ---------- Trilhas (uma por vaga) ----------
create table if not exists public.plans (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null references public.profiles on delete cascade,
  area        text not null,
  vaga_texto  text not null,
  vaga_link   text,
  respostas   jsonb not null default '{}',
  plano       jsonb not null,
  progresso   jsonb not null default '{}',
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);
create index if not exists plans_user_idx on public.plans (user_id);

-- ---------- Envios do case (PDF + correção) ----------
create table if not exists public.submissions (
  id             uuid primary key default gen_random_uuid(),
  plan_id        uuid not null references public.plans on delete cascade,
  user_id        uuid not null references public.profiles on delete cascade default auth.uid(),
  arquivo_path   text not null,
  arquivo_nome   text,
  status         text not null default 'corrigindo' check (status in ('corrigindo','processando','corrigido','erro')),
  erro           text,
  feedback       jsonb,
  nota           numeric,
  pediu_revisao  boolean not null default false,
  revisao_rh     text,
  revisado_em    timestamptz,
  created_at     timestamptz not null default now()
);
create index if not exists submissions_plan_idx on public.submissions (plan_id);

-- Candidato não pode escrever a revisão do RH no próprio envio
create or replace function public.guard_submission_update()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if not public.is_rh() then
    if new.revisao_rh is distinct from old.revisao_rh or new.revisado_em is distinct from old.revisado_em then
      raise exception 'Somente o RH pode revisar';
    end if;
  end if;
  return new;
end $$;
drop trigger if exists levelup_guard_submission on public.submissions;
create trigger levelup_guard_submission
  before update on public.submissions
  for each row execute function public.guard_submission_update();

-- Se você rodou uma versão anterior deste arquivo, isto atualiza a regra de status
alter table public.submissions drop constraint if exists submissions_status_check;
alter table public.submissions add constraint submissions_status_check
  check (status in ('corrigindo','processando','corrigido','erro'));

-- ---------- Regras de acesso (RLS) ----------
alter table public.allowlist   enable row level security;
alter table public.profiles    enable row level security;
alter table public.plans       enable row level security;
alter table public.submissions enable row level security;

-- allowlist: só RH vê e mexe
drop policy if exists allow_rh_all on public.allowlist;
create policy allow_rh_all on public.allowlist for all to authenticated
  using (public.is_rh()) with check (public.is_rh());

-- profiles: cada um vê o seu; RH vê todos
drop policy if exists prof_select on public.profiles;
create policy prof_select on public.profiles for select to authenticated
  using (id = auth.uid() or public.is_rh());
drop policy if exists prof_update on public.profiles;
create policy prof_update on public.profiles for update to authenticated
  using (id = auth.uid()) with check (id = auth.uid());
-- só estes campos podem ser alterados pelo próprio usuário (nunca o "role")
revoke update on public.profiles from authenticated;
grant update (nome, consentiu, last_seen) on public.profiles to authenticated;

-- plans: cada um vê os seus; RH vê todos. Criação só pela função de IA.
drop policy if exists plans_select on public.plans;
create policy plans_select on public.plans for select to authenticated
  using (user_id = auth.uid() or public.is_rh());
drop policy if exists plans_update on public.plans;
create policy plans_update on public.plans for update to authenticated
  using (user_id = auth.uid()) with check (user_id = auth.uid());
revoke insert, update, delete on public.plans from authenticated;
grant update (progresso, updated_at) on public.plans to authenticated;

-- submissions: cada um vê/cria os seus; RH vê todos e escreve a revisão
drop policy if exists subs_select on public.submissions;
create policy subs_select on public.submissions for select to authenticated
  using (user_id = auth.uid() or public.is_rh());
drop policy if exists subs_insert on public.submissions;
create policy subs_insert on public.submissions for insert to authenticated
  with check (user_id = auth.uid()
    and arquivo_path like auth.uid()::text || '/' || plan_id::text || '/%'
    and exists (select 1 from public.plans p where p.id = plan_id and p.user_id = auth.uid()));
-- candidato só preenche estes campos ao criar (nota, correção e revisão ficam com o sistema/RH)
revoke insert on public.submissions from authenticated;
grant insert (plan_id, arquivo_path, arquivo_nome) on public.submissions to authenticated;
drop policy if exists subs_update on public.submissions;
create policy subs_update on public.submissions for update to authenticated
  using (user_id = auth.uid() or public.is_rh())
  with check (user_id = auth.uid() or public.is_rh());
revoke update, delete on public.submissions from authenticated;
grant update (pediu_revisao, revisao_rh, revisado_em) on public.submissions to authenticated;

-- ---------- Armazenamento dos PDFs ----------
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('cases', 'cases', false, 10485760, array['application/pdf'])
on conflict (id) do nothing;

drop policy if exists cases_insert on storage.objects;
create policy cases_insert on storage.objects for insert to authenticated
  with check (bucket_id = 'cases' and (storage.foldername(name))[1] = auth.uid()::text);
drop policy if exists cases_select on storage.objects;
create policy cases_select on storage.objects for select to authenticated
  using (bucket_id = 'cases' and ((storage.foldername(name))[1] = auth.uid()::text or public.is_rh()));

-- =====================================================================
-- DEPOIS DE RODAR: coloque o seu e-mail e o do RH na lista e vire RH.
-- (troque os e-mails abaixo e rode só estas linhas)
-- =====================================================================
-- insert into public.allowlist (email) values ('seu.email@gmail.com'), ('rh1@gmail.com');
-- Depois que a pessoa fizer o primeiro login:
-- update public.profiles set role = 'rh' where email = 'seu.email@gmail.com';
