"""矩形板材排样引擎。

仅处理矩形零件与直线切割。坐标系：板材左上角为原点，x 向右，y 向下，单位毫米。
排样在"可用区域"（板材四边扣除留边 margin）内进行，输出时换算回板材绝对坐标。

零件间距规则：任意两个零件之间的净距离不得小于 gap = 锯缝 kerf + 零件间距 spacing。

板面缺陷避让：每张板材实例可携带若干缺陷区（矩形/多边形，坐标为板材绝对坐标）。
缺陷含 类型(节疤/裂纹/划痕)、等级(1 轻微 ~ 3 严重)、影响面(正面/反面/双面)与
安全外扩量。零件含 正反面要求、允许缺陷等级与容许区（零件局部坐标多边形）。
缺陷核心区按安全外扩量膨胀（距离判定，多边形任意形状均精确）后视为禁入区，
与板边留量、零件间距一并参与 Bottom-Left 放置计算。
"""
from __future__ import annotations

import math

EPS = 1e-6
MAX_PART_INSTANCES = 400   # 展开数量后的零件实例上限
MAX_SHEET_INSTANCES = 40   # 展开数量后的板材实例上限

DEFECT_TYPES = {'knot': '节疤', 'crack': '裂纹', 'scratch': '划痕'}
DEFECT_FACES = {'front': '正面', 'back': '反面', 'both': '双面'}


def _f(v, default=0.0):
    try:
        return float(v)
    except (TypeError, ValueError):
        return default


# ---------------------------------------------------------------------------
# 缺陷几何（绝对/局部坐标均为 mm；多边形点为 {'x','y'} 或 (x, y)）
# ---------------------------------------------------------------------------
def _pt(p):
    return (_f(p[0]), _f(p[1])) if isinstance(p, (list, tuple)) else (_f(p.get('x')), _f(p.get('y')))


def poly_area(points):
    """简单多边形面积（绝对值，鞋带公式）。"""
    pts = [_pt(p) for p in points]
    if len(pts) < 3:
        return 0.0
    s = 0.0
    for i in range(len(pts)):
        x1, y1 = pts[i]
        x2, y2 = pts[(i + 1) % len(pts)]
        s += x1 * y2 - x2 * y1
    return abs(s) * 0.5


def poly_bbox(points):
    xs = [_pt(p)[0] for p in points]
    ys = [_pt(p)[1] for p in points]
    return min(xs), min(ys), max(xs), max(ys)


def point_in_poly(x, y, points):
    """射线法判断点是否在简单多边形内（边界按在内处理）。"""
    pts = [_pt(p) for p in points]
    inside = False
    n = len(pts)
    j = n - 1
    for i in range(n):
        xi, yi = pts[i]
        xj, yj = pts[j]
        if ((yi > y) != (yj > y)):
            xc = (xj - xi) * (y - yi) / (yj - yi + EPS) + xi
            if xc >= x - EPS:
                inside = not inside
        if abs(x - xi) <= EPS and min(yi, yj) - EPS <= y <= max(yi, yj) + EPS and \
                abs((x - xi) * (yj - yi) - (xj - xi) * (y - yi)) <= 1e-6:
            return True   # 点落在边上
        j = i
    return inside


def _seg_intersect(p1, p2, p3, p4):
    """两线段是否相交（含相接）。"""
    def ccw(a, b, c):
        return (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0])
    d1, d2 = ccw(p3, p4, p1), ccw(p3, p4, p2)
    d3, d4 = ccw(p1, p2, p3), ccw(p1, p2, p4)
    if ((d1 > EPS and d2 < -EPS) or (d1 < -EPS and d2 > EPS)) and \
       ((d3 > EPS and d4 < -EPS) or (d3 < -EPS and d4 > EPS)):
        return True
    # 端点落在另一线段上
    def on(a, b, c):
        return abs((b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0])) <= 1e-6 and \
            min(a[0], b[0]) - EPS <= c[0] <= max(a[0], b[0]) + EPS and \
            min(a[1], b[1]) - EPS <= c[1] <= max(a[1], b[1]) + EPS
    return on(p3, p4, p1) or on(p3, p4, p2) or on(p1, p2, p3) or on(p1, p2, p4)


