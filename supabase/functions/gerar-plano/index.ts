// LevelUp Hub · Edge Function "gerar-plano"
// Recebe a vaga + respostas do candidato, pede ao Gemini um plano (diagnóstico,
// trilha semana a semana e case), busca vídeos reais no YouTube e salva tudo.
// Segredos necessários (Supabase > Edge Functions > Secrets):
//   GEMINI_API_KEY, YOUTUBE_API_KEY   (YOUTUBE é opcional: sem ela, viram links de busca)
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

function prompt(area: string, vaga: string, r: Record<string, unknown>) {
  const horas = Number(r.horas) || 4;
  const semanas = Math.min(Math.max(Number(r.semanas) || 6, 2), 12);
  return `Você é um especialista em carreira e recrutamento no Brasil, montando um plano de estudo
para uma pessoa conseguir UMA vaga específica. Escreva tudo em português do Brasil, direto e encorajador.

ÁREA: ${area}
VAGA (texto colado pela pessoa, pode estar bagunçado):
"""
${vaga.slice(0, 9000)}
"""

SOBRE A PESSOA:
- Nome: ${r.nome ?? "não informado"}
- De onde vem / experiência: ${r.origem ?? "não informado"}
- Nível atual na área: ${r.nivel ?? "não informado"}
- Tempo por semana: ${horas} horas
- Prazo: ${semanas} semanas
- Prefere: ${r.formato ?? "misto"} (videos = maioria vídeos; leitura = maioria artigos e livros; misto = equilibrado)

REGRAS DA TRILHA:
1. Exatamente ${semanas} semanas. Some os "minutos" dos itens de cada semana: NUNCA passe de ${horas * 60} minutos.
2. Foque nas competências que FALTAM para esta vaga. Não ensine o que a pessoa já tem.
3. Cada semana tem 3 a 6 itens e termina com 1 item do tipo "pratica" ligado ao case.
4. NUNCA escreva URLs. Para cada item informe um campo "busca":
   - tipo "video": termos de busca para o YouTube em português (ex.: "SQL joins para iniciantes"),
     específicos o bastante para achar uma aula boa e curta.
   - tipo "artigo": termos de busca para o Google (pode citar fontes conhecidas, ex.: "Alura blog o que é ETL").
   - tipo "livro": só livros REAIS e conhecidos, com autor. Se não tiver certeza que existe, não use livro.
   - tipo "pratica": um exercício curto que a pessoa faz sozinha (em "busca" coloque "").
5. "minutos" realista: vídeo 10-40, artigo 10-25, capítulo de livro 30-60, prática 30-90.

REGRAS DO CASE:
- Um desafio prático com cara da empresa e da vaga, que a pessoa resolve em ${Math.max(3, Math.round(horas * 1.5))} horas no máximo
  e entrega em UM PDF (relatório, apresentação ou dashboard exportado).
- Se precisar de dados, invente uma tabela pequena e realista em "dados" (texto/Markdown, até 15 linhas)
  ou descreva onde achar dados públicos gratuitos.
- 4 a 5 critérios de avaliação com peso (somando 100), do jeito que um recrutador avaliaria.

Responda SOMENTE com um JSON neste formato exato:
{
  "vaga": {"titulo": "", "empresa": "", "senioridade": "", "resumo": "2 frases sobre o que a vaga pede"},
  "mensagem": "1 frase motivadora e específica para a pessoa",
  "competencias": [{"nome": "", "tipo": "tecnica|comportamental", "status": "tem|parcial|falta", "porque": "1 frase"}],
  "semanas": [{"numero": 1, "tema": "", "objetivo": "1 frase", "itens": [
     {"tipo": "video|artigo|livro|pratica", "titulo": "", "busca": "", "autor": "", "minutos": 20, "porque": "1 frase ligando à vaga"}
  ]}],
  "case": {"titulo": "", "contexto": "", "desafio": "", "dados": "", "entregaveis": [""],
           "criterios": [{"nome": "", "peso": 25, "descricao": ""}], "dicas": [""]}
}`;
}

async function gemini(text: string) {
  const key = (Deno.env.get("GEMINI_API_KEY") ?? Deno.env.get("GEMINI"));
  if (!key) throw new Error("GEMINI_API_KEY não configurada");
  const res = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-goog-api-key": key.trim() },
      body: JSON.stringify({
        contents: [{ role: "user", parts: [{ text }] }],
        generationConfig: {
          responseMimeType: "application/json", temperature: 0.6, maxOutputTokens: 16000,
        },
      }),
    },
  );
  if (res.status === 429) throw new Error("LIMITE_IA");
  if (!res.ok) throw new Error(`Gemini ${res.status}: ${(await res.text()).slice(0, 300)}`);
  const data = await res.json();
  const out = data?.candidates?.[0]?.content?.parts?.map((p: { text?: string }) => p.text ?? "").join("") ?? "";
  const start = out.indexOf("{"), end = out.lastIndexOf("}");
  return JSON.parse(out.slice(start, end + 1));
}

