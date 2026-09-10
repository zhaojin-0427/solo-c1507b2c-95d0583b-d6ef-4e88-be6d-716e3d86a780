"""矩形板材排样引擎。

仅处理矩形零件与直线切割。坐标系：板材左上角为原点，x 向右，y 向下，单位毫米。
排样在"可用区域"（板材四边扣除留边 margin）内进行，输出时换算回板材绝对坐标。

零件间距规则：任意两个零件之间的净距离不得小于 gap = 锯缝 kerf + 零件间距 spacing。
"""
from __future__ import annotations

EPS = 1e-6
MAX_PART_INSTANCES = 400   # 展开数量后的零件实例上限
MAX_SHEET_INSTANCES = 40   # 展开数量后的板材实例上限


def _f(v, default=0.0):
    try:
        return float(v)
    except (TypeError, ValueError):
        return default


def expand_parts(parts):
    """把零件定义按数量展开为实例列表，uid 形如 P1#3。"""
    insts = []
    for p in parts or []:
        qty = max(0, min(int(_f(p.get('quantity'), 1)), 500))
        for i in range(qty):
            insts.append({
                'uid': f"{p.get('id')}#{i + 1}",
                'partId': p.get('id'),
                'name': p.get('name') or p.get('id'),
                'w': _f(p.get('width')),
                'h': _f(p.get('height')),
                'rotatable': bool(p.get('rotatable', True)),
                'grain': p.get('grain', 'none'),
            })
    return insts


def expand_sheets(sheets):
    insts = []
    for s in sheets or []:
        qty = max(0, min(int(_f(s.get('quantity'), 1)), 50))
        for i in range(qty):
            insts.append({
                'sheetId': s.get('id'),
                'name': s.get('name') or s.get('id'),
                'instance': i,
                'w': _f(s.get('width')),
                'h': _f(s.get('height')),
            })
    return insts


def orientations(inst):
    """零件允许的摆放方向，返回 [(w, h, rotated), ...]。

    纹理规则：horizontal = 纹理必须沿板材宽度方向（不可旋转）；
    vertical = 纹理必须沿板材高度方向（必须旋转 90°）；none = 任意（受 rotatable 约束）。
    """
    w, h = inst['w'], inst['h']
    grain = inst.get('grain', 'none')
    if grain == 'horizontal':
        return [(w, h, False)]
    if grain == 'vertical':
        return [(h, w, True)]
    if inst.get('rotatable', True) and abs(w - h) > EPS:
        return [(w, h, False), (h, w, True)]
    return [(w, h, False)]


def _conflicts(x, y, w, h, placed, gap):
    """新矩形与已放置矩形（含锁定）是否间距不足 / 重叠。"""
    for r in placed:
        if (x < r['x'] + r['w'] + gap - EPS and r['x'] < x + w + gap - EPS and
                y < r['y'] + r['h'] + gap - EPS and r['y'] < y + h + gap - EPS):
            return True
    return False


def _find_position(inst, placed, uw, uh, gap):
    """在单张板材可用区域内寻找最靠下、再最靠左（Bottom-Left）的可行位置。"""
    best = None  # (y, x, w, h, rotated)
    cands = {(0.0, 0.0)}
    for r in placed:
        cands.add((r['x'] + r['w'] + gap, r['y']))
        cands.add((r['x'], r['y'] + r['h'] + gap))
    for w, h, rot in orientations(inst):
        if w > uw + EPS or h > uh + EPS:
            continue
        for cx, cy in sorted(cands):
            if cx + w > uw + EPS or cy + h > uh + EPS:
                continue
            if _conflicts(cx, cy, w, h, placed, gap):
                continue
            if best is None or (cy, cx) < (best[0], best[1]):
                best = (cy, cx, w, h, rot)
    if best is None:
        return None
    cy, cx, w, h, rot = best
    return {'x': cx, 'y': cy, 'w': w, 'h': h, 'rotated': rot}


