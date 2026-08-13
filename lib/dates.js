/* ============================================================
   共享日期与会议重复逻辑（UMD：服务端 require / 浏览器 <script>）
   收敛原 server.js 与 public/app.js 中重复的三份实现，
   支持：周重复展开、单场取消（skipDates）、下一次发生时间
   ============================================================ */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.MBDates = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const pad2 = (n) => String(n).padStart(2, '0');

  function isoDate(d) {
    return d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate());
  }

  function parseISO(s) {
    const [y, m, d] = String(s || '').split('-').map(Number);
    return new Date(y, m - 1, d);
  }

  function toMin(s) {
    const [h, m] = String(s || '').split(':').map(Number);
    return (h || 0) * 60 + (m || 0);
  }

  function minutesOf(m) {
    return Math.max(0, toMin(m.end) - toMin(m.start));
  }

  function startOfWeek(d) {
    const x = new Date(d.getFullYear(), d.getMonth(), d.getDate());
    x.setDate(x.getDate() - ((x.getDay() + 6) % 7));
    return x;
  }

  function toDateStr(d) {
    return isoDate(d);
  }

  // 该场次是否被单独取消（仅周重复会议使用）
  function isSkipped(m, date) {
    return Array.isArray(m.skipDates) && m.skipDates.includes(date);
  }

  // 会议是否发生在某天（周重复按每周展开，已取消的场次不算）
  function occursOn(m, date) {
    const base = parseISO(m.date);
    if (m.repeat === 'weekly') {
      const d = parseISO(date);
      return base.getDay() === d.getDay() && date >= m.date && !isSkipped(m, date);
    }
    return m.date === date && !isSkipped(m, date);
  }

  // 会议在 [from, to] 内的所有发生日期（周重复展开，剔除 skipDates）
  function occurrences(m, from, to) {
    const dates = [];
    const base = parseISO(m.date);
    const f = parseISO(from), t = parseISO(to);
    if (m.repeat === 'weekly') {
      const first = new Date(f);
      const diff = ((base.getDay() - f.getDay() + 7) % 7);
      first.setDate(first.getDate() + diff);
      // 系列从基期（首次创建）起算，基期之前的同星期日期不计入
      if (first < base) first.setTime(base.getTime());
      let guard = 0;
      for (let d = new Date(first); d <= t; d.setDate(d.getDate() + 7)) {
        const iso = isoDate(d);
        if (!isSkipped(m, iso)) dates.push(iso);
        if (++guard > 1000) break;
      }
    } else if (base >= f && base <= t && !isSkipped(m, m.date)) {
      dates.push(m.date);
    }
    return dates;
  }

  function occurrenceCount(m, from, to) {
    return occurrences(m, from, to).length;
  }

  // 会议下一次发生（相对 after），考虑每周重复与单场取消，返回 Date 或 null
  function nextOccurrence(m, after) {
    const startMin = toMin(m.start);
    const [y, mo, d] = String(m.date || '').split('-').map(Number);
    if (!y || !mo || !d) return null;
    const base = parseISO(m.date);
    if (m.repeat === 'weekly') {
      const today = new Date(after.getFullYear(), after.getMonth(), after.getDate());
      const diff = ((base.getDay() - today.getDay() + 7) % 7);
      let occ = new Date(today.getFullYear(), today.getMonth(), today.getDate() + diff, Math.floor(startMin / 60), startMin % 60);
      if (occ < base) occ = base;
      if (occ < after) occ = new Date(occ.getTime() + 7 * 86400000);
      let guard = 0;
      while (isSkipped(m, isoDate(occ))) {
        occ = new Date(occ.getTime() + 7 * 86400000);
        if (++guard > 60) return null;
      }
      return occ;
    }
    const occ = new Date(y, mo - 1, d, Math.floor(startMin / 60), startMin % 60);
    return occ >= after ? occ : null;
  }

  return {
    pad2, isoDate, parseISO, toMin, minutesOf, startOfWeek, toDateStr,
    isSkipped, occursOn, occurrences, occurrenceCount, nextOccurrence
  };
});
