import { escapeHtml } from './utils.js';
import { setElementHtml } from './dom.js';
import { getActiveSession } from './sessions.js';

function renderTaskPanel() {
  const session = getActiveSession();
  const taskPanel = document.getElementById('task-panel');
  const taskList = document.getElementById('task-list');
  const taskCount = document.querySelector('.task-panel-count');

  if (!taskPanel || !taskList) return;

  // Handle case where session doesn't exist or has no tasks
  const tasks = session?.tasks || [];
  const activeTasks = tasks.filter(t => t.status === 'running' || t.status === 'pending');

  // Show/hide panel based on whether there are any tasks
  if (tasks.length === 0) {
    taskPanel.classList.remove('visible');
    taskPanel.classList.add('hidden');
    return;
  }

  taskPanel.classList.remove('hidden');
  taskPanel.classList.add('visible');

  // Update task count
  if (taskCount) {
    const count = activeTasks.length;
    taskCount.textContent = count === 1 ? '1 active' : `${count} active`;
  }

  // Restore expanded state
  if (session?.taskPanelExpanded) {
    taskPanel.classList.add('expanded');
    taskPanel.setAttribute('aria-expanded', 'true');
  } else {
    taskPanel.classList.remove('expanded');
    taskPanel.setAttribute('aria-expanded', 'false');
  }

  // Render task list
  if (tasks.length === 0) {
    setElementHtml(taskList, '<li class="task-empty">No active tasks</li>');
    return;
  }

  // Sort: active tasks first, then by start time
  const sortedTasks = [...tasks].sort((a, b) => {
    const aActive = a.status === 'running' || a.status === 'pending';
    const bActive = b.status === 'running' || b.status === 'pending';
    if (aActive && !bActive) return -1;
    if (!aActive && bActive) return 1;
    return (b.startTime || 0) - (a.startTime || 0);
  });

  setElementHtml(taskList, sortedTasks.map(task => {
    const progressHtml = task.progress !== undefined && task.progress !== null
      ? `<span class="task-progress">${Math.round(task.progress)}%</span>`
      : '<span class="task-progress hidden"></span>';

    return `
      <li class="task-item" data-task-id="${escapeHtml(task.taskId)}" role="listitem">
        <span class="task-status ${escapeHtml(task.status)}"></span>
        <span class="task-title">${escapeHtml(task.title || 'Unknown task')}</span>
        ${progressHtml}
      </li>
    `;
  }).join(''));
}

function toggleTaskPanel() {
  const session = getActiveSession();
  if (!session) return;

  const taskPanel = document.getElementById('task-panel');
  if (!taskPanel) return;

  session.taskPanelExpanded = !session.taskPanelExpanded;

  if (session.taskPanelExpanded) {
    taskPanel.classList.add('expanded');
    taskPanel.setAttribute('aria-expanded', 'true');
  } else {
    taskPanel.classList.remove('expanded');
    taskPanel.setAttribute('aria-expanded', 'false');
  }
}

function expandTaskPanel() {
  const session = getActiveSession();
  if (!session) return;

  const taskPanel = document.getElementById('task-panel');
  if (!taskPanel) return;

  session.taskPanelExpanded = true;
  taskPanel.classList.add('expanded');
  taskPanel.setAttribute('aria-expanded', 'true');
}

function collapseTaskPanel() {
  const session = getActiveSession();
  if (!session) return;

  const taskPanel = document.getElementById('task-panel');
  if (!taskPanel) return;

  session.taskPanelExpanded = false;
  taskPanel.classList.remove('expanded');
  taskPanel.setAttribute('aria-expanded', 'false');
}

function addTask(session, taskData) {
  if (!session) return;
  if (!session.tasks) session.tasks = [];

  // Check if task already exists
  const existingIndex = session.tasks.findIndex(t => t.taskId === taskData.taskId);
  if (existingIndex >= 0) {
    // Update existing task
    session.tasks[existingIndex] = { ...session.tasks[existingIndex], ...taskData };
  } else {
    // Add new task
    session.tasks.push({
      taskId: taskData.taskId,
      title: taskData.title || 'Task',
      status: taskData.status || 'pending',
      progress: taskData.progress,
      parentId: taskData.parentId || null,
      startTime: taskData.startTime || Date.now()
    });
  }

  // Only render if this is the active session
  if (session === getActiveSession()) {
    renderTaskPanel();
  }
}

function updateTask(session, taskId, updates) {
  if (!session || !session.tasks) return;

  const taskIndex = session.tasks.findIndex(t => t.taskId === taskId);
  if (taskIndex >= 0) {
    session.tasks[taskIndex] = { ...session.tasks[taskIndex], ...updates };

    // Only render if this is the active session
    if (session === getActiveSession()) {
      renderTaskPanel();
    }
  }
}

function removeTask(session, taskId) {
  if (!session || !session.tasks) return;

  session.tasks = session.tasks.filter(t => t.taskId !== taskId);

  // Only render if this is the active session
  if (session === getActiveSession()) {
    renderTaskPanel();
  }
}

function clearTasks(session) {
  if (!session) return;

  session.tasks = [];

  // Only render if this is the active session
  if (session === getActiveSession()) {
    renderTaskPanel();
  }
}

function syncTasks(session, tasks) {
  if (!session) return;

  session.tasks = tasks || [];

  // Only render if this is the active session
  if (session === getActiveSession()) {
    renderTaskPanel();
  }
}

// ==================== End Task Panel Functions ====================

export { renderTaskPanel, toggleTaskPanel, expandTaskPanel, collapseTaskPanel, addTask, updateTask, removeTask, clearTasks, syncTasks };
