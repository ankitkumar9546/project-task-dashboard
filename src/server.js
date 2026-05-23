require("dotenv").config();

const path = require("path");
const bcrypt = require("bcryptjs");
const cors = require("cors");
const express = require("express");
const helmet = require("helmet");
const jwt = require("jsonwebtoken");
const rateLimit = require("express-rate-limit");
const { Prisma, PrismaClient } = require("@prisma/client");
const { z } = require("zod");

const prisma = new PrismaClient();
const app = express();
const port = process.env.PORT || 3000;

if (process.env.NODE_ENV === "production" && !process.env.JWT_SECRET) {
  console.error("JWT_SECRET is required in production.");
  process.exit(1);
}

const jwtSecret = process.env.JWT_SECRET || "local-development-secret-change-me";
const userSelect = { id: true, name: true, email: true, createdAt: true };
const taskStatuses = ["TODO", "IN_PROGRESS", "DONE", "BLOCKED"];

app.set("trust proxy", 1);
app.use(
  helmet({
    contentSecurityPolicy: {
      directives: {
        ...helmet.contentSecurityPolicy.getDefaultDirectives(),
        "script-src": ["'self'"],
        "style-src": ["'self'", "'unsafe-inline'", "https:"],
        "img-src": ["'self'", "data:"]
      }
    }
  })
);
app.use(cors());
app.use(express.json({ limit: "1mb" }));
app.use(
  "/api",
  rateLimit({
    windowMs: 15 * 60 * 1000,
    limit: 600,
    standardHeaders: "draft-7",
    legacyHeaders: false
  })
);

const signupSchema = z.object({
  name: z.string().trim().min(2, "Name must be at least 2 characters.").max(80),
  email: z.string().trim().email().max(255).transform((value) => value.toLowerCase()),
  password: z.string().min(8, "Password must be at least 8 characters.").max(128)
});

const loginSchema = z.object({
  email: z.string().trim().email().max(255).transform((value) => value.toLowerCase()),
  password: z.string().min(1)
});

const projectSchema = z.object({
  name: z.string().trim().min(2).max(120),
  description: z.string().trim().max(1000).optional().nullable()
});

const memberSchema = z.object({
  email: z.string().trim().email().max(255).transform((value) => value.toLowerCase()),
  role: z.enum(["ADMIN", "MEMBER"]).default("MEMBER")
});

const roleSchema = z.object({
  role: z.enum(["ADMIN", "MEMBER"])
});

const taskCreateSchema = z.object({
  title: z.string().trim().min(2).max(160),
  description: z.string().trim().max(1000).optional().nullable(),
  assigneeId: z.string().trim().optional().nullable(),
  dueDate: z.string().trim().optional().nullable(),
  status: z.enum(taskStatuses).default("TODO")
});

const taskPatchSchema = taskCreateSchema.partial();

function asyncHandler(handler) {
  return (req, res, next) => Promise.resolve(handler(req, res, next)).catch(next);
}

function validate(schema, data) {
  const parsed = schema.safeParse(data);
  if (!parsed.success) {
    const message = parsed.error.issues.map((issue) => issue.message).join(" ");
    throw httpError(400, message || "Invalid request.");
  }

  return parsed.data;
}

function httpError(status, message) {
  const error = new Error(message);
  error.status = status;
  return error;
}

function signToken(user) {
  return jwt.sign({ sub: user.id, email: user.email, name: user.name }, jwtSecret, { expiresIn: "7d" });
}

function authPayload(user) {
  return {
    token: signToken(user),
    user: {
      id: user.id,
      name: user.name,
      email: user.email,
      createdAt: user.createdAt
    }
  };
}

function parseDueDate(value) {
  if (value === undefined || value === null || value === "") {
    return null;
  }

  const normalized = /^\d{4}-\d{2}-\d{2}$/.test(value) ? `${value}T23:59:59.000Z` : value;
  const date = new Date(normalized);

  if (Number.isNaN(date.getTime())) {
    throw httpError(400, "Due date is invalid.");
  }

  return date;
}

