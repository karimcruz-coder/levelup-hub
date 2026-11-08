// LevelUp Hub · Edge Function "gerar-plano"
// Monta a trilha em pedaços curtos, para caber no limite de tempo do Supabase gratuito:
//   1) modo "inicio": lê a vaga e devolve diagnóstico, case e o roteiro das semanas (sem conteúdos)
//   2) modo "semanas": preenche os conteúdos de 1 ou 2 semanas por vez e busca vídeos reais no YouTube
// O app chama o passo 1 e depois o passo 2 quantas vezes precisar, mostrando o progresso.
// Segredos: GEMINI_API_KEY (ou GEMINI) e YOUTUBE_API_KEY (ou YOUTUBE, opcional)
import { createClient } from "jsr:@supabase/supabase-js@2";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...CORS, "Content-Type": "application/json" } });

const GEMINI_MODEL = Deno.env.get("GEMINI_MODEL") ?? "gemini-3.8-flash";
const AREAS = ["Dados e BI", "Marketing", "Produto"];
const LIMITE_MS = 120_000; // desiste antes do limite de ~150 s do Supabase

// deno-lint-ignore no-explicit-any
type Any = any;

function contexto(area: string, vaga: string, r: Record<string, unknown>) {
  const horas = Number(r.horas) || 4;
  const semanas = Math.min(Math.max(Number(r.semanas) || 6, 2), 12);
  return {
    horas, semanas,
    texto: `Você é um especialista em carreira e recrutamento no Brasil, ajudando uma pessoa a conseguir UMA vaga
específica. Escreva tudo em português do Brasil, direto e encorajador. Seja conciso.

ÁREA: ${area}
VAGA (texto colado pela pessoa, pode estar bagunçado):
"""
${vaga.slice(0, 8000)}
"""

SOBRE A PESSOA:
- Nome: ${r.nome || "não informado"}
- De onde vem / experiência: ${r.origem || "não informado"}
- Nível atual na área: ${r.nivel || "não informado"}
- Tempo por semana: ${horas} horas
- Prazo: ${semanas} semanas
- Prefere: ${r.formato || "misto"} (videos = maioria vídeos; leitura = maioria artigos e livros; misto = equilibrado)`,
  };
}

function promptInicio(area: string, vaga: string, r: Record<string, unknown>) {
  const c = contexto(area, vaga, r);
  return `${c.texto}

TAREFA: analise a vaga, faça o diagnóstico da pessoa, crie UM case prático e o ROTEIRO da trilha
(só o tema e o objetivo de cada semana; os conteúdos vêm depois).

REGRAS:
- Diagnóstico: 6 a 10 competências que a vaga pede.
- Roteiro: exatamente ${c.semanas} semanas, numa ordem que faça sentido, focando no que a pessoa ainda não domina.
  A última semana prepara o case.
- Case: desafio com cara da empresa e da vaga, que a pessoa resolve em ${Math.max(3, Math.round(c.horas * 1.5))} horas no máximo
  e entrega em UM PDF. Se precisar de dados, invente uma tabela pequena e realista em "dados" (Markdown, até 10 linhas)
  ou diga onde achar dados públicos gratuitos. 4 a 5 critérios com peso (somando 100).

Responda SOMENTE com JSON neste formato:
{
  "vaga": {"titulo": "", "empresa": "", "senioridade": "", "resumo": "2 frases sobre o que a vaga pede"},
  "mensagem": "1 frase motivadora e específica para a pessoa",
  "competencias": [{"nome": "", "tipo": "tecnica|comportamental", "status": "tem|parcial|falta", "porque": "1 frase"}],
  "roteiro": [{"numero": 1, "tema": "", "objetivo": "1 frase"}],
  "case": {"titulo": "", "contexto": "", "desafio": "", "dados": "", "entregaveis": [""],
           "criterios": [{"nome": "", "peso": 25, "descricao": ""}], "dicas": [""]}
}`;
}

