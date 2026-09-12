let deviceIp = null;
let latestQuotes = {};      // symbol -> { price, change, percent, valid, alert, history }
let deviceSymbols = [];     // symbols currently active on the device, in order
let portfolio = [];         // [{ symbol, shares, costBasis }]
let savedSymbols = [];      // user's bookmarked symbols (local only)
let localApiKey = null;     // mirrored Finnhub key, used for chart fetches
let pollTimer = null;
let previewTimer = null;
let previewIndex = 0;
let previewCycleMs = 5000;
let currentChartSymbol = null;
let currentChartRange = '1D';
let currentCurrencyCode = 'USD';
let currentDeviceFirmware = null;

function formatPrice(v) {
  return currentCurrencyCode === 'USD' ? `$${v.toFixed(2)}` : `${v.toFixed(2)} ${currentCurrencyCode}`;
}

const POPULAR_SYMBOLS = ['AAPL', 'MSFT', 'GOOGL', 'AMZN', 'TSLA', 'NVDA', 'META', 'NFLX', 'AMD', 'INTC', 'DIS', 'JPM', 'V', 'WMT', 'KO'];
const MAX_DEVICE_SYMBOLS = 8;

const $ = (id) => document.getElementById(id);

// ------------------ Visual helpers ------------------

function avatarColor(symbol) {
  let hash = 0;
  for (let i = 0; i < symbol.length; i++) hash = (hash * 31 + symbol.charCodeAt(i)) % 360;
  return `hsl(${hash}, 55%, 55%)`;
}

function buildSparklineSvg(history, isUp, uid) {
  const w = 300, h = 120;
  if (!history || history.length < 2) return `<svg viewBox="0 0 ${w} ${h}" preserveAspectRatio="none"></svg>`;
  const min = Math.min(...history);
  const max = Math.max(...history);
  const range = (max - min) || 1;
  const stepX = w / (history.length - 1);
  const points = history.map((v, i) => [i * stepX, h - ((v - min) / range) * (h - 10) - 5]);
  const linePath = points.map((p, i) => (i === 0 ? `M${p[0]},${p[1]}` : `L${p[0]},${p[1]}`)).join(' ');
  const areaPath = `${linePath} L${w},${h} L0,${h} Z`;
  const color = isUp ? '#b8f36a' : '#ff6b7f';
  const gradId = `grad-${uid}`;
  return `<svg viewBox="0 0 ${w} ${h}" preserveAspectRatio="none">
    <defs><linearGradient id="${gradId}" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0%" stop-color="${color}" stop-opacity="0.35"/>
      <stop offset="100%" stop-color="${color}" stop-opacity="0"/>
    </linearGradient></defs>
    <path d="${areaPath}" fill="url(#${gradId})" stroke="none"/>
    <path d="${linePath}" fill="none" stroke="${color}" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"/>
  </svg>`;
}

function fmtChange(v) {
  const sign = v >= 0 ? '+' : '';
  return `${sign}${v.toFixed(2)}`;
}

// ------------------ Navigation ------------------
document.querySelectorAll('.nav-btn').forEach((btn) => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.nav-btn').forEach((b) => b.classList.remove('active'));
    document.querySelectorAll('.view').forEach((v) => v.classList.remove('active'));
    btn.classList.add('active');
    $(`view-${btn.dataset.view}`).classList.add('active');
    if (btn.dataset.view === 'settings') loadSettingsIntoForm();
    if (btn.dataset.view === 'firmware') loadFirmwareInfo();
    if (btn.dataset.view === 'symbols') renderSymbolsView();
  });
});

// ------------------ Device connection ------------------
function apiUrl(path) { return `http://${deviceIp}${path}`; }

function setConnectedUI(connected) {
  $('statusDot').classList.toggle('connected', connected);
  $('statusText').textContent = connected ? 'Connected' : 'Not connected';
  $('deviceIpText').textContent = deviceIp || '—';
}

