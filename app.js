'use strict';

// ── Constants ────────────────────────────────────────────────────────────────

const TROY_OZ_TO_GRAMS = 31.1035;
const CHANGE_DEAD_ZONE = 0.005; // % — avoid showing ±0.00% from float rounding

const GOLD_KARATS = [
  { k: 24, purity: 24 / 24 },
  { k: 21, purity: 21 / 24 },
  { k: 18, purity: 18 / 24 },
];

const SILVER_PURITIES = [
  { k: 999, purity: 0.999 },
  { k: 925, purity: 0.925 },
];

const API = {
  geo:   'https://ipapi.co/json/',
  gold:  'https://api.gold-api.com/price/XAU',
  silver:'https://api.gold-api.com/price/XAG',
  // 170+ currencies, free, no key, updated daily, hosted on jsDelivr CDN
  fx:    () => 'https://cdn.jsdelivr.net/npm/@fawazahmed0/currency-api@latest/v1/currencies/usd.json',
};

const TTL = {
  geo:    7 * 24 * 60 * 60 * 1000,  // 7 days
  prices: 23 * 60 * 60 * 1000,      // 23 hours
  fx:     23 * 60 * 60 * 1000,      // 23 hours
};

const CACHE_KEY = {
  geo:       'pmt_geo',
  gold:      'pmt_prices_gold',
  silver:    'pmt_prices_silver',
  fx:        'pmt_fx2',          // pmt_fx2 avoids stale Frankfurter-format cache
  history:   'pmt_history',
  portfolio: 'pmt_portfolio',
};

// No currency exclusion list needed: the fawazahmed0 API covers 170+ currencies

// ── localStorage cache helpers ───────────────────────────────────────────────

function cacheGet(key) {
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return null;
    const { data, expires } = JSON.parse(raw);
    if (expires && Date.now() > expires) { localStorage.removeItem(key); return null; }
    return data;
  } catch { return null; }
}

function cacheSet(key, data, ttlMs) {
  try {
    localStorage.setItem(key, JSON.stringify({
      data,
      expires: ttlMs ? Date.now() + ttlMs : null,
    }));
  } catch { /* private mode or storage full — silently ignore */ }
}

// ── Fetch wrapper with cache ─────────────────────────────────────────────────

async function fetchWithCache(url, cacheKey, ttlMs) {
  const cached = cacheGet(cacheKey);
  if (cached !== null) return cached;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
  const data = await res.json();
  cacheSet(cacheKey, data, ttlMs);
  return data;
}

// ── Date helper (local time, not UTC) ───────────────────────────────────────

