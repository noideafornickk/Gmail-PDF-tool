const crypto = require("crypto");
const path = require("path");
require("dotenv").config({
  // Forca leitura do backend/.env mesmo se o comando for executado fora da pasta backend.
  path: path.resolve(__dirname, "..", ".env"),
  quiet: true,
});

const cors = require("cors");
const express = require("express");
const {
  GMAIL_SCOPE,
  buildOAuthClient,
  diagnoseGoogleSetup,
  extractBodyHtml,
  getMessageFull,
  getProfile,
  listEmails,
  parseHeaders,
} = require("./gmail");
const { generatePdf } = require("./pdf");

const app = express();

const PORT = Number(process.env.PORT) || 3000;
const NODE_ENV = process.env.NODE_ENV || "development";
const IS_PRODUCTION = NODE_ENV === "production";
const IS_DEVELOPMENT = NODE_ENV === "development";
const FRONTEND_ORIGIN = String(process.env.FRONTEND_ORIGIN || "").trim();
const SESSION_TTL_MS = Math.max(60 * 1000, Number(process.env.SESSION_TTL_MS) || 1000 * 60 * 60 * 24);
const SESSION_CLEANUP_INTERVAL_MS = Math.max(
  60 * 1000,
  Number(process.env.SESSION_CLEANUP_INTERVAL_MS) || 1000 * 60 * 30
);

const REQUIRED_ENV_VARS = [
  "GOOGLE_CLIENT_ID",
  "GOOGLE_CLIENT_SECRET",
  "GOOGLE_REDIRECT_URI",
  "FRONTEND_ORIGIN",
];

const sessionStore = new Map();

function normalizeOrigin(origin) {
  return String(origin || "").trim().replace(/\/$/, "");
}

function listMissingEnv(requiredVars) {
  return requiredVars.filter((envName) => !process.env[envName]);
}

function getBearerToken(req) {
  const authHeader = req.headers.authorization;

  if (!authHeader?.startsWith("Bearer ")) {
    return "";
  }

  return authHeader.slice("Bearer ".length).trim();
}

function isSessionExpired(session) {
  if (!session?.createdAt) {
    return true;
  }

  return Date.now() - session.createdAt > SESSION_TTL_MS;
}

function cleanupExpiredSessions() {
  for (const [token, session] of sessionStore.entries()) {
    if (isSessionExpired(session)) {
      sessionStore.delete(token);
    }
  }
}

const cleanupTimer = setInterval(cleanupExpiredSessions, SESSION_CLEANUP_INTERVAL_MS);
if (typeof cleanupTimer.unref === "function") {
  cleanupTimer.unref();
}

const normalizedFrontendOrigin = normalizeOrigin(FRONTEND_ORIGIN);
const hasValidFrontendOrigin = /^https?:\/\//i.test(normalizedFrontendOrigin);
const startupMissingEnv = listMissingEnv(REQUIRED_ENV_VARS);

if (startupMissingEnv.length > 0) {
  // Mantem o boot vivo para endpoints de diagnostico, mas avisa claramente a causa.
  console.error(`ENV ERROR - missing vars: [${startupMissingEnv.join(", ")}]`);
}

if (!hasValidFrontendOrigin) {
  console.warn("ENV WARNING - FRONTEND_ORIGIN invalido (use http://... ou https://...).");
}

function listConfigIssues(requiredVars) {
  const missing = listMissingEnv(requiredVars);

  if (requiredVars.includes("FRONTEND_ORIGIN") && !hasValidFrontendOrigin) {
    // Reporta FRONTEND_ORIGIN como issue funcional, mesmo quando string existe.
    missing.push("FRONTEND_ORIGIN (deve iniciar com http:// ou https://)");
  }

  return missing;
}

function respondMissingConfig(res, missing) {
  return res.status(500).json({
    error: "Config ausente no servidor",
    missing,
  });
}