async function tryConnect(ip) {
  try {
    const res = await fetch(`http://${ip}/api/status`, { cache: 'no-store' });
    if (!res.ok) return false;
    const data = await res.json();
    deviceIp = ip;
    await window.deviceApi.setDeviceIp(ip);
    setConnectedUI(true);
    if (data.firmware) { $('deviceFwText').textContent = `Firmware v${data.firmware}`; currentDeviceFirmware = data.firmware; }
    startPolling();

    // pick up cycle interval for the preview timer
    try {
      const cfgRes = await fetch(apiUrl('/api/config'), { cache: 'no-store' });
      const cfg = await cfgRes.json();
      previewCycleMs = (cfg.cycleIntervalSec || 5) * 1000;
      startPreviewTimer();
    } catch (e) { /* not critical */ }

    return true;
  } catch (e) {
    return false;
  }
}

async function findDevice() {
  setConnectedUI(false);
  $('statusText').textContent = 'Searching...';
  const savedIp = await window.deviceApi.getDeviceIp();
  if (savedIp && (await tryConnect(savedIp))) return;
  const discoveredIp = await window.deviceApi.discoverDevice();
  if (discoveredIp && (await tryConnect(discoveredIp))) return;
  setConnectedUI(false);
  $('statusText').textContent = 'Device not found';
}

$('rescanBtn').addEventListener('click', findDevice);
$('manualIpBtn').addEventListener('click', async () => {
  const ip = $('manualIpInput').value.trim();
  if (!ip) return;
  const ok = await tryConnect(ip);
  if (!ok) $('statusText').textContent = 'Could not reach that IP';
});

// ------------------ Watchlist polling ------------------
function startPolling() {
  if (pollTimer) clearInterval(pollTimer);
  pollStatus();
  pollTimer = setInterval(pollStatus, 5000);
}

async function pollStatus() {
  if (!deviceIp) return;
  try {
    const res = await fetch(apiUrl('/api/status'), { cache: 'no-store' });
    if (!res.ok) throw new Error('bad response');
    const data = await res.json();
    latestQuotes = {};
    deviceSymbols = (data.stocks || []).map((s) => s.symbol);
    (data.stocks || []).forEach((s) => { latestQuotes[s.symbol] = s; });
    currentCurrencyCode = data.currency || 'USD';
    renderWatchlist(data.stocks || []);
    renderPortfolio();
    setConnectedUI(true);
    if (data.firmware) { $('deviceFwText').textContent = `Firmware v${data.firmware}`; currentDeviceFirmware = data.firmware; }

    const pill = $('marketPill');
    if (typeof data.marketOpen === 'boolean') {
      pill.style.display = 'inline-flex';
      pill.className = `market-pill ${data.marketOpen ? 'open' : 'closed'}`;
      pill.textContent = data.marketOpen ? 'Market open' : 'Market closed';
    }

    drawDevicePreview();
    if ($('view-symbols').classList.contains('active')) renderSymbolsView();
  } catch (e) {
    setConnectedUI(false);
    $('statusText').textContent = 'Connection lost';
  }
}

function renderWatchlist(stocks) {
  const grid = $('watchlistGrid');
  if (!stocks.length) {
    grid.innerHTML = '<div class="empty-state">No symbols configured on the device.</div>';
    return;
  }
  grid.innerHTML = stocks.map((s) => {
    if (!s.valid) {
      return `<div class="stock-card flat" data-symbol="${s.symbol}">
        <div class="stock-card-head"><span class="stock-symbol">${s.symbol}</span></div>
        <div class="hint" style="margin:0;">No data yet</div>
        <div class="stock-card-foot"><div class="avatar" style="background:${avatarColor(s.symbol)}">${s.symbol[0]}</div></div>
      </div>`;
    }
    const isUp = s.change >= 0;
    return `<div class="stock-card ${isUp ? 'up' : 'down'}" data-symbol="${s.symbol}">
      <div class="stock-card-head">
        <span class="stock-symbol">${s.symbol}</span>
        <span class="pct-pill ${isUp ? 'pos' : 'neg'}">${fmtChange(s.percent)}%${s.alert ? '<span class="alert-icon">&#9650;</span>' : ''}</span>
      </div>
      <div class="stock-chart">${buildSparklineSvg(s.history, isUp, s.symbol)}</div>
      <div class="stock-card-foot">
        <div class="avatar" style="background:${avatarColor(s.symbol)}">${s.symbol[0]}</div>
        <span class="stock-price">${formatPrice(s.price)}</span>
      </div>
    </div>`;
  }).join('');

  grid.querySelectorAll('.stock-card').forEach((card) => {
    card.addEventListener('click', () => openChartModal(card.dataset.symbol));
  });
}

