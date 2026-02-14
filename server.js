const http = require('http');
const fs = require('fs');
const path = require('path');
const { URL } = require('url');
const { analyzeHtml, normalizeUrl } = require('./src/analyzer');

const PORT = Number(process.env.PORT || 3000);
const PUBLIC_DIR = path.join(__dirname, 'public');
const USER_AGENT = 'OnPageSEOAnalyzer/1.0 (+https://localhost)';

const MIME_TYPES = {
  '.css': 'text/css; charset=utf-8',
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.txt': 'text/plain; charset=utf-8'
};

function sendJson(res, statusCode, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(statusCode, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body)
  });
  res.end(body);
}

function sendText(res, statusCode, text, contentType) {
  res.writeHead(statusCode, {
    'content-type': contentType,
    'content-length': Buffer.byteLength(text)
  });
  res.end(text);
}

function isBlockedHost(hostname) {
  const host = hostname.toLowerCase();
  if (host === 'localhost' || host === '0.0.0.0' || host === '::1') {
    return true;
  }
  if (/^127\./.test(host)) {
    return true;
  }
  if (/^10\./.test(host)) {
    return true;
  }
  if (/^192\.168\./.test(host)) {
    return true;
  }
  if (/^172\.(1[6-9]|2\d|3[0-1])\./.test(host)) {
    return true;
  }
  if (host.endsWith('.local')) {
    return true;
  }
  return false;
}

async function fetchHtml(url) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 12000);

  try {
    const response = await fetch(url, {
      headers: {
        accept: 'text/html,application/xhtml+xml',
        'user-agent': USER_AGENT
      },
      redirect: 'follow',
      signal: controller.signal
    });

    const contentType = String(response.headers.get('content-type') || '').toLowerCase();
    if (!response.ok) {
      throw new Error(`Remote server responded with status ${response.status}`);
    }
    if (!contentType.includes('text/html')) {
      throw new Error(`URL did not return HTML. Received content-type: ${contentType || 'unknown'}`);
    }

    const html = await response.text();
    return {
      html,
      finalUrl: response.url || url
    };
  } catch (error) {
    if (error.name === 'AbortError') {
      throw new Error('Request timed out after 12 seconds');
    }
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

function safeStaticPath(urlPathname) {
  const decoded = decodeURIComponent(urlPathname);
  const relativePath = decoded === '/' ? 'index.html' : decoded.replace(/^\/+/, '');
  const fullPath = path.normalize(path.join(PUBLIC_DIR, relativePath));
  if (!fullPath.startsWith(PUBLIC_DIR)) {
    return null;
  }
  return fullPath;
}

async function handleAnalyze(_req, res, requestUrl) {
  const target = requestUrl.searchParams.get('url');
  if (!target) {
    sendJson(res, 400, { ok: false, error: 'Missing required query parameter: url' });
    return;
  }

  let normalized;
  try {
    normalized = normalizeUrl(target);
  } catch (error) {
    sendJson(res, 400, { ok: false, error: error.message });
    return;
  }

  const parsed = new URL(normalized);
  if (isBlockedHost(parsed.hostname)) {
    sendJson(res, 403, {
      ok: false,
      error: 'Target host is blocked for safety reasons'
    });
    return;
  }

  try {
    const { html, finalUrl } = await fetchHtml(normalized);
    const report = analyzeHtml(finalUrl, html);

    sendJson(res, 200, {
      ok: true,
      url: finalUrl,
      fetchedAt: new Date().toISOString(),
      report
    });
  } catch (error) {
    sendJson(res, 502, {
      ok: false,
      error: error.message || 'Unable to fetch and analyze the target URL'
    });
  }
}

const server = http.createServer(async (req, res) => {
  const method = String(req.method || 'GET').toUpperCase();
  const requestUrl = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);

  if (requestUrl.pathname === '/api/health') {
    sendJson(res, 200, { ok: true, status: 'up' });
    return;
  }

  if (requestUrl.pathname === '/api/analyze') {
    if (method !== 'GET') {
      sendJson(res, 405, { ok: false, error: 'Method not allowed' });
      return;
    }
    await handleAnalyze(req, res, requestUrl);
    return;
  }

  if (method !== 'GET') {
    sendJson(res, 405, { ok: false, error: 'Method not allowed' });
    return;
  }

  const filePath = safeStaticPath(requestUrl.pathname);
  if (!filePath) {
    sendJson(res, 403, { ok: false, error: 'Forbidden path' });
    return;
  }

  fs.readFile(filePath, (error, data) => {
    if (error) {
      if (error.code === 'ENOENT') {
        sendText(res, 404, 'Not Found', 'text/plain; charset=utf-8');
        return;
      }
      sendText(res, 500, 'Internal Server Error', 'text/plain; charset=utf-8');
      return;
    }

    const ext = path.extname(filePath).toLowerCase();
    const contentType = MIME_TYPES[ext] || 'application/octet-stream';
    res.writeHead(200, {
      'content-type': contentType,
      'content-length': data.length
    });
    res.end(data);
  });
});

server.listen(PORT, () => {
  console.log(`On-Page SEO Analyzer is running at http://localhost:${PORT}`);
});
