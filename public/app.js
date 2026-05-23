const state = {
  token: localStorage.getItem("ptd_token"),
  user: null,
  view: "dashboard",
  projects: [],
  dashboard: null,
  currentProjectId: null,
  currentProject: null
};

const statusLabels = {
  TODO: "To do",
  IN_PROGRESS: "In progress",
  DONE: "Done",
  BLOCKED: "Blocked"
};

const statusClasses = {
  TODO: "todo",
  IN_PROGRESS: "in-progress",
  DONE: "done",
  BLOCKED: "blocked"
};

const $ = (selector, root = document) => root.querySelector(selector);
const $$ = (selector, root = document) => Array.from(root.querySelectorAll(selector));

function escapeHtml(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

function formatDate(value) {
  if (!value) {
    return "No due date";
  }

  return new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric", year: "numeric" }).format(new Date(value));
}

function isOverdue(task) {
  return task.status !== "DONE" && task.dueDate && new Date(task.dueDate) < new Date();
}

function showToast(message) {
  const toast = $("[data-toast]");
  toast.textContent = message;
  toast.classList.add("is-visible");
  clearTimeout(showToast.timeout);
  showToast.timeout = setTimeout(() => toast.classList.remove("is-visible"), 2800);
}

async function api(path, options = {}) {
  const headers = {
    ...(options.body ? { "Content-Type": "application/json" } : {}),
    ...(state.token ? { Authorization: `Bearer ${state.token}` } : {}),
    ...options.headers
  };
  const response = await fetch(path, { ...options, headers });

  if (response.status === 204) {
    return null;
  }

  const data = await response.json().catch(() => ({}));

  if (!response.ok) {
    if (response.status === 401) {
      logout(false);
    }

    throw new Error(data.error || "Request failed.");
  }

  return data;
}

function formData(form) {
  return Object.fromEntries(new FormData(form).entries());
}

function saveSession(payload) {
  state.token = payload.token;
  state.user = payload.user;
  localStorage.setItem("ptd_token", payload.token);
}

function logout(showMessage = true) {
  state.token = null;
  state.user = null;
  state.projects = [];
  state.dashboard = null;
  state.currentProjectId = null;
  state.currentProject = null;
  localStorage.removeItem("ptd_token");
  renderAuth();

  if (showMessage) {
    showToast("Logged out.");
  }
}

function renderAuth() {
  $("[data-auth-screen]").classList.toggle("is-hidden", Boolean(state.user));
  $("[data-shell]").classList.toggle("is-hidden", !state.user);

  if (state.user) {
    $("[data-user-chip]").textContent = state.user.name;
  }
}

function setView(view) {
  state.view = view;
  $$("[data-view]").forEach((button) => button.classList.toggle("is-active", button.dataset.view === view));
  $$("[data-panel]").forEach((panel) => panel.classList.toggle("is-hidden", panel.dataset.panel !== view));
}

async function refreshAll() {
  const [dashboardData, projectsData] = await Promise.all([api("/api/dashboard"), api("/api/projects")]);
  state.dashboard = dashboardData;
  state.projects = projectsData.projects;

  if (!state.currentProjectId && state.projects.length) {
    state.currentProjectId = state.projects[0].id;
  }

  if (state.currentProjectId && state.projects.some((project) => project.id === state.currentProjectId)) {
    await loadProject(state.currentProjectId, false);
  } else {
    state.currentProjectId = null;
    state.currentProject = null;
  }

  renderDashboard();
  renderProjectList();
  renderProjectDetail();
}

async function loadProject(projectId, render = true) {
  state.currentProjectId = projectId;
  const data = await api(`/api/projects/${projectId}`);
  state.currentProject = data.project;

  if (render) {
    renderProjectList();
    renderProjectDetail();
  }
}

function renderDashboard() {
  const container = $("[data-dashboard]");
  const stats = state.dashboard?.stats || {
    projectCount: 0,
    totalTasks: 0,
    assignedToMe: 0,
    overdueTasks: 0,
    statusCounts: { TODO: 0, IN_PROGRESS: 0, DONE: 0, BLOCKED: 0 }
  };
  const total = Math.max(stats.totalTasks, 1);

  container.innerHTML = `
    <div class="metrics-grid">
      ${metricCard("Projects", stats.projectCount)}
      ${metricCard("Total tasks", stats.totalTasks)}
      ${metricCard("Assigned to me", stats.assignedToMe)}
      ${metricCard("Overdue", stats.overdueTasks)}
    </div>
    <div class="dashboard-grid">
      <section class="panel">
        <div class="panel-header">
          <h2>Status tracking</h2>
          <span class="muted">${stats.totalTasks} tasks</span>
        </div>
        <div class="status-grid">
          ${Object.entries(statusLabels)
            .map(([status, label]) => {
              const count = stats.statusCounts[status] || 0;
              const width = Math.round((count / total) * 100);
              return `
                <div class="status-line">
                  <span>${label}</span>
                  <div class="bar"><span style="width: ${width}%"></span></div>
                  <strong>${count}</strong>
                </div>
              `;
            })
            .join("")}
        </div>
      </section>
      <section class="panel">
        <div class="panel-header">
          <h2>Assigned to me</h2>
          <span class="muted">${state.dashboard?.myTasks?.length || 0} shown</span>
        </div>
        <div class="task-list">
          ${taskList(state.dashboard?.myTasks || [], { compact: true })}
        </div>
      </section>
    </div>
    <section class="panel" style="margin-top: 1rem;">
      <div class="panel-header">
        <h2>Overdue tasks</h2>
        <span class="muted">${state.dashboard?.overdueTasks?.length || 0} shown</span>
      </div>
      <div class="task-list">
        ${taskList(state.dashboard?.overdueTasks || [], { compact: true, overdue: true })}
      </div>
    </section>
  `;
}

function metricCard(label, value) {
  return `
    <div class="metric">
      <span class="muted">${label}</span>
      <strong>${value}</strong>
    </div>
  `;
}

function renderProjectList() {
  const container = $("[data-project-list]");

  if (!state.projects.length) {
    container.innerHTML = `<div class="empty-state">Create your first project to start assigning work.</div>`;
    return;
  }

  container.innerHTML = state.projects
    .map(
      (project) => `
        <button class="project-row ${project.id === state.currentProjectId ? "is-active" : ""}" type="button" data-project-id="${escapeHtml(project.id)}">
          <span>
            <strong>${escapeHtml(project.name)}</strong>
            <small>${project.openTaskCount} open, ${project.overdueTaskCount} overdue</small>
          </span>
          <span class="role-badge ${project.role === "ADMIN" ? "admin" : ""}">${project.role}</span>
        </button>
      `
    )
    .join("");
}

function renderProjectDetail() {
  const container = $("[data-project-detail]");
  const project = state.currentProject;

  if (!project) {
    container.innerHTML = `<div class="empty-state">Select or create a project to manage team members and tasks.</div>`;
    return;
  }

  const isAdmin = project.role === "ADMIN";

  container.innerHTML = `
    <article class="project-detail">
      <section class="panel">
        <div class="panel-header">
          <div>
            <p class="eyebrow">${project.role}</p>
            <h2>${escapeHtml(project.name)}</h2>
            <p class="muted">${escapeHtml(project.description || "No description yet.")}</p>
          </div>
          ${isAdmin ? `<button class="danger" type="button" data-delete-project="${escapeHtml(project.id)}">Delete project</button>` : ""}
        </div>
      </section>

      <div class="detail-grid">
        <section class="panel">
          <div class="panel-header">
            <h2>Team</h2>
            <span class="muted">${project.members.length} members</span>
          </div>
          ${
            isAdmin
              ? `
                <form class="stack" data-member-form>
                  <label>
                    Add by email
                    <input name="email" type="email" placeholder="member@example.com" required>
                  </label>
                  <label>
                    Role
                    <select name="role">
                      <option value="MEMBER">Member</option>
                      <option value="ADMIN">Admin</option>
                    </select>
                  </label>
                  <button class="primary" type="submit">Add member</button>
                </form>
              `
              : `<p class="muted">Members can view the team and update their assigned task status.</p>`
          }
          <div class="member-list">
            ${project.members.map((member) => memberRow(member, project, isAdmin)).join("")}
          </div>
        </section>

        <section class="panel">
          <div class="panel-header">
            <h2>Create task</h2>
            <span class="muted">${isAdmin ? "Admin controls" : "Admin only"}</span>
          </div>
          ${
            isAdmin
              ? `
                <form class="stack" data-task-form>
                  <label>
                    Title
                    <input name="title" type="text" maxlength="160" required>
                  </label>
                  <label>
                    Description
                    <textarea name="description" rows="3" maxlength="1000"></textarea>
                  </label>
                  <label>
                    Assignee
                    <select name="assigneeId">
                      <option value="">Unassigned</option>
                      ${project.members
                        .map((member) => `<option value="${escapeHtml(member.userId)}">${escapeHtml(member.user.name)}</option>`)
                        .join("")}
                    </select>
                  </label>
                  <label>
                    Due date
                    <input name="dueDate" type="date">
                  </label>
                  <label>
                    Status
                    <select name="status">
                      ${statusOptions("TODO")}
                    </select>
                  </label>
                  <button class="primary" type="submit">Create task</button>
                </form>
              `
              : `<div class="empty-state">Ask a project admin to create or assign tasks.</div>`
          }
        </section>
      </div>

      <section class="panel">
        <div class="panel-header">
          <h2>Tasks</h2>
          <span class="muted">${project.tasks.length} total</span>
        </div>
        <div class="task-list">
          ${taskList(project.tasks, { projectRole: project.role })}
        </div>
      </section>
    </article>
  `;
}

function memberRow(member, project, isAdmin) {
  const isOwner = member.userId === project.owner.id;
  const canEdit = isAdmin && !isOwner;

  return `
    <div class="member-row">
      <div class="member-main">
        <strong>${escapeHtml(member.user.name)} ${isOwner ? "(Owner)" : ""}</strong>
        <span class="muted">${escapeHtml(member.user.email)}</span>
      </div>
      <div class="member-actions">
        <select data-member-role="${escapeHtml(member.userId)}" ${canEdit ? "" : "disabled"}>
          <option value="MEMBER" ${member.role === "MEMBER" ? "selected" : ""}>Member</option>
          <option value="ADMIN" ${member.role === "ADMIN" ? "selected" : ""}>Admin</option>
        </select>
        ${
          canEdit
            ? `<button class="danger" type="button" data-remove-member="${escapeHtml(member.userId)}">Remove</button>`
            : `<span class="role-badge ${member.role === "ADMIN" ? "admin" : ""}">${member.role}</span>`
        }
      </div>
    </div>
  `;
}

function taskList(tasks, options = {}) {
  if (!tasks.length) {
    return `<div class="empty-state">No tasks to show.</div>`;
  }

  return tasks.map((task) => taskCard(task, options)).join("");
}

function taskCard(task, options = {}) {
  const statusClass = statusClasses[task.status] || "todo";
  const overdue = isOverdue(task);
  const canUpdate = Boolean(task.canUpdate || options.projectRole === "ADMIN");
  const projectName = task.project ? `<span>${escapeHtml(task.project.name)}</span>` : "";
  const assignee = task.assignee ? escapeHtml(task.assignee.name) : "Unassigned";

  return `
    <article class="task-card">
      <div class="card-title-row">
        <div class="task-main">
          <strong>${escapeHtml(task.title)}</strong>
          ${task.description ? `<p>${escapeHtml(task.description)}</p>` : ""}
        </div>
        <span class="status-badge ${overdue ? "overdue" : statusClass}">${overdue ? "Overdue" : statusLabels[task.status]}</span>
      </div>
      <div class="task-meta">
        ${projectName}
        <span>Assignee: ${assignee}</span>
        <span>Due: ${formatDate(task.dueDate)}</span>
      </div>
      ${
        options.compact
          ? ""
          : `
            <div class="task-actions">
              <select data-task-status="${escapeHtml(task.id)}" ${canUpdate ? "" : "disabled"}>
                ${statusOptions(task.status)}
              </select>
              ${options.projectRole === "ADMIN" ? `<button class="danger" type="button" data-delete-task="${escapeHtml(task.id)}">Delete</button>` : ""}
            </div>
          `
      }
    </article>
  `;
}

function statusOptions(selected) {
  return Object.entries(statusLabels)
    .map(([value, label]) => `<option value="${value}" ${selected === value ? "selected" : ""}>${label}</option>`)
    .join("");
}

async function handleAuth(event) {
  event.preventDefault();
  const form = event.currentTarget;
  const mode = form.dataset.authForm;
  const payload = formData(form);

  try {
    const data = await api(`/api/auth/${mode}`, {
      method: "POST",
      body: JSON.stringify(payload)
    });
    saveSession(data);
    renderAuth();
    await refreshAll();
    setView("dashboard");
    form.reset();
    showToast(mode === "signup" ? "Account created." : "Welcome back.");
  } catch (error) {
    showToast(error.message);
  }
}

async function handleCreateProject(event) {
  event.preventDefault();
  const payload = formData(event.currentTarget);

  try {
    const data = await api("/api/projects", {
      method: "POST",
      body: JSON.stringify(payload)
    });
    state.currentProjectId = data.project.id;
    state.currentProject = data.project;
    event.currentTarget.reset();
    await refreshAll();
    setView("projects");
    showToast("Project created.");
  } catch (error) {
    showToast(error.message);
  }
}

async function handleAddMember(event) {
  event.preventDefault();
  const payload = formData(event.currentTarget);

  try {
    const data = await api(`/api/projects/${state.currentProjectId}/members`, {
      method: "POST",
      body: JSON.stringify(payload)
    });
    state.currentProject = data.project;
    event.currentTarget.reset();
    renderProjectDetail();
    await refreshAll();
    showToast("Member updated.");
  } catch (error) {
    showToast(error.message);
  }
}

async function handleCreateTask(event) {
  event.preventDefault();
  const payload = formData(event.currentTarget);

  try {
    await api(`/api/projects/${state.currentProjectId}/tasks`, {
      method: "POST",
      body: JSON.stringify(payload)
    });
    event.currentTarget.reset();
    await refreshAll();
    showToast("Task created.");
  } catch (error) {
    showToast(error.message);
  }
}

function bindEvents() {
  $$("[data-auth-tab]").forEach((button) => {
    button.addEventListener("click", () => {
      $$("[data-auth-tab]").forEach((tab) => tab.classList.toggle("is-active", tab === button));
      $$("[data-auth-form]").forEach((form) => form.classList.toggle("is-hidden", form.dataset.authForm !== button.dataset.authTab));
    });
  });

  $$("[data-auth-form]").forEach((form) => form.addEventListener("submit", handleAuth));
  $("[data-project-form]").addEventListener("submit", handleCreateProject);
  $("[data-logout]").addEventListener("click", () => logout());
  $("[data-refresh]").addEventListener("click", () => refreshAll().then(() => showToast("Refreshed.")).catch((error) => showToast(error.message)));

  $$("[data-view]").forEach((button) => {
    button.addEventListener("click", () => setView(button.dataset.view));
  });

  $("[data-project-list]").addEventListener("click", async (event) => {
    const button = event.target.closest("[data-project-id]");

    if (!button) {
      return;
    }

    try {
      await loadProject(button.dataset.projectId);
    } catch (error) {
      showToast(error.message);
    }
  });

  $("[data-project-detail]").addEventListener("submit", (event) => {
    if (event.target.matches("[data-member-form]")) {
      handleAddMember(event);
    }

    if (event.target.matches("[data-task-form]")) {
      handleCreateTask(event);
    }
  });

  $("[data-project-detail]").addEventListener("change", async (event) => {
    const memberRole = event.target.closest("[data-member-role]");
    const taskStatus = event.target.closest("[data-task-status]");

    try {
      if (memberRole) {
        const data = await api(`/api/projects/${state.currentProjectId}/members/${memberRole.dataset.memberRole}`, {
          method: "PATCH",
          body: JSON.stringify({ role: memberRole.value })
        });
        state.currentProject = data.project;
        renderProjectDetail();
        await refreshAll();
        showToast("Role updated.");
      }

      if (taskStatus) {
        await api(`/api/projects/${state.currentProjectId}/tasks/${taskStatus.dataset.taskStatus}`, {
          method: "PATCH",
          body: JSON.stringify({ status: taskStatus.value })
        });
        await refreshAll();
        showToast("Task status updated.");
      }
    } catch (error) {
      showToast(error.message);
      await loadProject(state.currentProjectId).catch(() => {});
    }
  });

  $("[data-project-detail]").addEventListener("click", async (event) => {
    const removeMember = event.target.closest("[data-remove-member]");
    const deleteTask = event.target.closest("[data-delete-task]");
    const deleteProject = event.target.closest("[data-delete-project]");

    try {
      if (removeMember && confirm("Remove this member from the project?")) {
        const data = await api(`/api/projects/${state.currentProjectId}/members/${removeMember.dataset.removeMember}`, {
          method: "DELETE"
        });
        state.currentProject = data.project;
        renderProjectDetail();
        await refreshAll();
        showToast("Member removed.");
      }

      if (deleteTask && confirm("Delete this task?")) {
        await api(`/api/projects/${state.currentProjectId}/tasks/${deleteTask.dataset.deleteTask}`, { method: "DELETE" });
        await refreshAll();
        showToast("Task deleted.");
      }

      if (deleteProject && confirm("Delete this project and all of its tasks?")) {
        await api(`/api/projects/${deleteProject.dataset.deleteProject}`, { method: "DELETE" });
        state.currentProjectId = null;
        state.currentProject = null;
        await refreshAll();
        renderProjectDetail();
        showToast("Project deleted.");
      }
    } catch (error) {
      showToast(error.message);
    }
  });
}

async function init() {
  bindEvents();

  if (!state.token) {
    renderAuth();
    return;
  }

  try {
    const data = await api("/api/auth/me");
    state.user = data.user;
    renderAuth();
    await refreshAll();
  } catch (_error) {
    logout(false);
  }
}

init();
