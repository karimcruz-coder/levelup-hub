// LevelUp Hub · Edge Function "corrigir-case"
// Lê o PDF enviado pelo candidato, manda ao Gemini junto com o case e os
// critérios, e salva a correção (nota por critério + o que melhorar).
// Segredo necessário: GEMINI_API_KEY
import { createClient } from "jsr:@supabase/supabase-js@2";
import { encodeBase64 } from "jsr:@std/encoding@1/base64";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...CORS, "Content-Type": "application/json" } });
const GEMINI_MODEL = Deno.env.get("GEMINI_MODEL") ?? "gemini-2.5-flash";

function prompt(plano: any, anteriores: any[]) {
  const c = plano.case ?? {};
  const hist = anteriores.length
    ? `\nCORREÇÕES ANTERIORES DESTA PESSOA (mais recente primeiro), para comentar a evolução:\n${anteriores
        .map((a, i) => `- Versão ${anteriores.length - i}: nota ${a.nota}. Melhorar: ${(a.feedback?.melhorar ?? []).map((m: any) => m.ponto).join("; ")}`)
        .join("\n")}`
    : "";
  return `Você é um recrutador sênior e mentor no Brasil corrigindo o case de uma pessoa que quer a vaga
"${plano.vaga?.titulo ?? ""}" (${plano.vaga?.empresa ?? ""}). Seja honesto, específico e gentil, em português do Brasil.
Cite trechos ou páginas do PDF quando apontar algo. Não invente conteúdo que não está no PDF.

O CASE PEDIDO:
Título: ${c.titulo}
Contexto: ${c.contexto}
Desafio: ${c.desafio}
Entregáveis: ${(c.entregaveis ?? []).join("; ")}
Critérios (peso): ${(c.criterios ?? []).map((k: any) => `${k.nome} (${k.peso}): ${k.descricao}`).join(" | ")}
${hist}

O PDF anexado é a entrega da pessoa. Avalie cada critério de 0 a 10. A nota geral é a média ponderada pelos pesos,
com uma casa decimal. "pronto_para_entrevista" só é true se a nota geral for 8 ou mais.

Responda SOMENTE com JSON:
{
  "nota_geral": 7.5,
  "resumo": "2 frases",
  "criterios": [{"nome": "", "nota": 7, "comentario": "1-2 frases com exemplo do PDF"}],
  "pontos_fortes": ["", ""],
  "melhorar": [{"ponto": "", "como": "instrução prática e curta"}],
  "proximo_passo": "1 ação concreta para a próxima versão",
  "pronto_para_entrevista": false
}`;
}

declare const EdgeRuntime: { waitUntil(p: Promise<unknown>): void } | undefined;

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  const admin = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
  const jwt = (req.headers.get("Authorization") ?? "").replace(/^Bearer\s+/i, "");
  const { data: { user } } = jwt ? await admin.auth.getUser(jwt) : { data: { user: null } };
  if (!user) return json({ error: "Faça login de novo." }, 401);

  const subId = String((await req.json().catch(() => ({}))).submission_id ?? "");
  // limite de uso da IA gratuita: até 10 envios por pessoa a cada 24h
  const since = new Date(Date.now() - 864e5).toISOString();
  const { count } = await admin.from("submissions").select("id", { count: "exact", head: true })
    .eq("user_id", user.id).gte("created_at", since);
  if ((count ?? 0) > 10) {
    const msg = "Você chegou ao limite de 10 envios em 24 horas. Tente de novo amanhã.";
    await admin.from("submissions").update({ status: "erro", erro: msg })
      .eq("id", subId).eq("user_id", user.id).eq("status", "corrigindo");
    return json({ error: msg }, 429);
  }
  // "Reserva" o envio: só corrige uma vez, e só se for da própria pessoa
  const { data: sub } = await admin.from("submissions").update({ status: "processando" })
    .eq("id", subId).eq("user_id", user.id).eq("status", "corrigindo").select("*").maybeSingle();
  if (!sub) return json({ error: "Esse envio já foi corrigido ou não existe." }, 409);
  if (!String(sub.arquivo_path).startsWith(`${user.id}/${sub.plan_id}/`)) {
    await admin.from("submissions").update({ status: "erro", erro: "Arquivo inválido." }).eq("id", subId);
    return json({ error: "Arquivo inválido." }, 400);
  }

  // A correção continua mesmo se a pessoa fechar a página
  const work = grade(admin, sub);
  if (typeof EdgeRuntime !== "undefined") { EdgeRuntime.waitUntil(work); return json({ ok: true, background: true }, 202); }
  await work;
  return json({ ok: true });
});

// deno-lint-ignore no-explicit-any
async function grade(admin: any, sub: any) {
  const subId = sub.id;
  try {
    const { data: plan } = await admin.from("plans").select("plano").eq("id", sub.plan_id).single();
    const { data: prev } = await admin.from("submissions").select("nota, feedback")
      .eq("plan_id", sub.plan_id).eq("status", "corrigido").neq("id", subId)
      .order("created_at", { ascending: false }).limit(3);

    const { data: file, error: dlErr } = await admin.storage.from("cases").download(sub.arquivo_path);
    if (dlErr || !file) throw new Error("PDF não encontrado no armazenamento");
    const pdf = new Uint8Array(await file.arrayBuffer());
    if (pdf.byteLength > 10 * 1024 * 1024) throw new Error("PDF maior que 10 MB");

    const key = (Deno.env.get("GEMINI_API_KEY") ?? Deno.env.get("GEMINI"));
    if (!key) throw new Error("GEMINI_API_KEY não configurada");
    const res = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-goog-api-key": key.trim() },
        body: JSON.stringify({
          contents: [{ role: "user", parts: [
            { inline_data: { mime_type: "application/pdf", data: encodeBase64(pdf) } },
            { text: prompt(plan?.plano ?? {}, prev ?? []) },
          ] }],
          generationConfig: {
            responseMimeType: "application/json", temperature: 0.3, maxOutputTokens: 6000,
            thinkingConfig: { thinkingBudget: 1024 },
          },
        }),
      },
    );
    if (res.status === 429) throw new Error("LIMITE_IA");
    if (!res.ok) throw new Error(`Gemini ${res.status}: ${(await res.text()).slice(0, 300)}`);
    const out = (await res.json())?.candidates?.[0]?.content?.parts?.map((p: any) => p.text ?? "").join("") ?? "";
    const fb = JSON.parse(out.slice(out.indexOf("{"), out.lastIndexOf("}") + 1));
    const nota = Math.max(0, Math.min(10, Number(fb.nota_geral) || 0));

    await admin.from("submissions").update({ status: "corrigido", feedback: fb, nota, erro: null }).eq("id", subId);
  } catch (e) {
    const msg = String((e as Error)?.message ?? e);
    console.error(msg);
    const friendly = msg === "LIMITE_IA"
      ? "A IA está no limite de uso agora. Envie o PDF de novo em 1 minuto."
      : "Não conseguimos ler esse PDF. Confira se ele abre normalmente, tem até 10 MB, e envie de novo.";
    await admin.from("submissions").update({ status: "erro", erro: friendly }).eq("id", subId);
  }
}