// ------------------ Device OLED preview ------------------

function drawMiniWifiIcon(ctx, rightX, bottomY, bars) {
  const barW = 3, gap = 1, maxH = 10;
  for (let i = 0; i < 4; i++) {
    const barH = (i + 1) * (maxH / 4);
    const x = rightX - (4 - i) * (barW + gap);
    const y = bottomY - barH;
    ctx.fillStyle = i < bars ? '#fff' : 'transparent';
    ctx.strokeStyle = '#fff';
    ctx.lineWidth = 1;
    if (i < bars) ctx.fillRect(x, y, barW, barH);
    else ctx.strokeRect(x + 0.5, y + 0.5, barW, barH);
  }
}

function drawDevicePreview() {
  const canvas = $('devicePreview');
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#000';
  ctx.fillRect(0, 0, 128, 128);
  ctx.fillStyle = '#fff';
  ctx.textBaseline = 'top';

  if (!deviceSymbols.length) {
    ctx.font = '11px monospace';
    ctx.fillText('No device data', 8, 58);
    return;
  }

  const symbol = deviceSymbols[previewIndex % deviceSymbols.length];
  const quote = latestQuotes[symbol];

  ctx.font = 'bold 18px monospace';
  ctx.fillText(symbol, 2, 0);
  ctx.strokeStyle = '#fff';
  ctx.lineWidth = 1;
  ctx.beginPath(); ctx.moveTo(0, 20); ctx.lineTo(128, 20); ctx.stroke();

  if (quote && quote.valid) {
    ctx.font = 'bold 18px monospace';
    ctx.fillText(formatPrice(quote.price), 2, 26);

    ctx.font = '10px monospace';
    const changeStr = `${quote.change >= 0 ? '+' : ''}${quote.change.toFixed(2)} (${quote.percent >= 0 ? '+' : ''}${quote.percent.toFixed(2)}%)`;
    ctx.fillText(changeStr, 2, 48);

    ctx.strokeStyle = '#fff';
    ctx.strokeRect(0.5, 60.5, 127, 44);
    if (quote.history && quote.history.length > 1) {
      const hist = quote.history;
      const min = Math.min(...hist), max = Math.max(...hist);
      const range = (max - min) || 1;
      ctx.strokeStyle = quote.change >= 0 ? '#b8f36a' : '#ff6b7f';
      ctx.beginPath();
      hist.forEach((v, i) => {
        const x = 3 + (i / (hist.length - 1)) * 122;
        const y = 100 - ((v - min) / range) * 36;
        if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
      });
      ctx.stroke();
    }
  } else {
    ctx.font = '10px monospace';
    ctx.fillText(quote === undefined ? 'No data' : 'No API key set', 2, 30);
  }

  ctx.font = '9px monospace';
  ctx.fillStyle = '#fff';
  ctx.fillText(deviceIp || '', 2, 118);

  drawMiniWifiIcon(ctx, 126, 126, deviceIp ? 4 : 0);

  // dot indicators, top-right
  const n = deviceSymbols.length;
  const spacing = 6;
  const startX = 126 - (n - 1) * spacing;
  for (let i = 0; i < n; i++) {
    ctx.beginPath();
    ctx.arc(startX + i * spacing, 4, 2, 0, Math.PI * 2);
    if (i === previewIndex % n) { ctx.fillStyle = '#fff'; ctx.fill(); }
    else { ctx.strokeStyle = '#fff'; ctx.lineWidth = 1; ctx.stroke(); }
  }
}