def _seg_dist(p1, p2, p3, p4):
    """两线段间最短距离。"""
    if _seg_intersect(p1, p2, p3, p4):
        return 0.0
    def point_seg_dist(p, a, b):
        vx, vy = b[0] - a[0], b[1] - a[1]
        wx, wy = p[0] - a[0], p[1] - a[1]
        l2 = vx * vx + vy * vy
        t = 0.0 if l2 <= EPS else max(0.0, min(1.0, (wx * vx + wy * vy) / l2))
        px, py = a[0] + t * vx, a[1] + t * vy
        return math.hypot(p[0] - px, p[1] - py)
    return min(point_seg_dist(p1, p3, p4), point_seg_dist(p2, p3, p4),
               point_seg_dist(p3, p1, p2), point_seg_dist(p4, p1, p2))


def rect_poly_dist(x, y, w, h, points):
    """矩形与简单多边形的最短距离；相交/包含返回 0。"""
    pts = [_pt(p) for p in points]
    rect_corners = [(x, y), (x + w, y), (x + w, y + h), (x, y + h)]
    # 多边形顶点在矩形内，或矩形顶点在多边形内 → 相交
    for px, py in pts:
        if x - EPS <= px <= x + w + EPS and y - EPS <= py <= y + h + EPS:
            return 0.0
    for cx, cy in rect_corners:
        if len(pts) >= 3 and point_in_poly(cx, cy, pts):
            return 0.0
    rect_edges = [(rect_corners[i], rect_corners[(i + 1) % 4]) for i in range(4)]
    best = float('inf')
    for i in range(len(pts)):
        pe = (pts[i], pts[(i + 1) % len(pts)])
        for re in rect_edges:
            best = min(best, _seg_dist(pe[0], pe[1], re[0], re[1]))
    return best


def face_conflict(defect_face, part_face_req):
    """缺陷影响面与零件正反面要求是否在同一面相遇。

    any=零件正反面均可，可通过翻板避开【单面】缺陷；但双面/贯穿缺陷两面都有，
    翻板也无法避开，故 any 仍与 both 缺陷相遇。front/back=该面为可见面须无缺陷；
    both=双面均可见。
    """
    req = part_face_req or 'any'
    df = defect_face or 'both'
    if df == 'both':
        return True          # 贯穿/双面缺陷：任何零件都无法靠翻板避开
    if req == 'any':
        return False         # 单面缺陷 + 正反面均可 → 翻板避让
    if req == 'both':
        return True
    return df == req


def rect_poly_overlap(x, y, w, h, points):
    """矩形与简单多边形是否有【严格重叠】（面积交叠或边交叉）；仅外切/点接触不算。"""
    pts = [_pt(p) for p in points]
    rect_corners = [(x, y), (x + w, y), (x + w, y + h), (x, y + h)]
    # 多边形顶点在矩形内部（严格，不在边界上）
    for px, py in pts:
        if x + EPS < px < x + w - EPS and y + EPS < py < y + h - EPS:
            return True
    # 多边形整体位于矩形内（凸矩形：顶点全在内或边上 ⇒ 整个多边形在内），
    # 且质心严格在内——覆盖缺陷与零件完全重合等"顶点全在边上但面积重叠"的情形
    if len(pts) >= 3 and w > EPS and h > EPS:
        inside_on = [x - EPS <= px <= x + w + EPS and y - EPS <= py <= y + h + EPS
                     for px, py in pts]
        if all(inside_on):
            cx = sum(p[0] for p in pts) / len(pts)
            cy = sum(p[1] for p in pts) / len(pts)
            if x + EPS < cx < x + w - EPS and y + EPS < cy < y + h - EPS:
                return True
    # 矩形顶点在多边形内部（严格，排除正好落在多边形边上的角点）
    if len(pts) >= 3:
        for cx, cy in rect_corners:
            if point_in_poly(cx, cy, pts) and not _point_on_poly_edge(cx, cy, pts):
                return True
    # 边与边严格相交（不含相接）
    rect_edges = [(rect_corners[i], rect_corners[(i + 1) % 4]) for i in range(4)]
    for i in range(len(pts)):
        a, b = pts[i], pts[(i + 1) % len(pts)]
        for c, dd in rect_edges:
            if _seg_cross_proper(a, b, c, dd):
                return True
    return False


