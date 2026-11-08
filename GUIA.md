# LevelUp Hub · Guia de configuração do MVP

Tudo aqui é **gratuito** e fica em **contas pessoais suas**, sem ligação com Terapon ou Selvia.
Tempo total: cerca de 1 hora, sem programar. Siga na ordem.

## O que tem nesta pasta

```
levelup-app/
├── index.html                 ← o site (landing)
├── app/                       ← o app do candidato e o painel do RH
│   ├── index.html
│   ├── app.js
│   ├── styles.css
│   └── config.js              ← você vai colar 2 dados aqui (passo 3)
├── supabase/
│   ├── schema.sql             ← banco de dados e regras de acesso (passo 2)
│   └── functions/
│       ├── gerar-plano/index.ts    ← IA que monta a trilha e o case
│       └── corrigir-case/index.ts  ← IA que corrige o PDF
└── GUIA.md                    ← este arquivo
```

Use **um Gmail pessoal** (ou um criado só para o projeto, tipo `levelup.hub@gmail.com`) em todas as contas abaixo.

---

## 1. Chaves gratuitas do Google (IA e YouTube)

### 1a. Chave do Gemini (a IA)
1. Acesse **aistudio.google.com** com o Gmail do projeto.
2. Clique em **Get API key** › **Create API key**.
3. Copie a chave e guarde num bloco de notas como `GEMINI_API_KEY`.

> O plano gratuito tem limite por minuto e por dia, que é folgado para um grupo fechado. O Google pode usar o que é enviado para melhorar os modelos; por isso o app pede o consentimento do candidato.

### 1b. Chave do YouTube (vídeos reais na trilha)
1. Acesse **console.cloud.google.com** e crie um projeto chamado `levelup-hub`.
2. No menu, vá em **APIs e serviços › Biblioteca**, procure **YouTube Data API v3** e clique em **Ativar**.
3. Vá em **APIs e serviços › Credenciais › Criar credenciais › Chave de API**.
4. Clique na chave criada › **Restringir chave** › em "Restrições de API" escolha só **YouTube Data API v3** › Salvar.
5. Guarde como `YOUTUBE_API_KEY`.

> Sem essa chave o app funciona igual, mas os vídeos viram um botão de busca no YouTube em vez do vídeo escolhido.

---

## 2. Supabase (login, banco de dados e PDFs)

1. Crie uma conta em **supabase.com** (pode entrar com o GitHub pessoal).
2. **New project** › nome `levelup-hub` › crie uma senha forte para o banco (guarde) › região **South America (São Paulo)** › plano **Free**.
3. Espere o projeto ficar pronto (1 a 2 minutos).

### 2a. Criar o banco
1. Menu da esquerda › **SQL Editor** › **New query**.
2. Abra o arquivo `supabase/schema.sql`, copie **tudo**, cole e clique em **Run**. Deve aparecer "Success".
3. Numa nova query, coloque o seu e-mail e o do RH na lista de acesso e rode:
   ```sql
   insert into public.allowlist (email) values ('seu.email@gmail.com'), ('pessoa.rh@gmail.com');
   ```

### 2b. Envio de e-mail do login (obrigatório)
O Supabase gratuito só manda e-mail de login para a própria equipe do projeto. Para mandar para os candidatos, use o seu Gmail como remetente:

1. No Gmail do projeto, ative a **verificação em duas etapas** (myaccount.google.com › Segurança).
2. Ainda em Segurança, procure **Senhas de app**, crie uma chamada `supabase` e copie a senha de 16 letras.
3. No Supabase: **Authentication › Emails › SMTP Settings** › ative **Enable custom SMTP** e preencha:
   - Sender email: o Gmail do projeto · Sender name: `LevelUp Hub`
   - Host: `smtp.gmail.com` · Port: `465`
   - Username: o Gmail do projeto · Password: a senha de app de 16 letras
4. Salve. (O Gmail permite cerca de 500 e-mails por dia, o que sobra para o grupo.)
5. Opcional: em **Authentication › Emails › Templates › Magic Link**, troque o assunto para "Seu acesso ao LevelUp Hub".

### 2c. Endereço do app (preencha depois do passo 4)
Em **Authentication › URL Configuration**:
- **Site URL:** `https://SEU-USUARIO.github.io/levelup-hub/app/`
- **Redirect URLs:** adicione `https://SEU-USUARIO.github.io/levelup-hub/app/`