async function requireAuth(req, res, next) {
  try {
    const header = req.headers.authorization || "";
    const token = header.startsWith("Bearer ") ? header.slice(7) : "";

    if (!token) {
      throw httpError(401, "Authentication required.");
    }

    const payload = jwt.verify(token, jwtSecret);
    const user = await prisma.user.findUnique({
      where: { id: payload.sub },
      select: userSelect
    });

    if (!user) {
      throw httpError(401, "Authentication required.");
    }

    req.user = user;
    next();
  } catch (error) {
    next(error.status ? error : httpError(401, "Invalid or expired session."));
  }
}

async function requireProjectMember(req, res, next) {
  try {
    const projectId = req.params.projectId || req.params.id;
    const membership = await prisma.projectMember.findUnique({
      where: { projectId_userId: { projectId, userId: req.user.id } },
      include: { project: true }
    });

    if (!membership) {
      throw httpError(403, "You do not have access to this project.");
    }

    req.project = membership.project;
    req.projectRole = membership.role;
    next();
  } catch (error) {
    next(error);
  }
}

function requireProjectAdmin(req, _res, next) {
  if (req.projectRole !== "ADMIN") {
    next(httpError(403, "Admin access is required for this action."));
    return;
  }

  next();
}

async function assertUserIsProjectMember(projectId, userId) {
  if (!userId) {
    return;
  }

  const membership = await prisma.projectMember.findUnique({
    where: { projectId_userId: { projectId, userId } }
  });

  if (!membership) {
    throw httpError(400, "Assignee must be a member of the project.");
  }
}

function projectSummary(project, currentUserId) {
  const currentMembership = project.members.find((member) => member.userId === currentUserId);
  const now = new Date();
  const openTasks = project.tasks.filter((task) => task.status !== "DONE");
  const overdueTasks = openTasks.filter((task) => task.dueDate && task.dueDate < now);

  return {
    id: project.id,
    name: project.name,
    description: project.description,
    role: currentMembership ? currentMembership.role : "MEMBER",
    memberCount: project.members.length,
    taskCount: project.tasks.length,
    openTaskCount: openTasks.length,
    overdueTaskCount: overdueTasks.length,
    createdAt: project.createdAt,
    updatedAt: project.updatedAt
  };
}

function serializeProject(project, currentUserId, role) {
  return {
    id: project.id,
    name: project.name,
    description: project.description,
    role,
    owner: project.owner,
    createdAt: project.createdAt,
    updatedAt: project.updatedAt,
    members: project.members.map((member) => ({
      id: member.id,
      role: member.role,
      userId: member.userId,
      createdAt: member.createdAt,
      user: member.user
    })),
    tasks: project.tasks.map((task) => serializeTask(task, currentUserId, role))
  };
}

function serializeTask(task, currentUserId, role) {
  return {
    id: task.id,
    title: task.title,
    description: task.description,
    status: task.status,
    dueDate: task.dueDate,
    projectId: task.projectId,
    assigneeId: task.assigneeId,
    assignee: task.assignee,
    createdAt: task.createdAt,
    updatedAt: task.updatedAt,
    canUpdate: role === "ADMIN" || task.assigneeId === currentUserId
  };
}

async function loadProjectDetail(projectId, currentUserId, role) {
  const project = await prisma.project.findUnique({
    where: { id: projectId },
    include: {
      owner: { select: userSelect },
      members: {
        orderBy: [{ role: "asc" }, { createdAt: "asc" }],
        include: { user: { select: userSelect } }
      },
      tasks: {
        orderBy: [{ status: "asc" }, { dueDate: "asc" }, { createdAt: "desc" }],
        include: { assignee: { select: userSelect } }
      }
    }
  });

  if (!project) {
    throw httpError(404, "Project not found.");
  }

  return serializeProject(project, currentUserId, role);
}

app.get("/api/health", (_req, res) => {
  res.json({ ok: true, service: "project-task-dashboard" });
});

