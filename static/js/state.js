/* 全局状态与撤销/重做 */
window.App = {
  settings: { kerf: 3, margin: 5, spacing: 2 },
  sheets: [],        // 原料板定义 [{id,name,width,height,grain,quantity}]
  parts: [],         // 零件定义 [{id,name,width,height,quantity,rotatable,grain}]
  layouts: [],       // 服务端返回的多个方案
  active: 0,         // 当前方案下标
  selected: null,    // 选中零件 uid
  placeMode: null,   // 待手动放置的未放置零件 uid
  history: [],
  hIndex: -1,
  violations: { vmap: new Map(), messages: [] },
  projectId: null,
  view: { x: -100, y: -120, w: 2800, h: 1800 },  // 画布视口（世界坐标=毫米）
};

App.layout = function () { return App.layouts[App.active] || null; };

App.partDef = function (partId) { return App.parts.find(p => p.id === partId) || null; };
App.sheetDef = function (sheetId) { return App.sheets.find(s => s.id === sheetId) || null; };
App.uidPart = function (uid) { return App.partDef(String(uid).split('#')[0]); };

App.findPlacement = function (uid) {
  const lay = App.layout();
  if (!lay) return null;
  for (let si = 0; si < lay.sheets.length; si++) {
    const idx = lay.sheets[si].placements.findIndex(p => p.uid === uid);
    if (idx >= 0) return { sheetIndex: si, partIndex: idx, placement: lay.sheets[si].placements[idx] };
  }
  return null;
};

/* ---- 撤销 / 重做（快照式） ----
   约定：pushHistory() 在每次变更【之后】调用，压入变更后的新状态，
   保证 history[hIndex] 始终等于当前状态，撤销/重做逐步移动指针。 */
App.snapshot = function () {
  return JSON.stringify({ layouts: App.layouts, active: App.active });
};
App.restore = function (snap) {
  const o = JSON.parse(snap);
  App.layouts = o.layouts;
  App.active = Math.min(o.active, o.layouts.length - 1);
  if (App.active < 0) App.active = 0;
};
App.pushHistory = function () {
  App.history = App.history.slice(0, App.hIndex + 1);  // 丢弃重做分支
  App.history.push(App.snapshot());
  if (App.history.length > 100) App.history.shift();
  App.hIndex = App.history.length - 1;
};
App.resetHistory = function () {
  App.history = [];
  App.hIndex = -1;
  App.pushHistory();
};
App.undo = function () {
  if (App.hIndex > 0) {
    App.hIndex--;
    App.restore(App.history[App.hIndex]);
    App.selected = null;
    renderAll();
  }
};
App.redo = function () {
  if (App.hIndex < App.history.length - 1) {
    App.hIndex++;
    App.restore(App.history[App.hIndex]);
    App.selected = null;
    renderAll();
  }
};

/* ---- 小工具 ---- */
function fmtNum(n) {
  const v = Math.round(+n * 10) / 10;
  return Number.isInteger(v) ? String(v) : v.toFixed(1);
}
function fmtArea(mm2) {
  if (mm2 >= 1e6) return (mm2 / 1e6).toFixed(3) + ' m²';
  return Math.round(mm2).toLocaleString() + ' mm²';
}
function fmtPct(x) { return (x * 100).toFixed(1) + '%'; }
function colorFor(id) {
  let h = 0;
  for (const c of String(id)) h = (h * 31 + c.charCodeAt(0)) % 360;
  return `hsl(${h}, 60%, 74%)`;
}
function esc(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g,
    c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

let _toastTimer = null;
function toast(msg, ms = 2600) {
  const t = document.getElementById('toast');
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(_toastTimer);
  _toastTimer = setTimeout(() => t.classList.remove('show'), ms);
}

/* ---- 方案统计实时重算 ----
   与后端 nesting.py 的估算口径一致：切割数 = 递归贯通切割 + 修边；
   利用率/废料按"有零件的板材"面积计算。任何本地编辑（删除、拖动、
   旋转、手动放置、撤销/重做）后由 renderAll 调用，保证方案标签、
   状态栏与打印摘要一致。 */
function guillotineCuts(rects) {
  if (rects.length <= 1) return 0;
  const EPS = 1e-6;
  const xs = [...new Set(rects.map(r => Math.round((r.x + r.w) * 1e6) / 1e6))].sort((a, b) => a - b);
  for (const c of xs) {
    const L = rects.filter(r => r.x + r.w <= c + EPS);
    const R = rects.filter(r => r.x >= c - EPS);
    if (L.length && R.length && L.length + R.length === rects.length)
      return 1 + guillotineCuts(L) + guillotineCuts(R);
  }
  const ys = [...new Set(rects.map(r => Math.round((r.y + r.h) * 1e6) / 1e6))].sort((a, b) => a - b);
  for (const c of ys) {
    const T = rects.filter(r => r.y + r.h <= c + EPS);
    const B = rects.filter(r => r.y >= c - EPS);
    if (T.length && B.length && T.length + B.length === rects.length)
      return 1 + guillotineCuts(T) + guillotineCuts(B);
  }
  return rects.length;  // 非贯通区域按零件数估算
}

function recomputeLayoutStats(lay) {
  if (!lay) return;
  const EPS = 1e-6;
  const m = +App.settings.margin || 0;
  let placedCount = 0, placedArea = 0, usedSheets = 0, usedArea = 0, cuts = 0;
  lay.sheets.forEach((si) => {
    const def = App.sheetDef(si.sheetId) || si;
    const W = +def.width, H = +def.height;
    const ps = si.placements;
    placedCount += ps.length;
    ps.forEach(p => { placedArea += p.w * p.h; });
    if (!ps.length) return;
    usedSheets++;
    usedArea += W * H;
    cuts += guillotineCuts(ps);
    const minx = Math.min(...ps.map(p => p.x));
    const miny = Math.min(...ps.map(p => p.y));
    const maxx = Math.max(...ps.map(p => p.x + p.w));
    const maxy = Math.max(...ps.map(p => p.y + p.h));
    // 修边：零件未贴到可用区域边缘的每一边修一次
    cuts += [minx > m + EPS, miny > m + EPS,
             maxx < W - m - EPS, maxy < H - m - EPS].filter(Boolean).length;
  });
  lay.stats = lay.stats || {};
  lay.stats.placedCount = placedCount;
  lay.stats.unplacedCount = lay.unplaced.length;
  lay.stats.usedSheets = usedSheets;
  lay.stats.totalSheets = lay.sheets.length;
  lay.stats.utilization = usedArea ? placedArea / usedArea : 0;
  lay.stats.waste = usedArea - placedArea;
  lay.stats.cuts = cuts;
}
