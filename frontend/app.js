const connectBtn = document.getElementById("connectBtn");
const listBtn = document.getElementById("listBtn");
const logoutBtn = document.getElementById("logoutBtn");
const statusBadge = document.getElementById("statusBadge");
const statusText = document.getElementById("statusText");
const runtimeInfoEl = document.getElementById("runtimeInfo");
const messageEl = document.getElementById("message");
const emailsEl = document.getElementById("emails");

const rawApiBaseUrl = typeof window.API_BASE_URL === "string" ? window.API_BASE_URL.trim() : "";
const isLikelyDev = ["localhost", "127.0.0.1"].includes(window.location.hostname);
const AUTH_TOKEN_STORAGE_KEY = "auth_token";

function normalizeApiBaseUrl(rawUrl) {
  if (!rawUrl) {
    return {
      ok: false,
      error: "API_BASE_URL vazio em frontend/config.js.",
    };
  }

  try {
    const parsedUrl = new URL(rawUrl);

    if (!["http:", "https:"].includes(parsedUrl.protocol)) {
      return {
        ok: false,
        error: "API_BASE_URL invalido: use http:// ou https://.",
      };
    }

    // Usa apenas o origin para evitar problemas com barra final ou path extra.
    return {
      ok: true,
      value: parsedUrl.origin,
    };
  } catch (_error) {
    return {
      ok: false,
      error: "API_BASE_URL malformado em frontend/config.js.",
    };
  }
}

const apiValidation = normalizeApiBaseUrl(rawApiBaseUrl);
const API = apiValidation.ok ? apiValidation.value : "";

const state = {
  connected: false,
  emailAddress: "",
};

function getStoredAuthToken() {
  return localStorage.getItem(AUTH_TOKEN_STORAGE_KEY) || "";
}

function storeAuthToken(token) {
  if (!token) {
    return;
  }

  localStorage.setItem(AUTH_TOKEN_STORAGE_KEY, token);
}

function clearAuthToken() {
  localStorage.removeItem(AUTH_TOKEN_STORAGE_KEY);
}

function consumeTokenFromUrl() {
  const urlParams = new URLSearchParams(window.location.search);
  const token = urlParams.get("token");

  if (!token) {
    return false;
  }

  storeAuthToken(token);

  const url = new URL(window.location.href);
  url.searchParams.delete("token");
  window.history.replaceState({}, "", url.toString());
  return true;
}

