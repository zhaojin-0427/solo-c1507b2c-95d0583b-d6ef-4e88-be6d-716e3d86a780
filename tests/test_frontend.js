/* 前端回归测试（Node 运行，mock 浏览器环境）。
 *
 * 覆盖：
 * - 缺陷1：历史栈支持连续编辑逐步撤销，重做可恢复刚撤销的变更
 * - 缺陷2：手动删除零件后立即重算放置数/未放置数/利用率/废料/切割数
 * - 缺陷3：纹理与旋转约束的前端校验（含原料板纹理参与）
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
const src = ['state.js', 'validate.js', 'print.js']
  .map(f => fs.readFileSync(path.join(__dirname, '..', 'static', 'js', f), 'utf8'))
  .join('\n');
eval(src + `
global.App = App; global.Validate = Validate; global.Print = Print;
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

/* ================= 结果 ================= */
console.log(`\n${passed} 通过, ${failed} 失败`);
process.exit(failed ? 1 : 0);
