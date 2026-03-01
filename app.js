'use strict';

// ── Constants ────────────────────────────────────────────────────────────────

const TROY_OZ_TO_GRAMS = 31.1035;
const CHANGE_DEAD_ZONE = 0.005; // % — avoid showing ±0.00% from float rounding

const API = {
  geo:   'https://ipapi.co/json/',
  gold:  'https://api.gold-api.com/price/XAU',
  silver:'https://api.gold-api.com/price/XAG',
  fx:    (code) => `https://api.frankfurter.app/latest?from=USD&to=${code}`,
};

const TTL = {
  geo:    7 * 24 * 60 * 60 * 1000,  // 7 days
  prices: 23 * 60 * 60 * 1000,      // 23 hours
  fx:     23 * 60 * 60 * 1000,      // 23 hours
};

const CACHE_KEY = {
  geo:     'pmt_geo',
  gold:    'pmt_prices_gold',
  silver:  'pmt_prices_silver',
  fx:      (code) => `pmt_fx_${code}`,
  history: 'pmt_history',
};

// Frankfurter-supported currency codes (subset covering common currencies)
const SUPPORTED_CURRENCIES = new Set([
  'AUD','BGN','BRL','CAD','CHF','CNY','CZK','DKK','EUR','GBP',
  'HKD','HUF','IDR','ILS','INR','ISK','JPY','KRW','MXN','MYR',
  'NOK','NZD','PHP','PLN','RON','SEK','SGD','THB','TRY','USD','ZAR',
]);

// Zero-decimal currencies for Intl.NumberFormat
const ZERO_DECIMAL = new Set(['JPY','KRW','IDR','ISK']);

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
  const fractionDigits = ZERO_DECIMAL.has(currencyCode) ? 0 : 2;
  return new Intl.NumberFormat(undefined, {
    style:                 'currency',
    currency:              currencyCode,
    minimumFractionDigits: fractionDigits,
    maximumFractionDigits: fractionDigits,
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
    if (SUPPORTED_CURRENCIES.has(detected)) {
      currencyCode = detected;
    } else if (detected) {
      fallbackNote = ` (${detected} not supported — showing USD)`;
    }
  } catch {
    // Silently fall back to USD
  }

  // 2. Fetch prices + FX in parallel
  let goldUsd, silverUsd, fxRate;
  try {
    const [goldData, silverData, fxData] = await Promise.all([
      fetchWithCache(API.gold,   CACHE_KEY.gold,       TTL.prices),
      fetchWithCache(API.silver, CACHE_KEY.silver,     TTL.prices),
      currencyCode === 'USD'
        ? Promise.resolve(null)
        : fetchWithCache(API.fx(currencyCode), CACHE_KEY.fx(currencyCode), TTL.fx),
    ]);

    // gold-api.com returns { price, ... }
    goldUsd   = goldData.price;
    silverUsd = silverData.price;

    if (fxData && fxData.rates && fxData.rates[currencyCode]) {
      fxRate = fxData.rates[currencyCode];
    } else {
      fxRate = 1;
      if (currencyCode !== 'USD') {
        fallbackNote = ` (FX unavailable — showing USD)`;
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

  document.getElementById('gold-oz').textContent   = formatter.format(goldOz)   + ' /troy oz';
  document.getElementById('gold-gram').textContent = formatter.format(goldGram) + ' /gram';
  renderBadge(document.getElementById('gold-badge'), goldChange);

  document.getElementById('silver-oz').textContent   = formatter.format(silverOz)   + ' /troy oz';
  document.getElementById('silver-gram').textContent = formatter.format(silverGram) + ' /gram';
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
}

// ── Event listeners ──────────────────────────────────────────────────────────

document.addEventListener('DOMContentLoaded', () => {
  init();

  document.getElementById('btn-retry').addEventListener('click', init);

  document.getElementById('tab-gold').addEventListener('click', () => switchTab('gold'));
  document.getElementById('tab-silver').addEventListener('click', () => switchTab('silver'));
});
