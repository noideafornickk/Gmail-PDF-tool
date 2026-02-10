const { google } = require("googleapis");

const GMAIL_SCOPE = "https://www.googleapis.com/auth/gmail.readonly";

function getRequiredEnv(name) {
  const value = process.env[name];

  if (!value) {
    throw new Error(`Variavel de ambiente obrigatoria ausente: ${name}`);
  }

  return value;
}

function buildOAuthClient() {
  const clientId = getRequiredEnv("GOOGLE_CLIENT_ID");
  const clientSecret = getRequiredEnv("GOOGLE_CLIENT_SECRET");
  const redirectUri = getRequiredEnv("GOOGLE_REDIRECT_URI");

  return new google.auth.OAuth2(clientId, clientSecret, redirectUri);
}

function getGmail(tokens) {
  const auth = buildOAuthClient();
  auth.setCredentials(tokens);

  return google.gmail({
    version: "v1",
    auth,
  });
}

async function getProfile(tokens) {
  const gmail = getGmail(tokens);
  const { data } = await gmail.users.getProfile({ userId: "me" });
  return data;
}

function parseHeaders(payload = {}) {
  const rawHeaders = Array.isArray(payload.headers) ? payload.headers : [];
  const normalized = new Map();

  for (const header of rawHeaders) {
    if (!header || !header.name) {
      continue;
    }

    normalized.set(String(header.name).toLowerCase(), header.value || "");
  }

  return {
    subject: normalized.get("subject") || "(Sem assunto)",
    from: normalized.get("from") || "",
    to: normalized.get("to") || "",
    date: normalized.get("date") || "",
  };
}

function base64urlDecode(str = "") {
  if (!str) {
    return "";
  }

  const normalized = str.replace(/-/g, "+").replace(/_/g, "/");
  const missingPadding = (4 - (normalized.length % 4)) % 4;
  const padded = normalized + "=".repeat(missingPadding);

  return Buffer.from(padded, "base64").toString("utf8");
}

function escapeHtml(text) {
  return String(text || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function extractBodyHtml(payload = {}) {
  let htmlBody = "";
  let textBody = "";

  const visitPart = (part) => {
    if (!part) {
      return;
    }

    const mimeType = String(part.mimeType || "").toLowerCase();
    const bodyData = part.body && part.body.data ? part.body.data : "";

    if (!htmlBody && mimeType === "text/html" && bodyData) {
      htmlBody = base64urlDecode(bodyData);
    } else if (!textBody && mimeType === "text/plain" && bodyData) {
      textBody = base64urlDecode(bodyData);
    }

    if (Array.isArray(part.parts)) {
      for (const child of part.parts) {
        visitPart(child);
      }
    }
  };

  visitPart(payload);

  if (htmlBody) {
    return htmlBody;
  }

  if (textBody) {
    return escapeHtml(textBody).replace(/\r?\n/g, "<br>");
  }

  return "<p>(Sem conteudo exibivel para este e-mail)</p>";
}

async function listEmails(tokens, max = 10) {
  const gmail = getGmail(tokens);
  const safeMax = Math.max(1, Math.min(50, Number(max) || 10));

  const listResponse = await gmail.users.messages.list({
    userId: "me",
    maxResults: safeMax,
  });

  const messages = Array.isArray(listResponse.data.messages) ? listResponse.data.messages : [];

  const details = await Promise.all(
    messages.map(async (message) => {
      const metaResponse = await gmail.users.messages.get({
        userId: "me",
        id: message.id,
        format: "metadata",
        metadataHeaders: ["Subject", "From", "Date"],
      });

      const headers = parseHeaders(metaResponse.data.payload || {});

      return {
        id: metaResponse.data.id,
        threadId: metaResponse.data.threadId,
        subject: headers.subject,
        from: headers.from,
        date: headers.date,
        snippet: metaResponse.data.snippet || "",
      };
    })
  );

  return details;
}

async function getMessageFull(tokens, id) {
  const gmail = getGmail(tokens);
  const { data } = await gmail.users.messages.get({
    userId: "me",
    id,
    format: "full",
  });

  return data;
}

function diagnoseGoogleSetup(error) {
  const status = error?.response?.status || error?.status || 500;
  const combined = [
    error?.message,
    error?.response?.data?.error_description,
    error?.response?.data?.error?.message,
    typeof error?.response?.data === "string" ? error.response.data : "",
  ]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();

  // Explica falhas comuns de projeto Google para reduzir tentativa e erro.
  if (/api has not been used|access_not_configured|gmail api/.test(combined)) {
    return {
      status: 403,
      error: "Gmail API nao ativada no projeto Google.",
      hint: "Ative Gmail API em APIs e servicos > Biblioteca e aguarde propagacao.",
    };
  }

  // Explica casos de permissoes OAuth (test users, consent, escopo).
  if (/access_denied|insufficient permissions|insufficient authentication scopes|forbidden/.test(combined)) {
    return {
      status: status >= 400 && status < 600 ? status : 403,
      error: "Permissao insuficiente para acessar Gmail.",
      hint: "Confira Test users, tela de consentimento e escopo gmail.readonly.",
    };
  }

  // Explica erro de callback OAuth mal configurado.
  if (/redirect_uri_mismatch/.test(combined)) {
    return {
      status: 400,
      error: "Redirect URI invalida para OAuth.",
      hint: "No Google Cloud, use exatamente a URI de callback configurada no backend.",
    };
  }

  return null;
}

module.exports = {
  GMAIL_SCOPE,
  base64urlDecode,
  buildOAuthClient,
  diagnoseGoogleSetup,
  extractBodyHtml,
  getGmail,
  getMessageFull,
  getProfile,
  listEmails,
  parseHeaders,
};