app.post(
  "/api/auth/signup",
  asyncHandler(async (req, res) => {
    const data = validate(signupSchema, req.body);
    const existing = await prisma.user.findUnique({ where: { email: data.email } });

    if (existing) {
      throw httpError(409, "An account already exists for this email.");
    }

    const passwordHash = await bcrypt.hash(data.password, 12);
    const user = await prisma.user.create({
      data: {
        name: data.name,
        email: data.email,
        passwordHash
      },
      select: userSelect
    });

    res.status(201).json(authPayload(user));
  })
);

app.post(
  "/api/auth/login",
  asyncHandler(async (req, res) => {
    const data = validate(loginSchema, req.body);
    const user = await prisma.user.findUnique({ where: { email: data.email } });

    if (!user) {
      throw httpError(401, "Invalid email or password.");
    }

    const passwordMatches = await bcrypt.compare(data.password, user.passwordHash);

    if (!passwordMatches) {
      throw httpError(401, "Invalid email or password.");
    }

    res.json(authPayload(user));
  })
);

app.get("/api/auth/me", requireAuth, (req, res) => {
  res.json({ user: req.user });
});

app.get(
  "/api/users",
  requireAuth,
  asyncHandler(async (req, res) => {
    const query = String(req.query.q || "").trim();

    if (query.length < 2) {
      res.json({ users: [] });
      return;
    }

    const users = await prisma.user.findMany({
      where: {
        OR: [
          { email: { contains: query, mode: "insensitive" } },
          { name: { contains: query, mode: "insensitive" } }
        ]
      },
      select: userSelect,
      orderBy: { name: "asc" },
      take: 10
    });

    res.json({ users });
  })
);

app.get(
  "/api/dashboard",
  requireAuth,
  asyncHandler(async (req, res) => {
    const memberships = await prisma.projectMember.findMany({
      where: { userId: req.user.id },
      include: { project: true }
    });
    const projectIds = memberships.map((membership) => membership.projectId);
    const tasks = await prisma.task.findMany({
      where: { projectId: { in: projectIds } },
      include: {
        project: { select: { id: true, name: true } },
        assignee: { select: userSelect }
      },
      orderBy: [{ dueDate: "asc" }, { createdAt: "desc" }]
    });

    const now = new Date();
    const statusCounts = taskStatuses.reduce((counts, status) => ({ ...counts, [status]: 0 }), {});
    tasks.forEach((task) => {
      statusCounts[task.status] += 1;
    });

    const myTasks = tasks.filter((task) => task.assigneeId === req.user.id);
    const overdueTasks = tasks.filter((task) => task.status !== "DONE" && task.dueDate && task.dueDate < now);

    res.json({
      stats: {
        projectCount: memberships.length,
        totalTasks: tasks.length,
        assignedToMe: myTasks.length,
        overdueTasks: overdueTasks.length,
        statusCounts
      },
      myTasks: myTasks.slice(0, 8).map((task) => ({
        ...task,
        canUpdate: true
      })),
      overdueTasks: overdueTasks.slice(0, 8)
    });
  })
);

app.get(
  "/api/projects",
  requireAuth,
  asyncHandler(async (req, res) => {
    const projects = await prisma.project.findMany({
      where: { members: { some: { userId: req.user.id } } },
      include: {
        owner: { select: userSelect },
        members: { include: { user: { select: userSelect } } },
        tasks: { select: { id: true, status: true, dueDate: true, assigneeId: true } }
      },
      orderBy: { updatedAt: "desc" }
    });

    res.json({ projects: projects.map((project) => projectSummary(project, req.user.id)) });
  })
);

app.post(
  "/api/projects",
  requireAuth,
  asyncHandler(async (req, res) => {
    const data = validate(projectSchema, req.body);
    const project = await prisma.project.create({
      data: {
        name: data.name,
        description: data.description || null,
        ownerId: req.user.id,
        members: {
          create: {
            userId: req.user.id,
            role: "ADMIN"
          }
        }
      }
    });

    const detail = await loadProjectDetail(project.id, req.user.id, "ADMIN");
    res.status(201).json({ project: detail });
  })
);

