/* ============================================================
   MeetingBoard 会议排班台 - 前端逻辑（零依赖原生 JS）
   功能：登录 / 日历排班 / 会议列表 / 数据指标 / 成员管理
        提醒（SSE+通知+声音）/ 导出 CSV / 备份恢复 / 中英双语
   v2 新增：会议状态流转、周例会单场取消、RSVP 出席确认、
        变更通知、团队时区本地换算、成员不可用日期、删除可撤销
   ============================================================ */
'use strict';

/* ---------------- 全局状态 ---------------- */
const S = {
  lang: localStorage.getItem('mb_lang') || (navigator.language && navigator.language.toLowerCase().startsWith('zh') ? 'zh' : 'en'),
  me: null,                    // 当前登录用户 {id,name,...}
  users: [],
  meetings: [],
  dicts: { countries: [], types: [] },
  meta: { reminderMinutes: 10, reminderSound: true, timezone: 'Asia/Shanghai' },
  wecom: { enabled: false },
  mail: { enabled: false },
  auditLogs: [],
  tab: 'calendar',
  viewDate: new Date(),        // 日历当前月份
  listFilters: { country: '', type: '', employee: '', status: '', from: '', to: '', search: '' },
  statsScope: 'all',
  statsView: 'team',
  reminders: [],               // 已收到的提醒（铃铛列表）
  editingId: null,
  detailId: null,
  detailOcc: null,             // 详情打开的场次日期（周例会单场）
  soundPref: localStorage.getItem('mb_sound') !== '0',
  _selEmps: [],
  _offDays: []
};

const $ = (id) => document.getElementById(id);
const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

/* ---------------- i18n ---------------- */
function t(key) { return (I18N[S.lang] && I18N[S.lang][key]) || I18N.zh[key] || key; }

function applyLang() {
  document.documentElement.lang = S.lang === 'zh' ? 'zh-CN' : 'en';
  document.title = t('appName') + ' · MeetingBoard';
  document.querySelectorAll('[data-i18n]').forEach((el) => { el.textContent = t(el.dataset.i18n); });
  document.querySelectorAll('[data-i18n-ph]').forEach((el) => { el.placeholder = t(el.dataset.i18nPh); });
  document.querySelectorAll('[data-setlang]').forEach((el) => {
    el.classList.toggle('active', el.dataset.setlang === S.lang);
  });
  renderAll();
  switchTab(S.tab);
}

function setLang(lang) {
  S.lang = lang === 'en' ? 'en' : 'zh';
  localStorage.setItem('mb_lang', S.lang);
  applyLang();
}

/* ---------------- 日期与本地时间 ---------------- */
const D = window.MBDates || { isoDate: (d) => d.toISOString().slice(0, 10), parseISO: (s) => new Date(s + 'T00:00:00') };
const WDAYS_ZH = ['周一', '周二', '周三', '周四', '周五', '周六', '周日'];
const WDAYS_EN = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
const MONTHS_ZH = ['1月', '2月', '3月', '4月', '5月', '6月', '7月', '8月', '9月', '10月', '11月', '12月'];
const MONTHS_EN = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

const isoDate = D.isoDate;
const parseISO = D.parseISO;

function fmtDate(iso) {
  const d = parseISO(iso);
  if (S.lang === 'zh') return `${d.getMonth() + 1}月${d.getDate()}日 ${WDAYS_ZH[(d.getDay() + 6) % 7]}`;
  return `${WDAYS_EN[(d.getDay() + 6) % 7]} ${MONTHS_EN[d.getMonth()]} ${d.getDate()}`;
}
function fmtMonth(d) {
  return S.lang === 'zh' ? `${d.getFullYear()}年${d.getMonth() + 1}月` : `${MONTHS_EN[d.getMonth()]} ${d.getFullYear()}`;
}
function monthLabelShort(d) {
  return S.lang === 'zh' ? `${d.getMonth() + 1}月` : MONTHS_EN[d.getMonth()];
}

/* ---------------- 时区换算 ---------------- */
function teamTZ() { return S.meta.timezone || 'Asia/Shanghai'; }
function tzLabel(tz) {
  try {
    const f = new Intl.DateTimeFormat('en-US', { timeZone: tz, timeZoneName: 'shortOffset' });
    return f.formatToParts(new Date()).find((p) => p.type === 'timeZoneName').value;
  } catch (e) {
    try {
      const f = new Intl.DateTimeFormat('en-US', { timeZone: tz, timeZoneName: 'short' });
      return f.formatToParts(new Date()).find((p) => p.type === 'timeZoneName').value;
    } catch (e2) { return tz; }
  }
}
function zonedParts(d, tz) {
  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false
  });
  const p = fmt.formatToParts(d);
  const get = (ty) => Number(p.find((x) => x.type === ty).value);
  return { y: get('year'), mo: get('month'), d: get('day'), h: get('hour'), mi: get('minute') };
}
// 团队时区的"墙上时间" → 本地时区时间（迭代收敛）
function teamToLocal(dateISO, hm) {
  const [y, mo, d] = String(dateISO || '').split('-').map(Number);
  const [h, mi] = String(hm || '00:00').split(':').map(Number);
  if (!y || !mo || !d) return { date: dateISO, hm: hm || '00:00' };
  let ts = Date.UTC(y, mo - 1, d, h, mi);
  for (let i = 0; i < 5; i++) {
    const p = zonedParts(new Date(ts), teamTZ());
    const want = Date.UTC(y, mo - 1, d, h, mi);
    const got = Date.UTC(p.y, p.mo - 1, p.d, p.h, p.mi);
    const err = want - got;
    if (err === 0) break;
    ts += err;
  }
  const l = new Date(ts);
  return { date: isoDate(l), hm: String(l.getHours()).padStart(2, '0') + ':' + String(l.getMinutes()).padStart(2, '0') };
}
function tzDiffers() {
  try { return Intl.DateTimeFormat().resolvedOptions().timeZone !== teamTZ(); } catch (e) { return false; }
}
function localHM(dateISO, hm) { return teamToLocal(dateISO, hm).hm; }
function fmtTimeRange(m, occ) {
  const d = occ || m.date;
  if (!tzDiffers()) return `${m.start}-${m.end}`;
  return `${localHM(d, m.start)}-${localHM(d, m.end)}`;
}
function fmtTimeRangeFull(m, occ) {
  const d = occ || m.date;
  const base = `${m.start}-${m.end} ${tzLabel(teamTZ())}`;
  if (!tzDiffers()) return base;
  return `${localHM(d, m.start)}-${localHM(d, m.end)} · ${t('teamTime')} ${base}`;
}
function updateTzBadge() {
  const el = $('tzBadge');
  if (!el) return;
  el.textContent = tzLabel(teamTZ());
  el.title = t('teamTimezone') + ': ' + teamTZ();
}
function updateTzHint() {
  const el = $('mTzHint');
  if (!el) return;
  const date = $('mDate').value;
  const start = $('mStart').value;
  const end = $('mEnd').value;
  if (!date || !start) { el.textContent = t('teamTime') + ': ' + tzLabel(teamTZ()); return; }
  if (!tzDiffers()) { el.textContent = t('teamTime') + ': ' + tzLabel(teamTZ()); return; }
  el.textContent = `${t('teamTime')} ${tzLabel(teamTZ())}: ${start}-${end} → ${t('localTime')}: ${localHM(date, start)}-${localHM(date, end)}`;
}

/* ---------------- 市场配色 ---------------- */
const COUNTRY_COLORS = {
  '南亚': '#1F7A68', 'South Asia': '#1F7A68',
  '中亚': '#5B5EA6', 'CIS': '#5B5EA6',
  '尼日利亚': '#3A8F4F', 'Nigeria': '#3A8F4F',
  '巴基斯坦': '#B4651A', 'Pakistan': '#B4651A',
  '孟加拉': '#C05A4A', 'Bangladesh': '#C05A4A',
  '东南亚': '#7A5EA6', 'Southeast Asia': '#7A5EA6',
  '中东': '#2E7DA6', 'Middle East': '#2E7DA6',
  '其他': '#8A8A86', 'Other': '#8A8A86'
};
function countryColor(c) {
  if (COUNTRY_COLORS[c]) return COUNTRY_COLORS[c];
  const hit = Object.keys(COUNTRY_COLORS).find((k) => k !== '其他' && c && c.includes(k));
  return hit ? COUNTRY_COLORS[hit] : COUNTRY_COLORS['其他'];
}

