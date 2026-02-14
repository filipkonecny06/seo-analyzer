const form = document.getElementById('analyzer-form');
const urlInput = document.getElementById('url-input');
const analyzeBtn = document.getElementById('analyze-btn');
const statusEl = document.getElementById('status');

const resultEl = document.getElementById('result');
const scoreValueEl = document.getElementById('score-value');
const scoreMetaEl = document.getElementById('score-meta');
const recommendationsEl = document.getElementById('recommendations');
const metricsEl = document.getElementById('metrics');
const keywordsEl = document.getElementById('keywords');
const checksBodyEl = document.getElementById('checks-body');

function escapeHtml(value) {
  return String(value || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function setStatus(message, isError = false) {
  statusEl.textContent = message;
  statusEl.style.color = isError ? '#b91c1c' : '#5a6a84';
}

function setLoading(loading) {
  analyzeBtn.disabled = loading;
  analyzeBtn.textContent = loading ? 'Analyzing...' : 'Analyze';
}

function scoreClass(score) {
  if (score >= 80) return 'score-good';
  if (score >= 60) return 'score-warn';
  return 'score-bad';
}

function renderMetrics(report) {
  const metrics = [
    ['Title length', `${report.metadata.titleLength} chars`],
    ['Meta description', `${report.metadata.descriptionLength} chars`],
    ['Word count', report.content.words.count],
    ['H1 count', report.content.headings.counts.h1],
    ['Images missing alt', report.content.images.missingAlt],
    ['Internal links', report.content.links.internal],
    ['External links', report.content.links.external],
    ['Structured data blocks', report.content.structuredDataCount],
    ['Lang', report.metadata.lang || 'Missing']
  ];

  metricsEl.innerHTML = metrics
    .map(
      ([label, value]) =>
        `<div class="metric"><strong>${escapeHtml(label)}</strong><span>${escapeHtml(value)}</span></div>`
    )
    .join('');
}

function renderRecommendations(report) {
  const items = report.recommendations.length
    ? report.recommendations
    : ['No critical issues detected. Focus on content quality and backlinks for further gains.'];

  recommendationsEl.innerHTML = items.map((item) => `<li>${escapeHtml(item)}</li>`).join('');
}

function renderKeywords(report) {
  if (!report.content.words.topKeywords.length) {
    keywordsEl.innerHTML = '<span class="muted">No meaningful keyword pattern detected.</span>';
    return;
  }

  keywordsEl.innerHTML = report.content.words.topKeywords
    .map((entry) => `<span class="chip">${escapeHtml(entry.term)} (${entry.count})</span>`)
    .join('');
}

function renderChecks(report) {
  checksBodyEl.innerHTML = report.checks
    .map((check) => {
      return `
        <tr>
          <td>${escapeHtml(check.label)}</td>
          <td>
            <span class="status-pill status-${escapeHtml(check.status)}">${escapeHtml(check.status)}</span>
          </td>
          <td>${escapeHtml(`${check.points}/${check.maxPoints}`)}</td>
          <td>${escapeHtml(check.detail)}</td>
        </tr>
      `;
    })
    .join('');
}

function renderReport(payload) {
  const report = payload.report;

  resultEl.classList.remove('hidden');

  scoreValueEl.className = `score-value ${scoreClass(report.score)}`;
  scoreValueEl.textContent = `${report.score}/100 (${report.grade})`;
  scoreMetaEl.textContent = `Analyzed URL: ${payload.url}`;

  renderMetrics(report);
  renderRecommendations(report);
  renderKeywords(report);
  renderChecks(report);
}

async function runAnalysis(rawUrl) {
  const response = await fetch(`/api/analyze?url=${encodeURIComponent(rawUrl)}`);
  const payload = await response.json();

  if (!response.ok || !payload.ok) {
    throw new Error(payload.error || 'Analysis failed');
  }

  return payload;
}

form.addEventListener('submit', async (event) => {
  event.preventDefault();

  const rawUrl = urlInput.value.trim();
  if (!rawUrl) {
    setStatus('Please enter a URL to analyze.', true);
    return;
  }

  setLoading(true);
  setStatus('Fetching page and running SEO checks...');

  try {
    const payload = await runAnalysis(rawUrl);
    renderReport(payload);
    setStatus('Analysis complete.');
  } catch (error) {
    setStatus(error.message || 'Unable to analyze this URL.', true);
  } finally {
    setLoading(false);
  }
});
