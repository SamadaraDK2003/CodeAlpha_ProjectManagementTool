const $ = id => document.getElementById(id);
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
let token = localStorage.getItem('token'), me = JSON.parse(localStorage.getItem('me') || 'null'), socket, current = null, data = null, openTask = null, registering = false;
const COLS = [['todo', 'To Do'], ['doing', 'In Progress'], ['done', 'Done']];

async function api(path, method = 'GET', body) {
  const r = await fetch('/api' + path, { method, headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token }, body: body && JSON.stringify(body) });
  const j = await r.json().catch(() => ({})); if (!r.ok) throw new Error(j.error || 'Request failed'); return j;
}
function toast(t) { $('toast').textContent = t; $('toast').classList.remove('hide'); setTimeout(() => $('toast').classList.add('hide'), 3500); }

// ---- Auth
$('toggle').onclick = e => { e.preventDefault(); registering = !registering; $('name').classList.toggle('hide', !registering);
  $('authBtn').textContent = registering ? 'Register' : 'Log in'; $('toggle').textContent = registering ? 'Have an account? Log in' : 'Need an account? Register'; };
$('authBtn').onclick = async () => {
  try {
    const r = await api(registering ? '/register' : '/login', 'POST', { name: $('name').value, email: $('email').value, password: $('password').value });
    token = r.token; me = r.user; localStorage.setItem('token', token); localStorage.setItem('me', JSON.stringify(me)); start();
  } catch (e) { $('authErr').textContent = e.message; }
};
$('logout').onclick = () => { localStorage.clear(); location.reload(); };

// ---- Start
function start() {
  $('auth').classList.add('hide'); $('app').classList.remove('hide'); $('me').textContent = me.name;
  socket = io({ auth: { token } });
  socket.on('project:changed', ({ projectId }) => { if (current === projectId) loadProject(); });
  socket.on('comment:new', ({ taskId }) => { if (openTask === taskId) loadComments(); });
  socket.on('notification', n => { toast('🔔 ' + n.text); loadNotifs(); });
  loadProjects(); loadNotifs();
}
async function loadProjects() {
  const ps = await api('/projects');
  $('projects').innerHTML = ps.map(p => `<div class="proj ${p.id === current ? 'active' : ''}" data-id="${p.id}">${esc(p.name)}</div>`).join('') || '<p class="muted">No projects yet</p>';
  document.querySelectorAll('.proj').forEach(el => el.onclick = () => { current = +el.dataset.id; socket.emit('join', current); loadProject(); loadProjects(); });
}
$('addProject').onclick = async () => { if (!$('newProject').value) return; const p = await api('/projects', 'POST', { name: $('newProject').value });
  $('newProject').value = ''; current = p.id; socket.emit('join', current); loadProjects(); loadProject(); };

// ---- Board
async function loadProject() {
  data = await api('/projects/' + current); $('projTitle').textContent = '/ ' + data.project.name;
  $('main').innerHTML = `<div class="members">${data.members.map(m => `<span class="chip">👤 ${esc(m.name)}</span>`).join('')}
    <input id="inviteEmail" placeholder="Invite by email" style="width:200px;margin:0"><button id="invite">Invite</button></div>
    <div class="row"><input id="taskTitle" placeholder="New task title"><select id="taskAssignee" style="width:160px;margin:0"><option value="">Unassigned</option>
    ${data.members.map(m => `<option value="${m.id}">${esc(m.name)}</option>`).join('')}</select><button id="addTask">Add task</button></div>
    <div class="board">${COLS.map(([k, label]) => `<div class="col" data-status="${k}"><h4>${label} (${data.tasks.filter(t => t.status === k).length})</h4>
    ${data.tasks.filter(t => t.status === k).map(t => `<div class="task" draggable="true" data-id="${t.id}"><b>${esc(t.title)}</b><br>
    <small>${t.assignee_name ? '👤 ' + esc(t.assignee_name) : 'Unassigned'} · 💬 ${t.comment_count}</small></div>`).join('')}</div>`).join('')}</div>`;
  $('invite').onclick = async () => { try { await api(`/projects/${current}/members`, 'POST', { email: $('inviteEmail').value }); } catch (e) { alert(e.message); } };
  $('addTask').onclick = async () => { if (!$('taskTitle').value) return;
    await api(`/projects/${current}/tasks`, 'POST', { title: $('taskTitle').value, assignee_id: +$('taskAssignee').value || null }); };
  document.querySelectorAll('.task').forEach(el => {
    el.ondragstart = e => e.dataTransfer.setData('id', el.dataset.id); el.onclick = () => showTask(+el.dataset.id); });
  document.querySelectorAll('.col').forEach(c => {
    c.ondragover = e => { e.preventDefault(); c.classList.add('over'); }; c.ondragleave = () => c.classList.remove('over');
    c.ondrop = async e => { e.preventDefault(); await api('/tasks/' + e.dataTransfer.getData('id'), 'PATCH', { status: c.dataset.status }); }; });
}

// ---- Task modal + comments
function showTask(id) {
  openTask = id; const t = data.tasks.find(x => x.id === id);
  $('modalBody').innerHTML = `<h3>Task</h3><input id="mTitle" value="${esc(t.title)}"><textarea id="mDesc" rows="3" placeholder="Description">${esc(t.description)}</textarea>
    <select id="mAssignee"><option value="">Unassigned</option>${data.members.map(m => `<option value="${m.id}" ${m.id === t.assignee_id ? 'selected' : ''}>${esc(m.name)}</option>`).join('')}</select>
    <select id="mStatus">${COLS.map(([k, l]) => `<option value="${k}" ${k === t.status ? 'selected' : ''}>${l}</option>`).join('')}</select>
    <div class="row"><button id="mSave">Save</button><button class="ghost" id="mDel">Delete</button></div><h4>Comments</h4><div id="cmts"></div>
    <div class="row"><input id="cmtBody" placeholder="Write a comment…"><button id="cmtSend">Send</button></div>`;
  $('modal').classList.remove('hide'); loadComments();
  $('mSave').onclick = async () => { await api('/tasks/' + id, 'PATCH', { title: $('mTitle').value, description: $('mDesc').value, assignee_id: +$('mAssignee').value || null, status: $('mStatus').value }); closeModal(); };
  $('mDel').onclick = async () => { if (confirm('Delete this task?')) { await api('/tasks/' + id, 'DELETE'); closeModal(); } };
  $('cmtSend').onclick = async () => { if (!$('cmtBody').value) return; await api(`/tasks/${id}/comments`, 'POST', { body: $('cmtBody').value }); $('cmtBody').value = ''; };
}
async function loadComments() {
  const cs = await api(`/tasks/${openTask}/comments`);
  $('cmts').innerHTML = cs.map(c => `<div class="cmt"><b>${esc(c.name)}</b> <small class="muted">${esc(c.created_at)}</small><br>${esc(c.body)}</div>`).join('') || '<p class="muted">No comments yet.</p>';
}
function closeModal() { $('modal').classList.add('hide'); openTask = null; }
$('closeModal').onclick = closeModal;

// ---- Notifications
async function loadNotifs() {
  const ns = await api('/notifications'), unread = ns.filter(n => !n.is_read).length;
  $('badge').textContent = unread; $('badge').classList.toggle('hide', !unread);
  $('notifs').innerHTML = ns.map(n => `<div>${esc(n.text)}</div>`).join('') || '<div class="muted">Nothing yet</div>';
}
$('bell').onclick = async () => { $('notifs').classList.toggle('hide'); await api('/notifications/read', 'POST'); setTimeout(loadNotifs, 300); };

if (token && me) start();
