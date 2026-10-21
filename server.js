const express = require('express'), http = require('http'), { Server } = require('socket.io');
const { DatabaseSync } = require('node:sqlite'), bcrypt = require('bcryptjs'), jwt = require('jsonwebtoken');
const SECRET = process.env.JWT_SECRET || 'dev-secret-change-me';
const db = new DatabaseSync('data.db');
db.exec(`
CREATE TABLE IF NOT EXISTS users(id INTEGER PRIMARY KEY, name TEXT, email TEXT UNIQUE, password TEXT);
CREATE TABLE IF NOT EXISTS projects(id INTEGER PRIMARY KEY, name TEXT, owner_id INTEGER);
CREATE TABLE IF NOT EXISTS members(project_id INTEGER, user_id INTEGER, PRIMARY KEY(project_id,user_id));
CREATE TABLE IF NOT EXISTS tasks(id INTEGER PRIMARY KEY, project_id INTEGER, title TEXT, description TEXT DEFAULT '',
  status TEXT DEFAULT 'todo', assignee_id INTEGER, created_at TEXT DEFAULT CURRENT_TIMESTAMP);
CREATE TABLE IF NOT EXISTS comments(id INTEGER PRIMARY KEY, task_id INTEGER, user_id INTEGER, body TEXT, created_at TEXT DEFAULT CURRENT_TIMESTAMP);
CREATE TABLE IF NOT EXISTS notifications(id INTEGER PRIMARY KEY, user_id INTEGER, text TEXT, is_read INTEGER DEFAULT 0, created_at TEXT DEFAULT CURRENT_TIMESTAMP);
`);
const app = express(), server = http.createServer(app), io = new Server(server);
app.use(express.json()); app.use(express.static('public'));

const sign = u => jwt.sign({ id: u.id, name: u.name }, SECRET, { expiresIn: '7d' });
const auth = (req, res, next) => {
  try { req.user = jwt.verify((req.headers.authorization || '').replace('Bearer ', ''), SECRET); next(); }
  catch { res.status(401).json({ error: 'Unauthorized' }); }
};
const isMember = (pid, uid) => !!db.prepare('SELECT 1 FROM members WHERE project_id=? AND user_id=?').get(pid, uid);
const notify = (uid, text) => { db.prepare('INSERT INTO notifications(user_id,text) VALUES(?,?)').run(uid, text); io.to('user:' + uid).emit('notification', { text }); };
const changed = pid => io.to('project:' + pid).emit('project:changed', { projectId: +pid });

// ---- Auth
app.post('/api/register', (req, res) => {
  const { name, email, password } = req.body;
  if (!name || !email || !password || password.length < 6) return res.status(400).json({ error: 'Name, email and password (min 6 chars) required' });
  try {
    const r = db.prepare('INSERT INTO users(name,email,password) VALUES(?,?,?)').run(name, email.toLowerCase(), bcrypt.hashSync(password, 10));
    const u = { id: r.lastInsertRowid, name }; res.json({ token: sign(u), user: u });
  } catch { res.status(400).json({ error: 'Email already registered' }); }
});
app.post('/api/login', (req, res) => {
  const u = db.prepare('SELECT * FROM users WHERE email=?').get((req.body.email || '').toLowerCase());
  if (!u || !bcrypt.compareSync(req.body.password || '', u.password)) return res.status(400).json({ error: 'Invalid credentials' });
  res.json({ token: sign(u), user: { id: u.id, name: u.name } });
});

// ---- Projects
app.get('/api/projects', auth, (req, res) => res.json(db.prepare(
  'SELECT p.* FROM projects p JOIN members m ON m.project_id=p.id WHERE m.user_id=? ORDER BY p.id DESC').all(req.user.id)));
app.post('/api/projects', auth, (req, res) => {
  if (!req.body.name) return res.status(400).json({ error: 'Name required' });
  const r = db.prepare('INSERT INTO projects(name,owner_id) VALUES(?,?)').run(req.body.name, req.user.id);
  db.prepare('INSERT INTO members VALUES(?,?)').run(r.lastInsertRowid, req.user.id);
  res.json({ id: r.lastInsertRowid, name: req.body.name });
});
app.get('/api/projects/:id', auth, (req, res) => {
  const pid = +req.params.id; if (!isMember(pid, req.user.id)) return res.status(403).json({ error: 'Not a member' });
  res.json({
    project: db.prepare('SELECT * FROM projects WHERE id=?').get(pid),
    members: db.prepare('SELECT u.id,u.name,u.email FROM users u JOIN members m ON m.user_id=u.id WHERE m.project_id=?').all(pid),
    tasks: db.prepare(`SELECT t.*, u.name AS assignee_name, (SELECT COUNT(*) FROM comments c WHERE c.task_id=t.id) AS comment_count
      FROM tasks t LEFT JOIN users u ON u.id=t.assignee_id WHERE t.project_id=? ORDER BY t.id`).all(pid)
  });
});
app.post('/api/projects/:id/members', auth, (req, res) => {
  const pid = +req.params.id; if (!isMember(pid, req.user.id)) return res.status(403).json({ error: 'Not a member' });
  const u = db.prepare('SELECT id FROM users WHERE email=?').get((req.body.email || '').toLowerCase());
  if (!u) return res.status(404).json({ error: 'No user with that email' });
  db.prepare('INSERT OR IGNORE INTO members VALUES(?,?)').run(pid, u.id);
  const p = db.prepare('SELECT name FROM projects WHERE id=?').get(pid);
  notify(u.id, `${req.user.name} added you to project "${p.name}"`); changed(pid); res.json({ ok: true });
});