def _guillotine(rects):
    """递归估算分离这组矩形所需的直线（贯通）切割次数；无法贯通分离时按零件数估算。"""
    if len(rects) <= 1:
        return 0
    for c in sorted({round(r['x'] + r['w'], 6) for r in rects}):
        left = [r for r in rects if r['x'] + r['w'] <= c + EPS]
        right = [r for r in rects if r['x'] >= c - EPS]
        if left and right and len(left) + len(right) == len(rects):
            return 1 + _guillotine(left) + _guillotine(right)
    for c in sorted({round(r['y'] + r['h'], 6) for r in rects}):
        top = [r for r in rects if r['y'] + r['h'] <= c + EPS]
        bot = [r for r in rects if r['y'] >= c - EPS]
        if top and bot and len(top) + len(bot) == len(rects):
            return 1 + _guillotine(top) + _guillotine(bot)
    return len(rects)


def _sheet_cuts(placed, uw, uh):
    """单张板材估算切割次数 = 分离切割 + 修边次数（零件未贴到可用区域边缘的每一边修一次）。"""
    if not placed:
        return 0
    cuts = _guillotine(placed)
    minx = min(r['x'] for r in placed)
    miny = min(r['y'] for r in placed)
    maxx = max(r['x'] + r['w'] for r in placed)
    maxy = max(r['y'] + r['h'] for r in placed)
    trims = int(minx > EPS) + int(miny > EPS) + int(maxx < uw - EPS) + int(maxy < uh - EPS)
    return cuts + trims


def _unplaced_reason(inst, sheet_insts, margin):
    max_uw = max_uh = 0.0
    fits_some = False
    for s in sheet_insts:
        uw, uh = s['w'] - 2 * margin, s['h'] - 2 * margin
        max_uw, max_uh = max(max_uw, uw), max(max_uh, uh)
        for w, h, _ in orientations(inst):
            if w <= uw + EPS and h <= uh + EPS:
                fits_some = True
                break
    if not fits_some:
        grain = inst.get('grain', 'none')
        note = {'horizontal': '（纹理要求水平，不可旋转）',
                'vertical': '（纹理要求垂直，须旋转 90°）'}.get(grain, '')
        return (f"尺寸 {inst['w']:g}×{inst['h']:g} 超出所有板材可用区域"
                f"（最大可用 {max_uw:g}×{max_uh:g}）{note}")
    return "板材剩余空间不足，无法容纳"


def pack(part_insts, sheet_insts, settings, locked=None, sort_key=None):
    """执行一次排样。locked: {板材实例序号字符串: [已锁定放置]}，这些放置保持不动。"""
    kerf = _f(settings.get('kerf'), 3)
    margin = _f(settings.get('margin'), 0)
    spacing = _f(settings.get('spacing'), 0)
    gap = kerf + spacing
    locked = locked or {}

    locked_uids = set()
    states = []
    for idx, s in enumerate(sheet_insts):
        placed = []
        for lp in locked.get(str(idx), []):
            placed.append({
                'uid': lp['uid'], 'partId': lp['partId'],
                'name': lp.get('name') or lp['partId'],
                'x': _f(lp.get('x')) - margin, 'y': _f(lp.get('y')) - margin,
                'w': _f(lp.get('w')), 'h': _f(lp.get('h')),
                'rotated': bool(lp.get('rotated')), 'locked': True,
            })
            locked_uids.add(lp['uid'])
        states.append({'def': s, 'uw': s['w'] - 2 * margin,
                       'uh': s['h'] - 2 * margin, 'placed': placed})

    pool = [p for p in part_insts if p['uid'] not in locked_uids]
    pool.sort(key=sort_key or (lambda p: p['w'] * p['h']), reverse=True)

    unplaced = []
    for inst in pool:
        done = False
        for st in states:  # 按板材顺序 first-fit，优先填满前面的板
            if st['uw'] <= EPS or st['uh'] <= EPS:
                continue
            pos = _find_position(inst, st['placed'], st['uw'], st['uh'], gap)
            if pos is not None:
                st['placed'].append({
                    'uid': inst['uid'], 'partId': inst['partId'], 'name': inst['name'],
                    'x': pos['x'], 'y': pos['y'], 'w': pos['w'], 'h': pos['h'],
                    'rotated': pos['rotated'], 'locked': False,
                })
                done = True
                break
        if not done:
            unplaced.append(inst)

    out_sheets = []
    for st in states:
        placements = [{
            'uid': r['uid'], 'partId': r['partId'], 'name': r.get('name'),
            'x': round(r['x'] + margin, 3), 'y': round(r['y'] + margin, 3),
            'w': r['w'], 'h': r['h'], 'rotated': r['rotated'],
            'locked': r.get('locked', False),
        } for r in st['placed']]
        out_sheets.append({
            'sheetId': st['def']['sheetId'], 'name': st['def']['name'],
            'instance': st['def']['instance'],
            'width': st['def']['w'], 'height': st['def']['h'],
            'placements': placements,
        })

    used = [st for st in states if st['placed']]
    placed_area = sum(r['w'] * r['h'] for st in states for r in st['placed'])
    used_area = sum(st['def']['w'] * st['def']['h'] for st in used) or 1.0
    cuts = sum(_sheet_cuts(st['placed'], st['uw'], st['uh']) for st in states)

    stats = {
        'utilization': placed_area / used_area,
        'waste': used_area - placed_area,
        'cuts': cuts,
        'usedSheets': len(used),
        'totalSheets': len(out_sheets),
        'placedCount': sum(len(s['placements']) for s in out_sheets),
        'unplacedCount': len(unplaced),
    }
    unplaced_out = [{
        'uid': p['uid'], 'partId': p['partId'], 'name': p['name'],
        'reason': _unplaced_reason(p, sheet_insts, margin),
    } for p in unplaced]
    return {'sheets': out_sheets, 'unplaced': unplaced_out, 'stats': stats}


