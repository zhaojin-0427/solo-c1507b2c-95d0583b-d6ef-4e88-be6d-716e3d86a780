/* 前端回归测试（Node 运行，mock 浏览器环境）。
 *
 * 覆盖：
 * - 缺陷1：历史栈支持连续编辑逐步撤销，重做可恢复刚撤销的变更
 * - 缺陷2：手动删除零件后立即重算放置数/未放置数/利用率/废料/切割数
 * - 缺陷3：纹理与旋转约束的前端校验（含原料板纹理参与）
 * - 裁切工序：贯通切割树（计入锯缝、切前尺寸、产出零件/余料）、阻塞区域与人工处理、
 *   依赖允许的步骤换序与翻板统计、候选切法切换、拖动/旋转后失效重分析、
 *   随项目保存恢复、打印采用已选工序并列出人工处理项
 * - 回归：JS 统计口径与后端 nesting.py 一致；打印视图生成不受影响
 *
 * 运行：node tests/test_frontend.js
 */
'use strict';
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

/* ---- mock 浏览器环境 ---- */
const _elements = {
  'toast': { textContent: '', classList: { add() {}, remove() {} } },
  'project-name': { value: '回归测试项目' },
};
global.window = global;
global.document = {
  getElementById: (id) => _elements[id] || null,
};
global.renderAll = () => {};  // App.undo/redo 会调用，测试中无需真实渲染

/* ---- 加载被测模块 ---- */
const src = ['state.js', 'validate.js', 'cutplan.js', 'cutui.js', 'print.js']
  .map(f => fs.readFileSync(path.join(__dirname, '..', 'static', 'js', f), 'utf8'))
  .join('\n');
eval(src + `
global.App = App; global.Validate = Validate; global.Print = Print;
global.CutPlan = CutPlan; global.CutUI = CutUI;
global.recomputeLayoutStats = recomputeLayoutStats;
global.guillotineCuts = guillotineCuts;
`);

/* ---- 测试框架（极简） ---- */
let passed = 0, failed = 0;
function ok(cond, msg) {
  if (cond) { passed++; console.log('  ✓ ' + msg); }
  else { failed++; console.error('  ✗ ' + msg); }
}
function eq(a, b, msg) { ok(a === b, `${msg}（期望 ${b}，实际 ${a}）`); }
function near(a, b, msg) { ok(Math.abs(a - b) < 1e-9, `${msg}（期望 ${b}，实际 ${a}）`); }
function section(name) { console.log('\n[' + name + ']'); }

/* ---- 构造测试数据 ---- */
function setupLayout() {
  App.settings = { kerf: 3, margin: 5, spacing: 2 };
  App.sheets = [{ id: 'S1', name: '板', width: 1000, height: 500, grain: 'none', quantity: 1 }];
  App.parts = [
    { id: 'P1', name: '甲', width: 400, height: 200, quantity: 2, rotatable: true, grain: 'none' },
    { id: 'P2', name: '乙', width: 300, height: 200, quantity: 1, rotatable: false, grain: 'none' },
  ];
  App.layouts = [{
    id: 1, strategy: '测试',
    sheets: [{
      sheetId: 'S1', name: '板', instance: 0, width: 1000, height: 500,
      placements: [
        { uid: 'P1#1', partId: 'P1', name: '甲', x: 5, y: 5, w: 400, h: 200, rotated: false, locked: false },
        { uid: 'P1#2', partId: 'P1', name: '甲', x: 5, y: 210, w: 400, h: 200, rotated: false, locked: false },
        { uid: 'P2#1', partId: 'P2', name: '乙', x: 410, y: 5, w: 300, h: 200, rotated: false, locked: false },
      ],
    }],
    unplaced: [],
    stats: {},
  }];
  App.active = 0;
  App.selected = null;
  App.resetHistory();
}