function promptSemanas(plan: Any, numeros: number[]) {
  const r = plan.respostas ?? {};
  const c = contexto(plan.area, plan.vaga_texto, r);
  const p = plan.plano ?? {};
  const roteiro = (p.semanas ?? []).map((s: Any) => `Semana ${s.numero}: ${s.tema} (${s.objetivo})`).join("\n");
  const lacunas = (p.competencias ?? []).filter((k: Any) => k.status !== "tem").map((k: Any) => k.nome).join(", ");
  return `${c.texto}

ROTEIRO COMPLETO DA TRILHA:
${roteiro}

COMPETÊNCIAS A DESENVOLVER: ${lacunas || "as que a vaga pede"}
CASE FINAL: ${p.case?.titulo ?? ""}

TAREFA: escolha os conteúdos SÓ das semanas ${numeros.join(" e ")}, seguindo o tema de cada uma.

REGRAS:
1. Cada semana tem 3 a 5 itens. A soma dos "minutos" de cada semana NUNCA passa de ${c.horas * 60}.
2. A última semana termina com 1 item "pratica" (exercício curto que prepara para o case). As outras podem ter 1 "pratica".
3. NUNCA escreva URLs. Em "busca":
   - "video": termos de busca para o YouTube em português, específicos (ex.: "SQL joins para iniciantes").
   - "artigo": termos de busca para o Google (pode citar fontes conhecidas).
   - "livro": só livros REAIS e conhecidos, com autor. Na dúvida, não use livro.
   - "pratica": deixe vazio.
4. "minutos" realista: vídeo 10-40, artigo 10-25, capítulo de livro 30-60, prática 30-90.
5. "porque": no máximo 1 frase curta.

Responda SOMENTE com JSON neste formato:
{"semanas": [{"numero": ${numeros[0]}, "itens": [
  {"tipo": "video|artigo|livro|pratica", "titulo": "", "busca": "", "autor": "", "minutos": 20, "porque": ""}
]}]}`;
}