app.get(
  "/api/projects/:projectId",
  requireAuth,
  requireProjectMember,
  asyncHandler(async (req, res) => {
    const project = await loadProjectDetail(req.params.projectId, req.user.id, req.projectRole);
    res.json({ project });
  })
);

app.patch(
  "/api/projects/:projectId",
  requireAuth,
  requireProjectMember,
  requireProjectAdmin,
  asyncHandler(async (req, res) => {
    const data = validate(projectSchema.partial(), req.body);

    if (!Object.keys(data).length) {
      throw httpError(400, "Provide at least one field to update.");
    }

    await prisma.project.update({
      where: { id: req.params.projectId },
      data: {
        ...(data.name !== undefined ? { name: data.name } : {}),
        ...(data.description !== undefined ? { description: data.description || null } : {})
      }
    });

    const project = await loadProjectDetail(req.params.projectId, req.user.id, req.projectRole);
    res.json({ project });
  })
);

app.delete(
  "/api/projects/:projectId",
  requireAuth,
  requireProjectMember,
  requireProjectAdmin,
  asyncHandler(async (req, res) => {
    await prisma.project.delete({ where: { id: req.params.projectId } });
    res.status(204).send();
  })
);

app.post(
  "/api/projects/:projectId/members",
  requireAuth,
  requireProjectMember,
  requireProjectAdmin,
  asyncHandler(async (req, res) => {
    const data = validate(memberSchema, req.body);
    const user = await prisma.user.findUnique({ where: { email: data.email }, select: userSelect });

    if (!user) {
      throw httpError(404, "User must sign up before they can be added to a project.");
    }

    const role = user.id === req.project.ownerId ? "ADMIN" : data.role;

    await prisma.projectMember.upsert({
      where: { projectId_userId: { projectId: req.params.projectId, userId: user.id } },
      update: { role },
      create: {
        projectId: req.params.projectId,
        userId: user.id,
        role
      }
    });

    const project = await loadProjectDetail(req.params.projectId, req.user.id, req.projectRole);
    res.status(201).json({ project });
  })
);

app.patch(
  "/api/projects/:projectId/members/:userId",
  requireAuth,
  requireProjectMember,
  requireProjectAdmin,
  asyncHandler(async (req, res) => {
    const data = validate(roleSchema, req.body);

    if (req.params.userId === req.project.ownerId && data.role !== "ADMIN") {
      throw httpError(400, "Project owner must remain an admin.");
    }

    const member = await prisma.projectMember.findUnique({
      where: { projectId_userId: { projectId: req.params.projectId, userId: req.params.userId } }
    });

    if (!member) {
      throw httpError(404, "Project member not found.");
    }

    if (member.role === "ADMIN" && data.role === "MEMBER") {
      const adminCount = await prisma.projectMember.count({
        where: { projectId: req.params.projectId, role: "ADMIN" }
      });

      if (adminCount <= 1) {
        throw httpError(400, "At least one project admin is required.");
      }
    }

    await prisma.projectMember.update({
      where: { projectId_userId: { projectId: req.params.projectId, userId: req.params.userId } },
      data: { role: data.role }
    });

    const project = await loadProjectDetail(req.params.projectId, req.user.id, req.projectRole);
    res.json({ project });
  })
);

app.delete(
  "/api/projects/:projectId/members/:userId",
  requireAuth,
  requireProjectMember,
  requireProjectAdmin,
  asyncHandler(async (req, res) => {
    if (req.params.userId === req.project.ownerId) {
      throw httpError(400, "Project owner cannot be removed.");
    }

    const member = await prisma.projectMember.findUnique({
      where: { projectId_userId: { projectId: req.params.projectId, userId: req.params.userId } }
    });

    if (!member) {
      throw httpError(404, "Project member not found.");
    }

    if (member.role === "ADMIN") {
      const adminCount = await prisma.projectMember.count({
        where: { projectId: req.params.projectId, role: "ADMIN" }
      });

      if (adminCount <= 1) {
        throw httpError(400, "At least one project admin is required.");
      }
    }

    await prisma.projectMember.delete({
      where: { projectId_userId: { projectId: req.params.projectId, userId: req.params.userId } }
    });

    const project = await loadProjectDetail(req.params.projectId, req.user.id, req.projectRole);
    res.json({ project });
  })
);

