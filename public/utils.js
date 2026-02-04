// ============================================================================
// Utils (centraliza formatação e parsing pt-BR) — refatoração segura (sem regra)
// ============================================================================
window.Utils = window.Utils || (() => {
  const nfCache = new Map();
  const getNF = (opts) => {
    const key = JSON.stringify(opts || {});
    if (!nfCache.has(key)) nfCache.set(key, new Intl.NumberFormat('pt-BR', opts || {}));
    return nfCache.get(key);
  };

  const toNum = (v) => {
    const n = Number(v);
    return Number.isFinite(n) ? n : 0;
  };

  // Currency BRL
  const fmtBRL = (v, { min = 2, max = 2 } = {}) =>
    getNF({ style: 'currency', currency: 'BRL', minimumFractionDigits: min, maximumFractionDigits: max }).format(toNum(v));

  // Plain number
  const fmtNumber = (v, { min = 0, max = 2 } = {}) =>
    getNF({ minimumFractionDigits: min, maximumFractionDigits: max }).format(toNum(v));

  const fmt2 = (v) => fmtNumber(v, { min: 2, max: 2 });

  const fmtPerc = (v, digits = 1) => `${fmtNumber(v, { min: 0, max: digits })}%`;

  // Parse "1.234.567,89" -> 1234567.89
  const parseBR = (txt) => {
    const raw = String(txt ?? '').trim();
    if (!raw) return 0;
    const cleaned = raw.replace(/\./g, '').replace(',', '.').replace(/[^\d\-\+\.]/g, '');
    const n = Number(cleaned);
    return Number.isFinite(n) ? n : 0;
  };

  return { fmtBRL, fmtNumber, fmt2, fmtPerc, parseBR };
})();