async function gemini(text: string, maxTokens: number) {
  const key = (Deno.env.get("GEMINI_API_KEY") ?? Deno.env.get("GEMINI"));
  if (!key) throw new Error("GEMINI_API_KEY não configurada");
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), LIMITE_MS);
  const call = (thinking: boolean) => fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent`,
    {
      method: "POST", signal: ctl.signal,
      headers: { "Content-Type": "application/json", "x-goog-api-key": key.trim() },
      body: JSON.stringify({
        contents: [{ role: "user", parts: [{ text }] }],
        generationConfig: {
          responseMimeType: "application/json", temperature: 0.6, maxOutputTokens: maxTokens,
          ...(thinking ? { thinkingConfig: { thinkingLevel: "low" } } : {}),
        },
      }),
    },
  );
  try {
    const t0 = Date.now();
    let res = await call(true);
    // Google sobrecarregado (503/500): espera e tenta de novo, até 3 vezes
    for (const wait of [3000, 8000, 15000]) {
      if (res.status !== 503 && res.status !== 500) break;
      console.error(`Gemini ${res.status}, tentando de novo em ${wait / 1000}s`);
      await new Promise((ok) => setTimeout(ok, wait));
      res = await call(true);
    }
    if (res.status === 400) {
      console.error("Gemini 400 com thinkingLevel, tentando sem:", (await res.text()).slice(0, 200));
      res = await call(false);
    }
    if (res.status === 429 || res.status === 503) throw new Error("LIMITE_IA");
    if (!res.ok) throw new Error(`Gemini ${res.status}: ${(await res.text()).slice(0, 300)}`);
    const data = await res.json();
    console.log(`Gemini respondeu em ${Math.round((Date.now() - t0) / 1000)}s`);
    const out = data?.candidates?.[0]?.content?.parts?.map((p: { text?: string }) => p.text ?? "").join("") ?? "";
    return JSON.parse(out.slice(out.indexOf("{"), out.lastIndexOf("}") + 1));
  } catch (e) {
    if (ctl.signal.aborted) throw new Error("DEMOROU");
    throw e;
  } finally {
    clearTimeout(timer);
  }
}

function isoToMin(iso: string) {
  const m = iso.match(/PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?/);
  if (!m) return null;
  return Math.max(1, Math.round((+(m[1] ?? 0)) * 60 + (+(m[2] ?? 0)) + (+(m[3] ?? 0)) / 60));
}

// Busca o melhor vídeo para cada item de vídeo (em paralelo). Sem chave, não faz nada.
// Cada busca gasta 100 da cota diária de 10.000: no máximo 3 por pedaço (~6 a 9 por trilha).
async function attachVideos(semanas: Any[]) {
  const key = (Deno.env.get("YOUTUBE_API_KEY") ?? Deno.env.get("YOUTUBE"));
  if (!key) return;
  const items: Any[] = [];
  for (const s of semanas) for (const it of s.itens ?? []) if (it.tipo === "video" && it.busca) items.push(it);
  await Promise.all(items.slice(0, 3).map(async (it) => {
    try {
      const q = new URLSearchParams({
        part: "snippet", type: "video", maxResults: "5", q: it.busca, key,
        relevanceLanguage: "pt", regionCode: "BR", safeSearch: "strict", videoEmbeddable: "true",
      });
      const s = await (await fetch(`https://www.googleapis.com/youtube/v3/search?${q}`)).json();
      const ids = (s.items ?? []).map((v: Any) => v.id?.videoId).filter(Boolean);
      if (!ids.length) return;
      const d = await (await fetch(
        `https://www.googleapis.com/youtube/v3/videos?part=contentDetails,statistics,snippet&id=${ids.join(",")}&key=${key}`,
      )).json();
      const cands = (d.items ?? []).map((v: Any) => ({
        id: v.id, titulo: v.snippet?.title, canal: v.snippet?.channelTitle,
        thumb: v.snippet?.thumbnails?.medium?.url, minutos: isoToMin(v.contentDetails?.duration ?? ""),
        views: Number(v.statistics?.viewCount ?? 0),
      })).filter((v: Any) => v.minutos && v.minutos >= 4 && v.minutos <= 60);
      cands.sort((a: Any, b: Any) => b.views - a.views);
      if (cands[0]) { it.youtube = cands[0]; it.minutos = cands[0].minutos; }
    } catch (_) { /* fica só o link de busca */ }
  }));
}

async function inicio(admin: Any, user: Any, body: Any) {
  const area = AREAS.includes(body.area) ? body.area : AREAS[0];
  const vaga = String(body.vaga_texto ?? "").trim();
  if (vaga.length < 80) return json({ error: "Cole o texto completo da vaga (pelo menos alguns parágrafos)." }, 400);
  const r = body.respostas ?? {};
  const pick = (v: unknown, n: number) => String(v ?? "").slice(0, n);
  const respostas = {
    nome: pick(r.nome, 80), origem: pick(r.origem, 300),
    nivel: ["zero", "basico", "intermediario"].includes(r.nivel) ? r.nivel : "basico",
    horas: ["2", "4", "6", "10"].includes(String(r.horas)) ? String(r.horas) : "4",
    semanas: ["4", "6", "8"].includes(String(r.semanas)) ? String(r.semanas) : "6",
    formato: ["videos", "leitura", "misto"].includes(r.formato) ? r.formato : "misto",
  };
  let link: string | null = null;
  try { const u = new URL(String(body.vaga_link ?? "")); if (u.protocol === "https:" || u.protocol === "http:") link = u.href.slice(0, 500); } catch (_) { /* sem link */ }

  const { count } = await admin.from("plans").select("id", { count: "exact", head: true }).eq("user_id", user.id);
  if ((count ?? 0) >= 5) return json({ error: "Você já tem 5 trilhas. Fale com a equipe para liberar mais." }, 400);

  const a = await gemini(promptInicio(area, vaga, respostas), 5000);
  if (!a?.case || !Array.isArray(a?.roteiro) || !a.roteiro.length) throw new Error("Resposta da IA incompleta");
  const semanas = a.roteiro.slice(0, 12).map((s: Any, i: number) => ({
    numero: i + 1, tema: String(s.tema ?? `Semana ${i + 1}`), objetivo: String(s.objetivo ?? ""), itens: [],
  }));
  const plano = { vaga: a.vaga, mensagem: a.mensagem, competencias: a.competencias ?? [], case: a.case, semanas };

  const { data, error } = await admin.from("plans").insert({
    user_id: user.id, area, vaga_texto: vaga.slice(0, 20000), vaga_link: link, respostas, plano,
  }).select("id").single();
  if (error) throw error;
  await admin.from("profiles").update({ ...(respostas.nome ? { nome: respostas.nome } : {}), consentiu: true }).eq("id", user.id);
  return json({ id: data.id, total: semanas.length });
}

