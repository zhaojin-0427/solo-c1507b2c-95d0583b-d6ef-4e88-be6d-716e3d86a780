"""矩形板材排样引擎。

仅处理矩形零件与直线切割。坐标系：板材左上角为原点，x 向右，y 向下，单位毫米。
排样在"可用区域"（板材四边扣除留边 margin）内进行，输出时换算回板材绝对坐标。

零件间距规则：任意两个零件之间的净距离不得小于 gap = 锯缝 kerf + 零件间距 spacing。

板面缺陷避让：每张板材实例可携带若干缺陷区（矩形/多边形，坐标为板材绝对坐标）。
缺陷含 类型(节疤/裂纹/划痕)、等级(1 轻微 ~ 3 严重)、影响面(正面/反面/双面)与
安全外扩量。零件含 正反面要求、允许缺陷等级与容许区（零件局部坐标多边形）。
缺陷核心区按安全外扩量膨胀（距离判定，多边形任意形状均精确）后视为禁入区，
与板边留量、零件间距一并参与 Bottom-Left 放置计算。

拼纹对花组：grainGroups 描述需要连续对花的零件实例序列（柜门/抽屉面）。
  dir='h' 横拼（沿 x 成排，竖缝），dir='v' 纵拼（沿 y 成列，横缝）；
  productGap 为成品安装间隙，tolerance 为可接受错花量，sameSheet 要求同一张板。
原料板另记 grainPeriod（纹理重复周期 mm，0=未记录）与 grainBase（定位基点 {x,y}）。
接缝错花量按相位比较：纹理轴与拼缝平行 → 比较两侧带向相位（基点差/错带）；
纹理轴与拼链同向 → 比较前缘相位推进（锯缝/成品间隙/跨板基点，周期包裹）。
组按原子单位排样：组员次序、同带、相位容差与板边/锯缝/方向/缺陷同时生效；
整组失败时各成员进入未放置清单并写明触发的限制。
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
                # 纹理重复周期（0=未记录）与定位基点（板材绝对坐标）
                'grainPeriod': max(0.0, _f(s.get('grainPeriod'), 0)),
                'grainBase': {'x': _f((s.get('grainBase') or {}).get('x')),
                              'y': _f((s.get('grainBase') or {}).get('y'))},
                'defects': defects.get(f"{s.get('id')}#{i}", []),
            })
    return insts


# ---------------------------------------------------------------------------
# 拼纹对花组
# ---------------------------------------------------------------------------
def normalize_groups(groups):
    """规范化拼纹组：去重成员 uid，丢弃空组。

    返回 [{id, dir:'h'|'v', productGap, tolerance, sameSheet, members:[uid...]}]。
    """
    out = []
    for g in groups or []:
        seen = set()
        members = []
        for uid in g.get('members') or []:
            uid = str(uid)
            if uid and uid not in seen:
                seen.add(uid)
                members.append(uid)
        if not members:
            continue
        out.append({
            'id': g.get('id') or f"G{len(out) + 1}",
            'dir': g.get('dir') if g.get('dir') in ('h', 'v') else 'h',
            'productGap': max(0.0, _f(g.get('productGap'), 0)),
            'tolerance': max(0.0, _f(g.get('tolerance'), 0)),
            'sameSheet': bool(g.get('sameSheet', False)),
            'members': members,
        })
    return out


def group_member_map(groups):
    """uid → 所属拼纹组（一个实例最多属于一个组）。"""
    m = {}
    for g in groups:
        for uid in g['members']:
            m[uid] = g['id']
    return m


def _phase_wrap(v, period):
    """把相位差包裹到 [-T/2, T/2]，返回绝对值（错花量 mm）。"""
    if period <= EPS:
        return abs(v)
    r = v - period * round(v / period)
    return abs(r)


def evaluate_seam(prev, cur, axis, product_gap, s_prev, s_cur, gap_sheet=None):
    """计算一条拼缝的错花量与状态。

    prev/cur：相邻两成员放置记录（绝对坐标，含 'x','y','w','h'）。
    axis：拼链方向 'x'（横拼成排，缝为竖缝）或 'y'（纵拼成列，缝为横缝）。
    product_gap：成品安装间隙 mm（理想对花时两件在成品上的净距）。
    s_prev/s_cur：两件所在板材实例（含 grain/grainPeriod/grainBase）；同一对象=同一张板。
    gap_sheet：板上两件实际净距（None 时由坐标直接计算）。
    返回 {'offset','status':'ok'|'unknown','band','reason'}；
    'unknown' 表示缺周期/跨板周期不一致，无法核算错花量（按不合格处理）。

    物理模型：同一张板上两件纹理相位差就是板上间距（相对各自基点测量）；
    成品连续对花要求 B 件起点相位 = A 件终点相位 + 成品间隙（模周期）。
      纵纹（纹理轴与拼链同向）：offset = wrap((前缘-base_B) - (A终点-base_A) - 成品间隙)
      横纹（纹理轴沿拼缝）：同带时比较带向基点相位；错带量直接计入错花量。
    """
    if gap_sheet is None:
        if axis == 'x':
            gap_sheet = cur['x'] - (prev['x'] + prev['w'])
        else:
            gap_sheet = cur['y'] - (prev['y'] + prev['h'])
    Tp = max(0.0, s_prev.get('grainPeriod', 0) or 0)
    Tc = max(0.0, s_cur.get('grainPeriod', 0) or 0)
    bp = s_prev.get('grainBase') or {'x': 0.0, 'y': 0.0}
    bc = s_cur.get('grainBase') or {'x': 0.0, 'y': 0.0}
    same_board = s_prev is s_cur
    grain = s_prev.get('grain') or 'none'
    grain_axis = axis if grain == 'none' else ('x' if grain == 'horizontal' else 'y')

    def unk(msg):
        return {'offset': 0.0, 'status': 'unknown', 'band': False, 'reason': msg}

    # 无纹理板材（双方都无纹理方向且未记周期）：没有花纹可对，接缝免核
    if (s_prev.get('grain') or 'none') == 'none' and \
       (s_cur.get('grain') or 'none') == 'none' and Tp <= EPS and Tc <= EPS:
        return {'offset': 0.0, 'status': 'ok', 'band': False, 'reason': ''}

    if grain_axis == axis:
        # 纹理轴与拼链同向
        if axis == 'x':
            front, edge = cur['x'], prev['x'] + prev['w']
            ba, bb = bp['x'], bc['x']
        else:
            front, edge = cur['y'], prev['y'] + prev['h']
            ba, bb = bp['y'], bc['y']
        if same_board:
            if Tp <= EPS:
                return unk('原料板未记录纹理重复周期，无法核算沿纹理方向的错花量')
            off = _phase_wrap(gap_sheet - product_gap, Tp)
            return {'offset': off, 'status': 'ok', 'band': False, 'reason': ''}
        if Tp <= EPS or Tc <= EPS:
            return unk('原料板未记录纹理重复周期，跨板接缝相位无法核算')
        if abs(Tp - Tc) > EPS:
            return unk('两张原料板纹理周期不一致，接缝相位无法对齐')
        off = _phase_wrap((front - bb) - (edge - ba) - product_gap, Tp)
        return {'offset': off, 'status': 'ok', 'band': False, 'reason': ''}

    # 纹理轴与拼链垂直（沿拼缝方向）：同带 + 两侧带向相位
    cross = 'y' if axis == 'x' else 'x'
    if cross == 'y':
        pa, pb = prev['y'] - bp['y'], cur['y'] - bc['y']
        band = abs(cur['y'] - prev['y'])
    else:
        pa, pb = prev['x'] - bp['x'], cur['x'] - bc['x']
        band = abs(cur['x'] - prev['x'])
    if band > EPS:
        return {'offset': band, 'status': 'ok', 'band': True,
                'reason': '成员未处于同一条带（错带）'}
    if same_board:
        return {'offset': 0.0, 'status': 'ok', 'band': False, 'reason': ''}
    if Tp <= EPS or Tc <= EPS:
        return unk('原料板未记录纹理重复周期，跨板带向相位无法核算')
    if abs(Tp - Tc) > EPS:
        return unk('两张原料板纹理周期不一致，带向相位无法对齐')
    return {'offset': _phase_wrap(pb - pa, Tp), 'status': 'ok',
            'band': False, 'reason': ''}


def seam_qualified(seam, tolerance):
    """依据容差判定接缝：unknown 不算合格，错花量 ≤ 容差才合格。"""
    if seam['status'] == 'unknown':
        return False
    return seam['offset'] <= tolerance + EPS


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


def _group_geom(inst, st):
    """成员在候选板上的摆放 (w,h,rot)；与纹理/旋转约束不兼容或超限返回 None。"""
    oris = orientations(inst, st['def'].get('grain', 'none'))
    if not oris:
        return None
    w, h, rot = oris[0]   # 优先不旋转（horizontal 本就不旋转，vertical 本就旋转）
    if w > st['uw'] + EPS or h > st['uh'] + EPS:
        return None
    return w, h, rot


def _grain_axis(st, chain):
    """板材纹理轴：horizontal→x，vertical→y，无纹理→沿拼链方向。"""
    g = st['def'].get('grain') or 'none'
    if g == 'horizontal':
        return 'x'
    if g == 'vertical':
        return 'y'
    return chain


def _rect_ok(st, x, y, w, h, inst, gap, extra):
    """候选矩形在该板可用区是否可行：边界 + 间距/重叠 + 缺陷。"""
    if x < -EPS or y < -EPS or x + w > st['uw'] + EPS or y + h > st['uh'] + EPS:
        return False
    if _conflicts(x, y, w, h, st['placed'] + extra, gap):
        return False
    if _blocking_defect(x, y, w, h, inst, st['defects']):
        return False
    return True


def _chain_cands(chain, st, extra, start, gap, pgap, prev, period, tol, margin, inst=None):
    """沿拼链生成候选链坐标（可用区域坐标），兼顾贴边/绕障与对花周期。

    返回去重升序的候选列表。相位合格的理想间距为 pgap + k·T（同板，
    错花量 = wrap(板上净距-成品间隙)）；另加入障碍右缘+gap 与缺陷外扩角点用于绕障。
    """
    if prev is None:
        cands = {0.0}
        for r in st['placed'] + extra:
            edge = (r['x'] + r['w']) if chain == 'x' else (r['y'] + r['h'])
            cands.add(max(0.0, edge + gap))
        if inst is not None:
            for cx, cy in _defect_candidates(inst, st['defects']):
                cands.add(max(0.0, (cx if chain == 'x' else cy)))
        return sorted(cands)
    edge = (prev['x'] + prev['w']) if chain == 'x' else (prev['y'] + prev['h'])
    cands = set()
    # 对花理想位置：净距 = pgap + k·T（k=0,1,2,…）
    if period and period > EPS:
        k = 0
        while edge + pgap + k * period <= st['uw' if chain == 'x' else 'uh'] + EPS and k < 200:
            c = edge + pgap + k * period
            if c >= start - EPS:
                cands.add(c)
            k += 1
    # 无周期（横纹横排等相位沿拼缝的情形）或绕障：最小净距
    cands.add(max(edge + gap, start))
    for r in st['placed'] + extra:
        e2 = (r['x'] + r['w']) if chain == 'x' else (r['y'] + r['h'])
        c = e2 + gap
        if c >= edge + gap - EPS:
            cands.add(c)
    # 缺陷外扩角点/顶点：沿链方向绕行位置
    if inst is not None:
        for cx, cy in _defect_candidates(inst, st['defects']):
            c = cx if chain == 'x' else cy
            if c >= edge + gap - EPS:
                cands.add(max(0.0, c))
    return sorted(c for c in cands if c >= edge + gap - EPS)


def _band_coords(chain, st, extra, gap, prev, first_band, inst=None):
    """候选带坐标（与拼链垂直方向）：承接上一成员的带，或新带贴边/绕障/绕缺陷。"""
    if prev is not None:
        band = prev['y'] if chain == 'x' else prev['x']
        cands = {band}
        # 同带被占/被缺陷挡时，枚举带起点：障碍外缘 +gap
        for r in st['placed'] + extra:
            e2 = (r['y'] + r['h']) if chain == 'x' else (r['x'] + r['w'])
            cands.add(max(0.0, e2 + gap))
        if inst is not None:
            for cx, cy in _defect_candidates(inst, st['defects']):
                cands.add(max(0.0, (cy if chain == 'x' else cx)))
        return sorted(cands)
    if first_band is not None:
        return [first_band]
    cands = {0.0}
    for r in st['placed'] + extra:
        e2 = (r['y'] + r['h']) if chain == 'x' else (r['x'] + r['w'])
        cands.add(max(0.0, e2 + gap))
    if inst is not None:
        for cx, cy in _defect_candidates(inst, st['defects']):
            cands.add(max(0.0, (cy if chain == 'x' else cx)))
    return sorted(cands)


def _seam_for_records(prev, cur, chain, group, st_prev, st_cur, margin, product_gap=None):
    """由两条放置记录（可用区域坐标）构造绝对坐标记录并评估接缝。"""
    if product_gap is None:
        product_gap = group['productGap']
    p_abs = {'x': prev['x'] + margin, 'y': prev['y'] + margin, 'w': prev['w'], 'h': prev['h']}
    c_abs = {'x': cur['x'] + margin, 'y': cur['y'] + margin, 'w': cur['w'], 'h': cur['h']}
    return evaluate_seam(p_abs, c_abs, chain, product_gap,
                         st_prev['def'], st_cur['def'])


def place_group(group, insts_by_uid, states, gap, margin):
    """把一个拼纹组按原子单位放置。

    成功：{'ok':True,'records':[{uid,inst,state,x,y,w,h,rot}]}
    失败：{'ok':False,'blockers':{uid:[原因...]},'why':code}
    约束同时生效：成员次序（沿拼链）、同带、板边留量、锯缝/间距、纹理方向、
    缺陷避让、接缝错花量 ≤ tolerance、sameSheet 同板要求。
    """
    chain = 'x' if group['dir'] == 'h' else 'y'
    tol, pgap = group['tolerance'], group['productGap']

    members, blockers = [], {}
    for uid in group['members']:
        inst = insts_by_uid.get(uid)
        if inst is None:
            blockers.setdefault(uid, []).append('零件实例不存在（定义或数量已变更）')
        else:
            members.append(inst)
    if blockers:
        return {'ok': False, 'blockers': blockers, 'why': 'missing'}

    compatible = [st for st in states
                  if st['uw'] > EPS and st['uh'] > EPS
                  and all(_group_geom(inst, st) for inst in members)]
    if not compatible:
        for inst in members:
            reasons = []
            if not orientations(inst):
                reasons.append('纹理方向与不可旋转设置冲突')
            else:
                fit_any = any(
                    any(w <= st['uw'] + EPS and h <= st['uh'] + EPS
                        for w, h, _ in orientations(inst, st['def'].get('grain', 'none')))
                    for st in states)
                if fit_any:
                    reasons.append('纹理方向与所有原料板冲突')
                else:
                    reasons.append('尺寸超出所有原料板可用区域')
            blockers[inst['uid']] = reasons
        return {'ok': False, 'blockers': blockers, 'why': 'compat'}

    # 带向等尺寸检查（横拼等高，纵拼等宽）；不一致直接失败
    for st in compatible[:1]:
        geoms = [_group_geom(i, st) for i in members]
        cross_sizes = [(g[1] if chain == 'x' else g[0]) for g in geoms]
        if max(cross_sizes) - min(cross_sizes) > EPS:
            why = '成员' + ('高度' if chain == 'x' else '宽度') + '不一致，无法同带拼合'
            for inst in members:
                blockers[inst['uid']] = [why]
            return {'ok': False, 'blockers': blockers, 'why': 'band'}

    def try_single_board(st):
        """整组落同一张板。返回 records 或 None。"""
        geoms = [_group_geom(i, st) for i in members]
        gax = _grain_axis(st, chain)
        T = st['def'].get('grainPeriod', 0) or 0
        longitudinal = (gax == chain)
        if longitudinal and T <= EPS and (st['def'].get('grain') or 'none') != 'none':
            return None  # 有纹理却未记周期：沿纹理方向无法保证对花
        cross_size = max((g[1] if chain == 'x' else g[0]) for g in geoms)
        pitch_gap = max(gap, pgap)
        chain_len = sum((g[0] if chain == 'x' else g[1]) for g in geoms) \
            + (len(members) - 1) * pitch_gap
        U = st['uw'] if chain == 'x' else st['uh']
        V = st['uh'] if chain == 'x' else st['uw']
        if chain_len > U + EPS or cross_size > V + EPS:
            return None

        # 枚举首成员带坐标（贴 0 / 已有零件外缘 +gap / 缺陷外扩角点）
        first_bands = _band_coords(chain, st, [], gap, None, None, members[0])
        for fb in first_bands:
            recs, extra = [], []
            ok = True
            for k, (inst, (w, h, rot)) in enumerate(zip(members, geoms)):
                prev = recs[-1] if recs else None
                period = T if longitudinal else 0
                cc = _chain_cands(chain, st, extra, 0.0, gap, pgap, prev,
                                  period, tol, margin, inst)
                bc = [fb] if prev is None else _band_coords(
                    chain, st, extra, gap, prev, fb, inst)
                found = None
                for c in cc:
                    for b in bc:
                        x, y = (c, b) if chain == 'x' else (b, c)
                        ww, hh = (w, h)
                        if not _rect_ok(st, x, y, ww, hh, inst, gap, extra):
                            continue
                        if prev is not None:
                            seam = _seam_for_records(prev, {'x': x, 'y': y, 'w': w, 'h': h},
                                                     chain, group, prev['state'], st, margin)
                            if not seam_qualified(seam, tol):
                                continue
                        found = (x, y)
                        break
                    if found:
                        break
                if found is None:
                    ok = False
                    break
                x, y = found
                rec = {'uid': inst['uid'], 'inst': inst, 'state': st,
                       'x': x, 'y': y, 'w': w, 'h': h, 'rot': rot}
                recs.append(rec)
                extra.append(rec)
            if ok and len(recs) == len(members):
                return recs
        return None

    # 优先同板 first-fit（无论是否要求同板，同板对花质量最好）
    for st in compatible:
        recs = try_single_board(st)
        if recs is not None:
            return {'ok': True, 'records': recs}

    if group['sameSheet']:
        why_text = _group_fail_reason(group, members, compatible, gap, margin)
        for inst in members:
            blockers[inst['uid']] = [why_text, '拼纹组要求全部取自同一张板']
        return {'ok': False, 'blockers': blockers, 'why': 'sameSheet'}

    # 允许跨板：沿链逐件 first-fit，每步可换板。相位限制（含跨板周期不一致导致
    # 的 unknown 接缝）是硬约束：找不到接缝全部合格的摆位即整组原子失败。
    recs, extras = [], {}
    fail_idx = None
    fail_causes = []   # 受阻成员触发的具体限制（去重）
    for inst in members:
        prev = recs[-1] if recs else None
        placed_here = False
        causes = set()
        for st in compatible:
            geom = _group_geom(inst, st)
            if geom is None:
                continue
            w, h, rot = geom
            gax = _grain_axis(st, chain)
            T = st['def'].get('grainPeriod', 0) or 0
            longitudinal = (gax == chain)
            extra = extras.get(id(st), [])
            if prev is not None and prev['state'] is st:
                start = ((prev['x'] + prev['w']) if chain == 'x'
                         else (prev['y'] + prev['h'])) + gap
            else:
                start = 0.0
            period = T if (prev is not None and longitudinal) else 0
            cc = _chain_cands(chain, st, extra, start, gap, pgap,
                              prev if prev is not None and prev['state'] is st else None,
                              period, tol, margin, inst)
            bc = _band_coords(chain, st, extra, gap,
                              prev if prev is not None and prev['state'] is st else None,
                              prev['y' if chain == 'x' else 'x'] if prev is not None else None,
                              inst)
            geom_feasible = False
            seam_bad = None
            seam_unknown = None
            for c in cc:
                for b in bc:
                    x, y = (c, b) if chain == 'x' else (b, c)
                    if not _rect_ok(st, x, y, w, h, inst, gap, extra):
                        continue
                    geom_feasible = True
                    if prev is not None:
                        seam = _seam_for_records(prev, {'x': x, 'y': y, 'w': w, 'h': h},
                                                 chain, group, prev['state'], st, margin)
                        if seam['status'] == 'unknown':
                            seam_unknown = seam
                            continue
                        if not seam_qualified(seam, tol):
                            seam_bad = seam
                            continue
                    rec = {'uid': inst['uid'], 'inst': inst, 'state': st,
                           'x': x, 'y': y, 'w': w, 'h': h, 'rot': rot}
                    recs.append(rec)
                    extras.setdefault(id(st), []).append(rec)
                    placed_here = True
                    break
                if placed_here:
                    break
            if placed_here:
                break
            # 该板上的受阻原因
            if prev is not None and longitudinal and T <= EPS and \
                    (st['def'].get('grain') or 'none') != 'none':
                causes.add(
                    f"板材 {st['def']['sheetId']} #{st['def']['instance'] + 1} 未记录纹理重复周期，"
                    "沿纹理方向接缝相位无法核算")
            if seam_unknown is not None:
                causes.add(
                    f"跨板接缝相位无法核算（{seam_unknown['reason']}）："
                    f"{prev['state']['def']['sheetId']} #{prev['state']['def']['instance'] + 1}"
                    f" → {st['def']['sheetId']} #{st['def']['instance'] + 1}")
            if seam_bad is not None:
                causes.add(
                    f"接缝错花量 {seam_bad['offset']:g}mm 超过可接受值 {tol:g}mm（"
                    f"{prev['state']['def']['sheetId']} #{prev['state']['def']['instance'] + 1}"
                    f" → {st['def']['sheetId']} #{st['def']['instance'] + 1}）")
            if not geom_feasible:
                causes.add(
                    f"板材 {st['def']['sheetId']} #{st['def']['instance'] + 1} "
                    "剩余空间/锯缝间距/缺陷避让限制下无可行位置")
        if not placed_here:
            fail_idx = len(recs)
            fail_causes = list(causes)
            break

    if fail_idx is None and len(recs) == len(members):
        return {'ok': True, 'records': recs}

    # 原子失败：逐成员列明其在组内角色与触发的限制
    phase_failed = any(('相位' in c or '错花量' in c or '周期' in c) for c in fail_causes)
    for k, inst in enumerate(members):
        reasons = []
        if k < fail_idx:
            reasons.append('拼纹组未能整体落板：下游成员受阻（组为原子单位，已放置成员一并撤回）')
        elif not fail_causes:
            reasons.append('板材剩余空间、锯缝间距或缺陷避让限制下无法放置')
        else:
            reasons.extend(fail_causes)
        blockers[inst['uid']] = reasons
    return {'ok': False, 'blockers': blockers,
            'why': 'phase' if phase_failed else 'space'}


def _group_fail_reason(group, members, compatible, gap, margin):
    """同板失败时给出最贴切的限制说明。"""
    chain = 'x' if group['dir'] == 'h' else 'y'
    st = compatible[0]
    geoms = [_group_geom(i, st) for i in members]
    cross_size = max((g[1] if chain == 'x' else g[0]) for g in geoms)
    chain_len = sum((g[0] if chain == 'x' else g[1]) for g in geoms) \
        + (len(members) - 1) * max(gap, group['productGap'])
    U = st['uw'] if chain == 'x' else st['uh']
    V = st['uh'] if chain == 'x' else st['uw']
    gax = _grain_axis(st, chain)
    T = st['def'].get('grainPeriod', 0) or 0
    if chain_len > U + EPS or cross_size > V + EPS:
        return ('整组外形 %g×%g 超出板材可用区域 %g×%g'
                % (chain_len, cross_size, U, V))
    if gax == chain and T <= EPS and (st['def'].get('grain') or 'none') != 'none':
        return '原料板未记录纹理重复周期，无法保证沿纹理方向的错花量 ≤ %gmm' % group['tolerance']
    return ('整组无法在同一张板上同时满足同带次序、锯缝/间距与错花量 ≤ %gmm（含缺陷避让）'
            % group['tolerance'])


def _commit_group_records(records, group_id):
    """把拼纹组放置记录写入各板 placed（可用区域坐标）。"""
    for mi, r in enumerate(records):
        r['state']['placed'].append({
            'uid': r['uid'], 'partId': r['inst']['partId'], 'name': r['inst']['name'],
            'x': r['x'], 'y': r['y'], 'w': r['w'], 'h': r['h'],
            'rotated': r['rot'], 'locked': False,
            'groupId': group_id, 'memberIndex': mi,
        })


def _analyze_groups(layout_states, groups, group_ids_by_uid, margin):
    """对排样结果逐组逐缝评估（绝对坐标）。

    layout_states: pack 的 states（含 placed，可用区域坐标）。
    返回 (groups_out, placed_uid_sheet, group_status_by_id)。
    """
    # uid → (state_idx, placement 可用坐标)
    where = {}
    for si, st in enumerate(layout_states):
        for r in st['placed']:
            where[r['uid']] = (si, st, r)

    groups_out = []
    status_by_id = {}
    for g in groups:
        members_out = []
        seams_out = []
        prev_r = prev_st = None
        prev_uid = None
        placed_cnt = 0
        max_off = 0.0
        bad_seams, unknown_seams = 0, 0
        for mi, uid in enumerate(g['members']):
            hit = where.get(uid)
            if hit:
                si, st, r = hit
                placed_cnt += 1
                members_out.append({'uid': uid, 'sheetIndex': si,
                                    'sheetId': st['def']['sheetId'],
                                    'instance': st['def']['instance'],
                                    'memberIndex': mi})
                if prev_r is not None:
                    p_abs = {'x': prev_r['x'] + margin, 'y': prev_r['y'] + margin,
                             'w': prev_r['w'], 'h': prev_r['h']}
                    c_abs = {'x': r['x'] + margin, 'y': r['y'] + margin,
                             'w': r['w'], 'h': r['h']}
                    axis = 'x' if g['dir'] == 'h' else 'y'
                    seam = evaluate_seam(p_abs, c_abs, axis, g['productGap'],
                                         prev_st['def'], st['def'])
                    qualified = seam_qualified(seam, g['tolerance'])
                    if seam['status'] == 'unknown':
                        unknown_seams += 1
                    if not qualified:
                        bad_seams += 1
                    max_off = max(max_off, seam['offset'] if seam['status'] != 'unknown' else 0.0)
                    seams_out.append({
                        'from': prev_uid, 'to': uid,
                        'fromSheet': layout_states.index(prev_st),
                        'toSheet': si,
                        'offset': round(seam['offset'], 2),
                        'status': seam['status'],
                        'qualified': qualified,
                        'band': seam['band'],
                        'reason': seam['reason'],
                        'tolerance': g['tolerance'],
                    })
                prev_r, prev_st, prev_uid = r, st, uid
            else:
                members_out.append({'uid': uid, 'sheetIndex': None,
                                    'sheetId': None, 'instance': None,
                                    'memberIndex': mi})
                prev_r, prev_st, prev_uid = None, None, uid
        if placed_cnt == len(g['members']) and bad_seams == 0 and unknown_seams == 0:
            status = 'complete'
        elif placed_cnt == 0:
            status = 'failed'
        else:
            status = 'partial'
        status_by_id[g['id']] = status
        groups_out.append({
            'id': g['id'], 'dir': g['dir'],
            'productGap': g['productGap'], 'tolerance': g['tolerance'],
            'sameSheet': g['sameSheet'],
            'members': members_out, 'seams': seams_out,
            'status': status,
            'placedCount': placed_cnt, 'memberCount': len(g['members']),
            'maxOffset': round(max_off, 2),
            'badSeamCount': bad_seams, 'unknownSeamCount': unknown_seams,
        })
    return groups_out, where, status_by_id


def pack(part_insts, sheet_insts, settings, locked=None, sort_key=None, groups=None):
    """执行一次排样。locked: {板材实例序号字符串: [已锁定放置]}，这些放置保持不动。

    groups: 拼纹对花组（normalize_groups 后的列表）。组按原子单位优先于散件排样；
    组员次序、同带与纹理相位容差同板边/锯缝/方向/缺陷限制一并生效。
    """
    kerf = _f(settings.get('kerf'), 3)
    margin = _f(settings.get('margin'), 0)
    spacing = _f(settings.get('spacing'), 0)
    gap = kerf + spacing
    locked = locked or {}
    groups = groups or []

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

    insts_by_uid = {p['uid']: p for p in part_insts}
    group_ids_by_uid = group_member_map(groups)
    grouped_uids = set()
    for g in groups:
        grouped_uids.update(g['members'])

    # 1) 拼纹组原子排样（按成员总面积降序，大组优先）
    group_failures = {}   # uid → [原因]
    failed_group_ids = set()
    ordered_groups = sorted(
        groups,
        key=lambda g: -sum((insts_by_uid[u]['w'] * insts_by_uid[u]['h'])
                           for u in g['members'] if u in insts_by_uid))
    for g in ordered_groups:
        res = place_group(g, insts_by_uid, states, gap, margin)
        if res['ok']:
            _commit_group_records(res['records'], g['id'])
        else:
            failed_group_ids.add(g['id'])
            group_failures.update(res.get('blockers', {}))

    # 2) 散件 Bottom-Left first-fit（组成员失败则不再作为散件补位，整组保持未放置）
    pool = [p for p in part_insts
            if p['uid'] not in locked_uids and p['uid'] not in grouped_uids]
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

    # 拼纹组成员未放置：place_group 仅在整组成功时落板，失败组成员全部列入未放置
    for g in ordered_groups:
        if g['id'] in failed_group_ids:
            for uid in g['members']:
                inst = insts_by_uid.get(uid)
                if inst is not None:
                    unplaced.append(inst)

    # 合格性：已放置（含锁定）零件不得与任何缺陷冲突（锁定件可能压在缺陷上）
    def defects_abs(st):
        return st['def'].get('defects', [])

    conflict_rows = []   # 供未放置/锁定冲突提示：{uid, sheetIndex, defects:[label]}
    qualified = 0
    for si, st in enumerate(states):
        for r in st['placed']:
            inst = insts_by_uid.get(r['uid'])
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

    # 拼纹组接缝评估
    groups_out, _, status_by_id = _analyze_groups(states, groups, group_ids_by_uid, margin)
    complete_groups = sum(1 for go in groups_out if go['status'] == 'complete')
    max_seam_offset = max((go['maxOffset'] for go in groups_out), default=0.0)

    out_sheets = []
    for st in states:
        placements = [{
            'uid': r['uid'], 'partId': r['partId'], 'name': r.get('name'),
            'x': round(r['x'] + margin, 3), 'y': round(r['y'] + margin, 3),
            'w': r['w'], 'h': r['h'], 'rotated': r['rotated'],
            'locked': r.get('locked', False),
            'groupId': r.get('groupId'),
            'memberIndex': r.get('memberIndex'),
        } for r in st['placed']]
        # 每张已用板材自身的避让碎料（未使用板不计入方案比较）
        sheet_scrap = sum(expanded_defect_area(d, margin, st['uw'], st['uh'])
                          for d in defects_abs(st)) if st['placed'] else 0.0
        out_sheets.append({
            'sheetId': st['def']['sheetId'], 'name': st['def']['name'],
            'instance': st['def']['instance'],
            'width': st['def']['w'], 'height': st['def']['h'],
            'grain': st['def'].get('grain', 'none'),
            'grainPeriod': st['def'].get('grainPeriod', 0),
            'grainBase': st['def'].get('grainBase', {'x': 0, 'y': 0}),
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
        'groupTotal': len(groups),
        'groupComplete': complete_groups,
        'maxSeamOffset': round(max_seam_offset, 2),
    }
    unplaced_out = []
    for p in unplaced:
        if p['uid'] in group_failures:
            reasons = list(dict.fromkeys(group_failures[p['uid']]))
            unplaced_out.append({
                'uid': p['uid'], 'partId': p['partId'], 'name': p['name'],
                'reason': '；'.join(reasons), 'conflicts': [],
                'groupId': group_ids_by_uid.get(p['uid']),
                'groupBlocked': True,
            })
            continue
        reason = _unplaced_reason(p, states, settings)
        unplaced_out.append({
            'uid': p['uid'], 'partId': p['partId'], 'name': p['name'],
            'reason': reason['text'], 'conflicts': reason['conflicts'],
        })
    return {'sheets': out_sheets, 'unplaced': unplaced_out,
            'conflicts': conflict_rows, 'stats': stats,
            'grainGroups': groups_out}


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

    # 拼纹对花组：过滤掉实例已不存在的成员引用
    groups = normalize_groups(payload.get('grainGroups'))
    groups = [g for g in groups if all(u in valid_uids for u in g['members'])]

    results, seen = [], set()
    for label, key in STRATEGIES:
        res = pack(part_insts, sheet_insts, settings, locked, key, groups)
        sig = _signature(res)
        if sig in seen:
            continue
        seen.add(sig)
        results.append((label, res))

    # 排序优先级：完整落板的拼纹组多者优先 → 最大接缝偏差小者优先
    #   → 耗用板数少者优先 → 利用率高者优先
    #   → 未放置少者 → 合格零件多者 → 避让碎料少者 → 切割次数少者
    results.sort(key=lambda item: (-item[1]['stats']['groupComplete'],
                                   item[1]['stats']['maxSeamOffset'],
                                   item[1]['stats']['usedSheets'],
                                   -item[1]['stats']['utilization'],
                                   len(item[1]['unplaced']),
                                   -item[1]['stats']['qualifiedCount'],
                                   item[1]['stats']['defectScrap'],
                                   item[1]['stats']['cuts']))
    max_layouts = max(1, min(int(_f(max_layouts, 3)), 5))
    layouts = [{'id': i + 1, 'strategy': label, **res}
               for i, (label, res) in enumerate(results[:max_layouts])]
    return {'layouts': layouts}
