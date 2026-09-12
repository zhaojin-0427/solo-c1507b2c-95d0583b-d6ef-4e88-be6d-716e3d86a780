"""板材裁切排样台 — Flask 本地服务。

提供：
  GET  /                     主页面
  POST /api/nest             生成多个排样方案（可携带锁定放置）
  GET  /api/projects         项目列表
  POST /api/projects         保存 / 更新项目（SQLite）
  GET  /api/projects/<id>    读取项目
  DELETE /api/projects/<id>  删除项目
"""
import json
import os
import sqlite3
import time

from flask import Flask, jsonify, render_template, request

from nesting import generate_layouts

app = Flask(__name__)
BASE_DIR = os.path.dirname(os.path.abspath(__file__))
DB_PATH = os.path.join(BASE_DIR, 'data', 'projects.db')

SCHEMA = """
CREATE TABLE IF NOT EXISTS projects (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  name       TEXT NOT NULL,
  data       TEXT NOT NULL,
  updated_at REAL NOT NULL
);
"""


def db():
    os.makedirs(os.path.dirname(DB_PATH), exist_ok=True)
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    return conn


def init_db():
    with db() as conn:
        conn.execute(SCHEMA)


init_db()


@app.route('/')
def index():
    return render_template('index.html')


@app.post('/api/nest')
def api_nest():
    payload = request.get_json(force=True, silent=True) or {}
    try:
        result = generate_layouts(payload, max_layouts=payload.get('maxLayouts', 3))
    except Exception as exc:  # 输入异常时给出可读信息而不是 500
        return jsonify({'error': f'排样失败：{exc}'}), 400
    status = 400 if result.get('error') else 200
    return jsonify(result), status


@app.get('/api/projects')
def list_projects():
    with db() as conn:
        rows = conn.execute(
            'SELECT id, name, updated_at FROM projects ORDER BY updated_at DESC').fetchall()
    return jsonify([dict(r) for r in rows])


@app.post('/api/projects')
def save_project():
    body = request.get_json(force=True, silent=True) or {}
    name = (body.get('name') or '').strip() or '未命名项目'
    data = json.dumps(body.get('data') or {}, ensure_ascii=False)
    now = time.time()
    with db() as conn:
        pid = body.get('id')
        if pid:
            cur = conn.execute(
                'UPDATE projects SET name=?, data=?, updated_at=? WHERE id=?',
                (name, data, now, pid))
            if cur.rowcount == 0:  # id 不存在则按新建处理
                cur = conn.execute(
                    'INSERT INTO projects (name, data, updated_at) VALUES (?,?,?)',
                    (name, data, now))
                pid = cur.lastrowid
        else:
            cur = conn.execute(
                'INSERT INTO projects (name, data, updated_at) VALUES (?,?,?)',
                (name, data, now))
            pid = cur.lastrowid
    return jsonify({'id': pid, 'name': name, 'updated_at': now})


@app.get('/api/projects/<int:pid>')
def load_project(pid):
    with db() as conn:
        row = conn.execute('SELECT * FROM projects WHERE id=?', (pid,)).fetchone()
    if not row:
        return jsonify({'error': '项目不存在'}), 404
    return jsonify({'id': row['id'], 'name': row['name'],
                    'updated_at': row['updated_at'],
                    'data': json.loads(row['data'])})


@app.delete('/api/projects/<int:pid>')
def delete_project(pid):
    with db() as conn:
        conn.execute('DELETE FROM projects WHERE id=?', (pid,))
    return jsonify({'ok': True})


if __name__ == '__main__':
    app.run(host='127.0.0.1', port=5000, debug=False)
