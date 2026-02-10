const puppeteer = require("puppeteer");

function escapeHtml(value = "") {
  return String(value || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/\"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function stripScriptTags(html) {
  return String(html || "").replace(/<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>/gi, "");
}

async function generatePdf({ subject, from, to, date, bodyHtml }) {
  const containerArgs = ["--no-sandbox", "--disable-setuid-sandbox", "--disable-dev-shm-usage"];
  // Esses flags sao obrigatorios no container (Railway/Docker) para Chromium iniciar sem travar.
  const shouldUseContainerArgs = process.platform === "linux";

  const launchOptions = {
    headless: "new",
    args: shouldUseContainerArgs ? containerArgs : [],
  };

  if (process.env.PUPPETEER_EXECUTABLE_PATH) {
    launchOptions.executablePath = process.env.PUPPETEER_EXECUTABLE_PATH;
  }

  const browser = await puppeteer.launch(launchOptions);

  try {
    const page = await browser.newPage();

    const cleanBodyHtml = stripScriptTags(bodyHtml);
    const now = new Date().toLocaleString("pt-BR");

    let html = `
      <style>
        body {
          margin: 0;
          font-family: "Segoe UI", Tahoma, sans-serif;
          color: #1d2a38;
          background: #f3f6fa;
        }
        .page {
          max-width: 820px;
          margin: 0 auto;
          background: #ffffff;
          padding: 24px 28px 30px;
          border: 1px solid #d7deea;
        }
        .title {
          margin: 0;
          font-size: 24px;
          color: #0f2d59;
          line-height: 1.3;
          word-break: break-word;
        }
        .meta {
          margin-top: 14px;
          display: grid;
          gap: 6px;
          font-size: 13px;
          color: #364a63;
        }
        .meta strong {
          color: #112d4e;
        }
        hr {
          border: 0;
          border-top: 1px solid #d7deea;
          margin: 18px 0 20px;
        }
        .content {
          font-size: 14px;
          line-height: 1.55;
          color: #1d2a38;
          word-wrap: break-word;
        }
        .content img {
          max-width: 100%;
        }
        .footer {
          margin-top: 24px;
          font-size: 12px;
          color: #596c84;
        }
      </style>
      <div class="page">
        <h1 class="title">${escapeHtml(subject || "(Sem assunto)")}</h1>
        <div class="meta">
          <div><strong>De:</strong> ${escapeHtml(from || "")}</div>
          <div><strong>Para:</strong> ${escapeHtml(to || "")}</div>
          <div><strong>Data:</strong> ${escapeHtml(date || "")}</div>
        </div>
        <hr>
        <div class="content">${cleanBodyHtml || "<p>(Sem conteudo)</p>"}</div>
        <div class="footer">Gerado em ${escapeHtml(now)}</div>
      </div>
    `;

    html = `
      <!DOCTYPE html>
      <html>
        <head>
          <meta charset="UTF-8">
        </head>
        <body>
          ${html}
        </body>
      </html>
    `;

    try {
      await page.setContent(html, {
        waitUntil: "networkidle0",
        timeout: 120000,
      });
    } catch (error) {
      if (!/Navigation timeout/i.test(String(error?.message || ""))) {
        throw error;
      }

      // Fallback para ambiente instavel: alguns runtimes nao entram em networkidle0 de forma consistente.
      await page.setContent(html, {
        waitUntil: "domcontentloaded",
        timeout: 120000,
      });
    }

    await page.evaluate(() => document.fonts.ready);
    await new Promise((resolve) => setTimeout(resolve, 500));

    const pdfBuffer = await page.pdf({
      format: "A4",
      printBackground: true,
    });

    return Buffer.from(pdfBuffer);
  } finally {
    // Garante fechamento do Chromium mesmo quando ocorre excecao no meio da renderizacao.
    await browser.close();
  }
}

module.exports = {
  generatePdf,
};