/* ---------------- API ---------------- */
async function api(path, opts = {}) {
  const res = await fetch(path, {
    headers: { 'Content-Type': 'application/json' },
    ...opts,
    body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || res.status);
  return data;
}

function applyData(data) {
  S.users = data.users || [];
  S.meetings = data.meetings || [];
  S.dicts = data.dictionaries || { countries: [], types: [] };
  S.meta = data.meta || { reminderMinutes: 10, reminderSound: true, timezone: 'Asia/Shanghai' };
  S.wecom = data.wecom || { enabled: false };
  S.mail = data.mail || { enabled: false };
  S.auditLogs = data.auditLogs || [];
  if (data.me) S.me = (data.users || []).find((u) => u.id === data.me) || null;
  renderAll();
}

// 登录后刷新全量数据；未登录返回 false
async function refreshData() {
  const data = await api('/api/bootstrap');
  if (!data.authenticated) return false;
  applyData(data);
  return true;
}

// 兼容旧调用点（登录后刷新）
async function loadBootstrap() { await refreshData(); }

/* ---------------- 提醒（浏览器通知 + 声音） ---------------- */
let audioCtx = null;
function beep() {
  try {
    audioCtx = audioCtx || new (window.AudioContext || window.webkitAudioContext)();
    const osc = audioCtx.createOscillator();
    const gain = audioCtx.createGain();
    osc.connect(gain); gain.connect(audioCtx.destination);
    osc.type = 'sine'; osc.frequency.value = 880;
    gain.gain.setValueAtTime(0.001, audioCtx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.35, audioCtx.currentTime + 0.02);
    gain.gain.exponentialRampToValueAtTime(0.001, audioCtx.currentTime + 0.7);
    osc.start(); osc.stop(audioCtx.currentTime + 0.75);
    setTimeout(() => { osc.frequency.value = 660; osc.start(audioCtx.currentTime); osc.stop(audioCtx.currentTime + 0.4); }, 250);
  } catch (e) { /* 忽略声音失败 */ }
}

function notifyBrowser(title, body) {
  try {
    if (Notification.permission === 'granted') new Notification(title, { body, icon: 'favicon.svg' });
  } catch (e) { /* 忽略 */ }
}

function pushReminder(payload) {
  const m = payload.meeting;
  if (!m) return;
  // 到点二次提醒：未确认参会的人
  if (payload.kind === 'ask') {
    if (!S.me || !(m.employeeIds || []).includes(S.me.id)) return;
    if ((m.confirmations || {})[S.me.id] === 'yes') return;
    notifyBrowser(t('askTitle'), m.title + ' ' + m.start + '-' + m.end);
    toastWithAction(`${t('askTitle')}：${m.title} ${fmtTimeRange(m, payload.occurrence)}`, t('confirmAttend'),
      async () => {
        try {
          await api(`/api/meetings/${m.id}/confirm`, { method: 'PATCH', body: { value: 'yes' } });
          toast(t('saved'));
          await loadBootstrap();
        } catch (e) { toast(e.message, 'error'); }
      }, 20000);
    return;
  }
  // 普通会前提醒：仅参会人展示
  if (S.me && !(m.employeeIds || []).includes(S.me.id)) return;
  const names = m.employeeIds.map((id) => userOf(id)).filter(Boolean).map((u) => u.name).join(', ');
  const mm = Math.round(payload.minutesBefore);
  const title = S.lang === 'zh' ? `${m.title} · ${t('remindNow')}` : `${m.title} · Reminder`;
  const when = mm <= 0 ? t('remindAt') : mm + t('minUnit') + ' ' + t('remindMinutes');
  const body = S.lang === 'zh'
    ? `${payload.occurrence} ${m.start}-${m.end}，${when} · ${names}`
    : `${payload.occurrence} ${m.start}-${m.end}, ${when} · ${names}`;
  if (S.me && S.soundPref) beep();
  notifyBrowser(title, body);
  S.reminders.unshift({ ...payload, at: Date.now() });
  if (S.reminders.length > 20) S.reminders.length = 20;
  renderBell();
  toast(`${m.title} · ${fmtTimeRange(m, payload.occurrence)} · ${when}`, 'warn');
}

function connectSSE() {
  const es = new EventSource('/api/events');
  es.addEventListener('changed', () => { if (S.me) refreshData().catch(() => {}); });
  es.addEventListener('reminder', (e) => {
    try { pushReminder(JSON.parse(e.data)); } catch (err) { /* 忽略 */ }
  });
  es.addEventListener('meetingChange', (e) => {
    let d;
    try { d = JSON.parse(e.data); } catch (err) { return; }
    if (!S.me || !d) return;
    if (d.by && d.by === myName(S.me)) return; // 自己操作不重复提示
    const m = S.meetings.find((x) => x.id === d.meetingId);
    const isMine = m && (m.employeeIds || []).includes(S.me.id);
    if (!isMine && S.me.role !== 'admin') return;
    const label = t('mc_' + d.action) || t('mc_updated');
    const occ = d.occurrence ? ' · ' + d.occurrence : '';
    toast(`${label}：${d.title}${occ}`, (d.action === 'deleted' || d.action === 'cancelled') ? 'warn' : '');
  });
  es.onopen = () => $('connBadge').classList.remove('off');
  es.onerror = () => $('connBadge').classList.add('off');
}

/* ---------------- Toast ---------------- */
function toast(msg, type = '') {
  const el = document.createElement('div');
  el.className = 'toast ' + type;
  el.textContent = msg;
  $('toasts').appendChild(el);
  setTimeout(() => { el.classList.add('out'); setTimeout(() => el.remove(), 320); }, 3200);
}

// 带操作按钮的 toast（撤销、确认等）
function toastWithAction(msg, actionLabel, onAction, ms = 6000) {
  const el = document.createElement('div');
  el.className = 'toast';
  const span = document.createElement('span');
  span.textContent = msg;
  const btn = document.createElement('button');
  btn.className = 'toast-act';
  btn.textContent = actionLabel;
  btn.onclick = () => { onAction(); el.classList.add('out'); setTimeout(() => el.remove(), 320); };
  el.appendChild(span);
  el.appendChild(btn);
  $('toasts').appendChild(el);
  setTimeout(() => { el.classList.add('out'); setTimeout(() => el.remove(), 320); }, ms);
}

/* ---------------- 工具 ---------------- */
function userOf(id) { return S.users.find((u) => u.id === id); }
function userName(u) { return S.lang === 'zh' || !(u && u.nameEn) ? (u ? u.name : '') : (u.nameEn || u.name); }
function activeUsers() { return S.users.filter((u) => u.active); }
function isAdmin() { return S.me && S.me.role === 'admin'; }
function myName(u) { return u ? (u.nameEn && S.lang === 'en' ? u.nameEn : u.name) : ''; }

function initials(name) {
  const parts = String(name || '').split(/[\s-]+/).filter(Boolean);
  if (!parts.length) return '?';
  const zh = parts[0].match(/[\u4e00-\u9fa5]/);
  return zh ? parts[0][0] : parts.slice(0, 2).map((p) => p[0]).join('').toUpperCase();
}

function statusOf(m) { return m.status || 'planned'; }

/* ---------------- 渲染入口 ---------------- */
function renderAll() {
  renderCalendar();
  renderList();
  renderStats();
  renderMembers();
  renderAudit();
  renderBell();
  renderDatalists();
  updateTzBadge();
}

/* ---------------- 登录 / 登出 ---------------- */
function enterApp() {
  if (!S.me) return;
  $('loginOverlay').classList.add('hidden');
  $('app').classList.remove('hidden');
  $('meName').textContent = myName(S.me);
  $('navMembers').classList.toggle('hidden', !isAdmin());
  $('navAudit').classList.toggle('hidden', !isAdmin());
  document.querySelectorAll('#mobileNav .mnav-item[data-tab="members"], #mobileNav .mnav-item[data-tab="audit"]').forEach((b) => b.classList.toggle('hidden', !isAdmin()));
  renderAll();
  if (typeof Notification !== 'undefined' && Notification.requestPermission) {
    Notification.requestPermission().catch(() => {});
  }
}

function showWecomLoginOptions() {
  $('wecomLoginBtn').classList.remove('hidden');
  $('wecomQrBtn').classList.remove('hidden');
  $('loginDivider').classList.remove('hidden');
}

async function logout() {
  try { await api('/api/auth/logout', { method: 'POST' }); } catch (e) { /* 忽略 */ }
  S.me = null;
  $('app').classList.add('hidden');
  showWecomLoginOptions();
  $('loginOverlay').classList.remove('hidden');
  $('loginForm').reset();
  $('loginError').classList.add('hidden');
}

/* ---------------- 导航 ---------------- */
function switchTab(tab) {
  S.tab = tab;
  document.querySelectorAll('.nav-item, .mnav-item').forEach((b) => b.classList.toggle('active', b.dataset.tab === tab));
  document.querySelectorAll('.tab').forEach((s) => s.classList.toggle('active', s.id === 'tab-' + tab));
  $('pageTitle').textContent = t({
    calendar: 'nav_calendar', list: 'nav_list', stats: 'nav_stats', members: 'nav_members', audit: 'nav_audit'
  }[tab]);
  $('monthNav').classList.toggle('hidden', tab !== 'calendar');
  $('addMeetingBtn').classList.toggle('hidden', tab === 'members' || tab === 'audit');
  $('pageTitle').classList.toggle('m-hide', window.innerWidth <= 860 && tab === 'calendar');
}

/* ---------------- 日历 ---------------- */
function renderCalendar() {
  $('monthLabel').textContent = fmtMonth(S.viewDate);
  const year = S.viewDate.getFullYear(), month = S.viewDate.getMonth();
  const first = new Date(year, month, 1);
  const start = new Date(first);
  start.setDate(first.getDate() - ((first.getDay() + 6) % 7)); // 周一起始
  const todayISO = isoDate(new Date());
  const from = isoDate(start);
  const end = new Date(start); end.setDate(start.getDate() + 41);
  const to = isoDate(end);

  const wd = $('weekdays');
  wd.innerHTML = '';
  (S.lang === 'zh' ? WDAYS_ZH : WDAYS_EN).forEach((w, i) => {
    const d = document.createElement('div');
    d.textContent = w;
    if (i >= 5) d.style.color = 'var(--amber)';
    wd.appendChild(d);
  });

  const grid = $('calendarGrid');
  grid.innerHTML = '';
  const byDate = {};
  S.meetings.forEach((m) => {
    D.occurrences(m, from, to).forEach((d) => {
      (byDate[d] = byDate[d] || []).push(m);
    });
  });

  for (let i = 0; i < 42; i++) {
    const d = new Date(start); d.setDate(start.getDate() + i);
    const iso = isoDate(d);
    const cell = document.createElement('div');
    cell.className = 'day-cell' + (d.getMonth() !== month ? ' other' : '') + (iso === todayISO ? ' today' : '') + ((d.getDay() === 0 || d.getDay() === 6) ? ' weekend' : '');
    const num = document.createElement('div');
    num.className = 'day-num';
    num.textContent = d.getDate();
    cell.appendChild(num);
    const list = byDate[iso] || [];
    const cells = document.createElement('div');
    cells.className = 'day-cells';
    const maxShow = 4;
    list.slice(0, maxShow).forEach((m) => {
      const st = statusOf(m);
      const chip = document.createElement('div');
      chip.className = 'meeting-chip' + (st === 'cancelled' ? ' chip-cancelled' : '') + (st === 'done' ? ' chip-done' : '');
      chip.style.background = st === 'cancelled' ? undefined : countryColor(m.country);
      chip.title = `${m.title} ${fmtTimeRangeFull(m, iso)}`;
      const time = document.createElement('span');
      time.className = 'chip-time'; time.textContent = localHM(iso, m.start);
      chip.appendChild(time);
      if (st === 'done') {
        const ck = document.createElement('span');
        ck.className = 'chip-check'; ck.textContent = '✓';
        chip.appendChild(ck);
      }
      const txt = document.createElement('span');
      txt.textContent = m.title;
      chip.appendChild(txt);
      if (m.repeat === 'weekly') {
        const rep = document.createElement('span');
        rep.className = 'rep'; rep.textContent = t('repeatBadge');
        chip.appendChild(rep);
      }
      chip.onclick = (ev) => { ev.stopPropagation(); openDetail(m.id, iso); };
      cells.appendChild(chip);
    });
    if (list.length > maxShow) {
      const more = document.createElement('div');
      more.className = 'more-chip';
      more.textContent = S.lang === 'zh' ? `+${list.length - maxShow} 场` : `+${list.length - maxShow} more`;
      cells.appendChild(more);
    }
    cell.appendChild(cells);
    if (!list.length && iso < todayISO && d.getMonth() === month) cell.style.opacity = 0.75;
    cell.onclick = () => openMeetingModal(null, iso);
    grid.appendChild(cell);
  }
}

/* ---------------- 列表 ---------------- */
function filteredMeetings() {
  const f = S.listFilters;
  return S.meetings.filter((m) => {
    if (f.country && m.country !== f.country) return false;
    if (f.type && m.type !== f.type) return false;
    if (f.employee) {
      if (f.employee === '__none__') { if (m.employeeIds.length) return false; }
      else if (!m.employeeIds.includes(f.employee)) return false;
    }
    if (f.status && (m.status || 'planned') !== f.status) return false;
    if (f.from && m.date < f.from) return false;
    if (f.to && m.date > f.to) return false;
    if (f.search && !m.title.toLowerCase().includes(f.search.toLowerCase())) return false;
    return true;
  }).sort((a, b) => a.date === b.date ? (a.start < b.start ? -1 : 1) : (a.date < b.date ? -1 : 1));
}

function renderList() {
  const f = S.listFilters;
  const setOpts = (sel, list, selected, placeholder) => {
    sel.innerHTML = '';
    const o0 = document.createElement('option');
    o0.value = ''; o0.textContent = placeholder;
    sel.appendChild(o0);
    list.forEach((v) => {
      const o = document.createElement('option');
      o.value = v; o.textContent = v;
      sel.appendChild(o);
    });
    sel.value = selected;
  };
  setOpts($('fCountry'), S.dicts.countries, f.country, t('filterCountry'));
  setOpts($('fType'), S.dicts.types, f.type, t('filterType'));
  const stSel = $('fStatus');
  stSel.innerHTML = '';
  [
    ['', t('filterStatus')],
    ['planned', t('st_planned')],
    ['done', t('st_done')],
    ['cancelled', t('st_cancelled')]
  ].forEach(([v, label]) => {
    const o = document.createElement('option');
    o.value = v; o.textContent = label;
    stSel.appendChild(o);
  });
  stSel.value = f.status || '';
  const empSel = $('fEmployee');
  empSel.innerHTML = '';
  const e0 = document.createElement('option'); e0.value = ''; e0.textContent = t('filterEmployee'); empSel.appendChild(e0);
  const e1 = document.createElement('option'); e1.value = '__none__'; e1.textContent = `${t('filterAll')} · ${t('filterNoEmployee')}`; empSel.appendChild(e1);
  activeUsers().forEach((u) => {
    const o = document.createElement('option');
    o.value = u.id; o.textContent = myName(u);
    empSel.appendChild(o);
  });
  empSel.value = f.employee || '';
  $('fFrom').value = f.from;
  $('fTo').value = f.to;
  $('fSearch').value = f.search;

  const rows = filteredMeetings();
  const tb = $('meetingTbody');
  tb.innerHTML = '';
  rows.forEach((m) => {
    const st = statusOf(m);
    const tr = document.createElement('tr');
    if (st === 'cancelled') tr.className = 'row-cancelled';
    const tds = [
      `<td data-label="${t('date')}" class="nowrap">${fmtDate(m.date)}<div class="cell-sub">${fmtTimeRange(m)}${m.repeat === 'weekly' ? ' · ' + t('repeatBadge') : ''}</div></td>`,
      `<td data-label="${t('meetingTitle')}" class="meeting-title"><b>${esc(m.title)}</b> <span class="tag tag-status st-${st}">${t('st_' + st)}</span>${m.note ? `<div class="cell-sub">${esc(m.note)}</div>` : ''}</td>`,
      `<td data-label="${t('country')}"><span class="tag tag-country" style="background:${countryColor(m.country)}">${esc(m.country || '-')}</span></td>`,
      `<td data-label="${t('meetingType')}"><span class="tag tag-type">${esc(m.type || '-')}</span></td>`,
      `<td data-label="${t('employees')}">${m.employeeIds.map((id) => userOf(id)).filter(Boolean).map((u) => `<span class="mini-avatar" title="${esc(myName(u))}">${esc(initials(myName(u)))}</span>`).join('') || '-'}</td>`,
      `<td data-label="${t('channel')}">${esc(m.channel || '-')}</td>`,
      `<td class="row-ops" data-label=""><button class="btn-link" data-view="${m.id}" data-i18n-view="view">${t('view')}</button>${m.repeat === 'weekly' && st !== 'cancelled' ? '<button class="btn-link danger-link" data-cancel-series="' + m.id + '">' + t('cancelSeries') + '</button>' : ''}</td>`
    ].join('');
    tr.innerHTML = tds;
    tr.querySelector('[data-view]').onclick = () => openDetail(m.id);
    const cancelSeries = tr.querySelector('[data-cancel-series]');
    if (cancelSeries) cancelSeries.onclick = () => cancelMeetingSeries(m.id);
    tb.appendChild(tr);
  });
  $('listEmpty').classList.toggle('hidden', rows.length > 0);
  $('listEmpty').textContent = t('noMeetings');
}

/* ---------------- 数据指标 ---------------- */
function scopeStart(scope) {
  const now = new Date();
  if (scope === 'month') return isoDate(new Date(now.getFullYear(), now.getMonth(), 1));
  if (scope === '3m') { const d = new Date(now); d.setDate(d.getDate() - 89); return isoDate(d); }
  if (scope === 'year') return `${now.getFullYear()}-01-01`;
  return '';
}

// 统计口径：范围内（截至今天）实际应开场次，已取消不计，周重复按实际场次计
function scopedRows() {
  const from = scopeStart(S.statsScope) || '0000-01-01';
  const to = isoDate(new Date());
  const rows = [];
  for (const m of S.meetings) {
    if (statusOf(m) === 'cancelled') continue;
    for (const d of D.occurrences(m, from, to)) rows.push({ m, date: d });
  }
  return rows;
}

function aggBy(list, keyFn) {
  const map = new Map();
  list.forEach((r) => {
    const k = keyFn(r);
    if (!map.has(k)) map.set(k, { key: k, count: 0, minutes: 0 });
    const v = map.get(k);
    v.count += 1;
    v.minutes += D.minutesOf(r.m);
  });
  return Array.from(map.values()).sort((a, b) => b.count - a.count);
}

function fmtHours(min) { return (min / 60).toFixed(1); }

function renderBars(el, items, colorFn) {
  el.innerHTML = '';
  if (!items.length) {
    el.innerHTML = `<div class="empty">${t('noStats')}</div>`;
    return;
  }
  const max = Math.max(...items.map((i) => i.count), 1);
  items.forEach((i) => {
    const row = document.createElement('div');
    row.className = 'bar-row';
    const label = document.createElement('div');
    label.className = 'bar-label'; label.textContent = i.key; label.title = i.key;
    const track = document.createElement('div');
    track.className = 'bar-track';
    const fill = document.createElement('div');
    fill.className = 'bar-fill';
    fill.style.background = colorFn(i.key);
    fill.style.width = Math.max(3, (i.count / max) * 100) + '%';
    track.appendChild(fill);
    const val = document.createElement('div');
    val.className = 'bar-val';
    const total = items.reduce((s, x) => s + x.count, 0);
    val.innerHTML = `${i.count}<span class="bar-pct"> · ${total ? Math.round((i.count / total) * 100) : 0}%</span>`;
    row.appendChild(label); row.appendChild(track); row.appendChild(val);
    el.appendChild(row);
  });
}

function renderStats() {
  const rows = scopedRows();
  const mine = S.me ? rows.filter((r) => r.m.employeeIds.includes(S.me.id)) : [];
  const isMine = S.statsView === 'mine';
  $('statsTeamView').classList.toggle('hidden', isMine);
  $('statsMineView').classList.toggle('hidden', !isMine);
  document.querySelectorAll('#statsView .seg-item').forEach((b) => b.classList.toggle('active', b.dataset.view === S.statsView));
  document.querySelectorAll('#statsScope .seg-item').forEach((b) => b.classList.toggle('active', b.dataset.scope === S.statsScope));

  if (isMine) {
    const totalMin = mine.reduce((s, r) => s + D.minutesOf(r.m), 0);
    const countries = new Set(mine.map((r) => r.m.country).filter(Boolean)).size;
    const types = new Set(mine.map((r) => r.m.type).filter(Boolean)).size;
    $('mineSummary').innerHTML = [
      card(mine.length, t('statMeetings'), 'amber'),
      card(fmtHours(totalMin), t('statHours'), 'amber'),
      card(countries, t('statCountries'), 'amber'),
      card(types, t('statTypes'), 'amber')
    ].join('');
    renderBars($('mineCountryBars'), aggBy(mine, (r) => r.m.country || '-'), (k) => countryColor(k));
    renderBars($('mineTypeBars'), aggBy(mine, (r) => r.m.type || '-'), () => '#1F5C4D');
    return;
  }

  // 团队视图
  const totalMin = rows.reduce((s, r) => s + D.minutesOf(r.m), 0);
  const countries = new Set(rows.map((r) => r.m.country).filter(Boolean)).size;
  const activeCount = activeUsers().length;
  $('statCards').innerHTML = [
    card(rows.length, t('statMeetings'), 'primary'),
    card(fmtHours(totalMin), t('statHours'), 'primary'),
    card(countries, t('statCountries'), 'primary'),
    card(activeCount, t('nav_members'), 'primary')
  ].join('');
  renderBars($('countryBars'), aggBy(rows, (r) => r.m.country || '-'), (k) => countryColor(k));
  renderBars($('typeBars'), aggBy(rows, (r) => r.m.type || '-'), () => '#1F5C4D');

  // 员工统计
  const empItems = activeUsers().map((u) => {
    const ms = rows.filter((r) => r.m.employeeIds.includes(u.id));
    return { key: myName(u), count: ms.length, minutes: ms.reduce((s, r) => s + D.minutesOf(r.m), 0), id: u.id };
  }).sort((a, b) => b.count - a.count);
  const empMax = Math.max(...empItems.map((i) => i.count), 1);
  $('employeeBars').innerHTML = '';
  empItems.forEach((i) => {
    const row = document.createElement('div');
    row.className = 'bar-row';
    const label = document.createElement('div');
    label.className = 'bar-label';
    label.innerHTML = `<b>${esc(i.key)}</b>`;
    const track = document.createElement('div'); track.className = 'bar-track';
    const fill = document.createElement('div'); fill.className = 'bar-fill';
    fill.style.background = i.id === (S.me && S.me.id) ? '#B4651A' : '#1F5C4D';
    fill.style.width = Math.max(3, (i.count / empMax) * 100) + '%';
    track.appendChild(fill);
    const val = document.createElement('div');
    val.className = 'bar-val';
    val.textContent = `${i.count}${t('countUnit')} · ${fmtHours(i.minutes)}${t('hourUnit')}`;
    row.appendChild(label); row.appendChild(track); row.appendChild(val);
    $('employeeBars').appendChild(row);
  });

  // 近12周趋势
  const trend = [];
  const now = new Date();
  const ws = D.startOfWeek(now);
  for (let i = 11; i >= 0; i--) {
    const s = new Date(ws); s.setDate(ws.getDate() - i * 7);
    const e = new Date(s); e.setDate(s.getDate() + 6);
    const sISO = isoDate(s), eISO = isoDate(e);
    const cnt = rows.filter((r) => r.date >= sISO && r.date <= eISO).length;
    trend.push({ label: `${s.getMonth() + 1}/${s.getDate()}`, count: cnt });
  }
  const tMax = Math.max(...trend.map((x) => x.count), 1);
  $('trendChart').innerHTML = '';
  trend.forEach((x) => {
    const col = document.createElement('div');
    col.className = 'trend-col';
    const bar = document.createElement('div');
    bar.className = 'trend-bar';
    bar.style.height = Math.max(4, (x.count / tMax) * 100) + '%';
    const tip = document.createElement('div');
    tip.className = 'tip';
    tip.textContent = `${x.count}${t('countUnit')}`;
    bar.appendChild(tip);
    const lab = document.createElement('div');
    lab.className = 'trend-label';
    lab.textContent = x.label;
    col.appendChild(bar); col.appendChild(lab);
    $('trendChart').appendChild(col);
  });
}

function card(num, label, color) {
  const c = color === 'amber' ? 'var(--amber)' : 'var(--primary)';
  return `<div class="stat-card"><div class="num" style="color:${c}">${num}</div><div class="label">${esc(label)}</div></div>`;
}

/* ---------------- 成员管理 ---------------- */
function renderMembers() {
  const tb = $('memberTbody');
  const activeUsers = S.users.filter((u) => u.active);
  const boundUsers = activeUsers.filter((u) => u.wecomUserId);
  const wecomEnabled = !!(S.wecom && S.wecom.enabled);
  const status = $('wecomMemberStatus');
  status.classList.toggle('is-enabled', wecomEnabled);
  status.textContent = wecomEnabled
    ? `${t('wecomEnabled')} · ${t('wecomBoundSummary')} ${boundUsers.length}/${activeUsers.length} · ${t('wecomBindingHint')}`
    : `${t('wecomNotConfigured')} · ${t('wecomBindingHint')}`;
  tb.innerHTML = '';
  if (!S.users.length) return;
  S.users.forEach((u) => {
    const cnt = S.meetings.filter((m) => m.employeeIds.includes(u.id)).length;
    const offCnt = (u.offDays || []).length;
    const tr = document.createElement('tr');
    tr.innerHTML = `
      <td data-label="${t('name')}"><b>${esc(u.name)}</b>${!u.active ? `<span class="cell-sub"> (${t('inactive')})</span>` : ''}${offCnt ? `<span class="tag tag-status st-cancelled" style="margin-left:6px">${t('offDays')} ${offCnt}</span>` : ''}</td>
      <td data-label="${t('englishName')}">${esc(u.nameEn || '-')}</td>
      <td data-label="${t('role')}"><span class="tag tag-type">${u.role === 'admin' ? t('roleAdmin') : t('roleMember')}</span></td>
      <td data-label="${t('meetingCount')}">${cnt}</td>
      <td data-label="${t('wecom')}">${u.wecomUserId ? `<span class="tag tag-country" style="background:#5B5EA6">${esc(u.wecomUserId)}</span> <span class="tag tag-status st-bound">${t('wecomBound')}</span>` : `<span class="tag tag-status st-unbound">${t('wecomUnbound')}</span>`}</td>
      <td data-label="${t('email')}">${esc(u.email || '-')}</td>
      <td data-label="${t('active')}"><label class="switch"><input type="checkbox" data-uid="${u.id}" ${u.active ? 'checked' : ''}><span class="slider"></span></label></td>
      <td class="row-ops" data-label=""><button class="btn-link" data-edit="${u.id}">${t('edit')}</button> <button class="btn-link" data-resetpwd="${u.id}" style="color:var(--amber)">${t('resetPwd')}</button> <button class="btn-link" data-del="${u.id}" style="color:var(--danger)">${t('delete')}</button></td>`;
    tb.appendChild(tr);
    tr.querySelector('[data-edit]').onclick = () => openMemberModal(u.id);
    tr.querySelector('[data-resetpwd]').onclick = async () => {
      if (!confirm(t('resetPwdConfirm'))) return;
      try {
        await api('/api/auth/password', { method: 'PATCH', body: { userId: u.id } });
        toast(t('resetPwdOk'));
      } catch (e) { toast(e.message, 'error'); }
    };
    tr.querySelector('[data-del]').onclick = async () => {
      if (!confirm(t('confirmDelete'))) return;
      const clone = JSON.parse(JSON.stringify(u));
      try {
        await api('/api/users/' + u.id, { method: 'DELETE' });
        toastWithAction(t('deletedUndo'), t('undo'), async () => {
          try {
            await api('/api/users', { method: 'POST', body: { name: clone.name, nameEn: clone.nameEn, wecomUserId: clone.wecomUserId, email: clone.email, role: clone.role, active: clone.active, offDays: clone.offDays } });
            toast(t('saved'));
          } catch (e2) { toast(e2.message, 'error'); }
        });
        await loadBootstrap();
      } catch (e) { toast(e.message, 'error'); }
    };
    tr.querySelector('[data-uid]').onchange = async (ev) => {
      try {
        await api('/api/users/' + u.id, { method: 'PATCH', body: { active: ev.target.checked } });
        await loadBootstrap();
      } catch (e) { toast(e.message, 'error'); }
    };
  });
}

function renderAudit() {
  const body = $('auditTbody');
  const empty = $('auditEmpty');
  if (!body || !empty) return;
  body.innerHTML = '';
  const logs = isAdmin() ? S.auditLogs : [];
  empty.classList.toggle('hidden', logs.length > 0);
  logs.forEach((entry) => {
    const row = document.createElement('tr');
    const when = new Date(entry.at);
    row.innerHTML = `<td>${esc(Number.isNaN(when.getTime()) ? '-' : when.toLocaleString())}</td><td>${esc(entry.actorName || '-')}</td><td>${esc(entry.action || '-')}</td><td>${esc(entry.target || '-')}</td><td>${esc(entry.details || '-')}</td>`;
    body.appendChild(row);
  });
}

function renderWecomBindStatus() {
  const button = $('wecomBindBtn');
  const status = $('wecomBindStatus');
  const enabled = !!(S.wecom && S.wecom.enabled);
  const bound = !!(S.me && S.me.wecomUserId);
  button.classList.toggle('hidden', !enabled || bound);
  status.textContent = !enabled ? t('wecomNotConfigured') : (bound ? t('wecomAlreadyBound') : t('wecomBindHint'));
}
function openProfileModal() {
  if (!S.me) return;
  $('pfNameEn').value = S.me.nameEn || '';
  $('pfEmail').value = S.me.email || '';
  renderWecomBindStatus();
  $('profileModal').classList.remove('hidden');
}
async function bindCurrentWecom() {
  try {
    const result = await api('/api/wecom/bind');
    if (result.url) window.location.href = result.url;
  } catch (e) { toast(e.message || t('wecomNotConfigured'), 'error'); }
}

async function saveProfile(ev) {
  ev.preventDefault();
  if (!S.me) return;
  try {
    await api('/api/users/' + S.me.id, {
      method: 'PATCH',
      body: { nameEn: $('pfNameEn').value.trim(), email: $('pfEmail').value.trim(), me: S.me.id }
    });
    $('profileModal').classList.add('hidden');
    toast(t('saved'));
    await loadBootstrap();
    $('meName').textContent = myName(userOf(S.me.id));
  } catch (e) { toast(e.message, 'error'); }
}

function openMemberModal(id) {
  const u = id ? userOf(id) : null;
  $('memberModalTitle').textContent = u ? t('edit') : t('addMember');
  $('muId').value = u ? u.id : '';
  $('muName').value = u ? u.name : '';
  $('muNameEn').value = u ? (u.nameEn || '') : '';
  $('muWecom').value = u ? (u.wecomUserId || '') : '';
  $('muEmail').value = u ? (u.email || '') : '';
  $('muRole').value = u ? u.role : 'member';
  $('muActive').checked = u ? u.active : true;
  S._offDays = u ? (Array.isArray(u.offDays) ? [...u.offDays] : []) : [];
  renderOffChips();
  $('memberModal').classList.remove('hidden');
}

function renderOffChips() {
  const box = $('muOffChips');
  box.innerHTML = '';
  if (!S._offDays.length) {
    box.innerHTML = `<span style="font-size:12px;color:var(--ink-3)">${t('offEmpty')}</span>`;
    return;
  }
  S._offDays.sort();
  S._offDays.forEach((d) => {
    const chip = document.createElement('button');
    chip.type = 'button';
    chip.className = 'person-chip sel';
    chip.textContent = d + ' ✕';
    chip.onclick = () => {
      S._offDays = S._offDays.filter((x) => x !== d);
      renderOffChips();
    };
    box.appendChild(chip);
  });
}

/* ---------------- 会议弹窗 ---------------- */
function renderDatalists() {
  const cl = $('countryList'), tl = $('typeList');
  cl.innerHTML = '';
  S.dicts.countries.forEach((v) => { const o = document.createElement('option'); o.value = v; cl.appendChild(o); });
  tl.innerHTML = '';
  S.dicts.types.forEach((v) => { const o = document.createElement('option'); o.value = v; tl.appendChild(o); });
}

function renderEmployeeChips() {
  const box = $('mEmployees');
  box.innerHTML = '';
  activeUsers().forEach((u) => {
    const chip = document.createElement('button');
    chip.type = 'button';
    chip.className = 'person-chip' + (S._selEmps && S._selEmps.includes(u.id) ? ' sel' : '');
    chip.textContent = myName(u);
    chip.onclick = () => {
      const set = S._selEmps;
      const i = set.indexOf(u.id);
      if (i >= 0) set.splice(i, 1); else set.push(u.id);
      renderEmployeeChips();
      checkConflicts();
    };
    box.appendChild(chip);
  });
}

function checkConflicts() {
  const box = $('conflictBox');
  const id = $('mId').value;
  const date = $('mDate').value;
  const start = $('mStart').value;
  const end = $('mEnd').value;
  const emps = S._selEmps || [];
  const parts = [];
  if (!date || !start || !end || !emps.length) { box.classList.add('hidden'); box.innerHTML = ''; return; }
  // 时间冲突
  const conflicts = new Set();
  S.meetings.forEach((m) => {
    if (m.id === id) return;
    if (statusOf(m) === 'cancelled') return;
    if (!D.occursOn(m, date)) return;
    const s = D.toMin(m.start), e = D.toMin(m.end), a = D.toMin(start), b = D.toMin(end);
    if (a < e && b > s) {
      m.employeeIds.forEach((uid) => { if (emps.includes(uid)) conflicts.add(uid); });
    }
  });
  // 员工不可用
  const offUsers = emps.map((uid) => userOf(uid)).filter((u) => u && (u.offDays || []).includes(date));
  if (conflicts.size) {
    const names = Array.from(conflicts).map((uid) => { const u = userOf(uid); return u ? myName(u) : ''; }).filter(Boolean).join('、');
    parts.push(`<b>${t('conflictTitle')}</b>${t('conflictMsg')} ${esc(names)}`);
  }
  if (offUsers.length) {
    parts.push(`<b>${t('unavailTitle')}</b>${t('unavailMsg')} ${esc(offUsers.map((u) => myName(u)).join('、'))}`);
  }
  if (!parts.length) { box.classList.add('hidden'); box.innerHTML = ''; return; }
  box.innerHTML = parts.join('<br>');
  box.classList.remove('hidden');
}

function openMeetingModal(id, presetDate) {
  if (!S.me) { toast(S.lang === 'zh' ? '请先选择身份登录' : 'Please log in first', 'error'); return; }
  const m = id ? S.meetings.find((x) => x.id === id) : null;
  $('meetingModalTitle').textContent = m ? t('editMeeting') : t('newMeeting');
  $('mId').value = m ? m.id : '';
  $('mTitle').value = m ? m.title : '';
  $('mCountry').value = m ? m.country : '';
  $('mType').value = m ? m.type : '';
  $('mChannel').value = m ? (m.channel || '') : '';
  $('mMeetingUrl').value = m ? (m.meetingUrl || '') : '';
  $('mDate').value = m ? m.date : (presetDate || isoDate(new Date()));
  $('mStart').value = m ? m.start : '15:00';
  $('mEnd').value = m ? m.end : '16:00';
  $('mRepeat').checked = m ? m.repeat === 'weekly' : false;
  $('mNote').value = m ? (m.note || '') : '';
  S._selEmps = m ? [...m.employeeIds] : (S.me ? [S.me.id] : []);
  $('mDelete').classList.toggle('hidden', !m);
  renderEmployeeChips();
  checkConflicts();
  updateTzHint();
  $('meetingModal').classList.remove('hidden');
  setTimeout(() => $('mTitle').focus(), 50);
}

async function saveMeeting(ev) {
  ev.preventDefault();
  const body = {
    title: $('mTitle').value.trim(),
    country: $('mCountry').value.trim(),
    type: $('mType').value.trim(),
    channel: $('mChannel').value.trim(),
    meetingUrl: $('mMeetingUrl').value.trim(),
    date: $('mDate').value,
    start: $('mStart').value,
    end: $('mEnd').value,
    employeeIds: S._selEmps || [],
    note: $('mNote').value.trim(),
    repeat: $('mRepeat').checked ? 'weekly' : null,
    createdBy: S.me ? S.me.id : ''
  };
  if (!body.title || !body.date || !body.start || !body.end) { toast(t('required'), 'error'); return; }
  if (body.start >= body.end) { toast(t('invalidTime'), 'error'); return; }
  const id = $('mId').value;
  try {
    if (id) {
      await api('/api/meetings/' + id, { method: 'PATCH', body });
    } else {
      await api('/api/meetings', { method: 'POST', body });
    }
    $('meetingModal').classList.add('hidden');
    toast(t('saved'));
    await loadBootstrap();
  } catch (e) { toast(e.message, 'error'); }
}

/* ---------------- 会议详情 ---------------- */
function openDetail(id, occurrenceDate) {
  const m = S.meetings.find((x) => x.id === id);
  if (!m) return;
  S.detailId = id;
  S.detailOcc = occurrenceDate || null;
  const names = m.employeeIds.map((uid) => userOf(uid)).filter(Boolean).map((u) => myName(u)).join(', ');
  const creator = userOf(m.createdBy);
  const occDate = occurrenceDate || m.date;
  const st = statusOf(m);
  const skipped = m.repeat === 'weekly' && occurrenceDate && (m.skipDates || []).includes(occurrenceDate);
  $('detailBody').innerHTML = `
    <div class="detail-row"><span class="k">${t('meetingTitle')}</span><span class="v">${esc(m.title)} <span class="tag tag-status st-${st}">${t('st_' + st)}</span>${skipped ? ` <span class="tag tag-status st-cancelled">${t('occSkipped')}</span>` : ''}</span></div>
    <div class="detail-row"><span class="k">${t('date')}</span><span class="v">${fmtDate(occDate)} ${fmtTimeRangeFull(m, occDate)}${m.repeat === 'weekly' ? ' · ' + t('repeatBadge') : ''}</span></div>
    <div class="detail-row"><span class="k">${t('country')}</span><span class="v"><span class="tag tag-country detail-country" style="background:${countryColor(m.country)}">${esc(m.country || '-')}</span></span></div>
    <div class="detail-row"><span class="k">${t('meetingType')}</span><span class="v">${esc(m.type || '-')}</span></div>
    <div class="detail-row"><span class="k">${t('employees')}</span><span class="v">${esc(names) || '-'}</span></div>
    <div class="detail-row"><span class="k">${t('channel')}</span><span class="v">${esc(m.channel || '-')}</span></div>
    ${m.meetingUrl ? `<div class="detail-row"><span class="k">${t('meetingLink')}</span><span class="v"><a href="${esc(m.meetingUrl)}" target="_blank" rel="noopener noreferrer">${t('openMeeting')}</a></span></div>` : ''}
    <div class="detail-row"><span class="k">${t('note')}</span><span class="v">${esc(m.note || '-')}</span></div>
    ${creator ? `<div class="detail-row"><span class="k">${t('createdBy')}</span><span class="v">${esc(myName(creator))}</span></div>` : ''}`;

  // 状态操作按钮
  const act = $('detailActions');
  act.innerHTML = '';
  const mkBtn = (label, cls, fn) => {
    const b = document.createElement('button');
    b.className = 'btn btn-sm ' + cls;
    b.textContent = label;
    b.onclick = fn;
    return b;
  };
  if (st !== 'cancelled') act.appendChild(mkBtn(t('markCancelled'), 'btn-danger', () => setMeetingStatus('cancelled')));
  if (st !== 'done') act.appendChild(mkBtn(t('markDone'), 'btn-primary', () => setMeetingStatus('done')));
  if (st !== 'planned') act.appendChild(mkBtn(t('restorePlan'), 'btn-ghost', () => setMeetingStatus('planned')));
  if (m.repeat === 'weekly' && occurrenceDate) {
    act.appendChild(mkBtn(skipped ? t('restoreOccurrence') : t('skipOccurrence'), 'btn-ghost', () => toggleSkipOccurrence(occDate)));
  }

  // RSVP 出席确认
  const rsvp = $('detailRsvp');
  if (!m.employeeIds || !m.employeeIds.length) {
    rsvp.classList.add('hidden');
    rsvp.innerHTML = '';
  } else {
    rsvp.classList.remove('hidden');
    rsvp.innerHTML = `
      <div class="rsvp-head"><h4>${t('rsvpTitle')}</h4><span class="rsvp-hint">${t('rsvpHint')}</span></div>
      <div id="rsvpList"></div>
      <div id="rsvpBtns" class="rsvp-btns"></div>`;
    const list = $('rsvpList');
    m.employeeIds.forEach((uid) => {
      const u = userOf(uid);
      if (!u) return;
      const conf = (m.confirmations || {})[uid];
      const stKey = conf === 'yes' ? 'yes' : conf === 'no' ? 'no' : 'none';
      const label = conf === 'yes' ? t('attYes') : conf === 'no' ? t('attNo') : t('attNone');
      const row = document.createElement('div');
      row.className = 'rsvp-item';
      row.innerHTML = `<span class="rsvp-name">${esc(myName(u))}</span><span class="rsvp-state ${stKey}">${label}</span>`;
      list.appendChild(row);
    });
    const btns = $('rsvpBtns');
    btns.innerHTML = '';
    if (S.me && m.employeeIds.includes(S.me.id) && st !== 'cancelled') {
      btns.appendChild(mkBtn(t('confirmAttend'), 'btn-primary', () => confirmMeeting('yes')));
      btns.appendChild(mkBtn(t('confirmAbsent'), 'btn-ghost', () => confirmMeeting('no')));
    }
  }
  $('detailModal').classList.remove('hidden');
}

async function cancelMeetingSeries(id) {
  const m = S.meetings.find((item) => item.id === id);
  if (!m || m.repeat !== 'weekly' || !confirm(t('cancelSeriesConfirm'))) return;
  try {
    await api(`/api/meetings/${id}/status`, { method: 'PATCH', body: { status: 'cancelled' } });
    toast(t('saved'));
    await loadBootstrap();
  } catch (e) { toast(e.message, 'error'); }
}

async function setMeetingStatus(status) {
  const id = S.detailId;
  if (!id || !S.me) return;
  try {
    await api(`/api/meetings/${id}/status`, { method: 'PATCH', body: { status } });
    toast(t('saved'));
    await loadBootstrap();
    openDetail(id, S.detailOcc);
  } catch (e) { toast(e.message, 'error'); }
}

async function toggleSkipOccurrence(date) {
  const id = S.detailId;
  if (!id || !S.me || !date) return;
  try {
    await api(`/api/meetings/${id}/skip`, { method: 'PATCH', body: { date } });
    toast(t('saved'));
    await loadBootstrap();
    openDetail(id, S.detailOcc);
  } catch (e) { toast(e.message, 'error'); }
}

async function confirmMeeting(value) {
  const id = S.detailId;
  if (!id || !S.me) return;
  try {
    await api(`/api/meetings/${id}/confirm`, { method: 'PATCH', body: { value } });
    toast(t('saved'));
    await loadBootstrap();
    openDetail(id, S.detailOcc);
  } catch (e) { toast(e.message, 'error'); }
}

/* ---------------- 提醒面板 ---------------- */
function upcomingMeetings() {
  const now = new Date();
  const list = [];
  S.meetings.forEach((m) => {
    if (!S.me || !m.employeeIds.includes(S.me.id)) return;
    if (statusOf(m) === 'cancelled') return;
    const occ = D.nextOccurrence(m, now);
    if (occ) {
      const diffMin = (occ.getTime() - now.getTime()) / 60000;
      if (diffMin >= -60 && diffMin <= 60 * 24) {
        list.push({ m, occ, diffMin: Math.round(diffMin) });
      }
    }
  });
  return list.sort((a, b) => a.diffMin - b.diffMin);
}

function renderBell() {
  const list = upcomingMeetings();
  const recent = S.reminders.length;
  const badge = $('bellCount');
  const total = list.length + recent;
  badge.classList.toggle('hidden', total === 0);
  badge.textContent = total > 99 ? '99+' : total;

  const box = $('bellList');
  box.innerHTML = '';
  if (!S.me) { box.innerHTML = `<div class="popover-empty">${t('bellEmpty')}</div>`; return; }
  const todayMs = list.filter((x) => x.diffMin > -120 && x.diffMin <= 60 * 18);
  if (!todayMs.length && !recent) {
    box.innerHTML = `<div class="popover-empty">${t('bellEmpty')}</div>`;
    return;
  }
  todayMs.slice(0, 8).forEach((x) => {
    const item = document.createElement('div');
    item.className = 'remind-item';
    const tstr = x.diffMin <= 0 ? t('remindAt') : `${x.diffMin}${S.lang === 'zh' ? '分钟后' : 'min'}`;
    item.innerHTML = `
      <div class="time">${localHM(isoDate(x.occ), x.m.start)}</div>
      <div class="body">
        <div class="title">${esc(x.m.title)} ${x.m.repeat === 'weekly' ? '· ' + t('repeatBadge') : ''}</div>
        <div class="sub">${fmtDate(isoDate(x.occ))} · ${tstr} · ${esc(x.m.country || '')}</div>
      </div>`;
    item.onclick = () => { $('bellPanel').classList.add('hidden'); openDetail(x.m.id, isoDate(x.occ)); };
    box.appendChild(item);
  });
  if (recent) {
    const sep = document.createElement('div');
    sep.className = 'remind-item';
    sep.innerHTML = `<div class="sub" style="width:100%;color:var(--amber);font-weight:600">${t('remindNow')} (${recent})</div>`;
    box.appendChild(sep);
  }
}

/* ---------------- 导出 / 备份 ---------------- */
function downloadFile(name, content, mime) {
  const blob = new Blob([content], { type: mime });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = name;
  document.body.appendChild(a);
  a.click();
  setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 500);
}