app.post(
  "/api/projects/:projectId/tasks",
  requireAuth,
  requireProjectMember,
  requireProjectAdmin,
  asyncHandler(async (req, res) => {
    const data = validate(taskCreateSchema, req.body);
    await assertUserIsProjectMember(req.params.projectId, data.assigneeId);

    const task = await prisma.task.create({
      data: {
        title: data.title,
        description: data.description || null,
        status: data.status,
        dueDate: parseDueDate(data.dueDate),
        projectId: req.params.projectId,
        assigneeId: data.assigneeId || null,
        creatorId: req.user.id
      },
      include: { assignee: { select: userSelect } }
    });

    res.status(201).json({ task: serializeTask(task, req.user.id, req.projectRole) });
  })
);

app.patch(
  "/api/projects/:projectId/tasks/:taskId",
  requireAuth,
  requireProjectMember,
  asyncHandler(async (req, res) => {
    const data = validate(taskPatchSchema, req.body);
    const keys = Object.keys(data);

    if (!keys.length) {
      throw httpError(400, "Provide at least one field to update.");
    }

    const task = await prisma.task.findFirst({
      where: { id: req.params.taskId, projectId: req.params.projectId }
    });

    if (!task) {
      throw httpError(404, "Task not found.");
    }

    const isAdmin = req.projectRole === "ADMIN";
    const isAssignee = task.assigneeId === req.user.id;

    if (!isAdmin) {
      if (!isAssignee) {
        throw httpError(403, "Members can update only tasks assigned to them.");
      }

      if (keys.some((key) => key !== "status")) {
        throw httpError(403, "Members can update only task status.");
      }
    }

    if (data.assigneeId !== undefined) {
      await assertUserIsProjectMember(req.params.projectId, data.assigneeId);
    }

    const updateData = {
      ...(data.title !== undefined ? { title: data.title } : {}),
      ...(data.description !== undefined ? { description: data.description || null } : {}),
      ...(data.status !== undefined ? { status: data.status } : {}),
      ...(data.assigneeId !== undefined ? { assigneeId: data.assigneeId || null } : {}),
      ...(data.dueDate !== undefined ? { dueDate: parseDueDate(data.dueDate) } : {})
    };

    const updatedTask = await prisma.task.update({
      where: { id: task.id },
      data: updateData,
      include: { assignee: { select: userSelect } }
    });

    res.json({ task: serializeTask(updatedTask, req.user.id, req.projectRole) });
  })
);

app.delete(
  "/api/projects/:projectId/tasks/:taskId",
  requireAuth,
  requireProjectMember,
  requireProjectAdmin,
  asyncHandler(async (req, res) => {
    const task = await prisma.task.findFirst({
      where: { id: req.params.taskId, projectId: req.params.projectId }
    });

    if (!task) {
      throw httpError(404, "Task not found.");
    }

    await prisma.task.delete({ where: { id: task.id } });
    res.status(204).send();
  })
);

app.use(express.static(path.join(__dirname, "..", "public")));
app.get("*", (req, res, next) => {
  if (req.path.startsWith("/api/")) {
    next();
    return;
  }

  res.sendFile(path.join(__dirname, "..", "public", "index.html"));
});

app.use((req, res) => {
  res.status(404).json({ error: "Not found." });
});

app.use((error, _req, res, _next) => {
  if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
    res.status(409).json({ error: "A record with those details already exists." });
    return;
  }

  const status = error.status || 500;
  const message = status >= 500 ? "Something went wrong." : error.message;

  if (status >= 500) {
    console.error(error);
  }

  res.status(status).json({ error: message });
});

app.listen(port, () => {
  console.log(`Project task dashboard running on port ${port}`);
});