/* 模拟 Main.deleteSelected 的变更逻辑（不加载 main.js 以避免 DOM 依赖） */
function deletePlacement(uid) {
  const lay = App.layout();
  const found = App.findPlacement(uid);
  const arr = lay.sheets[found.sheetIndex].placements;
  const [p] = arr.splice(arr.findIndex(q => q.uid === uid), 1);
  lay.unplaced.push({ uid: p.uid, partId: p.partId, name: p.name, reason: '手动移除，等待重新放置' });
  App.pushHistory();  // 新语义：变更后提交
}

/* ================= 缺陷1：历史栈 ================= */
section('缺陷1：连续编辑逐步撤销 / 重做恢复');
{
  setupLayout();
  // 编辑1：移动 P1#1
  App.findPlacement('P1#1').placement.x = 100;
  App.pushHistory();
  // 编辑2：删除 P2#1
  deletePlacement('P2#1');
  // 编辑3：锁定 P1#2
  App.findPlacement('P1#2').placement.locked = true;
  App.pushHistory();

  eq(App.history.length, 4, '三次编辑后历史深度为 4（含初始快照）');

  App.undo();
  eq(App.findPlacement('P1#2').placement.locked, false, '撤销1：回到编辑3前（未锁定）');
  ok(App.layout().unplaced.some(u => u.uid === 'P2#1'), '撤销1：P2#1 仍在未放置中');
  App.undo();
  ok(App.findPlacement('P2#1'), '撤销2：P2#1 回到板材上');
  eq(App.findPlacement('P1#1').placement.x, 100, '撤销2：P1#1.x 保持编辑1后的 100');
  App.undo();
  eq(App.findPlacement('P1#1').placement.x, 5, '撤销3：P1#1.x 回到初始 5');
  const depthAtBottom = App.hIndex;
  App.undo();
  eq(App.hIndex, depthAtBottom, '撤销到底后继续撤销无副作用');

  App.redo();
  eq(App.findPlacement('P1#1').placement.x, 100, '重做1：恢复编辑1（x=100）');
  App.redo();
  ok(App.layout().unplaced.some(u => u.uid === 'P2#1'), '重做2：恢复编辑2（P2#1 被删除）');
  App.redo();
  eq(App.findPlacement('P1#2').placement.locked, true, '重做3：恢复编辑3（锁定）');
  const depthAtTop = App.hIndex;
  App.redo();
  eq(App.hIndex, depthAtTop, '重做到顶后继续重做无副作用');

  // 撤销后产生新编辑 → 重做分支被截断
  App.undo(); App.undo();
  App.findPlacement('P1#1').placement.y = 50;
  App.pushHistory();
  eq(App.history.length, App.hIndex + 1, '新编辑截断重做分支');
  App.undo();
  eq(App.findPlacement('P1#1').placement.x, 100, '截断后撤销仍逐步回退');
}

/* ================= 缺陷2：统计实时重算 ================= */
section('缺陷2：删除零件后统计立即重算');
{
  setupLayout();
  const lay = App.layout();
  recomputeLayoutStats(lay);
  eq(lay.stats.placedCount, 3, '初始 placedCount=3');
  eq(lay.stats.unplacedCount, 0, '初始 unplacedCount=0');
  near(lay.stats.utilization, 220000 / 500000, '初始利用率=0.44');
  near(lay.stats.waste, 280000, '初始废料=280000mm²');
  eq(lay.stats.cuts, 4, '初始切割数=4（2 分离 + 2 修边）');

  deletePlacement('P1#2');           // 模拟手动删除
  App.layouts.forEach(recomputeLayoutStats);  // renderAll 的重算步骤
  eq(lay.stats.placedCount, 2, '删除后 placedCount=2');
  eq(lay.stats.unplacedCount, 1, '删除后 unplacedCount=1');
  near(lay.stats.utilization, 140000 / 500000, '删除后利用率=0.28');
  near(lay.stats.waste, 360000, '删除后废料=360000mm²');
  eq(lay.stats.cuts, 3, '删除后切割数=3（1 分离 + 2 修边）');
  eq(lay.unplaced[0].reason, '手动移除，等待重新放置', '删除件进入未放置并带原因');

  // 手动放回后统计恢复
  const u = lay.unplaced.splice(0, 1)[0];
  lay.sheets[0].placements.push({ uid: u.uid, partId: u.partId, name: u.name, x: 5, y: 210, w: 400, h: 200, rotated: false, locked: false });
  App.pushHistory();
  App.layouts.forEach(recomputeLayoutStats);
  eq(lay.stats.placedCount, 3, '放回后 placedCount 恢复 3');
  eq(lay.stats.unplacedCount, 0, '放回后 unplacedCount 恢复 0');
}

