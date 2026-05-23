# Project Task Dashboard

A full-stack web app for creating projects, managing team roles, assigning tasks, and tracking progress from a dashboard.

## Features

- Authentication with signup and login
- Project creation and project-scoped team management
- Role-based access control:
  - `ADMIN`: manage project details, team members, roles, and all tasks
  - `MEMBER`: view assigned projects and update status for assigned tasks
- Task creation, assignment, status tracking, due dates, and overdue detection
- Dashboard metrics for projects, total tasks, assigned tasks, overdue work, and status counts
- REST API backed by a MongoDB database through Prisma

## Tech Stack

- Node.js + Express
- MongoDB + Prisma
- JWT authentication
- Bcrypt password hashing
- Zod validation
- Static HTML/CSS/JavaScript frontend served by Express
- Railway deployment config included

## Local Setup

1. Install dependencies.

   ```bash
   npm install
   ```

2. Copy the environment file and fill in your MongoDB connection string.

   ```bash
   cp .env.example .env
   ```

3. Push the schema to MongoDB.

   ```bash
   npm run db:push
   ```

4. Optional: seed demo users and a demo project.

   ```bash
   npm run db:seed
   ```

5. Start the app.

   ```bash
   npm run dev
   ```

6. Open `http://localhost:3000`.

Demo seed login:

- Admin: `admin@example.com` / `Password123!`
- Member: `member@example.com` / `Password123!`

## Railway Deployment

1. Push this repo to GitHub.
2. Create a new Railway project from the GitHub repo.
3. Add a Railway MongoDB service, or use a MongoDB Atlas connection string.
4. In the web service variables, set:
   - `DATABASE_URL` to the MongoDB connection string
   - `JWT_SECRET` to a long random secret
5. Deploy. Railway uses `railway.json`, which runs:

   ```bash
   npx prisma db push && node src/server.js
   ```

6. Open the generated Railway domain and create the first account. The first user is not global admin by default; any user who creates a project becomes that project's admin.

## REST API

Auth:

- `POST /api/auth/signup`
- `POST /api/auth/login`
- `GET /api/auth/me`

Users:

- `GET /api/users?q=search`

Dashboard:

- `GET /api/dashboard`

Projects:

- `GET /api/projects`
- `POST /api/projects`
- `GET /api/projects/:projectId`
- `PATCH /api/projects/:projectId` Admin only
- `DELETE /api/projects/:projectId` Admin only

Team:

- `POST /api/projects/:projectId/members` Admin only
- `PATCH /api/projects/:projectId/members/:userId` Admin only
- `DELETE /api/projects/:projectId/members/:userId` Admin only

Tasks:

- `POST /api/projects/:projectId/tasks` Admin only
- `PATCH /api/projects/:projectId/tasks/:taskId` Admin or assigned member
- `DELETE /api/projects/:projectId/tasks/:taskId` Admin only

All protected routes require:

```http
Authorization: Bearer <token>
```

## Submission Checklist

- Live URL: [Pending Railway Deployment]
- GitHub repo: https://github.com/ankitkumar9546/project-task-dashboard
- README: included ✅
- Demo video: [Pending Demo Video Recording]