def _point_on_poly_edge(x, y, pts, tol=1e-6):
    for i in range(len(pts)):
        a, b = pts[i], pts[(i + 1) % len(pts)]
        if abs((b[0] - a[0]) * (y - a[1]) - (b[1] - a[1]) * (x - a[0])) <= tol and \
                min(a[0], b[0]) - tol <= x <= max(a[0], b[0]) + tol and \
                min(a[1], b[1]) - tol <= y <= max(a[1], b[1]) + tol:
            return True
    return False


def _seg_cross_proper(p1, p2, p3, p4):
    """两线段是否严格交叉（端点相接不算）。"""
    def ccw(a, b, c):
        return (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0])
    d1, d2 = ccw(p3, p4, p1), ccw(p3, p4, p2)
    d3, d4 = ccw(p1, p2, p3), ccw(p1, p2, p4)
    return ((d1 > EPS and d2 < -EPS) or (d1 < -EPS and d2 > EPS)) and \
           ((d3 > EPS and d4 < -EPS) or (d3 < -EPS and d4 > EPS))


def transform_zone(zone, x, y, w, h, rotated, pw, ph):
    """零件局部容许区多边形 → 放置后绝对/可用坐标。

    与前端一致：旋转 90°（视觉顺时针，y 向下）映射 (lx,ly) → (x + ph - ly, y + lx)，
    旋转后外接矩形为 ph × pw。zone 结构为 {'points': [(lx,ly), ...]}。
    """
    out = []
    for p in (zone or {}).get('points') or []:
        lx, ly = _pt(p)
        if rotated:
            out.append((x + ph - ly, y + lx))
        else:
            out.append((x + lx, y + ly))
    return out


def defect_inside_allowzone(dpts, x, y, w, h, inst, rotated):
    """缺陷核心是否整体落在零件某容许区内（容许区豁免等级限制）。

    保守规则：缺陷所有顶点都在零件矩形内，且全部位于同一容许区内、无穿边。
    """
    pts = [_pt(p) for p in dpts]
    for px, py in pts:
        if not (x - EPS <= px <= x + w + EPS and y - EPS <= py <= y + h + EPS):
            return False
    pw, ph = inst['w'], inst['h']
    zones = inst.get('allowZones') or []
    for zone in zones:
        zt = transform_zone(zone, x, y, w, h, rotated, pw, ph)
        if len(zt) < 3:
            continue
        if all(point_in_poly(px, py, zt) for px, py in pts):
            crossed = False
            for i in range(len(pts)):
                a, b = pts[i], pts[(i + 1) % len(pts)]
                for j in range(len(zt)):
                    if _seg_intersect(a, b, zt[j], zt[(j + 1) % len(zt)]):
                        crossed = True
                        break
                if crossed:
                    break
            if not crossed:
                return True
    return False


def defect_label(d):
    """D1（节疤·2级·正面·外扩20mm）形式的可读标签。"""
    return ('{id}（{t}·{g}级·{f}·外扩{c:g}mm）').format(
        id=d.get('id') or '?',
        t=DEFECT_TYPES.get(d.get('type'), d.get('type') or '缺陷'),
        g=int(_f(d.get('grade'), 0)),
        f=DEFECT_FACES.get(d.get('face'), d.get('face') or '双面'),
        c=_f(d.get('clearance')),
    )


