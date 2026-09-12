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
global.Canvas = { svg: { querySelectorAll: () => [] }, sheetOffsets: [] };

/* ---- 加载被测模块 ---- */
const src = ['state.js', 'edging.js', 'defects.js', 'grain.js', 'validate.js', 'cutplan.js', 'cutui.js', 'print.js', 'parttol.js']
  .map(f => fs.readFileSync(path.join(__dirname, '..', 'static', 'js', f), 'utf8'))
  .join('\n');
eval(src + `
global.App = App; global.Validate = Validate; global.Print = Print;
global.CutPlan = CutPlan; global.CutUI = CutUI; global.Defects = Defects;
global.PartTol = PartTol; global.Grain = Grain; global.Edging = Edging;
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

/* ================= 板面缺陷：拖动 / 调整 / 闭合（纯状态） ================= */
section('缺陷：核心拖动、顶点调整与多边形闭合后立即复核');
{
  global.Canvas = global.Canvas || { svg: { querySelectorAll: () => [], querySelector: () => null }, sheetOffsets: [] };
  setupDefectLayout();
  const lay = App.layout();
  // D1 初始核心 (100,100)-(200,200)，放一个压在核心上的零件
  lay.sheets[0].placements = [
    { uid: 'P1#1', partId: 'P1', name: '门板', x: 110, y: 110, w: 80, h: 80, rotated: false, locked: false }];
  let res = Validate.check();
  ok(res.vmap.get('P1#1').has('defect'), '初始：P1#1 与 D1 冲突');

  // 模拟整体拖动缺陷 300mm 右移（Defects.onPointerMove 的变更逻辑）
  const d0 = App.defects['S1#0'][0];
  const orig = JSON.stringify(d0.points);
  const drag = { kind: 'move', key: 'S1#0', id: 'D1', start: { x: 150, y: 150 } };
  d0.points = JSON.parse(orig).map(p => ({ x: p.x + 300, y: p.y }));
  res = Validate.check();   // 每次改动后立即复核
  ok(!res.vmap.get('P1#1') || !res.vmap.get('P1#1').has('defect'), '拖走缺陷后立即解除冲突');
  ok(res.dmap.get('S1#0:D1') == null, 'D1 不再影响任何零件');
  // 拖回
  d0.points = JSON.parse(orig);
  res = Validate.check();
  ok(res.vmap.get('P1#1').has('defect'), '拖回后立即重新标记冲突');

  // 矩形对角手柄调整：把第二个对角点拉到 (150,150)
  d0.points = [{ x: 100, y: 100 }, { x: 150, y: 150 }];
  res = Validate.check();
  ok(res.vmap.get('P1#1').has('defect'), '调小后的缺陷核心仍被 P1#1 压住 → 冲突');
  // 拉到远离零件处
  d0.points = [{ x: 100, y: 100 }, { x: 105, y: 105 }];
  res = Validate.check();
  // 小核心(100..105)与零件(110..190)严格不重叠；外扩30仍侵入 → 冲突
  ok(res.vmap.get('P1#1').has('defect'), '外扩30仍侵入零件 → 冲突');
  // 外扩改为 0 且仅相邻不重叠 → 不冲突
  d0.clearance = 0;
  res = Validate.check();
  ok(!res.vmap.get('P1#1') || !res.vmap.get('P1#1').has('defect'), '零外扩且核心在零件外 → 不冲突');

  // 多边形闭合：≥3 顶点闭合后形成缺陷并可立即检出冲突
  App.defects['S1#0'] = [];
  App.defectMode = 'poly';
  Defects._draft = { shape: 'poly', key: 'S1#0',
    verts: [{ x: 120, y: 120 }, { x: 180, y: 120 }, { x: 150, y: 180 }], current: null };
  Defects.drag = null;
  Defects.finishPolyDraft();
  eq(App.defects['S1#0'].length, 1, '双击/Enter 闭合后多边形缺陷入库（不再停留草稿）');
  eq(Defects._draft, null, '闭合后草稿清除');
  res = Validate.check();
  ok(res.vmap.get('P1#1') && res.vmap.get('P1#1').has('defect'), '新闭合多边形立即参与复核');
}

/* ================= 板面缺陷：容缺模态取消不保存 ================= */
section('缺陷：容缺设置取消还原面别/等级/容许区');
{
  setupDefectLayout();
  const p1 = App.partDef('P1');
  const saved = { faceReq: p1.faceReq, allowGrade: p1.allowGrade,
    allowZones: JSON.parse(JSON.stringify(p1.allowZones)) };
  // 模拟 PartTol 打开时快照 + 编辑 + 取消还原（不依赖 DOM）
  PartTol.part = p1;
  PartTol._snapshot = { faceReq: p1.faceReq, allowGrade: p1.allowGrade,
    allowZones: JSON.parse(JSON.stringify(p1.allowZones)) };
  p1.faceReq = 'both'; p1.allowGrade = 3;
  p1.allowZones.push({ points: [{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 10 }] });
  PartTol.restoreSnapshot();
  eq(p1.faceReq, saved.faceReq, '取消：面别还原');
  eq(p1.allowGrade, saved.allowGrade, '取消：允许等级还原');
  eq(p1.allowZones.length, saved.allowZones.length, '取消：容许区数量还原');
}

/* ================= 板面缺陷避让 ================= */
section('缺陷：几何工具（点在多边形内 / 矩形-多边形距离 / 面别）');
{
  const sq = [{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 10 }, { x: 0, y: 10 }];
  ok(Defects.pointInPoly(5, 5, sq), '点在正方形内');
  ok(!Defects.pointInPoly(15, 5, sq), '点在正方形外');
  near(Defects.rectPolyDist(20, 0, 5, 5, sq), 10, '矩形与多边形水平间隙 10');
  near(Defects.rectPolyDist(5, -6, 5, 5, sq), 1, '矩形与多边形垂直间隙 1');
  near(Defects.rectPolyDist(0, 0, 10, 10, sq), 0, '重叠距离为 0');
  const tri = [{ x: 0, y: 0 }, { x: 20, y: 0 }, { x: 0, y: 20 }];
  near(Defects.rectPolyDist(30, 30, 10, 10, tri), Math.hypot(20, 20), '矩形到三角形斜边距离');
  // 面别相遇矩阵
  ok(!Defects.faceConflict('front', 'any'), '正反面均可的零件不避让');
  ok(Defects.faceConflict('both', 'front'), '双面缺陷 vs 正面要求 → 相遇');
  ok(Defects.faceConflict('front', 'both'), '正面缺陷 vs 双面要求 → 相遇');
  ok(!Defects.faceConflict('back', 'front'), '反面缺陷 vs 正面要求 → 不相遇');
  ok(Defects.faceConflict('front', 'front'), '正面缺陷 vs 正面要求 → 相遇');
  // 两点矩形展开四点
  const d = { shape: 'rect', points: [{ x: 120, y: 160 }, { x: 60, y: 40 }], clearance: 0 };
  eq(Defects.polyPoints(d).length, 4, '矩形两点存储展开为 4 点');
  near(Defects.polyArea(Defects.polyPoints(d)), 60 * 120, '矩形核心面积');
}

function setupDefectLayout() {
  App.settings = { kerf: 3, margin: 5, spacing: 2 };
  App.sheets = [{ id: 'S1', name: '板', width: 1000, height: 500, grain: 'none', quantity: 1 }];
  App.parts = [
    { id: 'P1', name: '门板', width: 300, height: 200, quantity: 1, rotatable: true,
      grain: 'none', faceReq: 'front', allowGrade: 0, allowZones: [] },
    { id: 'P2', name: '背板', width: 300, height: 200, quantity: 1, rotatable: true,
      grain: 'none', faceReq: 'back', allowGrade: 0, allowZones: [] },
    { id: 'P3', name: '层板', width: 300, height: 200, quantity: 1, rotatable: true,
      grain: 'none', faceReq: 'front', allowGrade: 1, allowZones: [] },
  ];
  App.defects = {
    'S1#0': [{ id: 'D1', type: 'knot', grade: 3, face: 'front', clearance: 30, shape: 'rect',
               points: [{ x: 100, y: 100 }, { x: 200, y: 200 }] }],
  };
  App.layouts = [{
    id: 1, strategy: '测试',
    sheets: [{ sheetId: 'S1', name: '板', instance: 0, width: 1000, height: 500, placements: [] }],
    unplaced: [], stats: {},
  }];
  App.active = 0;
  App.selected = null;
  App.resetHistory();
}

section('缺陷：blockingDefect 安全外扩 / 等级 / 面别 / 容许区');
{
  setupDefectLayout();
  const list = App.defects['S1#0'];
  const p1 = App.partDef('P1');
  // 核心(100,100)-(200,200)，外扩30：零件右边 x=100 时净距 0 < 30 → 冲突
  ok(Defects.blockingDefect({ x: 0, y: 0, w: 100, h: 100 }, p1, list), '净距 0 < 外扩30 → 冲突');
  ok(!Defects.blockingDefect({ x: 0, y: 0, w: 60, h: 100 }, p1, list), '净距 40 ≥ 外扩30 → 不冲突');
  // 反面要求的 P2：正面缺陷不相遇
  ok(!Defects.blockingDefect({ x: 0, y: 0, w: 100, h: 100 }, App.partDef('P2'), list), '面别不相遇 → 不冲突');
  // P3 允许 1 级：3 级缺陷仍冲突；1 级缺陷在容许区外也冲突（等级与容许区须同时满足）
  ok(Defects.blockingDefect({ x: 0, y: 0, w: 100, h: 100 }, App.partDef('P3'), list), '3级 > 允许1级 → 冲突');
  const d1 = { ...list[0], grade: 1 };
  ok(Defects.blockingDefect({ x: 0, y: 0, w: 100, h: 100 }, App.partDef('P3'), [d1]),
    '容许区外的1级缺陷（等级够但无容许区覆盖）→ 仍冲突');
  // 允许3级但无容许区 → 仍冲突；允许3级且核心整体落入容许区 → 放行
  const p3b = { ...App.partDef('P3'), allowGrade: 3 };
  ok(Defects.blockingDefect({ x: 0, y: 0, w: 100, h: 100 }, p3b, list), '允许3级但无容许区 → 仍冲突');
  const p3z = { ...p3b, allowZones: [{ points: [
    { x: 90, y: 90 }, { x: 210, y: 90 }, { x: 210, y: 210 }, { x: 90, y: 210 }] }] };
  ok(!Defects.blockingDefect({ x: 0, y: 0, w: 300, h: 200, rotated: false }, p3z, list),
    '3级缺陷整体落入容许区且等级达标 → 放行');
  // 区内但等级超限：允许1级 + 容许区覆盖，3级缺陷仍冲突
  const p1g1 = { ...p1, allowGrade: 1, allowZones: [{ points: [
    { x: 90, y: 90 }, { x: 210, y: 90 }, { x: 210, y: 210 }, { x: 90, y: 210 }] }] };
  ok(Defects.blockingDefect({ x: 0, y: 0, w: 300, h: 200, rotated: false }, p1g1, list),
    '容许区内3级 > 允许1级 → 仍冲突');
  // 容许区：1级缺陷整体在零件内部且落入容许区，允许1级 → 豁免
  const p1z = { ...p1, allowGrade: 1, allowZones: [{ points: [
    { x: 60, y: 60 }, { x: 260, y: 60 }, { x: 260, y: 260 }, { x: 60, y: 260 }] }] };
  const placement = { x: 0, y: 0, w: 300, h: 200, rotated: false };
  ok(!Defects.blockingDefect(placement, p1z, [d1]), '区内1级 + 允许1级 → 豁免');
  // 容许区只覆盖左 50mm：缺陷 x∈[100,200] 不在区内 → 仍冲突
  const p1z2 = { ...p1, allowGrade: 1, allowZones: [{ points: [
    { x: 0, y: 0 }, { x: 50, y: 0 }, { x: 50, y: 200 }, { x: 0, y: 200 }] }] };
  ok(Defects.blockingDefect(placement, p1z2, [d1]), '容许区未覆盖缺陷 → 仍冲突');
  // 零外扩核心：严格重叠阻止，外切不阻止
  const d0 = { ...list[0], clearance: 0 };
  ok(Defects.blockingDefect({ x: 110, y: 110, w: 50, h: 50 }, p1, [d0]), '零外扩：压住核心 → 冲突');
  ok(!Defects.blockingDefect({ x: 50, y: 100, w: 50, h: 100 }, p1, [d0]), '零外扩：外切核心 → 不冲突');
  // 双面缺陷 vs 正反面均可 → 仍冲突
  const db = { ...list[0], face: 'both', clearance: 0 };
  const pAny = { ...p1, faceReq: 'any' };
  ok(Defects.blockingDefect({ x: 110, y: 110, w: 50, h: 50 }, pAny, [db]), '双面缺陷 vs 正反面均可 → 冲突');
  ok(!Defects.blockingDefect({ x: 110, y: 110, w: 50, h: 50 }, pAny,
    [{ ...db, face: 'front' }]), '单面缺陷 vs 正反面均可 → 可翻板放行');
  // 旋转零件容许区坐标映射（视觉顺时针）：局部容许区 (0,0)-(40,200)
  const p1r = { ...p1, width: 300, height: 200, allowZones: [{ points: [
    { x: 0, y: 0 }, { x: 40, y: 0 }, { x: 40, y: 200 }, { x: 0, y: 200 }] }] };
  const pr = { x: 0, y: 0, w: 200, h: 300, rotated: true };
  const zt = Defects.transformZone(p1r.allowZones[0], pr, p1r);
  // (lx,ly)→(x+ph-ly, y+lx)：ph=200 → 区域为 x∈[0,200], y∈[0,40]
  ok(zt.every(q => q.x >= -1e-9 && q.x <= 200 + 1e-9 && q.y >= -1e-9 && q.y <= 40 + 1e-9),
    '旋转后容许区映射到零件顶部条带');
  // 避让碎料面积 > 0 且不超过可用区面积
  const scrap = Defects.expandedArea(list[0], 5, 990, 490);
  ok(scrap > 100 * 100 && scrap <= 990 * 490, '外扩碎料面积估算合理（实际 ' + Math.round(scrap) + '）');
}

section('缺陷：Validate 复核与受影响零件映射');
{
  setupDefectLayout();
  const lay = App.layout();
  // P1#1 压住缺陷（侵入安全区），P2#1 反面要求不冲突，P3#1 远离缺陷
  lay.sheets[0].placements = [
    { uid: 'P1#1', partId: 'P1', name: '门板', x: 60, y: 60, w: 300, h: 200, rotated: false, locked: false },
    { uid: 'P2#1', partId: 'P2', name: '背板', x: 60, y: 60, w: 300, h: 200, rotated: false, locked: false },
    { uid: 'P3#1', partId: 'P3', name: '层板', x: 600, y: 250, w: 300, h: 200, rotated: false, locked: false },
  ];
  const res = Validate.check();
  ok(res.vmap.get('P1#1') && res.vmap.get('P1#1').has('defect'), 'P1#1 标记缺陷冲突');
  ok(!res.vmap.get('P2#1') || !res.vmap.get('P2#1').has('defect'), 'P2#1（反面要求）不冲突');
  ok(!res.vmap.get('P3#1') || !res.vmap.get('P3#1').has('defect'), 'P3#1 远离缺陷不冲突');
  const affected = res.dmap.get('S1#0:D1');
  ok(affected && affected.length === 1 && affected[0] === 'P1#1', '受影响零件映射到 D1 → P1#1');
  ok(res.messages.some(m => m.code === 'defect' && m.loc && m.loc.id === 'D1' && m.loc.sheetIndex === 0),
    '冲突提示携带板材/缺陷定位信息');
  // 拖动复核 checkPlacement：侵入区非法、安全距离外合法
  ok(!Validate.checkPlacement(0, 'P1#1', 60, 60, 300, 200), '拖入安全区 → 非法');
  ok(Validate.checkPlacement(0, 'P1#1', 620, 40, 300, 200), '安全外扩且与其他零件间距满足 → 合法');

  // 统计：合格 2、冲突 1、碎料 > 0
  recomputeLayoutStats(lay);
  eq(lay.stats.qualifiedCount, 2, '合格零件数 2');
  eq(lay.stats.defectConflictCount, 1, '缺陷冲突数 1');
  ok(lay.stats.defectScrap > 0, '避让碎料面积计入统计');

  // 避让碎料只统计方案实际使用的板材：第二张板有缺陷但无零件 → 不计入
  App.defects['S1#1'] = [{ id: 'D2', type: 'knot', grade: 3, face: 'front',
    clearance: 50, shape: 'rect', points: [{ x: 10, y: 10 }, { x: 100, y: 100 }] }];
  lay.sheets.push({ sheetId: 'S1', name: '板', instance: 1, width: 1000, height: 500, placements: [] });
  const scrapOneUsed = (() => { recomputeLayoutStats(lay); return lay.stats.defectScrap; })();
  // 移除已用板上的缺陷 → 只剩未用板缺陷，合计应为 0
  const d0 = App.defects['S1#0'].splice(0, 1)[0];
  recomputeLayoutStats(lay);
  eq(lay.stats.defectScrap, 0, '未使用的缺陷板不计入避让碎料');
  // 恢复
  App.defects['S1#0'].push(d0);
  lay.sheets.pop();
  delete App.defects['S1#1'];
  recomputeLayoutStats(lay);
  ok(lay.stats.defectScrap > 0 && Math.abs(lay.stats.defectScrap - scrapOneUsed) < 1e-6,
    '已用缺陷板的碎料恢复计入');

  // 拖动缺陷后立即复核：把缺陷移到 P3#1 处 → P3 变为受影响件
  App.defects['S1#0'][0].points = [{ x: 650, y: 280 }, { x: 750, y: 380 }];
  const res2 = Validate.check();
  ok(!res2.vmap.get('P1#1') || !res2.vmap.get('P1#1').has('defect'), '缺陷移走后 P1#1 解除冲突');
  ok(res2.vmap.get('P3#1') && res2.vmap.get('P3#1').has('defect'), 'P3#1 立即被标为受影响');
  // 撤销恢复缺陷位置（快照含 defects）
  App.pushHistory();
  App.undo();
  eq(App.defects['S1#0'][0].points[0].x, 100, '撤销恢复缺陷位置');
}

section('缺陷：随项目数据序列化与打印图标注');
{
  setupDefectLayout();
  // 打印 SVG 含缺陷编号、类型、避让距离与安全外扩多边形
  App.violations = Validate.check();
  const lay = App.layout();
  const r = Print.sheetSvg(lay.sheets[0], 0, null);
  ok(r.defects.length === 1, '打印数据携带缺陷列表');
  ok(r.svg.includes('D1'), '打印图标注缺陷编号 D1');
  ok(r.svg.includes('避让30mm'), '打印图标注避让距离');
  ok(r.svg.includes('节疤'), '打印图标注缺陷类型');
  ok(/stroke-dasharray/.test(r.svg), '打印图含安全边界虚线');
  const html = Print.buildHtml(lay);
  ok(html.includes('板面缺陷'), '打印页含板面缺陷章节');
  ok(html.includes('合格零件'), '打印摘要含合格零件数');
  // 容许区打印：给零件加容许区后图上出现蓝色虚线多边形
  App.parts[0].allowZones = [{ points: [
    { x: 0, y: 0 }, { x: 100, y: 0 }, { x: 100, y: 100 }, { x: 0, y: 100 }] }];
  lay.sheets[0].placements = [
    { uid: 'P1#1', partId: 'P1', name: '门板', x: 5, y: 5, w: 300, h: 200, rotated: false, locked: false }];
  const r2 = Print.sheetSvg(lay.sheets[0], 0, null);
  ok(r2.svg.includes('#1565c0'), '容许区在打印图上以蓝色虚线标出');
}

/* ================= 拼纹对花组 ================= */
function setupGrainLayout() {
  App.settings = { kerf: 3, margin: 5, spacing: 2 };
  App.sheets = [{ id: 'S1', name: '纵纹板', width: 2440, height: 1220, grain: 'vertical',
    quantity: 1, grainPeriod: 240, grainBase: { x: 0, y: 0 } }];
  App.parts = [
    { id: 'P1', name: '门板', width: 500, height: 350, quantity: 3, rotatable: true, grain: 'none' },
  ];
  App.grainGroups = [{ id: 'G1', dir: 'h', productGap: 2, tolerance: 2, sameSheet: true,
    members: ['P1#1', 'P1#2', 'P1#3'] }];
  App.layouts = [{
    id: 1, strategy: '测试',
    sheets: [{
      sheetId: 'S1', name: '纵纹板', instance: 0, width: 2440, height: 1220,
      grain: 'vertical', grainPeriod: 240, grainBase: { x: 0, y: 0 },
      placements: [
        { uid: 'P1#1', partId: 'P1', name: '门板', x: 5, y: 5, w: 500, h: 350, rotated: false, locked: false },
        { uid: 'P1#2', partId: 'P1', name: '门板', x: 510, y: 5, w: 500, h: 350, rotated: false, locked: false },
        { uid: 'P1#3', partId: 'P1', name: '门板', x: 1015, y: 5, w: 500, h: 350, rotated: false, locked: false },
      ],
    }],
    unplaced: [], stats: {},
  }];
  App.active = 0;
  App.selected = null;
  App.resetHistory();
}

section('拼纹：接缝相位评估（与后端同口径）');
{
  setupGrainLayout();
  // 纵纹横排：纹理轴沿拼缝（y vs x 链），同板同带 → 错花量 0
  let ev = Grain.evaluate(App.layout());
  eq(ev.totalGroups, 1, '检测到 1 个拼纹组');
  eq(ev.completeCount, 1, '同板同带纵纹横排：组完整');
  eq(ev.seams.length, 2, '两条接缝');
  ok(ev.seams.every(s => s.offset === 0 && s.qualified), '两条缝错花量均为 0 且合格');
  eq(ev.allQualified, true, '全部合格');

  // 横纹板沿拼链方向：错花量 = wrap(板上净距-成品间隙, T) = wrap(5-2,240)=3
  App.sheets[0].grain = 'horizontal';
  App.layouts[0].sheets[0].grain = 'horizontal';
  ev = Grain.evaluate(App.layout());
  near(ev.maxOffset, 3, '横纹横排最大错花量为 3mm');
  eq(ev.allQualified, false, '容差 2mm 时 3mm 超限 → 不合格');
  ok(ev.badUids.has('P1#2'), '超限成员进入 badUids');

  // 容差放宽到 3 → 合格
  App.grainGroups[0].tolerance = 3;
  ev = Grain.evaluate(App.layout());
  eq(ev.allQualified, true, '容差 3mm 时合格');
  eq(ev.completeCount, 1, '容差放宽后组完整');

  // 按周期取板上净距 242（=2+240）→ wrap(242-2,240)=0
  App.grainGroups[0].tolerance = 0;
  const ps = App.layouts[0].sheets[0].placements;
  ps[1].x = 5 + 500 + 242; ps[2].x = ps[1].x + 500 + 242;
  ev = Grain.evaluate(App.layout());
  ok(ev.seams.every(s => s.offset === 0), '周期对齐（净距=间隙+k·T）时错花量为 0');
  eq(ev.completeCount, 1, '周期对齐且容差 0 仍完整');

  // 未记录周期 → unknown，不算合格
  App.sheets[0].grainPeriod = 0;
  App.layouts[0].sheets[0].grainPeriod = 0;
  App.layouts[0].sheets[0].placements.forEach((p, i) => { p.x = 5 + i * 505; });
  ev = Grain.evaluate(App.layout());
  eq(ev.seams[0].status, 'unknown', '缺周期接缝状态为 unknown');
  eq(ev.completeCount, 0, 'unknown 接缝不计入完整组');
}

section('拼纹：跨板、错带、同板要求与成员缺失');
{
  setupGrainLayout();
  // 跨板（两板同周期不同基点 10）：带向相位差 = wrap(5-5)=0
  App.sheets = [
    { id: 'S1', name: '纵纹板', width: 2440, height: 1220, grain: 'vertical', quantity: 1, grainPeriod: 240, grainBase: { x: 0, y: 0 } },
    { id: 'S2', name: '纵纹板', width: 2440, height: 1220, grain: 'vertical', quantity: 1, grainPeriod: 240, grainBase: { x: 10, y: 0 } },
  ];
  App.layouts[0].sheets.push({
    sheetId: 'S2', name: '纵纹板', instance: 0, width: 2440, height: 1220,
    grain: 'vertical', grainPeriod: 240, grainBase: { x: 10, y: 0 }, placements: [] });
  const s0 = App.layouts[0].sheets[0], s1 = App.layouts[0].sheets[1];
  const p3 = s0.placements.splice(2, 1)[0];
  p3.x = 5; s1.placements.push(p3);
  App.grainGroups[0].sameSheet = false;
  let ev = Grain.evaluate(App.layout());
  const seam = ev.seams.find(s => s.to === 'P1#3');
  eq(seam.crossSheet, true, '识别跨板接缝');
  near(seam.offset, 0, '基点一致带向相位差为 0');
  eq(ev.completeCount, 1, '跨板对花合格时组仍完整');

  // 同板要求打开 → 违规
  App.grainGroups[0].sameSheet = true;
  ev = Grain.evaluate(App.layout());
  eq(ev.groups[0].sameSheetViolation, true, '违反同板要求被标记');
  eq(ev.completeCount, 0, '违反同板要求组不完整');

  // 错带（y 偏移 8mm，容差 2）→ 超限
  App.grainGroups[0].sameSheet = false;
  s1.placements[0].y = 13;
  ev = Grain.evaluate(App.layout());
  near(ev.maxOffset, 8, '错带量计入错花量');
  eq(ev.completeCount, 0, '错带超容差时不完整');

  // 成员未放置 → partial/failed
  s1.placements = [];
  ev = Grain.evaluate(App.layout());
  eq(ev.groups[0].status, 'partial', '缺一件 → partial');
  const v = Validate.check();
  ok(v.messages.some(m => m.msg && m.msg.includes('G1') && m.msg.includes('未放置')),
     '校验消息列出未放置成员与组号');
}

section('拼纹：最近全部合格摆位的记录与回退');
{
  setupGrainLayout();
  const lay = App.layout();
  eq(Grain.saveCheckpoint(lay), true, '全部合格时建立基线快照');
  eq(Grain.hasCheckpoint(lay), false, '当前状态与基线相同 → 无需回退');
  // 移动到另一组"仍合格"摆位（纵纹带向，错花量恒 0），基线更新
  const ps = lay.sheets[0].placements;
  ps[1].x = 600; ps[2].x = 1200;
  eq(Grain.saveCheckpoint(lay), true, '另一组合格摆位更新基线');
  // 改成横纹并放到错花超限位置（净距 95，wrap(95-2,240)=93 > 2）
  App.sheets[0].grain = 'horizontal';
  lay.sheets[0].grain = 'horizontal';
  ps[1].x = 600; ps[2].x = 1200;   // 保持当前位置
  eq(Grain.saveCheckpoint(lay), false, '超限时不覆盖合格基线');
  eq(Grain.hasCheckpoint(lay), false, '当前仍与基线几何相同 → 不可回退（基线随几何移动过）');
  ps[1].x = 700;
  eq(Grain.hasCheckpoint(lay), true, '几何偏离基线后可回退');
  eq(Grain.restoreCheckpoint(lay), true, '执行回退');
  near(lay.sheets[0].placements[1].x, 600, '回退后恢复基线位置 600');
}

section('拼纹：违规标注与实时统计');
{
  setupGrainLayout();
  App.sheets[0].grain = 'horizontal';
  App.layouts[0].sheets[0].grain = 'horizontal';
  const v = Validate.check();
  ok(v.vmap.get('P1#2') && v.vmap.get('P1#2').has('grainmatch'), '超限成员标 grainmatch');
  ok(v.messages.some(m => /错花量/.test(m.msg || '')), '违规消息含错花量数值');
  recomputeLayoutStats(App.layout());
  eq(App.layout().stats.groupTotal, 1, '统计：拼纹组数');
  eq(App.layout().stats.groupComplete, 0, '统计：完整组 0');
  near(App.layout().stats.maxSeamOffset, 3, '统计：最大接缝偏差 3mm');
}

/* ================= 封边尺寸补偿 ================= */
section('封边：毛坯/成品换算、旋转换向、批次与接缝校验');
{
  // 成品 600×400；左/右封 1mm（余量 0.5），上封 2mm（余量 0）
  const edge = (kind, material, thickness, trim) => ({ kind: kind || 'none', material: material || '', thickness: thickness || 0, trim: trim || 0 });
  const part = {
    id: 'E1', name: '侧板', width: 600, height: 400, quantity: 1,
    edges: { top: edge('exposed', 'ABS', 2, 0), right: edge('none'), bottom: edge('none'),
             left: edge('exposed', 'PVC', 1, 0.5) },
  };
  Edging.ensureEdges(part);
  const d = Edging.blankDims(part);
  near(d.bw, 599.5, '毛坯宽 = 600 −1 +0.5');
  near(d.bh, 398, '毛坯高 = 400 −2');
  const g0 = Edging.productGeom(part, false);
  near(g0.ox, -0.5, '未旋转成品 ox = 左边补偿 -0.5');
  near(g0.oy, -2, '未旋转成品 oy = 上边补偿 -2');
  const g1 = Edging.productGeom(part, true);
  near(g1.ox, 0, '旋转成品 ox = comp.bottom(0)');
  near(g1.oy, -0.5, '旋转成品 oy = comp.left(-0.5)');
  near(g1.w, 400, '旋转成品宽 = 成品高');
  near(g1.blankH, 599.5, '旋转毛坯高 = 未旋毛坯宽');
  // 旋转换向（与后端一致）：canonical 右 → visual 上、上 → visual 左、左 → visual 下
  const ves = Edging.visualEdges(part, true);
  eq(ves.find(e => e.key === 'top').canonical, 'right', '旋转：上边来自 canonical 右边');
  eq(ves.find(e => e.key === 'left').canonical, 'top', '旋转：左边来自 canonical 上边');
  eq(ves.find(e => e.key === 'bottom').canonical, 'left', '旋转：下边来自 canonical 左边');

  // 工序核对：毛坯非正指出具体边 / 外露未封 / 拼接误封
  const bad = { id: 'E9', name: '坏', width: 10, height: 10, edges: {
    top: edge('exposed', '', 0, 0), right: edge('none'),
    bottom: edge('join', 'PVC', 1, 0), left: edge('exposed', 'A', 20, 0) } };
  Edging.ensureEdges(bad);
  const issues = Edging.partIssues(bad);
  ok(issues.some(i => i.code === 'blanknonpositive' && /左边/.test(i.msg)), '毛坯非正指出左边');
  ok(issues.some(i => i.code === 'exposedunbanded' && /上边/.test(i.msg)), '外露未封指出上边');
  ok(issues.some(i => i.code === 'joinbanded' && /下边/.test(i.msg)), '拼接误封指出下边');

  // 旧项目（无 edges）：毛坯 = 成品
  const legacy = { id: 'L1', width: 300, height: 200 };
  Edging.ensureEdges(legacy);
  near(Edging.blankDims(legacy).bw, 300, '旧项目毛坯宽=成品');
  near(Edging.blankDims(legacy).bh, 200, '旧项目毛坯高=成品');
}

section('封边：补偿后接缝成品净距（1mm/3mm 合格不得误报 9/7mm）');
{
  const band = { kind: 'exposed', material: 'PVC', thickness: 2, trim: 0 };
  const none = { kind: 'none' };
  const mkPart = (id, facingRight) => ({
    id, name: '门', width: 500, height: 350, quantity: 1,
    edges: { top: none, bottom: none,
             left: facingRight ? none : band, right: facingRight ? band : none },
  });
  // 两侧各封 2mm，毛坯净距 5：成品净距 = 5−2−2 = 1，pgap=1/tol=3 → 合格
  App.sheets = [{ id: 'S1', name: '板', width: 2440, height: 1220, grain: 'none', quantity: 1 }];
  App.parts = [mkPart('A', true), mkPart('B', false)];
  App.grainGroups = [{ id: 'G1', dir: 'h', productGap: 1, tolerance: 3, sameSheet: true,
    members: ['A#1', 'B#1'] }];
  const geomA = Edging.productGeom(App.parts[0], false);
  const geomB = Edging.productGeom(App.parts[1], false);
  App.layouts = [{ id: 1, strategy: 't', sheets: [{ sheetId: 'S1', instance: 0, width: 2440, height: 1220, placements: [
    { uid: 'A#1', partId: 'A', x: 5, y: 5, w: 498, h: 350, rotated: false, product: geomA },
    { uid: 'B#1', partId: 'B', x: 508, y: 5, w: 498, h: 350, rotated: false, product: geomB },
  ] }], unplaced: [], stats: {} }];
  App.active = 0;
  let v = Validate.check();
  ok(!v.messages.some(m => m.code === 'grainmatch'), '成品净距 1mm 合格：无误报超限');
  // 单边封 2mm（A 右侧）：B 不封边，成品净距 = 5−2 = 3
  App.parts[1].edges = { top: none, bottom: none, left: none, right: none };
  App.layouts[0].sheets[0].placements[1].w = 500;
  App.layouts[0].sheets[0].placements[1].product = Edging.productGeom(App.parts[1], false);
  App.layouts[0].sheets[0].placements[1].x = 508;
  v = Validate.check();
  ok(!v.messages.some(m => m.code === 'grainmatch'), '成品净距 3mm 合格：无误报超限');

  // 修边余量把接缝撑到 19mm（>2+2）→ 必须报超限（独立状态，避免前例泄漏）
  App.parts = [
    { id: 'A', name: '门', width: 500, height: 350, quantity: 1,
      edges: { top: none, bottom: none, left: none,
        right: { kind: 'exposed', material: 'PVC', thickness: 1, trim: 8 } } },
    { id: 'B', name: '门', width: 500, height: 350, quantity: 1,
      edges: { top: none, bottom: none, right: none,
        left: { kind: 'exposed', material: 'PVC', thickness: 1, trim: 8 } } },
  ];
  App.grainGroups = [{ id: 'G1', dir: 'h', productGap: 2, tolerance: 2, sameSheet: true,
    members: ['A#1', 'B#1'] }];
  // 毛坯 507（=500−1+8），毛坯净距 5 → 成品净距 = 5+7+7 = 19
  App.layouts = [{ id: 1, strategy: 't', sheets: [{ sheetId: 'S1', instance: 0, width: 2440, height: 1220, placements: [
    { uid: 'A#1', partId: 'A', x: 5, y: 5, w: 507, h: 350, rotated: false, product: Edging.productGeom(App.parts[0], false) },
    { uid: 'B#1', partId: 'B', x: 517, y: 5, w: 507, h: 350, rotated: false, product: Edging.productGeom(App.parts[1], false) },
  ] }], unplaced: [], stats: {} }];
  App.active = 0;
  const v19 = Validate.check();
  ok(v19.messages.some(m => m.code === 'grainmatch' && /补偿后接缝超限/.test(m.msg) && /19/.test(m.msg)),
    '补偿后成品净距 19mm 超限被标出（含具体数值与边）');
}

section('封边：批次合并、顺序与用量统计');
{
  const e = (mat, th) => ({ kind: 'exposed', material: mat, thickness: th, trim: 0 });
  const n = { kind: 'none' };
  App.parts = [
    { id: 'Q1', name: '长', width: 600, height: 400, quantity: 1,
      edges: { top: e('ABS', 2), bottom: n, left: e('ABS', 2), right: n } },
    { id: 'Q2', name: '短', width: 300, height: 200, quantity: 1,
      edges: { top: e('ABS', 2), bottom: n, left: n, right: n } },
  ];
  App.sheets = [{ id: 'S1', width: 1000, height: 1000, grain: 'none', quantity: 1 }];
  App.layouts = [{ id: 1, sheets: [{ sheetId: 'S1', instance: 0, width: 1000, height: 1000, placements: [
    { uid: 'Q1#1', partId: 'Q1', x: 0, y: 0, w: 596, h: 396, rotated: false },
    { uid: 'Q2#1', partId: 'Q2', x: 0, y: 401, w: 296, h: 196, rotated: false },
  ] }], unplaced: [], stats: {} }];
  App.active = 0; App.edgingOrder = { mode: 'shortFirst', orders: {} };
  let b = Edging.batches(App.layout(), 'shortFirst', {});
  eq(b.length, 1, '同材料同厚度合并为 1 批');
  eq(b[0].count, 3, '共 3 段（2 长 1 短）');
  near(b[0].total, 400 + 600 + 300, '用量合计 = 短边优先排序不影响合计 1300');
  eq(b[0].segments[0].length, 300, '先短边：第 1 段 300');
  const bl = Edging.batches(App.layout(), 'longFirst', {});
  eq(bl[0].segments[0].length, 600, '先长边：第 1 段 600');
  // 手动换序
  const segs = bl[0].segments.slice();
  [segs[0], segs[2]] = [segs[2], segs[0]];
  const order = segs.map(s => s.uid + '|' + s.edgeVisual);
  const bm = Edging.batches(App.layout(), 'manual', { [b[0].key]: order });
  eq(bm[0].segments[0].uid, 'Q2#1', '手动次序生效：首段为短件');
  // 段方向标注：Q1 上边/左边
  const q1 = b[0].segments.filter(s => s.uid === 'Q1#1').map(s => s.edgeVisual).sort();
  ok(q1.join(',') === 'left,top', '段带封边方向（上、左）');
}

/* ================= 结果 ================= */
console.log(`\n${passed} 通过, ${failed} 失败`);
process.exit(failed ? 1 : 0);