function startPreviewTimer() {
  if (previewTimer) clearInterval(previewTimer);
  previewTimer = setInterval(() => {
    previewIndex++;
    drawDevicePreview();
  }, previewCycleMs);
}

// ------------------ Symbols management ------------------

async function updateDeviceSymbols(newList) {
  if (!deviceIp) return false;
  try {
    const res = await fetch(apiUrl('/api/config'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ symbols: newList.join(',') }),
    });
    if (!res.ok) throw new Error('failed');
    await pollStatus();
    return true;
  } catch (e) {
    return false;
  }
}

async function addSymbolToDevice(symbol) {
  if (deviceSymbols.includes(symbol)) return;
  if (deviceSymbols.length >= MAX_DEVICE_SYMBOLS) {
    setSymbolsStatus(`Device is full — remove one first (max ${MAX_DEVICE_SYMBOLS}).`);
    return;
  }
  const ok = await updateDeviceSymbols([...deviceSymbols, symbol]);
  setSymbolsStatus(ok ? `Added ${symbol} to the device.` : 'Could not reach the device.');
  renderSymbolsView();
}

async function removeSymbolFromDevice(symbol) {
  if (deviceSymbols.length <= 1) {
    setSymbolsStatus('Keep at least one symbol on the device.');
    return;
  }
  const ok = await updateDeviceSymbols(deviceSymbols.filter((s) => s !== symbol));
  setSymbolsStatus(ok ? `Removed ${symbol} from the device.` : 'Could not reach the device.');
  renderSymbolsView();
}

function setSymbolsStatus(msg) {
  let el = document.getElementById('symbolsStatus');
  if (!el) {
    el = document.createElement('div');
    el.id = 'symbolsStatus';
    el.className = 'hint';
    $('onDeviceChips').insertAdjacentElement('afterend', el);
  }
  el.textContent = msg;
}

async function addToSaved(symbol) {
  if (!savedSymbols.includes(symbol)) {
    savedSymbols.push(symbol);
    await window.deviceApi.setSavedSymbols(savedSymbols);
  }
  renderSymbolsView();
}

async function removeFromSaved(symbol) {
  savedSymbols = savedSymbols.filter((s) => s !== symbol);
  await window.deviceApi.setSavedSymbols(savedSymbols);
  renderSymbolsView();
}
window.addSymbolToDevice = addSymbolToDevice;
window.removeSymbolFromDevice = removeSymbolFromDevice;
window.addToSaved = addToSaved;
window.removeFromSaved = removeFromSaved;

function renderSymbolsView() {
  const onDeviceEl = $('onDeviceChips');
  onDeviceEl.innerHTML = deviceIp
    ? (deviceSymbols.length
        ? deviceSymbols.map((s) => `<span class="chip">${s}<button class="chip-btn remove" onclick="removeSymbolFromDevice('${s}')">&times;</button></span>`).join('')
        : '<div class="empty-state">No symbols on the device.</div>')
    : '<div class="empty-state">Connect to a device first.</div>';

  const savedEl = $('savedChips');
  savedEl.innerHTML = savedSymbols.length
    ? savedSymbols.map((s) => `<span class="chip">${s}
        <button class="chip-btn add" title="Add to device" onclick="addSymbolToDevice('${s}')">+</button>
        <button class="chip-btn remove" title="Remove from saved" onclick="removeFromSaved('${s}')">&times;</button>
      </span>`).join('')
    : '<div class="empty-state">No saved symbols yet.</div>';

  const popularEl = $('popularChips');
  popularEl.innerHTML = POPULAR_SYMBOLS.map((s) => {
    const already = savedSymbols.includes(s);
    return `<span class="chip popular" onclick="${already ? '' : `addToSaved('${s}')`}" style="${already ? 'opacity:0.4;cursor:default;' : ''}">${s}${already ? '' : ' +'}</span>`;
  }).join('');
}