def expanded_defect_area(d, margin, uw, uh):
    """缺陷禁入区（核心 + 安全外扩）落在可用区域内的面积估算。

    采用 Steiner 外扩近似 A + P·c + πc²（凸多边形精确，凹多边形近似），
    并钳制在可用区域面积内，仅用于方案间"避让碎料面积"的相对比较。
    """
    pts = [(_pt(p)[0] - margin, _pt(p)[1] - margin) for p in d.get('points') or []]
    if len(pts) < 2:
        return 0.0
    core = poly_area(pts)
    perim = 0.0
    for i in range(len(pts)):
        perim += math.hypot(pts[(i + 1) % len(pts)][0] - pts[i][0],
                            pts[(i + 1) % len(pts)][1] - pts[i][1])
    if len(pts) == 2:   # 矩形以两点存储：核心为矩形面积/周长
        x1, y1 = pts[0]
        x2, y2 = pts[1]
        core = abs((x2 - x1) * (y2 - y1))
        perim = 2 * (abs(x2 - x1) + abs(y2 - y1))
    c = max(0.0, _f(d.get('clearance')))
    est = core + perim * c + math.pi * c * c
    usable = max(0.0, uw) * max(0.0, uh)
    return max(0.0, min(est, usable))


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
                'faceReq': p.get('faceReq', 'any'),          # any/front/back/both
                'allowGrade': int(_f(p.get('allowGrade'), 0)),  # 0=不容许任何等级
                'allowZones': p.get('allowZones') or [],     # 零件局部容许区多边形
            })
    return insts


def normalize_defects(defects):
    """规范化缺陷数据：[{id,type,grade,face,clearance,shape:'rect'|'poly',points}]，
    矩形以两个对角点存储，返回时补全四点，便于几何判定。"""
    out = []
    for d in defects or []:
        pts = [_pt(p) for p in (d.get('points') or [])]
        if len(pts) < 2:
            continue
        shape = d.get('shape', 'poly')
        if shape == 'rect' and len(pts) == 2:
            (x1, y1), (x2, y2) = pts
            x1, x2 = sorted((x1, x2))
            y1, y2 = sorted((y1, y2))
            pts = [(x1, y1), (x2, y1), (x2, y2), (x1, y2)]
        if len(pts) < 3:
            continue
        out.append({
            'id': d.get('id') or f"D{len(out) + 1}",
            'type': d.get('type', 'knot'),
            'grade': int(_f(d.get('grade'), 1)),
            'face': d.get('face', 'both'),
            'clearance': max(0.0, _f(d.get('clearance'), 0)),
            'shape': shape,
            'points': pts,
        })
    return out


def defect_map(payload):
    """解析随请求提交的缺陷数据，键形如 'S1#0'（板材ID#实例序号）。"""
    raw = payload.get('defects') or {}
    if not isinstance(raw, dict):
        return {}
    return {k: normalize_defects(v) for k, v in raw.items() if v}


def expand_sheets(sheets, defects=None):
    defects = defects or {}
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
                'grain': s.get('grain', 'none'),
                'defects': defects.get(f"{s.get('id')}#{i}", []),
            })
    return insts


def orientations(inst, sheet_grain='none'):
    """零件在指定纹理板材上的允许摆放方向，返回 [(w, h, rotated), ...]。

    统一约束（与前端 Validate 一致）：
    - rotatable=False 的零件任何情况下都不旋转，包括为满足纹理要求；
    - 零件纹理 horizontal → 不可旋转；vertical → 须旋转 90°（不可旋转则无解）；
    - 原料板纹理与零件纹理均指定且不一致 → 该板不可放置（返回空）。
    """
    w, h = inst['w'], inst['h']
    grain = inst.get('grain', 'none')
    rotatable = bool(inst.get('rotatable', True))
    if grain != 'none' and sheet_grain != 'none' and grain != sheet_grain:
        return []
    if grain == 'horizontal':
        return [(w, h, False)]
    if grain == 'vertical':
        return [(h, w, True)] if rotatable else []
    if rotatable and abs(w - h) > EPS:
        return [(w, h, False), (h, w, True)]
    return [(w, h, False)]


def _conflicts(x, y, w, h, placed, gap):
    """新矩形与已放置矩形（含锁定）是否间距不足 / 重叠。"""
    for r in placed:
        if (x < r['x'] + r['w'] + gap - EPS and r['x'] < x + w + gap - EPS and
                y < r['y'] + r['h'] + gap - EPS and r['y'] < y + h + gap - EPS):
            return True
    return False