function isoToMin(iso: string) {
  const m = iso.match(/PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?/);
  if (!m) return null;
  return Math.max(1, Math.round((+(m[1] ?? 0)) * 60 + (+(m[2] ?? 0)) + (+(m[3] ?? 0)) / 60));
}

// Busca o melhor vídeo para cada item de vídeo (em paralelo). Sem chave, não faz nada.
async function attachVideos(plano: any) {
  const key = (Deno.env.get("YOUTUBE_API_KEY") ?? Deno.env.get("YOUTUBE"));
  if (!key) return;
  const items: any[] = [];
  for (const s of plano.semanas ?? []) for (const it of s.itens ?? []) if (it.tipo === "video" && it.busca) items.push(it);
  // cada busca gasta 100 da cota diária de 10.000: no máximo 8 por trilha (~12 trilhas/dia)
  await Promise.all(items.slice(0, 8).map(async (it) => {
    try {
      const q = new URLSearchParams({
        part: "snippet", type: "video", maxResults: "5", q: it.busca, key,
        relevanceLanguage: "pt", regionCode: "BR", safeSearch: "strict", videoEmbeddable: "true",
      });
      const s = await (await fetch(`https://www.googleapis.com/youtube/v3/search?${q}`)).json();
      const ids = (s.items ?? []).map((v: any) => v.id?.videoId).filter(Boolean);
      if (!ids.length) return;
      const d = await (await fetch(
        `https://www.googleapis.com/youtube/v3/videos?part=contentDetails,statistics,snippet&id=${ids.join(",")}&key=${key}`,
      )).json();
      // prefere vídeos entre 4 e 60 min, com mais visualizações
      const cands = (d.items ?? []).map((v: any) => ({
        id: v.id, titulo: v.snippet?.title, canal: v.snippet?.channelTitle,
        thumb: v.snippet?.thumbnails?.medium?.url, minutos: isoToMin(v.contentDetails?.duration ?? ""),
        views: Number(v.statistics?.viewCount ?? 0),
      })).filter((v: any) => v.minutos && v.minutos >= 4 && v.minutos <= 60);
      cands.sort((a: any, b: any) => b.views - a.views);
      const best = cands[0];
      if (best) { it.youtube = best; it.minutos = best.minutos; }
    } catch (_) { /* fica só o link de busca */ }
  }));
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  try {
    const admin = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
    const jwt = (req.headers.get("Authorization") ?? "").replace(/^Bearer\s+/i, "");
    const { data: { user } } = jwt ? await admin.auth.getUser(jwt) : { data: { user: null } };
    if (!user) return json({ error: "Faça login de novo." }, 401);

    const body = await req.json();
    const area = AREAS.includes(body.area) ? body.area : AREAS[0];
    const vaga = String(body.vaga_texto ?? "").trim();
    if (vaga.length < 80) return json({ error: "Cole o texto completo da vaga (pelo menos alguns parágrafos)." }, 400);
    // só os campos esperados, com tamanho limitado
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

    // limite simples: no máximo 5 trilhas por pessoa
    const { count } = await admin.from("plans").select("id", { count: "exact", head: true }).eq("user_id", user.id);
    if ((count ?? 0) >= 5) return json({ error: "Você já tem 5 trilhas. Fale com a equipe para liberar mais." }, 400);

    const plano = await gemini(prompt(area, vaga, respostas));
    if (!Array.isArray(plano?.semanas) || !plano?.case) throw new Error("Resposta da IA incompleta");
    await attachVideos(plano);

    const { data, error } = await admin.from("plans").insert({
      user_id: user.id, area, vaga_texto: vaga.slice(0, 20000),
      vaga_link: link,
      respostas, plano,
    }).select("id").single();
    if (error) throw error;
    await admin.from("profiles").update({ ...(respostas.nome ? { nome: respostas.nome } : {}), consentiu: true }).eq("id", user.id);
    return json({ id: data.id });
  } catch (e) {
    const msg = String((e as Error)?.message ?? e);
    if (msg === "LIMITE_IA") return json({ error: "A IA está no limite de uso agora. Tente de novo em 1 minuto." }, 429);
    console.error(msg);
    return json({ error: "Não deu para gerar a trilha agora. Tente de novo em instantes." }, 500);
  }
});