$('addCustomForm').addEventListener('submit', (e) => {
  e.preventDefault();
  const symbol = $('addCustomInput').value.trim().toUpperCase();
  if (!symbol) return;
  addToSaved(symbol);
  e.target.reset();
});

// ------------------ Historical chart ------------------

function openChartModal(symbol) {
  currentChartSymbol = symbol;
  currentChartRange = '1D';
  $('chartModalSymbol').textContent = symbol;
  document.querySelectorAll('.range-btn').forEach((b) => b.classList.toggle('active', b.dataset.range === '1D'));
  $('chartModalBackdrop').classList.add('open');
  loadHistory(symbol, '1D');
}

$('chartModalClose').addEventListener('click', () => $('chartModalBackdrop').classList.remove('open'));
$('chartModalBackdrop').addEventListener('click', (e) => {
  if (e.target.id === 'chartModalBackdrop') $('chartModalBackdrop').classList.remove('open');
});

document.querySelectorAll('.range-btn').forEach((btn) => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.range-btn').forEach((b) => b.classList.remove('active'));
    btn.classList.add('active');
    currentChartRange = btn.dataset.range;
    loadHistory(currentChartSymbol, currentChartRange);
  });
});

async function loadHistory(symbol, range) {
  const statusEl = $('chartStatus');
  const canvas = $('historyCanvas');
  const ctx = canvas.getContext('2d');
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  statusEl.textContent = 'Loading...';

  if (!localApiKey) {
    statusEl.textContent = 'Add your Finnhub API key in Settings to view historical charts.';
    return;
  }

  const now = Math.floor(Date.now() / 1000);
  let resolution, from;
  if (range === '1D') { resolution = '5'; from = now - 86400; }
  else if (range === '1M') { resolution = '60'; from = now - 30 * 86400; }
  else { resolution = 'D'; from = now - 365 * 86400; }

  try {
    const url = `https://finnhub.io/api/v1/stock/candle?symbol=${encodeURIComponent(symbol)}&resolution=${resolution}&from=${from}&to=${now}&token=${localApiKey}`;
    const res = await fetch(url);
    const data = await res.json();
    if (data.s !== 'ok' || !data.c || !data.c.length) {
      statusEl.textContent = 'No historical data available (may require a paid Finnhub plan, or the rate limit was hit).';
      return;
    }
    statusEl.textContent = '';
    drawHistoryChart(data.c);
  } catch (e) {
    statusEl.textContent = 'Could not fetch historical data.';
  }
}

function drawHistoryChart(closes) {
  const canvas = $('historyCanvas');
  const ctx = canvas.getContext('2d');
  const w = canvas.width, h = canvas.height, pad = 30;
  ctx.clearRect(0, 0, w, h);

  const min = Math.min(...closes), max = Math.max(...closes);
  const range = (max - min) || 1;
  const isUp = closes[closes.length - 1] >= closes[0];
  const color = isUp ? '#b8f36a' : '#ff6b7f';

  ctx.strokeStyle = 'rgba(255,255,255,0.08)';
  ctx.lineWidth = 1;
  for (let i = 0; i <= 4; i++) {
    const y = pad + (i / 4) * (h - pad * 2);
    ctx.beginPath(); ctx.moveTo(pad, y); ctx.lineTo(w - 10, y); ctx.stroke();
  }

  ctx.fillStyle = '#7d8290';
  ctx.font = '11px sans-serif';
  ctx.textBaseline = 'middle';
  ctx.fillText('$' + max.toFixed(2), 0, pad);
  ctx.fillText('$' + min.toFixed(2), 0, h - pad);

  const plotW = w - pad - 10;
  const grad = ctx.createLinearGradient(0, pad, 0, h - pad);
  grad.addColorStop(0, color + '55');
  grad.addColorStop(1, color + '00');

  ctx.beginPath();
  closes.forEach((v, i) => {
    const x = pad + (i / (closes.length - 1)) * plotW;
    const y = pad + (1 - (v - min) / range) * (h - pad * 2);
    if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
  });
  ctx.strokeStyle = color;
  ctx.lineWidth = 2;
  ctx.lineJoin = 'round';
  ctx.stroke();

  ctx.lineTo(pad + plotW, h - pad);
  ctx.lineTo(pad, h - pad);
  ctx.closePath();
  ctx.fillStyle = grad;
  ctx.fill();
}