def _blocking_defect(x, y, w, h, inst, defects):
    """返回阻止该矩形放在此位置的缺陷；可避让（面别/等级+容许区）则不阻止。

    缺陷坐标与候选矩形均在可用区域坐标系（扣除 margin）。单个缺陷放行的条件：
      1. 面别不相遇（单面缺陷遇正反面均可的零件，可翻板避开）；
      2. 综合容缺：等级 ≤ 允许等级 且 缺陷核心整体在容许区内——两者必须同时满足；
         允许等级为 0 表示任何等级都不容许；
      3. 几何避让：与核心严格重叠，或净距 < 安全外扩量。零外扩时仅严格重叠才阻止，
         外切/点接触不阻止。
    """
    for d in defects:
        if not face_conflict(d['face'], inst.get('faceReq', 'any')):
            continue
        pts = d['points']
        clearance = max(0.0, d.get('clearance', 0.0))
        # 综合容缺判定：等级达标 + 核心整体落入同一容许区，二者同时满足才放行
        allowed_by_grade = bool(inst.get('allowGrade', 0)) and d['grade'] <= inst['allowGrade']
        rotated = abs(w - inst['w']) > EPS or abs(h - inst['h']) > EPS
        in_zone = defect_inside_allowzone(pts, x, y, w, h, inst, rotated)
        if allowed_by_grade and in_zone:
            continue
        # 几何冲突：严格重叠（零外扩时即因此阻止）或净距不足外扩
        if rect_poly_overlap(x, y, w, h, pts):
            return d
        if clearance > EPS:
            dx0, dy0, dx1, dy1 = poly_bbox(pts)
            # 外接盒分离：两个轴向上最近角点间距均 ≥ 外扩 → 逐边距离必 ≥ 外扩
            gx = max(0.0, dx0 - (x + w), x - dx1)
            gy = max(0.0, dy0 - (y + h), y - dy1)
            if gx >= clearance - EPS and gy >= clearance - EPS:
                continue
            dist = rect_poly_dist(x, y, w, h, pts)
            if dist + EPS < clearance:
                return d
    return None


def _defect_candidates(inst, defects):
    """围绕缺陷禁入区生成候选原点：外接盒外侧角点 + 各多边形顶点。

    面别相遇即产生候选（计算量可忽略），候选位置是否可行由 _blocking_defect
    按"等级+容许区"综合容缺与净距精确判定。"""
    cands = set()
    for d in defects:
        if not face_conflict(d['face'], inst.get('faceReq', 'any')):
            continue
        c = max(0.0, d['clearance'])
        x0, y0, x1, y1 = poly_bbox(d['points'])
        for cx, cy in ((x1 + c, y0 - c), (x0 - c, y1 + c), (x1 + c, y1 + c),
                       (x0 - c, y0 - c), (x1 + c, 0.0), (0.0, y1 + c)):
            if cx >= -EPS and cy >= -EPS:
                cands.add((round(max(0.0, cx), 4), round(max(0.0, cy), 4)))
        for px, py in d['points']:
            cands.add((round(max(0.0, px), 4), round(max(0.0, py), 4)))
    return cands


def _find_position(inst, placed, uw, uh, gap, sheet_grain='none', defects=None):
    """在单张板材可用区域内寻找最靠下、再最靠左（Bottom-Left）的可行位置。

    可行位置须同时避开已放置零件（含锯缝/间距）、板边留量与缺陷安全外扩区。
    """
    best = None  # (y, x, w, h, rotated)
    cands = {(0.0, 0.0)}
    for r in placed:
        cands.add((r['x'] + r['w'] + gap, r['y']))
        cands.add((r['x'], r['y'] + r['h'] + gap))
    for cx, cy in _defect_candidates(inst, defects or []):
        cands.add((cx, cy))
    for w, h, rot in orientations(inst, sheet_grain):
        if w > uw + EPS or h > uh + EPS:
            continue
        for cx, cy in sorted(cands):
            if cx + w > uw + EPS or cy + h > uh + EPS:
                continue
            if _conflicts(cx, cy, w, h, placed, gap):
                continue
            if _blocking_defect(cx, cy, w, h, inst, defects or []):
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


