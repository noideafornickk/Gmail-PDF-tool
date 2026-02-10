# gmail-to-pdf

Projeto fullstack para conectar no Gmail via OAuth, listar e-mails e gerar PDF com Puppeteer.

Arquitetura:
- `frontend/` -> estatico (GitHub Pages)
- `backend/` -> API (Railway + Docker)
- Front chama o back via `window.API_BASE_URL` (`frontend/config.js`)
- Autenticacao por Bearer token no header `Authorization` (sem cookies)

## Estrutura

```text
gmail-to-pdf/
  frontend/
    index.html
    styles.css
    app.js
    config.js
  backend/
    src/index.js
    src/gmail.js
    src/pdf.js
    src/selfcheck.js
    Dockerfile
    package.json
    .env.example
    .gitignore
  .gitignore
  README.md
```

## Seguranca (critico)

- NUNCA commitar `backend/.env`.
- NUNCA commitar `client_secret*.json`.
- NUNCA logar tokens OAuth.
- Tokens Google ficam em memoria do backend (`sessionStore`), sem arquivo/DB.
- Repositorio publico: mantenha `GOOGLE_CLIENT_SECRET` apenas em env local/Railway.

## Variaveis de ambiente

Copie `backend/.env.example` para `backend/.env`:

```env
GOOGLE_CLIENT_ID=
GOOGLE_CLIENT_SECRET=
GOOGLE_REDIRECT_URI=
FRONTEND_ORIGIN=
NODE_ENV=development
```

Valores esperados:
- `GOOGLE_REDIRECT_URI`
  - DEV: `http://localhost:3000/auth/google/callback`
  - PROD: `https://SEUAPP.up.railway.app/auth/google/callback`
- `FRONTEND_ORIGIN`
  - DEV: `http://localhost:5500` (ou origem real do seu server estatico)
  - PROD: `https://SEUUSUARIO.github.io`

## Google OAuth (resumo)

1. Google Cloud -> `APIs e servicos` -> `Tela de consentimento OAuth`.
2. Publico-alvo: `External` em `Testing`.
3. Adicione seu Gmail em `Test users`.
4. Crie credencial `ID do cliente OAuth` (tipo `Aplicativo da Web`).
5. Redirect URIs:
   - `http://localhost:3000/auth/google/callback`
   - `https://SEUAPP.up.railway.app/auth/google/callback`
6. Ative `Gmail API` em `APIs e servicos` -> `Biblioteca`.

## Rodar local

Backend:

```bash
cd backend
npm i
npm run dev
```

Frontend:
- Sirva `frontend/` com Live Server.
- Confirme que a origem bate com `FRONTEND_ORIGIN`.
- `frontend/config.js` ja usa fallback local:

```js
window.API_BASE_URL = "http://localhost:3000";
```

## Self-check rapido

No backend:

```bash
npm run check
```

Esse comando:
- reporta env ausente (sem exigir credenciais reais),
- valida `GET /health`,
- valida `GET /debug/env` em dev,
- valida `GET /debug/pdf` em dev (teste Puppeteer sem Gmail real).

## Deploy Railway (Docker)

1. Crie projeto no Railway a partir do repo.
2. Configure root directory como `backend`.
3. Defina env vars no Railway:
   - `NODE_ENV=production`
   - `FRONTEND_ORIGIN=https://SEUUSUARIO.github.io`
   - `GOOGLE_CLIENT_ID=...`
   - `GOOGLE_CLIENT_SECRET=...`
   - `GOOGLE_REDIRECT_URI=https://SEUAPP.up.railway.app/auth/google/callback`
4. Deploy e copie a URL publica do Railway.
5. Atualize a Redirect URI no Google Cloud para bater exatamente com a URL final.

Implementado no backend:
- `process.env.PORT` com fallback `3000`
- CORS simplificado com `origin:true` (sem `credentials`)
- Sessao em memoria via token aleatorio (48 bytes -> 96 chars em hex)

## Deploy GitHub Pages

1. Publique a pasta `frontend/`.
2. Troque `frontend/config.js`:

```js
window.API_BASE_URL = "https://SEUAPP.up.railway.app";
```

3. Commit/push da alteracao.

## Endpoints principais

- `GET /health`
- `GET /auth/google`
- `GET /auth/google/callback`
- `POST /auth/logout`
- `GET /api/me`
- `GET /api/emails?max=10`
- `POST /api/generate-pdf`

Fluxo OAuth:
- Backend redireciona para `/?token=<sessionToken>` apos callback.
- Front salva `token` em `localStorage`.
- Chamadas para `/api/*` e `/auth/logout` enviam `Authorization: Bearer <token>`.

Endpoints de diagnostico (somente `NODE_ENV=development`):
- `GET /debug/env`
- `GET /debug/pdf`

## Erros comuns

- Front retorna `401 Nao autenticado`: token nao foi salvo no `localStorage`.
- Front retorna `401 Sessao invalida`: token expirou ou foi removido do backend.
- CORS falha: `API_BASE_URL` invalido no `frontend/config.js`.
- OAuth falha: Redirect URI divergente, Test user faltando, ou Gmail API nao ativada.