/* ================= 缺陷3：纹理与旋转约束 ================= */
section('缺陷3：纹理/旋转约束前端校验');
{
  setupLayout();
  // 板材改为横向纹理，放一个纵向纹理零件 → 冲突
  App.sheets[0].grain = 'horizontal';
  App.parts.push({ id: 'P3', name: '纵纹件', width: 100, height: 200, quantity: 1, rotatable: true, grain: 'vertical' });
  App.layout().sheets[0].placements.push(
    { uid: 'P3#1', partId: 'P3', name: '纵纹件', x: 720, y: 5, w: 200, h: 100, rotated: true, locked: false });
  let v = Validate.check();
  ok(v.messages.some(m => m.code === 'grain' && m.msg.includes('P3#1') && m.msg.includes('冲突')),
     '板纹理与零件纹理冲突被检出');

  // rotatable=False 被旋转 → 检出
  App.layout().sheets[0].placements[2].rotated = true;  // P2#1 rotatable=false
  v = Validate.check();
  ok(v.messages.some(m => m.code === 'grain' && m.msg.includes('P2#1') && m.msg.includes('不可旋转')),
     'rotatable=False 被旋转被检出');
  App.layout().sheets[0].placements[2].rotated = false;

  // 拖拽实时校验：纵纹件 → 横纹板 = 非法；→ 无纹板 = 合法
  eq(Validate.checkPlacement(0, 'P3#1', 720, 5, 200, 100), false, '拖拽校验拦截纹理冲突板材');
  App.sheets[0].grain = 'none';
  eq(Validate.checkPlacement(0, 'P3#1', 720, 5, 200, 100), true, '无纹理板材接受纹理零件');
}

