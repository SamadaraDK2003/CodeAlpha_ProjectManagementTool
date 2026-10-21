# CodeAlpha_ProjectManagementTool
Trello/Asana-style collaborative project manager (CodeAlpha Full Stack Internship – Task 3).

**Stack:** Node.js, Express, SQLite (built-in node:sqlite, needs Node 22.13+), Socket.io, JWT + bcrypt, vanilla HTML/CSS/JS.

## Features
- Register / login (JWT, hashed passwords)
- Create group projects, invite members by email
- Task cards on a To Do / In Progress / Done board (drag & drop)
- Assign tasks, edit, delete
- Comments inside each task
- Bonus: real-time board/comment updates and live notifications via WebSockets

## Run
```
npm install
npm start
```
Open http://localhost:3000 – register two users in two browsers to see real-time updates.
Set `JWT_SECRET` env var in production.

## API
POST /api/register, /api/login · GET/POST /api/projects · GET /api/projects/:id · POST /api/projects/:id/members ·
POST /api/projects/:id/tasks · PATCH/DELETE /api/tasks/:id · GET/POST /api/tasks/:id/comments · GET /api/notifications
