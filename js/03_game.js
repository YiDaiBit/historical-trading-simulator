/* ============================================================
   03_game.js — 游戏主逻辑
   ============================================================ */
if (typeof PAYLOAD === 'undefined') {
  function showMissingQuotes() {
    var m = document.getElementById('bootMsg');
    if (m) {
      m.style.color = '#e8c877';
      m.textContent = '这里没有附带历史行情。请在本地放入 data/payload.js 后再打开。';
    }
    var spin = document.querySelector('#boot div div');
    if (spin) spin.style.animation = 'none';
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', showMissingQuotes);
  else showMissingQuotes();
} else {
const DATA = Payload.decode(PAYLOAD);
const ND = DATA.nd;
const LS = 'hist-trade-sim-v1';
const MARGIN_RATE = 0.5;      // 空头保证金比例

const $ = s => document.querySelector(s);
const $$ = s => Array.from(document.querySelectorAll(s));

/* ---------------- 工具 ---------------- */
function fmtMoney(v, dec) {
  if (!isFinite(v)) return '—';
  const d = dec === undefined ? 2 : dec;
  return '$' + v.toLocaleString('en-US', { minimumFractionDigits: d, maximumFractionDigits: d });
}
function fmtPct(v) {
  if (!isFinite(v)) return '—';
  return (v >= 0 ? '+' : '') + (v * 100).toFixed(2) + '%';
}
function cls(v) { return !isFinite(v) || v === 0 ? 'flat' : v > 0 ? 'up' : 'down'; }
function decimalsFor(a) {
  const m = Math.abs(a.c[a.n - 1]);
  if (m >= 1000) return 1;
  if (m >= 100) return 2;
  if (m >= 0.1) return 4;
  return 6;
}
function px(a, v) { return Chart.fmt(v, decimalsFor(a)); }
function dstr(g) { return DATA.dates[Math.max(0, Math.min(ND - 1, g))]; }
function weekday(g) {
  const d = new Date(dstr(g) + 'T00:00:00Z');
  return ['周日', '周一', '周二', '周三', '周四', '周五', '周六'][d.getUTCDay()];
}
/* 把毫秒格式化成人类可读的倒计时 */
function fmtDur(ms) {
  if (!isFinite(ms) || ms < 0) ms = 0;
  const s = ms / 1000;
  if (s < 10) return s.toFixed(1) + ' 秒';
  const t = Math.ceil(s);
  const h = Math.floor(t / 3600), m = Math.floor((t % 3600) / 60), ss = t % 60;
  const mm = String(m).padStart(2, '0'), s2 = String(ss).padStart(2, '0');
  return h > 0 ? h + ':' + mm + ':' + s2 : m + ':' + s2;
}
function toast(msg, kind) {
  const el = document.createElement('div');
  el.className = kind || '';
  el.textContent = msg;
  $('#toast').appendChild(el);
  setTimeout(() => { el.style.transition = 'opacity .4s'; el.style.opacity = 0; }, 1900);
  setTimeout(() => el.remove(), 2400);
}

/* ---------------- 状态 ---------------- */
const S = {
  g: 0, startG: 0, endG: ND - 1,
  cash: 100000, initCash: 100000, feeRate: 0.001, allowShort: true,
  pos: {}, trades: [], eq: [], bench: [], benchSPX: null,
  realized: 0, fees: 0, closes: [],
  sel: (DATA.assets['SPX'] ? 'SPX' : DATA.list[0].key),
  viewN: 365, ma: { 5: true, 20: true, 60: false }, showVol: true,
  speedMs: 10000, playing: false, lastTick: Date.now(),
  side: 'openLong', closeFrac: 1, over: false, tab: 'chart', filter: '',
  focusKey: null, focusAt: 0, focusPending: false,
  watchKey: null, watchAt: 0, watchPending: false,
  showBench: true, logScale: true, showMarks: true, hover: -1,
};

function markOf(a, g) { const m = a.mark[g]; return isFinite(m) ? m : NaN; }
function listed(a, g) { return a.d0 <= g; }
function tradable(a, g) { return a.has[g] === 1; }

/* ---------------- 双向持仓：多空两条腿各自独立 ---------------- */
const ACTIONS = {
  openLong:   { label: '开多', dir: 'long',  open: true  },
  openShort:  { label: '开空', dir: 'short', open: true  },
  closeLong:  { label: '平多', dir: 'long',  open: false },
  closeShort: { label: '平空', dir: 'short', open: false },
};
const LEGCN = { long: '多头', short: '空头' };

function blankLeg() { return { qty: 0, avg: 0 }; }
function hasLeg(key, side) { const p = S.pos[key]; return !!p && p[side].qty > 1e-9; }
function hasAnyPos(key) { return hasLeg(key, 'long') || hasLeg(key, 'short'); }
function legCount(side) { let c = 0; for (const k in S.pos) if (hasLeg(k, side)) c++; return c; }

/* 多空分开计市值：net = 多头市值 − 空头市值 */
function grossAt(g) {
  let L = 0, Sh = 0;
  for (const k in S.pos) {
    const p = S.pos[k], m = markOf(DATA.assets[k], g);
    if (!isFinite(m)) continue;
    L += p.long.qty * m;
    Sh += p.short.qty * m;
  }
  return { long: L, short: Sh, net: L - Sh };
}
/* 权益 = 现金 + 多头市值 − 空头市值（开空时收到的现金已计入 cash） */
function equityAt(g) {
  const v = grossAt(g);
  return S.cash + v.long - v.short;
}
function shortMarginAt(g) {
  let v = 0;
  for (const k in S.pos) {
    const p = S.pos[k]; if (!p.short.qty) continue;
    const m = markOf(DATA.assets[k], g);
    if (isFinite(m)) v += p.short.qty * m * MARGIN_RATE;
  }
  return v;
}
function availableCash() { return S.cash - shortMarginAt(S.g); }
function totalEquity() { return equityAt(S.g); }
/* 某个方向还能开多大名义金额 */
function maxOpenNotional(action) {
  const avail = Math.max(0, availableCash());
  const cost = action === 'openLong' ? (1 + S.feeRate) : (MARGIN_RATE + S.feeRate);
  return cost > 0 ? avail / cost : 0;
}
function unrealizedAt(g) {
  let v = 0;
  for (const k in S.pos) {
    const p = S.pos[k], m = markOf(DATA.assets[k], g);
    if (!isFinite(m)) continue;
    v += p.long.qty * (m - p.long.avg) + p.short.qty * (p.short.avg - m);
  }
  return v;
}

/* ---------------- 基准 ---------------- */
function buildBenchmark() {
  const startG = S.startG, cash = S.initCash;
  const picks = [];
  for (const a of DATA.list) {
    if (!listed(a, startG)) continue;
    // 找到 >= startG 的第一个交易日
    let k = -1;
    for (let g = startG; g <= S.endG; g++) if (a.has[g]) { k = a.pos[g]; break; }
    if (k >= 0) picks.push({ a: a, base: a.c[k] });
  }
  S.benchBase = picks;
  const spx = DATA.assets['SPX'];
  if (spx && listed(spx, startG)) {
    let k = -1; for (let g = startG; g <= S.endG; g++) if (spx.has[g]) { k = spx.pos[g]; break; }
    S.spxBase = k >= 0 ? spx.c[k] : null;
  } else S.spxBase = null;
}
function benchAt(g) {
  if (!S.benchBase || !S.benchBase.length) return NaN;
  let s = 0, n = 0;
  for (const p of S.benchBase) {
    const m = markOf(p.a, g);
    if (!isFinite(m)) continue;
    s += m / p.base; n++;
  }
  return n ? S.initCash * s / n : NaN;
}
function benchSPXAt(g) {
  const spx = DATA.assets['SPX'];
  if (!spx || !S.spxBase) return NaN;
  const m = markOf(spx, g);
  return isFinite(m) ? S.initCash * m / S.spxBase : NaN;
}

/* ---------------- 成交：开多 / 开空 / 平多 / 平空 互不抵消 ----------------
   返回 {ex 成交数量, fee 手续费, pnl 已实现盈亏}，被拒绝时返回 null            */
function execFill(key, action, qty, price) {
  const A = ACTIONS[action];
  if (!A || !(qty > 0)) return null;
  const a = DATA.assets[key];
  let p = S.pos[key];
  if (!p) p = S.pos[key] = { long: blankLeg(), short: blankLeg(), fee: 0 };
  const leg = p[A.dir];
  let ex = 0, fee = 0, pnl = 0, avg0 = leg.avg;

  if (A.open) {
    ex = qty;
    fee = ex * price * S.feeRate;
    const tot = leg.qty + ex;
    leg.avg = tot > 0 ? (leg.qty * leg.avg + ex * price) / tot : price;
    if (A.dir === 'long') S.cash -= ex * price + fee;     // 开多：付钱买入
    else S.cash += ex * price - fee;                      // 开空：收到卖出款（另冻结保证金）
    leg.qty = tot;
  } else {
    ex = Math.min(qty, leg.qty);
    if (ex <= 1e-12) return null;
    fee = ex * price * S.feeRate;
    pnl = A.dir === 'long' ? ex * (price - avg0) : ex * (avg0 - price);
    if (A.dir === 'long') S.cash += ex * price - fee;     // 平多：卖出收回
    else S.cash -= ex * price + fee;                      // 平空：买回偿还
    leg.qty -= ex;
    if (leg.qty < 1e-9) { leg.qty = 0; leg.avg = 0; }
  }

  S.fees += fee; p.fee += fee;
  if (!A.open) {
    S.realized += pnl;
    S.closes.push({ key: key, g: S.g, qty: ex, price: price, avg: avg0, pnl: pnl, dir: A.dir });
  }
  S.trades.push({ g: S.g, key: key, cn: a.cn, action: action, qty: ex, price: price,
                  fee: fee, amt: ex * price });
  if (!p.long.qty && !p.short.qty) delete S.pos[key];
  if (S.trades.length > 4000) S.trades.splice(0, 1000);
  return { ex: ex, fee: fee, pnl: pnl };
}

function doTrade() {
  if (S.over) return toast('本局已结束，请重新开局', 'bad');
  const a = DATA.assets[S.sel];
  if (!tradable(a, S.g)) return toast(a.cn + ' 今日休市，无法交易', 'bad');
  const price = a.c[a.pos[S.g]];
  const act = S.side, A = ACTIONS[act];
  const p = S.pos[S.sel];
  const amt = parseFloat($('#inAmt').value) || 0;

  if (A.open) {
    if (act === 'openShort' && !S.allowShort) return toast('本局已关闭做空', 'bad');
    if (amt <= 0) return toast('请输入金额', 'bad');
    const avail = availableCash();
    // 开多需备足全额 + 手续费；开空只冻结 50% 保证金 + 手续费
    const need = amt * (act === 'openLong' ? 1 + S.feeRate : MARGIN_RATE + S.feeRate);
    if (need > avail + 1e-6) {
      return toast((act === 'openLong' ? '可用资金不足' : '空头保证金不足') +
        '（可用 ' + fmtMoney(avail, 0) + '，最多可开 ' + fmtMoney(maxOpenNotional(act), 0) + '）', 'bad');
    }
    const r = execFill(S.sel, act, amt / price, price);
    if (!r) return toast('下单失败', 'bad');
    toast(A.label + ' ' + a.cn + ' ' + fmtMoney(r.ex * price, 0), 'ok');
  } else {
    const q = p ? p[A.dir].qty : 0;
    if (!(q > 1e-9)) return toast('当前没有' + LEGCN[A.dir] + '持仓', 'bad');
    const r = execFill(S.sel, act, q * S.closeFrac, price);
    if (!r) return toast('平仓数量过小', 'bad');
    toast(A.label + ' ' + a.cn + ' ' + fmtMoney(r.ex * price, 0) +
      (Math.abs(r.pnl) > 0.005 ? '，实现盈亏 ' + fmtMoney(r.pnl, 2) : ''), 'ok');
  }
  recordEquity();
  saveNow(); renderAll();
}

/* ---------------- 时间 ---------------- */
function computeDerived() {
  // 仅在需要时重算基准序列（基准为确定性函数，不回填状态）
  return null;
}
function recordEquity() {
  const k = S.g - S.startG;
  S.eq[k] = Math.round(totalEquity() * 100) / 100;
  const b = benchAt(S.g); S.bench[k] = isFinite(b) ? Math.round(b * 100) / 100 : NaN;
  if (S.spxBase && S.benchSPX) {              // 两者必须同时存在，缺一就跳过
    const s = benchSPXAt(S.g); S.benchSPX[k] = isFinite(s) ? Math.round(s * 100) / 100 : NaN;
  }
}
function initEquitySeries() {
  S.eq = new Array(S.g - S.startG + 1);
  S.bench = new Array(S.g - S.startG + 1);
  S.benchSPX = S.spxBase ? new Array(S.g - S.startG + 1) : null;
  recordEquity();
}
function advance(n) {
  if (S.over) return;
  closeCloseMenu();
  let steps = 0;
  while (steps < n && S.g < S.endG) { S.g++; steps++; recordEquity(); }
  if (S.g >= S.endG) { S.over = true; S.playing = false; syncSpeedUI(); toast('🎉 已走完全部历史数据，本局结束', 'ok'); }
  const eq = totalEquity();
  if (eq <= 0) {
    S.over = true; S.playing = false; syncSpeedUI();
    toast('💥 权益归零，本局爆仓结束', 'bad');
  }
  saveThrottled(); renderAll();
}
function clockLoop() {
  if (S.playing && !S.over && S.speedMs > 0) {
    const now = Date.now();
    let elapsed = now - S.lastTick;
    if (elapsed >= S.speedMs) {
      let n = Math.floor(elapsed / S.speedMs);
      n = Math.min(n, 4);                       // 后台切回时不要一次性跳过太多
      S.lastTick = now - (elapsed - n * S.speedMs);
      advance(n);
    }
    const el2 = Date.now() - S.lastTick;
    const pr = Math.min(1, el2 / S.speedMs);
    $('#prog').style.width = (pr * 100).toFixed(2) + '%';
    $('#nextIn').textContent = '⏳ 距下一交易日 ' + fmtDur(S.speedMs - el2) +
      (S.speedMs > 60000 ? '（较慢，可点顶栏加速）' : '');
  } else {
    $('#prog').style.width = '0%';
    $('#nextIn').textContent = S.over ? '' : (S.speedMs > 0 ? '⏸ 已暂停' : '手动推进模式：点 ⏭ 走一天');
  }
}

/* ---------------- 渲染：资产列表 ---------------- */
let watchCache = '';
let posCache = '';
function renderWatch() {
  const q = (S.filter || '').trim().toLowerCase();
  const match = a => !q || a.cn.toLowerCase().indexOf(q) >= 0 ||
    a.en.toLowerCase().indexOf(q) >= 0 || a.key.toLowerCase().indexOf(q) >= 0 ||
    a.cat.indexOf(q) >= 0 || (a.src || '').toLowerCase().indexOf(q) >= 0;
  const cats = {};
  for (const a of DATA.list) { if (match(a)) (cats[a.cat] = cats[a.cat] || []).push(a); }
  const order = ['股指', '商品', '汇率', '加密', '债券'];
  let h = '', shown = 0;
  for (const c of order) {
    const arr = cats[c]; if (!arr) continue;
    shown += arr.length;
    h += '<div class="catgrp"><div class="catth"><span>' + c + '</span><span>' + arr.length + '</span></div>';
    for (const a of arr) {
      const on = a.key === S.sel ? ' on' : '';
      const flash = (S.watchKey === a.key && (Date.now() - S.watchAt) < FOCUS_MS) ? ' flash' : '';
      const held = S.pos[a.key] ? ' held' : '';
      const notListed = !listed(a, S.g);
      const isToday = a.has[S.g] === 1;
      const m = markOf(a, S.g);
      let priceTxt = '—', chTxt = '', chCls = 'flat';
      if (notListed) { priceTxt = '未上市'; }
      else if (isFinite(m)) {
        priceTxt = px(a, m);
        let pg = S.g;
        while (pg > 0 && a.has[pg] !== 1) pg--;
        let ppg = pg - 1; while (ppg > 0 && a.has[ppg] !== 1) ppg--;
        if (ppg >= 0 && a.has[ppg] === 1) {
          const prev = a.c[a.pos[ppg]];
          const ch = m / prev - 1;
          chCls = cls(ch);
          chTxt = fmtPct(ch);
        }
      }
      if (!isToday && !notListed) chTxt += ' 休市';
      h += '<div class="arow' + on + flash + held + (isToday || notListed ? '' : ' closed') + '" data-k="' + a.key + '">' +
        '<div><div class="nm">' + a.cn + '</div><div class="sub">' + a.en + '</div></div>' +
        '<div><div class="px ' + chCls + '">' + priceTxt + '</div><div class="ch ' + chCls + '">' + chTxt + '</div></div>' +
        '</div>';
    }
    h += '</div>';
  }
  if (!shown) h = '<div class="empty">没有匹配「' + esc(S.filter) + '」的资产</div>';
  const wrap = $('#watch');
  if (wrap) {
    const st = wrap.scrollTop;                     // 重绘不能让滚动位置跳回顶部
    if (h !== watchCache) { wrap.innerHTML = h; watchCache = h; wrap.scrollTop = st; }
    if (S.watchPending) {
      S.watchPending = false;
      scrollElIntoView(wrap, wrap.querySelector('.arow[data-k="' + S.watchKey + '"]'), true);
    }
  }
  const heldN = Object.keys(S.pos).length;
  $('#mkStat').textContent = (q ? shown + ' / ' + DATA.list.length : DATA.list.length + ' 项') +
    (heldN ? ' · 持有 ' + heldN : '') + ' · ' + dstr(S.g);
}
function esc(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, c =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

/* ---------------- 渲染：K线 ---------------- */
let barCache = { key: '', viewN: 0, g: -1, bars: null };

/* 全局日期轴的"天数序号"。区间必须按真实日历天数算：
   日期轴是所有市场交易日的并集，含加密资产的周末，
   若按"下标个数"取，一年会被当成 365 天而不是约 250 个交易日，区间会明显缩水。 */
let _daynum = null;
function dayNum(g) {
  if (!_daynum) {
    _daynum = new Int32Array(ND);
    for (let i = 0; i < ND; i++) {
      _daynum[i] = Math.round(Date.parse(DATA.dates[i] + 'T00:00:00Z') / 86400000);
    }
  }
  return _daynum[g];
}
/* 找出 "gEnd 往前 days 个日历天" 对应的最小全局下标 */
function gStartForDays(gEnd, days) {
  const target = dayNum(gEnd) - days;
  let lo = 0, hi = gEnd;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (dayNum(mid) < target) lo = mid + 1; else hi = mid;
  }
  return lo;
}
function buildBars() {
  const a = DATA.assets[S.sel];
  const gEnd = S.g;
  let gStart = S.viewN > 0 ? gStartForDays(gEnd, S.viewN) : a.d0;
  gStart = Math.max(gStart, a.d0);
  const key = S.sel + '|' + S.viewN + '|' + S.g;
  if (barCache.key === key) return barCache;
  const bars = [];
  for (let g = gStart; g <= gEnd; g++) {
    if (a.has[g] !== 1) continue;
    const k = a.pos[g];
    bars.push({ g: g, k: k, o: a.o[k], h: a.h[k], l: a.l[k], c: a.c[k], v: a.v ? a.v[k] : 0 });
  }
  barCache = { key: key, bars: bars, a: a };
  return barCache;
}
/* 把成交记录映射到当前可见的 K 线下标上 */
function buildMarks(a, bars) {
  if (!S.showMarks || !bars.length) return null;
  const slot = Object.create(null);
  for (let i = 0; i < bars.length; i++) slot[bars[i].g] = i;
  const out = new Array(bars.length);
  let any = false, mx = 0;
  for (let t = 0; t < S.trades.length; t++) {
    const tr = S.trades[t];
    if (tr.key !== a.key) continue;
    const i = slot[tr.g];
    if (i === undefined) continue;
    const act = ACTIONS[tr.action] ? tr.action : (tr.delta > 0 ? 'openLong' : 'openShort');
    const qty = tr.qty !== undefined ? tr.qty : Math.abs(tr.delta);
    const amt = tr.amt || qty * tr.price;
    if (amt > mx) mx = amt;
    (out[i] || (out[i] = [])).push({ action: act, qty: qty, amt: amt, price: tr.price });
    any = true;
  }
  if (!any) return null;
  out.maxAmt = mx;
  return out;
}

function renderChart() {
  const a = DATA.assets[S.sel];
  const bc = buildBars();
  const maKeys = Object.keys(S.ma).filter(m => S.ma[m]).map(Number);
  const marks = buildMarks(a, bc.bars);
  Chart.candles($('#cvMain'), {
    dates: DATA.dates, bars: bc.bars, allCandles: a, ma: maKeys,
    showVol: S.showVol, hover: S.hover, dec: decimalsFor(a),
    marks: marks, markMax: marks ? marks.maxAmt : 0
  });
  // 图例
  const last = bc.bars[bc.bars.length - 1];
  let lg = '<i><b>' + a.cn + '</b> <span class="tx3">' + a.en + '</span></i>';
  if (last) {
    const ch = last.c / last.o - 1;
    lg += '<i>开 <b>' + px(a, last.o) + '</b></i><i>高 <b>' + px(a, last.h) + '</b></i>' +
      '<i>低 <b>' + px(a, last.l) + '</b></i><i>收 <b class="' + cls(ch) + '">' + px(a, last.c) + '</b></i>' +
      '<i>日涨跌 <b class="' + cls(ch) + '">' + fmtPct(ch) + '</b></i>';
  } else lg += '<i class="tx3">未上市</i>';
  for (const m of maKeys) {
    const arr = [];
    for (let i = 0; i < bc.bars.length; i++) {
      const k = bc.bars[i].k;
      if (k >= m - 1) { let s = 0; for (let j = 0; j < m; j++) s += a.c[k - j]; arr.push(s / m); }
    }
    const v = arr.length ? arr[arr.length - 1] : NaN;
    lg += '<i style="color:' + (Chart.MA_COLOR[m] || '#888') + '">MA' + m + ' <b>' + (isFinite(v) ? px(a, v) : '—') + '</b></i>';
  }
  $('#legend').innerHTML = lg;
  let mkTxt = '';
  if (marks) {
    let nb = 0, ns = 0;
    for (let i = 0; i < marks.length; i++) {
      const ms = marks[i]; if (!ms) continue;
      for (const mk of ms) {
        const st = Chart.MK_STYLE[mk.action];
        if (st && st.up) nb++; else ns++;
      }
    }
    mkTxt = ' · 买卖点 ' + (nb + ns) + ' 个（买 ' + nb + ' / 卖 ' + ns + '）';
  }
  const rng = bc.bars.length
    ? DATA.dates[bc.bars[0].g] + ' ~ ' + DATA.dates[bc.bars[bc.bars.length - 1].g] + ' · '
    : '';
  $('#chartInfo').textContent = rng + bc.bars.length + ' 根K线' + mkTxt;
}

/* ---------------- 渲染：资金曲线 ---------------- */
function renderEquity() {
  const n = S.eq.length;
  const my = new Float64Array(n), mk = new Float64Array(n), bm = new Float64Array(n), sp = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    my[i] = isFinite(S.eq[i]) ? S.eq[i] : NaN;
    mk[i] = S.initCash;
    bm[i] = isFinite(S.bench[i]) ? S.bench[i] : NaN;
    sp[i] = (S.benchSPX && isFinite(S.benchSPX[i])) ? S.benchSPX[i] : NaN;
  }
  const series = [
    { name: '我的权益', color: '#e8b339', data: my, width: 2, fill: 'rgba(232,179,57,.16)' },
    { name: '初始资金', color: '#4a5568', data: mk, width: 1, dash: [5, 5] },
  ];
  if (S.showBench) {
    series.push({ name: '等权买入持有', color: '#4c9aff', data: bm, width: 1.4 });
    if (S.benchSPX) series.push({ name: '标普500买入持有', color: '#a78bfa', data: sp, width: 1.4, dash: [3, 3] });
  }
  Chart.lines($('#cvEq'), { labels: DATA.dates, off: S.startG, series: series, log: S.logScale, hover: S.hover });

  const cur = S.eq[n - 1], b = S.bench[n - 1], spv = S.benchSPX ? S.benchSPX[n - 1] : NaN;
  let lg = '<i>我的权益 <b style="color:#e8b339">' + fmtMoney(cur, 0) + '</b> <span class="' + cls(cur / S.initCash - 1) + '">' + fmtPct(cur / S.initCash - 1) + '</span></i>';
  if (S.showBench) {
    lg += '<i>等权基准 <b style="color:#4c9aff">' + fmtPct(b / S.initCash - 1) + '</b></i>';
    if (isFinite(spv)) lg += '<i>标普500 <b style="color:#a78bfa">' + fmtPct(spv / S.initCash - 1) + '</b></i>';
    lg += '<i>超额 <b class="' + cls((cur - b) / S.initCash) + '">' + fmtPct((cur - b) / S.initCash) + '</b></i>';
  }
  $('#legendEq').innerHTML = lg;
  $('#eqInfo').textContent = n + ' 个交易日';
}

/* ---------------- 减仓菜单 ---------------- */
const CLOSE_FRACS = [0.1, 0.25, 0.5, 0.75, 1];
const CLOSE_NAMES = ['10%', '25%', '50%', '75%', '全部'];
let closeMenuFor = null;

function closeCloseMenu() {
  const el = $('#popClose');
  if (el) el.classList.remove('on');
  closeMenuFor = null;
}
function openCloseMenu(k, side, anchor) {
  const el = $('#popClose');
  const a = DATA.assets[k], p = S.pos[k];
  if (!el || !a || !p || !(p[side].qty > 1e-9)) return;
  const m = markOf(a, S.g), leg = p[side];
  const val = isFinite(m) ? leg.qty * m : NaN;
  closeMenuFor = { k: k, side: side };
  el.innerHTML = '<div class="pmhd">平' + LEGCN[side] + ' · ' + a.cn + '</div>' +
    '<div class="pmq">持有 ' + leg.qty.toFixed(4) + ' @ ' + px(a, leg.avg) +
      (isFinite(val) ? ' · 市值 ' + fmtMoney(val, 0) : '') + '</div>' +
    '<div class="pmbtns">' + CLOSE_FRACS.map((f, i) =>
      '<button data-frac="' + f + '" title="平掉 ' + (leg.qty * f).toFixed(4) + ' 份">' +
      CLOSE_NAMES[i] + '</button>').join('') + '</div>';
  el.classList.add('on');
  if (anchor && anchor.getBoundingClientRect) {
    const r = anchor.getBoundingClientRect();
    const w = el.offsetWidth || 232, h = el.offsetHeight || 96;
    const vw = (typeof window !== 'undefined' && window.innerWidth) || 1440;
    const vh = (typeof window !== 'undefined' && window.innerHeight) || 900;
    let x = Math.round(r.right - w), y = Math.round(r.bottom + 6);
    if (x < 6) x = 6;
    if (x + w > vw - 6) x = Math.max(6, vw - w - 6);
    if (y + h > vh - 6) y = Math.round(r.top - h - 6);
    if (y < 6) y = 6;
    el.style.left = x + 'px'; el.style.top = y + 'px';
  }
}
function doPartialClose(k, side, frac) {
  const a = DATA.assets[k], p = S.pos[k];
  closeCloseMenu();
  if (!p || !(p[side].qty > 1e-9)) return;
  if (!tradable(a, S.g)) return toast('今日休市，无法平仓', 'bad');
  const act = side === 'long' ? 'closeLong' : 'closeShort';
  const r = execFill(k, act, p[side].qty * frac, a.c[a.pos[S.g]]);
  if (!r) return toast('减仓数量过小', 'bad');
  recordEquity(); saveNow(); renderAll();
  toast('已减' + LEGCN[side] + ' ' + (frac * 100).toFixed(0) + '% · ' + a.cn +
    '，实现盈亏 ' + fmtMoney(r.pnl, 2), 'ok');
}

/* ---------------- 渲染：当前标的的持仓条（最右栏） ---------------- */
function renderSelPos() {
  const el = $('#selPos');
  if (!el) return;
  const a = DATA.assets[S.sel];
  const p = S.pos[S.sel];
  const m = markOf(a, S.g);
  const has = p && (p.long.qty > 1e-9 || p.short.qty > 1e-9);
  let h = '<div class="hd">当前标的 · <b>' + a.cn + '</b>' +
    (has ? '' : ' <span class="tx3">尚无持仓</span>') + '</div>';
  let rows = '';
  if (p && isFinite(m)) {
    for (const side of ['long', 'short']) {
      const leg = p[side];
      if (!(leg.qty > 1e-9)) continue;
      const val = leg.qty * m;
      const pnl = side === 'long' ? leg.qty * (m - leg.avg) : leg.qty * (leg.avg - m);
      const ret = leg.avg > 0 ? (side === 'long' ? m / leg.avg - 1 : leg.avg / m - 1) : 0;
      rows += '<div class="selrow">' +
        '<span class="tag ' + side + '">' + LEGCN[side] + '</span>' +
        '<span class="q">' + leg.qty.toFixed(4) + ' @ ' + px(a, leg.avg) + '</span>' +
        '<span class="v">' + fmtMoney(val, 0) + '</span>' +
        '<span class="g ' + cls(pnl) + '">' + fmtMoney(pnl, 0) + ' (' + fmtPct(ret) + ')</span>' +
        '<button class="mini" data-close="' + S.sel + '|' + side + '" title="平仓 / 减仓（可选比例）">平</button>' +
        '</div>';
    }
  }
  h += rows || ('<div class="none">' +
    (listed(a, S.g) ? '还没有这个标的的持仓 — 用下面的按钮开仓' : '该资产在本局当前日期尚未上市') +
    '</div>');
  el.innerHTML = h;
}

/* ---------------- 联动定位：点资产 → 持仓栏跳过去并高亮 ---------------- */
const FOCUS_MS = 2600;          // 高亮持续时长（略长于 6 次闪烁的 2.4 秒）

/* 把 el 滚动到 wrap 的中间。
   注意：不能用 el.offsetTop —— 那是相对"最近的定位祖先"算的，
   而 .scroll 容器没有 position，offsetTop 会相对 body，值偏大一大截，
   结果被 clamp 到最底部。这里一律用 getBoundingClientRect 算相对位移。 */
function scrollElIntoView(wrap, el, smooth) {
  if (!wrap || !el || !el.getBoundingClientRect) return;
  const wr = wrap.getBoundingClientRect();
  const er = el.getBoundingClientRect();
  const ch = wrap.clientHeight || wr.height || 0;
  const eh = er.height || el.offsetHeight || 0;
  const max = Math.max(0, (wrap.scrollHeight || 0) - ch);
  // 元素相对"可视区顶部"的偏移 → 加上已滚距离 = 它在内容里的真实位置
  let top = (wrap.scrollTop || 0) + (er.top - wr.top) - (ch - eh) / 2;
  if (!isFinite(top)) return;
  top = Math.max(0, Math.min(max, top));
  if (smooth && wrap.scrollTo) {
    try { wrap.scrollTo({ top: top, behavior: 'smooth' }); return; } catch (e) { }
  }
  wrap.scrollTop = top;
}

/* 在②持仓栏里定位并高亮某个资产的持仓 */
function focusPosition(key) {
  S.focusKey = key; S.focusAt = Date.now(); S.focusPending = true;
  posCache = '';                 // 清缓存，保证重复点同一个也能重放闪烁
  if (_focusTimer) clearTimeout(_focusTimer);
  _focusTimer = setTimeout(() => { S.focusKey = null; renderAll(); }, FOCUS_MS);
}
let _focusTimer = null;

/* 反向：在①标的栏里定位并高亮（点持仓时用） */
function focusWatch(key) {
  S.watchKey = key; S.watchAt = Date.now(); S.watchPending = true;
  watchCache = '';
  if (_watchTimer) clearTimeout(_watchTimer);
  _watchTimer = setTimeout(() => { S.watchKey = null; renderAll(); }, FOCUS_MS);
}
let _watchTimer = null;

/* ---------------- 渲染：账户 / 持仓 / 下单 ---------------- */
function renderAccount() {
  const eq = totalEquity(), avail = availableCash();
  const gv = grossAt(S.g), upnl = unrealizedAt(S.g);
  const nL = legCount('long'), nS = legCount('short');
  const ret = eq / S.initCash - 1;
  $('#hEquity').textContent = fmtMoney(eq, 0);
  $('#hRet').textContent = fmtPct(ret); $('#hRet').className = 'v ' + cls(ret);
  $('#sEquity').textContent = fmtMoney(eq, 2);
  $('#sEquity').className = 'n';
  $('#sReturn').innerHTML = '<span class="' + cls(ret) + '">' + fmtPct(ret) + '</span> <span class="tx3">· 累计 ' + (S.g - S.startG) + ' 交易日</span>';
  $('#sCash').textContent = fmtMoney(avail, 0);
  $('#sCash').className = 'v' + (avail < 0 ? ' up' : '');
  $('#sLong').textContent = fmtMoney(gv.long, 0) + (nL ? '  ×' + nL : '');
  $('#sLong').className = 'v ' + (gv.long > 0 ? 'up' : '');
  $('#sShort').textContent = fmtMoney(gv.short, 0) + (nS ? '  ×' + nS : '');
  $('#sShort').className = 'v ' + (gv.short > 0 ? 'down' : '');
  $('#sNet').textContent = (gv.net >= 0 ? '+' : '') + fmtMoney(gv.net, 0);
  $('#sNet').className = 'v ' + cls(gv.net);
  const gross = gv.long + gv.short;
  $('#sUpnl').textContent = fmtMoney(upnl, 0) + (gross > 0 ? '  (' + fmtPct(upnl / gross) + ')' : '');
  $('#sUpnl').className = 'v ' + cls(upnl);
  $('#sRpnl').textContent = fmtMoney(S.realized, 0);
  $('#sRpnl').className = 'v ' + cls(S.realized);
  $('#sFee').textContent = fmtMoney(S.fees, 0);
  $('#sFee').className = 'v tx2';
}

function legRow(k, side, a, m, eq) {
  const leg = S.pos[k][side];
  const val = leg.qty * m;
  const weight = eq > 0 ? Math.abs(val) / eq : 0;
  const pnl = side === 'long' ? leg.qty * (m - leg.avg) : leg.qty * (leg.avg - m);
  const ret = leg.avg > 0 ? (side === 'long' ? m / leg.avg - 1 : leg.avg / m - 1) : 0;
  return '<div class="posrow" data-k="' + k + '">' +
    '<div class="col1"><div class="n ' + (side === 'long' ? 'up' : 'down') + '">' + LEGCN[side] + '</div>' +
    '<div class="q">' + leg.qty.toFixed(4) + ' @ ' + px(a, leg.avg) +
      ' · 占 ' + (weight * 100).toFixed(1) + '%</div></div>' +
    '<div class="col2"><div class="p">' + fmtMoney(val, 0) + '</div>' +
    '<div class="g ' + cls(pnl) + '">' + fmtMoney(pnl, 0) + ' (' + fmtPct(ret) + ')</div></div>' +
    '<button class="mini" data-close="' + k + '|' + side + '" title="平仓 / 减仓（可选比例）">平</button>' +
    '</div>';
}

function renderPositions() {
  const keys = Object.keys(S.pos).filter(hasAnyPos);
  if (!keys.length) {
    $('#posWrap').innerHTML = '<div class="empty">暂无持仓<br><span class="tx3">从左侧选资产，右侧可同时开多与开空</span></div>';
    posCache = '';
    S.focusPending = false;
    $('#posStat').textContent = '';
    return;
  }
  const gv = grossAt(S.g), eq = totalEquity();
  let h = '';
  for (const k of keys) {
    const a = DATA.assets[k], p = S.pos[k], m = markOf(a, S.g);
    const both = p.long.qty > 0 && p.short.qty > 0;
    const net = (p.long.qty - p.short.qty) * m;
    const isSel = k === S.sel;
    const flash = isSel && S.focusKey === k && (Date.now() - S.focusAt) < FOCUS_MS;
    h += '<div class="posgrp' + (both ? ' both' : '') + (isSel ? ' sel' : '') +
      (flash ? ' flash' : '') + '" data-k="' + k + '">' +
      '<div class="poshd" data-k="' + k + '">' + a.cn +
      (both ? '<span class="badge">双向</span>' : '') +
      '<span class="net">净 ' + (net >= 0 ? '+' : '') + fmtMoney(net, 0) + '</span></div>';
    if (p.long.qty > 0) h += legRow(k, 'long', a, m, eq);
    if (p.short.qty > 0) h += legRow(k, 'short', a, m, eq);
    h += '</div>';
  }
  const pw = $('#posWrap');
  if (pw) {
    const st = pw.scrollTop;                       // 关键：重绘后恢复滚动位置
    if (h !== posCache) { pw.innerHTML = h; posCache = h; pw.scrollTop = st; }
    if (S.focusPending) {
      S.focusPending = false;
      scrollElIntoView(pw, pw.querySelector('.posgrp[data-k="' + S.focusKey + '"]'), true);
    }
  }
  $('#posStat').textContent = keys.length + ' 个资产 · 多 ' + fmtMoney(gv.long, 0) + ' / 空 ' + fmtMoney(gv.short, 0);
}

function renderOrder() {
  const a = DATA.assets[S.sel];
  const listedNow = listed(a, S.g), tradableNow = tradable(a, S.g);
  $('#oName').textContent = a.cn;
  $('#oCode').textContent = a.en + ' · ' + a.src;
  const m = markOf(a, S.g);
  $('#oPrice').textContent = listedNow ? px(a, m) : '未上市';
  let ch = NaN;
  if (listedNow) {
    let pg = S.g; while (pg > 0 && a.has[pg] !== 1) pg--;
    let ppg = pg - 1; while (ppg > 0 && a.has[ppg] !== 1) ppg--;
    if (ppg >= 0 && a.has[ppg] === 1) ch = m / a.c[a.pos[ppg]] - 1;
  }
  $('#oChange').innerHTML = isFinite(ch) ? '<span class="' + cls(ch) + '">' + fmtPct(ch) + ' 今日</span>' : '<span class="tx3">—</span>';

  const A = ACTIONS[S.side];
  const p = S.pos[S.sel];
  const legQty = p ? p[A.dir].qty : 0;
  const btn = $('#btnSubmit');
  if (A.open) {
    btn.textContent = (S.side === 'openLong' ? '开多（买入）' : '开空（卖出）') + ' ' + a.cn;
    btn.className = 'submit' + (S.side === 'openLong' ? '' : ' sellmode');
  } else {
    btn.textContent = A.label + ' ' + (S.closeFrac * 100).toFixed(0) + '% · ' + a.cn;
    btn.className = 'submit closemode';
  }
  btn.disabled = !tradableNow || S.over || (!A.open && !(legQty > 1e-9));
  // 关闭做空时禁用"开空"按钮
  $$('#segSide button[data-s="openShort"]').forEach(x => {
    x.disabled = !S.allowShort;
    x.title = S.allowShort ? '' : '本局已关闭做空';
  });

  const avail = availableCash();
  const inAmt = $('#inAmt');
  if (A.open) {
    inAmt.readOnly = false;
  } else {
    inAmt.readOnly = true;
    inAmt.value = (legQty > 1e-9 && isFinite(m)) ? Math.round(legQty * m * S.closeFrac) : 0;
  }

  let hint = '';
  if (!listedNow) hint = '<span class="warn">该资产在 ' + dstr(S.g) + ' 尚未上市</span>';
  else if (!tradableNow) hint = '<span class="warn">今日休市，无法交易（可继续持有）</span>';
  else if (!A.open) {
    if (!(legQty > 1e-9)) hint = '<span class="warn">当前没有' + LEGCN[A.dir] + '持仓</span>';
    else {
      const leg = p[A.dir];
      const pnl = A.dir === 'long' ? leg.qty * (m - leg.avg) : leg.qty * (leg.avg - m);
      const held = (p.long.qty > 0 && p.short.qty > 0)
        ? '<br><span class="warn">该资产为双向持仓：多 ' + p.long.qty.toFixed(4) + ' / 空 ' + p.short.qty.toFixed(4) + '</span>' : '';
      hint = LEGCN[A.dir] + ' ' + leg.qty.toFixed(4) + ' 份 @ ' + px(a, leg.avg) +
        ' · 市值 ' + fmtMoney(leg.qty * m, 0) +
        ' · 浮动 <span class="' + cls(pnl) + '">' + fmtMoney(pnl, 2) + '</span>' + held;
    }
  } else {
    const openAmt = parseFloat(inAmt.value) || 0;
    const fee = openAmt * S.feeRate;
    const held = [];
    if (p && p.long.qty > 0) held.push('多 ' + p.long.qty.toFixed(4));
    if (p && p.short.qty > 0) held.push('空 ' + p.short.qty.toFixed(4));
    hint = '可用资金 ' + fmtMoney(avail, 0) +
      ' · ' + (S.side === 'openLong' ? '最多可开多 ' : '最多可开空 ') + fmtMoney(maxOpenNotional(S.side), 0) +
      (S.side === 'openShort' ? '（保证金 ' + (MARGIN_RATE * 100) + '%）' : '') +
      '<br>成交价按当日收盘 ' + px(a, m) + ' · 手续费 ' + (S.feeRate * 100).toFixed(3) +
      '%（约 ' + fmtMoney(fee, 2) + '）' +
      (held.length ? '<br>已有持仓：' + held.join(' / ') + '（双向持仓，互不抵消）' : '');
  }
  $('#ordHint').innerHTML = hint;
}

/* ---------------- 渲染：成交记录 / 统计 ---------------- */
function renderTrades() {
  const t = S.trades;
  if (!t.length) { $('#tradeWrap').innerHTML = '<div class="empty">还没有成交记录</div>'; return; }
  let h = '<table><thead><tr><th>日期</th><th>资产</th><th>操作</th><th>数量</th><th>价格</th><th>成交额</th><th>手续费</th></tr></thead><tbody>';
  for (let i = t.length - 1; i >= 0; i--) {
    const x = t[i], a = DATA.assets[x.key];
    const A = ACTIONS[x.action] || { label: (x.delta > 0 ? '买入' : '卖出'), dir: x.delta > 0 ? 'long' : 'short', open: x.delta > 0 };
    const q = x.qty !== undefined ? x.qty : Math.abs(x.delta);
    h += '<tr><td>' + dstr(x.g) + '</td><td class="nm">' + x.cn + '</td>' +
      '<td class="' + (A.dir === 'long' ? 'up' : 'down') + '">' + A.label + '</td>' +
      '<td>' + q.toFixed(4) + '</td>' +
      '<td>' + px(a, x.price) + '</td><td>' + fmtMoney(x.amt, 0) + '</td><td class="tx3">' + fmtMoney(x.fee, 2) + '</td></tr>';
  }
  $('#tradeWrap').innerHTML = h + '</tbody></table>';
}

function maxDrawdown(arr) {
  let peak = -Infinity, mdd = 0, at = 0;
  for (let i = 0; i < arr.length; i++) {
    const v = arr[i]; if (!isFinite(v)) continue;
    if (v > peak) peak = v;
    const dd = v / peak - 1;
    if (dd < mdd) { mdd = dd; at = i; }
  }
  return { mdd: mdd, at: at };
}
function renderStats() {
  const n = S.eq.length, eq = S.eq[n - 1] || S.initCash;
  const days = Math.max(1, S.g - S.startG);
  const yrs = days / 252;
  const totalRet = eq / S.initCash - 1;
  const ann = yrs > 0.02 ? Math.pow(eq / S.initCash, 1 / yrs) - 1 : totalRet;
  const dd = maxDrawdown(S.eq);
  const bench = S.bench[n - 1], spx = S.benchSPX ? S.benchSPX[n - 1] : NaN;
  const wins = S.closes.filter(c => c.pnl > 0), loses = S.closes.filter(c => c.pnl <= 0);
  const avgW = wins.length ? wins.reduce((a, b) => a + b.pnl, 0) / wins.length : 0;
  const avgL = loses.length ? loses.reduce((a, b) => a + b.pnl, 0) / loses.length : 0;
  const gross = wins.reduce((a, b) => a + b.pnl, 0), loss = -loses.reduce((a, b) => a + b.pnl, 0);
  const pf = loss > 0 ? gross / loss : (gross > 0 ? Infinity : 0);
  // 年化波动 + 夏普（按日收益）
  const rets = [];
  for (let i = 1; i < n; i++) if (isFinite(S.eq[i]) && isFinite(S.eq[i - 1]) && S.eq[i - 1] > 0) rets.push(S.eq[i] / S.eq[i - 1] - 1);
  const mean = rets.length ? rets.reduce((a, b) => a + b, 0) / rets.length : 0;
  const varr = rets.length > 1 ? rets.reduce((a, b) => a + (b - mean) * (b - mean), 0) / (rets.length - 1) : 0;
  const vol = Math.sqrt(varr) * Math.sqrt(252);
  const sharpe = vol > 0 ? (mean * 252) / vol : 0;
  const calmar = dd.mdd < 0 ? ann / Math.abs(dd.mdd) : 0;

  const gv = grossAt(S.g);
  const upnl = unrealizedAt(S.g);
  const nL = legCount('long'), nS = legCount('short');

  const C = (l, v, c, s, wide) => '<div class="card' + (wide ? ' wide' : '') + '"><div class="l">' + l + '</div>' +
    '<div class="v ' + (c || '') + '">' + v + '</div>' + (s ? '<div class="s">' + s + '</div>' : '') + '</div>';

  let h = '<div class="cards">';
  h += C('总权益', fmtMoney(eq, 0), cls(totalRet), '初始 ' + fmtMoney(S.initCash, 0));
  h += C('总收益率', fmtPct(totalRet), cls(totalRet), '年化 ' + fmtPct(ann));
  h += C('最大回撤', fmtPct(dd.mdd), 'down', dd.at > 0 ? '发生于 ' + dstr(S.startG + dd.at) : '');
  h += C('夏普比率', sharpe.toFixed(2), cls(sharpe), '年化波动 ' + fmtPct(vol));
  h += C('Calmar', isFinite(calmar) ? calmar.toFixed(2) : '—', cls(calmar), '年化/最大回撤');
  h += C('已实现盈亏', fmtMoney(S.realized, 0), cls(S.realized), '浮动 ' + fmtMoney(upnl, 0));
  h += C('多头市值', fmtMoney(gv.long, 0), gv.long > 0 ? 'up' : '', nL + ' 条多头持仓');
  h += C('空头市值', fmtMoney(gv.short, 0), gv.short > 0 ? 'down' : '', nS + ' 条空头持仓');
  h += C('净头寸', fmtMoney(gv.net, 0), cls(gv.net), '多头 − 空头 市值');
  h += C('双向持仓', String(Object.keys(S.pos).filter(k => hasLeg(k, 'long') && hasLeg(k, 'short')).length),
    '', '同时持有多空的资产数');
  h += C('累计手续费', fmtMoney(S.fees, 0), 'tx2', '占初始资金 ' + fmtPct(S.fees / S.initCash));
  h += C('交易笔数', String(S.trades.length), '', '平仓 ' + S.closes.length + ' 次');
  h += C('胜率', S.closes.length ? fmtPct(wins.length / S.closes.length) : '—', wins.length >= loses.length ? 'up' : 'down',
    wins.length + ' 胜 / ' + loses.length + ' 负');
  h += C('盈亏比', isFinite(pf) ? pf.toFixed(2) : '∞', cls(pf - 1), '平均盈 ' + fmtMoney(avgW, 0) + ' / 亏 ' + fmtMoney(avgL, 0));
  h += C('等权基准', fmtPct(bench / S.initCash - 1), cls(bench / S.initCash - 1), '买入持有全部资产');
  h += C('超额收益', fmtPct((eq - bench) / S.initCash), cls(eq - bench), '相对等权基准');
  if (isFinite(spx)) h += C('标普500基准', fmtPct(spx / S.initCash - 1), cls(spx / S.initCash - 1), '同期买入持有');
  h += C('已走时间', days + ' 交易日', '', Math.floor(days / 21) + ' 个月 · 约 ' + yrs.toFixed(2) + ' 年');
  h += C('当前日期', dstr(S.g), '', '起始 ' + dstr(S.startG));
  h += '</div>';

  const closes = S.closes.slice(-12).reverse();
  if (closes.length) {
    h += '<div class="ph" style="background:transparent;border-top:1px solid var(--line)"><span>最近平仓明细</span></div>';
    h += '<table><thead><tr><th>日期</th><th>资产</th><th>方向</th><th>数量</th><th>开仓均价</th><th>平仓价</th><th>盈亏</th></tr></thead><tbody>';
    for (const c of closes) {
      const a = DATA.assets[c.key];
      h += '<tr><td>' + dstr(c.g) + '</td><td class="nm">' + a.cn + '</td>' +
        '<td class="' + (c.dir === 'long' ? 'up' : 'down') + '">' + (c.dir === 'long' ? '平多' : '平空') + '</td>' +
        '<td>' + c.qty.toFixed(4) + '</td><td>' + px(a, c.avg) + '</td><td>' + px(a, c.price) + '</td>' +
        '<td class="' + cls(c.pnl) + '">' + fmtMoney(c.pnl, 2) + '</td></tr>';
    }
    h += '</tbody></table>';
  }
  $('#statsWrap').innerHTML = h;
}

/* ---------------- 渲染：持仓分析 ---------------- */
function anBar(label, pct, val, sub, color) {
  const w = Math.max(0, Math.min(100, pct * 100));
  return '<div class="anbar"><span class="lb">' + label + '</span>' +
    '<span class="tr"><i style="width:' + w.toFixed(2) + '%;background:' + color + '"></i></span>' +
    '<span class="vl">' + (pct * 100).toFixed(2) + '%</span>' +
    '<span class="v2">' + (sub === undefined ? '' : sub) + '</span></div>';
}

function renderAnalysis() {
  const el = $('#analysisWrap');
  if (!el) return;
  const eq = totalEquity();
  const gv = grossAt(S.g);
  const gross = gv.long + gv.short;
  const cash = S.cash;
  const assetBase = cash + gv.long;          // 资产端 = 现金 + 多头市值
  const safe = v => (isFinite(v) && v > 0) ? v : 0;

  // 收集每条腿
  const legs = [];
  const byCat = {};
  for (const k in S.pos) {
    const a = DATA.assets[k], p = S.pos[k], m = markOf(a, S.g);
    if (!isFinite(m)) continue;
    for (const side of ['long', 'short']) {
      const leg = p[side];
      if (!(leg.qty > 1e-9)) continue;
      const mv = leg.qty * m;
      const pnl = side === 'long' ? leg.qty * (m - leg.avg) : leg.qty * (leg.avg - m);
      legs.push({ k: k, a: a, side: side, qty: leg.qty, avg: leg.avg, m: m,
                  mv: mv, pnl: pnl, wEq: eq > 0 ? mv / eq : 0,
                  wAs: assetBase > 0 ? mv / assetBase : 0 });
      byCat[a.cat] = (byCat[a.cat] || 0) + mv;
    }
  }
  legs.sort((x, y) => y.mv - x.mv);

  if (!legs.length) {
    el.innerHTML = '<div class="anempty">还没有任何持仓<br>' +
      '<span class="tx3">从①选资产，在③下单后，这里会显示配置占比、类别分布与盈亏贡献</span></div>';
    return;
  }

  const upnl = legs.reduce((s, x) => s + x.pnl, 0);
  const longMV = gv.long, shortMV = gv.short;
  const netMV = longMV - shortMV;
  const lev = eq > 0 ? gross / eq : 0;
  const cashW = assetBase > 0 ? cash / assetBase : 0;

  // 集中度
  const ws = legs.map(x => x.wEq).sort((a, b) => b - a);
  const top1 = ws.length ? ws[0] : 0;
  const top3 = ws.slice(0, 3).reduce((a, b) => a + b, 0);
  const hhi = ws.reduce((a, b) => a + b * b, 0);

  const card = (l, v, c, s) => '<div class="card"><div class="l">' + l + '</div>' +
    '<div class="v ' + (c || '') + '">' + v + '</div>' + (s ? '<div class="s">' + s + '</div>' : '') + '</div>';

  let h = '';

  /* ---- 概览 ---- */
  h += '<div class="ancard"><div class="anh">概览 <span class="note">按每条持仓腿独立统计（双向持仓）</span></div>';
  h += '<div class="cards" style="padding:0">';
  h += card('总权益', fmtMoney(eq, 0), cls(eq / S.initCash - 1), '初始 ' + fmtMoney(S.initCash, 0));
  h += card('总敞口', fmtMoney(gross, 0), '', '杠杆 ' + lev.toFixed(2) + '× （敞口/权益）');
  h += card('净敞口', (netMV >= 0 ? '+' : '') + fmtMoney(netMV, 0), cls(netMV),
    eq > 0 ? '占权益 ' + fmtPct(netMV / eq) : '');
  h += card('浮动盈亏', fmtMoney(upnl, 0), cls(upnl),
    eq > 0 ? '占权益 ' + fmtPct(upnl / eq) : '');
  h += card('持仓', legs.length + ' 条腿', '', Object.keys(S.pos).length + ' 个资产');
  h += card('最大单一', fmtPct(top1), top1 > 0.3 ? 'up' : '', '占权益比');
  h += card('Top3 集中度', fmtPct(top3), top3 > 0.6 ? 'up' : '', '前三名合计占权益');
  h += card('HHI', hhi.toFixed(4), hhi > 0.25 ? 'up' : '', '越高越集中（>0.25 偏集中）');
  h += '</div></div>';

  /* ---- 资产配置（占资产端，合计 100%） ---- */
  let cfg = anBar('<span class="tx2">现金</span>', cashW, '', fmtMoney(cash, 0), '#6b7a8d');
  for (const x of legs) {
    if (x.side !== 'long') continue;
    const col = x.pnl >= 0 ? '#f0433f' : '#e0665f';
    cfg += anBar(esc(x.a.cn), x.wAs, '', fmtMoney(x.mv, 0), col);
  }
  cfg += '<div class="anbar total"><span class="lb">合计</span><span class="tr"></span>' +
    '<span class="vl">100.00%</span><span class="v2">' + fmtMoney(assetBase, 0) + '</span></div>';
  h += '<div class="ancard"><div class="anh">资产配置 <span class="note">资产端 = 现金 + 多头市值，合计 100%</span></div>' + cfg + '</div>';

  /* ---- 空头敞口 + 类别分布 ---- */
  h += '<div class="ancols">';
  let shr = '';
  const shorts = legs.filter(x => x.side === 'short');
  if (shorts.length) {
    for (const x of shorts) shr += anBar(esc(x.a.cn), x.wEq, '', fmtMoney(x.mv, 0), '#12b76a');
    shr += '<div class="anbar total"><span class="lb">空头合计</span><span class="tr"></span>' +
      '<span class="vl">' + (eq > 0 ? (shortMV / eq * 100).toFixed(2) : '0.00') + '%</span>' +
      '<span class="v2">' + fmtMoney(shortMV, 0) + '</span></div>';
  } else shr = '<div class="anempty" style="padding:14px">当前没有空头持仓</div>';
  h += '<div class="ancard" style="margin:0 0 0 12px"><div class="anh">空头敞口 <span class="note">占权益比（保证金占用 50%）</span></div>' + shr + '</div>';

  let cat = '';
  const catKeys = Object.keys(byCat).sort((a, b) => byCat[b] - byCat[a]);
  const catCol = { '股指': '#4c9aff', '商品': '#e8b339', '汇率': '#a78bfa', '加密': '#39c0c8', '债券': '#8e44ad' };
  for (const c of catKeys) {
    cat += anBar(c, gross > 0 ? byCat[c] / gross : 0, '', fmtMoney(byCat[c], 0), catCol[c] || '#6b7a8d');
  }
  cat += '<div class="anbar total"><span class="lb">合计</span><span class="tr"></span>' +
    '<span class="vl">100.00%</span><span class="v2">' + fmtMoney(gross, 0) + '</span></div>';
  h += '<div class="ancard" style="margin:0 12px 0 0"><div class="anh">类别分布 <span class="note">按总敞口（多空绝对值）汇总</span></div>' + cat + '</div>';
  h += '</div>';

  /* ---- 盈亏贡献 ---- */
  const ranked = legs.slice().sort((a, b) => b.pnl - a.pnl);
  const maxAbs = Math.max.apply(null, ranked.map(x => Math.abs(x.pnl)).concat([1]));
  let pl = '';
  for (const x of ranked) {
    const w = Math.abs(x.pnl) / maxAbs * 100;
    const col = x.pnl >= 0 ? '#f0433f' : '#12b76a';
    pl += '<div class="anbar"><span class="lb">' +
      '<span class="tag ' + x.side + '">' + (x.side === 'long' ? '多' : '空') + '</span>' +
      esc(x.a.cn) + '</span>' +
      '<span class="tr"><i style="width:' + w.toFixed(1) + '%;background:' + col + '"></i></span>' +
      '<span class="vl ' + cls(x.pnl) + '">' + fmtMoney(x.pnl, 0) + '</span>' +
      '<span class="v2">' + (eq > 0 ? fmtPct(x.pnl / eq) : '') + '</span></div>';
  }
  h += '<div class="ancard"><div class="anh">盈亏贡献 <span class="note">按浮动盈亏排序，条长代表金额绝对值</span></div>' + pl + '</div>';

  /* ---- 明细表 ---- */
  h += '<div class="ancard"><div class="anh">持仓明细</div>';
  h += '<table class="antbl"><thead><tr><th>资产</th><th>类别</th><th>方向</th><th>数量</th>' +
    '<th>开仓均价</th><th>现价</th><th>市值</th><th>占权益</th><th>占资产</th><th>浮动盈亏</th><th>收益率</th></tr></thead><tbody>';
  for (const x of legs) {
    const ret = x.avg > 0 ? (x.side === 'long' ? x.m / x.avg - 1 : x.avg / x.m - 1) : 0;
    h += '<tr><td class="nm">' + esc(x.a.cn) + '</td><td class="tx3">' + x.a.cat + '</td>' +
      '<td class="' + (x.side === 'long' ? 'up' : 'down') + '">' + (x.side === 'long' ? '多头' : '空头') + '</td>' +
      '<td>' + x.qty.toFixed(4) + '</td><td>' + px(x.a, x.avg) + '</td><td>' + px(x.a, x.m) + '</td>' +
      '<td>' + fmtMoney(x.mv, 0) + '</td>' +
      '<td>' + (x.wEq * 100).toFixed(2) + '%</td>' +
      '<td>' + (x.side === 'long' ? (x.wAs * 100).toFixed(2) + '%' : '—') + '</td>' +
      '<td class="' + cls(x.pnl) + '">' + fmtMoney(x.pnl, 2) + '</td>' +
      '<td class="' + cls(ret) + '">' + fmtPct(ret) + '</td></tr>';
  }
  h += '</tbody></table></div>';

  el.innerHTML = h;
}

/* ============================================================
   投资组合：自定义成分与目标权重，整组加仓 / 减仓
   ============================================================ */
/* 浏览器里有原生弹窗；无界面环境（自动化测试）下退化为直接确认 */
function pfConfirm(msg) { return (typeof confirm === 'function') ? confirm(msg) : true; }
function pfPrompt(msg, def) {
  if (typeof prompt !== 'function') return def;
  const v = prompt(msg, def);
  return (v === null || v === undefined) ? null : v;
}
function pfEnsure() {
  if (!Array.isArray(UI.pfolios) || !UI.pfolios.length) {
    UI.pfolios = [{ id: 'p1', name: '组合一', items: [] }];
  }
  for (const p of UI.pfolios) {
    if (!Array.isArray(p.items)) p.items = [];
    p.items = p.items.filter(it => it && DATA.assets[it.k]);   // 清掉已下架的成分
  }
  if (!UI.pfolios.some(p => p.id === UI.pfCur)) UI.pfCur = UI.pfolios[0].id;
  return UI.pfolios.find(p => p.id === UI.pfCur);
}
function pfSave() { saveUI(); }
function pfTotalW(pf) { return pf.items.reduce((s, it) => s + (it.w > 0 ? it.w : 0), 0); }
function pfNewId() { return 'p' + Date.now().toString(36) + Math.floor(Math.random() * 1000); }

/* 整组加仓：按目标权重把金额分配到每个可交易成分 */
function pfOpen(amount) {
  const pf = pfEnsure();
  const items = pf.items.filter(it => DATA.assets[it.k] && it.w > 0);
  if (!items.length) return toast('组合里还没有配置资产', 'bad');
  if (!(amount > 0)) return toast('请输入投入金额', 'bad');
  const tradableItems = items.filter(it => tradable(DATA.assets[it.k], S.g));
  if (!tradableItems.length) return toast('组合内资产今日全部休市', 'bad');

  const avail = Math.max(0, availableCash());
  const maxAmt = avail / (1 + S.feeRate);
  let amt = amount, capped = false;
  if (amt > maxAmt) { amt = maxAmt; capped = true; }
  if (amt < 1) return toast('可用资金不足（' + fmtMoney(avail, 0) + '）', 'bad');

  const W = tradableItems.reduce((s, it) => s + it.w, 0);
  let done = 0, spent = 0;
  for (const it of tradableItems) {
    const a = DATA.assets[it.k];
    const price = a.c[a.pos[S.g]];
    const part = amt * it.w / W;
    if (part < 1) continue;
    const r = execFill(it.k, 'openLong', part / price, price);
    if (r) { done++; spent += r.ex * price; }
  }
  recordEquity(); saveNow(); renderAll();
  const skipped = items.length - tradableItems.length;
  toast('组合加仓：' + done + ' 个资产 / 投入 ' + fmtMoney(spent, 0) +
    (capped ? '（按可用资金封顶）' : '') +
    (skipped ? '，' + skipped + ' 个今日休市已跳过' : ''), 'ok');
}

/* 整组减仓：每个有多头的成分按比例平掉一部分 */
function pfReduce(frac, label) {
  const pf = pfEnsure();
  if (!pf.items.length) return toast('组合里还没有配置资产', 'bad');
  let done = 0, got = 0, pnl = 0, skipped = 0;
  for (const it of pf.items) {
    const k = it.k, a = DATA.assets[k], p = S.pos[k];
    if (!a || !p || !(p.long.qty > 1e-9)) continue;
    if (!tradable(a, S.g)) { skipped++; continue; }
    const r = execFill(k, 'closeLong', p.long.qty * frac, a.c[a.pos[S.g]]);
    if (r) { done++; got += r.ex * r.price; pnl += r.pnl; }
  }
  if (!done) return toast('组合内没有可减仓的多头持仓' + (skipped ? '（' + skipped + ' 个休市）' : ''), 'bad');
  recordEquity(); saveNow(); renderAll();
  toast('组合' + (label || '减仓') + '：' + done + ' 个资产 / 收回 ' + fmtMoney(got, 0) +
    ' / 实现盈亏 ' + fmtMoney(pnl, 2) + (skipped ? '，' + skipped + ' 个休市跳过' : ''), 'ok');
}

function renderPfolios() {
  const el = $('#pfWrap');
  if (!el) return;
  const pf = pfEnsure();
  const eq = totalEquity();
  const W = pfTotalW(pf);
  const avail = Math.max(0, availableCash());
  const maxAmt = avail / (1 + S.feeRate);

  let h = '';

  /* ---- 组合选择 ---- */
  h += '<div class="pfcard"><div class="anh">投资组合' +
    '<span class="note">成分与权重保存在本地，跨局沿用</span></div>';
  h += '<div class="pftabs">';
  for (const p of UI.pfolios) {
    h += '<span class="pf' + (p.id === pf.id ? ' on' : '') + '" data-pfsel="' + p.id + '">' +
      esc(p.name) + ' <span class="tx3">' + p.items.length + '</span>' +
      (UI.pfolios.length > 1 ? '<span class="del" data-pfdel="' + p.id + '" title="删除这个组合">✕</span>' : '') +
      '</span>';
  }
  h += '<button class="mini" data-pfnew="1" title="新建一个组合">+ 新建</button>';
  h += '<button class="mini" data-pfrename="1" title="重命名当前组合">改名</button>';
  if (S.pos && Object.keys(S.pos).length) {
    h += '<button class="mini" data-pffrompos="1" title="按当前持仓市值生成权重">按持仓生成</button>';
  }
  h += '</div></div>';

  /* ---- 成分与权重 ---- */
  h += '<div class="pfcard"><div class="anh">成分与目标权重' +
    '<span class="note">权重合计 <b class="pfsum' + (W > 100.001 ? ' bad' : '') + '" id="pfSum">' +
    W.toFixed(1) + '%</b>（不必等于 100，按比例分配）</span></div>';
  if (!pf.items.length) {
    h += '<div class="anempty" style="padding:18px">还没有成分 —— 从下面选一个资产加进来</div>';
  } else {
    const mx = Math.max.apply(null, pf.items.map(it => it.w).concat([1]));
    for (const it of pf.items) {
      const a = DATA.assets[it.k];
      const p = S.pos[it.k];
      const m = markOf(a, S.g);
      const mv = (p && isFinite(m)) ? p.long.qty * m : 0;
      h += '<div class="pfrow">' +
        '<span class="nm">' + esc(a.cn) + '<span class="cat">' + a.cat + '</span>' +
        (mv > 0 ? '<span class="cat" style="color:var(--gold)">已持有 ' + fmtMoney(mv, 0) + '</span>' : '') +
        '</span>' +
        '<input type="number" data-pfw="' + it.k + '" min="0" max="100" step="1" value="' + it.w + '">' +
        '<span class="tr"><i style="width:' + (it.w / mx * 100).toFixed(1) + '%"></i></span>' +
        '<button class="mini" data-pfrm="' + it.k + '" title="从组合里移除">✕</button>' +
        '</div>';
    }
  }
  const inPf = {};
  for (const it of pf.items) inPf[it.k] = 1;
  const cats = {};
  for (const a of DATA.list) { if (!inPf[a.key]) (cats[a.cat] = cats[a.cat] || []).push(a); }
  h += '<div class="pfadd"><select id="pfAdd"><option value="">选择要加入的资产…</option>';
  for (const c of CAT_ORDER) {
    if (!cats[c]) continue;
    h += '<optgroup label="' + c + '">';
    for (const a of cats[c]) h += '<option value="' + a.key + '">' + esc(a.cn) + '</option>';
    h += '</optgroup>';
  }
  h += '</select><button class="mini" data-pfadd="1">加入组合</button>';
  h += '<span style="width:8px"></span>';
  h += '<button class="mini" data-pfeq="1">等权分配</button>';
  h += '<button class="mini" data-pfnorm="1">归一化到 100%</button>';
  h += '<button class="mini" data-pfclear="1">清空成分</button>';
  h += '</div></div>';

  /* ---- 整组操作 ---- */
  const canBuy = pf.items.some(it => it.w > 0 && tradable(DATA.assets[it.k], S.g));
  const canSell = pf.items.some(it => {
    const p = S.pos[it.k];
    return p && p.long.qty > 1e-9 && tradable(DATA.assets[it.k], S.g);
  });
  h += '<div class="pfcard"><div class="anh">整组操作' +
    '<span class="note">按上面的权重把金额分配到每个可交易成分</span></div>';
  h += '<div class="pfact">' +
    '<div class="field"><label>投入</label>' +
    '<input type="number" id="pfAmt" min="0" step="1000" value="' + (UI.pfAmt || 20000) + '">' +
    '<span class="u">USD</span></div>' +
    '<div class="quicks" id="pfQuicks">' +
    '<button data-pfq="0.1">10%</button><button data-pfq="0.25">25%</button>' +
    '<button data-pfq="0.5">50%</button><button data-pfq="0.75">75%</button>' +
    '<button data-pfq="1">全部可用</button></div>' +
    '</div>';
  h += '<div class="pfact" style="margin-top:10px">' +
    '<button class="pfbtn buy" data-pfopen="1"' + (canBuy ? '' : ' disabled') + '>一键加仓 / 建仓</button>' +
    '<button class="pfbtn sell" data-pfreduce="0.25"' + (canSell ? '' : ' disabled') + '>减仓 25%</button>' +
    '<button class="pfbtn sell" data-pfreduce="0.5"' + (canSell ? '' : ' disabled') + '>减仓 50%</button>' +
    '<button class="pfbtn flat" data-pfreduce="1"' + (canSell ? '' : ' disabled') + '>全部清仓</button>' +
    '</div>';
  h += '<div class="pfhint">可用资金 ' + fmtMoney(avail, 0) +
    '，最多可投入 ' + fmtMoney(maxAmt, 0) + '。加仓按金额与权重的比例分配到每个成分；' +
    '减仓按"每个成分当前持仓的百分比"平仓。<b>今日休市的成分会自动跳过。</b>' +
    '（组合只做多；若某成分另持有空头，不受影响。）</div>';
  h += '</div>';

  /* ---- 该组合的持仓现状 ---- */
  h += '<div class="pfcard"><div class="anh">该组合的持仓现状' +
    '<span class="note">目标权重 vs 实际占比（占权益）</span></div>';
  const rows = [];
  let totMV = 0, totPnL = 0;
  for (const it of pf.items) {
    const a = DATA.assets[it.k], p = S.pos[it.k], m = markOf(a, S.g);
    if (!p || !(p.long.qty > 1e-9) || !isFinite(m)) continue;
    const mv = p.long.qty * m;
    const pnl = p.long.qty * (m - p.long.avg);
    totMV += mv; totPnL += pnl;
    rows.push({ a: a, it: it, mv: mv, pnl: pnl, p: p, m: m });
  }
  if (!rows.length) {
    h += '<div class="anempty" style="padding:18px">该组合目前没有任何持仓 —— 点上面的「一键加仓 / 建仓」</div>';
  } else {
    rows.sort((x, y) => y.mv - x.mv);
    h += '<table class="antbl"><thead><tr><th>资产</th><th>类别</th><th>目标权重</th>' +
      '<th>实际占比</th><th>数量</th><th>开仓均价</th><th>现价</th><th>市值</th><th>浮动盈亏</th></tr></thead><tbody>';
    for (const r of rows) {
      h += '<tr><td class="nm">' + esc(r.a.cn) + '</td><td class="tx3">' + r.a.cat + '</td>' +
        '<td>' + r.it.w.toFixed(1) + '%</td>' +
        '<td>' + (eq > 0 ? (r.mv / eq * 100).toFixed(2) : '0.00') + '%</td>' +
        '<td>' + r.p.long.qty.toFixed(4) + '</td>' +
        '<td>' + px(r.a, r.p.long.avg) + '</td><td>' + px(r.a, r.m) + '</td>' +
        '<td>' + fmtMoney(r.mv, 0) + '</td>' +
        '<td class="' + cls(r.pnl) + '">' + fmtMoney(r.pnl, 2) + '</td></tr>';
    }
    h += '<tr style="font-weight:600"><td class="nm">合计</td><td></td><td></td>' +
      '<td>' + (eq > 0 ? (totMV / eq * 100).toFixed(2) : '0.00') + '%</td><td></td><td></td><td></td>' +
      '<td>' + fmtMoney(totMV, 0) + '</td>' +
      '<td class="' + cls(totPnL) + '">' + fmtMoney(totPnL, 2) + '</td></tr>';
    h += '</tbody></table>';
  }
  h += '</div>';

  el.innerHTML = h;
}

/* ---------------- 总渲染 ---------------- */
let renderPending = false;
function renderAll() {
  if (renderPending) return;
  renderPending = true;
  requestAnimationFrame(() => {
    renderPending = false;
    const cd = $('#curDate');
    if (cd.textContent !== dstr(S.g)) {
      cd.textContent = dstr(S.g);
      cd.classList.remove('flash');
      void cd.offsetWidth;          // 强制重排，让动画能重新播放
      cd.classList.add('flash');
    }
    const nd = S.g - S.startG;
    const base = weekday(S.g) + ' · 第 ' + nd + ' 个交易日 · ';
    if (S.over) {
      $('#curSub').innerHTML = base + '<b style="color:var(--gold)">本局已结束 · 点 ⚙ 重新开局</b>';
    } else if (!S.playing) {
      $('#curSub').innerHTML = base + '<b style="color:var(--gold)">⏸ 已暂停 · 点 ▶ 继续，或点 ⏭ 单步</b>';
    } else {
      $('#curSub').textContent = base + '运行中';
    }
    renderWatch(); renderAccount(); renderPositions(); renderOrder(); renderSelPos();
    if (S.tab === 'chart' || S.tab === 'equity') syncViewUI();
    if (S.tab === 'chart') renderChart();
    else if (S.tab === 'equity') renderEquity();
    else if (S.tab === 'trades') renderTrades();
    else if (S.tab === 'stats') renderStats();
    else if (S.tab === 'analysis') renderAnalysis();
    else renderPfolios();
  });
}

/* ---------------- 存档 ---------------- */
let STORAGE_OK = true;
try { localStorage.setItem('__t', '1'); localStorage.removeItem('__t'); }
catch (e) { STORAGE_OK = false; }
let _lastSave = 0;
function saveNow() { _lastSave = Date.now(); save(); }
let _saveWarned = false;
/* 存档结构版本。规则（R2）：只增字段不删字段；改结构必须写迁移。 */
const SAVE_V = 2;

function save() {
  if (!STORAGE_OK) {
    if (!_saveWarned) { _saveWarned = true; toast('浏览器不允许本地存档，本局进度不会被保留', 'bad'); }
    return;
  }
  try {
    localStorage.setItem(LS, JSON.stringify({
      v: SAVE_V,
      /* —— 游戏进度 —— */
      g: S.g, startG: S.startG, cash: S.cash, initCash: S.initCash, feeRate: S.feeRate,
      allowShort: S.allowShort, pos: S.pos, trades: S.trades,
      eq: S.eq, bench: S.bench, benchSPX: S.benchSPX,
      realized: S.realized, fees: S.fees, closes: S.closes,
      over: S.over, playing: false,
      benchBase: (S.benchBase || []).map(p => ({ k: p.a.key, base: p.base })),
      spxBase: S.spxBase,
      /* —— 用户设置：必须一并持久化，更新后要原样恢复（R2）—— */
      sel: S.sel, viewN: S.viewN, ma: S.ma, showVol: S.showVol,
      speedMs: S.speedMs, side: S.side, tab: S.tab,
      showBench: S.showBench, logScale: S.logScale, showMarks: S.showMarks,
      closeFrac: S.closeFrac, filter: S.filter,
      amt: (function () { const e = $('#inAmt'); return e ? (parseFloat(e.value) || 0) : 0; })()
    }));
  } catch (e) {
    STORAGE_OK = false;
    if (!_saveWarned) { _saveWarned = true; toast('本地存档写入失败（可能超出配额），进度不会保留', 'bad'); }
  }
}
/* 存档摘要，用于"覆盖前确认"提示 */
function saveSummary(o) {
  if (!o || o.startG === undefined) return '';
  const d = (typeof o.g === 'number' && DATA.dates[o.g]) ? DATA.dates[o.g] : '—';
  const eq = Array.isArray(o.eq) && o.eq.length ? o.eq[o.eq.length - 1] : null;
  return d + (eq ? ' · 权益 ' + fmtMoney(eq, 0) : '');
}
function loadSave() {
  if (!STORAGE_OK) return null;
  try {
    const raw = localStorage.getItem(LS); if (!raw) return null;
    const o = JSON.parse(raw);
    if (!o || o.startG === undefined) return null;
    return o;
  } catch (e) { return null; }
}
/* 老的"净头寸"存档 → 双向持仓结构 */
function migratePos(raw) {
  const out = {};
  for (const k in (raw || {})) {
    const p = raw[k]; if (!p) continue;
    if (p.long || p.short) {
      out[k] = { long: p.long || blankLeg(), short: p.short || blankLeg(), fee: p.fee || 0 };
    } else if (typeof p.qty === 'number' && Math.abs(p.qty) > 1e-9) {
      out[k] = p.qty > 0
        ? { long: { qty: p.qty, avg: p.avg }, short: blankLeg(), fee: p.fee || 0 }
        : { long: blankLeg(), short: { qty: -p.qty, avg: p.avg }, fee: p.fee || 0 };
      }
    }
  return out;
}
/* 存档里可能持有"已下架"的资产（比如用户删掉了某个类别）。
   直接用会导致 DATA.assets[k] 为 undefined 而在估值处崩溃，
   所以读档时统一清算：按开仓均价折回现金（不退不赚，只损失已付手续费），
   并清掉对应的成交与平仓记录。 */
function pruneRemovedAssets() {
  const gone = [];
  for (const k in S.pos) {
    if (DATA.assets[k]) continue;
    const p = S.pos[k];
    if (p && p.long && p.long.qty > 1e-9) S.cash += p.long.qty * p.long.avg;
    if (p && p.short && p.short.qty > 1e-9) S.cash -= p.short.qty * p.short.avg;
    delete S.pos[k];
    gone.push(k);
  }
  if (S.trades && S.trades.length) S.trades = S.trades.filter(t => DATA.assets[t.key]);
  if (S.closes && S.closes.length) S.closes = S.closes.filter(c => DATA.assets[c.key]);
  if (S.benchBase) S.benchBase = S.benchBase.filter(p => p && p.a);
  if (!DATA.assets[S.sel] && DATA.list.length) S.sel = DATA.list[0].key;
  return gone;
}

/* 逐字段兜底：某一项缺失/损坏只让那一项回默认，其余照常恢复（R2 第 3 条） */
const _num = (v, d) => (typeof v === 'number' && isFinite(v)) ? v : d;
/* 老存档里的区间值是"日期轴下标"，含义已改为"日历天数"，做一次等价换算 */
const VIEW_MIGRATE = { 250: 365, 750: 1095 };
const _bool = (v, d) => (typeof v === 'boolean') ? v : d;
const _arr = (v, d) => Array.isArray(v) ? v : d;
const TABS = ['chart', 'equity', 'trades', 'stats', 'analysis', 'pfolios'];
const CAT_ORDER = ['股指', '商品', '汇率', '加密', '债券'];

function restore(o) {
  o = o || {};
  Object.assign(S, {
    /* 进度 */
    g: _num(o.g, 0), startG: _num(o.startG, 0),
    cash: _num(o.cash, 100000), initCash: _num(o.initCash, 100000),
    feeRate: _num(o.feeRate, 0.001), allowShort: _bool(o.allowShort, true),
    pos: migratePos(o.pos), trades: _arr(o.trades, []),
    eq: _arr(o.eq, []), bench: _arr(o.bench, []), benchSPX: _arr(o.benchSPX, null),
    realized: _num(o.realized, 0), fees: _num(o.fees, 0), closes: _arr(o.closes, []),
    over: _bool(o.over, false),
    /* 设置：存在就一定沿用，只有缺失才回默认 */
    sel: DATA.assets[o.sel] ? o.sel : S.sel,
    viewN: VIEW_MIGRATE[_num(o.viewN, 365)] || _num(o.viewN, 365),
    ma: (o.ma && typeof o.ma === 'object') ? o.ma : S.ma,
    showVol: _bool(o.showVol, true),
    speedMs: _num(o.speedMs, 10000),
    side: ACTIONS[o.side] ? o.side : 'openLong',
    tab: TABS.indexOf(o.tab) >= 0 ? o.tab : 'chart',
    showBench: _bool(o.showBench, true),
    logScale: _bool(o.logScale, true),
    showMarks: _bool(o.showMarks, true),
    closeFrac: _num(o.closeFrac, 1),
    filter: (typeof o.filter === 'string') ? o.filter : '',
    playing: false, lastTick: Date.now()
  });
  S.benchBase = _arr(o.benchBase, []).map(p => ({ a: DATA.assets[p.k], base: p.base })).filter(p => p.a);
  S.spxBase = o.spxBase || null;
  // 清算已被下架的资产（例如用户删掉的"汇率"类别）
  const gone = pruneRemovedAssets();
  if (gone.length) {
    S.__prunedCount = gone.length;
    setTimeout(() => toast('已下架 ' + gone.length + ' 个资产的持仓，按开仓均价折回现金', 'bad'), 400);
  }
  // 界面控件跟着回填，别让"数据"和"控件"不一致
  const ia = $('#inAmt');
  if (ia) { const v = _num(o.amt, 0); if (v > 0) ia.value = v; }
  const ws = $('#wSearch');
  if (ws) ws.value = S.filter;
  watchCache = '';
  if (typeof syncViewUI === 'function') syncViewUI();
}
/* 把控件外观同步到 S 里的设置（恢复存档后要看到一致的按钮状态） */
function syncViewUI() {
  $$('#chartbar .rng').forEach(b => b.classList.toggle('on', parseInt(b.dataset.n) === S.viewN));
  $$('#chartbar .tog[data-ma]').forEach(b => b.classList.toggle('on', !!S.ma[b.dataset.ma]));
  $$('#segSide button').forEach(b => b.classList.toggle('on', b.dataset.s === S.side));
  const tb = $('#tgBench'); if (tb) tb.classList.toggle('on', S.showBench);
  const tl = $('#tgLog'); if (tl) tl.classList.toggle('on', S.logScale);
  const tm = $('#tgMarks'); if (tm) tm.classList.toggle('on', S.showMarks);
}
function clearSave() { try { localStorage.removeItem(LS); } catch (e) { } }
function saveThrottled() { if (Date.now() - _lastSave > 1500) saveNow(); }

function newGame(scenDate, cash, feePct, speedMs, allowShort) {
  clearSave();
  S.initCash = cash; S.cash = cash; S.feeRate = feePct / 100;
  S.allowShort = allowShort; S.speedMs = speedMs;
  S.pos = {}; S.trades = []; S.closes = []; S.realized = 0; S.fees = 0; S.over = false;
  let g0 = 0;
  if (scenDate === 'random') {
    // 在至少有 60% 资产生效之后随机
    const lo = DATA.list.reduce((m, a) => Math.min(m, a.d0), ND);
    const hi = ND - 260;
    const start = Math.max(lo + 500, Math.floor(lo + Math.random() * (hi - lo)));
    g0 = start;
  } else {
    const target = scenDate;
    g0 = ND - 1;
    for (let g = 0; g < ND; g++) if (DATA.dates[g] >= target) { g0 = g; break; }
  }
  S.startG = g0; S.g = g0; S.lastTick = Date.now();
  S.hover = -1; S.tab = 'chart'; S.viewN = S.viewN || 365;
  buildBenchmark(); initEquitySeries();
  S.playing = speedMs > 0;
  setTab('chart'); syncSpeedUI();
  saveNow(); renderAll();
}

/* ---------------- 速度 / Tab / 设置 ---------------- */
function syncSpeedUI() {
  $$('#speeds button').forEach(b => b.classList.toggle('on', parseInt(b.dataset.ms) === (S.playing ? S.speedMs : 0)));
  const bp = $('#btnPlay');
  bp.textContent = S.playing ? '⏸' : '▶';
  bp.classList.toggle('pulse', !S.playing && !S.over);
  bp.title = S.over ? '本局已结束' : (S.playing ? '暂停' : '继续（当前已暂停）');
}
function setTab(v) {
  S.tab = v;
  $$('#tabs button[data-v]').forEach(b => b.classList.toggle('on', b.dataset.v === v));
  $$('.view').forEach(e => e.classList.toggle('on', e.dataset.v === v));
  renderAll();
}

/* ---------------- 弹窗 ---------------- */
const SCEN = [
  ['1995-01-03', '九十年代繁荣', '互联网浪潮起步'],
  ['2000-01-03', '互联网泡沫顶峰', '纳斯达克随后腰斩'],
  ['2004-01-02', '全球化黄金期', '新兴市场大牛市'],
  ['2007-06-01', '金融危机前夜', '次贷危机即将爆发'],
  ['2010-01-04', '后危机复苏', 'QE 推动的修复行情'],
  ['2015-06-01', 'A股杠杆牛顶', '随后千股跌停'],
  ['2018-01-02', '贸易战前夜', '波动率回归'],
  ['2020-02-19', '疫情崩盘前夜', '一个月内全球熔断'],
  ['2021-11-01', '全球放水顶峰', '通胀与加息在路上'],
  ['2022-01-03', '加息熊市开局', '股债双杀'],
  ['2024-01-02', '最近两年', 'AI 行情与新高'],
  ['random', '随机时点', '在全部历史里掷骰子'],
];
let scenPick = '2007-06-01';
function renderScen() {
  $('#scenList').innerHTML = SCEN.map(s =>
    '<div class="it' + (s[0] === scenPick ? ' on' : '') + '" data-d="' + s[0] + '">' +
    '<div class="a">' + s[1] + '</div><div class="b">' + (s[0] === 'random' ? 'RANDOM' : s[0]) + ' · ' + s[2] + '</div></div>'
  ).join('');
}
/* 把存档里"用户设置过的东西"列出来，让续局一目了然 */
function renderSavedBox(o) {
  const box = $('#savedBox');
  if (!box || !o) return;
  const d = (typeof o.g === 'number' && DATA.dates[o.g]) ? DATA.dates[o.g] : '—';
  const eq = (Array.isArray(o.eq) && o.eq.length) ? o.eq[o.eq.length - 1] : null;
  const init = (typeof o.initCash === 'number') ? o.initCash : null;
  let nL = 0, nS = 0, nA = 0;
  for (const k in (o.pos || {})) {
    const p = o.pos[k]; if (!p) continue;
    const qL = p.long ? p.long.qty : (p.qty > 0 ? p.qty : 0);
    const qS = p.short ? p.short.qty : (p.qty < 0 ? -p.qty : 0);
    if (qL > 1e-9) nL++;
    if (qS > 1e-9) nS++;
    if (qL > 1e-9 || qS > 1e-9) nA++;
  }
  const sp = (typeof o.speedMs === 'number') ? o.speedMs : 10000;
  const spTxt = sp > 0 ? '<b>' + fmtDur(sp) + '</b> / 交易日' : '手动推进（点 ⏭ 走一天）';
  const fee = (typeof o.feeRate === 'number') ? o.feeRate : 0.001;
  const rows = [
    ['走到', d + (o.over ? '（本局已走完全部历史）' : '')],
    ['总权益', eq !== null
      ? '<b>' + fmtMoney(eq, 0) + '</b>' + (init ? '  ' + fmtPct(eq / init - 1) : '')
      : '—'],
    ['时间流速', spTxt],
    ['手续费率', '<b>' + (fee * 100).toFixed(3) + '%</b>'],
    ['初始资金', init !== null ? fmtMoney(init, 0) : '—'],
    ['允许做空', o.allowShort === false ? '否' : '是'],
    ['持仓', nA ? nA + ' 个资产（多 ' + nL + ' / 空 ' + nS + '）' : '无']
  ];
  box.innerHTML = rows.map(r =>
    '<div class="svrow"><span class="k">' + r[0] + '</span><span class="v">' + r[1] + '</span></div>'
  ).join('');
}

let startArmed = false;
function disarmStart() {
  startArmed = false;
  const b = $('#btnStart');
  if (b) { b.textContent = '开始交易'; b.classList.remove('danger'); }
}
function openGameModal(hasSave) {
  applySetupForm();
  renderScen();
  disarmStart();
  const o = hasSave ? loadSave() : null;
  const rb = $('#resumeBlock'), nb = $('#newBlock'), bb = $('#btnBackResume');
  if (rb) rb.style.display = o ? '' : 'none';
  if (nb) nb.style.display = o ? 'none' : '';
  if (bb) bb.style.display = o ? '' : 'none';
  if (o) renderSavedBox(o);
  const w = $('#overwriteWarn');
  if (w) {
    if (o) {
      w.style.display = '';
      w.innerHTML = '⚠️ 已有一局进行中（<b>' + esc(saveSummary(o)) + '</b>）。' +
        '点「开始交易」会<b>永久覆盖</b>它，请再点一次确认。';
    } else { w.style.display = 'none'; w.innerHTML = ''; }
  }
  $('#maskGame').classList.add('on');
}

/* ---------------- 界面偏好：栏宽 / 折叠（与游戏存档分开存） ---------------- */
const LS_UI = 'hist-trade-ui-v1';
const UI = {
  wl: 0, wr: 0, acct: false, dense: false, topH: 0, setup: {},
  pfolios: [], pfCur: '', pfAmt: 20000
};
const WIDE_THRESHOLD = 380;

function loadUI() {
  try { Object.assign(UI, JSON.parse(localStorage.getItem(LS_UI) || '{}') || {}); } catch (e) { }
}
function saveUI() {
  if (!STORAGE_OK) return;
  try { localStorage.setItem(LS_UI, JSON.stringify(UI)); } catch (e) { }
}
function applyUI() {
  const appEl = document.querySelector('.app');
  if (UI.wl) appEl.style.setProperty('--wl', UI.wl + 'px'); else appEl.style.removeProperty('--wl');
  if (UI.wr) appEl.style.setProperty('--wr', UI.wr + 'px'); else appEl.style.removeProperty('--wr');
  const rows = document.querySelector('#acctRows');
  if (rows) rows.style.display = UI.acct ? 'none' : '';
  const fb = document.querySelector('#btnAcctFold');
  if (fb) {
    fb.textContent = UI.acct ? '⌄' : '⌃';
    fb.title = UI.acct ? '展开账户明细' : '收起账户明细，给持仓更多空间';
  }
  const wb = document.querySelector('#btnWide');
  if (wb) wb.classList.toggle('on', UI.wr > WIDE_THRESHOLD);
  // 交易面板高度：拖过就固定，没拖过交给 CSS 默认上限
  const tz = document.querySelector('#tradeZone');
  if (tz) {
    if (UI.topH) {
      const h = Math.max(126, Math.min(760, UI.topH));
      tz.style.flex = '0 0 auto'; tz.style.maxHeight = 'none'; tz.style.height = h + 'px';
    } else {
      tz.style.height = ''; tz.style.flex = ''; tz.style.maxHeight = '';
    }
  }
  // 紧凑模式（每条腿压成一行）
  document.body.classList.toggle('dense', !!UI.dense);
  const db = document.querySelector('#btnDense');
  if (db) {
    db.classList.toggle('on', !!UI.dense);
    db.title = UI.dense ? '当前：紧凑（点击切回舒适）' : '当前：舒适（点击切换紧凑）';
  }
  clampPanels();
}
/* 栏宽之和不得超过窗口，否则主区（K线）会被挤成 0。
   这里按比例压缩，保证主区至少留 MIN_MAIN 像素。 */
const MIN_MAIN = 280, SPLIT_TOTAL = 12;
function clampPanels() {
  const appEl = document.querySelector('.app');
  if (!appEl) return;
  const vw = Math.round(appEl.getBoundingClientRect().width) ||
    ((typeof window !== 'undefined' && window.innerWidth) ? window.innerWidth : 1440);
  if (!UI.wl && !UI.wr) return;                       // 都用默认值，交给 CSS 断点
  let dWL = 220, dWR = 320;
  if (typeof getComputedStyle === 'function') {
    const cs = getComputedStyle(appEl);
    dWL = parseInt(cs.getPropertyValue('--wl')) || dWL;
    dWR = parseInt(cs.getPropertyValue('--wr')) || dWR;
  }
  const curL = UI.wl || dWL, curR = UI.wr || dWR;
  const avail = Math.max(240, vw - SPLIT_TOTAL - MIN_MAIN);
  if (curL + curR <= avail) return;
  const k = avail / (curL + curR);
  if (UI.wl) { UI.wl = Math.max(110, Math.round(curL * k)); appEl.style.setProperty('--wl', UI.wl + 'px'); }
  if (UI.wr) { UI.wr = Math.max(150, Math.round(curR * k)); appEl.style.setProperty('--wr', UI.wr + 'px'); }
}

/* 开局面板的参数（初始资金 / 手续费 / 流速 / 是否做空 / 开局时点）
   属于"用户设置"，必须记住，下次打开不用重填（R2） */
const SETUP_DEF = { scen: '2007-06-01', cash: 100000, fee: 0.1, speed: 10000, short: 1 };
function readSetupForm() {
  const g = id => document.querySelector('#' + id);
  const cashEl = g('setCash'), feeEl = g('setFee'), spEl = g('setSpeed'), shEl = g('setShort');
  return {
    scen: scenPick,
    cash: cashEl ? (Math.max(1000, parseFloat(cashEl.value) || SETUP_DEF.cash)) : SETUP_DEF.cash,
    fee: feeEl ? (Math.max(0, parseFloat(feeEl.value) || 0)) : SETUP_DEF.fee,
    speed: spEl ? (parseInt(spEl.value) || 0) : SETUP_DEF.speed,
    short: shEl ? (shEl.value === '1' ? 1 : 0) : SETUP_DEF.short
  };
}
function rememberSetup() { UI.setup = readSetupForm(); saveUI(); }
function applySetupForm() {
  const s = (UI.setup && typeof UI.setup === 'object') ? UI.setup : {};
  const g = id => document.querySelector('#' + id);
  scenPick = (typeof s.scen === 'string' && s.scen) ? s.scen : SETUP_DEF.scen;
  const cashEl = g('setCash'), feeEl = g('setFee'), spEl = g('setSpeed'), shEl = g('setShort');
  const num = (v, d) => (typeof v === 'number' && isFinite(v)) ? v : d;
  if (cashEl) cashEl.value = num(s.cash, SETUP_DEF.cash);
  if (feeEl) feeEl.value = num(s.fee, SETUP_DEF.fee);
  if (spEl) spEl.value = String(num(s.speed, SETUP_DEF.speed));
  if (shEl) shEl.value = String(num(s.short, SETUP_DEF.short));
}

function toggleWide() {
  const appEl = document.querySelector('.app');
  if (UI.wr > WIDE_THRESHOLD) {
    UI.wr = 0; appEl.style.removeProperty('--wr');
  } else {
    const vw = (typeof window !== 'undefined' && window.innerWidth) ? window.innerWidth : 1440;
    UI.wr = Math.max(440, Math.min(820, Math.round(vw * 0.44)));
    appEl.style.setProperty('--wr', UI.wr + 'px');
  }
  applyUI(); renderAll(); saveUI();
}
function initView() {
  const appEl = document.querySelector('.app');
  const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
  function makeDrag(el, which) {
    if (!el) return;
    let on = false;
    // 两条竖向分隔条的基准边不同：spL 贴着 app 左边，spR 贴着中间栏左边
    const baseLeft = () => which === 'l'
      ? appEl.getBoundingClientRect().left
      : (document.querySelector('.side-m') || appEl).getBoundingClientRect().left;
    el.addEventListener('mousedown', e => {
      on = true; el.classList.add('drag');
      document.body.style.cursor = 'col-resize';
      document.body.style.userSelect = 'none';
      if (e.preventDefault) e.preventDefault();
    });
    document.addEventListener('mousemove', e => {
      if (!on) return;
      const r = appEl.getBoundingClientRect();
      const w = clamp(Math.round(e.clientX - baseLeft()), 150, Math.round(r.width * 0.55));
      if (which === 'l') UI.wl = w; else UI.wr = w;
      appEl.style.setProperty(which === 'l' ? '--wl' : '--wr', w + 'px');
      renderAll();
    });
    document.addEventListener('mouseup', () => {
      if (!on) return;
      on = false; el.classList.remove('drag');
      document.body.style.cursor = ''; document.body.style.userSelect = '';
      applyUI(); saveUI();
    });
    el.addEventListener('dblclick', () => {
      if (which === 'l') { UI.wl = 0; } else { UI.wr = 0; }
      applyUI(); renderAll(); saveUI();
    });
  }
  makeDrag(document.querySelector('#spL'), 'l');
  makeDrag(document.querySelector('#spR'), 'r');
  // 水平分隔条：上下拖动 = 改变最右栏"交易面板"的高度
  (function () {
    const sp = document.querySelector('#spTrade');
    const ta = document.querySelector('#tradeZone');
    const pane = document.querySelector('.main');
    if (!sp || !ta || !pane) return;
    let on = false;
    sp.addEventListener('mousedown', e => {
      on = true; sp.classList.add('drag');
      document.body.style.cursor = 'row-resize';
      document.body.style.userSelect = 'none';
      if (e.preventDefault) e.preventDefault();
    });
    document.addEventListener('mousemove', e => {
      if (!on) return;
      const r = pane.getBoundingClientRect();
      const maxH = Math.max(126, Math.round(r.height - 180));  // 图表至少留 180px
      const v = Math.max(126, Math.min(maxH, Math.round(r.bottom - e.clientY)));
      UI.topH = v;
      ta.style.flex = '0 0 auto'; ta.style.maxHeight = 'none'; ta.style.height = v + 'px';
      renderAll();
    });
    document.addEventListener('mouseup', () => {
      if (!on) return;
      on = false; sp.classList.remove('drag');
      document.body.style.cursor = ''; document.body.style.userSelect = '';
      saveUI();
    });
    sp.addEventListener('dblclick', () => {
      UI.topH = 0;
      ta.style.height = ''; ta.style.flex = ''; ta.style.maxHeight = '';
      applyUI(); renderAll(); saveUI();
    });
  })();
  const wb = document.querySelector('#btnWide');
  if (wb) wb.onclick = toggleWide;
  const fb = document.querySelector('#btnAcctFold');
  if (fb) fb.onclick = () => { UI.acct = !UI.acct; applyUI(); renderAll(); saveUI(); };
  const db = document.querySelector('#btnDense');
  if (db) db.onclick = () => { UI.dense = !UI.dense; applyUI(); renderAll(); saveUI(); };
}

/* ---------------- 事件绑定 ---------------- */
function bind() {
  $('#watch').addEventListener('click', e => {
    const r = e.target.closest('.arow'); if (!r) return;
    S.sel = r.dataset.k; S.hover = -1; barCache.key = '';
    focusPosition(S.sel);          // ②持仓栏自动跳到该资产并高亮
    renderAll();
  });
  $('#wSearch').addEventListener('input', e => {
    S.filter = e.target.value; watchCache = ''; renderWatch();
  });
  $('#wSearch').addEventListener('keydown', e => {
    if (e.key === 'Escape') { e.target.value = ''; S.filter = ''; watchCache = ''; renderWatch(); }
  });
  // 「平」按钮在②持仓栏和③该标的条里都有，共用同一套处理：
  // 点它不直接全平，而是弹出减仓比例菜单（10% / 25% / 50% / 75% / 全部）
  function onPosClick(e) {
    const f = e.target.closest('[data-close]');
    if (f) {
      const parts = f.dataset.close.split('|');
      const a = DATA.assets[parts[0]], p = S.pos[parts[0]];
      if (!p || !(p[parts[1]].qty > 1e-9)) return;
      if (!tradable(a, S.g)) return toast('今日休市，无法平仓', 'bad');
      openCloseMenu(parts[0], parts[1], f);
      return;
    }
    const row = e.target.closest('.posrow') || e.target.closest('.poshd');
    if (row && row.dataset.k) {
      S.sel = row.dataset.k; S.hover = -1; barCache.key = '';
      focusWatch(S.sel);           // 反向：①标的栏也跳过去
      renderAll();
    }
  }
  $('#posWrap').addEventListener('click', onPosClick);
  const selPosEl = $('#selPos');
  if (selPosEl) selPosEl.addEventListener('click', onPosClick);

  // 减仓菜单：点比例执行，点别处关闭
  const pm = $('#popClose');
  if (pm) {
    pm.addEventListener('click', e => {
      const b = e.target.closest('button[data-frac]');
      if (!b || !closeMenuFor) return;
      doPartialClose(closeMenuFor.k, closeMenuFor.side, parseFloat(b.dataset.frac));
    });
  }
  document.addEventListener('click', e => {
    if (!closeMenuFor) return;
    const t = e.target;
    if (t && t.closest && (t.closest('#popClose') || t.closest('[data-close]'))) return;
    closeCloseMenu();
  });
  document.addEventListener('keydown', e => { if (e.key === 'Escape') closeCloseMenu(); });
  const pw = $('#posWrap'); if (pw) pw.addEventListener('scroll', closeCloseMenu);
  window.addEventListener('resize', closeCloseMenu);
  $$('#tabs button[data-v]').forEach(b => b.onclick = () => setTab(b.dataset.v));
  $$('#segSide button').forEach(b => b.onclick = () => {
    if (b.disabled) return toast('本局已关闭做空', 'bad');
    S.side = b.dataset.s;
    $$('#segSide button').forEach(x => x.classList.toggle('on', x === b));
    if (!ACTIONS[S.side].open) { S.closeFrac = 1; }
    renderOrder();
  });
  $('#quicks').addEventListener('click', e => {
    const b = e.target.closest('button'); if (!b) return;
    const q = parseFloat(b.dataset.q);
    if (!ACTIONS[S.side].open) {
      S.closeFrac = q; renderOrder();
    } else {
      $('#inAmt').value = Math.max(0, Math.floor(maxOpenNotional(S.side) * q));
      renderOrder();
    }
  });
  $('#inAmt').addEventListener('input', () => renderOrder());
  $('#btnSubmit').onclick = doTrade;
  $$('#speeds button').forEach(b => b.onclick = () => {
    const ms = parseInt(b.dataset.ms);
    S.speedMs = ms; S.playing = ms > 0; S.lastTick = Date.now(); syncSpeedUI(); save(); renderAll();
  });
  const calEl = document.querySelector('.cal');
  if (calEl) {
    calEl.style.cursor = 'pointer';
    calEl.title = '点击播放 / 暂停';
    calEl.onclick = () => { if (!S.over) $('#btnPlay').onclick(); };
  }
  $('#btnPlay').onclick = () => {
    if (S.over) return toast('本局已结束', 'bad');
    if (S.speedMs === 0) S.speedMs = 10000;
    S.playing = !S.playing; S.lastTick = Date.now(); syncSpeedUI(); renderAll();
  };
  $('#btnStep').onclick = () => { S.lastTick = Date.now(); advance(1); };
  $('#btnRestart').onclick = () => openGameModal(!!loadSave());
  $('#btnSet').onclick = () => openGameModal(!!loadSave());
  $('#btnHelp').onclick = () => $('#maskHelp').classList.add('on');
  $('#btnHelpOk').onclick = () => $('#maskHelp').classList.remove('on');
  $('#scenList').addEventListener('click', e => {
    const it = e.target.closest('.it'); if (!it) return;
    scenPick = it.dataset.d; renderScen(); disarmStart(); rememberSetup();
  });
  // 开局面板里任何一项改动都立刻记住，不等点"开始交易"
  ['#setCash', '#setFee', '#setSpeed', '#setShort'].forEach(sel => {
    const el = document.querySelector(sel);
    if (el) el.addEventListener('change', rememberSetup);
    if (el) el.addEventListener('input', rememberSetup);
  });
  $('#btnStart').onclick = () => {
    // 有存档时必须二次确认，避免误点丢掉上一局（R2 第 6 条）
    if (loadSave() && !startArmed) {
      startArmed = true;
      const b = $('#btnStart');
      b.textContent = '再点一次：确认覆盖并重开';
      b.classList.add('danger');
      const w = $('#overwriteWarn');
      if (w) { w.style.display = ''; w.innerHTML = '⚠️ 再点一次将<b>永久删除</b>当前存档并重新开局。'; }
      return;
    }
    disarmStart();
    rememberSetup();
    const s = UI.setup;
    const cash = s.cash, fee = s.fee, sp = s.speed, sh = s.short === 1;
    $('#maskGame').classList.remove('on');
    newGame(scenPick, cash, fee, sp, sh);
    toast('开局：' + dstr(S.g) + ' · 初始资金 ' + fmtMoney(cash, 0), 'ok');
  };
  const bng = $('#btnNewGame');
  if (bng) bng.onclick = () => {
    const rb = $('#resumeBlock'), nb = $('#newBlock');
    if (rb) rb.style.display = 'none';
    if (nb) nb.style.display = '';
    disarmStart();
  };
  const bbr = $('#btnBackResume');
  if (bbr) bbr.onclick = () => openGameModal(!!loadSave());
  $('#btnContinue').onclick = () => {
    const o = loadSave(); if (!o) return toast('没有找到存档', 'bad');
    $('#maskGame').classList.remove('on');
    restore(o);
    // 完全沿用存档里的设置：速度、方向、标签页、图表选项都不动
    // 手动推进模式（speedMs=0）保持暂停，不擅自改成自动
    S.playing = !S.over && S.speedMs > 0;
    S.lastTick = Date.now();
    applyUI(); setTab(S.tab); syncSpeedUI(); renderAll();
    if (!S.over) saveNow();
    toast(S.over ? ('本局已结束 · ' + dstr(S.g) + '，点 ⚙ 重新开局')
                 : ('已继续上局 · ' + dstr(S.g) + ' · 速度 ' + fmtDur(S.speedMs) + '/天' +
                    (S.playing ? '' : '（手动推进，点 ⏭ 走一天）')), 'ok');
  };
  // 图表交互
  const bindHover = (cv, tipEl) => {
    cv.addEventListener('mousemove', e => {
      const i = Chart.pick(cv, e.clientX);
      if (i !== S.hover) { S.hover = i; if (S.tab === 'chart') renderChart(); else renderEquity(); }
      showTip(cv, tipEl, e, i);
    });
    cv.addEventListener('mouseleave', () => {
      S.hover = -1; tipEl.style.display = 'none';
      if (S.tab === 'chart') renderChart(); else renderEquity();
    });
  };
  bindHover($('#cvMain'), $('#tipMain'));
  bindHover($('#cvEq'), $('#tipEq'));
  $$('#chartbar .rng').forEach(b => b.onclick = () => {
    S.viewN = parseInt(b.dataset.n); barCache.key = '';
    $$('#chartbar .rng').forEach(x => x.classList.toggle('on', x === b)); renderAll();
  });
  $$('#chartbar .tog[data-ma]').forEach(b => b.onclick = () => {
    const m = b.dataset.ma; S.ma[m] = !S.ma[m]; b.classList.toggle('on', S.ma[m]); renderAll();
  });
  const tgm = $('#tgMarks');
  if (tgm) tgm.onclick = () => {
    S.showMarks = !S.showMarks;
    tgm.classList.toggle('on', S.showMarks);
    saveThrottled(); renderAll();
  };
  $('#tgBench').onclick = () => { S.showBench = !S.showBench; $('#tgBench').classList.toggle('on', S.showBench); renderAll(); };
  $('#tgLog').onclick = () => { S.logScale = !S.logScale; $('#tgLog').classList.toggle('on', S.logScale); renderAll(); };
  // ---- 投资组合页交互 ----
  const pfw = $('#pfWrap');
  if (pfw) {
    pfw.addEventListener('change', e => {
      const inp = e.target.closest('input[data-pfw]');
      if (inp) {
        const pf = pfEnsure();
        const it = pf.items.find(x => x.k === inp.dataset.pfw);
        if (it) {
          it.w = Math.max(0, Math.min(100, parseFloat(inp.value) || 0));
          pfSave();
          // 只更新合计数字，不整页重绘（否则输入框会失焦）
          const sumEl = document.querySelector('#pfSum');
          if (sumEl) {
            const W = pfTotalW(pf);
            sumEl.textContent = W.toFixed(1) + '%';
            sumEl.classList.toggle('bad', W > 100.001);
          }
        }
        return;
      }
      const amtEl = e.target.closest('#pfAmt');
      if (amtEl) { UI.pfAmt = Math.max(0, parseFloat(amtEl.value) || 0); pfSave(); }
    });
    pfw.addEventListener('input', e => {
      const amtEl = e.target.closest('#pfAmt');
      if (amtEl) UI.pfAmt = Math.max(0, parseFloat(amtEl.value) || 0);
    });
    pfw.addEventListener('click', e => {
      const t = e.target;
      const hit = sel => (t && t.closest) ? t.closest(sel) : null;
      if (hit('[data-pfsel]')) {
        UI.pfCur = hit('[data-pfsel]').dataset.pfsel; pfSave(); renderAll(); return;
      }
      if (hit('[data-pfdel]')) {
        const id = hit('[data-pfdel]').dataset.pfdel;
        const p = UI.pfolios.find(x => x.id === id);
        if (p && pfConfirm('删除组合「' + p.name + '」？（不会平掉持仓）')) {
          UI.pfolios = UI.pfolios.filter(x => x.id !== id);
          if (UI.pfCur === id) UI.pfCur = UI.pfolios.length ? UI.pfolios[0].id : '';
          pfSave(); renderAll();
        }
        return;
      }
      if (hit('[data-pfnew]')) {
        const name = pfPrompt('新组合的名称', '组合' + (UI.pfolios.length + 1));
        if (name) {
          const id = pfNewId();
          UI.pfolios.push({ id: id, name: String(name).slice(0, 20), items: [] });
          UI.pfCur = id; pfSave(); renderAll();
        }
        return;
      }
      if (hit('[data-pfrename]')) {
        const pf = pfEnsure();
        const name = pfPrompt('修改组合名称', pf.name);
        if (name) { pf.name = String(name).slice(0, 20); pfSave(); renderAll(); }
        return;
      }
      if (hit('[data-pffrompos]')) {
        const pf = pfEnsure();
        const mvs = [];
        let tot = 0;
        for (const k in S.pos) {
          const a = DATA.assets[k], p = S.pos[k], m = markOf(a, S.g);
          if (!isFinite(m) || !(p.long.qty > 1e-9)) continue;
          const mv = p.long.qty * m;
          mvs.push({ k: k, mv: mv }); tot += mv;
        }
        if (!tot) return toast('当前没有多头持仓', 'bad');
        pf.items = mvs.map(x => ({ k: x.k, w: Math.round(x.mv / tot * 1000) / 10 }));
        pfSave(); renderAll();
        toast('已按当前持仓市值生成 ' + pf.items.length + ' 个成分', 'ok');
        return;
      }
      if (hit('[data-pfadd]')) {
        const sel = document.querySelector('#pfAdd');
        const k = sel ? sel.value : '';
        if (!k || !DATA.assets[k]) return toast('请先选择一个资产', 'bad');
        const pf = pfEnsure();
        if (pf.items.some(x => x.k === k)) return toast('该资产已在组合里', 'bad');
        pf.items.push({ k: k, w: 10 });
        pfSave(); renderAll();
        toast('已加入 ' + DATA.assets[k].cn + '（默认权重 10%）', 'ok');
        return;
      }
      if (hit('[data-pfrm]')) {
        const pf = pfEnsure();
        const k = hit('[data-pfrm]').dataset.pfrm;
        pf.items = pf.items.filter(x => x.k !== k);
        pfSave(); renderAll(); return;
      }
      if (hit('[data-pfeq]')) {
        const pf = pfEnsure();
        if (!pf.items.length) return toast('组合里还没有成分', 'bad');
        const w = Math.round(1000 / pf.items.length) / 10;
        for (const it of pf.items) it.w = w;
        pfSave(); renderAll(); toast('已等权分配：每个 ' + w + '%', 'ok'); return;
      }
      if (hit('[data-pfnorm]')) {
        const pf = pfEnsure();
        const W = pfTotalW(pf);
        if (!W) return toast('权重合计为 0，无法归一化', 'bad');
        for (const it of pf.items) it.w = Math.round(it.w / W * 1000) / 10;
        pfSave(); renderAll(); toast('已归一化到 100%', 'ok'); return;
      }
      if (hit('[data-pfclear]')) {
        const pf = pfEnsure();
        if (!pf.items.length || pfConfirm('清空组合「' + pf.name + '」的全部成分？（不会平掉持仓）')) {
          pf.items = []; pfSave(); renderAll();
        }
        return;
      }
      if (hit('[data-pfq]')) {
        const q = parseFloat(hit('[data-pfq]').dataset.pfq);
        const v = Math.max(0, Math.floor((availableCash() / (1 + S.feeRate)) * q));
        UI.pfAmt = v; pfSave();
        const el = document.querySelector('#pfAmt'); if (el) el.value = v;
        return;
      }
      if (hit('[data-pfopen]')) {
        const el = document.querySelector('#pfAmt');
        const amt = el ? (parseFloat(el.value) || 0) : (UI.pfAmt || 0);
        UI.pfAmt = amt;
        pfOpen(amt); return;
      }
      if (hit('[data-pfreduce]')) {
        const f = parseFloat(hit('[data-pfreduce]').dataset.pfreduce);
        pfReduce(f, f >= 1 ? '清仓' : '减仓 ' + (f * 100) + '%');
        return;
      }
    });
  }

  initView();
  window.addEventListener('resize', () => { applyUI(); renderAll(); });
  // 布局尺寸一变就重绘，避免"画布尺寸还没稳定就画完"导致的空白
  if (typeof ResizeObserver !== 'undefined') {
    try {
      const ro = new ResizeObserver(() => renderAll());
      const m = document.querySelector('.main'); if (m) ro.observe(m);
      const cw = document.querySelector('.chartwrap'); if (cw) ro.observe(cw);
    } catch (e) { }
  }
  document.addEventListener('visibilitychange', () => { if (!document.hidden) S.lastTick = Date.now(); });
}

function showTip(cv, el, e, i) {
  const r = cv.getBoundingClientRect();
  if (S.tab === 'chart') {
    const a = DATA.assets[S.sel], bc = buildBars(), b = bc.bars[i];
    if (!b) { el.style.display = 'none'; return; }
    const ch = b.c / b.o - 1;
    let pg = b.g - 1; while (pg > 0 && a.has[pg] !== 1) pg--;
    const pch = a.has[pg] === 1 ? b.c / a.c[a.pos[pg]] - 1 : NaN;
    let extra = '';
    const mk = buildMarks(a, bc.bars);
    if (mk && mk[i]) {
      extra = '<div class="rw" style="margin-top:5px;border-top:1px solid #242c3a;padding-top:5px">' +
        '<span>当日成交</span><span></span></div>';
      for (const t of mk[i]) {
        const st = Chart.MK_STYLE[t.action] || {};
        extra += row('<span style="color:' + (st.color || '#888') + '">' + (st.name || '成交') + '</span>',
          t.qty.toFixed(4) + ' @ ' + px(a, t.price) + ' · ' + fmtMoney(t.amt, 0));
      }
    }
    el.innerHTML = '<div class="hd">' + a.cn + ' · ' + DATA.dates[b.g] + '</div>' +
      row('开盘', px(a, b.o)) + row('最高', px(a, b.h)) + row('最低', px(a, b.l)) + row('收盘', px(a, b.c)) +
      row('日内', '<span class="' + cls(ch) + '">' + fmtPct(ch) + '</span>') +
      row('较前日', '<span class="' + cls(pch) + '">' + (isFinite(pch) ? fmtPct(pch) : '—') + '</span>') +
      (b.v ? row('成交量', Chart.fmtVol(b.v)) : '') + extra;
    el.style.display = 'block';
    place(el, cv, r, e);
  } else {
    const n = S.eq.length;
    if (i < 0 || i >= n) { el.style.display = 'none'; return; }
    const my = S.eq[i], bm = S.bench[i], sp = S.benchSPX ? S.benchSPX[i] : NaN;
    el.innerHTML = '<div class="hd">' + DATA.dates[S.startG + i] + '</div>' +
      row('我的权益', fmtMoney(my, 0)) +
      row('我的收益', '<span class="' + cls(my / S.initCash - 1) + '">' + fmtPct(my / S.initCash - 1) + '</span>') +
      row('等权基准', '<span class="' + cls(bm / S.initCash - 1) + '">' + fmtPct(bm / S.initCash - 1) + '</span>') +
      (isFinite(sp) ? row('标普500', '<span class="' + cls(sp / S.initCash - 1) + '">' + fmtPct(sp / S.initCash - 1) + '</span>') : '');
    el.style.display = 'block';
    place(el, cv, r, e);
  }
}
function row(k, v) { return '<div class="rw"><span>' + k + '</span><span>' + v + '</span></div>'; }
function place(el, cv, r, e) {
  const w = el.offsetWidth, h = el.offsetHeight;
  let x = e.clientX - r.left + 16, y = e.clientY - r.top + 12;
  if (x + w > r.width - 4) x = e.clientX - r.left - w - 16;
  if (y + h > r.height - 4) y = Math.max(4, r.height - h - 4);
  el.style.left = x + 'px'; el.style.top = y + 'px';
}

/* ---------------- 启动 ---------------- */
(function boot() {
  // 先让"解码中"加载层画出来，再做重活
  setTimeout(function () {
    try {
      loadUI(); applyUI();
      const sv = loadSave();
      if (sv) { restore(sv); S.playing = false; if (!S.benchBase || !S.benchBase.length) buildBenchmark(); }
      bind();
      setTab(sv ? S.tab : 'chart');
      syncSpeedUI();
      renderAll();
      setInterval(clockLoop, 120);
      const b = document.getElementById('boot'); if (b) b.remove();
      openGameModal(!!sv);
      if (sv) toast('检测到上局存档：可「继续上局」或直接「开始交易」重开', 'ok');
      if (!STORAGE_OK) toast('当前环境不支持本地存档，进度不会被保留', 'bad');
    } catch (err) {
      const m = document.getElementById('bootMsg');
      if (m) { m.style.color = '#ff9d9d'; m.textContent = '初始化失败：' + err.message; }
      const bb = document.getElementById('boot');
      if (bb) bb.querySelector('div').style.animation = 'none';
      throw err;
    }
  }, 30);
})();
}
