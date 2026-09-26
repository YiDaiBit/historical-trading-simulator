/* ============================================================
   01_codec.js — 载荷解码与数据预处理
   载荷格式：varint(差分+zigzag) → XOR → base64，全部内嵌于 HTML。
   目的是让"未来数据"不能被人肉直接 grep 出来。
   ============================================================ */
const Payload = (function () {
  const KEY = [0x5a, 0x37, 0xc1, 0x6e, 0x93, 0x2b, 0xf0, 0x4d, 0x11, 0xa6, 0x74, 0xcd, 0x02, 0xe9, 0x58, 0x3f];

  function b64bytes(s) {
    const bin = atob(s);
    const n = bin.length;
    const a = new Uint8Array(n);
    for (let i = 0; i < n; i++) a[i] = bin.charCodeAt(i);
    return a;
  }
  function unxor(b) {
    const n = b.length, o = new Uint8Array(n), kl = KEY.length;
    for (let i = 0; i < n; i++) o[i] = b[i] ^ KEY[i % kl];
    return o;
  }
  /* 解出 n 个 zigzag+差分 编码的整数，再做前缀和 */
  function varints(buf, n) {
    const out = new Int32Array(n);
    let acc = 0, v = 0, shift = 0, k = 0;
    for (let i = 0; i < buf.length && k < n; i++) {
      const b = buf[i];
      if (shift < 28) v += (b & 0x7f) * (1 << shift);
      else v += (b & 0x7f) * Math.pow(2, shift);
      if (b & 0x80) { shift += 7; }
      else {
        // zigzag 解码
        const d = (v % 4294967296) >>> 1 ^ -((v & 1));
        acc += d;
        out[k++] = acc;
        v = 0; shift = 0;
      }
    }
    return out;
  }

  function decode(pl) {
    const D = varints(unxor(b64bytes(pl.d)), pl.nd);
    const DAY = 86400000;
    const dates = new Array(D.length);
    for (let i = 0; i < D.length; i++) {
      const dt = new Date(D[i] * DAY);
      dates[i] = dt.getUTCFullYear() + '-' + String(dt.getUTCMonth() + 1).padStart(2, '0') + '-' + String(dt.getUTCDate()).padStart(2, '0');
    }

    const assets = {}, list = [];
    for (const m of pl.m) {
      const raw = pl.a[m.k];
      const idx = varints(unxor(b64bytes(raw.i)), m.n);
      const sc = m.s;                                  // 价格放大倍数
      const buf = {};
      for (const f of ['o', 'h', 'l', 'c', 'v']) {
        if (raw[f]) buf[f] = varints(unxor(b64bytes(raw[f])), m.n);
      }
      const A = {
        key: m.k, cn: m.cn, en: m.en, cat: m.cat, src: m.src, sc: sc,
        idx: idx, n: m.n, d0: idx[0], d1: idx[idx.length - 1],
        o: new Float64Array(m.n), h: new Float64Array(m.n),
        l: new Float64Array(m.n), c: new Float64Array(m.n), v: null,
        // 以全局日期轴为索引的查表
        pos: new Int32Array(pl.nd).fill(-1),
        mark: new Float64Array(pl.nd),
        has: new Uint8Array(pl.nd),
        tradable: false
      };
      for (let k = 0; k < m.n; k++) {
        A.o[k] = buf.o[k] / sc; A.h[k] = buf.h[k] / sc;
        A.l[k] = buf.l[k] / sc; A.c[k] = buf.c[k] / sc;
        A.pos[idx[k]] = k; A.has[idx[k]] = 1;
      }
      if (buf.v) { A.v = new Float64Array(m.n); for (let k = 0; k < m.n; k++) A.v[k] = buf.v[k]; }

      // 前向填充的标记价（休市日沿用上一个收盘价）
      let last = NaN;
      for (let g = 0; g < pl.nd; g++) {
        if (A.has[g]) last = A.c[A.pos[g]];
        A.mark[g] = last;
      }
      assets[m.k] = A; list.push(A);
    }
    return { dates: dates, nd: pl.nd, assets: assets, list: list, meta: pl.x };
  }

  return { decode: decode };
})();