function sanitizeFilename(filename) {
  const sanitized = String(filename || "email")
    .replace(/[\/\\:*?"<>|]/g, " ")
    .replace(/\s+/g, " ")
    .trim();

  if (!sanitized) {
    return "email";
  }

  return sanitized.slice(0, 120);
}

function isReconnectError(error) {
  const status =
    error?.response?.status ||
    error?.code ||
    error?.status ||
    error?.cause?.response?.status;

  if (status === 401) {
    return true;
  }

  const rawMessage = [
    error?.message,
    error?.response?.data?.error_description,
    error?.response?.data?.error?.message,
  ]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();

  return /invalid_grant|invalid credentials|token has been expired|login required|unauthorized/.test(
    rawMessage
  );
}

function logError(label, error) {
  // Loga stack para facilitar suporte sem expor tokens.
  console.error(label, {
    message: error?.message,
    status: error?.response?.status || error?.status || null,
    stack: error?.stack || null,
  });
}

function respondGoogleDiagnosis(res, error) {
  const diagnosis = diagnoseGoogleSetup(error);

  if (!diagnosis) {
    return false;
  }

  res.status(diagnosis.status).json({
    error: diagnosis.error,
    hint: diagnosis.hint,
  });
  return true;
}

app.use(
  cors({
    origin: true,
  })
);

app.use(express.json());

if (IS_DEVELOPMENT) {
  app.use((req, _res, next) => {
    if (req.path.startsWith("/api")) {
      const hasBearer = req.headers.authorization?.startsWith("Bearer ");

      if (!hasBearer) {
        console.warn(`DEV AUTH WARNING - Authorization Bearer ausente em ${req.method} ${req.path}`);
      }
    }

    return next();
  });
}

function requireApiConfig(req, res, next) {
  const missing = listConfigIssues(REQUIRED_ENV_VARS);

  if (missing.length > 0) {
    return respondMissingConfig(res, missing);
  }

  return next();
}

function requireAuth(req, res, next) {
  const authHeader = req.headers.authorization;

  if (!authHeader?.startsWith("Bearer ")) {
    return res.status(401).json({ error: "Nao autenticado" });
  }

  const token = authHeader.replace("Bearer ", "").trim();

  if (token.length < 96) {
    return res.status(401).json({ error: "Sessao invalida" });
  }

  const session = sessionStore.get(token);

  if (!session || isSessionExpired(session)) {
    sessionStore.delete(token);
    return res.status(401).json({ error: "Sessao invalida" });
  }

  req.tokens = session.tokens;
  return next();
}

app.get("/health", (_req, res) => {
  res.send("ok");
});

if (IS_DEVELOPMENT) {
  app.get("/debug/env", (_req, res) => {
    // Endpoint de diagnostico local para descobrir config faltante sem derrubar app.
    const missing = listConfigIssues(REQUIRED_ENV_VARS);

    return res.json({
      ok: missing.length === 0,
      missing,
      values: {
        GOOGLE_REDIRECT_URI: process.env.GOOGLE_REDIRECT_URI || "",
        FRONTEND_ORIGIN: FRONTEND_ORIGIN || "",
        NODE_ENV,
      },
    });
  });

  app.get("/debug/pdf", async (_req, res, next) => {
    try {
      // PDF fake para testar Chromium/Puppeteer sem depender de Gmail real.
      const pdfBuffer = await generatePdf({
        subject: "Debug PDF",
        from: "debug@example.com",
        to: "user@example.com",
        date: new Date().toISOString(),
        bodyHtml: "<p>Se este PDF abriu, o Puppeteer esta ok neste ambiente.</p>",
      });

      res.setHeader("Content-Type", "application/pdf");
      res.setHeader("Content-Disposition", 'attachment; filename="debug-pdf.pdf"');
      return res.send(pdfBuffer);
    } catch (error) {
      logError("DEBUG PDF ERROR", error);
      return next(error);
    }
  });
}

app.get("/auth/google", (_req, res) => {
  const missing = listConfigIssues(REQUIRED_ENV_VARS);

  // Log explicito para evitar 500 sem contexto no inicio do OAuth.
  console.log("AUTH ENV CHECK", {
    hasClientId: Boolean(process.env.GOOGLE_CLIENT_ID),
    hasClientSecret: Boolean(process.env.GOOGLE_CLIENT_SECRET),
    redirectUri: process.env.GOOGLE_REDIRECT_URI || "",
    frontendOrigin: FRONTEND_ORIGIN || "",
  });

  if (missing.length > 0) {
    return respondMissingConfig(res, missing);
  }

  try {
    const oauthClient = buildOAuthClient();
    const url = oauthClient.generateAuthUrl({
      access_type: "offline",
      prompt: "consent",
      include_granted_scopes: true,
      scope: [GMAIL_SCOPE],
    });

    return res.redirect(url);
  } catch (error) {
    logError("AUTH GOOGLE ERROR", error);

    if (respondGoogleDiagnosis(res, error)) {
      return undefined;
    }

    return res.status(500).json({
      error: "Falha ao iniciar OAuth.",
      detail: IS_PRODUCTION ? undefined : error.message,
    });
  }
});

app.get("/auth/google/callback", async (req, res, next) => {
  const missing = listConfigIssues(REQUIRED_ENV_VARS);

  if (missing.length > 0) {
    return respondMissingConfig(res, missing);
  }

  const code = req.query.code;

  if (!code || typeof code !== "string") {
    return res.status(400).json({ error: "Code OAuth ausente." });
  }

  try {
    const oauthClient = buildOAuthClient();
    let tokens;

    try {
      const tokenResponse = await oauthClient.getToken(code);
      tokens = tokenResponse.tokens;
    } catch (oauthError) {
      // Mantem retorno amigavel para erros frequentes de setup OAuth.
      logError("AUTH CALLBACK TOKEN ERROR", oauthError);
      return res.status(500).json({
        error: "Falha no OAuth",
        hint: "Verifique Redirect URI, Test Users, Gmail API ativada",
      });
    }

    // 48 bytes hex -> token com 96 caracteres.
    const sessionToken = crypto.randomBytes(48).toString("hex");
    sessionStore.set(sessionToken, {
      tokens,
      createdAt: Date.now(),
    });

    return res.redirect(`${FRONTEND_ORIGIN}/Gmail-PDF-tool/?token=${sessionToken}`);
  } catch (error) {
    logError("AUTH CALLBACK ERROR", error);

    if (respondGoogleDiagnosis(res, error)) {
      return undefined;
    }

    return next(error);
  }
});

app.post("/auth/logout", (req, res) => {
  const token = getBearerToken(req);

  if (token) {
    sessionStore.delete(token);
  }

  return res.json({ ok: true });
});

app.use("/api", requireApiConfig, requireAuth);

app.get("/api/me", async (req, res, next) => {
  try {
    const profile = await getProfile(req.tokens);
    return res.json({ emailAddress: profile.emailAddress || "" });
  } catch (error) {
    if (respondGoogleDiagnosis(res, error)) {
      return undefined;
    }

    return next(error);
  }
});

app.get("/api/emails", async (req, res, next) => {
  try {
    const max = Math.max(1, Math.min(50, Number(req.query.max) || 10));
    const emails = await listEmails(req.tokens, max);
    return res.json({ emails });
  } catch (error) {
    if (respondGoogleDiagnosis(res, error)) {
      return undefined;
    }

    return next(error);
  }
});

app.post("/api/generate-pdf", async (req, res, next) => {
  try {
    const { messageId, filename } = req.body || {};

    if (!messageId || typeof messageId !== "string") {
      return res.status(400).json({ error: "messageId e obrigatorio." });
    }

    const fullMessage = await getMessageFull(req.tokens, messageId);
    const headers = parseHeaders(fullMessage.payload || {});
    const bodyHtml = extractBodyHtml(fullMessage.payload || {});

    const pdfBuffer = await generatePdf({
      subject: headers.subject,
      from: headers.from,
      to: headers.to,
      date: headers.date,
      bodyHtml,
    });

    const safeFilename = sanitizeFilename(filename || headers.subject || `email-${messageId}`);
    const downloadFilename = `${safeFilename}.pdf`;

    res.setHeader("Content-Type", "application/pdf");
    res.setHeader("Content-Disposition", `attachment; filename="${downloadFilename}"`);
    return res.send(pdfBuffer);
  } catch (error) {
    if (respondGoogleDiagnosis(res, error)) {
      return undefined;
    }

    return next(error);
  }
});

app.use((error, req, res, _next) => {
  logError(`REQUEST ERROR - ${req.method} ${req.path}`, error);

  if (isReconnectError(error)) {
    return res.status(401).json({ error: "Reconecte" });
  }

  if (respondGoogleDiagnosis(res, error)) {
    return undefined;
  }

  const status =
    error?.response?.status ||
    error?.status ||
    (typeof error?.code === "number" ? error.code : 500);
  const safeStatus = status >= 400 && status < 600 ? status : 500;

  const payload = {
    // Evita "erro interno" sem pista; sempre devolve texto com hint operacional.
    error: error?.message || "Falha interna no servidor.",
    hint: safeStatus === 500 ? "Consulte os logs do backend para stack trace." : undefined,
    detail: !IS_PRODUCTION && safeStatus === 500 ? error?.stack : undefined,
  };

  if (!payload.hint) {
    delete payload.hint;
  }

  if (!payload.detail) {
    delete payload.detail;
  }

  return res.status(safeStatus).json(payload);
});

app.listen(PORT, () => {
  console.log(`Backend iniciado na porta ${PORT}`);
});