function localDateKey(date = new Date()) {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

// ── History cache ────────────────────────────────────────────────────────────

function historyLoad() {
  return cacheGet(CACHE_KEY.history) ?? {};
}

function historySave(history) {
  cacheSet(CACHE_KEY.history, history, null); // no TTL — managed manually
}

/** Keep only entries within the current calendar month */
function historyPrune(history) {
  const now = new Date();
  const curYear  = now.getFullYear();
  const curMonth = now.getMonth();
  return Object.fromEntries(
    Object.entries(history).filter(([key]) => {
      const d = new Date(key + 'T00:00:00'); // local-time parse
      return d.getFullYear() === curYear && d.getMonth() === curMonth;
    })
  );
}

function historyAddToday(goldUsd, silverUsd) {
  let history = historyLoad();
  history = historyPrune(history);
  history[localDateKey()] = { gold: goldUsd, silver: silverUsd };
  historySave(history);
  return history;
}

// ── Price formatting ─────────────────────────────────────────────────────────

function makeFormatter(currencyCode) {
  // Let Intl decide decimal places per currency (JPY=0, USD=2, JOD=3, etc.)
  return new Intl.NumberFormat(undefined, {
    style:    'currency',
    currency: currencyCode,
  });
}

// ── % change badge ───────────────────────────────────────────────────────────

function calcChange(current, previous) {
  if (previous == null || previous === 0) return null;
  return ((current - previous) / previous) * 100;
}

function renderBadge(el, pct) {
  if (pct === null) { el.textContent = '—'; el.className = 'badge flat'; return; }
  const abs = Math.abs(pct);
  if (abs < CHANGE_DEAD_ZONE) {
    el.textContent = '±0.00%';
    el.className = 'badge flat';
  } else if (pct > 0) {
    el.textContent = `+${pct.toFixed(2)}%`;
    el.className = 'badge up';
  } else {
    el.textContent = `${pct.toFixed(2)}%`;
    el.className = 'badge down';
  }
}

// ── Portfolio ─────────────────────────────────────────────────────────────────

function portfolioLoad() {
  return cacheGet(CACHE_KEY.portfolio) ?? { goldOz: '', silverOz: '' };
}

function portfolioSave(goldOz, silverOz) {
  cacheSet(CACHE_KEY.portfolio, { goldOz, silverOz }, null);
}

function renderPortfolio() {
  const formatter     = window._formatter;
  const goldPriceOz   = window._goldPriceOz   ?? 0;
  const silverPriceOz = window._silverPriceOz ?? 0;
  if (!formatter) return;

  const goldOz   = parseFloat(document.getElementById('gold-oz-input').value)   || 0;
  const silverOz = parseFloat(document.getElementById('silver-oz-input').value) || 0;

  portfolioSave(
    document.getElementById('gold-oz-input').value,
    document.getElementById('silver-oz-input').value,
  );

  const goldValue   = goldOz   * goldPriceOz;
  const silverValue = silverOz * silverPriceOz;
  const total       = goldValue + silverValue;

  document.getElementById('portfolio-gold-value').textContent   = formatter.format(goldValue);
  document.getElementById('portfolio-silver-value').textContent = formatter.format(silverValue);
  document.getElementById('portfolio-total').textContent        = formatter.format(total);
}

function initPortfolioInputs() {
  const goldOzEl    = document.getElementById('gold-oz-input');
  const goldGramEl  = document.getElementById('gold-gram-input');
  const silverOzEl  = document.getElementById('silver-oz-input');
  const silverGramEl= document.getElementById('silver-gram-input');

  // Restore saved values
  const saved = portfolioLoad();
  if (saved.goldOz)   { goldOzEl.value   = saved.goldOz;   goldGramEl.value   = (parseFloat(saved.goldOz)   * TROY_OZ_TO_GRAMS).toFixed(3); }
  if (saved.silverOz) { silverOzEl.value = saved.silverOz; silverGramEl.value = (parseFloat(saved.silverOz) * TROY_OZ_TO_GRAMS).toFixed(3); }

  goldOzEl.addEventListener('input', () => {
    const oz = parseFloat(goldOzEl.value);
    goldGramEl.value = isNaN(oz) ? '' : (oz * TROY_OZ_TO_GRAMS).toFixed(3);
    renderPortfolio();
  });
  goldGramEl.addEventListener('input', () => {
    const g = parseFloat(goldGramEl.value);
    goldOzEl.value = isNaN(g) ? '' : (g / TROY_OZ_TO_GRAMS).toFixed(6);
    renderPortfolio();
  });
  silverOzEl.addEventListener('input', () => {
    const oz = parseFloat(silverOzEl.value);
    silverGramEl.value = isNaN(oz) ? '' : (oz * TROY_OZ_TO_GRAMS).toFixed(3);
    renderPortfolio();
  });
  silverGramEl.addEventListener('input', () => {
    const g = parseFloat(silverGramEl.value);
    silverOzEl.value = isNaN(g) ? '' : (g / TROY_OZ_TO_GRAMS).toFixed(6);
    renderPortfolio();
  });
}

// ── UI helpers ───────────────────────────────────────────────────────────────

function showState(name) {
  ['loading', 'error', 'main'].forEach((s) => {
    document.getElementById(`state-${s}`).classList.toggle('hidden', s !== name);
  });
}

function showError(msg) {
  document.getElementById('error-msg').textContent = msg;
  showState('error');
}

// ── Chart ────────────────────────────────────────────────────────────────────

let chart = null;
let activeTab = 'gold'; // 'gold' | 'silver'

const CHART_COLORS = {
  gold:   { line: '#f5c842', fill: 'rgba(245,200,66,0.12)' },
  silver: { line: '#a8b5c8', fill: 'rgba(168,181,200,0.12)' },
};

function buildChartData(history, metal, formatter) {
  const sorted = Object.keys(history).sort();
  const labels = sorted.map((k) => {
    const [, m, d] = k.split('-');
    return `${parseInt(m)}/${parseInt(d)}`;
  });
  const values = sorted.map((k) => history[k][metal]);
  return { labels, values };
}

function initChart(history, formatter, currencyCode) {
  const ctx = document.getElementById('price-chart').getContext('2d');
  const { labels, values } = buildChartData(history, activeTab, formatter);
  const colors = CHART_COLORS[activeTab];

  // Formatter for tooltip — chart stores raw USD values; convert on-the-fly
  const fxRate  = window._fxRate  ?? 1;
  const localValues = values.map((v) => v * fxRate);

  chart = new Chart(ctx, {
    type: 'line',
    data: {
      labels,
      datasets: [{
        label: activeTab === 'gold' ? 'Gold' : 'Silver',
        data: localValues,
        borderColor:     colors.line,
        backgroundColor: colors.fill,
        borderWidth: 2,
        pointRadius: localValues.length > 15 ? 2 : 4,
        pointHoverRadius: 6,
        fill: true,
        tension: 0.35,
      }],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      interaction: { mode: 'index', intersect: false },
      plugins: {
        legend: { display: false },
        tooltip: {
          callbacks: {
            label: (ctx) => {
              const val = ctx.parsed.y;
              return ' ' + formatter.format(val) + ' /oz';
            },
          },
        },
      },
      scales: {
        x: {
          grid:  { color: 'rgba(255,255,255,0.05)' },
          ticks: { color: '#8b90a8', font: { size: 11 } },
        },
        y: {
          grid:  { color: 'rgba(255,255,255,0.05)' },
          ticks: {
            color: '#8b90a8',
            font: { size: 11 },
            callback: (v) => formatter.format(v),
          },
        },
      },
    },
  });
}

function switchTab(metal) {
  if (!chart) return;
  activeTab = metal;

  const history   = historyLoad();
  const fxRate    = window._fxRate ?? 1;
  const formatter = window._formatter;
  const { labels, values } = buildChartData(history, metal, formatter);
  const localValues = values.map((v) => v * fxRate);
  const colors = CHART_COLORS[metal];

  chart.data.labels            = labels;
  chart.data.datasets[0].data  = localValues;
  chart.data.datasets[0].label = metal === 'gold' ? 'Gold' : 'Silver';
  chart.data.datasets[0].borderColor     = colors.line;
  chart.data.datasets[0].backgroundColor = colors.fill;
  chart.data.datasets[0].pointRadius     = localValues.length > 15 ? 2 : 4;

  chart.update();

  document.getElementById('tab-gold').classList.toggle('active', metal === 'gold');
  document.getElementById('tab-silver').classList.toggle('active', metal === 'silver');
  document.getElementById('tab-gold').setAttribute('aria-selected', String(metal === 'gold'));
  document.getElementById('tab-silver').setAttribute('aria-selected', String(metal === 'silver'));
}

// ── Main init ────────────────────────────────────────────────────────────────

async function init() {
  showState('loading');

  // 1. Geolocation → currency code
  let currencyCode = 'USD';
  let countryName  = '';
  let fallbackNote = '';

  try {
    const geo = await fetchWithCache(API.geo, CACHE_KEY.geo, TTL.geo);
    const detected = (geo.currency ?? '').toUpperCase();
    countryName = geo.country_name ?? '';
    if (detected) currencyCode = detected;
  } catch {
    // Silently fall back to USD
  }

  // 2. Fetch prices + FX in parallel
  let goldUsd, silverUsd, fxRate;
  try {
    const [goldData, silverData, fxData] = await Promise.all([
      fetchWithCache(API.gold,   CACHE_KEY.gold,   TTL.prices),
      fetchWithCache(API.silver, CACHE_KEY.silver, TTL.prices),
      currencyCode === 'USD'
        ? Promise.resolve(null)
        : fetchWithCache(API.fx(), CACHE_KEY.fx, TTL.fx),
    ]);

    // gold-api.com returns { price, ... }
    goldUsd   = goldData.price;
    silverUsd = silverData.price;

    // fawazahmed0 API returns { date, usd: { jod: 0.709, eur: 0.92, ... } }
    const rate = fxData?.usd?.[currencyCode.toLowerCase()];
    if (rate) {
      fxRate = rate;
    } else {
      fxRate = 1;
      if (currencyCode !== 'USD') {
        fallbackNote = ` (${currencyCode} not supported — showing USD)`;
        currencyCode = 'USD';
      }
    }
  } catch (err) {
    showError(`Failed to load price data. ${err.message}`);
    return;
  }

  // 3. Store FX rate and formatter globally for chart callbacks
  window._fxRate    = fxRate;
  window._formatter = makeFormatter(currencyCode);
  const formatter   = window._formatter;

  // Store local prices per oz for portfolio calculations
  window._goldPriceOz   = goldUsd * fxRate;
  window._silverPriceOz = silverUsd * fxRate;

  // 4. Update history cache
  const history = historyAddToday(goldUsd, silverUsd);

  // 5. Calculate local prices
  const goldOz     = goldUsd   * fxRate;
  const silverOz   = silverUsd * fxRate;
  const goldGram   = goldOz   / TROY_OZ_TO_GRAMS;
  const silverGram = silverOz / TROY_OZ_TO_GRAMS;

  // 6. Calculate % change vs yesterday
  const sortedDays = Object.keys(history).sort();
  const todayKey   = localDateKey();
  const todayIndex = sortedDays.indexOf(todayKey);
  const yesterdayKey = todayIndex > 0 ? sortedDays[todayIndex - 1] : null;
  const yesterday  = yesterdayKey ? history[yesterdayKey] : null;

  const goldChange   = calcChange(goldUsd,   yesterday?.gold);
  const silverChange = calcChange(silverUsd, yesterday?.silver);

  // 7. Populate UI
  const subtitleParts = [countryName, currencyCode].filter(Boolean);
  document.getElementById('subtitle').textContent =
    subtitleParts.length ? `Prices in ${subtitleParts.join(' — ')}${fallbackNote}` : '';

  document.getElementById('updated').textContent =
    `Updated: ${new Date().toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' })}`;

  GOLD_KARATS.forEach(({ k, purity }) => {
    const kOz   = goldOz * purity;
    const kGram = kOz / TROY_OZ_TO_GRAMS;
    document.getElementById(`gold-${k}k-oz`).textContent   = formatter.format(kOz);
    document.getElementById(`gold-${k}k-gram`).textContent = formatter.format(kGram);
  });
  renderBadge(document.getElementById('gold-badge'), goldChange);

  SILVER_PURITIES.forEach(({ k, purity }) => {
    const kOz   = silverOz * purity;
    const kGram = kOz / TROY_OZ_TO_GRAMS;
    document.getElementById(`silver-${k}-oz`).textContent   = formatter.format(kOz);
    document.getElementById(`silver-${k}-gram`).textContent = formatter.format(kGram);
  });
  renderBadge(document.getElementById('silver-badge'), silverChange);

  // 8. Chart
  const pointCount = Object.keys(history).length;
  if (pointCount === 1) {
    const note = document.getElementById('chart-note');
    note.textContent = 'Visit daily to build up your monthly history chart.';
    note.classList.remove('hidden');
  }

  showState('main');
  initChart(history, formatter, currencyCode);
  initPortfolioInputs();
  renderPortfolio();
}

// ── Event listeners ──────────────────────────────────────────────────────────

document.addEventListener('DOMContentLoaded', () => {
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('/sw.js').catch(() => { /* non-fatal */ });
  }

  init();

  document.getElementById('btn-retry').addEventListener('click', init);

  document.getElementById('tab-gold').addEventListener('click', () => switchTab('gold'));
  document.getElementById('tab-silver').addEventListener('click', () => switchTab('silver'));
});