### 2d. Funções de IA
Para cada uma das duas funções:
1. Menu › **Edge Functions** › **Deploy a new function** › **Via Editor**.
2. Nome: `gerar-plano` (na segunda vez: `corrigir-case`). **Use exatamente esses nomes.**
3. Apague o código de exemplo, cole o conteúdo de `supabase/functions/gerar-plano/index.ts` (ou `corrigir-case/index.ts`) e clique em **Deploy**.

Depois: **Edge Functions › Secrets** › adicione:
- `GEMINI_API_KEY` = a chave do passo 1a
- `YOUTUBE_API_KEY` = a chave do passo 1b

### 2e. Copiar os dados de conexão
**Project Settings › API** (ou **Data API**). Copie:
- **Project URL** (algo como `https://abcd1234.supabase.co`)
- **anon public** key (uma chave longa que começa com `eyJ`)

> A chave **anon** é pública por design. **Nunca** copie a chave `service_role` para nenhum arquivo do site.

---

## 3. Colar os dados no app
Abra `app/config.js` e troque os dois textos:
```js
export const SUPABASE_URL = "https://abcd1234.supabase.co";
export const SUPABASE_ANON_KEY = "eyJ...";
```

---

## 4. Publicar no GitHub Pages
1. No GitHub pessoal: **New repository** › nome `levelup-hub` › **Public** › Create.
2. Clique em **uploading an existing file** e arraste **o conteúdo** da pasta `levelup-app` (o `index.html`, a pasta `app`, a pasta `supabase` e este guia) › **Commit changes**.
3. **Settings › Pages** › Source: **Deploy from a branch** › Branch: `main` / `(root)` › Save.
4. Em 1 a 2 minutos, o site fica em `https://SEU-USUARIO.github.io/levelup-hub/` e o app em `https://SEU-USUARIO.github.io/levelup-hub/app/`.
5. Volte ao passo **2c** e confira se os endereços batem.

---

## 5. Primeiro acesso e virar RH
1. Abra o app, digite o seu e-mail e clique no link que chegar.
2. No Supabase › SQL Editor, rode (com o seu e-mail e o do RH, depois que cada um entrar uma vez):
   ```sql
   update public.profiles set role = 'rh' where email in ('seu.email@gmail.com', 'pessoa.rh@gmail.com');
   ```
3. Recarregue o app: você verá o **Painel do RH**. Pela aba **Acesso** você libera os e-mails dos candidatos, sem precisar voltar ao Supabase.
4. Para testar como candidato, use outro e-mail seu.

---

## Como o RH usa (pouco tempo, visão total)
- **Candidatos:** cada pessoa, a vaga, % da trilha, nota do último case e última atividade. Clique para ver tudo o que o candidato vê.
- **Revisões pedidas:** só aparece algo quando o candidato aperta "Pedir revisão de um recrutador". Escreva a revisão e salve; o candidato vê na hora.
- **Acesso:** adicione ou remova e-mails do grupo.

## Limites do plano gratuito (para ficar de olho)
| Serviço | Limite | O que significa |
|---|---|---|
| Gemini | por minuto e por dia | se estourar, o app pede para tentar de novo em 1 minuto |
| YouTube | 10.000 unidades/dia | cerca de 12 trilhas novas por dia |
| Supabase Free | 500 MB de banco, 1 GB de arquivos | centenas de candidatos e milhares de PDFs |
| Supabase Free | pausa após 7 dias sem uso | entre no painel do Supabase uma vez por semana, ou mantenha o grupo usando |
| Gmail SMTP | ~500 e-mails/dia | sobra para o grupo |

## Se algo der errado
- **"Esse e-mail ainda não está no grupo"**: adicione o e-mail na aba Acesso (ou na tabela `allowlist`).
- **O link do e-mail abre e volta para o login**: confira o passo 2c (endereços exatos, com `/app/` no final).
- **"Não deu para gerar a trilha"**: veja em Supabase › Edge Functions › `gerar-plano` › **Logs**. Quase sempre é a `GEMINI_API_KEY` faltando ou digitada errada.
- **Para trocar de IA no futuro** (ex.: Claude pago): só as duas funções mudam; o app e o banco continuam iguais.
