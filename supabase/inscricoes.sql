-- =====================================================================
-- LevelUp Hub · Inscrições abertas pelo site (controladas pelo RH no painel)
-- Rodar DEPOIS do schema.sql. Pode rodar de novo sem problema.
-- =====================================================================
create table if not exists public.config (
  chave  text primary key,
  valor  jsonb not null
);
insert into public.config (chave, valor) values
  ('inscricoes_abertas', 'true'),
  ('limite_cadastros_dia', '30')
on conflict (chave) do nothing;

alter table public.config enable row level security;
drop policy if exists config_rh on public.config;
create policy config_rh on public.config for all to authenticated
  using (public.is_rh()) with check (public.is_rh());
revoke all on public.config from anon;

-- Quem pode criar conta:
--  - e-mails da lista de acesso entram sempre;
--  - com inscrições abertas, qualquer e-mail entra, até o limite de novos cadastros do dia.
create or replace function public.check_allowlist()
returns trigger language plpgsql security definer set search_path = public as $$
declare
  aberto boolean := coalesce((select valor = 'true'::jsonb from public.config where chave = 'inscricoes_abertas'), false);
  limite int := coalesce((select (valor #>> '{}')::int from public.config where chave = 'limite_cadastros_dia'), 30);
begin
  if exists (select 1 from public.allowlist where lower(email) = lower(new.email)) then
    return new;
  end if;
  if not aberto then
    raise exception 'INSCRICOES_FECHADAS';
  end if;
  if (select count(*) from auth.users where created_at > now() - interval '24 hours') >= limite then
    raise exception 'LIMITE_CADASTROS';
  end if;
  return new;
end $$;