/* ================= 回归：JS 与后端统计口径一致 ================= */
section('回归：JS 统计口径与 nesting.py 一致');
{
  const pyOut = execSync(
    `python3 -c "
import json, sys
sys.path.insert(0, '${path.join(__dirname, '..')}')
from nesting import generate_layouts
payload = {
  'settings': {'kerf': 3, 'margin': 5, 'spacing': 2},
  'sheets': [{'id':'S1','name':'多层板','width':2440,'height':1220,'grain':'horizontal','quantity':2}],
  'parts': [
    {'id':'P1','name':'侧板','width':600,'height':400,'quantity':4,'rotatable':True,'grain':'none'},
    {'id':'P2','name':'层板','width':560,'height':300,'quantity':6,'rotatable':True,'grain':'none'},
    {'id':'P3','name':'门板','width':500,'height':350,'quantity':4,'rotatable':False,'grain':'horizontal'},
    {'id':'P4','name':'背板','width':580,'height':380,'quantity':2,'rotatable':True,'grain':'none'}]}
print(json.dumps(generate_layouts(payload)))"`, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  const py = JSON.parse(pyOut);
  ok(py.layouts.length > 0, '后端生成方案');

  App.settings = { kerf: 3, margin: 5, spacing: 2 };
  App.sheets = [{ id: 'S1', name: '多层板', width: 2440, height: 1220, grain: 'horizontal', quantity: 2 }];
  App.parts = [];
  App.layouts = py.layouts;
  App.active = 0;
  App.layouts.forEach(recomputeLayoutStats);
  // 基准：重新解析一份未被重算覆盖的 Python 输出
  const pyBase = JSON.parse(pyOut).layouts;
  App.layouts.forEach((lay, i) => {
    const base = pyBase[i].stats, got = lay.stats;
    eq(got.placedCount, base.placedCount, `方案${i + 1} placedCount 一致`);
    eq(got.unplacedCount, base.unplacedCount, `方案${i + 1} unplacedCount 一致`);
    eq(got.usedSheets, base.usedSheets, `方案${i + 1} usedSheets 一致`);
    eq(got.cuts, base.cuts, `方案${i + 1} cuts 一致`);
    near(got.utilization, base.utilization, `方案${i + 1} utilization 一致`);
    near(got.waste, base.waste, `方案${i + 1} waste 一致`);
  });
}

/* ================= 回归：打印视图 ================= */
section('回归：打印视图生成');
{
  setupLayout();
  App.layouts.forEach(recomputeLayoutStats);
  const html = Print.buildHtml(App.layout());
  ok(html.includes('切割顺序'), '打印页含切割顺序表');
  ok(html.includes('零件清单'), '打印页含零件清单');
  ok(html.includes('P1#1') && html.includes('P2#1'), '打印页含零件编号');
  ok(html.includes('400×200') || html.includes('400 ×200') || html.includes('400×'), '打印页含尺寸标注');
  ok(html.includes('回归测试项目'), '打印页含项目名');
  // 删除一个零件后打印摘要与统计一致
  deletePlacement('P2#1');
  App.layouts.forEach(recomputeLayoutStats);
  const html2 = Print.buildHtml(App.layout());
  ok(html2.includes('未放置 1 件'), '删除后打印摘要未放置数一致');
  ok(html2.includes('P2#1'), '被删零件出现在打印页（未放置表）');
}

/* ================= 裁切工序：测试数据 ================= */
/* 1000×500 板（锯缝3/留量5/间距2）：P1#1(5,5,400×490) 与 P2#1(410,5,300×200) */
function setupCutLayout() {
  App.settings = { kerf: 3, margin: 5, spacing: 2 };
  App.sheets = [{ id: 'S1', name: '板', width: 1000, height: 500, grain: 'none', quantity: 1 }];
  App.parts = [
    { id: 'P1', name: '甲', width: 400, height: 490, quantity: 1, rotatable: true, grain: 'none' },
    { id: 'P2', name: '乙', width: 300, height: 200, quantity: 1, rotatable: true, grain: 'none' },
  ];
  App.layouts = [{
    id: 1, strategy: '测试',
    sheets: [{
      sheetId: 'S1', name: '板', instance: 0, width: 1000, height: 500,
      placements: [
        { uid: 'P1#1', partId: 'P1', name: '甲', x: 5, y: 5, w: 400, h: 490, rotated: false, locked: false },
        { uid: 'P2#1', partId: 'P2', name: '乙', x: 410, y: 5, w: 300, h: 200, rotated: false, locked: false },
      ],
    }],
    unplaced: [], stats: {},
  }];
  App.active = 0;
  App.cutplan = null; App.cutplanData = null; App._cutStates = {};
}

/* 210×210 板上的风车（pinwheel）布局：任何贯通直线都会切到零件 */
function setupBlockedLayout() {
  App.settings = { kerf: 3, margin: 0, spacing: 2 };
  App.sheets = [{ id: 'S1', name: '板', width: 210, height: 210, grain: 'none', quantity: 1 }];
  App.parts = [];
  App.layouts = [{
    id: 1, strategy: '测试',
    sheets: [{
      sheetId: 'S1', name: '板', instance: 0, width: 210, height: 210,
      placements: [
        { uid: 'P1#1', partId: 'P1', name: 'a', x: 0, y: 0, w: 150, h: 100, rotated: false, locked: false },
        { uid: 'P2#1', partId: 'P2', name: 'b', x: 155, y: 0, w: 55, h: 150, rotated: false, locked: false },
        { uid: 'P3#1', partId: 'P3', name: 'c', x: 55, y: 155, w: 155, h: 55, rotated: false, locked: false },
        { uid: 'P4#1', partId: 'P4', name: 'd', x: 0, y: 105, w: 50, h: 105, rotated: false, locked: false },
      ],
    }],
    unplaced: [], stats: {},
  }];
  App.active = 0;
  App.cutplan = null; App.cutplanData = null; App._cutStates = {};
}

/* ================= 裁切工序：贯通切割树与锯缝 ================= */
section('裁切工序：贯通切割树与锯缝');
{
  setupCutLayout();
  const plan = CutPlan.ensure().plans[0];
  eq(plan.steps.length, 8, '总刀数=8（1 板边修边 + 1 分离 + 6 修边）');
  // 面积守恒：零件 + 余料 + 锯缝损耗 = 板面积
  const remnantArea = plan.remnants.reduce((t, r) => t + r.w * r.h, 0);
  near(400 * 490 + 300 * 200 + remnantArea + plan.kerfLoss, 500000,
       '面积守恒：零件+余料+锯缝损耗=板面积');
  near(plan.kerfLoss, 9700, '锯缝损耗=9700mm²（每一刀都计入锯缝）');
  // 首刀：修板边（留量5 − 锯缝3 = x2），切前为整板
  const s0 = plan.steps[0];
  eq(s0.dir, 'v', '首刀为竖切');
  eq(s0.at, 2, '首刀位置 x=2（板边留量5 − 锯缝3）');
  ok(s0.board.w === 1000 && s0.board.h === 500, '首刀切前子板为整板 1000×500');
  ok(s0.trim && s0.wasteSide === '左', '首刀记为修边（左）');
  // 每一步都是当前子板上的贯通横/竖直线，且给出切前尺寸与产出
  let fieldsOk = true, containsOk = true;
  plan.steps.forEach(s => {
    if (!(s.dir === 'v' || s.dir === 'h')) fieldsOk = false;
    if (!(s.board && s.board.w > 0 && s.board.h > 0 && Array.isArray(s.produces))) fieldsOk = false;
    const lo = s.dir === 'v' ? s.board.x : s.board.y;
    const hi = s.dir === 'v' ? s.board.x + s.board.w : s.board.y + s.board.h;
    if (!(s.at > lo - 3 - 1e-6 && s.at < hi + 1e-6)) containsOk = false;
  });
  ok(fieldsOk, '每刀均有方向/切前子板/产出字段');
  ok(containsOk, '每刀切线都落在当前子板范围内');
  // 产出零件尺寸精确
  eq(Object.keys(plan.partStep).length, 2, '两个零件均有产出步骤');
  const p1step = plan.steps.find(s => s.produces.some(pr => pr.kind === 'part' && pr.uid === 'P1#1'));
  const prod = p1step.produces.find(pr => pr.uid === 'P1#1');
  ok(Math.abs(prod.board.w - 400) < 1e-9 && Math.abs(prod.board.h - 490) < 1e-9,
     '产出零件尺寸精确 400×490');
  // 余料分类
  eq(plan.remnants.length, 6, '余料 6 块');
  eq(plan.remnants.filter(r => r.reusable).length, 2, '可复用余料 2 块（短边≥100mm）');
  eq(plan.blocked.length, 0, '该布局无阻塞');
  const st = CutPlan.statsFor(0);
  eq(st.cuts, 8, '统计总刀数=8');
  eq(st.flips, 3, '默认顺序翻板 3 次');
  near(st.reusableArea, 231100, '可复用余料面积=231100mm²');
}

/* ================= 裁切工序：阻塞区域与人工处理 ================= */
section('裁切工序：阻塞区域与人工处理');
{
  setupBlockedLayout();
  const plan = CutPlan.ensure().plans[0];
  eq(plan.steps.length, 0, '阻塞：无可执行的贯通切刀');
  eq(plan.blocked.length, 1, '标出阻塞区域 1 处');
  eq(plan.blocked[0].uids.length, 4, '4 个零件落入阻塞区域');
  ok(plan.blocked[0].reason.includes('贯通'), '阻塞原因说明无法贯通裁切');
  eq(plan.manual.length, 1, '剩余步骤归入人工处理（1 项）');
  eq(plan.manual[0].uids.length, 4, '人工处理项列出全部阻塞零件');
  const st = CutPlan.statsFor(0);
  eq(st.manualCount, 1, '统计人工处理 1 项');
  eq(st.manualParts, 4, '统计人工处理 4 件');
}

/* ================= 裁切工序：依赖允许的步骤顺序调整 ================= */
section('裁切工序：依赖允许的步骤顺序调整');
{
  setupCutLayout();
  CutPlan.ensure();
  eq(CutPlan.statsFor(0).flips, 3, '默认顺序翻板 3 次');
  eq(CutPlan.canSwap(0, 0), false, '第1/2刀有依赖（子板由前刀产生）不可交换');
  eq(CutPlan.canSwap(0, 1), false, '第2/3刀有依赖不可交换');
  eq(CutPlan.canSwap(0, 3), true, '第4/5刀无依赖可交换');
  const before = CutPlan.orderFor(0).slice();
  ok(CutPlan.swap(0, 3), '交换第4/5刀成功');
  const after = CutPlan.orderFor(0);
  eq(after[3], before[4], '交换后第4刀为原第5刀');
  eq(after[4], before[3], '交换后第5刀为原第4刀');
  eq(CutPlan.statsFor(0).flips, 5, '交换后翻板次数重算为 5');
  eq(after.slice().sort().join(','), before.slice().sort().join(','), '交换后步骤集合不变');
}

/* ================= 裁切工序：候选切法切换 ================= */
section('裁切工序：候选切法切换');
{
  setupCutLayout();
  CutPlan.ensure();
  const rootKey = '0,0,1000,500';
  eq(App.cutplanData.plans[0].steps[0].at, 2, '默认首刀 x=2（修板边）');
  eq(App.cutplanData.plans[0].steps[0].candCount, 6, '整板有 6 个候选切法');
  CutPlan.setCandidate(0, rootKey, 1);   // 候选1 = 竖切 x=405（先分离）
  eq(App.cutplanData.plans[0].steps[0].at, 405, '切换候选后首刀 x=405');
  CutPlan.ensure();   // 模拟 renderAll 重新进入
  eq(App.cutplanData.plans[0].steps[0].at, 405, '候选覆盖在重新渲染后保持');
  CutPlan.setCandidate(0, rootKey, 99);
  ok(App.cutplanData.plans[0].steps[0].candIndex < 6, '候选序号越界被钳制');
}

/* ================= 裁切工序：拖动/旋转后旧工序失效并重新分析 ================= */
section('裁切工序：拖动/旋转后旧工序失效并重新分析');
{
  setupCutLayout();
  CutPlan.ensure();
  CutPlan.setCandidate(0, '0,0,1000,500', 1);   // 自定义切法
  eq(App.cutplanData.plans[0].steps[0].at, 405, '自定义切法生效');
  App.layout().sheets[0].placements[0].x = 6;   // 模拟拖动零件
  CutPlan.ensure();   // renderAll 中的钩子
  eq(Object.keys(App.cutplan.overrides).length, 0, '几何变化后切法覆盖失效');
  eq(App.cutplanData.plans[0].steps[0].at, 3, '按新排样重新分析（首刀 x=3）');
  const p = App.layout().sheets[0].placements[0];   // 模拟旋转零件
  const w = p.w; p.w = p.h; p.h = w; p.rotated = true;
  CutPlan.ensure();
  eq(App.cutplanData.plans[0].steps[0].at, 3, '旋转后工序同步重分析');
}

/* ================= 裁切工序：随项目保存与恢复 ================= */
section('裁切工序：随项目保存与恢复');
{
  setupCutLayout();
  CutPlan.ensure();
  CutPlan.setCandidate(0, '0,0,1000,500', 1);
  CutPlan.swap(0, 3);
  const savedOrder = CutPlan.orderFor(0).slice();
  // 模拟项目保存（Main.saveProject 的 data 字段）与重新打开（Main.applyProject）
  const data = JSON.parse(JSON.stringify({
    cutplan: App.cutplan, cutStates: App._cutStates, cutOpen: true,
  }));
  App.cutplan = data.cutplan;
  App._cutStates = data.cutStates;
  App.cutOpen = data.cutOpen;
  App.cutplanData = null;
  CutPlan.ensure();
  eq(App.cutplanData.plans[0].steps[0].at, 405, '恢复后候选切法保持');
  eq(CutPlan.orderFor(0).join(','), savedOrder.join(','), '恢复后自定义步骤顺序保持');
}

/* ================= 裁切工序：打印采用已选工序与当前顺序 ================= */
section('裁切工序：打印采用已选工序与当前顺序');
{
  setupCutLayout();
  CutPlan.ensure();
  App.layouts.forEach(recomputeLayoutStats);
  let html = Print.buildHtml(App.layout());
  ok(html.includes('裁切工序'), '打印页含裁切工序表');
  ok(html.includes('切割顺序'), '打印页保留切割顺序说明');
  ok(html.includes('修边'), '打印页含修边类型');
  ok(html.includes('共 8 刀'), '打印摘要总刀数=8');
  ok(html.includes('翻板 3 次'), '打印摘要翻板 3 次');
  // 默认顺序：第4刀 y=495 在第5刀 x=407 之前
  let i495 = html.indexOf('y = 495'), i407 = html.indexOf('x = 407');
  ok(i495 >= 0 && i407 >= 0 && i495 < i407, '默认顺序下 y=495 刀在 x=407 刀之前');
  CutPlan.swap(0, 3);   // 交换第4/5刀 → 打印应反映当前顺序
  html = Print.buildHtml(App.layout());
  i495 = html.indexOf('y = 495'); i407 = html.indexOf('x = 407');
  ok(i407 >= 0 && i495 >= 0 && i407 < i495, '换序后打印采用当前步骤顺序');
  CutPlan.setCandidate(0, '0,0,1000,500', 1);   // 切换候选 → 首刀 x=405
  html = Print.buildHtml(App.layout());
  ok(html.includes('<tr><td>1</td><td>竖切</td><td>x = 405</td>'), '候选切换后打印首刀为已选切法');
}

/* ================= 裁切工序：阻塞布局打印列出人工处理项 ================= */
section('裁切工序：阻塞布局打印列出人工处理项');
{
  setupBlockedLayout();
  App.layouts.forEach(recomputeLayoutStats);
  const html = Print.buildHtml(App.layout());
  ok(html.includes('人工处理'), '打印页列出人工处理项');
  ok(html.includes('贯通'), '打印页含阻塞原因');
  ok(html.includes('P1#1') && html.includes('P4#1'), '人工处理项涉及零件列出');
  ok(html.includes('人工处理区'), '打印图标出阻塞区域');
}

/* ================= 裁切工序：面板开合与画布高亮层（DOM mock） ================= */
section('裁切工序：面板开合与画布高亮层');
{
  // 极简 DOM mock：支持 classList / appendChild / remove / querySelector(All)
  function mockEl(tag) {
    const el = {
      tag, children: [], attrs: {}, _cls: new Set(), parent: null,
      innerHTML: '', textContent: '', value: 0, max: 0, disabled: false, title: '',
      dataset: {}, style: {},
    };
    el.classList = {
      add: (...cs) => cs.forEach(c => el._cls.add(c)),
      remove: (...cs) => cs.forEach(c => el._cls.delete(c)),
      toggle: (c, f) => { if (f === undefined) f = !el._cls.has(c); if (f) el._cls.add(c); else el._cls.delete(c); },
      contains: (c) => el._cls.has(c),
    };
    el.setAttribute = (k, v) => {
      el.attrs[k] = v;
      if (k === 'class') el._cls = new Set(String(v).split(/\s+/).filter(Boolean));
    };
    el.getAttribute = (k) => el.attrs[k];
    el.appendChild = (ch) => { ch.parent = el; el.children.push(ch); return ch; };
    el.remove = () => {
      if (el.parent) {
        const i = el.parent.children.indexOf(el);
        if (i >= 0) el.parent.children.splice(i, 1);
        el.parent = null;
      }
    };
    el.addEventListener = () => {};
    el.querySelector = () => mockEl('mock');
    el.querySelectorAll = (sel) => {
      if (!sel.startsWith('.')) return [];
      const cls = sel.slice(1);
      const out = [];
      (function walk(n) { n.children.forEach(ch => { if (ch._cls.has(cls)) out.push(ch); walk(ch); }); })(el);
      return out;
    };
    return el;
  }
  const idEls = {};
  const tbodyMock = mockEl('tbody');
  const svgMock = mockEl('svg');
  const realDoc = global.document;
  global.document = {
    getElementById: (id) => idEls[id] || (idEls[id] = mockEl('div#' + id)),
    querySelector: (sel) => (sel === '#cp-steps tbody' ? tbodyMock : mockEl('mock')),
    createElement: (tag) => mockEl(tag),
    createElementNS: (ns, tag) => mockEl(tag),
  };
  global.Canvas = { svg: svgMock, sheetOffsets: [{ x: 0, y: 0, w: 1000, h: 500 }], NS: 'http://www.w3.org/2000/svg' };
  const overlayCount = () => svgMock.querySelectorAll('.cut-overlay').length;

  try {
    setupCutLayout();
    App.cutOpen = false;
    CutUI.refresh();
    ok(idEls['cutpanel']._cls.has('hidden'), '初始/关闭状态：面板带 hidden，不占空间');
    eq(overlayCount(), 0, '关闭状态：画布无工序高亮层');

    App.cutOpen = true;
    CutUI.refresh();
    ok(!idEls['cutpanel']._cls.has('hidden'), '打开面板：hidden 移除');
    ok(idEls['btn-cutplan']._cls.has('on'), '打开面板：顶栏按钮高亮');
    eq(overlayCount(), 1, '打开后面布只有 1 层高亮');

    // 连续前后切换：每次切换前移除旧 cut-overlay
    let maxOverlay = 0;
    for (let i = 0; i < 8; i++) { CutUI.stepBy(1); maxOverlay = Math.max(maxOverlay, overlayCount()); }
    for (let i = 0; i < 8; i++) { CutUI.stepBy(-1); maxOverlay = Math.max(maxOverlay, overlayCount()); }
    eq(maxOverlay, 1, '连续前后切换：画布始终只保留当前步骤的 1 层高亮');
    eq(App.cutplan.cursors['0'], 0, '前后切换后游标回到 0');

    CutUI.setCursor(5);
    eq(App.cutplan.cursors['0'], 5, '定位到第 6 刀');
    eq(overlayCount(), 1, '定位后仍只有 1 层高亮');

    App.cutOpen = false;
    CutUI.refresh();
    ok(idEls['cutpanel']._cls.has('hidden'), '关闭面板：hidden 恢复，画布空间释放');
    ok(!idEls['btn-cutplan']._cls.has('on'), '关闭面板：顶栏按钮取消高亮');
    eq(overlayCount(), 0, '关闭面板：画布高亮层清除');
  } finally {
    global.document = realDoc;
    delete global.Canvas;
  }
}

/* ================= 结果 ================= */
console.log(`\n${passed} 通过, ${failed} 失败`);
process.exit(failed ? 1 : 0);
