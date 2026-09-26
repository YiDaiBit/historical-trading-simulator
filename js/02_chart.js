/* ============================================================
   02_chart.js — 纯 Canvas 图表引擎（K线 / 折线），无外部依赖
   ============================================================ */
const Chart = (function () {
  const UP = '#f0433f', DOWN = '#12b76a';
  const GRID = '#1b2230', AXIS = '#5d6b7d', TXT = '#9aa7b8';
  const MA_COLOR = { 5: '#e8b339', 10: '#4c9aff', 20: '#a78bfa', 30: '#39c0c8', 60: '#39c0c8', 120: '#e07b39', 250: '#d16ba5' };
  /* 买卖点：形状表示方向（▲买 ▼卖），实心=开仓，空心=平仓 */
  const MK_STYLE = {
    openLong:   { up: true,  filled: true,  color: '#f0433f', name: '开多' },
    closeShort: { up: true,  filled: false, color: '#f0433f', name: '平空' },
    openShort:  { up: false, filled: true,  color: '#12b76a', name: '开空' },
    closeLong:  { up: false, filled: false, color: '#12b76a', name: '平多' }
  };
  const PADL = 8, PADR = 66, PADT = 12, PADB = 24;

  function setup(cv) {
    const dpr = window.devicePixelRatio || 1;
    const r = cv.getBoundingClientRect();
    const w = Math.max(60, Math.round(r.width)), h = Math.max(60, Math.round(r.height));
    if (cv.width !== Math.round(w * dpr) || cv.height !== Math.round(h * dpr)) {
      cv.width = Math.round(w * dpr); cv.height = Math.round(h * dpr);
    }
    const ctx = cv.getContext('2d');
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);
    return { ctx: ctx, w: w, h: h };
  }

  function fmt(v, dec) {
    if (!isFinite(v)) return '—';
    let d = dec;
    if (d === undefined) {
      const a = Math.abs(v);
      d = a >= 1000 ? 1 : a >= 100 ? 2 : a >= 1 ? 3 : a >= 0.01 ? 4 : 6;
    }
    return v.toLocaleString('en-US', { minimumFractionDigits: d, maximumFractionDigits: d });
  }
  function fmtBig(v) {
    const a = Math.abs(v);
    if (a >= 1e12) return (v / 1e12).toFixed(2) + 'T';
    if (a >= 1e9) return (v / 1e9).toFixed(2) + 'B';
    if (a >= 1e6) return (v / 1e6).toFixed(2) + 'M';
    if (a >= 1e4) return (v / 1e3).toFixed(1) + 'K';
    return fmt(v, 0);
  }
  function fmtVol(v) {
    const a = Math.abs(v);
    if (a >= 1e9) return (v / 1e9).toFixed(2) + 'B';
    if (a >= 1e6) return (v / 1e6).toFixed(2) + 'M';
    if (a >= 1e3) return (v / 1e3).toFixed(1) + 'K';
    return String(Math.round(v));
  }

  /* 图表区太小时，把尺寸和原因直接画出来，避免"一片空白无从排查" */
  function tooSmall(ctx, W, H, pw, ph, what) {
    ctx.save();
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.fillStyle = '#6b7a8d';
    ctx.font = '13px "PingFang SC","Hiragino Sans GB",sans-serif';
    ctx.fillText('⚠ ' + what + '可用区域太小', W / 2, H / 2 - 26);
    ctx.font = '11px "SF Mono",Menlo,monospace';
    ctx.fillStyle = '#8b949e';
    ctx.fillText('当前画布 ' + Math.round(W) + ' × ' + Math.round(H) +
      '，绘图区 ' + Math.round(pw) + ' × ' + Math.round(ph), W / 2, H / 2 - 4);
    ctx.fillText('请拉宽窗口，或拖动分隔条把这一栏调宽', W / 2, H / 2 + 16);
    ctx.fillText('（双击分隔条可恢复默认宽度）', W / 2, H / 2 + 34);
    ctx.restore();
  }

  /* ---------- 统一时间轴：上一行年份带，下一行刻度 ---------- */
  const AXIS_H = 28;                 // 底部为时间轴预留的总高度
  function spanFmt(d0, d1) {
    const days = (Date.parse(d1) - Date.parse(d0)) / 86400000;
    if (!isFinite(days)) return d => d.slice(2, 7);
    if (days <= 120) return d => d.slice(5);        // MM-DD
    return d => d.slice(2, 7);                      // YY-MM
  }
  /* opt: { n, X(i), dateAt(i), plotW, axisTop, tickStep, fmt } */
  function timeAxis(ctx, opt) {
    const n = opt.n; if (!n) return;
    const X = opt.X, dateAt = opt.dateAt, plotW = opt.plotW, axisTop = opt.axisTop;
    const yr = i => String(dateAt(i)).slice(0, 4);
    ctx.save();
    ctx.textBaseline = 'top';

    // ---- 上行：年份带 ----
    ctx.font = 'bold 10px "SF Mono",Menlo,monospace';
    ctx.textAlign = 'center';
    let i = 0;
    while (i < n) {
      const y0 = yr(i);
      let j = i;
      while (j + 1 < n && yr(j + 1) === y0) j++;
      const xs = X(i), xe = X(j);
      const onlyYear = (i === 0 && j === n - 1);  // 整张图只有一年时，再窄也要标
      // 起始年份必标；其余年份宽于 18px 才标，免得糊成一团
      if (xe - xs >= 18 || onlyYear || i === 0) {
        if (i > 0) {                             // 年份分隔线
          ctx.strokeStyle = 'rgba(122,142,172,.35)';
          ctx.lineWidth = 1;
          ctx.beginPath();
          ctx.moveTo(Math.round(xs) + .5, axisTop - 1);
          ctx.lineTo(Math.round(xs) + .5, axisTop + 21);
          ctx.stroke();
        }
        const tw = ctx.measureText(y0).width;
        let cx = (xs + xe) / 2;
        cx = Math.max(PADL + tw / 2, Math.min(cx, PADL + plotW - tw / 2));
        ctx.fillStyle = '#a9b6c8';
        ctx.fillText(y0, cx, axisTop);
      }
      i = j + 1;
    }

    // ---- 下行：刻度 ----
    ctx.font = '10px "SF Mono",Menlo,monospace';
    ctx.textAlign = 'left';
    const step = Math.max(1, opt.tickStep);
    for (let k = n - 1; k >= 0; k -= step) {
      const s = opt.fmt(String(dateAt(k)));
      const tw = ctx.measureText(s).width;
      let tx = X(k) - tw / 2;
      tx = Math.max(PADL, Math.min(tx, PADL + plotW - tw));
      ctx.fillStyle = AXIS;
      ctx.fillText(s, tx, axisTop + 13);
    }
    ctx.restore();
  }

  function ticks(lo, hi, n) {
    if (!isFinite(lo) || !isFinite(hi) || hi <= lo) { hi = lo + 1; }
    const raw = (hi - lo) / n;
    const mag = Math.pow(10, Math.floor(Math.log10(raw)));
    const norm = raw / mag;
    const step = (norm <= 1 ? 1 : norm <= 2 ? 2 : norm <= 2.5 ? 2.5 : norm <= 5 ? 5 : 10) * mag;
    const out = [];
    for (let v = Math.ceil(lo / step) * step; v <= hi + step * 1e-6; v += step) out.push(v);
    return out;
  }

  /* ---------- 十字线 ---------- */
  function crosshair(ctx, L, x, y) {
    ctx.save();
    ctx.strokeStyle = 'rgba(200,215,235,.34)'; ctx.lineWidth = 1;
    ctx.setLineDash([3, 3]);
    ctx.beginPath();
    ctx.moveTo(Math.round(x) + .5, L.pt); ctx.lineTo(Math.round(x) + .5, L.pt + L.ph);
    ctx.moveTo(PADL, Math.round(y) + .5); ctx.lineTo(PADL + L.pw, Math.round(y) + .5);
    ctx.stroke();
    ctx.restore();
  }

  /* =========================================================
     K 线图
     spec = { dates, bars:[{g,o,h,l,c,v}], ma:[5,20], showVol, hover }
     ========================================================= */
  function candles(cv, spec) {
    const S = setup(cv), ctx = S.ctx, W = S.w, H = S.h;
    const bars = spec.bars || [];
    const plotW = W - PADL - PADR;
    const volH = spec.showVol && bars.length ? Math.round((H - PADT - AXIS_H) * 0.16) : 0;
    const plotH = H - PADT - AXIS_H - (volH ? volH + 10 : 0);
    const L = { pt: PADT, ph: plotH, pl: PADL, pw: plotW };
    cv._lay = { n: bars.length, pw: Math.max(plotW, 1), pl: PADL, pt: PADT, ph: Math.max(plotH, 1), bars: bars };

    if (plotH < 30 || plotW < 30) { tooSmall(ctx, W, H, plotW, plotH, 'K线图'); return; }
    if (!bars.length) {
      ctx.fillStyle = AXIS; ctx.font = '13px "PingFang SC",sans-serif';
      ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      ctx.fillText('暂无数据', W / 2, H / 2);
      return;
    }

    // ---- 计算 y 轴范围 ----
    let lo = Infinity, hi = -Infinity;
    for (const b of bars) { if (b.l < lo) lo = b.l; if (b.h > hi) hi = b.h; }
    // 均线也纳入范围
    const maKeys = spec.ma || [];
    const maSeries = {};
    const all = spec.allCandles;   // Float64Array 的局部序列（含当前光标之前的全部）
    for (const m of maKeys) {
      const arr = new Float64Array(bars.length).fill(NaN);
      for (let i = 0; i < bars.length; i++) {
        const k = bars[i].k;
        if (k >= m - 1) {
          let s = 0;
          for (let j = 0; j < m; j++) s += all.c[k - j];
          arr[i] = s / m;
          if (arr[i] < lo) lo = arr[i];
          if (arr[i] > hi) hi = arr[i];
        }
      }
      maSeries[m] = arr;
    }
    if (!isFinite(lo)) { lo = 0; hi = 1; }
    let pad = (hi - lo) * 0.08; if (pad === 0) pad = Math.abs(hi) * 0.01 || 1;
    lo -= pad; hi += pad;

    const n = bars.length;
    const barW = plotW / n;
    const X = i => PADL + i * barW + barW / 2;
    const Y = v => PADT + (hi - v) / (hi - lo) * plotH;

    // ---- 网格 & y 轴 ----
    ctx.font = '10px "SF Mono",Menlo,monospace';
    ctx.textAlign = 'left'; ctx.textBaseline = 'middle';
    const tk = ticks(lo, hi, 6);
    ctx.strokeStyle = GRID; ctx.lineWidth = 1;
    for (const t of tk) {
      const y = Math.round(Y(t)) + .5;
      if (y < PADT - 1 || y > PADT + plotH + 1) continue;
      ctx.beginPath(); ctx.moveTo(PADL, y); ctx.lineTo(PADL + plotW, y); ctx.stroke();
      ctx.fillStyle = TXT;
      ctx.fillText(fmt(t, spec.dec), PADL + plotW + 6, y);
    }

    // ---- 成交量 ----
    if (volH) {
      let vmax = 0;
      for (const b of bars) if (b.v > vmax) vmax = b.v;
      if (vmax > 0) {
        const vy0 = PADT + plotH + 10, vh = volH;
        for (let i = 0; i < n; i++) {
          const b = bars[i];
          const up = b.c >= b.o;
          ctx.fillStyle = up ? 'rgba(240,67,63,.5)' : 'rgba(18,183,106,.5)';
          const bh = Math.max(1, b.v / vmax * vh);
          const bw = Math.max(1, barW * 0.66);
          ctx.fillRect(X(i) - bw / 2, vy0 + vh - bh, bw, bh);
        }
        ctx.fillStyle = AXIS; ctx.textAlign = 'left';
        ctx.fillText('VOL ' + fmtVol(vmax), PADL + plotW + 6, vy0 + 6);
      }
    }

    // ---- K 线 ----
    const thin = barW < 2.6;
    if (thin) {
      // 太密 → 用收盘价折线 + 涨跌色
      ctx.lineWidth = 1; ctx.beginPath();
      for (let i = 0; i < n; i++) { const b = bars[i]; i ? ctx.lineTo(X(i), Y(b.c)) : ctx.moveTo(X(i), Y(b.c)); }
      ctx.strokeStyle = '#8fa6c4'; ctx.stroke();
    } else {
      const bw = Math.max(1, Math.min(barW * 0.7, 17));
      for (let i = 0; i < n; i++) {
        const b = bars[i], up = b.c >= b.o;
        const col = up ? UP : DOWN;
        const x = X(i);
        ctx.strokeStyle = col; ctx.fillStyle = col; ctx.lineWidth = 1;
        const xr = Math.round(x) + .5;
        ctx.beginPath(); ctx.moveTo(xr, Y(b.h)); ctx.lineTo(xr, Y(b.l)); ctx.stroke();
        const yo = Y(b.o), yc = Y(b.c);
        const top = Math.min(yo, yc), hgt = Math.max(1, Math.abs(yc - yo));
        if (spec.hollow !== false && up) {
          ctx.fillStyle = '#0e131c';
          ctx.fillRect(Math.round(x - bw / 2), Math.round(top), Math.round(bw), Math.round(hgt));
          ctx.strokeRect(Math.round(x - bw / 2) + .5, Math.round(top) + .5, Math.round(bw) - 1, Math.round(hgt) - 1);
        } else {
          ctx.fillRect(Math.round(x - bw / 2), Math.round(top), Math.round(bw), Math.round(hgt));
        }
      }
    }

    // ---- 均线 ----
    let li = 0;
    for (const m of maKeys) {
      const arr = maSeries[m];
      ctx.strokeStyle = MA_COLOR[m] || '#888'; ctx.lineWidth = 1.3;
      ctx.beginPath(); let started = false;
      for (let i = 0; i < n; i++) {
        if (!isFinite(arr[i])) continue;
        started ? ctx.lineTo(X(i), Y(arr[i])) : (ctx.moveTo(X(i), Y(arr[i])), started = true);
      }
      ctx.stroke(); li++;
    }

    // ---- 历史买卖点 ----
    if (spec.marks) {
      const marks = spec.marks, mx = spec.markMax || 1;
      const dense = barW < 3.2;                    // 太密就退化画小圆点
      for (let i = 0; i < n; i++) {
        const ms = marks[i]; if (!ms) continue;
        let upK = 0, dnK = 0;
        for (let q = 0; q < ms.length; q++) {
          const mk = ms[q];
          const st = MK_STYLE[mk.action] || MK_STYLE.openLong;
          const x = X(i), b = bars[i];
          const wt = mx > 0 ? Math.min(1, (mk.amt || 0) / mx) : 0.5;
          if (dense) {
            const y = st.up ? Y(b.l) + 5 : Y(b.h) - 5;
            ctx.fillStyle = st.color;
            ctx.beginPath();
            ctx.arc(x, Math.max(PADT + 3, Math.min(PADT + plotH - 3, y)), st.filled ? 2.2 : 1.6, 0, Math.PI * 2);
            st.filled ? ctx.fill() : (ctx.strokeStyle = st.color, ctx.lineWidth = 1, ctx.stroke());
            continue;
          }
          const sz = 5 + 5 * wt;
          let y;
          if (st.up) { y = Y(b.l) + 9 + upK * (sz * 1.5); upK++; }
          else { y = Y(b.h) - 9 - dnK * (sz * 1.5); dnK++; }
          y = Math.max(PADT + sz + 2, Math.min(PADT + plotH - sz - 2, y));
          ctx.beginPath();
          if (st.up) {
            ctx.moveTo(x, y - sz);
            ctx.lineTo(x - sz * 0.82, y + sz * 0.62);
            ctx.lineTo(x + sz * 0.82, y + sz * 0.62);
          } else {
            ctx.moveTo(x, y + sz);
            ctx.lineTo(x - sz * 0.82, y - sz * 0.62);
            ctx.lineTo(x + sz * 0.82, y - sz * 0.62);
          }
          ctx.closePath();
          if (st.filled) { ctx.fillStyle = st.color; ctx.fill(); }
          else {
            ctx.fillStyle = '#0e131c'; ctx.fill();
            ctx.strokeStyle = st.color; ctx.lineWidth = 1.6; ctx.stroke();
          }
        }
      }
    }

    // ---- 当前价标注 ----
    const lastB = bars[n - 1];
    const lastC = lastB.c, upLast = lastC >= lastB.o;
    const yLast = Y(lastC);
    ctx.save();
    ctx.strokeStyle = upLast ? UP : DOWN; ctx.globalAlpha = .55; ctx.setLineDash([4, 4]); ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(PADL, Math.round(yLast) + .5); ctx.lineTo(PADL + plotW, Math.round(yLast) + .5); ctx.stroke();
    ctx.restore();
    ctx.fillStyle = upLast ? UP : DOWN;
    const labW = PADR - 8, labH = 15;
    ctx.fillRect(PADL + plotW + 3, yLast - labH / 2, labW, labH);
    ctx.fillStyle = '#fff'; ctx.font = 'bold 10.5px "SF Mono",Menlo,monospace';
    ctx.textAlign = 'left'; ctx.textBaseline = 'middle';
    ctx.fillText(fmt(lastC, spec.dec), PADL + plotW + 7, yLast);

    // ---- x 轴：年份带 + 刻度 ----
    timeAxis(ctx, {
      n: n, X: X, plotW: plotW,
      dateAt: i => spec.dates[bars[i].g],
      axisTop: PADT + plotH + (volH ? volH + 10 : 0) + 4,
      tickStep: Math.max(1, Math.ceil(n / Math.max(2, Math.floor(plotW / 92)))),
      fmt: spanFmt(spec.dates[bars[0].g], spec.dates[bars[n - 1].g])
    });

    // ---- hover ----
    if (spec.hover >= 0 && spec.hover < n) {
      const b = bars[spec.hover];
      crosshair(ctx, L, X(spec.hover), Y(b.c));
      ctx.fillStyle = '#0d1119'; ctx.strokeStyle = '#2f3949';
      const yy = Y(b.c);
      ctx.beginPath();
      const bw2 = PADR - 9;
      ctx.rect(PADL + plotW + 3, yy - 8, bw2, 16);
      ctx.fill(); ctx.stroke();
      ctx.fillStyle = '#e6edf3'; ctx.font = 'bold 10.5px "SF Mono",Menlo,monospace';
      ctx.textAlign = 'left'; ctx.textBaseline = 'middle';
      ctx.fillText(fmt(b.c, spec.dec), PADL + plotW + 7, yy);
    }
  }

  /* =========================================================
     折线图（资金曲线）
     spec = { labels:[dateStr], series:[{name,color,data:Float64Array,fill,width}],
              log, hover }
     data 中 NaN 表示无数据
     ========================================================= */
  function lines(cv, spec) {
    const S = setup(cv), ctx = S.ctx, W = S.w, H = S.h;
    const series = (spec.series || []).filter(s => s.data && s.data.length);
    if (!series.length) {
      ctx.fillStyle = AXIS; ctx.font = '13px "PingFang SC",sans-serif';
      ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      ctx.fillText('还没有数据，先让时间走一段', W / 2, H / 2);
      return;
    }
    const n = series[0].data.length;
    const plotW = W - PADL - PADR, plotH = H - PADT - AXIS_H;
    if (plotW < 30 || plotH < 30) { tooSmall(ctx, W, H, plotW, plotH, '图表'); return; }
    const L = { pt: PADT, ph: plotH, pl: PADL, pw: plotW };
    cv._lay = { n: n, pw: plotW, pl: PADL, pt: PADT, ph: plotH };

    const useLog = !!spec.log;
    const T = v => useLog ? Math.log(Math.max(v, 1e-9)) : v;
    let lo = Infinity, hi = -Infinity;
    for (const s of series) for (let i = 0; i < n; i++) {
      const v = s.data[i]; if (!isFinite(v)) continue;
      const t = T(v); if (t < lo) lo = t; if (t > hi) hi = t;
    }
    if (!isFinite(lo)) { lo = 0; hi = 1; }
    let pad = (hi - lo) * 0.08; if (pad === 0) pad = Math.abs(hi) * .02 || 1;
    lo -= pad; hi += pad;

    const X = i => PADL + (n <= 1 ? plotW / 2 : i / (n - 1) * plotW);
    const Y = v => PADT + (hi - T(v)) / (hi - lo) * plotH;

    // 网格
    ctx.font = '10px "SF Mono",Menlo,monospace';
    ctx.textAlign = 'left'; ctx.textBaseline = 'middle';
    let tk;
    if (useLog) {
      tk = (function () {
        const out = [], l0 = Math.ceil(lo), l1 = Math.floor(hi);
        const stp = Math.max(1, Math.ceil((l1 - l0) / 7));
        for (let k = l0; k <= l1; k += stp) out.push(Math.exp(k));
        return out;
      })();
      if (tk.length < 2) tk = ticks(Math.exp(lo), Math.exp(hi), 5);
    } else tk = ticks(lo, hi, 6);
    ctx.strokeStyle = GRID; ctx.lineWidth = 1;
    for (const t of tk) {
      const y = Math.round(Y(t)) + .5;
      if (y < PADT - 1 || y > PADT + plotH + 1) continue;
      ctx.beginPath(); ctx.moveTo(PADL, y); ctx.lineTo(PADL + plotW, y); ctx.stroke();
      ctx.fillStyle = TXT;
      ctx.fillText(spec.pct ? (t * 100 - 100).toFixed(0) + '%' : fmtBig(t), PADL + plotW + 6, y);
    }

    // 起点标记
    if (!spec.pct) {
      const y0 = Math.round(Y(series[0].data[0])) + .5;
      ctx.save(); ctx.setLineDash([2, 4]); ctx.strokeStyle = '#3a4557';
      ctx.beginPath(); ctx.moveTo(PADL, y0); ctx.lineTo(PADL + plotW, y0); ctx.stroke(); ctx.restore();
    }

    // 曲线
    for (const s of series) {
      if (s.fill) {
        const grad = ctx.createLinearGradient(0, PADT, 0, PADT + plotH);
        grad.addColorStop(0, s.fill); grad.addColorStop(1, 'rgba(0,0,0,0)');
        ctx.beginPath(); let st = false;
        for (let i = 0; i < n; i++) { const v = s.data[i]; if (!isFinite(v)) continue; st ? ctx.lineTo(X(i), Y(v)) : (ctx.moveTo(X(i), Y(v)), st = true); }
        if (st) {
          const lastI = (function () { for (let i = n - 1; i >= 0; i--) if (isFinite(s.data[i])) return i; return -1; })();
          ctx.lineTo(X(lastI), PADT + plotH); 
          let fi = 0; for (let i = 0; i < n; i++) if (isFinite(s.data[i])) { fi = i; break; }
          ctx.lineTo(X(fi), PADT + plotH); ctx.closePath();
          ctx.fillStyle = grad; ctx.fill();
        }
      }
      ctx.strokeStyle = s.color; ctx.lineWidth = s.width || 1.6;
      if (s.dash) ctx.setLineDash(s.dash); else ctx.setLineDash([]);
      ctx.beginPath(); let started = false;
      for (let i = 0; i < n; i++) {
        const v = s.data[i]; if (!isFinite(v)) continue;
        started ? ctx.lineTo(X(i), Y(v)) : (ctx.moveTo(X(i), Y(v)), started = true);
      }
      ctx.stroke(); ctx.setLineDash([]);
      if (n === 1) {
        for (let i = 0; i < n; i++) {
          const v = s.data[i]; if (!isFinite(v)) continue;
          ctx.fillStyle = s.color;
          ctx.beginPath(); ctx.arc(X(i), Y(v), 3.2, 0, Math.PI * 2); ctx.fill();
        }
      }
    }

    // x 轴：年份带 + 刻度
    const lab = i => spec.labels[spec.off + i] || '';
    timeAxis(ctx, {
      n: n, X: X, plotW: plotW, dateAt: lab,
      axisTop: PADT + plotH + 4,
      tickStep: Math.max(1, Math.ceil(n / Math.max(2, Math.floor(plotW / 92)))),
      fmt: spanFmt(lab(0), lab(n - 1))
    });

    if (spec.hover >= 0 && spec.hover < n) {
      const x = X(spec.hover);
      crosshair(ctx, L, x, PADT + plotH / 2);
      ctx.save();
      ctx.strokeStyle = 'rgba(200,215,235,.25)';
      ctx.beginPath(); ctx.moveTo(x, PADT); ctx.lineTo(x, PADT + plotH); ctx.stroke();
      ctx.restore();
    }
  }

  /* 根据鼠标 x 找最近的 bar/点 索引 */
  function pick(cv, clientX) {
    const lay = cv._lay; if (!lay || !lay.n) return -1;
    const r = cv.getBoundingClientRect();
    const x = clientX - r.left;
    if (lay.bars) {                       // K线：等宽
      const bw = lay.pw / lay.n;
      let i = Math.floor((x - lay.pl) / bw);
      return Math.max(0, Math.min(lay.n - 1, i));
    }
    const t = (x - lay.pl) / lay.pw;      // 折线：按比例
    let i = Math.round(t * (lay.n - 1));
    return Math.max(0, Math.min(lay.n - 1, i));
  }

  return { candles: candles, lines: lines, pick: pick, fmt: fmt, fmtBig: fmtBig,
           fmtVol: fmtVol, MA_COLOR: MA_COLOR, MK_STYLE: MK_STYLE };
})();