async function preencherSemanas(admin: Any, user: Any, body: Any) {
  const { data: plan } = await admin.from("plans").select("*").eq("id", String(body.plan_id ?? "")).maybeSingle();
  if (!plan || plan.user_id !== user.id) return json({ error: "Trilha não encontrada." }, 404);
  const semanas: Any[] = plan.plano?.semanas ?? [];
  // só preenche semanas que ainda estão vazias (evita gerar de novo o que já existe)
  const pedidas = (Array.isArray(body.numeros) ? body.numeros : []).map(Number)
    .filter((n: number) => semanas[n - 1] && !(semanas[n - 1].itens ?? []).length).slice(0, 2);
  if (!pedidas.length) return json({ ok: true, faltam: semanas.filter((s) => !(s.itens ?? []).length).length });

  const out = await gemini(promptSemanas(plan, pedidas), 4000);
  const novas: Any[] = (out?.semanas ?? []).filter((s: Any) => pedidas.includes(Number(s.numero)));
  if (!novas.length) throw new Error("Resposta da IA incompleta");
  await attachVideos(novas);

  // relê a trilha antes de gravar, para não apagar outra semana gravada nesse meio-tempo
  const { data: atual } = await admin.from("plans").select("plano").eq("id", plan.id).single();
  const lista: Any[] = atual.plano.semanas;
  for (const s of novas) {
    const i = Number(s.numero) - 1;
    if (lista[i] && !(lista[i].itens ?? []).length) lista[i].itens = (s.itens ?? []).slice(0, 6);
  }
  await admin.from("plans").update({ plano: { ...atual.plano, semanas: lista } }).eq("id", plan.id);
  return json({ ok: true, faltam: lista.filter((s) => !(s.itens ?? []).length).length });
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  try {
    const admin = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
    const jwt = (req.headers.get("Authorization") ?? "").replace(/^Bearer\s+/i, "");
    const { data: { user } } = jwt ? await admin.auth.getUser(jwt) : { data: { user: null } };
    if (!user) return json({ error: "Faça login de novo." }, 401);
    const body = await req.json();
    return body.modo === "semanas" ? await preencherSemanas(admin, user, body) : await inicio(admin, user, body);
  } catch (e) {
    const msg = String((e as Error)?.message ?? e);
    console.error(msg);
    if (msg === "LIMITE_IA") return json({ error: "A IA do Google está sobrecarregada agora. Tente de novo em 1 ou 2 minutos." }, 429);
    if (msg === "DEMOROU") return json({ error: "A IA do Google está lenta agora e não respondeu a tempo. Tente de novo em instantes." }, 504);
    return json({ error: "Não deu para gerar a trilha agora. Tente de novo em instantes." }, 500);
  }
});
