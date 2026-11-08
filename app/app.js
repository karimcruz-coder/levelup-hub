// LevelUp Hub · App (candidato + painel do RH)
import { createClient } from "https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2.49.4/+esm";
import { SUPABASE_URL, SUPABASE_ANON_KEY } from "./config.js";

/* ---------------- helpers ---------------- */
const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
const ic = (id) => `<svg class="ic"><use href="#i-${id}"/></svg>`;
const enc = encodeURIComponent;
const app = $("#app");
const fmtDate = (d) => d ? new Date(d).toLocaleDateString("pt-BR", { day: "2-digit", month: "short" }) : "—";
const fmtDateTime = (d) => d ? new Date(d).toLocaleString("pt-BR", { day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit" }) : "—";
let toastT;
function toast(msg) {
  const t = $("#toast"); t.textContent = msg; t.hidden = false;
  clearTimeout(toastT); toastT = setTimeout(() => (t.hidden = true), 3200);
}
const AREAS = [
  { v: "Dados e BI", d: "Analista de dados, BI, dados de negócio" },
  { v: "Marketing", d: "Growth, performance, conteúdo, CRM" },
  { v: "Produto", d: "Product owner, analista de produto, PM júnior" },
];
const KIND = { video: "Vídeo", artigo: "Artigo", livro: "Livro", pratica: "Prática" };

/* ---------------- setup check ---------------- */
if (!/^https?:\/\//.test(SUPABASE_URL)) {
  app.innerHTML = `<div class="setup fade"><svg style="width:40px;height:46px"><use href="#logo"/></svg>
    <h1 style="margin:18px 0 12px">Falta configurar o app</h1>
    <p class="muted">Abra o arquivo <code>app/config.js</code> e cole a <b>Project URL</b> e a <b>anon key</b> do seu projeto Supabase
    (Supabase › Project Settings › API). O passo a passo completo está no arquivo <code>GUIA.md</code>.</p></div>`;
  throw new Error("config pendente");
}
const sb = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

/* ---------------- state ---------------- */
const S = {
  session: null, profile: null,
  plans: [], plan: null, subs: [], tab: "trilha", openWeeks: new Set(),
  wiz: { step: 0, area: "Dados e BI", vaga_texto: "", vaga_link: "", nome: "", origem: "", nivel: "basico", horas: "4", semanas: "6", formato: "misto", consent: false },
  rh: null, rhTab: "candidatos", rhPlanId: null,
};
let pollT = null;
let saveT = null;

async function invokeFn(name, body) {
  const { data, error } = await sb.functions.invoke(name, { body });
  if (error) {
    let msg = "Algo deu errado. Tente de novo em instantes.";
    try { const j = await error.context.json(); if (j?.error) msg = j.error; } catch (_) {}
    throw new Error(msg);
  }
  return data;
}

/* ---------------- boot & routing ---------------- */
let currentUid = null;
async function boot() {
  const { data: { session } } = await sb.auth.getSession();
  S.session = session;
  sb.auth.onAuthStateChange((_ev, session) => {
    const uid = session?.user?.id ?? null;
    S.session = session;
    if (uid !== currentUid) {
      // troca de conta: limpa tudo da pessoa anterior
      Object.assign(S, { profile: null, plans: [], plan: null, subs: [], tab: "trilha", openWeeks: new Set(), rh: null, rhTab: "candidatos", rhPlanId: null });
      S.wiz = { step: 0, area: "Dados e BI", vaga_texto: "", vaga_link: "", nome: "", origem: "", nivel: "basico", horas: "4", semanas: "6", formato: "misto", consent: false };
      pollN = 0;
      if (!uid) { try { localStorage.removeItem("lu-plan"); } catch (_) {} }
      route();
    }
  });
  route();
}

async function route() {
  clearTimeout(pollT);
  currentUid = S.session?.user?.id ?? null;
  if (!S.session) return renderLogin();
  const { data: profile, error } = await sb.from("profiles").select("*").eq("id", currentUid).single();
  if (error || !profile) {
    app.innerHTML = `<div class="setup"><h1>Não encontramos seu perfil</h1><p class="muted" style="margin:12px 0 20px">Saia e entre de novo. Se continuar, fale com a equipe LevelUp.</p><button class="btn btn-ghost" id="out">Sair</button></div>`;
    $("#out").onclick = () => sb.auth.signOut();
    return;
  }
  S.profile = profile;
  sb.from("profiles").update({ last_seen: new Date().toISOString() }).eq("id", currentUid).then(() => {});
  if (profile.role === "rh") return loadRH();
  await loadPlans();
  if (!S.plans.length) { S.wiz.nome = S.wiz.nome || profile.nome || ""; return renderWizard(); }
  renderPlan();
}

async function loadPlans(selectId) {
  const { data } = await sb.from("plans").select("*").eq("user_id", currentUid).order("created_at", { ascending: false });
  S.plans = data ?? [];
  let saved = selectId;
  try { saved = saved || localStorage.getItem("lu-plan"); } catch (_) {}
  S.plan = S.plans.find((p) => p.id === saved) || S.plans[0] || null;
  if (S.plan) await loadSubs(S.plan.id);
}
async function loadSubs(planId) {
  const { data } = await sb.from("submissions").select("*").eq("plan_id", planId).order("created_at", { ascending: false });
  S.subs = data ?? [];
}

function topbar(extra = "") {
  const p = S.profile;
  return `<header class="top"><div class="wrap">
    <a class="logo" href="./" aria-label="LevelUp Hub"><svg viewBox="170 170 1505 1720" aria-hidden="true"><use href="#logo"/></svg><span>LevelUp<b>hub</b></span></a>
    ${p?.role === "rh" ? `<span class="chip-role">Painel do RH</span>` : ""}
    <span class="sp"></span>${extra}
    <span class="who">${esc(p?.nome || p?.email || "")}</span>
    <button class="btn btn-ghost btn-sm" id="logout" title="Sair">${ic("out")}<span class="sr">Sair</span></button>
  </div></header>`;
}
function bindTop() {
  $("#logout")?.addEventListener("click", async () => { await sb.auth.signOut(); });
}

/* ---------------- login ---------------- */
function renderLogin() {
  app.innerHTML = `<div class="auth">
    <div class="auth-l">
      <a class="logo" href="./"><svg viewBox="170 170 1505 1720" aria-hidden="true"><use href="#logo"/></svg><span>LevelUp<b>hub</b></span></a>
      <div class="fade"><span class="label">Grupo de teste</span><h1 style="margin-top:14px">Cole a vaga.<br>A gente monta <em>o caminho.</em></h1></div>
      <ul>
        <li><span class="n">1</span>Cole o texto de uma vaga que você quer</li>
        <li><span class="n">2</span>Receba uma trilha semana a semana, com vídeos e leituras</li>
        <li><span class="n">3</span>Faça um case feito para essa vaga e receba correção</li>
      </ul>
    </div>
    <div class="auth-r"><form class="auth-box fade" id="login" novalidate>
      <h2>Entrar</h2>
      <p class="muted">Use o e-mail que você passou para a equipe. Enviamos um link de acesso, sem senha.</p>
      <div class="field"><label for="em">E-mail</label><input type="email" id="em" autocomplete="email" placeholder="voce@email.com" required></div>
      <p class="err" id="lerr" aria-live="polite"></p>
      <button class="btn btn-primary" id="lbtn" type="submit">Receber link de acesso ${ic("arrow")}</button>
      <div id="sent" hidden class="card" style="padding:18px"><b>Link enviado.</b><p class="muted" style="margin-top:6px">Abra seu e-mail e clique no link. Pode fechar esta aba. Não chegou? Veja o spam ou tente de novo em alguns minutos.</p></div>
    </form></div>
  </div>`;
  $("#login").addEventListener("submit", async (e) => {
    e.preventDefault();
    const email = $("#em").value.trim().toLowerCase(), err = $("#lerr"), btn = $("#lbtn");
    if (!/^\S+@\S+\.\S+$/.test(email)) { err.textContent = "Digite um e-mail válido."; return; }
    err.textContent = ""; btn.disabled = true; btn.innerHTML = `<span class="spinner"></span> Enviando...`;
    const { error } = await sb.auth.signInWithOtp({ email, options: { emailRedirectTo: location.origin + location.pathname } });
    btn.disabled = false; btn.innerHTML = `Receber link de acesso ${ic("arrow")}`;
    if (error) {
      const m = (error.message || "").toLowerCase();
      err.textContent = m.includes("database") || m.includes("autorizado")
        ? "Esse e-mail ainda não está no grupo de teste. Fale com a equipe LevelUp."
        : m.includes("rate") ? "Muitos pedidos seguidos. Espere alguns minutos e tente de novo."
        : "Não conseguimos enviar agora. Tente de novo em instantes.";
      return;
    }
    $("#sent").hidden = false;
  });
}

/* ---------------- wizard ---------------- */
function renderWizard() {
  const w = S.wiz;
  const back = S.plans.length ? `<button class="btn btn-ghost btn-sm" id="cancel">${ic("back")} Voltar à minha trilha</button>` : "";
  const bars = [0, 1, 2].map((i) => `<i class="${i <= w.step ? "on" : ""}"></i>`).join("");
  let body = "";
  if (w.step === 0) body = `
    <span class="label">Passo 1 de 3 · A vaga</span>
    <h1>Qual vaga você quer conquistar?</h1>
    <p class="lead">Cole o texto completo da vaga (no LinkedIn, abra a vaga e copie a descrição). Quanto mais completo, melhor a trilha.</p>
    <p class="lbl" style="margin-bottom:10px">Área</p>
    <div class="opts">${AREAS.map((a) => `<label class="opt"><input type="radio" name="area" value="${a.v}" ${w.area === a.v ? "checked" : ""}><span><b>${a.v}</b><small>${a.d}</small></span></label>`).join("")}</div>
    <div class="field"><label for="vt">Texto da vaga</label><textarea id="vt" placeholder="Cole aqui a descrição: responsabilidades, requisitos, diferenciais...">${esc(w.vaga_texto)}</textarea><small><span id="vcount">${w.vaga_texto.length}</span> caracteres</small></div>
    <div class="field"><label for="vl">Link da vaga <span class="dim">(opcional)</span></label><input type="url" id="vl" placeholder="https://www.linkedin.com/jobs/view/..." value="${esc(w.vaga_link)}"></div>`;
  if (w.step === 1) body = `
    <span class="label">Passo 2 de 3 · Você</span>
    <h1>Conta um pouco sobre você</h1>
    <p class="lead">Assim a trilha pula o que você já sabe e cabe na sua rotina.</p>
    <div class="field"><label for="nm">Como podemos te chamar?</label><input type="text" id="nm" value="${esc(w.nome)}" placeholder="Ana" autocomplete="given-name"></div>
    <div class="field"><label for="og">De onde você vem?</label><input type="text" id="og" value="${esc(w.origem)}" placeholder="Ex.: 2 anos em atendimento, formada em Administração"></div>
    <p class="lbl" style="margin-bottom:10px">Quanto você já sabe da área?</p>
    <div class="opts">${[["zero", "Do zero", "Nunca estudei"], ["basico", "Básico", "Já fiz cursos ou estudei sozinho"], ["intermediario", "Intermediário", "Já usei no trabalho ou em projetos"]].map(([v, t, d]) => `<label class="opt"><input type="radio" name="nivel" value="${v}" ${w.nivel === v ? "checked" : ""}><span><b>${t}</b><small>${d}</small></span></label>`).join("")}</div>`;
  if (w.step === 2) body = `
    <span class="label">Passo 3 de 3 · Seu ritmo</span>
    <h1>Como você prefere estudar?</h1>
    <p class="lead">Dá para mudar depois criando uma nova trilha.</p>
    <p class="lbl" style="margin-bottom:10px">Horas por semana</p>
    <div class="opts">${[["2", "2 horas", "Bem leve"], ["4", "4 horas", "Uma hora em 4 dias"], ["6", "6 horas", "Ritmo bom"], ["10", "10 horas", "Intensivo"]].map(([v, t, d]) => `<label class="opt"><input type="radio" name="horas" value="${v}" ${w.horas === v ? "checked" : ""}><span><b>${t}</b><small>${d}</small></span></label>`).join("")}</div>
    <p class="lbl" style="margin-bottom:10px">Em quantas semanas?</p>
    <div class="opts">${[["4", "4 semanas", "Tenho pressa"], ["6", "6 semanas", "Equilibrado"], ["8", "8 semanas", "Com calma"]].map(([v, t, d]) => `<label class="opt"><input type="radio" name="semanas" value="${v}" ${w.semanas === v ? "checked" : ""}><span><b>${t}</b><small>${d}</small></span></label>`).join("")}</div>
    <p class="lbl" style="margin-bottom:10px">Formato preferido</p>
    <div class="opts">${[["videos", "Vídeos", "Prefiro assistir"], ["leitura", "Leitura", "Prefiro ler"], ["misto", "Misto", "Um pouco de cada"]].map(([v, t, d]) => `<label class="opt"><input type="radio" name="formato" value="${v}" ${w.formato === v ? "checked" : ""}><span><b>${t}</b><small>${d}</small></span></label>`).join("")}</div>
    <label class="check"><input type="checkbox" id="cs" ${w.consent ? "checked" : ""}><span>Entendo que o texto da vaga, minhas respostas e os PDFs que eu enviar são processados por uma IA do Google (Gemini, plano gratuito), que pode usá-los para melhorar seus modelos. Não vou enviar dados pessoais sensíveis.</span></label>`;
  app.innerHTML = `${topbar(back)}<main class="wrap"><div class="wiz">
    <div class="steps-bar">${bars}</div>
    <form id="wf" class="fade" novalidate>${body}
      <p class="err" id="werr" aria-live="polite"></p>
      <div class="wiz-nav">
        <button type="button" class="btn btn-ghost" id="wback" ${w.step === 0 ? "hidden" : ""}>${ic("back")} Voltar</button><span></span>
        <button type="submit" class="btn ${w.step === 2 ? "btn-blue" : "btn-primary"}">${w.step === 2 ? `Montar minha trilha ${ic("bolt")}` : `Continuar ${ic("arrow")}`}</button>
      </div>
    </form></div></main>`;
  bindTop();
  $("#cancel")?.addEventListener("click", () => renderPlan());
  $("#vt")?.addEventListener("input", (e) => { $("#vcount").textContent = e.target.value.length; });
  const collect = () => {
    const f = $("#wf");
    const val = (n) => $(`input[name="${n}"]:checked`, f)?.value;
    if (w.step === 0) { w.area = val("area") || w.area; w.vaga_texto = $("#vt").value.trim(); w.vaga_link = $("#vl").value.trim(); }
    if (w.step === 1) { w.nome = $("#nm").value.trim(); w.origem = $("#og").value.trim(); w.nivel = val("nivel") || w.nivel; }
    if (w.step === 2) { w.horas = val("horas") || w.horas; w.semanas = val("semanas") || w.semanas; w.formato = val("formato") || w.formato; w.consent = $("#cs").checked; }
  };
  $("#wback").addEventListener("click", () => { collect(); w.step--; renderWizard(); });
  $("#wf").addEventListener("submit", (e) => {
    e.preventDefault(); collect();
    const err = $("#werr");
    if (w.step === 0 && w.vaga_texto.length < 200) { err.textContent = "Cole o texto completo da vaga (pelo menos alguns parágrafos)."; $("#vt").focus(); return; }
    if (w.step === 1 && !w.nome) { err.textContent = "Diga como podemos te chamar."; $("#nm").focus(); return; }
    if (w.step === 2 && !w.consent) { err.textContent = "Para continuar, marque que você entendeu como seus dados são processados."; return; }
    if (w.step < 2) { w.step++; renderWizard(); window.scrollTo(0, 0); return; }
    generate();
  });
}

async function generate() {
  const w = S.wiz;
  const msgs = ["Lendo a vaga com atenção...", "Separando o que você já tem do que falta...", "Criando um case com cara dessa empresa..."];
  app.innerHTML = `${topbar()}<main class="wrap"><div class="gen"><div class="gen-in fade">
    <div class="orb"><svg viewBox="170 170 1505 1720"><use href="#logo"/></svg></div>
    <h2>Montando sua trilha</h2><p class="gen-msg" id="gm">${msgs[0]}</p>
    <p class="dim" style="font-size:13.5px">Leva de 2 a 4 minutos, em etapas. Não feche esta página.</p></div></div></main>`;
  bindTop();
  let i = 0; const t = setInterval(() => { i = Math.min(i + 1, 2); const el = $("#gm"); if (el) el.textContent = msgs[i]; }, 9000);
  let createdId = null;
  try {
    const res = await invokeFn("gerar-plano", {
      area: w.area, vaga_texto: w.vaga_texto, vaga_link: w.vaga_link,
      respostas: { nome: w.nome, origem: w.origem, nivel: w.nivel, horas: w.horas, semanas: w.semanas, formato: w.formato },
    });
    clearInterval(t);
    createdId = res.id;
    try { localStorage.setItem("lu-plan", res.id); } catch (_) {}
    S.profile.nome = w.nome || S.profile.nome;
    S.wiz = { ...S.wiz, step: 0, vaga_texto: "", vaga_link: "" };
    await fillWeeks(res.id, (m) => { const el = $("#gm"); if (el) el.textContent = m; });
    await loadPlans(res.id);
    S.tab = "trilha"; S.openWeeks = new Set();
    renderPlan();
    toast("Trilha pronta. Bons estudos!");
  } catch (e) {
    clearInterval(t);
    if (createdId) {
      // o diagnóstico e o case já foram salvos: mostra a trilha e deixa continuar depois
      await loadPlans(createdId); S.tab = "trilha"; renderPlan(); toast(e.message);
      return;
    }
    app.innerHTML = `${topbar()}<main class="wrap"><div class="gen"><div class="gen-in fade">
      <h2>Não deu certo desta vez</h2><p class="muted">${esc(e.message)}</p>
      <div style="display:flex;gap:10px;flex-wrap:wrap;justify-content:center"><button class="btn btn-ghost" id="edit">${ic("back")} Revisar respostas</button><button class="btn btn-blue" id="retry">Tentar de novo</button></div>
    </div></div></main>`;
    bindTop();
    $("#edit").onclick = () => renderWizard();
    $("#retry").onclick = () => generate();
  }
}

/* Preenche as semanas que ainda estão vazias, de 2 em 2, mostrando o progresso */
async function fillWeeks(planId, onMsg) {
  for (let guard = 0; guard < 8; guard++) {
    const { data: plan } = await sb.from("plans").select("plano").eq("id", planId).single();
    const sem = plan?.plano?.semanas ?? [];
    const vazias = sem.map((s, i) => ((s.itens ?? []).length ? null : i + 1)).filter(Boolean);
    if (!vazias.length) return;
    const lote = vazias.slice(0, 2);
    onMsg(`Escolhendo vídeos e leituras: semana${lote.length > 1 ? "s" : ""} ${lote.join(" e ")} de ${sem.length}...`);
    await invokeFn("gerar-plano", { modo: "semanas", plan_id: planId, numeros: lote });
  }
}
async function resumeWeeks() {
  const planId = S.plan.id;
  app.innerHTML = `${topbar()}<main class="wrap"><div class="gen"><div class="gen-in fade">
    <div class="orb"><svg viewBox="170 170 1505 1720"><use href="#logo"/></svg></div>
    <h2>Terminando sua trilha</h2><p class="gen-msg" id="gm">Continuando de onde parou...</p>
    <p class="dim" style="font-size:13.5px">Cada etapa leva até 1 minuto. Não feche esta página.</p></div></div></main>`;
  bindTop();
  try { await fillWeeks(planId, (m) => { const el = $("#gm"); if (el) el.textContent = m; }); toast("Trilha completa!"); }
  catch (e) { toast(e.message); }
  await loadPlans(planId); renderPlan();
}

/* ---------------- plan helpers ---------------- */
function allItems(plano) {
  const out = [];
  (plano?.semanas ?? []).forEach((s, si) => (s.itens ?? []).forEach((it, ii) => out.push({ key: `s${si + 1}-${ii}`, it, si })));
  return out;
}
function progressOf(plan) {
  const items = allItems(plan.plano);
  const done = items.filter((x) => plan.progresso?.[x.key]).length;
  return { done, total: items.length, pct: items.length ? Math.round((done / items.length) * 100) : 0 };
}
function itemLink(it) {
  if (it.tipo === "video") return it.youtube?.id ? `https://www.youtube.com/watch?v=${enc(it.youtube.id)}` : `https://www.youtube.com/results?search_query=${enc(it.busca || it.titulo)}`;
  if (it.tipo === "artigo") return `https://www.google.com/search?q=${enc(it.busca || it.titulo)}`;
  if (it.tipo === "livro") return `https://www.google.com/search?q=${enc(`livro ${it.titulo} ${it.autor || ""}`)}`;
  return null;
}

function weeksHTML(plan, readonly) {
  const semanas = plan.plano?.semanas ?? [];
  let currentFound = false;
  return semanas.map((s, si) => {
    const itens = s.itens ?? [];
    const keys = itens.map((_, ii) => `s${si + 1}-${ii}`);
    const done = keys.filter((k) => plan.progresso?.[k]).length;
    const full = itens.length && done === itens.length;
    const isNow = !full && !currentFound; if (isNow) currentFound = true;
    if (isNow && !S.openWeeks.size) S.openWeeks.add(si);
    const open = S.openWeeks.has(si);
    const mins = itens.reduce((a, it) => a + (Number(it.minutos) || 0), 0);
    return `<section class="week ${full ? "done" : ""} ${isNow ? "now" : ""} ${open ? "open" : ""}" data-w="${si}">
      <button class="week-h" data-toggle="${si}" aria-expanded="${open}">
        <span class="num">${full ? ic("check") : si + 1}</span>
        <span class="g"><b>Semana ${si + 1} · ${esc(s.tema)}</b><span>${esc(s.objetivo)} · cerca de ${Math.round(mins / 6) / 10}h</span></span>
        <span class="mini" aria-hidden="true"><i style="width:${itens.length ? (done / itens.length) * 100 : 0}%"></i></span>
        <svg class="ic chev" viewBox="0 0 24 24"><path d="M9 6l6 6-6 6"/></svg>
      </button>
      <div class="week-b">${itens.length ? itens.map((it, ii) => itemHTML(it, `s${si + 1}-${ii}`, plan.progresso?.[`s${si + 1}-${ii}`], readonly)).join("") : `<p class="dim" style="font-size:14px;padding:6px 2px">Os conteúdos desta semana ainda estão sendo escolhidos.</p>`}</div>
    </section>`;
  }).join("");
}
function itemHTML(it, key, ok, readonly) {
  const link = itemLink(it);
  const yt = it.youtube;
  const thumb = yt?.thumb
    ? `<a class="thumb" href="${esc(link)}" target="_blank" rel="noopener"><img src="${esc(yt.thumb)}" alt="" loading="lazy"><span class="dur">${esc(yt.minutos)} min</span></a>`
    : `<span class="thumb icon">${ic({ video: "play", artigo: "doc", livro: "book", pratica: "bolt" }[it.tipo] || "doc")}</span>`;
  const title = link ? `<a class="t" href="${esc(link)}" target="_blank" rel="noopener">${esc(yt?.titulo || it.titulo)}</a>` : `<span class="t">${esc(it.titulo)}</span>`;
  const meta = [
    yt?.canal ? esc(yt.canal) : "",
    it.tipo === "livro" && it.autor ? esc(it.autor) : "",
    it.minutos ? `${esc(it.minutos)} min` : "",
    it.tipo === "video" && !yt ? "abre a busca no YouTube" : "",
    it.tipo === "artigo" ? "abre a busca no Google" : "",
  ].filter(Boolean).join(" · ");
  return `<div class="item ${ok ? "ok" : ""}">
    <button class="tick" data-key="${key}" ${readonly ? "disabled" : ""} aria-pressed="${!!ok}" aria-label="${ok ? "Desmarcar" : "Marcar como feito"}">${ic("check")}</button>
    ${thumb}
    <div class="body"><span class="kind ${it.tipo === "pratica" ? "pratica" : ""}">${KIND[it.tipo] || "Conteúdo"}</span>${title}
      ${yt && it.titulo && yt.titulo !== it.titulo ? `<span class="why">Tema: ${esc(it.titulo)}</span>` : ""}
      ${it.porque ? `<span class="why">${esc(it.porque)}</span>` : ""}
      ${meta ? `<span class="meta">${meta}</span>` : ""}</div>
  </div>`;
}

function caseHTML(plan, subs, opts) {
  const c = plan.plano?.case ?? {};
  const versions = subs.length;
  return `<div class="grid2">
    <article class="card brief">
      <span class="label">Seu case</span><h2>${esc(c.titulo)}</h2>
      <h4>Contexto</h4><p>${esc(c.contexto)}</p>
      <h4>Desafio</h4><p>${esc(c.desafio)}</p>
      ${c.dados ? `<h4>Dados</h4><pre>${esc(c.dados)}</pre>` : ""}
      ${(c.entregaveis ?? []).length ? `<h4>O que entregar (em um PDF)</h4><ul>${c.entregaveis.map((x) => `<li>${esc(x)}</li>`).join("")}</ul>` : ""}
      ${(c.dicas ?? []).length ? `<h4>Dicas</h4><ul>${c.dicas.map((x) => `<li>${esc(x)}</li>`).join("")}</ul>` : ""}
    </article>
    <div style="display:grid;gap:16px;align-content:start">
      <div class="card"><span class="label">Como vamos avaliar</span>
        <div class="crit" style="margin-top:14px">${(c.criterios ?? []).map((k) => `<div title="${esc(k.descricao)}"><b>${esc(k.nome)}</b><span>${esc(k.peso)}%</span></div>`).join("")}</div>
      </div>
      ${opts.readonly ? "" : `<div class="card">
        <label class="drop" id="drop" for="pdf">${ic("upload")}<b>Enviar ${versions ? "nova versão" : "meu case"} em PDF</b><span class="muted" style="font-size:14px">Arraste aqui ou clique · até 10 MB</span><input type="file" id="pdf" accept="application/pdf"></label>
        <p class="muted" style="font-size:13.5px;margin-top:12px">Você recebe a correção em cerca de 1 minuto e pode enviar quantas versões quiser.</p>
      </div>`}
    </div>
  </div>
  <h3 style="margin:36px 0 16px;font-size:22px">Envios ${versions ? `<span class="dim" style="font-weight:400">(${versions})</span>` : ""}</h3>
  ${versions ? subs.map((s, i) => subHTML(s, versions - i, opts)).join("") : `<div class="card empty">Nenhum envio ainda. Quando enviar o PDF, a correção aparece aqui.</div>`}`;
}

const isPending = (s) => s.status === "corrigindo" || s.status === "processando";
const isFresh = (s) => isPending(s) && Date.now() - new Date(s.created_at).getTime() < 5 * 60 * 1000;

function subHTML(s, n, opts) {
  const fb = s.feedback;
  const stuck = isPending(s) && Date.now() - new Date(s.created_at).getTime() > 5 * 60 * 1000;
  const status = stuck ? `<span class="pill bad">Demorou demais</span>`
    : isPending(s) ? `<span class="pill wait"><span class="spinner" style="width:12px;height:12px"></span> Corrigindo...</span>`
    : s.status === "erro" ? `<span class="pill bad">Não deu para corrigir</span>`
    : fb?.pronto_para_entrevista ? `<span class="pill ok">Pronto para entrevista</span>` : `<span class="pill">Corrigido</span>`;
  const review = s.revisao_rh
    ? `<div class="rh-note"><b>Revisão do recrutador · ${fmtDate(s.revisado_em)}</b><p style="white-space:pre-wrap">${esc(s.revisao_rh)}</p></div>`
    : s.pediu_revisao ? `<span class="pill amb">Revisão humana pedida</span>` : "";
  const rhForm = opts.rh ? `<div class="field" style="margin:0"><label for="rv-${s.id}">${s.revisao_rh ? "Editar sua revisão" : "Escrever revisão para o candidato"}</label>
      <textarea id="rv-${s.id}" style="min-height:110px" placeholder="O que está bom, o que mudar antes de uma entrevista real...">${esc(s.revisao_rh || "")}</textarea>
      <div><button class="btn btn-amber btn-sm" data-review="${s.id}">Salvar revisão</button></div></div>` : "";
  return `<article class="sub fade">
    <div class="sub-h"><div><b>Versão ${n}</b> <span class="muted">· ${fmtDateTime(s.created_at)} · ${esc(s.arquivo_nome || "case.pdf")}</span></div>
      <div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap">${status}<button class="link" data-pdf="${esc(s.arquivo_path)}">Ver PDF</button></div></div>
    ${s.status === "erro" ? `<p class="muted">${esc(s.erro || "Tente enviar de novo.")}</p>` : ""}
    ${stuck ? `<p class="muted">A correção não terminou. Envie o PDF de novo; se acontecer outra vez, avise a equipe.</p>` : ""}
    ${fb ? `<div style="display:flex;gap:18px;align-items:flex-end;flex-wrap:wrap"><div class="score">${Number(s.nota ?? fb.nota_geral).toFixed(1)}<small> / 10</small></div><p class="muted" style="flex:1;min-width:220px">${esc(fb.resumo)}</p></div>
      <div style="display:grid;gap:14px">${(fb.criterios ?? []).map((k) => `<div class="cbar"><span>${esc(k.nome)}</span><span class="bar"><i style="width:${Math.max(0, Math.min(10, +k.nota || 0)) * 10}%"></i></span><b>${esc(k.nota)}</b><p>${esc(k.comentario)}</p></div>`).join("")}</div>
      <div class="fb-cols">
        <div class="fb-box"><h4>Pontos fortes</h4><ul>${(fb.pontos_fortes ?? []).map((x) => `<li>${esc(x)}</li>`).join("")}</ul></div>
        <div class="fb-box"><h4>O que melhorar</h4><ul>${(fb.melhorar ?? []).map((x) => `<li><b>${esc(x.ponto)}:</b> ${esc(x.como)}</li>`).join("")}</ul></div>
      </div>
      ${fb.proximo_passo ? `<div class="next"><b>Próximo passo:</b> ${esc(fb.proximo_passo)}</div>` : ""}` : ""}
    ${review}
    ${!opts.readonly && s.status === "corrigido" && !s.pediu_revisao && !s.revisao_rh ? `<div><button class="btn btn-ghost btn-sm" data-ask="${s.id}">${ic("flag")} Pedir revisão de um recrutador</button></div>` : ""}
    ${rhForm}
  </article>`;
}

function diagHTML(plan) {
  const comp = plan.plano?.competencias ?? [];
  const col = (st, t, color) => `<div class="comp-col"><h3><i style="background:${color}"></i>${t} <span class="dim" style="font-weight:400">${comp.filter((c) => c.status === st).length}</span></h3>
    ${comp.filter((c) => c.status === st).map((c) => `<div class="comp-item"><b>${esc(c.nome)}</b><span>${esc(c.porque)}</span></div>`).join("") || `<p class="dim" style="font-size:14px">Nada aqui.</p>`}</div>`;
  return `<div class="comp">${col("tem", "Você já tem", "var(--green)")}${col("parcial", "Precisa reforçar", "var(--amber-hi)")}${col("falta", "Falta aprender", "var(--blue-2)")}</div>`;
}
function vagaHTML(plan) {
  return `<div class="card"><span class="label">Texto da vaga</span>
    ${/^https?:\/\//i.test(plan.vaga_link || "") ? `<p style="margin:12px 0"><a href="${esc(plan.vaga_link)}" target="_blank" rel="noopener">Abrir vaga original ${ic("ext")}</a></p>` : ""}
    <p style="white-space:pre-wrap;color:#CBD3E8;margin-top:14px;font-size:15px">${esc(plan.vaga_texto)}</p></div>`;
}

/* shared plan body (candidate and RH) */
function planBody(plan, subs, opts) {
  const v = plan.plano?.vaga ?? {};
  const pr = progressOf(plan);
  const pending = subs.filter((s) => s.pediu_revisao && !s.revisao_rh).length;
  const tabs = [["trilha", "Trilha"], ["case", "Case"], ["diag", "Diagnóstico"], ["vaga", "Vaga"]];
  const content = S.tab === "case" ? caseHTML(plan, subs, opts) : S.tab === "diag" ? diagHTML(plan) : S.tab === "vaga" ? vagaHTML(plan) : weeksHTML(plan, opts.readonly);
  return `<div class="plan-head fade">
      <div><span class="label">${esc(plan.area)}${v.senioridade ? " · " + esc(v.senioridade) : ""}</span>
        <h1>${esc(v.titulo || "Sua vaga")}${v.empresa ? ` <span class="dim" style="font-weight:400">· ${esc(v.empresa)}</span>` : ""}</h1>
        ${opts.rh ? `<p class="muted">${esc(v.resumo)}</p>` : `<p class="msg">${esc(plan.plano?.mensagem || v.resumo || "")}</p>`}</div>
      <div class="ringbig" aria-label="${pr.pct}% da trilha concluída"><svg viewBox="0 0 44 44"><circle class="bg" cx="22" cy="22" r="18" pathLength="100"/><circle class="fg" cx="22" cy="22" r="18" pathLength="100" style="stroke-dashoffset:${100 - pr.pct}"/></svg><b>${pr.pct}%</b><small>${pr.done}/${pr.total}</small></div>
    </div>
    ${(() => {
      const faltam = (plan.plano?.semanas ?? []).filter((s) => !(s.itens ?? []).length).length;
      if (!faltam) return "";
      return `<div class="card" style="display:flex;gap:16px;align-items:center;justify-content:space-between;flex-wrap:wrap;margin-bottom:22px;border-color:rgba(124,157,255,.35)">
        <span><b>Faltam ${faltam} semana${faltam > 1 ? "s" : ""} para a trilha ficar completa.</b> <span class="muted">O diagnóstico e o case já estão prontos.</span></span>
        ${opts.rh ? "" : `<button class="btn btn-blue btn-sm" id="resume">Continuar montando ${ic("bolt")}</button>`}</div>`;
    })()}
    <div class="tabs" role="tablist">${tabs.map(([k, t]) => `<button role="tab" data-tab="${k}" aria-selected="${S.tab === k}">${t}${k === "case" && subs.length ? `<span class="cnt">${subs.length}</span>` : ""}${k === "case" && opts.rh && pending ? `<span class="cnt">revisar</span>` : ""}</button>`).join("")}</div>
    <div id="pbody" class="fade">${content}</div>`;
}

function bindPlanBody(plan, subs, opts, rerender) {
  $$("[data-tab]").forEach((b) => b.addEventListener("click", () => { S.tab = b.dataset.tab; rerender(); }));
  $$("[data-toggle]").forEach((b) => b.addEventListener("click", () => {
    const i = +b.dataset.toggle; S.openWeeks.has(i) ? S.openWeeks.delete(i) : S.openWeeks.add(i);
    b.closest(".week").classList.toggle("open"); b.setAttribute("aria-expanded", S.openWeeks.has(i));
  }));
  $$("[data-pdf]").forEach((b) => b.addEventListener("click", async () => {
    const win = window.open("", "_blank"); // abre já no clique para o navegador não bloquear
    const { data, error } = await sb.storage.from("cases").createSignedUrl(b.dataset.pdf, 600);
    if (error || !data?.signedUrl) { win?.close(); return toast("Não deu para abrir o PDF agora."); }
    if (win) { win.opener = null; win.location.href = data.signedUrl; } else location.href = data.signedUrl;
  }));
  if (!opts.readonly) {
    $$(".tick").forEach((b) => b.addEventListener("click", () => {
      const k = b.dataset.key; const on = !plan.progresso?.[k];
      plan.progresso = { ...(plan.progresso || {}) }; if (on) plan.progresso[k] = new Date().toISOString(); else delete plan.progresso[k];
      b.closest(".item").classList.toggle("ok", on); b.setAttribute("aria-pressed", on);
      const pr = progressOf(plan); const ring = $(".ringbig");
      if (ring) { $(".fg", ring).style.strokeDashoffset = 100 - pr.pct; $("b", ring).textContent = pr.pct + "%"; $("small", ring).textContent = `${pr.done}/${pr.total}`; }
      clearTimeout(saveT);
      saveT = setTimeout(async () => {
        const { error } = await sb.from("plans").update({ progresso: plan.progresso, updated_at: new Date().toISOString() }).eq("id", plan.id);
        if (error) toast("Não salvou o progresso. Verifique sua conexão.");
        else if (on && pr.pct === 100) toast("Trilha concluída! Agora é caprichar no case.");
      }, 700);
    }));
    const drop = $("#drop"), input = $("#pdf");
    if (drop) {
      ["dragover", "dragenter"].forEach((ev) => drop.addEventListener(ev, (e) => { e.preventDefault(); drop.classList.add("over"); }));
      ["dragleave", "drop"].forEach((ev) => drop.addEventListener(ev, () => drop.classList.remove("over")));
      drop.addEventListener("drop", (e) => { e.preventDefault(); const f = e.dataTransfer.files?.[0]; if (f) uploadCase(f); });
      input.addEventListener("change", () => { const f = input.files?.[0]; if (f) uploadCase(f); });
    }
    $$("[data-ask]").forEach((b) => b.addEventListener("click", async () => {
      b.disabled = true;
      const { error } = await sb.from("submissions").update({ pediu_revisao: true }).eq("id", b.dataset.ask);
      if (error) { b.disabled = false; return toast("Não deu para pedir agora. Tente de novo."); }
      const s = subs.find((x) => x.id === b.dataset.ask); if (s) s.pediu_revisao = true;
      toast("Pedido enviado. Um recrutador vai revisar seu case."); rerender();
    }));
  }
  if (opts.rh) {
    $$("[data-review]").forEach((b) => b.addEventListener("click", async () => {
      const id = b.dataset.review, txt = $(`#rv-${id}`).value.trim();
      if (!txt) return toast("Escreva a revisão antes de salvar.");
      b.disabled = true;
      const { error } = await sb.from("submissions").update({ revisao_rh: txt, revisado_em: new Date().toISOString() }).eq("id", id);
      b.disabled = false;
      if (error) return toast("Não salvou. Tente de novo.");
      const s = subs.find((x) => x.id === id); if (s) { s.revisao_rh = txt; s.revisado_em = new Date().toISOString(); }
      toast("Revisão salva. O candidato já pode ver."); rerender();
    }));
  }
}

/* ---------------- candidate plan view ---------------- */
function renderPlan() {
  clearTimeout(pollT);
  const plan = S.plan;
  if (!plan) return renderWizard();
  const sw = S.plans.length > 1
    ? `<div class="plans-switch"><select id="psel" aria-label="Trocar de trilha">${S.plans.map((p) => `<option value="${p.id}" ${p.id === plan.id ? "selected" : ""}>${esc(p.plano?.vaga?.titulo || "Trilha")}</option>`).join("")}</select></div>` : "";
  app.innerHTML = `${topbar(`${sw}<button class="btn btn-ghost btn-sm" id="newp">${ic("plus")} Nova vaga</button>`)}
    <main class="wrap" style="padding-bottom:80px">${planBody(plan, S.subs, { readonly: false, rh: false })}</main>`;
  bindTop();
  $("#newp").addEventListener("click", () => { S.wiz.step = 0; renderWizard(); });
  $("#resume")?.addEventListener("click", resumeWeeks);
  $("#psel")?.addEventListener("change", async (e) => {
    try { localStorage.setItem("lu-plan", e.target.value); } catch (_) {}
    S.plan = S.plans.find((p) => p.id === e.target.value); S.openWeeks = new Set(); S.tab = "trilha";
    await loadSubs(S.plan.id); renderPlan();
  });
  bindPlanBody(plan, S.subs, { readonly: false, rh: false }, renderPlan);
  // enquanto houver correção em andamento, atualiza sozinho (até ~3 min)
  if (S.subs.some(isFresh)) schedulePoll();
}
let pollN = 0;
function schedulePoll() {
  clearTimeout(pollT);
  if (pollN++ > 18) return; // para depois de ~3 minutos
  pollT = setTimeout(async () => {
    if (!S.plan || S.profile?.role === "rh") return;
    await loadSubs(S.plan.id);
    if (S.tab === "case") renderPlan();
    else if (S.subs.some(isFresh)) schedulePoll();
  }, 10000);
}

async function uploadCase(file) {
  if (file.type !== "application/pdf" && !/\.pdf$/i.test(file.name)) return toast("Envie um arquivo em PDF.");
  if (file.size > 10 * 1024 * 1024) return toast("O PDF passou de 10 MB. Exporte com qualidade menor.");
  const plan = S.plan;
  const path = `${currentUid}/${plan.id}/${Date.now()}.pdf`;
  const drop = $("#drop"); if (drop) drop.innerHTML = `<span class="spinner"></span><b>Enviando ${esc(file.name)}...</b>`;
  const up = await sb.storage.from("cases").upload(path, file, { contentType: "application/pdf", upsert: false });
  if (up.error) { toast("Não deu para enviar o arquivo. Tente de novo."); return renderPlan(); }
  const { data: sub, error } = await sb.from("submissions").insert({ plan_id: plan.id, arquivo_path: path, arquivo_nome: file.name.slice(0, 120) }).select("*").single();
  if (error) { toast("Não deu para registrar o envio. Tente de novo."); return renderPlan(); }
  pollN = 0;
  S.subs.unshift(sub); S.tab = "case"; renderPlan();
  toast("Recebido! A correção chega em cerca de 1 minuto.");
  try { await invokeFn("corrigir-case", { submission_id: sub.id }); }
  catch (e) { toast(e.message); }
  // a correção roda no servidor; a página confere de 10 em 10 segundos
  if (S.plan?.id === plan.id) { await loadSubs(plan.id); if (S.tab === "case") renderPlan(); else if (S.subs.some(isFresh)) schedulePoll(); }
}

/* ---------------- RH ---------------- */
async function loadRH() {
  app.innerHTML = `${topbar()}<main class="wrap"><div class="gen"><span class="spinner"></span></div></main>`;
  bindTop();
  const [pr, pl, su, al] = await Promise.all([
    sb.from("profiles").select("*").order("created_at", { ascending: false }),
    sb.from("plans").select("*").order("created_at", { ascending: false }),
    sb.from("submissions").select("*").order("created_at", { ascending: false }),
    sb.from("allowlist").select("*").order("added_at", { ascending: false }),
  ]);
  S.rh = { profiles: pr.data ?? [], plans: pl.data ?? [], subs: su.data ?? [], allow: al.data ?? [] };
  if (S.rhPlanId && S.rh.plans.some((p) => p.id === S.rhPlanId)) return renderRHDetail(S.rhPlanId);
  renderRH();
}

function rhRows() {
  const { profiles, plans, subs } = S.rh;
  const byId = Object.fromEntries(profiles.map((p) => [p.id, p]));
  const rows = plans.map((p) => {
    const ss = subs.filter((s) => s.plan_id === p.id);
    const last = ss.find((s) => s.status === "corrigido");
    const pend = ss.filter((s) => s.pediu_revisao && !s.revisao_rh).length;
    const prof = byId[p.user_id] || {};
    const act = [p.updated_at, ss[0]?.created_at, prof.last_seen].filter(Boolean).sort().pop();
    return { p, prof, pr: progressOf(p), versions: ss.length, last, pend, act };
  });
  const withPlan = new Set(plans.map((p) => p.user_id));
  const noPlan = profiles.filter((p) => p.role === "candidato" && !withPlan.has(p.id));
  return { rows, noPlan };
}

function renderRH() {
  const { profiles, subs, allow } = S.rh;
  const { rows, noPlan } = rhRows();
  const cands = profiles.filter((p) => p.role === "candidato").length;
  const pending = subs.filter((s) => s.pediu_revisao && !s.revisao_rh);
  const avg = (() => { const n = subs.filter((s) => s.nota != null); return n.length ? (n.reduce((a, s) => a + Number(s.nota), 0) / n.length).toFixed(1) : "—"; })();
  const tabs = [["candidatos", "Candidatos"], ["revisoes", `Revisões pedidas${pending.length ? ` <span class="cnt">${pending.length}</span>` : ""}`], ["acesso", "Acesso"]];
  let content = "";
  if (S.rhTab === "candidatos") {
    content = rows.length || noPlan.length ? `<div class="tbl"><table>
      <thead><tr><th>Candidato</th><th>Vaga</th><th>Trilha</th><th>Case</th><th>Revisão</th><th>Última atividade</th></tr></thead>
      <tbody>${rows.map((r) => `<tr data-plan="${r.p.id}">
        <td><span class="nm">${esc(r.prof.nome || "—")}</span><span class="em">${esc(r.prof.email || "")}</span></td>
        <td><span class="nm">${esc(r.p.plano?.vaga?.titulo || "—")}</span><span class="em">${esc(r.p.area)}</span></td>
        <td><span class="minibar"><i style="width:${r.pr.pct}%"></i></span>${r.pr.pct}%</td>
        <td>${r.last ? `<b>${Number(r.last.nota).toFixed(1)}</b> <span class="em">· ${r.versions} ${r.versions === 1 ? "versão" : "versões"}</span>` : r.versions ? `<span class="em">${r.versions} enviado</span>` : `<span class="em">Ainda não enviou</span>`}</td>
        <td>${r.pend ? `<span class="pill amb">Pedida</span>` : r.last?.revisao_rh ? `<span class="pill ok">Feita</span>` : `<span class="em">—</span>`}</td>
        <td><span class="em">${fmtDate(r.act)}</span></td></tr>`).join("")}
        ${noPlan.map((p) => `<tr style="cursor:default"><td><span class="nm">${esc(p.nome || "—")}</span><span class="em">${esc(p.email)}</span></td><td colspan="4"><span class="em">Entrou, mas ainda não criou a trilha</span></td><td><span class="em">${fmtDate(p.last_seen || p.created_at)}</span></td></tr>`).join("")}
      </tbody></table></div>` : `<div class="card empty">Ninguém entrou ainda. Adicione e-mails na aba Acesso e mande o link do app para as pessoas.</div>`;
  }
  if (S.rhTab === "revisoes") {
    const byPlan = Object.fromEntries(S.rh.plans.map((p) => [p.id, p]));
    const byId = Object.fromEntries(profiles.map((p) => [p.id, p]));
    content = pending.length ? `<div class="tbl"><table><thead><tr><th>Candidato</th><th>Vaga</th><th>Nota da IA</th><th>Enviado em</th></tr></thead><tbody>
      ${pending.map((s) => `<tr data-plan="${s.plan_id}" data-case="1"><td><span class="nm">${esc(byId[s.user_id]?.nome || "—")}</span><span class="em">${esc(byId[s.user_id]?.email || "")}</span></td>
        <td>${esc(byPlan[s.plan_id]?.plano?.vaga?.titulo || "—")}</td><td><b>${s.nota != null ? Number(s.nota).toFixed(1) : "—"}</b></td><td><span class="em">${fmtDateTime(s.created_at)}</span></td></tr>`).join("")}
      </tbody></table></div>` : `<div class="card empty">Nenhuma revisão pendente. O RH só é chamado quando um candidato pede.</div>`;
  }
  if (S.rhTab === "acesso") {
    content = `<div class="allow">
      <form class="card" id="af"><span class="label">Liberar acesso</span><h3 style="margin:10px 0 8px">Adicionar e-mails ao grupo</h3>
        <p class="muted" style="font-size:14px;margin-bottom:14px">Um por linha ou separados por vírgula. Depois é só mandar o link do app para a pessoa.</p>
        <div class="field"><label for="ae" class="sr">E-mails</label><textarea id="ae" style="min-height:140px" placeholder="ana@gmail.com&#10;lucas@hotmail.com"></textarea></div>
        <button class="btn btn-blue" type="submit">Adicionar</button></form>
      <div class="card"><span class="label">Na lista (${allow.length})</span>
        <div class="allow-list" style="margin-top:14px">${allow.map((a) => { const p = profiles.find((x) => x.email === a.email); return `<div><span>${esc(a.email)} ${p ? `<span class="pill ${p.role === "rh" ? "amb" : "ok"}" style="margin-left:6px">${p.role === "rh" ? "RH" : "já entrou"}</span>` : ""}</span><button class="link" data-rm="${esc(a.email)}" style="color:var(--red)">Remover</button></div>`; }).join("") || `<p class="dim">Lista vazia.</p>`}</div>
        <p class="dim" style="font-size:13px;margin-top:14px">Remover da lista impede novos cadastros, mas não apaga quem já entrou.</p></div>
    </div>`;
  }
  app.innerHTML = `${topbar(`<button class="btn btn-ghost btn-sm" id="reload">Atualizar</button>`)}<main class="wrap" style="padding-bottom:80px">
    <div class="rh-head fade"><div><span class="label">Visão geral</span><h1>Como o grupo está indo</h1></div></div>
    <div class="kpis fade">
      <div class="kpi"><b>${cands}</b><span>candidatos</span></div>
      <div class="kpi"><b>${S.rh.plans.length}</b><span>trilhas criadas</span></div>
      <div class="kpi"><b>${subs.length}</b><span>cases enviados · média ${avg}</span></div>
      <div class="kpi"><b style="color:${pending.length ? "var(--amber-hi)" : "inherit"}">${pending.length}</b><span>revisões pedidas</span></div>
    </div>
    <div class="tabs" role="tablist">${tabs.map(([k, t]) => `<button role="tab" data-rtab="${k}" aria-selected="${S.rhTab === k}">${t}</button>`).join("")}</div>
    <div class="fade">${content}</div></main>`;
  bindTop();
  $("#reload").onclick = () => loadRH();
  $$("[data-rtab]").forEach((b) => b.addEventListener("click", () => { S.rhTab = b.dataset.rtab; renderRH(); }));
  $$("tr[data-plan]").forEach((tr) => tr.addEventListener("click", () => { S.tab = tr.dataset.case ? "case" : "trilha"; S.openWeeks = new Set(); renderRHDetail(tr.dataset.plan); }));
  $("#af")?.addEventListener("submit", async (e) => {
    e.preventDefault();
    const emails = [...new Set($("#ae").value.split(/[\s,;]+/).map((x) => x.trim().toLowerCase()).filter((x) => /^\S+@\S+\.\S+$/.test(x)))];
    if (!emails.length) return toast("Digite pelo menos um e-mail válido.");
    const { error } = await sb.from("allowlist").upsert(emails.map((email) => ({ email })), { onConflict: "email" });
    if (error) return toast("Não deu para adicionar. Tente de novo.");
    toast(`${emails.length} e-mail(s) liberado(s).`); loadRH();
  });
  $$("[data-rm]").forEach((b) => b.addEventListener("click", async () => {
    if (b.dataset.confirm !== "1") { b.dataset.confirm = "1"; b.textContent = "Confirmar"; return; }
    const { error } = await sb.from("allowlist").delete().eq("email", b.dataset.rm);
    if (error) return toast("Não deu para remover.");
    loadRH();
  }));
}

function renderRHDetail(planId) {
  S.rhPlanId = planId;
  const plan = S.rh.plans.find((p) => p.id === planId);
  if (!plan) { S.rhPlanId = null; return renderRH(); }
  const prof = S.rh.profiles.find((p) => p.id === plan.user_id) || {};
  const subs = S.rh.subs.filter((s) => s.plan_id === planId);
  const r = plan.respostas || {};
  app.innerHTML = `${topbar()}<main class="wrap" style="padding-bottom:80px">
    <div style="padding-top:28px;display:flex;gap:12px;align-items:center;flex-wrap:wrap">
      <button class="btn btn-ghost btn-sm" id="back">${ic("back")} Todos os candidatos</button>
      <span class="muted"><b style="color:var(--text)">${esc(prof.nome || "—")}</b> · ${esc(prof.email || "")} · vem de: ${esc(r.origem || "—")} · nível ${esc(r.nivel || "—")} · ${esc(r.horas || "?")}h/semana · prefere ${esc(r.formato || "—")}</span>
    </div>
    ${planBody(plan, subs, { readonly: true, rh: true })}</main>`;
  bindTop();
  $("#back").onclick = () => { S.rhPlanId = null; S.tab = "trilha"; renderRH(); };
  bindPlanBody(plan, subs, { readonly: true, rh: true }, () => renderRHDetail(planId));
}

boot();