// ------------------ Portfolio ------------------
async function loadPortfolio() {
  portfolio = (await window.deviceApi.loadPortfolio()) || [];
  renderPortfolio();
}

$('holdingForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const symbol = $('holdingSymbol').value.trim().toUpperCase();
  const shares = parseFloat($('holdingShares').value);
  const costBasis = parseFloat($('holdingCost').value);
  if (!symbol || !(shares > 0) || !(costBasis >= 0)) return;
  portfolio.push({ symbol, shares, costBasis });
  await window.deviceApi.savePortfolio(portfolio);
  e.target.reset();
  renderPortfolio();
});

async function removeHolding(index) {
  portfolio.splice(index, 1);
  await window.deviceApi.savePortfolio(portfolio);
  renderPortfolio();
}
window.removeHolding = removeHolding;

function renderPortfolio() {
  const list = $('portfolioList');
  if (!portfolio.length) {
    list.innerHTML = '<div class="empty-state">No holdings yet.</div>';
    $('portfolioTotalValue').textContent = '$0.00';
    $('portfolioTotalPill').textContent = '';
    $('portfolioTotalPill').className = 'balance-pill zero';
    return;
  }

  let totalValue = 0, totalCost = 0;
  list.innerHTML = portfolio.map((h, i) => {
    const quote = latestQuotes[h.symbol];
    const price = quote && quote.valid ? quote.price : null;
    const value = price !== null ? price * h.shares : null;
    const cost = h.costBasis * h.shares;
    totalCost += cost;
    if (value !== null) totalValue += value;
    const gain = value !== null ? value - cost : null;
    const gainPct = value !== null && cost > 0 ? (gain / cost) * 100 : null;
    const cls = gain === null ? 'zero' : (gain >= 0 ? 'pos' : 'neg');
    return `<div class="asset-row">
      <div class="avatar" style="background:${avatarColor(h.symbol)}">${h.symbol[0]}</div>
      <div class="asset-info">
        <span class="asset-symbol">${h.symbol}</span>
        <span class="asset-sub">${h.shares} sh @ $${h.costBasis.toFixed(2)}</span>
      </div>
      <div class="asset-values">
        <div class="asset-value">${value !== null ? '$' + value.toFixed(2) : 'not tracked'}</div>
        <div class="asset-change ${cls}">${gain !== null ? (gain >= 0 ? '+' : '-') + '$' + Math.abs(gain).toFixed(2) + ' (' + (gainPct >= 0 ? '+' : '') + gainPct.toFixed(1) + '%)' : '—'}</div>
      </div>
      <button class="remove-btn" onclick="removeHolding(${i})">&times;</button>
    </div>`;
  }).join('');

  const totalGain = totalValue - totalCost;
  const cls = totalCost === 0 ? 'zero' : (totalGain >= 0 ? 'pos' : 'neg');
  const pct = totalCost > 0 ? (totalGain / totalCost) * 100 : 0;
  $('portfolioTotalValue').textContent = `$${totalValue.toFixed(2)}`;
  $('portfolioTotalPill').className = `balance-pill ${cls}`;
  $('portfolioTotalPill').textContent = totalCost === 0
    ? 'No cost basis yet'
    : `${totalGain >= 0 ? '+' : '-'}$${Math.abs(totalGain).toFixed(2)} (${pct >= 0 ? '+' : ''}${pct.toFixed(1)}%)`;
}