function authFetch(url, options = {}) {
  const token = getStoredAuthToken();

  return fetch(url, {
    ...options,
    headers: {
      ...(options.headers || {}),
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
  });
}

function setMessage(text, type = "info") {
  messageEl.textContent = text || "";
  messageEl.className = `message ${type}`;
}

function showStatus(msg) {
  const status = document.getElementById("status");
  if (status) {
    status.textContent = msg || "";
  }
}

function setStatus(connected, emailAddress = "") {
  state.connected = connected;
  state.emailAddress = emailAddress;

  statusBadge.textContent = connected ? "Conectado" : "Desconectado";
  statusBadge.className = `status ${connected ? "connected" : "disconnected"}`;
  statusText.textContent = connected
    ? `Conta conectada: ${emailAddress || "email nao identificado"}`
    : "Faca login para comecar.";

  listBtn.disabled = !connected;
  logoutBtn.disabled = !connected;
}

function renderRuntimeInfo() {
  if (!runtimeInfoEl) {
    return;
  }

  // Exibe diagnostico em dev (ou quando API esta invalida) para reduzir erros de CORS/origem.
  if (isLikelyDev || !apiValidation.ok) {
    const apiLabel = apiValidation.ok ? API : `invalido (${apiValidation.error})`;
    runtimeInfoEl.textContent = `API_BASE_URL: ${apiLabel} | Origin atual: ${window.location.origin}`;
    return;
  }

  runtimeInfoEl.textContent = "";
}

function clearEmails() {
  emailsEl.innerHTML = '<p class="empty">Nenhum e-mail carregado.</p>';
}

function escapeHtml(text) {
  return String(text || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function sanitizeFilename(name) {
  const sanitized = String(name || "email")
    .replace(/[\/\\:*?"<>|]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return sanitized ? sanitized.slice(0, 120) : "email";
}

function parseFilenameFromDisposition(contentDisposition) {
  const match = /filename="?(.*?)"?$/i.exec(contentDisposition || "");
  return match && match[1] ? match[1] : "";
}

function assertApiReady() {
  if (!API) {
    throw new Error(apiValidation.error || "API_BASE_URL invalido.");
  }
}

async function apiRequest(path, options = {}) {
  assertApiReady();

  const requestOptions = {
    method: "GET",
    ...options,
    headers: {
      ...(options.headers || {}),
    },
  };

  if (requestOptions.body && typeof requestOptions.body !== "string") {
    requestOptions.headers["Content-Type"] = "application/json";
    requestOptions.body = JSON.stringify(requestOptions.body);
  }

  const response = await authFetch(`${API}${path}`, requestOptions);

  if (!response.ok) {
    let message = `Erro ${response.status}`;
    const contentType = response.headers.get("content-type") || "";

    try {
      if (contentType.includes("application/json")) {
        const json = await response.json();
        message = json.error || message;
      } else {
        const text = await response.text();
        if (text) {
          message = text;
        }
      }
    } catch (_error) {
      // Mantem fallback de erro quando a resposta nao e JSON valido.
    }

    const error = new Error(message);
    error.status = response.status;
    throw error;
  }

  return response;
}

async function refreshConnection({ silent = false } = {}) {
  try {
    const response = await apiRequest("/api/me");
    const data = await response.json();
    setStatus(true, data.emailAddress || "");

    if (!silent) {
      setMessage("Conta conectada e pronta para uso.", "success");
    }
  } catch (error) {
    if (error.status === 401) {
      clearAuthToken();
    }

    setStatus(false);
    clearEmails();

    if (!silent && error.status !== 401) {
      setMessage(error.message || "Nao foi possivel validar a sessao.", "error");
    }
  }
}

function renderEmails(emails) {
  emailsEl.innerHTML = "";

  if (!Array.isArray(emails) || emails.length === 0) {
    clearEmails();
    return;
  }

  for (const email of emails) {
    const card = document.createElement("article");
    card.className = "email-card";

    const top = document.createElement("div");
    top.className = "email-top";

    const subjectEl = document.createElement("h3");
    subjectEl.className = "email-subject";
    subjectEl.textContent = email.subject || "(Sem assunto)";

    const dateEl = document.createElement("p");
    dateEl.className = "email-date";
    dateEl.textContent = email.date || "Sem data";

    top.appendChild(subjectEl);
    top.appendChild(dateEl);

    const fromEl = document.createElement("p");
    fromEl.className = "email-meta";
    fromEl.innerHTML = `<strong>De:</strong> ${escapeHtml(email.from || "Nao informado")}`;

    const snippetEl = document.createElement("p");
    snippetEl.className = "email-snippet";
    snippetEl.textContent = email.snippet || "(Sem snippet)";

    const downloadBtn = document.createElement("button");
    downloadBtn.textContent = "Gerar PDF";
    downloadBtn.addEventListener("click", (event) => handleGeneratePdf(email, event));

    card.appendChild(top);
    card.appendChild(fromEl);
    card.appendChild(snippetEl);
    card.appendChild(downloadBtn);

    emailsEl.appendChild(card);
  }
}

async function handleListEmails() {
  setMessage("Buscando e-mails...", "info");

  try {
    const response = await apiRequest("/api/emails?max=10");
    const data = await response.json();
    const emails = Array.isArray(data.emails) ? data.emails : [];

    renderEmails(emails);
    setMessage(`${emails.length} e-mail(s) carregado(s).`, "success");
  } catch (error) {
    if (error.status === 401) {
      clearAuthToken();
      setStatus(false);
      clearEmails();
      setMessage("Sessao expirada. Clique em Conectar novamente.", "error");
      return;
    }

    setMessage(error.message || "Nao foi possivel listar os e-mails.", "error");
  }
}

function downloadBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  URL.revokeObjectURL(url);
}

async function handleGeneratePdf(email, event) {
  const button = event?.currentTarget || null;
  const fallbackName = sanitizeFilename(email.subject || `email-${email.id}`);
  if (button) {
    button.disabled = true;
    button.textContent = "Gerando PDF...";
  }

  showStatus("Gerando PDF... isso pode levar alguns segundos.");
  setMessage(`Gerando PDF de "${fallbackName}"...`, "info");

  try {
    const response = await apiRequest("/api/generate-pdf", {
      method: "POST",
      body: {
        messageId: email.id,
        filename: fallbackName,
      },
    });

    const pdfBlob = await response.blob();
    const contentDisposition = response.headers.get("content-disposition") || "";
    const suggestedFile = parseFilenameFromDisposition(contentDisposition);
    const filename = suggestedFile || `${fallbackName}.pdf`;

    downloadBlob(pdfBlob, filename);
    showStatus("PDF gerado com sucesso!");
    setMessage(`PDF "${filename}" gerado com sucesso.`, "success");
  } catch (error) {
    showStatus("Erro ao gerar PDF.");
    if (error.status === 401) {
      clearAuthToken();
      setStatus(false);
      setMessage("Sessao expirada. Reconecte para gerar PDF.", "error");
      return;
    }

    setMessage(error.message || "Erro ao gerar PDF.", "error");
  } finally {
    if (button) {
      button.disabled = false;
      button.textContent = "Gerar PDF";
    }
  }
}

async function handleLogout() {
  let logoutError;

  try {
    await apiRequest("/auth/logout", { method: "POST" });
  } catch (error) {
    logoutError = error;
  } finally {
    clearAuthToken();
    setStatus(false);
    clearEmails();
  }

  if (logoutError) {
    setMessage(logoutError.message || "Erro ao desconectar.", "error");
    return;
  }

  setMessage("Sessao encerrada.", "success");
}

function handleConnect() {
  if (!API) {
    setMessage(apiValidation.error || "API_BASE_URL invalido.", "error");
    return;
  }

  // Fluxo OAuth deve navegar o browser para o backend.
  window.location.href = `${API}/auth/google`;
}

connectBtn.addEventListener("click", handleConnect);
listBtn.addEventListener("click", handleListEmails);
logoutBtn.addEventListener("click", handleLogout);

clearEmails();
renderRuntimeInfo();

(async () => {
  if (!apiValidation.ok) {
    // Evita chamadas quebradas quando a API nao esta configurada.
    connectBtn.disabled = true;
    listBtn.disabled = true;
    logoutBtn.disabled = true;
    setMessage(apiValidation.error, "error");
    return;
  }

  const justConnected = consumeTokenFromUrl();
  await refreshConnection({ silent: true });

  if (justConnected && state.connected) {
    setMessage("Login concluido com sucesso. Agora voce pode listar e-mails.", "success");
  } else if (!state.connected) {
    setMessage("Conecte sua conta para listar e-mails e gerar PDF.", "info");
  }
})();