// ---- Tasks
app.post('/api/projects/:id/tasks', auth, (req, res) => {
  const pid = +req.params.id; if (!isMember(pid, req.user.id)) return res.status(403).json({ error: 'Not a member' });
  const { title, description = '', assignee_id = null } = req.body; if (!title) return res.status(400).json({ error: 'Title required' });
  if (assignee_id && !isMember(pid, assignee_id)) return res.status(400).json({ error: 'Assignee must be a member' });
  const r = db.prepare('INSERT INTO tasks(project_id,title,description,assignee_id) VALUES(?,?,?,?)').run(pid, title, description, assignee_id);
  if (assignee_id && assignee_id !== req.user.id) notify(assignee_id, `${req.user.name} assigned you "${title}"`);
  changed(pid); res.json({ id: r.lastInsertRowid });
});
app.patch('/api/tasks/:id', auth, (req, res) => {
  const t = db.prepare('SELECT * FROM tasks WHERE id=?').get(req.params.id);
  if (!t || !isMember(t.project_id, req.user.id)) return res.status(403).json({ error: 'Forbidden' });
  const n = { ...t, ...req.body };
  if (!['todo', 'doing', 'done'].includes(n.status)) return res.status(400).json({ error: 'Bad status' });
  if (n.assignee_id && !isMember(t.project_id, n.assignee_id)) return res.status(400).json({ error: 'Assignee must be a member' });
  db.prepare('UPDATE tasks SET title=?,description=?,status=?,assignee_id=? WHERE id=?').run(n.title, n.description, n.status, n.assignee_id || null, t.id);
  if (n.assignee_id && n.assignee_id !== t.assignee_id && n.assignee_id !== req.user.id) notify(n.assignee_id, `${req.user.name} assigned you "${n.title}"`);
  changed(t.project_id); res.json({ ok: true });
});
app.delete('/api/tasks/:id', auth, (req, res) => {
  const t = db.prepare('SELECT * FROM tasks WHERE id=?').get(req.params.id);
  if (!t || !isMember(t.project_id, req.user.id)) return res.status(403).json({ error: 'Forbidden' });
  db.prepare('DELETE FROM comments WHERE task_id=?').run(t.id); db.prepare('DELETE FROM tasks WHERE id=?').run(t.id);
  changed(t.project_id); res.json({ ok: true });
});

// ---- Comments
app.get('/api/tasks/:id/comments', auth, (req, res) => {
  const t = db.prepare('SELECT * FROM tasks WHERE id=?').get(req.params.id);
  if (!t || !isMember(t.project_id, req.user.id)) return res.status(403).json({ error: 'Forbidden' });
  res.json(db.prepare('SELECT c.*, u.name FROM comments c JOIN users u ON u.id=c.user_id WHERE task_id=? ORDER BY c.id').all(t.id));
});
app.post('/api/tasks/:id/comments', auth, (req, res) => {
  const t = db.prepare('SELECT * FROM tasks WHERE id=?').get(req.params.id);
  if (!t || !isMember(t.project_id, req.user.id)) return res.status(403).json({ error: 'Forbidden' });
  if (!req.body.body) return res.status(400).json({ error: 'Empty comment' });
  db.prepare('INSERT INTO comments(task_id,user_id,body) VALUES(?,?,?)').run(t.id, req.user.id, req.body.body);
  if (t.assignee_id && t.assignee_id !== req.user.id) notify(t.assignee_id, `${req.user.name} commented on "${t.title}"`);
  io.to('project:' + t.project_id).emit('comment:new', { taskId: t.id }); changed(t.project_id); res.json({ ok: true });
});

// ---- Notifications
app.get('/api/notifications', auth, (req, res) => res.json(db.prepare('SELECT * FROM notifications WHERE user_id=? ORDER BY id DESC LIMIT 30').all(req.user.id)));
app.post('/api/notifications/read', auth, (req, res) => { db.prepare('UPDATE notifications SET is_read=1 WHERE user_id=?').run(req.user.id); res.json({ ok: true }); });

// ---- WebSockets
io.use((s, next) => { try { s.user = jwt.verify(s.handshake.auth.token, SECRET); next(); } catch { next(new Error('auth')); } });
io.on('connection', s => {
  s.join('user:' + s.user.id);
  s.on('join', pid => { if (isMember(+pid, s.user.id)) { s.rooms.forEach(r => r.startsWith('project:') && s.leave(r)); s.join('project:' + pid); } });
});
server.listen(process.env.PORT || 3000, () => console.log('Running on http://localhost:' + (process.env.PORT || 3000)));