// ------------------ Settings ------------------
async function loadSettingsIntoForm() {
  if (!deviceIp) {
    $('settingsStatus').textContent = 'Connect to a device first.';
    return;
  }
  try {
    const res = await fetch(apiUrl('/api/config'), { cache: 'no-store' });
    const cfg = await res.json();
    $('settingSymbols').value = cfg.symbols || '';
    $('settingFetchSec').value = cfg.fetchIntervalSec || 60;
    $('settingCycleSec').value = cfg.cycleIntervalSec || 5;
    $('settingCurrency').value = cfg.currencyCode || 'USD';
    $('settingAlertThreshold').value = cfg.alertThreshold || 0;
    $('settingRotation').value = String(cfg.rotation || 0);
    $('settingInvert').checked = !!cfg.invertDisplay;
    $('settingMarketAware').checked = !!cfg.marketAwareMode;
    $('settingApPassword').value = cfg.apPassword || '';
    $('settingApiKey').value = '';
    $('settingsStatus').textContent = cfg.hasApiKey ? 'API key is set on the device.' : 'No API key set yet.';
  } catch (e) {
    $('settingsStatus').textContent = 'Could not load settings from device.';
  }
}

$('settingsForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  if (!deviceIp) return;

  const body = {
    symbols: $('settingSymbols').value.trim(),
    fetchIntervalSec: parseInt($('settingFetchSec').value, 10) || 60,
    cycleIntervalSec: parseInt($('settingCycleSec').value, 10) || 5,
    currencyCode: $('settingCurrency').value,
    alertThreshold: parseFloat($('settingAlertThreshold').value) || 0,
    rotation: parseInt($('settingRotation').value, 10),
    invertDisplay: $('settingInvert').checked,
    marketAwareMode: $('settingMarketAware').checked,
    apPassword: $('settingApPassword').value,
  };
  const apiKey = $('settingApiKey').value.trim();
  if (apiKey) {
    body.apikey = apiKey;
    localApiKey = apiKey;
    await window.deviceApi.setApiKey(apiKey);
  }

  previewCycleMs = body.cycleIntervalSec * 1000;
  startPreviewTimer();

  $('settingsStatus').textContent = 'Saving...';
  try {
    const res = await fetch(apiUrl('/api/config'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!res.ok) throw new Error('save failed');
    $('settingsStatus').textContent = 'Saved.';
    pollStatus();
  } catch (e) {
    $('settingsStatus').textContent = 'Failed to save settings.';
  }
});

// ------------------ Firmware update ------------------
async function loadFirmwareInfo() {
  if (!deviceIp) { $('fwCurrentVersion').textContent = 'connect to a device first'; return; }
  try {
    const res = await fetch(apiUrl('/api/status'), { cache: 'no-store' });
    const data = await res.json();
    $('fwCurrentVersion').textContent = data.firmware || 'unknown';
    currentDeviceFirmware = data.firmware || null;
  } catch (e) {
    $('fwCurrentVersion').textContent = 'unknown';
  }

  const savedRepo = await window.deviceApi.getFirmwareRepo();
  if (savedRepo) $('fwRepoInput').value = savedRepo;
}