function exportCSV() {
  const rows = filteredMeetings();
  const head = [t('date'), t('meetingTitle'), t('country'), t('meetingType'), t('employees'), t('channel'), t('meetingLink'), t('startTime'), t('endTime'), t('note'), t('filterStatus')];
  const lines = [head.join(',')];
  rows.forEach((m) => {
    const names = m.employeeIds.map((uid) => userOf(uid)).filter(Boolean).map((u) => myName(u)).join('; ');
    const csv = (s) => `"${String(s == null ? '' : s).replace(/"/g, '""')}"`;
    lines.push([m.date, csv(m.title), csv(m.country), csv(m.type), csv(names), csv(m.channel), csv(m.meetingUrl), m.start, m.end, csv(m.note), csv(t('st_' + statusOf(m)))].join(','));
  });
  downloadFile(`meetings_${isoDate(new Date())}.csv`, '\ufeff' + lines.join('\r\n'), 'text/csv;charset=utf-8');
}

function exportBackup() {
  const data = {
    version: 2, users: S.users, meetings: S.meetings,
    dictionaries: S.dicts, meta: S.meta, exportedAt: new Date().toISOString()
  };
  downloadFile(`meetingboard_backup_${isoDate(new Date())}.json`, JSON.stringify(data, null, 2), 'application/json');
}