def _unplaced_reason(inst, states, settings):
    """解释零件无法放置的原因：纹理/旋转约束冲突、尺寸超限、缺陷阻挡或空间不足。

    states 为 pack 的板材状态列表（含缺陷，坐标已换算到可用区域）。
    返回 {'text': ..., 'conflicts': [{sheetIndex, sheetId, instance, name, defects:[...]}]}。
    """
    margin = _f(settings.get('margin'), 0)
    gap = _f(settings.get('kerf'), 3) + _f(settings.get('spacing'), 0)
    grain = inst.get('grain', 'none')
    grain_label = {'horizontal': '横向', 'vertical': '纵向'}.get(grain, '')
    # 零件自身约束矛盾：要求纵向纹理但不可旋转
    if not orientations(inst):
        return {'text': f"零件要求{grain_label}纹理但设为不可旋转，约束冲突，无法放置",
                'conflicts': []}
    # 原料板纹理参与判断：仅纹理匹配的板材可用于该零件
    compatible = [st for st in states
                  if orientations(inst, st['def'].get('grain', 'none'))]
    if not compatible:
        return {'text': f"零件纹理（{grain_label}）与所有原料板纹理方向冲突，无法放置",
                'conflicts': []}
    max_uw = max(st['uw'] for st in compatible)
    max_uh = max(st['uh'] for st in compatible)
    fits_some = False
    for st in compatible:
        for w, h, _ in orientations(inst, st['def'].get('grain', 'none')):
            if w <= st['uw'] + EPS and h <= st['uh'] + EPS:
                fits_some = True
                break
        if fits_some:
            break
    if not fits_some:
        note = f"（纹理{grain_label}，仅限纹理匹配板材）" if grain_label else ''
        return {'text': (f"尺寸 {inst['w']:g}×{inst['h']:g} 超出可用板材区域"
                         f"（最大可用 {max_uw:g}×{max_uh:g}）{note}"), 'conflicts': []}

    # 在每张空板（仅缺陷）上尝试放置：区分"被缺陷阻挡"与"已被占用剩余空间不足"
    blockers = []
    for idx, st in enumerate(states):
        if not orientations(inst, st['def'].get('grain', 'none')):
            continue
        empty_ok = False
        block_ids = []
        for w, h, _ in orientations(inst, st['def'].get('grain', 'none')):
            if w > st['uw'] + EPS or h > st['uh'] + EPS:
                continue
            # 忽略已放置零件：仅看缺陷是否允许放置
            hit = []
            for d in st['defects']:
                if _blocking_defect(0, 0, w, h, inst, [d]):
                    hit.append(d)
            # 尝试在无零件、仅缺陷的板上搜索
            if _find_position(inst, [], st['uw'], st['uh'], 0,
                              st['def'].get('grain', 'none'), st['defects']) is not None:
                empty_ok = True
                break
            block_ids = hit
        if not empty_ok and block_ids:
            blockers.append({'sheetIndex': idx, 'sheetId': st['def']['sheetId'],
                             'instance': st['def']['instance'],
                             'name': st['def'].get('name') or st['def']['sheetId'],
                             'defects': [defect_label(d) for d in block_ids],
                             'defectIds': [d['id'] for d in block_ids]})
    if blockers:
        first = blockers[0]
        loc = f"板材 {first['sheetId']} #{first['instance'] + 1}"
        dl = '、'.join(first['defects'][:3])
        more = f" 等 {len(blockers)} 张板" if len(blockers) > 1 else ''
        return {'text': f"无法避让 {loc} 的缺陷（{dl}）{more}",
                'conflicts': blockers[:5]}
    return {'text': '板材剩余空间不足，无法容纳', 'conflicts': []}


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
        # 缺陷绝对坐标 → 可用区域坐标
        udefects = [{
            **d,
            'points': [(px - margin, py - margin) for px, py in d['points']],
        } for d in s.get('defects', [])]
        states.append({'def': s, 'uw': s['w'] - 2 * margin,
                       'uh': s['h'] - 2 * margin, 'placed': placed,
                       'defects': udefects})

    pool = [p for p in part_insts if p['uid'] not in locked_uids]
    pool.sort(key=sort_key or (lambda p: p['w'] * p['h']), reverse=True)

    unplaced = []
    for inst in pool:
        done = False
        for st in states:  # 按板材顺序 first-fit，优先填满前面的板
            if st['uw'] <= EPS or st['uh'] <= EPS:
                continue
            pos = _find_position(inst, st['placed'], st['uw'], st['uh'], gap,
                                 st['def'].get('grain', 'none'), st['defects'])
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

    # 合格性：已放置（含锁定）零件不得与任何缺陷冲突（锁定件可能压在缺陷上）
    def defects_abs(st):
        return st['def'].get('defects', [])

    conflict_rows = []   # 供未放置/锁定冲突提示：{uid, sheetIndex, defects:[label]}
    qualified = 0
    for si, st in enumerate(states):
        for r in st['placed']:
            inst = next((p for p in part_insts if p['uid'] == r['uid']), None)
            if inst is None:
                continue
            hit = _blocking_defect(r['x'], r['y'], r['w'], r['h'], inst,
                                   st["defects"])
            if hit:
                conflict_rows.append({
                    'uid': r['uid'], 'sheetIndex': si,
                    'sheetId': st['def']['sheetId'],
                    'instance': st['def']['instance'],
                    'defects': [defect_label(hit)],
                    'defectIds': [hit['id']],
                })
            else:
                qualified += 1

    out_sheets = []
    for st in states:
        placements = [{
            'uid': r['uid'], 'partId': r['partId'], 'name': r.get('name'),
            'x': round(r['x'] + margin, 3), 'y': round(r['y'] + margin, 3),
            'w': r['w'], 'h': r['h'], 'rotated': r['rotated'],
            'locked': r.get('locked', False),
        } for r in st['placed']]
        # 每张已用板材自身的避让碎料（未使用板不计入方案比较）
        sheet_scrap = sum(expanded_defect_area(d, margin, st['uw'], st['uh'])
                          for d in defects_abs(st)) if st['placed'] else 0.0
        out_sheets.append({
            'sheetId': st['def']['sheetId'], 'name': st['def']['name'],
            'instance': st['def']['instance'],
            'width': st['def']['w'], 'height': st['def']['h'],
            'placements': placements,
            'defectScrap': round(sheet_scrap, 1),
        })

    used = [st for st in states if st['placed']]
    placed_area = sum(r['w'] * r['h'] for st in states for r in st['placed'])
    used_area = sum(st['def']['w'] * st['def']['h'] for st in used) or 1.0
    cuts = sum(_sheet_cuts(st['placed'], st['uw'], st['uh']) for st in states)
    # 避让碎料面积：仅统计方案实际使用的板材（未使用缺陷板不影响方案比较）
    defect_scrap = sum(expanded_defect_area(d, margin, st['uw'], st['uh'])
                       for st in used for d in defects_abs(st))

    stats = {
        'utilization': placed_area / used_area,
        'waste': used_area - placed_area,
        'cuts': cuts,
        'usedSheets': len(used),
        'totalSheets': len(out_sheets),
        'placedCount': sum(len(s['placements']) for s in out_sheets),
        'unplacedCount': len(unplaced),
        'qualifiedCount': qualified,
        'defectConflictCount': len(conflict_rows),
        'defectScrap': defect_scrap,
    }
    unplaced_out = []
    for p in unplaced:
        reason = _unplaced_reason(p, states, settings)
        unplaced_out.append({
            'uid': p['uid'], 'partId': p['partId'], 'name': p['name'],
            'reason': reason['text'], 'conflicts': reason['conflicts'],
        })
    return {'sheets': out_sheets, 'unplaced': unplaced_out,
            'conflicts': conflict_rows, 'stats': stats}


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
    dmap = defect_map(payload)
    sheet_insts = expand_sheets(payload.get('sheets'), dmap)
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

    # 排序：未放置少者优先 → 合格零件多者优先 → 使用板材少者优先
    #       → 利用率高者优先 → 避让碎料少者优先 → 切割次数少者优先
    results.sort(key=lambda item: (len(item[1]['unplaced']),
                                   -item[1]['stats']['qualifiedCount'],
                                   item[1]['stats']['usedSheets'],
                                   -item[1]['stats']['utilization'],
                                   item[1]['stats']['defectScrap'],
                                   item[1]['stats']['cuts']))
    max_layouts = max(1, min(int(_f(max_layouts, 3)), 5))
    layouts = [{'id': i + 1, 'strategy': label, **res}
               for i, (label, res) in enumerate(results[:max_layouts])]
    return {'layouts': layouts}