$('fwCheckGithubBtn').addEventListener('click', async () => {
  const repo = $('fwRepoInput').value.trim();
  if (!repo || !repo.includes('/')) {
    $('fwGithubStatus').textContent = 'Enter a repo as owner/name, e.g. yourname/stock-tracker.';
    return;
  }
  await window.deviceApi.setFirmwareRepo(repo);
  $('fwGithubStatus').textContent = 'Checking...';
  $('fwGithubUpdateBox').style.display = 'none';

  const latest = await window.deviceApi.checkLatestFirmware(repo);
  if (!latest) {
    $('fwGithubStatus').textContent = 'Could not find a release with a .bin attached on that repo.';
    return;
  }

  if (currentDeviceFirmware && latest.version === currentDeviceFirmware) {
    $('fwGithubStatus').textContent = `Up to date (v${currentDeviceFirmware}).`;
    return;
  }

  $('fwGithubStatus').textContent = '';
  const box = $('fwGithubUpdateBox');
  box.style.display = 'block';
  box.innerHTML = `<div class="fw-update-available">
    <span>Firmware v${latest.version} available</span>
    <button id="fwInstallGithubBtn">Install</button>
  </div>`;
  $('fwInstallGithubBtn').addEventListener('click', async () => {
    if (!deviceIp) return;
    $('fwGithubStatus').textContent = 'Downloading and installing — this can take a minute...';
    box.style.display = 'none';
    const ok = await window.deviceApi.pushFirmwareFromUrl(deviceIp, latest.assetUrl);
    if (ok) {
      $('fwGithubStatus').textContent = 'Update installed. Device is rebooting...';
      setTimeout(() => { $('fwGithubStatus').textContent = 'Reconnecting...'; findDevice(); }, 6000);
    } else {
      $('fwGithubStatus').textContent = 'Update failed — check the device is still connected and try again.';
    }
  });
});

// ------------------ App self-update ------------------
async function initAppUpdateUI() {
  const version = await window.appUpdate.getVersion();
  $('appVersionText').textContent = `v${version}`;

  window.appUpdate.onAvailable((newVersion) => {
    const banner = $('appUpdateBanner');
    banner.style.display = 'flex';
    banner.innerHTML = `<span>Downloading update v${newVersion}...</span>`;
  });

  window.appUpdate.onDownloaded((newVersion) => {
    const banner = $('appUpdateBanner');
    banner.style.display = 'flex';
    banner.innerHTML = `<span>Update v${newVersion} ready</span><button id="appRestartBtn">Restart &amp; install</button>`;
    $('appRestartBtn').addEventListener('click', () => window.appUpdate.quitAndInstall());
  });
}

$('fwUploadBtn').addEventListener('click', () => {
  if (!deviceIp) { $('fwStatus').textContent = 'Connect to a device first.'; return; }
  const file = $('fwFileInput').files[0];
  if (!file) { $('fwStatus').textContent = 'Choose a .bin file first.'; return; }

  const formData = new FormData();
  formData.append('firmware', file, file.name);
  const xhr = new XMLHttpRequest();
  xhr.open('POST', apiUrl('/update'));

  const bar = $('fwProgressBar'), fill = $('fwProgressFill');
  bar.style.display = 'block'; fill.style.width = '0%';
  $('fwStatus').textContent = 'Uploading...';

  xhr.upload.addEventListener('progress', (e) => {
    if (e.lengthComputable) fill.style.width = `${Math.round((e.loaded / e.total) * 100)}%`;
  });
  xhr.onload = () => {
    if (xhr.status === 200) {
      $('fwStatus').textContent = 'Update installed. Device is rebooting...';
      fill.style.width = '100%';
      setTimeout(() => { $('fwStatus').textContent = 'Reconnecting...'; findDevice(); }, 6000);
    } else {
      $('fwStatus').textContent = `Update failed (status ${xhr.status}).`;
    }
  };
  xhr.onerror = () => { $('fwStatus').textContent = 'Upload failed — device may have rebooted or connection dropped.'; };
  xhr.send(formData);
});

// ------------------ Init ------------------
(async function init() {
  await loadPortfolio();
  savedSymbols = (await window.deviceApi.getSavedSymbols()) || [];
  localApiKey = await window.deviceApi.getApiKey();

  const savedTheme = (await window.deviceApi.getTheme()) || 'dark';
  document.body.dataset.theme = savedTheme;
  $('themeSelect').value = savedTheme;

  drawDevicePreview();
  renderSymbolsView();
  initAppUpdateUI();
  await findDevice();
})();

$('themeSelect').addEventListener('change', async (e) => {
  const theme = e.target.value;
  document.body.dataset.theme = theme;
  await window.deviceApi.setTheme(theme);
});