function importBackup() {
  if (!isAdmin()) { toast(S.lang === 'zh' ? '仅管理员可导入备份' : 'Only admins can import backups', 'error'); return; }
  const input = document.createElement('input');
  input.type = 'file';
  input.accept = '.json';
  input.onchange = async () => {
    const file = input.files[0];
    if (!file) return;
    if (!confirm(t('importConfirm'))) return;
    try {
      const data = JSON.parse(await file.text());
      if (!Array.isArray(data.users) || !Array.isArray(data.meetings)) throw new Error('bad');
      await api('/api/import', { method: 'POST', body: { users: data.users, meetings: data.meetings, dictionaries: data.dictionaries, meta: data.meta } });
      toast(t('importOk'));
      await loadBootstrap();
    } catch (e) {
      toast(t('importFail'), 'error');
    }
  };
  input.click();
}

/* ---------------- 事件绑定 ---------------- */
function bindEvents() {
  // 登录
  $('loginForm').onsubmit = async (ev) => {
    ev.preventDefault();
    const errEl = $('loginError');
    errEl.classList.add('hidden');
    const username = $('loginUsername').value.trim();
    const password = $('loginPassword').value;
    if (!username || !password) { errEl.textContent = t('required'); errEl.classList.remove('hidden'); return; }
    try {
      const r = await api('/api/auth/login', { method: 'POST', body: { username, password } });
      if (r.user) S.me = r.user;
      await refreshData();
      enterApp();
    } catch (e) {
      errEl.textContent = e.message === 'invalid credentials' ? t('loginError') : e.message;
      errEl.classList.remove('hidden');
    }
  };
  $('pwdBtn').onclick = () => {
    $('pwOld').value = '';
    $('pwNew').value = '';
    $('pwConfirm').value = '';
    $('pwdModal').classList.remove('hidden');
  };
  $('pwdForm').onsubmit = async (ev) => {
    ev.preventDefault();
    const oldP = $('pwOld').value;
    const np = $('pwNew').value;
    const cp = $('pwConfirm').value;
    if (np !== cp) { toast(t('pwdMismatch'), 'error'); return; }
    if (np.length < 6) { toast(t('pwdTooShort'), 'error'); return; }
    try {
      await api('/api/auth/password', { method: 'PATCH', body: { oldPassword: oldP, newPassword: np } });
      $('pwdModal').classList.add('hidden');
      toast(t('pwdChanged'));
    } catch (e) { toast(e.message === 'old password incorrect' ? t('oldPwdWrong') : e.message, 'error'); }
  };
  document.querySelectorAll('[data-setlang]').forEach((b) => { b.onclick = () => setLang(b.dataset.setlang); });
  $('wecomLoginBtn').onclick = async () => {
    try {
      const r = await api('/api/wecom/auth');
      if (r.url) window.location.href = r.url;
    } catch (e) { toast(e.message || '企业微信未配置', 'error'); }
  };
  $('wecomQrBtn').onclick = async () => {
    try {
      const r = await api('/api/wecom/qr');
      if (r.url) window.location.href = r.url;
    } catch (e) { toast(e.message || '企业微信扫码登录未配置', 'error'); }
  };

  // 导航
  const sb = () => document.querySelector('.sidebar');
  const sbBackdrop = () => $('sidebarBackdrop');
  const setSidebar = (open) => { sb().classList.toggle('open', open); sbBackdrop().classList.toggle('hidden', !open); };
  document.querySelectorAll('.nav-item, .mnav-item').forEach((b) => { b.onclick = () => { switchTab(b.dataset.tab); setSidebar(false); }; });
  $('menuBtn').onclick = () => setSidebar(!sb().classList.contains('open'));
  $('sidebarBackdrop').onclick = () => setSidebar(false);
  $('addMeetingBtn').onclick = () => openMeetingModal(null);
  $('logoutBtn').onclick = logout;
  $('profileBtn').onclick = openProfileModal;
  $('profileForm').onsubmit = saveProfile;

  // 日历导航
  $('prevMonthBtn').onclick = () => { S.viewDate.setMonth(S.viewDate.getMonth() - 1); renderCalendar(); };
  $('nextMonthBtn').onclick = () => { S.viewDate.setMonth(S.viewDate.getMonth() + 1); renderCalendar(); };
  $('todayBtn').onclick = () => { S.viewDate = new Date(); renderCalendar(); };

  // 列表筛选
  $('fCountry').onchange = (e) => { S.listFilters.country = e.target.value; renderList(); };
  $('fType').onchange = (e) => { S.listFilters.type = e.target.value; renderList(); };
  $('fEmployee').onchange = (e) => { S.listFilters.employee = e.target.value; renderList(); };
  $('fStatus').onchange = (e) => { S.listFilters.status = e.target.value; renderList(); };
  $('fFrom').onchange = (e) => { S.listFilters.from = e.target.value; renderList(); };
  $('fTo').onchange = (e) => { S.listFilters.to = e.target.value; renderList(); };
  $('fSearch').oninput = (e) => { S.listFilters.search = e.target.value; renderList(); };
  $('fReset').onclick = () => { S.listFilters = { country: '', type: '', employee: '', status: '', from: '', to: '', search: '' }; renderList(); };
  $('exportCsvBtn').onclick = exportCSV;

  // 统计
  document.querySelectorAll('#statsScope .seg-item').forEach((b) => { b.onclick = () => { S.statsScope = b.dataset.scope; renderStats(); }; });
  document.querySelectorAll('#statsView .seg-item').forEach((b) => { b.onclick = () => { S.statsView = b.dataset.view; renderStats(); }; });
  $('exportStatsBtn').onclick = exportCSV;

  // 会议弹窗
  $('meetingForm').onsubmit = saveMeeting;
  $('mDate').onchange = () => { checkConflicts(); updateTzHint(); };
  $('mStart').onchange = () => { checkConflicts(); updateTzHint(); };
  $('mEnd').onchange = () => { checkConflicts(); updateTzHint(); };
  $('mDelete').onclick = async () => {
    const id = $('mId').value;
    if (!id || !confirm(t('confirmDelete'))) return;
    const clone = JSON.parse(JSON.stringify(S.meetings.find((x) => x.id === id)));
    try {
      await api('/api/meetings/' + id, { method: 'DELETE' });
      $('meetingModal').classList.add('hidden');
      toastWithAction(t('deletedUndo'), t('undo'), async () => {
        try {
          await api('/api/meetings', { method: 'POST', body: { title: clone.title, country: clone.country, type: clone.type, channel: clone.channel, meetingUrl: clone.meetingUrl, date: clone.date, start: clone.start, end: clone.end, employeeIds: clone.employeeIds, note: clone.note, repeat: clone.repeat } });
          toast(t('saved'));
        } catch (e2) { toast(e2.message, 'error'); }
      });
      await loadBootstrap();
    } catch (e) { toast(e.message, 'error'); }
  };

  // 成员弹窗
  $('wecomBindBtn').onclick = bindCurrentWecom;
  $('addMemberBtn').onclick = () => openMemberModal(null);
  $('muOffAdd').onclick = () => {
    const d = $('muOffDate').value;
    if (!d) { toast(t('required'), 'error'); return; }
    if (!S._offDays.includes(d)) S._offDays.push(d);
    $('muOffDate').value = '';
    renderOffChips();
  };
  $('memberForm').onsubmit = async (ev) => {
    ev.preventDefault();
    const id = $('muId').value;
    const body = {
      name: $('muName').value.trim(),
      nameEn: $('muNameEn').value.trim(),
      wecomUserId: $('muWecom').value.trim(),
      email: $('muEmail').value.trim(),
      role: $('muRole').value,
      active: $('muActive').checked,
      offDays: S._offDays,
      me: S.me ? S.me.id : ''
    };
    if (!body.name) { toast(t('required'), 'error'); return; }
    if (body.wecomUserId && S.users.some((u) => u.id !== id && u.wecomUserId === body.wecomUserId)) {
      toast(t('wecomUserIdDuplicate'), 'error');
      return;
    }
    try {
      if (id) await api('/api/users/' + id, { method: 'PATCH', body });
      else await api('/api/users', { method: 'POST', body });
      $('memberModal').classList.add('hidden');
      toast(t('saved'));
      await loadBootstrap();
    } catch (e) { toast(e.message === 'wecom user id already bound' ? t('wecomUserIdDuplicate') : e.message, 'error'); }
  };

  // 详情
  $('detailEditBtn').onclick = () => {
    $('detailModal').classList.add('hidden');
    if (S.detailId) openMeetingModal(S.detailId);
  };

  // 提醒
  $('bellBtn').onclick = (ev) => {
    ev.stopPropagation();
    $('bellPanel').classList.toggle('hidden');
    renderBell();
  };
  $('remindSettingsBtn').onclick = () => {
    $('bellPanel').classList.add('hidden');
    $('setMinutes').value = S.meta.reminderMinutes;
    $('setSound').checked = S.soundPref;
    // 团队时区选项
    const tzSel = $('setTZ');
    tzSel.innerHTML = '';
    const TZS = ['Asia/Shanghai', 'Asia/Karachi', 'Asia/Kolkata', 'Asia/Dhaka', 'Asia/Dubai',
      'Asia/Bangkok', 'Asia/Jakarta', 'Asia/Almaty', 'Asia/Tashkent',
      'Africa/Lagos', 'Africa/Cairo', 'Europe/London', 'Europe/Berlin',
      'America/New_York', 'America/Los_Angeles'];
    TZS.forEach((z) => {
      const o = document.createElement('option');
      o.value = z;
      o.textContent = `${z} (${tzLabel(z)})`;
      tzSel.appendChild(o);
    });
    tzSel.value = teamTZ();
    const isAdminUser = isAdmin();
    $('setMinutes').disabled = !isAdminUser;
    tzSel.disabled = !isAdminUser;
    $('settingsModal').classList.remove('hidden');
  };
  $('setSaveBtn').onclick = async () => {
    try {
      S.soundPref = $('setSound').checked;
      localStorage.setItem('mb_sound', S.soundPref ? '1' : '0');
      if (isAdmin()) {
        await api('/api/settings', {
          method: 'PATCH',
          body: { reminderMinutes: parseInt($('setMinutes').value, 10) || 10, timezone: $('setTZ').value }
        });
      }
      $('settingsModal').classList.add('hidden');
      toast(t('saved'));
      await loadBootstrap();
    } catch (e) { toast(e.message, 'error'); }
  };

  // 备份
  $('backupBtn').onclick = (ev) => { ev.stopPropagation(); $('backupPanel').classList.toggle('hidden'); };
  $('backupExportBtn').onclick = () => { $('backupPanel').classList.add('hidden'); exportBackup(); };
  $('backupImportBtn').onclick = () => { $('backupPanel').classList.add('hidden'); importBackup(); };

  // 关闭弹窗
  document.querySelectorAll('[data-close]').forEach((b) => {
    b.onclick = () => $(b.dataset.close).classList.add('hidden');
  });
  // 登录遮罩只能通过成功认证或退出后状态切换控制，不能被空白点击关闭。
  document.querySelectorAll('.overlay:not(#loginOverlay)').forEach((ov) => {
    ov.addEventListener('click', (ev) => { if (ev.target === ov) ov.classList.add('hidden'); });
  });
  document.addEventListener('click', (ev) => {
    if (!ev.target.closest('#bellPanel') && !ev.target.closest('#bellBtn')) $('bellPanel').classList.add('hidden');
    if (!ev.target.closest('#backupPanel') && !ev.target.closest('#backupBtn')) $('backupPanel').classList.add('hidden');
    if (window.innerWidth <= 860 && !ev.target.closest('.sidebar') && !ev.target.closest('#menuBtn')) {
      document.querySelector('.sidebar').classList.remove('open');
      $('sidebarBackdrop').classList.add('hidden');
    }
  });
}

/* ---------------- 启动 ---------------- */
(async function init() {
  bindEvents();
  applyLang();
  switchTab('calendar');
  try {
    const data = await api('/api/bootstrap');
    if (data.authenticated && data.me) {
      // 已有有效会话（账号密码或企业微信登录过）
      applyData(data);
      enterApp();
    } else {
      // 未登录：显示登录页
      S.wecom = data.wecom || { enabled: false };
      showWecomLoginOptions();
      $('loginOverlay').classList.remove('hidden');
    }
  } catch (e) {
    toast('Server unreachable: ' + e.message, 'error');
    $('loginOverlay').classList.remove('hidden');
  }
  connectSSE();
})();
