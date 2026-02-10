const http = require("http");
const path = require("path");
const { spawn } = require("child_process");

require("dotenv").config({
  // Usa o backend/.env de forma deterministica para o check local.
  path: path.resolve(__dirname, "..", ".env"),
  quiet: true,
});

const REQUIRED_ENV_VARS = [
  "GOOGLE_CLIENT_ID",
  "GOOGLE_CLIENT_SECRET",
  "GOOGLE_REDIRECT_URI",
  "FRONTEND_ORIGIN",
];

const CHECK_NODE_ENV = process.env.NODE_ENV || "development";
const CHECK_PORT = Number(process.env.SELFCHECK_PORT) || 3010;

function listMissingEnv(requiredVars) {
  return requiredVars.filter((envName) => !process.env[envName]);
}

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function request(pathname) {
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        hostname: "127.0.0.1",
        port: CHECK_PORT,
        path: pathname,
        method: "GET",
      },
      (res) => {
        const chunks = [];
        res.on("data", (chunk) => chunks.push(chunk));
        res.on("end", () => {
          resolve({
            status: res.statusCode || 0,
            headers: res.headers,
            body: Buffer.concat(chunks),
          });
        });
      }
    );

    req.on("error", reject);
    req.end();
  });
}

async function waitForHealth(timeoutMs = 15000) {
  const startedAt = Date.now();

  while (Date.now() - startedAt < timeoutMs) {
    try {
      const response = await request("/health");

      if (response.status === 200) {
        return;
      }
    } catch (_error) {
      // Ignora tentativas iniciais enquanto o servidor sobe.
    }

    await wait(250);
  }

  throw new Error("Timeout aguardando /health.");
}

async function stopChild(child) {
  if (!child || child.killed) {
    return;
  }

  child.kill("SIGTERM");
  await wait(600);

  if (!child.killed) {
    // Fallback para evitar processo zumbi em ambiente local.
    child.kill("SIGKILL");
  }
}

async function run() {
  const missing = listMissingEnv(REQUIRED_ENV_VARS);

  if (missing.length > 0) {
    console.log(`[check] ENV missing (nao bloqueante): ${missing.join(", ")}`);
  } else {
    console.log("[check] ENV ok");
  }

  const child = spawn(process.execPath, [path.resolve(__dirname, "index.js")], {
    env: {
      ...process.env,
      NODE_ENV: CHECK_NODE_ENV,
      PORT: String(CHECK_PORT),
    },
    stdio: ["ignore", "pipe", "pipe"],
  });

  let stderrText = "";
  child.stderr.on("data", (chunk) => {
    stderrText += chunk.toString();
  });

  try {
    await waitForHealth();
    const health = await request("/health");
    const healthBody = health.body.toString("utf8").trim();

    if (health.status !== 200 || healthBody !== "ok") {
      throw new Error(`Falha em /health: status=${health.status}, body="${healthBody}"`);
    }

    console.log("[check] /health ok");

    if (CHECK_NODE_ENV === "development") {
      // Em dev, valida endpoint de diagnostico de env.
      const envDebug = await request("/debug/env");
      const envDebugBody = envDebug.body.toString("utf8");

      if (envDebug.status !== 200) {
        throw new Error(`Falha em /debug/env: status=${envDebug.status}`);
      }

      const envJson = JSON.parse(envDebugBody);
      const envMissing = Array.isArray(envJson.missing) ? envJson.missing : [];
      console.log(`[check] /debug/env ok (missing reportado: ${envMissing.length})`);

      // Em dev, valida o caminho Puppeteer sem depender da API Gmail.
      const pdfDebug = await request("/debug/pdf");
      const contentType = String(pdfDebug.headers["content-type"] || "");

      if (pdfDebug.status !== 200) {
        throw new Error(`Falha em /debug/pdf: status=${pdfDebug.status}`);
      }

      if (!contentType.includes("application/pdf")) {
        throw new Error(`Content-Type inesperado em /debug/pdf: ${contentType}`);
      }

      if (pdfDebug.body.length === 0) {
        throw new Error("PDF vazio em /debug/pdf.");
      }

      console.log(`[check] /debug/pdf ok (${pdfDebug.body.length} bytes)`);
    } else {
      console.log("[check] /debug/env e /debug/pdf pulados (NODE_ENV!=development)");
    }
  } finally {
    await stopChild(child);
  }

  if (stderrText.trim()) {
    // Mostra stderr ao final para facilitar diagnostico sem esconder falhas de boot.
    console.log("[check] stderr capturado:");
    console.log(stderrText.trim());
  }
}

run()
  .then(() => {
    console.log("[check] concluido com sucesso");
    process.exit(0);
  })
  .catch((error) => {
    console.error(`[check] falhou: ${error.message}`);
    process.exit(1);
  });
