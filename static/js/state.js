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

/* ---- 撤销 / 重做（快照式） ---- */
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
  App.history = App.history.slice(0, App.hIndex + 1);
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
