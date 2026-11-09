-- =====================================================================
-- LevelUp Hub · Comunidade (posts, comentários, "útil" e conquistas automáticas)
-- Rodar DEPOIS do schema.sql. Pode rodar de novo sem problema.
-- =====================================================================

-- ---------- Perfil: área e preferência de conquistas ----------
alter table public.profiles add column if not exists area text;
alter table public.profiles add column if not exists compartilhar_conquistas boolean not null default true;
grant update (nome, consentiu, last_seen, area, compartilhar_conquistas) on public.profiles to authenticated;

-- O que os outros participantes veem de cada pessoa: só nome e área
create or replace view public.membros as
  select id, coalesce(nullif(nome, ''), 'Participante') as nome, area, role
  from public.profiles;
revoke all on public.membros from anon;
grant select on public.membros to authenticated;

create or replace function public.canal_da_area(a text)
returns text language sql immutable as $$
  select case a when 'Dados e BI' then 'dados' when 'Marketing' then 'marketing' when 'Produto' then 'produto' else 'geral' end;
$$;

-- ---------- Posts ----------
create table if not exists public.posts (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null references public.profiles on delete cascade default auth.uid(),
  canal       text not null default 'geral' check (canal in ('geral','dados','marketing','produto')),
  tipo        text not null default 'post' check (tipo in ('post','conquista','aviso')),
  texto       text not null check (char_length(texto) between 1 and 2000),
  fixado      boolean not null default false,
  ref         text,
  created_at  timestamptz not null default now()
);
create index if not exists posts_canal_idx on public.posts (canal, created_at desc);
create unique index if not exists posts_ref_uq on public.posts (user_id, ref) where ref is not null;

create table if not exists public.comments (
  id          uuid primary key default gen_random_uuid(),
  post_id     uuid not null references public.posts on delete cascade,
  user_id     uuid not null references public.profiles on delete cascade default auth.uid(),
  texto       text not null check (char_length(texto) between 1 and 1000),
  created_at  timestamptz not null default now()
);
create index if not exists comments_post_idx on public.comments (post_id, created_at);

create table if not exists public.uteis (
  post_id     uuid not null references public.posts on delete cascade,
  user_id     uuid not null references public.profiles on delete cascade default auth.uid(),
  created_at  timestamptz not null default now(),
  primary key (post_id, user_id)
);

alter table public.posts    enable row level security;
alter table public.comments enable row level security;
alter table public.uteis    enable row level security;

-- posts: todo mundo do grupo lê; cada um publica/apaga os seus; RH apaga e fixa qualquer um
drop policy if exists posts_select on public.posts;
create policy posts_select on public.posts for select to authenticated using (true);
drop policy if exists posts_insert on public.posts;
create policy posts_insert on public.posts for insert to authenticated
  with check (user_id = auth.uid() and (tipo = 'post' or (tipo = 'aviso' and public.is_rh())));
drop policy if exists posts_delete on public.posts;
create policy posts_delete on public.posts for delete to authenticated
  using (user_id = auth.uid() or public.is_rh());
drop policy if exists posts_update on public.posts;
create policy posts_update on public.posts for update to authenticated
  using (public.is_rh()) with check (public.is_rh());
revoke insert, update on public.posts from authenticated;
grant insert (canal, tipo, texto) on public.posts to authenticated;
grant update (fixado) on public.posts to authenticated;

drop policy if exists comments_select on public.comments;
create policy comments_select on public.comments for select to authenticated using (true);
drop policy if exists comments_insert on public.comments;
create policy comments_insert on public.comments for insert to authenticated with check (user_id = auth.uid());
drop policy if exists comments_delete on public.comments;
create policy comments_delete on public.comments for delete to authenticated
  using (user_id = auth.uid() or public.is_rh());
revoke insert, update on public.comments from authenticated;
grant insert (post_id, texto) on public.comments to authenticated;

drop policy if exists uteis_select on public.uteis;
create policy uteis_select on public.uteis for select to authenticated using (true);
drop policy if exists uteis_insert on public.uteis;
create policy uteis_insert on public.uteis for insert to authenticated with check (user_id = auth.uid());
drop policy if exists uteis_delete on public.uteis;
create policy uteis_delete on public.uteis for delete to authenticated using (user_id = auth.uid());
revoke insert, update on public.uteis from authenticated;
grant insert (post_id) on public.uteis to authenticated;

-- ---------- Conquistas automáticas ----------
-- Começou uma trilha / concluiu uma semana
create or replace function public.conquistas_plano()
returns trigger language plpgsql security definer set search_path = public as $$
declare
  i int; n int; feitos int; k int;
  titulo text := coalesce(new.plano->'vaga'->>'titulo', 'uma nova vaga');
  canal text := public.canal_da_area(new.area);
begin
  if tg_op = 'INSERT' then
    update public.profiles set area = new.area where id = new.user_id and area is null;
  end if;
  if not exists (select 1 from public.profiles where id = new.user_id and compartilhar_conquistas) then
    return new;
  end if;
  if tg_op = 'INSERT' then
    insert into public.posts (user_id, canal, tipo, texto, ref)
    values (new.user_id, canal, 'conquista', 'começou a trilha para ' || titulo || '.', 'inicio:' || new.id)
    on conflict do nothing;
    return new;
  end if;
  if new.progresso is not distinct from old.progresso then return new; end if;
  for i in 0 .. coalesce(jsonb_array_length(new.plano->'semanas'), 0) - 1 loop
    n := coalesce(jsonb_array_length(new.plano->'semanas'->i->'itens'), 0);
    continue when n = 0;
    feitos := 0;
    for k in 0 .. n - 1 loop
      if new.progresso ? ('s' || (i + 1) || '-' || k) then feitos := feitos + 1; end if;
    end loop;
    if feitos = n then
      insert into public.posts (user_id, canal, tipo, texto, ref)
      values (new.user_id, canal, 'conquista',
        'concluiu a semana ' || (i + 1) || ' (' || coalesce(new.plano->'semanas'->i->>'tema', '') || ') da trilha para ' || titulo || '.',
        'semana:' || new.id || ':' || (i + 1))
      on conflict do nothing;
    end if;
  end loop;
  return new;
end $$;

drop trigger if exists levelup_conquistas_plano on public.plans;
create trigger levelup_conquistas_plano
  after insert or update on public.plans
  for each row execute function public.conquistas_plano();

-- Tirou 7 ou mais no case
create or replace function public.conquistas_case()
returns trigger language plpgsql security definer set search_path = public as $$
declare p record;
begin
  if new.status = 'corrigido' and old.status is distinct from 'corrigido' and coalesce(new.nota, 0) >= 7
     and exists (select 1 from public.profiles where id = new.user_id and compartilhar_conquistas) then
    select area, plano->'vaga'->>'titulo' as titulo into p from public.plans where id = new.plan_id;
    insert into public.posts (user_id, canal, tipo, texto, ref)
    values (new.user_id, public.canal_da_area(p.area), 'conquista',
      'tirou ' || replace(to_char(new.nota, 'FM90.0'), '.', ',') || ' no case da trilha para ' || coalesce(p.titulo, 'uma vaga') || '.',
      'case:' || new.id)
    on conflict do nothing;
  end if;
  return new;
end $$;

drop trigger if exists levelup_conquistas_case on public.submissions;
create trigger levelup_conquistas_case
  after update on public.submissions
  for each row execute function public.conquistas_case();

-- Preenche a área de quem já tem trilha
update public.profiles pr set area = p.area
from (select distinct on (user_id) user_id, area from public.plans order by user_id, created_at) p
where p.user_id = pr.id and pr.area is null;