def _signature(res):
    return tuple(sorted(
        (si, p['uid'], round(p['x'], 2), round(p['y'], 2), p['w'], p['h'], p['rotated'])
        for si, s in enumerate(res['sheets']) for p in s['placements']))


# 多种排序策略 → 生成多个可比较的方案
STRATEGIES = [
    ('面积降序', lambda p: p['w'] * p['h']),
    ('长边降序', lambda p: max(p['w'], p['h'])),
    ('短边降序', lambda p: min(p['w'], p['h'])),
    ('宽度降序', lambda p: p['w']),
    ('高度降序', lambda p: p['h']),
]


def generate_layouts(payload, max_layouts=3):
    settings = payload.get('settings') or {}
    margin = _f(settings.get('margin'), 0)
    sheet_insts = expand_sheets(payload.get('sheets'))
    part_insts = expand_parts(payload.get('parts'))
    if not sheet_insts:
        return {'layouts': [], 'error': '请先定义至少一张原料板'}
    if not part_insts:
        return {'layouts': [], 'error': '请先定义至少一个零件'}
    if len(sheet_insts) > MAX_SHEET_INSTANCES:
        return {'layouts': [], 'error': f'板材实例过多（>{MAX_SHEET_INSTANCES}）'}
    if len(part_insts) > MAX_PART_INSTANCES:
        return {'layouts': [], 'error': f'零件实例过多（>{MAX_PART_INSTANCES}），请减少数量'}

    # 过滤 uid 已不在零件池中的锁定项（例如数量被改小）
    valid_uids = {p['uid'] for p in part_insts}
    locked = {k: [lp for lp in v if lp.get('uid') in valid_uids]
              for k, v in (payload.get('locked') or {}).items()}

    results, seen = [], set()
    for label, key in STRATEGIES:
        res = pack(part_insts, sheet_insts, settings, locked, key)
        sig = _signature(res)
        if sig in seen:
            continue
        seen.add(sig)
        results.append((label, res))

    # 排序：未放置少者优先 → 利用率高者优先 → 切割次数少者优先
    results.sort(key=lambda item: (len(item[1]['unplaced']),
                                   -item[1]['stats']['utilization'],
                                   item[1]['stats']['cuts']))
    max_layouts = max(1, min(int(_f(max_layouts, 3)), 5))
    layouts = [{'id': i + 1, 'strategy': label, **res}
               for i, (label, res) in enumerate(results[:max_layouts])]
    return {'layouts': layouts}
