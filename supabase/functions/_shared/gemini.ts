// LevelUp Hub · chamada ao Gemini compartilhada pelas duas funções.
// Pergunta ao Google quais modelos esta chave pode usar e tenta do mais rápido
// (linha "flash-lite") para o mais forte, trocando de modelo se um demorar,
// estiver sobrecarregado ou não existir. Assim a função não estoura o limite de
// ~150 s do Supabase gratuito por causa de um único modelo lento.
const BASE = "https://generativelanguage.googleapis.com/v1beta";
let cache: string[] | null = null;

function chave() {
  const k = Deno.env.get("GEMINI_API_KEY") ?? Deno.env.get("GEMINI");
  if (!k) throw new Error("GEMINI_API_KEY não configurada");
  return k.trim();
}

async function modelos(k: string) {
  if (!cache) {
    cache = [];
    try {
      const r = await fetch(`${BASE}/models?pageSize=200`, { headers: { "x-goog-api-key": k } });
      const d = await r.json();
      const nomes: string[] = (d.models ?? [])
        // deno-lint-ignore no-explicit-any
        .filter((m: any) => (m.supportedGenerationMethods ?? []).includes("generateContent"))
        // deno-lint-ignore no-explicit-any
        .map((m: any) => String(m.name).replace(/^models\//, ""))
        .filter((n: string) => /^gemini-[\d.]+-flash(-lite)?(-latest)?$/.test(n));
      const ver = (n: string) => parseFloat(n.match(/gemini-([\d.]+)/)?.[1] ?? "0");
      const lite = nomes.filter((n) => n.includes("lite")).sort((a, b) => ver(b) - ver(a));
      const flash = nomes.filter((n) => !n.includes("lite")).sort((a, b) => ver(b) - ver(a));
      cache = [...lite, ...flash];
      console.log("Modelos disponíveis:", cache.join(", ") || "(nenhum listado)");
    } catch (e) {
      console.error("Não deu para listar modelos:", String(e));
    }
  }
  const fixo = Deno.env.get("GEMINI_MODEL");
  return [...new Set([...(fixo ? [fixo] : []), ...cache, "gemini-3.8-flash"])];
}

type Parte = { text: string } | { inline_data: { mime_type: string; data: string } };

async function tentar(model: string, parts: Parte[], maxTokens: number, temperature: number, ms: number, k: string) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), ms);
  const t0 = Date.now();
  const corpo = (pensar: boolean) => JSON.stringify({
    contents: [{ role: "user", parts }],
    generationConfig: {
      responseMimeType: "application/json", temperature, maxOutputTokens: maxTokens,
      ...(pensar ? { thinkingConfig: { thinkingLevel: "low" } } : {}),
    },
  });
  const chamar = (pensar: boolean) => fetch(`${BASE}/models/${model}:generateContent`, {
    method: "POST", signal: ctl.signal,
    headers: { "Content-Type": "application/json", "x-goog-api-key": k },
    body: corpo(pensar),
  });
  try {
    let res = await chamar(true);
    if (res.status === 400) { await res.text(); res = await chamar(false); } // modelo sem esse ajuste
    if (!res.ok) {
      const txt = (await res.text()).slice(0, 200).replace(/\s+/g, " ");
      return { ok: false as const, err: `${res.status} ${txt}`, fatal: res.status === 401 || res.status === 403 };
    }
    const data = await res.json();
    const out: string = data?.candidates?.[0]?.content?.parts?.map((p: { text?: string }) => p.text ?? "").join("") ?? "";
    const json = JSON.parse(out.slice(out.indexOf("{"), out.lastIndexOf("}") + 1));
    console.log(`${model} respondeu em ${Math.round((Date.now() - t0) / 1000)}s`);
    return { ok: true as const, json };
  } catch (e) {
    return { ok: false as const, err: ctl.signal.aborted ? `demorou mais de ${Math.round(ms / 1000)}s` : String(e), fatal: false };
  } finally {
    clearTimeout(timer);
  }
}

// Devolve o JSON da resposta. Erros: "DEMOROU" (todos lentos) ou "LIMITE_IA" (sobrecarga/cota).
// deno-lint-ignore no-explicit-any
export async function gemini(parts: Parte[], maxTokens: number, temperature = 0.6, orcamentoMs = 115_000): Promise<any> {
  const k = chave();
  const fim = Date.now() + orcamentoMs;
  let ultimo = "";
  for (const model of (await modelos(k)).slice(0, 4)) {
    const resta = fim - Date.now();
    if (resta < 10_000) break;
    const r = await tentar(model, parts, maxTokens, temperature, Math.min(resta, 55_000), k);
    if (r.ok) return r.json;
    ultimo = r.err;
    console.error(`Modelo ${model} falhou: ${r.err}`);
    if (r.fatal) throw new Error(`Chave do Gemini recusada: ${r.err}`);
  }
  throw new Error(ultimo.startsWith("demorou") ? "DEMOROU" : "LIMITE_IA");
}
