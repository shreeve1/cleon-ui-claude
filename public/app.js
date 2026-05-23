// Constants
const MAX_ATTACHMENTS = 5;
const PREVIEW_TRUNCATE_LENGTH = 100;
const TOOL_COMMAND_PREVIEW_LENGTH = 80;
const WS_RECONNECT_MAX_DELAY = 30000;
const SEARCH_DEBOUNCE_MS = 300;
const DEFAULT_MODEL = 'opus';

const MAX_SESSIONS = 5;

const state = {
  token: localStorage.getItem('token'),
  ws: null,
  wsReconnectAttempts: 0,
  notificationsEnabled: false,
  eventSource: null,
  sseConnected: false,
  sessions: [],
  activeSessionIndex: -1,
  modeIndex: 2,
  currentMode: 'bypass',
  searchTimeout: null,
  customCommands: [],
  forceNewTab: false,
  selectedModel: localStorage.getItem('selectedModel') || DEFAULT_MODEL,
};

const SW_CLEANUP_RELOAD_KEY = 'cleon-sw-cleanup-reloaded';

function createClientId() {
  const cryptoApi = globalThis.crypto;
  if (cryptoApi?.randomUUID) return cryptoApi.randomUUID();

  if (cryptoApi?.getRandomValues) {
    const bytes = cryptoApi.getRandomValues(new Uint8Array(16));
    bytes[6] = (bytes[6] & 0x0f) | 0x40;
    bytes[8] = (bytes[8] & 0x3f) | 0x80;
    const hex = Array.from(bytes, byte => byte.toString(16).padStart(2, '0'));
    return `${hex.slice(0, 4).join('')}-${hex.slice(4, 6).join('')}-${hex.slice(6, 8).join('')}-${hex.slice(8, 10).join('')}-${hex.slice(10).join('')}`;
  }

  return `session-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

// Session object factory
function createSession(project, sessionId = null) {
  return {
    id: createClientId(),             // Internal tab ID
    sessionId: sessionId,              // Claude SDK session ID (null = new)
    project: project,                  // { name, path, displayName }
    isStreaming: false,
    isReplaying: false,
    pendingText: '',
    pendingQuestion: null,
    pendingPlanConfirmation: null,
    attachments: [],
    lastTokenUsage: null,
    lastContextWindow: null,
    model: null,
    hasUnread: false,
    needsHistoryLoad: false,
    containerEl: null,                 // DOM reference
    streamingRenderer: null,           // StreamingRenderer instance
    // File mention state (per-session)
    fileMentionSelectedIndex: 0,
    fileMentionQuery: '',
    fileMentionStartPos: -1,
    fileMentionDebounceTimer: null,
    slashCommandSelectedIndex: -1,
    unreadCount: 0,
    isAtBottom: true,
    // Task panel state (per-session)
    tasks: [],                         // Active tasks array
    taskPanelExpanded: false,          // Task panel expand/collapse state
    activityState: null                // Current AI activity state
  };
}

function getActiveSession() {
  if (state.activeSessionIndex < 0 || state.activeSessionIndex >= state.sessions.length) return null;
  return state.sessions[state.activeSessionIndex];
}

function getSessionByInternalId(id) {
  return state.sessions.find(s => s.id === id) || null;
}

function getSessionBySessionId(sessionId) {
  return state.sessions.find(s => s.sessionId === sessionId) || null;
}

// Markdown renderer initialization
let markdownInitialized = false;

function initializeMarkdownRenderer() {
  if (typeof marked === 'undefined' || typeof DOMPurify === 'undefined') return false;

  marked.setOptions({
    gfm: true,
    breaks: true,
    headerIds: false,
    highlight: function(code, lang) {
      if (typeof Prism !== 'undefined' && Prism.languages[lang]) {
        return Prism.highlight(code, Prism.languages[lang], lang);
      }
      return code;
    }
  });

  // Custom code block renderer - preserves copy button structure
  marked.use({
    renderer: {
      code(code, lang) {
        const displayLang = lang || 'code';
        const highlighted = this.options.highlight ? this.options.highlight(code, lang) : escapeHtml(code);
        return `<div class="code-block-wrapper"><div class="code-block-header"><span class="code-lang">${escapeHtml(displayLang)}</span><button class="code-copy-btn" aria-label="Copy code">Copy</button></div><pre><code class="${lang || ''}">${highlighted}</code></pre></div>`;
      }
    }
  });

  markdownInitialized = true;
  return true;
}

// StreamingRenderer class for smooth character-by-character animation
class StreamingRenderer {
  constructor(element) {
    this.element = element;
    this.networkBuffer = '';
    this.displayedChars = 0;
    this.rafHandle = null;
    this.timeoutHandle = null;
    const prefersReducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    this.charInterval = prefersReducedMotion ? 0 : 5; // ms per char (~200 chars/sec)
  }

  appendNetworkChunk(chunk) {
    this.networkBuffer += chunk;
    if (!this.rafHandle) {
      this.scheduleRender();
    }
  }

  scheduleRender() {
    this.rafHandle = requestAnimationFrame(() => {
      this.renderNextChar();
    });
  }

  renderNextChar() {
    if (this.displayedChars < this.networkBuffer.length) {
      this.displayedChars++;
      this.element.textContent = this.networkBuffer.slice(0, this.displayedChars);

      // Schedule next character
      this.timeoutHandle = setTimeout(() => {
        this.scheduleRender();
      }, this.charInterval);
    } else {
      // Caught up with network buffer
      this.rafHandle = null;
    }
  }

  finalizeMarkdown() {
    // Skip to end and apply markdown
    this.element.textContent = this.networkBuffer;
    this.element.innerHTML = formatMarkdown(this.networkBuffer);

    // Apply Prism highlighting to code blocks
    if (typeof Prism !== 'undefined') {
      this.element.querySelectorAll('pre code').forEach(block => {
        Prism.highlightElement(block);
      });
    }
  }

  skipToEnd() {
    this.destroy();
    this.finalizeMarkdown();
  }

  destroy() {
    if (this.rafHandle) {
      cancelAnimationFrame(this.rafHandle);
      this.rafHandle = null;
    }
    if (this.timeoutHandle) {
      clearTimeout(this.timeoutHandle);
      this.timeoutHandle = null;
    }
  }
}

function createSessionContainer(session) {
  const container = document.createElement('div');
  container.className = 'session-container';
  container.dataset.sessionId = session.id;
  document.getElementById('session-containers').appendChild(container);
  session.containerEl = container;
  container.addEventListener('scroll', () => {
    const session = state.sessions.find(s => s.containerEl === container);
    if (!session) return;
    const threshold = 100;
    const atBottom = container.scrollHeight - container.scrollTop - container.clientHeight < threshold;
    session.isAtBottom = atBottom;
    if (atBottom) {
      session.unreadCount = 0;
      updateScrollFAB(session);
    }
  });
  return container;
}

function renderSessionBar() {
  if (state.sessions.length === 0) {
    sessionBarEl.classList.remove('visible');
    return;
  }
  sessionBarEl.classList.add('visible');
  sessionTabsEl.innerHTML = state.sessions.map((s, i) => `
    <button class="session-tab${i === state.activeSessionIndex ? ' active' : ''}${s.hasUnread ? ' unread' : ''}" data-index="${i}">
      <span class="session-tab-number">[${i + 1}]</span>
      <span class="session-tab-name">${escapeHtml(s.project.displayName || s.project.name)}</span>
      <span class="close-tab" title="Close session">&times;</span>
    </button>
  `).join('');
}

function switchToSession(index) {
  if (index < 0 || index >= state.sessions.length) return;
  if (index === state.activeSessionIndex) return;

  const currentSession = getActiveSession();
  if (currentSession) {
    currentSession.containerEl.classList.remove('active');
    hideSlashCommands();
    hideFileMentions();
    clearTimeout(currentSession.fileMentionDebounceTimer);
  }

  state.activeSessionIndex = index;
  const newSession = getActiveSession();

  newSession.containerEl.classList.add('active');
  newSession.hasUnread = false;
  renderActivityStatus(newSession);

  // Lazy-load message history for restored sessions
  if (newSession.needsHistoryLoad) {
    loadSessionHistory(newSession);
  } else if (!newSession.sessionId) {
    // New session without history - ensure it has welcome message
    if (!newSession.containerEl.querySelector('.welcome-message')) {
      clearMessages(newSession);
    }
  }

  if (newSession.isStreaming) {
    abortBtn.classList.remove('hidden');
    chatInput.disabled = true;
    sendBtn.disabled = true;
    modeBtn.disabled = true;
    modelBtn.disabled = true;
    attachBtn.disabled = true;
  } else {
    abortBtn.classList.add('hidden');
    chatInput.disabled = false;
    sendBtn.disabled = false;
    modeBtn.disabled = false;
    modelBtn.disabled = false;
    attachBtn.disabled = false;
  }

  projectNameEl.textContent = newSession.project.displayName || newSession.project.name;
  updateTokenUsage(newSession.lastTokenUsage, newSession.lastContextWindow, newSession);
  renderAttachmentPreview();
  updateHash(newSession.project.name, newSession.sessionId);
  renderSessionBar();
  updateScrollFAB(newSession);
  renderTaskPanel(); // Render task panel for the new session
  saveSessionState();
  if (!newSession.isStreaming) chatInput.focus();
}

function closeSession(index) {
  if (index < 0 || index >= state.sessions.length) return;
  const session = state.sessions[index];

  // Abort if streaming
  if (session.isStreaming && session.sessionId) {
    state.ws.send(JSON.stringify({ type: 'abort', sessionId: session.sessionId }));
  }

  // Clean up timers
  clearTimeout(session.fileMentionDebounceTimer);

  // Clear tasks for this session
  clearTasks(session);

  // Remove DOM container
  if (session.containerEl) session.containerEl.remove();

  // Remove from array
  state.sessions.splice(index, 1);

  // Adjust active index
  if (state.sessions.length === 0) {
    state.activeSessionIndex = -1;
    renderSessionBar();
    openSidebar();
    return;
  }

  if (index === state.activeSessionIndex) {
    // Switch to nearest session
    const newIndex = Math.min(index, state.sessions.length - 1);
    state.activeSessionIndex = -1; // Reset so switchToSession doesn't early-return
    switchToSession(newIndex);
  } else if (index < state.activeSessionIndex) {
    state.activeSessionIndex--;
    renderSessionBar();
  } else {
    renderSessionBar();
  }

  saveSessionState();
}

// ==================== Task Panel Functions ====================

function renderTaskPanel() {
  const session = getActiveSession();
  const taskPanel = document.getElementById('task-panel');
  const taskList = document.getElementById('task-list');
  const taskCount = document.querySelector('.task-panel-count');

  if (!taskPanel || !taskList) return;

  // Handle case where session doesn't exist or has no tasks
  const tasks = session?.tasks || [];
  const activeTasks = tasks.filter(t => t.status === 'running' || t.status === 'pending');
  const completedTasks = tasks.filter(t => t.status === 'completed' || t.status === 'failed');

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
    taskList.innerHTML = '<li class="task-empty">No active tasks</li>';
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

  taskList.innerHTML = sortedTasks.map(task => {
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
  }).join('');
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

function saveSessionState() {
  const sessionData = state.sessions.map(s => ({
    sessionId: s.sessionId,
    project: s.project,
    lastTokenUsage: s.lastTokenUsage,
    lastContextWindow: s.lastContextWindow,
    model: s.model,
    cacheMetrics: s.cacheMetrics || null
  }));
  localStorage.setItem('cleon-sessions', JSON.stringify(sessionData));
  localStorage.setItem('cleon-active-session', String(state.activeSessionIndex));
}

async function restoreSessionState() {
  try {
    const saved = JSON.parse(localStorage.getItem('cleon-sessions'));
    const activeIndex = parseInt(localStorage.getItem('cleon-active-session')) || 0;
    if (!saved || saved.length === 0) return false;

    for (const data of saved) {
      const session = createSession(data.project, data.sessionId);
      session.lastTokenUsage = data.lastTokenUsage;
      session.lastContextWindow = data.lastContextWindow;
      session.model = data.model || null;
      session.cacheMetrics = data.cacheMetrics || null;
      state.sessions.push(session);
      createSessionContainer(session);
      // Mark sessions with history for lazy loading
      if (session.sessionId) {
        session.needsHistoryLoad = true;
        session.containerEl.innerHTML = '<div class="loading">Loading history</div>';
      } else {
        clearMessages(session);
      }
    }

    if (state.sessions.length > 0) {
      state.activeSessionIndex = -1;
      const targetIndex = Math.min(activeIndex, state.sessions.length - 1);
      switchToSession(targetIndex);
      enableChat();

      // Load message history for the active session
      const activeSession = getActiveSession();
      if (activeSession && activeSession.needsHistoryLoad) {
        await loadSessionHistory(activeSession);
      }

      // Update hash to match restored session (use replaceState to avoid history entry)
      if (activeSession) {
        const hash = activeSession.project.name
          ? `/project/${encodeURIComponent(activeSession.project.name)}${activeSession.sessionId ? `/session/${encodeURIComponent(activeSession.sessionId)}` : ''}`
          : '';
        if (hash) window.history.replaceState(null, '', '#' + hash);
      }
    }

    return state.sessions.length > 0;
  } catch (e) {
    console.error('Failed to restore session state:', e);
    return false;
  }
}

// Mode configuration
const MODES = [
  { name: 'default', label: 'Default', color: 'var(--neon-cyan)' },
  { name: 'plan', label: 'Plan Mode', color: 'var(--neon-green)' },
  { name: 'bypass', label: 'Bypass Permissions', color: 'var(--neon-red)' }
];

// Favorites storage utilities
function getFavorites() {
  try {
    return JSON.parse(localStorage.getItem('favoriteProjects') || '[]');
  } catch {
    return [];
  }
}

function toggleFavorite(projectPath) {
  const favorites = getFavorites();
  const index = favorites.indexOf(projectPath);
  if (index === -1) {
    favorites.push(projectPath);
  } else {
    favorites.splice(index, 1);
  }
  localStorage.setItem('favoriteProjects', JSON.stringify(favorites));
  return index === -1; // returns true if now favorited
}

function isFavorite(projectPath) {
  return getFavorites().includes(projectPath);
}

function parseHash() {
  const hash = window.location.hash.slice(1);
  if (!hash) return null;
  
  const projectMatch = hash.match(/^\/project\/([^/]+)(?:\/session\/([^/]+))?$/);
  if (projectMatch) {
    return {
      projectName: decodeURIComponent(projectMatch[1]),
      sessionId: projectMatch[2] ? decodeURIComponent(projectMatch[2]) : null
    };
  }
  return null;
}

function updateHash(projectName, sessionId = null) {
  let hash = '';
  if (projectName) {
    hash = `/project/${encodeURIComponent(projectName)}`;
    if (sessionId) {
      hash += `/session/${encodeURIComponent(sessionId)}`;
    }
  }
  const newUrl = hash ? '#' + hash : window.location.pathname;
  if (window.location.hash === '' && hash) {
    window.history.replaceState(null, '', newUrl);
  } else {
    window.history.pushState(null, '', newUrl);
  }
}

const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => document.querySelectorAll(sel);

const authScreen = $('#auth-screen');
const mainScreen = $('#main-screen');
const authForm = $('#auth-form');
const authError = $('#auth-error');
const authBtn = $('#auth-btn');
const menuBtn = $('#menu-btn');
const closeSidebarBtn = $('#close-sidebar');
const sidebar = $('#sidebar');
const sidebarOverlay = $('#sidebar-overlay');
const projectSearch = $('#project-search');
const projectList = $('#project-list');
const sessionList = $('#session-list');
const sessionsContainer = $('#sessions-container');
const backToProjectsBtn = $('#back-to-projects');
const newSessionBtn = $('#new-session-btn');
const chatForm = $('#chat-form');
const chatInput = $('#chat-input');
const sendBtn = $('#send-btn');
const modeBtn = $('#mode-btn');
const sessionContainersEl = $('#session-containers');
const sessionBarEl = $('#session-bar');
const sessionTabsEl = $('#session-tabs');
const newSessionTabBtn = $('#new-session-tab-btn');
const abortBtn = $('#abort-btn');
const projectNameEl = $('#project-name');
const tokenUsageEl = $('#token-usage');
const slashCommandsEl = $('#slash-commands');
const fileMentionsEl = $('#file-mentions');
const attachmentPreviewEl = $('#attachment-preview');
const dropZoneOverlay = $('#drop-zone-overlay');
const fileInput = $('#file-input');
const attachBtn = $('#attach-btn');
const contextBar = $('#context-bar');
const contextModel = $('#context-model');
const contextUsageFill = $('#context-usage-fill');
const contextUsageText = $('#context-usage-text');
const scrollToBottomBtn = $('#scroll-to-bottom-btn');
const unreadBadge = $('#unread-badge');
const modelBtn = $('#model-btn');
const modelDropdown = $('#model-dropdown');

// Built-in commands (always available)
const BUILTIN_COMMANDS = [
  { name: '/compact', desc: 'Use compact mode for shorter responses', source: 'builtin' },
  { name: '/verbose', desc: 'Use verbose mode for detailed responses', source: 'builtin' },
  { name: '/clear', desc: 'Clear the current conversation', source: 'builtin' },
  { name: '/help', desc: 'Show available commands', source: 'builtin' },
  { name: '/model', desc: 'Show or change the current model', source: 'builtin' },
  { name: '/tokens', desc: 'Show current token usage', source: 'builtin' },
  { name: '/context', desc: 'Show context window information', source: 'builtin' },
  { name: '/reset', desc: 'Reset conversation context', source: 'builtin' }
];

// Built-in command handlers - commands that execute locally in the UI
// Commands not in this map (like /compact, /verbose) are sent to Claude
const BUILTIN_COMMAND_HANDLERS = {
  '/clear': handleClearCommand,
  '/reset': handleClearCommand, // Same behavior as /clear
  '/help': handleHelpCommand,
  '/tokens': handleTokensCommand,
  '/context': handleContextCommand,
  '/model': handleModelCommand
};

// Check if a message is a built-in command that should be handled locally
function isLocalBuiltinCommand(message) {
  const trimmed = message.trim();
  const command = trimmed.split(/\s+/)[0].toLowerCase();
  return command in BUILTIN_COMMAND_HANDLERS;
}

// Parse command and arguments from message
function parseCommand(message) {
  const trimmed = message.trim();
  const parts = trimmed.split(/\s+/);
  const command = parts[0].toLowerCase();
  const args = parts.slice(1).join(' ');
  return { command, args };
}

// Model selection
function setModel(model) {
  state.selectedModel = model;
  localStorage.setItem('selectedModel', model);
  modelBtn.title = model.charAt(0).toUpperCase() + model.slice(1);
  modelDropdown.querySelectorAll('.dropdown-item').forEach(item => {
    item.classList.toggle('active', item.dataset.model === model);
  });
  modelDropdown.classList.add('hidden');
}

modelBtn.addEventListener('click', (e) => {
  e.stopPropagation();
  modelDropdown.classList.toggle('hidden');
});

modelDropdown.querySelectorAll('.dropdown-item').forEach(item => {
  item.addEventListener('click', () => {
    setModel(item.dataset.model);
  });
});

document.addEventListener('click', () => {
  modelDropdown.classList.add('hidden');
});

// Execute a built-in command locally
function executeBuiltinCommand(command, args) {
  const handler = BUILTIN_COMMAND_HANDLERS[command];
  if (handler) {
    handler(args);
    return true;
  }
  return false;
}

// Handler for /clear and /reset commands
function handleClearCommand() {
  const session = getActiveSession();
  if (!session) {
    appendCommandMessage('Please select a project first.');
    return;
  }

  session.sessionId = null;
  updateHash(session.project.name);
  clearMessages(session);
  enableChat();
  appendCommandMessage('Session cleared. Starting fresh.', session);
  saveSessionState();
}

// Handler for /help command
function handleHelpCommand() {
  const commands = getAllCommands();

  // Group commands by source
  const builtin = commands.filter(c => c.source === 'builtin');
  const global = commands.filter(c => c.source === 'global');
  const project = commands.filter(c => c.source === 'project');

  let helpText = 'Available Commands:\n\n';

  if (builtin.length > 0) {
    helpText += 'Built-in:\n';
    for (const cmd of builtin) {
      helpText += `  ${cmd.name} - ${cmd.desc}\n`;
    }
  }

  if (global.length > 0) {
    helpText += '\nGlobal:\n';
    for (const cmd of global) {
      helpText += `  ${cmd.name} - ${cmd.desc}\n`;
    }
  }

  if (project.length > 0) {
    helpText += '\nProject:\n';
    for (const cmd of project) {
      helpText += `  ${cmd.name} - ${cmd.desc}\n`;
    }
  }

  appendCommandMessage(helpText);
}

// Handler for /tokens command
function handleTokensCommand() {
  const session = getActiveSession();
  if (!session || session.lastTokenUsage === null) {
    appendCommandMessage('No token usage data yet. Send a message first.');
    return;
  }

  const usedK = Math.round(session.lastTokenUsage / 1000);
  const totalK = Math.round(session.lastContextWindow / 1000);
  const pct = Math.round((session.lastTokenUsage / session.lastContextWindow) * 100);

  appendCommandMessage(`Token Usage: ${usedK}k / ${totalK}k (${pct}%)`);
}

// Handler for /context command
function handleContextCommand() {
  const session = getActiveSession();
  if (!session || session.lastContextWindow === null) {
    appendCommandMessage('No context data yet. Send a message first.');
    return;
  }

  const usedK = session.lastTokenUsage ? Math.round(session.lastTokenUsage / 1000) : 0;
  const totalK = Math.round(session.lastContextWindow / 1000);
  const pct = session.lastTokenUsage ? Math.round((session.lastTokenUsage / session.lastContextWindow) * 100) : 0;
  const remaining = session.lastContextWindow - (session.lastTokenUsage || 0);
  const remainingK = Math.round(remaining / 1000);

  appendCommandMessage(`Context Window: ${totalK}k tokens total\nUsed: ${usedK}k (${pct}%)\nRemaining: ${remainingK}k`);
}

// Handler for /model command
function handleModelCommand() {
  appendCommandMessage('Model: Claude (via Claude Code SDK)\nModel switching is not yet supported in the web UI.');
}

// Append a command feedback message (styled differently from assistant messages)
function appendCommandMessage(content, session) {
  session = session || getActiveSession();
  if (!session?.containerEl) return;
  removeWelcome(session);
  const div = document.createElement('div');
  div.className = 'message command-feedback';
  div.style.borderLeft = '3px solid var(--neon-cyan)';
  div.style.fontFamily = 'monospace';
  div.style.whiteSpace = 'pre-wrap';
  div.textContent = content;
  session.containerEl.appendChild(div);
  scrollToBottom(session);
}

// Get all commands merged (builtin + global + project)
function getAllCommands() {
  const commandMap = new Map();

  // Add built-in commands first
  for (const cmd of BUILTIN_COMMANDS) {
    commandMap.set(cmd.name, cmd);
  }

  // Custom commands (global + project) override built-in if same name
  for (const cmd of state.customCommands) {
    commandMap.set(cmd.name, {
      name: cmd.name,
      desc: cmd.description,
      source: cmd.source
    });
  }

  return Array.from(commandMap.values());
}

// Load custom commands from the API
async function loadCustomCommands(projectPath = null) {
  try {
    let url = '/api/commands';
    if (projectPath) {
      url += `?projectPath=${encodeURIComponent(projectPath)}`;
    }
    state.customCommands = await api(url);
  } catch (err) {
    console.warn('[Commands] Failed to load custom commands:', err);
    state.customCommands = [];
  }
}


async function clearLegacyServiceWorkers() {
  if (!('serviceWorker' in navigator)) return false;

  try {
    const registrations = await navigator.serviceWorker.getRegistrations();
    if (registrations.length === 0) {
      sessionStorage.removeItem(SW_CLEANUP_RELOAD_KEY);
      return false;
    }

    await Promise.all(registrations.map(registration => registration.unregister()));

    if ('caches' in window) {
      const cacheNames = await caches.keys();
      await Promise.all(cacheNames.map(cacheName => caches.delete(cacheName)));
    }

    if (navigator.serviceWorker.controller && !sessionStorage.getItem(SW_CLEANUP_RELOAD_KEY)) {
      sessionStorage.setItem(SW_CLEANUP_RELOAD_KEY, '1');
      window.location.reload();
      return true;
    }

    sessionStorage.removeItem(SW_CLEANUP_RELOAD_KEY);
  } catch (err) {
    console.warn('[ServiceWorker] Cleanup failed:', err);
  }

  return false;
}

async function init() {
  if (await clearLegacyServiceWorkers()) return;

  const status = await api('/api/auth/status').catch(() => ({ needsSetup: true }));
  
  if (status.needsSetup) {
    authBtn.textContent = 'Create Account';
    authForm.dataset.mode = 'register';
  }
  
  if (state.token) {
    showMain();
  } else {
    showAuth();
  }
}

function showAuth() {
  authScreen.classList.remove('hidden');
  mainScreen.classList.add('hidden');
}

function showMain() {
  authScreen.classList.add('hidden');
  mainScreen.classList.remove('hidden');

  if ('Notification' in window && Notification.permission === 'default') {
    Notification.requestPermission().then(perm => {
      state.notificationsEnabled = perm === 'granted';
    });
  } else if ('Notification' in window) {
    state.notificationsEnabled = Notification.permission === 'granted';
  }
  loadCustomCommands();

  restoreSessionState().then(restored => {
    if (!restored) {
      restoreFromHash();
    }
    connectWebSocket();
    connectEventStream();
  });
}

async function restoreFromHash() {
  const route = parseHash();
  if (!route) return;

  console.log('[Session] Restoring from hash:', route);

  try {
    const { path: projectPath } = await api(`/api/projects/${encodeURIComponent(route.projectName)}/path`);
    const displayName = projectPath.split('/').pop();

    await selectProject(route.projectName, projectPath, displayName, true);
    closeSidebar();

    if (route.sessionId) {
      await resumeSession(route.sessionId, true);

      // Defensive check: ensure sessionId survived the restore flow
      const session = getActiveSession();
      if (session && !session.sessionId && route.sessionId) {
        console.warn('[Session] Hash restore: sessionId not set after resumeSession, forcing it');
        session.sessionId = route.sessionId;
      }
    } else {
      enableChat();
    }
    saveSessionState();
  } catch (err) {
    console.error('Failed to restore from hash:', err);
  }
}

authForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  const username = $('#username').value.trim();
  const password = $('#password').value;
  const isRegister = authForm.dataset.mode === 'register';
  
  authError.classList.add('hidden');
  authBtn.disabled = true;
  
  try {
    if (isRegister) {
      await api('/api/auth/register', { username, password });
      authBtn.textContent = 'Log In';
      authForm.dataset.mode = 'login';
      showAuthError('Account created! Please log in.');
      authBtn.disabled = false;
      return;
    }
    
    const { token } = await api('/api/auth/login', { username, password });
    state.token = token;
    localStorage.setItem('token', token);
    showMain();
  } catch (err) {
    showAuthError(err.message);
  } finally {
    authBtn.disabled = false;
  }
});

function showAuthError(msg) {
  authError.textContent = msg;
  authError.classList.remove('hidden');
}



function connectWebSocket() {
  if (state.ws?.readyState === WebSocket.OPEN) return;

  const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
  state.ws = new WebSocket(`${protocol}//${location.host}?token=${state.token}`);

  state.ws.onopen = () => {
    console.log('[WS] Connected (command channel)');
    state.wsReconnectAttempts = 0;
  };

  state.ws.onclose = () => {
    console.log('[WS] Disconnected');
    state.wsReconnectAttempts++;
    const delay = Math.min(1000 * Math.pow(2, state.wsReconnectAttempts), 30000);
    setTimeout(connectWebSocket, delay);
  };

  state.ws.onerror = (err) => {
    console.error('[WS] Error:', err);
  };
}

function connectEventStream() {
  if (state.eventSource) {
    state.eventSource.close();
    state.eventSource = null;
  }

  const es = new EventSource(`/api/events?token=${state.token}`);
  state.eventSource = es;

  es.onopen = () => {
    console.log('[SSE] Connected');
    state.sseConnected = true;
  };

  es.onmessage = (e) => {
    try {
      const event = JSON.parse(e.data);
      handleServerEvent(event);
    } catch (err) {
      console.warn('[SSE] Parse error:', err);
    }
  };

  es.onerror = () => {
    state.sseConnected = false;
    if (es.readyState === EventSource.CLOSED) {
      console.log('[SSE] Connection closed, reconnecting in 2s');
      setTimeout(connectEventStream, 2000);
    }
  };
}

function handleServerEvent(event) {
  if (event.type === 'heartbeat') return;

  if (event.type === 'state-snapshot') {
    if (event.sessions) {
      for (const serverSession of event.sessions) {
        const localSession = getSessionBySessionId(serverSession.sessionId);
        if (localSession) {
          localSession.isStreaming = (serverSession.status === 'streaming');
        }
      }
    }
    const activeSession = getActiveSession();
    if (activeSession) {
      if (activeSession.isStreaming) {
        abortBtn.classList.remove('hidden');
        chatInput.disabled = true;
        sendBtn.disabled = true;
        modeBtn.disabled = true;
        modelBtn.disabled = true;
        attachBtn.disabled = true;
      } else {
        abortBtn.classList.add('hidden');
        chatInput.disabled = false;
        sendBtn.disabled = false;
        modeBtn.disabled = false;
        modelBtn.disabled = false;
        attachBtn.disabled = false;
      }
    }
    return;
  }

  if (event.type === 'session-status') {
    const session = getSessionBySessionId(event.sessionId);
    if (session) {
      session.isStreaming = (event.status === 'streaming');
      if (state.sessions.indexOf(session) === state.activeSessionIndex) {
        if (session.isStreaming) {
          abortBtn.classList.remove('hidden');
          chatInput.disabled = true;
          sendBtn.disabled = true;
          modeBtn.disabled = true;
          modelBtn.disabled = true;
          attachBtn.disabled = true;
        } else {
          abortBtn.classList.add('hidden');
          chatInput.disabled = false;
          sendBtn.disabled = false;
          modeBtn.disabled = false;
          modelBtn.disabled = false;
          attachBtn.disabled = false;
        }
      }
    }
    return;
  }

  handleWsMessage(event);
}

function handleWsMessage(msg) {
  let session;

  if (msg.type === 'session-created') {
    session = state.sessions.find(s => s.sessionId === null && s.isStreaming);
    if (session) {
      session.sessionId = msg.sessionId;
      saveSessionState();
    }
  } else if (msg.sessionId) {
    session = getSessionBySessionId(msg.sessionId);
  } else {
    session = getActiveSession();
  }

  if (!session && msg.type !== 'pong') {
    console.warn('[WS] Message for unknown session:', msg.sessionId);
    return;
  }

  const isInactive = session && state.sessions.indexOf(session) !== state.activeSessionIndex;

  switch (msg.type) {
    case 'session-created':
      break;
    case 'claude-message':
      handleClaudeMessage(msg.data, session);
      if (isInactive) { session.hasUnread = true; renderSessionBar(); }
      break;
    case 'claude-done':
      finishStreaming(session);
      sendNotification('Claude finished', session.project.displayName || session.project.name);
      if (isInactive) { session.hasUnread = true; renderSessionBar(); }
      break;
    case 'token-usage':
      if (msg.model && session) session.model = msg.model;
      updateTokenUsage(msg, session);
      break;
    case 'abort-result':
      if (msg.success) finishStreaming(session);
      break;
    case 'question-response-result':
      break;
    case 'plan-response-result':
      break;
    case 'error':
      appendSystemMessage(`Error: ${msg.message}`, session);
      sendNotification('Error', msg.message);
      finishStreaming(session);
      if (isInactive) { session.hasUnread = true; renderSessionBar(); }
      break;
    // Task panel WebSocket handlers
    case 'task-started':
      if (session && msg.data) {
        addTask(session, {
          taskId: msg.data.taskId,
          title: msg.data.title,
          status: 'running',
          progress: msg.data.progress,
          parentId: msg.data.parentId,
          startTime: msg.data.startTime || Date.now()
        });
      }
      break;
    case 'task-progress':
      if (session && msg.data) {
        updateTask(session, msg.data.taskId, {
          status: 'running',
          progress: msg.data.progress
        });
      }
      break;
    case 'task-completed':
      if (session && msg.data) {
        updateTask(session, msg.data.taskId, {
          status: 'completed',
          progress: 100
        });
        // Auto-remove completed tasks after a delay
        setTimeout(() => {
          removeTask(session, msg.data.taskId);
        }, 3000);
      }
      break;
    case 'task-failed':
      if (session && msg.data) {
        updateTask(session, msg.data.taskId, {
          status: 'failed',
          error: msg.data.error
        });
      }
      break;
    case 'task-update':
      if (session && msg.data) {
        addTask(session, {
          taskId: msg.data.taskId,
          title: msg.data.title,
          status: msg.data.status || 'pending',
          progress: msg.data.progress,
          parentId: msg.data.parentId,
          startTime: msg.data.startTime || Date.now()
        });
      }
      break;
    case 'tasks-sync':
      if (session && msg.data) {
        syncTasks(session, msg.data.tasks || []);
      }
      break;
    case 'agent-activity':
      if (session) {
        session.activityState = msg.state === 'idle' ? null : {
          state: msg.state,
          label: msg.label,
          description: msg.description || null,
          elapsed: msg.elapsed || null,
          toolName: msg.toolName || null
        };
        if (session === getActiveSession()) {
          renderActivityStatus(session);
        }
      }
      break;
    case 'replay-start':
      if (session) {
        session.isReplaying = true;
        // Flush any existing streaming state before replay
        flushPendingText(session);
      }
      break;
    case 'replay-end':
      if (session) {
        session.isReplaying = false;
        flushPendingText(session);
        scrollToBottom(session);
      }
      break;
    case 'pong':
      break;
    default:
      console.debug('[WS] Unknown message type:', msg.type);
  }
}

function handleClaudeMessage(data, session) {
  if (!data) return;
  session = session || getActiveSession();
  if (!session) return;

  if (data.type === 'text') {
    session.isStreaming = true;
    session.pendingText = (session.pendingText || '') + data.content;

    // Store metadata for the current streaming message
    if (!session.currentMessageMetadata) {
      session.currentMessageMetadata = {
        timestamp: data.timestamp || null,
        messageId: data.messageId || null,
        model: data.model || null
      };
    }

    // During replay, render instantly without animation
    if (session.isReplaying) {
      let el = session.containerEl.querySelector('.message.streaming');
      if (!el) {
        el = document.createElement('div');
        el.className = 'message assistant streaming';
        if (session.currentMessageMetadata) {
          el.dataset.timestamp = session.currentMessageMetadata.timestamp || '';
          el.dataset.messageId = session.currentMessageMetadata.messageId || '';
          el.dataset.model = session.currentMessageMetadata.model || '';
        }
        session.containerEl.appendChild(el);
      }
      // Set text content directly without animation
      el.textContent = session.pendingText;
      return;
    }

    // Create renderer on first chunk (normal streaming)
    if (!session.streamingRenderer) {
      let el = session.containerEl.querySelector('.message.streaming');
      if (!el) {
        el = document.createElement('div');
        el.className = 'message assistant streaming';
        // Attach metadata to the element
        if (session.currentMessageMetadata) {
          el.dataset.timestamp = session.currentMessageMetadata.timestamp || '';
          el.dataset.messageId = session.currentMessageMetadata.messageId || '';
          el.dataset.model = session.currentMessageMetadata.model || '';
        }
        session.containerEl.appendChild(el);
      }
      session.streamingRenderer = new StreamingRenderer(el);
    }

    // Append network chunk to renderer
    session.streamingRenderer.appendNetworkChunk(data.content);
    scrollToBottom(session);
    return;
  }

  if (data.type === 'question') {
    flushPendingText(session);
    session.pendingQuestion = {
      id: data.id,
      questions: data.questions,
      selectedAnswers: {}
    };
    renderQuestion(data, session);
    return;
  }

  if (data.type === 'plan-confirmation') {
    // Ignore duplicate plan confirmations
    if (session.pendingPlanConfirmation) return;
    flushPendingText(session);
    session.pendingPlanConfirmation = {
      id: data.id
    };
    renderPlanConfirmation(data, session);
    return;
  }

  if (data.type === 'tool_use') {
    flushPendingText(session);
    // Pass enhanced metadata to appendToolMessage
    const toolMetadata = {
      timestamp: data.timestamp || null,
      messageId: data.messageId || null,
      model: data.model || null,
      startTime: data.startTime || null,
      summary: data.summary || null
    };
    // During replay, render tools as completed since the result follows immediately
    const status = session.isReplaying ? 'success' : 'running';
    appendToolMessage(data.tool, data.summary, data.id, status, session, toolMetadata, data.input);
    return;
  }

  if (data.type === 'tool_result') {
    // Pass timing metadata to updateToolResult
    const resultMetadata = {
      timestamp: data.timestamp || null,
      messageId: data.messageId || null,
      duration: data.duration || null,
      startTime: data.startTime || null
    };
    updateToolResult(data.id, data.success, data.output, session, resultMetadata);
    return;
  }
}

function flushPendingText(session) {
  session = session || getActiveSession();
  if (!session || !session.pendingText) return;

  if (session.streamingRenderer) {
    session.streamingRenderer.skipToEnd();
    session.streamingRenderer.destroy();
    session.streamingRenderer = null;

    // Remove streaming class after finalization
    const streamingEl = session.containerEl?.querySelector('.message.streaming');
    if (streamingEl) {
      streamingEl.classList.remove('streaming');
    }
  } else {
    // Fallback for non-streaming
    const streamingEl = session.containerEl?.querySelector('.message.streaming');
    if (streamingEl) {
      streamingEl.innerHTML = formatMarkdown(session.pendingText);
      streamingEl.classList.remove('streaming');
    }
  }

  session.pendingText = '';
  session.currentMessageMetadata = null;
}

function updateStreamingMessage(session) {
  session = session || getActiveSession();
  if (!session?.containerEl) return;

  let el = session.containerEl.querySelector('.message.streaming');
  if (!el) {
    el = document.createElement('div');
    el.className = 'message assistant streaming';
    // Attach metadata to the element
    if (session.currentMessageMetadata) {
      el.dataset.timestamp = session.currentMessageMetadata.timestamp || '';
      el.dataset.messageId = session.currentMessageMetadata.messageId || '';
      el.dataset.model = session.currentMessageMetadata.model || '';
    }
    session.containerEl.appendChild(el);
  }
  el.innerHTML = formatMarkdown(session.pendingText);
  scrollToBottom(session);
}

function renderActivityStatus(session) {
  const el = document.getElementById('activity-status');
  if (!el) return;

  const labelEl = el.querySelector('.activity-label');
  const elapsedEl = el.querySelector('.activity-elapsed');
  const indicatorEl = el.querySelector('.activity-indicator');

  if (!session || !session.activityState) {
    el.classList.add('hidden');
    indicatorEl.className = 'activity-indicator';
    return;
  }

  const { state, label, description, elapsed } = session.activityState;

  el.classList.remove('hidden');

  // Set indicator animation class
  indicatorEl.className = 'activity-indicator ' + state;

  // Set label text
  labelEl.textContent = description ? `${label} — ${description}` : (label || '');

  // Set elapsed timer
  if (elapsed != null) {
    elapsedEl.textContent = `${elapsed}s`;
    elapsedEl.classList.remove('hidden');
  } else {
    elapsedEl.classList.add('hidden');
  }
}

function finishStreaming(session) {
  session = session || getActiveSession();
  if (!session) return;
  session.isStreaming = false;
  session.pendingPlanConfirmation = null;
  session.activityState = null;
  renderActivityStatus(session);

  // Ensure renderer is cleaned up
  if (session.streamingRenderer) {
    session.streamingRenderer.skipToEnd();
    session.streamingRenderer.destroy();
    session.streamingRenderer = null;
  }

  flushPendingText(session);

  // Only update UI controls if this is the active session
  if (state.sessions.indexOf(session) === state.activeSessionIndex) {
    abortBtn.classList.add('hidden');
    chatInput.disabled = false;
    sendBtn.disabled = false;
    modeBtn.disabled = false;
    modelBtn.disabled = false;
    attachBtn.disabled = false;
  }

  // Scope question cancellation to session container
  if (session.containerEl) {
    const streamingEl = session.containerEl.querySelector('.message.streaming');
    if (streamingEl) streamingEl.classList.remove('streaming');
    if (session.pendingQuestion) {
      const questionBlock = session.containerEl.querySelector('.message.question-block:not(.submitted)');
      if (questionBlock) {
        questionBlock.classList.add('cancelled');
        const submitBtn = questionBlock.querySelector('.question-submit');
        if (submitBtn) { submitBtn.disabled = true; submitBtn.textContent = 'Cancelled'; }
        questionBlock.querySelectorAll('.question-option').forEach(opt => { opt.style.pointerEvents = 'none'; });
        questionBlock.querySelectorAll('.question-custom-input').forEach(input => { input.disabled = true; });
      }
      session.pendingQuestion = null;
    }
    // Also clean up any pending plan confirmation
    if (session.pendingPlanConfirmation) {
      const planBlock = session.containerEl.querySelector('.plan-confirmation-block:not(.submitted)');
      if (planBlock) {
        markPlanConfirmationSubmitted(planBlock, 'rejected');
      }
      session.pendingPlanConfirmation = null;
    }
  }
}

function appendMessage(role, content, session, attachments = null) {
  session = session || getActiveSession();
  if (!session?.containerEl) return;
  removeWelcome(session);
  const div = document.createElement('div');
  div.className = `message ${role}`;

  // For assistant messages, add message header with metadata
  if (role === 'assistant') {
    // Check if we have metadata from streaming
    const metadata = session.currentMessageMetadata || {};
    const timestamp = metadata.timestamp || null;
    const messageId = metadata.messageId || null;
    const model = metadata.model || null;

    let headerHtml = '';
    if (timestamp || messageId || model) {
      headerHtml = '<div class="message-header">';
      if (timestamp) {
        headerHtml += `<span class="message-timestamp" title="${escapeAttr(timestamp)}">${escapeHtml(formatTimestamp(timestamp))}</span>`;
      }
      if (messageId) {
        headerHtml += `<span class="message-id" title="${escapeAttr(messageId)}">· ${escapeHtml(getShortId(messageId))}</span>`;
      }
      if (model) {
        headerHtml += `<span class="model-badge">${escapeHtml(model)}</span>`;
      }
      headerHtml += '</div>';
    }

    div.innerHTML = headerHtml + formatMarkdown(content);

    // Store metadata on element for history loading
    if (timestamp) div.dataset.timestamp = timestamp;
    if (messageId) div.dataset.messageId = messageId;
    if (model) div.dataset.model = model;
  } else if (role === 'user' && attachments && attachments.length > 0) {
    // Render user message with image attachments
    const imageAttachments = attachments.filter(att => att.type === 'image');
    let contentHtml = escapeHtml(content);
    if (imageAttachments.length > 0) {
      const imagesHtml = imageAttachments.map(att =>
        `<img src="${att.data}" alt="${escapeAttr(att.name)}" class="message-image">`
      ).join('');
      contentHtml += `<div class="message-images">${imagesHtml}</div>`;
    }
    div.innerHTML = contentHtml;
  } else {
    div.innerHTML = escapeHtml(content);
  }

  session.containerEl.appendChild(div);
  scrollToBottom(session);
}

function appendSystemMessage(content, session) {
  session = session || getActiveSession();
  if (!session?.containerEl) return;
  removeWelcome(session);
  const div = document.createElement('div');
  div.className = 'message assistant';
  div.style.borderLeft = '3px solid var(--error)';
  div.textContent = content;
  session.containerEl.appendChild(div);
  scrollToBottom(session);
}

/**
 * Format timestamp to human-readable time
 * @param {string} isoString - ISO 8601 timestamp
 * @returns {string} Formatted time like "2:34 PM" or empty string if invalid
 */
function formatTimestamp(isoString) {
  if (!isoString) return '';
  const date = new Date(isoString);
  if (isNaN(date.getTime())) return '';
  return date.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
}

/**
 * Format duration in milliseconds to human-readable string
 * @param {number} durationMs - Duration in milliseconds
 * @returns {string} Formatted duration like "1.2s" or "234ms"
 */
function formatDuration(durationMs) {
  if (durationMs === null || durationMs === undefined) return '';
  const ms = Number(durationMs);
  if (isNaN(ms)) return '';
  if (ms < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}

/**
 * Get short UUID (last 8 characters)
 * @param {string} uuid - Full UUID
 * @returns {string} Short UUID
 */
function getShortId(uuid) {
  if (!uuid) return '';
  return uuid.slice(-8);
}

/**
 * Copy text to clipboard with optional feedback
 * @param {string} text - Text to copy
 * @param {HTMLElement} feedbackEl - Optional element for visual feedback
 */
function copyToClipboard(text, feedbackEl = null) {
  if (!text) return;
  navigator.clipboard.writeText(text).then(() => {
    if (feedbackEl) {
      const originalText = feedbackEl.textContent;
      feedbackEl.textContent = 'Copied!';
      setTimeout(() => {
        feedbackEl.textContent = originalText;
      }, 1500);
    }
  }).catch(err => {
    console.warn('Failed to copy:', err);
  });
}

function getToolIcon(tool) {
  const icons = {
    'Bash': '$',
    'Read': 'R',
    'Write': 'W',
    'Edit': 'E',
    'Glob': 'G',
    'Grep': '?',
    'Task': 'T',
    'TodoWrite': '✓',
    'Todowrite': '✓'
  };
  return icons[tool] || '*';
}

function renderToolDetails(tool, input) {
  if (!input || Object.keys(input).length === 0) return '';

  const normalizedTool = tool.toLowerCase();

  switch (normalizedTool) {
    case 'read':
      if (input.offset !== undefined && input.limit !== undefined) {
        return `Lines ${input.offset}-${input.offset + input.limit} of ${escapeHtml(input.file_path || 'file')}`;
      } else if (input.file_path) {
        return `Full file: ${escapeHtml(input.file_path)}`;
      }
      return '';

    case 'bash':
      if (input.command) {
        return `<code>${escapeHtml(input.command)}</code>`;
      }
      return '';

    case 'grep':
      let details = '';
      if (input.pattern) details += `Pattern: <code>${escapeHtml(input.pattern)}</code>`;
      if (input.glob) details += ` in <code>${escapeHtml(input.glob)}</code>`;
      if (input.type) details += ` (${escapeHtml(input.type)} files)`;
      return details;

    case 'edit':
      if (input.old_string && input.new_string) {
        return `${escapeHtml(input.old_string)}... → ${escapeHtml(input.new_string)}...`;
      }
      return '';

    case 'glob':
      if (input.pattern) {
        const pathInfo = input.path ? ` in ${escapeHtml(input.path)}` : '';
        return `Pattern: <code>${escapeHtml(input.pattern)}</code>${pathInfo}`;
      }
      return '';

    case 'task':
      if (input.description) {
        const agentInfo = input.subagent_type ? ` (${escapeHtml(input.subagent_type)})` : '';
        return `Delegating${agentInfo}: ${escapeHtml(input.description)}`;
      }
      return '';

    case 'write':
      if (input.file_path) {
        return `File: ${escapeHtml(input.file_path)}`;
      }
      return '';

    default:
      return '';
  }
}

function getCompactSummary(tool, input) {
  if (!input || Object.keys(input).length === 0) return '';

  const normalizedTool = tool.toLowerCase();

  switch (normalizedTool) {
    case 'bash':
      if (input.command) {
        const cmd = input.command.length > 60 ? input.command.slice(0, 57) + '...' : input.command;
        return `$ ${cmd}`;
      }
      return '';

    case 'read':
      if (input.file_path) {
        const parts = input.file_path.split('/');
        return parts[parts.length - 1];
      }
      return '';

    case 'write':
      if (input.file_path) {
        const parts = input.file_path.split('/');
        return parts[parts.length - 1];
      }
      return '';

    case 'edit':
      if (input.file_path) {
        const parts = input.file_path.split('/');
        return parts[parts.length - 1];
      }
      return '';

    case 'grep':
      if (input.pattern) {
        const pat = input.pattern.length > 40 ? input.pattern.slice(0, 37) + '...' : input.pattern;
        return pat;
      }
      return '';

    case 'glob':
      if (input.pattern) {
        return input.pattern;
      }
      return '';

    case 'task':
      if (input.description) {
        const desc = input.description.length > 50 ? input.description.slice(0, 47) + '...' : input.description;
        return desc;
      }
      return '';

    default:
      return '';
  }
}

// Tool Clustering: Group consecutive tool pills into a collapsible cluster
const CLUSTER_THRESHOLD = 3; // Minimum pills to form a cluster

function maybeCluster(session) {
  if (!session?.containerEl) return;

  const children = Array.from(session.containerEl.children);

  // Find consecutive run of unclustered tool pills at the END of the container
  let run = [];
  for (let i = children.length - 1; i >= 0; i--) {
    const child = children[i];
    if (child.classList.contains('tool-pill') && !child.closest('.tool-cluster')) {
      run.unshift(child);
    } else if (child.classList.contains('tool-cluster')) {
      // Found an existing cluster at the end - stop here, we may add to it
      break;
    } else {
      break; // Hit a non-tool message, stop
    }
  }

  if (run.length < CLUSTER_THRESHOLD) return; // Not enough to cluster

  // Check if there's already a cluster right before this run
  const firstPill = run[0];
  const prevSibling = firstPill.previousElementSibling;

  if (prevSibling && prevSibling.classList.contains('tool-cluster')) {
    // Add pills to existing cluster
    const clusterBody = prevSibling.querySelector('.tool-cluster-body');
    run.forEach(pill => clusterBody.appendChild(pill));
    updateClusterHeader(prevSibling);
  } else {
    // Create new cluster
    const cluster = document.createElement('div');
    cluster.className = 'tool-cluster';

    const header = document.createElement('div');
    header.className = 'tool-cluster-header';
    header.innerHTML = '<span class="tool-cluster-chevron">&#x25BE;</span> <span class="tool-cluster-summary"></span>';
    header.classList.add('expanded');

    const body = document.createElement('div');
    body.className = 'tool-cluster-body';

    // Insert cluster where first pill was
    firstPill.parentNode.insertBefore(cluster, firstPill);
    cluster.appendChild(header);
    cluster.appendChild(body);

    // Move pills into cluster body
    run.forEach(pill => body.appendChild(pill));

    updateClusterHeader(cluster);

    // Click handler for cluster header
    header.addEventListener('click', () => {
      const isExpanded = !body.classList.contains('hidden');
      body.classList.toggle('hidden');
      header.classList.toggle('expanded');
      const chevron = header.querySelector('.tool-cluster-chevron');
      if (chevron) {
        chevron.textContent = isExpanded ? '\u25B8' : '\u25BE';
      }
    });
  }
}

function updateClusterHeader(cluster) {
  const pills = cluster.querySelectorAll('.message.tool-pill');
  const total = pills.length;

  // Count by tool type
  const toolCounts = {};
  let doneCount = 0;
  let errorCount = 0;

  pills.forEach(pill => {
    const toolName = pill.dataset.tool || 'unknown';
    toolCounts[toolName] = (toolCounts[toolName] || 0) + 1;
    if (pill.classList.contains('success')) doneCount++;
    if (pill.classList.contains('error')) errorCount++;
  });

  const running = total - doneCount - errorCount;

  // Build summary: "5 tool calls (3 Bash, 2 Grep)"
  const breakdown = Object.entries(toolCounts)
    .map(([tool, count]) => `${count} ${tool}`)
    .join(', ');

  let statusStr = '';
  if (running > 0) {
    statusStr = ` \u2014 ${doneCount}/${total} done`;
  } else if (errorCount > 0) {
    statusStr = ` \u2014 ${doneCount} done, ${errorCount} failed`;
  } else {
    statusStr = ` \u2014 all done`;
  }

  const summaryEl = cluster.querySelector('.tool-cluster-summary');
  if (summaryEl) {
    summaryEl.textContent = `${total} tool calls (${breakdown})${statusStr}`;
  }
}

function appendToolMessage(tool, summary, id, status, session, metadata = null, input = null) {
  session = session || getActiveSession();
  if (!session?.containerEl) return;
  removeWelcome(session);

  const div = document.createElement('div');
  div.className = `message tool-pill ${status}`;
  div.dataset.toolId = id || '';
  div.dataset.tool = tool.toLowerCase();  // For CSS color selectors

  // Store metadata
  if (metadata) {
    div.dataset.timestamp = metadata.timestamp || '';
    div.dataset.messageId = metadata.messageId || '';
    div.dataset.model = metadata.model || '';
    div.dataset.startTime = metadata.startTime || '';
  }

  const serverSummary = typeof summary === 'object' ? (summary.summary || JSON.stringify(summary)) : summary;
  const compactSummary = getCompactSummary(tool, input || {}) || serverSummary;
  const detailsHtml = renderToolDetails(tool, input || {});

  const statusText = status === 'running' ? '⋯' : status === 'success' ? '✓' : '✗';
  const durationHtml = status === 'running' ? '<span class="tool-pill-duration">0.0s</span>' : '';

  div.innerHTML = `
    <div class="tool-pill-header expanded" data-tool-id="${escapeHtml(id || '')}">
      <div class="tool-pill-top">
        <div style="display: flex; align-items: center; gap: 4px;">
          <span class="tool-pill-icon">${getToolIcon(tool)}</span>
          <span class="tool-pill-name">${escapeHtml(tool)}</span>
          <span class="tool-pill-summary">${escapeHtml(compactSummary)}</span>
          <span class="tool-pill-chevron">▾</span>
        </div>
        <div style="display: flex; align-items: center; gap: 4px;">
          <span class="tool-pill-status ${status}">${statusText}</span>
          ${durationHtml}
        </div>
      </div>
    </div>
    <div class="tool-pill-output">${detailsHtml ? `<div class="tool-pill-output-command">${detailsHtml}</div>` : ''}</div>
  `;

  session.containerEl.appendChild(div);
  scrollToBottom(session);
  maybeCluster(session);
}

function updateToolResult(id, success, output, session, resultMetadata = null) {
  session = session || getActiveSession();
  if (!session?.containerEl) return;

  const toolMsgs = session.containerEl.querySelectorAll('.message.tool-pill');
  let target = null;

  if (id) {
    target = session.containerEl.querySelector(`.message.tool-pill[data-tool-id="${id}"]`);
  }
  if (!target && toolMsgs.length > 0) {
    target = toolMsgs[toolMsgs.length - 1];
  }

  if (target) {
    target.classList.remove('running');
    target.classList.add(success ? 'success' : 'error');

    const statusEl = target.querySelector('.tool-pill-status');
    if (statusEl) {
      statusEl.textContent = success ? '✓' : '✗';
      statusEl.className = `tool-pill-status ${success ? 'success' : 'error'}`;
    }

    // Store result metadata (duration, etc.) and display duration
    if (resultMetadata) {
      if (resultMetadata.duration !== null && resultMetadata.duration !== undefined) {
        target.dataset.duration = String(resultMetadata.duration);
        const durationEl = target.querySelector('.tool-pill-duration');
        if (durationEl) {
          durationEl.textContent = formatDuration(resultMetadata.duration);
        }
      }
      if (resultMetadata.timestamp) {
        target.dataset.resultTimestamp = resultMetadata.timestamp;
      }
    }

    if (output && output.trim()) {
      const outputEl = target.querySelector('.tool-pill-output');
      if (outputEl) {
        // If there's an existing command detail div, keep it and append output after
        const existingCommand = outputEl.querySelector('.tool-pill-output-command');
        if (existingCommand) {
          const outputText = document.createElement('pre');
          outputText.textContent = output;
          outputEl.appendChild(outputText);
        } else {
          outputEl.textContent = output;
        }

        // Always show output expanded
        outputEl.classList.remove('hidden');
        const header = target.querySelector('.tool-pill-header');
        if (header) header.classList.add('expanded');
      }
    }

    // Update cluster header if this pill is inside a cluster
    const parentCluster = target.closest('.tool-cluster');
    if (parentCluster) {
      updateClusterHeader(parentCluster);
    }
  }
  scrollToBottom(session);
}



function renderQuestion(data, session) {
  session = session || getActiveSession();
  if (!session?.containerEl) return;
  removeWelcome(session);

  const div = document.createElement('div');
  div.className = 'message question-block';
  div.dataset.questionId = data.id;

  let html = '';

  data.questions.forEach((q, qIndex) => {
    const isMultiple = q.multiSelect || q.multiple || false;

    html += `
      <div class="question-group" data-question-index="${qIndex}" data-multiple="${isMultiple}">
        <div class="question-header">${escapeHtml(q.header || '')}</div>
        <div class="question-text">${escapeHtml(q.question)}</div>
        <div class="question-options">
    `;

    if (q.options && q.options.length > 0) {
      q.options.forEach(opt => {
        html += `
          <div class="question-option" data-label="${escapeAttr(opt.label)}" data-qindex="${qIndex}">
            <span class="option-label">${escapeHtml(opt.label)}</span>
            ${opt.description ? `<span class="option-desc">${escapeHtml(opt.description)}</span>` : ''}
          </div>
        `;
      });
    }

    html += `
        </div>
        <div class="question-custom-container">
          <input type="text" class="question-custom-input" data-qindex="${qIndex}" placeholder="Type your own answer...">
        </div>
      </div>
    `;
  });

  html += `
    <button class="question-submit" disabled>Submit Answer</button>
  `;

  div.innerHTML = html;
  session.containerEl.appendChild(div);

  div.querySelectorAll('.question-option').forEach(opt => {
    opt.addEventListener('click', () => handleOptionSelect(opt));
  });

  div.querySelectorAll('.question-custom-input').forEach(input => {
    input.addEventListener('input', () => handleCustomInputChange(input));
  });

  div.querySelector('.question-submit').addEventListener('click', submitQuestionResponse);

  scrollToBottom(session);
}

function renderPlanConfirmation(data, session) {
  if (!session || !session.containerEl) return;

  const div = document.createElement('div');
  div.className = 'message plan-confirmation-block';
  div.dataset.confirmationId = data.id;

  div.innerHTML = `
    <div class="plan-confirmation-header">
      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
        <path d="M9 11l3 3L22 4"/>
        <path d="M21 12v7a2 2 0 01-2 2H5a2 2 0 01-2-2V5a2 2 0 012-2h11"/>
      </svg>
      <span>Plan complete. Ready to implement?</span>
    </div>
    <div class="plan-confirmation-actions">
      <button class="plan-confirm-btn plan-approve-btn" data-action="approve">Approve Plan</button>
      <button class="plan-confirm-btn plan-reject-btn" data-action="reject">Reject &amp; Revise</button>
    </div>
    <div class="plan-feedback-container hidden">
      <input type="text" class="plan-feedback-input" placeholder="What should be revised? (optional)">
      <button class="plan-confirm-btn plan-send-feedback-btn">Send Feedback</button>
    </div>
  `;

  // Approve button handler
  div.querySelector('.plan-approve-btn').addEventListener('click', () => {
    sendPlanResponse(session, data.id, true, null);
    markPlanConfirmationSubmitted(div, 'approved');
  });

  // Reject button handler - shows feedback input
  div.querySelector('.plan-reject-btn').addEventListener('click', () => {
    div.querySelector('.plan-feedback-container').classList.remove('hidden');
    div.querySelector('.plan-reject-btn').classList.add('hidden');
    div.querySelector('.plan-feedback-input').focus();
  });

  // Send feedback button handler
  div.querySelector('.plan-send-feedback-btn').addEventListener('click', () => {
    const feedback = div.querySelector('.plan-feedback-input').value.trim();
    sendPlanResponse(session, data.id, false, feedback || null);
    markPlanConfirmationSubmitted(div, 'rejected');
  });

  // Also allow Enter key on feedback input
  div.querySelector('.plan-feedback-input').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      const feedback = e.target.value.trim();
      sendPlanResponse(session, data.id, false, feedback || null);
      markPlanConfirmationSubmitted(div, 'rejected');
    }
  });

  session.containerEl.appendChild(div);
  scrollToBottom(session);
}

function handleOptionSelect(optionEl) {
  const qIndex = parseInt(optionEl.dataset.qindex);
  const label = optionEl.dataset.label;
  const questionGroup = optionEl.closest('.question-group');
  const isMultiple = questionGroup.dataset.multiple === 'true';

  const session = getActiveSession();
  if (!session || !session.pendingQuestion) return;

  if (!session.pendingQuestion.selectedAnswers[qIndex]) {
    session.pendingQuestion.selectedAnswers[qIndex] = [];
  }

  const answers = session.pendingQuestion.selectedAnswers[qIndex];
  const existingIndex = answers.indexOf(label);

  if (isMultiple) {
    if (existingIndex >= 0) {
      answers.splice(existingIndex, 1);
      optionEl.classList.remove('selected');
    } else {
      answers.push(label);
      optionEl.classList.add('selected');
    }
  } else {
    questionGroup.querySelectorAll('.question-option').forEach(opt => {
      opt.classList.remove('selected');
    });
    session.pendingQuestion.selectedAnswers[qIndex] = [label];
    optionEl.classList.add('selected');
  }

  const customInput = questionGroup.querySelector('.question-custom-input');
  if (customInput) {
    customInput.value = '';
  }

  updateSubmitButtonState();
}

function handleCustomInputChange(inputEl) {
  const qIndex = parseInt(inputEl.dataset.qindex);
  const value = inputEl.value.trim();
  const questionGroup = inputEl.closest('.question-group');

  const session = getActiveSession();
  if (!session || !session.pendingQuestion) return;

  questionGroup.querySelectorAll('.question-option').forEach(opt => {
    opt.classList.remove('selected');
  });

  if (value) {
    session.pendingQuestion.selectedAnswers[qIndex] = [value];
  } else {
    delete session.pendingQuestion.selectedAnswers[qIndex];
  }

  updateSubmitButtonState();
}

function updateSubmitButtonState() {
  const session = getActiveSession();
  if (!session || !session.pendingQuestion || !session.containerEl) return;

  const questionBlock = session.containerEl.querySelector(
    `.message.question-block[data-question-id="${session.pendingQuestion.id}"]`
  );
  if (!questionBlock) return;

  const submitBtn = questionBlock.querySelector('.question-submit');
  const totalQuestions = session.pendingQuestion.questions.length;
  const answeredQuestions = Object.keys(session.pendingQuestion.selectedAnswers).filter(
    key => session.pendingQuestion.selectedAnswers[key]?.length > 0
  ).length;

  submitBtn.disabled = answeredQuestions < totalQuestions;
}

function submitQuestionResponse() {
  const session = getActiveSession();
  if (!session || !session.pendingQuestion || !session.sessionId) return;

  const answers = session.pendingQuestion.selectedAnswers;

  state.ws.send(JSON.stringify({
    type: 'question-response',
    sessionId: session.sessionId,
    toolUseId: session.pendingQuestion.id,
    answers: answers
  }));

  const questionBlock = session.containerEl?.querySelector(
    `.message.question-block[data-question-id="${session.pendingQuestion.id}"]`
  );
  if (questionBlock) {
    questionBlock.classList.add('submitted');
    const submitBtn = questionBlock.querySelector('.question-submit');
    if (submitBtn) {
      submitBtn.disabled = true;
      submitBtn.textContent = 'Submitted';
    }
    questionBlock.querySelectorAll('.question-option').forEach(opt => {
      opt.style.pointerEvents = 'none';
    });
    questionBlock.querySelectorAll('.question-custom-input').forEach(input => {
      input.disabled = true;
    });
  }

  session.pendingQuestion = null;
}

function sendPlanResponse(session, toolUseId, approved, feedback) {
  if (!session || !session.sessionId || !state.ws) return;
  state.ws.send(JSON.stringify({
    type: 'plan-response',
    sessionId: session.sessionId,
    toolUseId: toolUseId,
    approved: approved,
    feedback: feedback
  }));
}

function markPlanConfirmationSubmitted(element, status) {
  element.classList.add('submitted');
  const actions = element.querySelector('.plan-confirmation-actions');
  const feedbackContainer = element.querySelector('.plan-feedback-container');
  if (actions) actions.innerHTML = `<span class="plan-status plan-status-${status}">${status === 'approved' ? 'Plan approved' : 'Plan rejected — revising...'}</span>`;
  if (feedbackContainer) feedbackContainer.classList.add('hidden');
}

function removeWelcome(session) {
  session = session || getActiveSession();
  if (!session?.containerEl) return;
  const welcome = session.containerEl.querySelector('.welcome-message');
  if (welcome) welcome.remove();
}

function clearMessages(session) {
  session = session || getActiveSession();
  if (!session?.containerEl) return;
  const isResuming = !!session.sessionId;
  session.containerEl.innerHTML = `
    <div class="welcome-message">
      <h2>${isResuming ? 'Continuing Session' : 'New Session'}</h2>
      <p>${isResuming ? 'Continuing session - conversation context preserved.' : 'New session - no conversation history.'}</p>
    </div>
  `;
  session.pendingText = '';
}

function updateScrollFAB(session) {
  const active = getActiveSession();
  if (!session || session !== active) return;
  if (session.isAtBottom || session.unreadCount === 0) {
    scrollToBottomBtn.classList.add('hidden');
  } else {
    scrollToBottomBtn.classList.remove('hidden');
    if (session.unreadCount > 0) {
      unreadBadge.textContent = session.unreadCount;
      unreadBadge.classList.remove('hidden');
    } else {
      unreadBadge.classList.add('hidden');
    }
  }
}

function scrollToBottom(session) {
  session = session || getActiveSession();
  if (!session?.containerEl) return;
  if (session.isAtBottom !== false) {
    requestAnimationFrame(() => {
      session.containerEl.scrollTop = session.containerEl.scrollHeight;
    });
  } else {
    session.unreadCount++;
    updateScrollFAB(session);
  }
}

scrollToBottomBtn.addEventListener('click', () => {
  const session = getActiveSession();
  if (!session?.containerEl) return;
  session.containerEl.scrollTo({ top: session.containerEl.scrollHeight, behavior: 'smooth' });
  session.unreadCount = 0;
  session.isAtBottom = true;
  updateScrollFAB(session);
});

chatForm.addEventListener('submit', (e) => {
  e.preventDefault();
  const content = chatInput.value.trim();
  const session = getActiveSession();
  if (!content || session?.isStreaming) return;

  if (!session) {
    alert('Please select a project first (tap the menu icon)');
    return;
  }

  sendMessage(content);
});

function sendMessage(content) {
  // Check if this is a local built-in command (e.g., /clear, /help, /tokens)
  // Commands like /compact and /verbose are NOT in the handler map and will be sent to Claude
  if (isLocalBuiltinCommand(content)) {
    const { command, args } = parseCommand(content);
    executeBuiltinCommand(command, args);
    chatInput.value = '';
    chatInput.style.height = 'auto';
    return; // Don't send to Claude
  }

  const session = getActiveSession();
  if (!session) {
    appendCommandMessage('Please create or select a session first.');
    return;
  }

  const mode = MODES[state.modeIndex];

  console.log('[Session] Sending message with sessionId:', session.sessionId, 'isNewSession:', !session.sessionId);

  // Context loss detection: warn if sending as new session but UI already shows messages
  if (!session.sessionId && session.containerEl && session.containerEl.children.length > 1) {
    console.warn('[Session] WARNING: Sending as new session but UI shows existing messages - possible context loss');
  }

  const message = {
    type: 'chat',
    content: content,
    mode: mode.name,
    model: state.selectedModel,
    projectPath: session.project.path,
    sessionId: session.sessionId,
    isNewSession: !session.sessionId
  };

  // Add attachments if present
  if (session.attachments.length > 0) {
    message.attachments = session.attachments.map(att => ({
      type: att.type,
      name: att.name,
      data: att.data,
      mediaType: att.mediaType
    }));
  }

  if (!state.ws || state.ws.readyState !== WebSocket.OPEN) {
    appendSystemMessage('Connection lost. Reconnecting...', session);
    session.isStreaming = false;
    chatInput.disabled = false;
    sendBtn.disabled = false;
    modeBtn.disabled = false;
    modelBtn.disabled = false;
    attachBtn.disabled = false;
    return;
  }
  state.ws.send(JSON.stringify(message));

  // Show user message with attachments displayed as images
  const displayContent = formatUserMessageWithAttachments(content, session.attachments);
  appendMessage('user', displayContent, session, session.attachments);

  // Clear attachments after sending
  session.attachments = [];
  renderAttachmentPreview();

  chatInput.value = '';
  chatInput.style.height = 'auto';

  session.isStreaming = true;
  abortBtn.classList.remove('hidden');
  chatInput.disabled = true;
  sendBtn.disabled = true;
  modeBtn.disabled = true;
  modelBtn.disabled = true;
  attachBtn.disabled = true;
}

chatInput.addEventListener('input', () => {
  chatInput.style.height = 'auto';
  chatInput.style.height = Math.min(chatInput.scrollHeight, 150) + 'px';
});

chatInput.addEventListener('keydown', (e) => {
  // Shift+Tab cycles through modes
  if (e.key === 'Tab' && e.shiftKey) {
    e.preventDefault();
    cycleMode();
    return;
  }
  if (slashCommandsEl && !slashCommandsEl.classList.contains('hidden')) {
    if (handleSlashCommandKeydown(e)) return;
  }
  if (fileMentionsEl && !fileMentionsEl.classList.contains('hidden')) {
    if (handleFileMentionKeydown(e)) return;
  }
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault();
    chatForm.dispatchEvent(new Event('submit'));
  }
});

chatInput.addEventListener('input', handleSlashCommandInput);
chatInput.addEventListener('input', handleFileMentionInput);
chatInput.addEventListener('blur', () => {
  setTimeout(hideSlashCommands, 150);
  setTimeout(hideFileMentions, 150);
});

// Code block copy button delegation
sessionContainersEl.addEventListener('click', (e) => {
  const copyBtn = e.target.closest('.code-copy-btn');
  if (copyBtn) {
    const wrapper = copyBtn.closest('.code-block-wrapper');
    const codeEl = wrapper?.querySelector('code');
    if (codeEl) {
      navigator.clipboard.writeText(codeEl.textContent).then(() => {
        copyBtn.textContent = 'Copied!';
        setTimeout(() => { copyBtn.textContent = 'Copy'; }, 2000);
      });
    }
  }

  // Message ID click to copy full UUID
  const messageIdEl = e.target.closest('.message-id');
  if (messageIdEl) {
    const fullId = messageIdEl.title;
    if (fullId) {
      copyToClipboard(fullId, messageIdEl);
    }
    e.preventDefault();
  }

  // File link click to copy path to clipboard
  const fileLinkEl = e.target.closest('.file-link');
  if (fileLinkEl) {
    const path = fileLinkEl.dataset.path;
    if (path) {
      copyToClipboard(path, fileLinkEl);
    }
    e.preventDefault();
  }
});

// Session tab event delegation
sessionTabsEl.addEventListener('click', (e) => {
  const closeBtn = e.target.closest('.close-tab');
  if (closeBtn) {
    const tab = closeBtn.closest('.session-tab');
    closeSession(parseInt(tab.dataset.index));
    return;
  }
  const tab = e.target.closest('.session-tab');
  if (tab) {
    // On mobile: first tap shows close button, second tap switches session
    const isMobile = window.matchMedia('(max-width: 767px)').matches;
    if (isMobile && !tab.classList.contains('show-close')) {
      sessionTabsEl.querySelectorAll('.session-tab').forEach(t => t.classList.remove('show-close'));
      tab.classList.add('show-close');
      return;
    }
    switchToSession(parseInt(tab.dataset.index));
  }
});

// Dismiss close button when tapping outside session tabs on mobile
document.addEventListener('click', (e) => {
  if (!e.target.closest('#session-bar')) {
    document.querySelectorAll('.session-tab.show-close').forEach(t => t.classList.remove('show-close'));
  }
});

// Tool pill expand/collapse delegation
sessionContainersEl.addEventListener('click', (e) => {
  const header = e.target.closest('.tool-pill-header');
  if (!header) return;

  const pill = header.closest('.message.tool-pill');
  if (!pill) return;

  const output = pill.querySelector('.tool-pill-output');
  if (!output) return;

  // Toggle expanded state
  const isExpanded = !output.classList.contains('hidden');
  if (isExpanded) {
    output.classList.add('hidden');
    header.classList.remove('expanded');
  } else {
    output.classList.remove('hidden');
    header.classList.add('expanded');
  }
});


// Keyboard shortcuts for session switching (Ctrl+1 through Ctrl+5)
document.addEventListener('keydown', (e) => {
  if (e.ctrlKey && !e.shiftKey && !e.altKey && !e.metaKey) {
    const num = parseInt(e.key);
    if (num >= 1 && num <= MAX_SESSIONS) {
      e.preventDefault();
      const index = num - 1;
      if (index < state.sessions.length) {
        switchToSession(index);
      }
    }
  }
});

// Mobile keyboard handling - scroll input into view when focused
chatInput.addEventListener('focus', () => {
  setTimeout(() => {
    chatInput.scrollIntoView({ behavior: 'smooth', block: 'center' });
  }, 300);
});

// Visual Viewport API for better mobile keyboard handling
if (window.visualViewport) {
  window.visualViewport.addEventListener('resize', () => {
    if (document.activeElement === chatInput) {
      chatInput.scrollIntoView({ behavior: 'smooth', block: 'center' });
    }
  });
}

// Mobile keyboard handling for Monaco Editor
function handleEditorViewportResize() {
  if (!window.visualViewport) return;
  if (!editorScreen || editorScreen.classList.contains('hidden')) return;

  const vv = window.visualViewport;
  editorScreen.style.top = `${vv.offsetTop}px`;
  editorScreen.style.height = `${vv.height}px`;
  editorScreen.style.bottom = 'auto';

  // Tell Monaco to recalculate its layout dimensions
  if (monacoEditor) {
    monacoEditor.layout();
  }
}

function resetEditorViewport() {
  if (!editorScreen) return;
  editorScreen.style.top = '';
  editorScreen.style.height = '';
  editorScreen.style.bottom = '';
  if (monacoEditor) {
    monacoEditor.layout();
  }
}

if (window.visualViewport) {
  window.visualViewport.addEventListener('resize', handleEditorViewportResize);
  window.visualViewport.addEventListener('scroll', handleEditorViewportResize);
}

function calculateCommandScore(cmd, query) {
  const nameLower = cmd.name.toLowerCase();

  // Highest priority: exact name match
  if (nameLower === query) return 1000;

  // High priority: name starts with query (prefix match)
  if (nameLower.startsWith(query)) return 500 + (query.length * 10);

  // Medium priority: query is a word in the name (for multi-word commands)
  const words = nameLower.split(/[\s_-]/);
  if (words.some(word => word === query)) return 300 + (query.length * 10);

  // Lower priority: name contains the query anywhere (substring match)
  if (nameLower.includes(query)) return 100 + (query.length * 10);

  // No match
  return 0;
}

function handleSlashCommandInput() {
  const value = chatInput.value;

  if (!value.startsWith('/')) {
    hideSlashCommands();
    return;
  }

  const query = value.slice(1).toLowerCase();
  const allCommands = getAllCommands();

  // Score and filter commands by name only
  const scoredCommands = allCommands
    .map(cmd => ({ cmd, score: calculateCommandScore(cmd, query) }))
    .filter(item => item.score > 0)
    .sort((a, b) => b.score - a.score)  // Sort descending by score
    .map(item => item.cmd);  // Extract commands

  if (scoredCommands.length === 0) {
    hideSlashCommands();
    return;
  }

  renderSlashCommands(scoredCommands);
  showSlashCommands();
}

function renderSlashCommands(commands) {
  const session = getActiveSession();
  if (session) session.slashCommandSelectedIndex = 0;

  slashCommandsEl.innerHTML = commands.map((cmd, i) => {
    const sourceClass = `source-${cmd.source || 'builtin'}`;
    const sourceLabel = ['global', 'project', 'skill'].includes(cmd.source) ? cmd.source : '';
    return `
      <div class="slash-command${i === 0 ? ' selected' : ''}" data-command="${escapeAttr(cmd.name)}">
        <div class="slash-command-header">
          <span class="slash-command-name">${escapeHtml(cmd.name)}</span>
          ${sourceLabel ? `<span class="slash-command-source ${sourceClass}">${sourceLabel}</span>` : ''}
        </div>
        <div class="slash-command-desc">${escapeHtml(cmd.desc)}</div>
      </div>
    `;
  }).join('');
}

// Event delegation for slash commands (avoids memory leaks)
slashCommandsEl.addEventListener('click', (e) => {
  const commandEl = e.target.closest('.slash-command');
  if (commandEl) {
    insertSlashCommand(commandEl.dataset.command);
  }
});

function showSlashCommands() {
  slashCommandsEl.classList.remove('hidden');
}

function hideSlashCommands() {
  slashCommandsEl.classList.add('hidden');
  const session = getActiveSession();
  if (session) session.slashCommandSelectedIndex = -1;
}

function handleSlashCommandKeydown(e) {
  const session = getActiveSession();
  if (!session) return false;

  const items = slashCommandsEl.querySelectorAll('.slash-command');
  if (items.length === 0) return false;

  if (e.key === 'ArrowDown') {
    e.preventDefault();
    session.slashCommandSelectedIndex = Math.min(session.slashCommandSelectedIndex + 1, items.length - 1);
    updateSlashCommandSelection(items);
    return true;
  }

  if (e.key === 'ArrowUp') {
    e.preventDefault();
    session.slashCommandSelectedIndex = Math.max(session.slashCommandSelectedIndex - 1, 0);
    updateSlashCommandSelection(items);
    return true;
  }

  if (e.key === 'Enter' || e.key === 'Tab') {
    e.preventDefault();
    const selected = items[session.slashCommandSelectedIndex];
    if (selected) {
      const command = selected.dataset.command;
      // If it's a local builtin command and Enter (not Tab), execute immediately
      if (e.key === 'Enter' && isLocalBuiltinCommand(command)) {
        hideSlashCommands();
        const { command: cmd, args } = parseCommand(command);
        executeBuiltinCommand(cmd, args);
        chatInput.value = '';
        chatInput.style.height = 'auto';
        return true;
      }
      insertSlashCommand(command);
    }
    return true;
  }

  if (e.key === 'Escape') {
    e.preventDefault();
    hideSlashCommands();
    return true;
  }

  return false;
}

function updateSlashCommandSelection(items) {
  const session = getActiveSession();
  if (!session) return;

  items.forEach((item, i) => {
    item.classList.toggle('selected', i === session.slashCommandSelectedIndex);
  });
  items[session.slashCommandSelectedIndex]?.scrollIntoView({ block: 'nearest' });
}

function insertSlashCommand(command) {
  // Replace existing text with the command
  chatInput.value = command + ' ';

  chatInput.focus();
  // Move cursor to end of input
  chatInput.selectionStart = chatInput.selectionEnd = chatInput.value.length;
  hideSlashCommands();
  chatInput.dispatchEvent(new Event('input'));
}

// File Mention Functions
function handleFileMentionInput() {
  const session = getActiveSession();
  if (!session) return;

  const value = chatInput.value;
  const cursorPos = chatInput.selectionStart;
  const textBeforeCursor = value.slice(0, cursorPos);
  const lastAtIndex = textBeforeCursor.lastIndexOf('@');

  // No @ found or @ is at the very end with nothing after it
  if (lastAtIndex === -1) {
    hideFileMentions();
    return;
  }

  const textAfterAt = textBeforeCursor.slice(lastAtIndex + 1);

  // Check if there's whitespace after @ (which would mean @ mention is complete)
  if (textAfterAt.includes(' ')) {
    hideFileMentions();
    return;
  }

  // Check if we're at the start or after whitespace
  if (lastAtIndex > 0 && textBeforeCursor[lastAtIndex - 1] !== ' ' && textBeforeCursor[lastAtIndex - 1] !== '\n') {
    // @ is in the middle of a word, don't trigger
    hideFileMentions();
    return;
  }

  session.fileMentionQuery = textAfterAt;
  session.fileMentionStartPos = lastAtIndex;

  // Debounce the API call
  clearTimeout(session.fileMentionDebounceTimer);
  session.fileMentionDebounceTimer = setTimeout(() => {
    fetchFileMentions(session.fileMentionQuery);
  }, 300);
}

async function fetchFileMentions(query) {
  const session = getActiveSession();
  // Check if project is selected
  if (!session) {
    renderFileMentions([], 'no-project');
    showFileMentions();
    return;
  }

  try {
    const { files } = await api(`/api/projects/${encodeURIComponent(session.project.name)}/files/search?q=${encodeURIComponent(query)}`);
    renderFileMentions(files);
    showFileMentions();
  } catch (err) {
    console.error('[FileMention] Failed to fetch files:', err);
    hideFileMentions();
  }
}

function renderFileMentions(files, displayState = 'normal') {
  const session = getActiveSession();
  if (session) session.fileMentionSelectedIndex = 0;

  if (displayState === 'no-project') {
    fileMentionsEl.innerHTML = '<div class="file-mention-no-project">Select a project to search files</div>';
    return;
  }

  if (files.length === 0) {
    fileMentionsEl.innerHTML = '<div class="file-mention-empty">No files found</div>';
    return;
  }

  fileMentionsEl.innerHTML = files.map((file, i) => {
    const icon = getFileIcon(file);
    return `
      <div class="file-mention-item${i === 0 ? ' selected' : ''}" data-file="${escapeAttr(file)}">
        <span class="file-icon">${icon}</span>
        <span class="file-path">${escapeHtml(file)}</span>
      </div>
    `;
  }).join('');
}

// Event delegation for file mentions (avoids memory leaks)
fileMentionsEl.addEventListener('click', (e) => {
  const fileItem = e.target.closest('.file-mention-item');
  if (fileItem) {
    selectFileMention(fileItem.dataset.file);
  }
});

function getFileIcon(filePath) {
  const ext = filePath.split('.').pop().toLowerCase();
  const iconMap = {
    'js': '📜',
    'ts': '📘',
    'jsx': '⚛️',
    'tsx': '⚛️',
    'py': '🐍',
    'json': '📋',
    'md': '📝',
    'css': '🎨',
    'scss': '🎨',
    'html': '🌐',
    'svg': '🖼️',
    'png': '🖼️',
    'jpg': '🖼️',
    'jpeg': '🖼️',
    'gif': '🖼️',
    'yml': '⚙️',
    'yaml': '⚙️',
    'toml': '⚙️',
    'sh': '🔧',
    'bash': '🔧',
    'zsh': '🔧'
  };
  return iconMap[ext] || '📄';
}

function showFileMentions() {
  fileMentionsEl.classList.remove('hidden');
}

function hideFileMentions() {
  fileMentionsEl.classList.add('hidden');
  const session = getActiveSession();
  if (session) {
    session.fileMentionSelectedIndex = 0;
    session.fileMentionQuery = '';
    session.fileMentionStartPos = -1;
    clearTimeout(session.fileMentionDebounceTimer);
  }
}

function handleFileMentionKeydown(e) {
  const session = getActiveSession();
  if (!session) return false;

  const items = fileMentionsEl.querySelectorAll('.file-mention-item');
  if (items.length === 0) return false;

  if (e.key === 'ArrowDown') {
    e.preventDefault();
    session.fileMentionSelectedIndex = Math.min(session.fileMentionSelectedIndex + 1, items.length - 1);
    updateFileMentionSelection(items);
    return true;
  }

  if (e.key === 'ArrowUp') {
    e.preventDefault();
    session.fileMentionSelectedIndex = Math.max(session.fileMentionSelectedIndex - 1, 0);
    updateFileMentionSelection(items);
    return true;
  }

  if (e.key === 'Enter' || e.key === 'Tab') {
    e.preventDefault();
    const selected = items[session.fileMentionSelectedIndex];
    if (selected) {
      selectFileMention(selected.dataset.file);
    }
    return true;
  }

  if (e.key === 'Escape') {
    e.preventDefault();
    hideFileMentions();
    return true;
  }

  return false;
}

function updateFileMentionSelection(items) {
  const session = getActiveSession();
  if (!session) return;

  items.forEach((item, i) => {
    item.classList.toggle('selected', i === session.fileMentionSelectedIndex);
  });
  items[session.fileMentionSelectedIndex]?.scrollIntoView({ block: 'nearest' });
}

function selectFileMention(filePath) {
  const session = getActiveSession();
  if (!session) return;

  const value = chatInput.value;
  const before = value.slice(0, session.fileMentionStartPos);
  const after = value.slice(chatInput.selectionStart);
  const formatted = `@"${filePath}"`;

  chatInput.value = before + formatted + after;
  chatInput.focus();

  // Set cursor position after the inserted text
  const newCursorPos = session.fileMentionStartPos + formatted.length;
  chatInput.setSelectionRange(newCursorPos, newCursorPos);

  hideFileMentions();
  chatInput.dispatchEvent(new Event('input'));
}

// Mode button functions
function cycleMode() {
  // If switching away from plan mode while confirmation is pending, auto-deny
  const activeSession = getActiveSession();
  if (activeSession && activeSession.pendingPlanConfirmation) {
    sendPlanResponse(activeSession, activeSession.pendingPlanConfirmation.id, false, 'Mode changed');
    activeSession.pendingPlanConfirmation = null;
    if (activeSession.containerEl) {
      const planBlock = activeSession.containerEl.querySelector('.plan-confirmation-block:not(.submitted)');
      if (planBlock) {
        markPlanConfirmationSubmitted(planBlock, 'rejected');
      }
    }
  }
  state.modeIndex = (state.modeIndex + 1) % MODES.length;
  state.currentMode = MODES[state.modeIndex].name;
  updateModeButton();
}

function updateModeButton() {
  const mode = MODES[state.modeIndex];

  // Remove all mode classes
  modeBtn.classList.remove('mode-default', 'mode-plan', 'mode-bypass');

  // Add current mode class
  modeBtn.classList.add(`mode-${mode.name}`);

  // Update title/tooltip
  modeBtn.title = mode.label;
}

modeBtn.addEventListener('click', cycleMode);

newSessionTabBtn.addEventListener('click', () => {
  if (state.sessions.length >= MAX_SESSIONS) {
    alert(`Maximum ${MAX_SESSIONS} sessions reached`);
    return;
  }
  state.forceNewTab = true;
  openSidebar();
});

abortBtn.addEventListener('click', () => {
  const session = getActiveSession();
  if (session && session.sessionId && session.isStreaming) {
    state.ws.send(JSON.stringify({
      type: 'abort',
      sessionId: session.sessionId
    }));
  }
});

function openSidebar() {
  sidebar.classList.remove('hidden');
  sidebarOverlay.classList.remove('hidden');
  projectSearch.focus();
}

function closeSidebar() {
  sidebar.classList.add('hidden');
  sidebarOverlay.classList.add('hidden');
  state.forceNewTab = false;
}

menuBtn.addEventListener('click', openSidebar);
closeSidebarBtn.addEventListener('click', closeSidebar);
sidebarOverlay.addEventListener('click', closeSidebar);

// Task panel toggle button
document.addEventListener('DOMContentLoaded', () => {
  // Initialize markdown renderer
  if (initializeMarkdownRenderer()) {
    console.log('[Markdown] Initialized Marked.js + DOMPurify + Prism.js');
  } else {
    console.log('[Markdown] Using fallback regex renderer');
  }

  const taskPanelToggle = document.getElementById('task-panel-toggle');
  if (taskPanelToggle) {
    taskPanelToggle.addEventListener('click', toggleTaskPanel);
  }

  // Initialize model selection
  if (modelBtn && modelDropdown) {
    setModel(state.selectedModel);
  }
});

projectSearch.addEventListener('input', () => {
  clearTimeout(state.searchTimeout);
  state.searchTimeout = setTimeout(() => searchProjects(projectSearch.value), SEARCH_DEBOUNCE_MS);
});

projectSearch.addEventListener('focus', () => {
  if (!projectSearch.value) {
    searchProjects('');
  }
});

async function searchProjects(query) {
  projectList.innerHTML = '<div class="loading">Searching</div>';
  sessionList.classList.add('hidden');
  projectList.classList.remove('hidden');
  newSessionBtn.classList.add('hidden');
  
  try {
    const projects = await api(`/api/projects/search?q=${encodeURIComponent(query)}`);
    
    if (projects.length === 0) {
      projectList.innerHTML = `
        <div class="empty-state">
          ${query ? 'No projects match your search' : 'No Claude projects found'}
        </div>
      `;
      return;
    }
    
    // Sort favorites to top
    const favorites = getFavorites();
    projects.sort((a, b) => {
      const aFav = favorites.includes(a.path);
      const bFav = favorites.includes(b.path);
      if (aFav && !bFav) return -1;
      if (!aFav && bFav) return 1;
      return 0;
    });

    projectList.innerHTML = projects.map(p => {
      const favored = isFavorite(p.path);
      return `
        <div class="project-item" data-name="${escapeAttr(p.name)}" data-path="${escapeAttr(p.path)}">
          <button class="favorite-btn${favored ? ' active' : ''}" data-path="${escapeAttr(p.path)}" aria-label="${favored ? 'Unfavorite' : 'Favorite'}">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="${favored ? 'currentColor' : 'none'}" stroke="currentColor" stroke-width="2">
              <polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"></polygon>
            </svg>
          </button>
          <span class="session-count">${p.sessionCount}</span>
          <span class="project-name">${escapeHtml(p.displayName)}</span>
          <span class="project-path">${escapeHtml(p.path)}</span>
        </div>
      `;
    }).join('');

    // Add click handlers for favorite buttons
    projectList.querySelectorAll('.favorite-btn').forEach(btn => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        const path = btn.dataset.path;
        toggleFavorite(path);
        // Re-render to update order and button state
        searchProjects(projectSearch.value);
      });
    });

    projectList.querySelectorAll('.project-item').forEach(el => {
      el.addEventListener('click', () => {
        selectProject(el.dataset.name, el.dataset.path, el.querySelector('.project-name').textContent);
      });
    });
    
  } catch (err) {
    projectList.innerHTML = `<div class="empty-state">Error: ${escapeHtml(err.message)}</div>`;
  }
}

async function selectProject(name, path, displayName, skipHashUpdate = false) {
  const project = { name, path, displayName };
  setModel(DEFAULT_MODEL);

  // Check if we can reuse the active session
  const forceNewTab = state.forceNewTab;
  state.forceNewTab = false;

  const activeSession = getActiveSession();
  const canReuse = activeSession && !activeSession.isStreaming && !forceNewTab;

  if (canReuse) {
    // Reuse existing session - reset all properties
    activeSession.project = { name, path, displayName };
    activeSession.sessionId = null;
    activeSession.isStreaming = false;
    activeSession.pendingText = '';
    activeSession.pendingQuestion = null;
    activeSession.pendingPlanConfirmation = null;
    activeSession.attachments = [];
    activeSession.lastTokenUsage = null;
    activeSession.lastContextWindow = null;
    activeSession.hasUnread = false;
    activeSession.needsHistoryLoad = false;
    activeSession.fileMentionSelectedIndex = 0;
    activeSession.fileMentionQuery = '';
    activeSession.fileMentionStartPos = -1;
    clearTimeout(activeSession.fileMentionDebounceTimer);
    activeSession.slashCommandSelectedIndex = -1;

    // Reset DOM
    clearMessages(activeSession);

    // Update UI
    projectNameEl.textContent = displayName;
    if (!skipHashUpdate) updateHash(name);

    // Load custom commands for this project
    loadCustomCommands(path);

    // Clear token usage and attachments
    updateTokenUsage(null, null, activeSession);
    renderAttachmentPreview();

    // Update session bar to reflect new project name
    renderSessionBar();

    // Save state
    saveSessionState();

    // Load and display sessions in sidebar
    projectList.classList.add('hidden');
    sessionList.classList.remove('hidden');
    sessionsContainer.innerHTML = '<div class="loading">Loading sessions</div>';
    newSessionBtn.classList.remove('hidden');

    try {
      const sessions = await api(`/api/projects/${encodeURIComponent(name)}/sessions`);

      if (sessions.length === 0) {
        sessionsContainer.innerHTML = '<div class="empty-state">No sessions yet</div>';
      } else {
        sessionsContainer.innerHTML = sessions.map(s => `
          <div class="session-item" data-id="${escapeAttr(s.id)}">
            <span class="session-preview">${escapeHtml(s.preview)}</span>
            <span class="session-date">${formatDate(s.lastModified)}</span>
          </div>
        `).join('');

        sessionsContainer.querySelectorAll('.session-item').forEach(el => {
          el.addEventListener('click', () => resumeSession(el.dataset.id));
        });
      }
    } catch (err) {
      sessionsContainer.innerHTML = `<div class="empty-state">Error: ${escapeHtml(err.message)}</div>`;
    }

    return;
  }

  // Cannot reuse - create new tab (existing behavior)

  // Check if we can add another session
  if (state.sessions.length >= MAX_SESSIONS) {
    alert(`Maximum ${MAX_SESSIONS} sessions allowed`);
    return;
  }

  // Create a new session for this project
  const session = createSession(project, null);
  state.sessions.push(session);
  createSessionContainer(session);

  // Switch to the new session (deactivate current container first since switchToSession
  // needs activeSessionIndex to find the old session)
  const prevSession = getActiveSession();
  if (prevSession) prevSession.containerEl.classList.remove('active');
  state.activeSessionIndex = -1; // Reset to force switch
  switchToSession(state.sessions.length - 1);

  projectNameEl.textContent = displayName;
  if (!skipHashUpdate) updateHash(name);

  // Load custom commands for this project
  loadCustomCommands(path);

  projectList.classList.add('hidden');
  sessionList.classList.remove('hidden');
  sessionsContainer.innerHTML = '<div class="loading">Loading sessions</div>';
  newSessionBtn.classList.remove('hidden');

  // Initialize container with welcome message
  clearMessages(session);

  try {
    const sessions = await api(`/api/projects/${encodeURIComponent(name)}/sessions`);

    if (sessions.length === 0) {
      sessionsContainer.innerHTML = '<div class="empty-state">No sessions yet</div>';
    } else {
      sessionsContainer.innerHTML = sessions.map(s => `
        <div class="session-item" data-id="${escapeAttr(s.id)}">
          <span class="session-preview">${escapeHtml(s.preview)}</span>
          <span class="session-date">${formatDate(s.lastModified)}</span>
        </div>
      `).join('');

      sessionsContainer.querySelectorAll('.session-item').forEach(el => {
        el.addEventListener('click', () => resumeSession(el.dataset.id));
      });
    }
  } catch (err) {
    sessionsContainer.innerHTML = `<div class="empty-state">Error: ${escapeHtml(err.message)}</div>`;
  }

  saveSessionState();
}

async function loadSessionHistory(session) {
  if (!session.sessionId) {
    clearMessages(session);
    return;
  }

  if (session.containerEl) {
    session.containerEl.innerHTML = '<div class="loading">Loading history</div>';
  }

  try {
    const projectName = session.project.name;
    const { messages } = await api(`/api/projects/${encodeURIComponent(projectName)}/sessions/${encodeURIComponent(session.sessionId)}/messages?limit=50`);

    if (session.containerEl) session.containerEl.innerHTML = '';

    if (messages.length === 0) {
      if (session.containerEl) {
        session.containerEl.innerHTML = `
          <div class="welcome-message">
            <h2>Session Resumed</h2>
            <p>Continue your conversation with Claude.</p>
          </div>
        `;
      }
    } else {
      for (const msg of messages) {
        if (msg.role === 'user') {
          appendMessage('user', msg.content, session);
        } else if (msg.role === 'assistant') {
          // Create element directly with metadata to preserve message header
          const div = document.createElement('div');
          div.className = 'message assistant';

          // Build message header with metadata from API
          let headerHtml = '';
          if (msg.timestamp || msg.messageId || msg.model) {
            headerHtml = '<div class="message-header">';
            if (msg.timestamp) {
              headerHtml += `<span class="message-timestamp" title="${escapeAttr(msg.timestamp)}">${escapeHtml(formatTimestamp(msg.timestamp))}</span>`;
            }
            if (msg.messageId) {
              headerHtml += `<span class="message-id" title="${escapeAttr(msg.messageId)}">· ${escapeHtml(getShortId(msg.messageId))}</span>`;
            }
            if (msg.model) {
              headerHtml += `<span class="model-badge">${escapeHtml(msg.model)}</span>`;
            }
            headerHtml += '</div>';
          }

          div.innerHTML = headerHtml + formatMarkdown(msg.content);

          // Store metadata on element for reference
          if (msg.timestamp) div.dataset.timestamp = msg.timestamp;
          if (msg.messageId) div.dataset.messageId = msg.messageId;
          if (msg.model) div.dataset.model = msg.model;

          session.containerEl.appendChild(div);
        } else if (msg.role === 'tool') {
          // Build metadata object for historical tool messages
          const toolMetadata = {
            timestamp: msg.timestamp || null,
            messageId: msg.messageId || null,
            model: msg.model || null
          };

          // Use enhanced summary from API if available, otherwise fall back to legacy
          const summary = msg.summary || getToolSummaryFromInput(msg.tool, msg.input);
          appendToolMessage(msg.tool, summary, null, 'success', session, toolMetadata, msg.input);
        }
      }
      // Scroll to bottom to show most recent messages
      if (session.containerEl) {
        session.containerEl.scrollTop = session.containerEl.scrollHeight;
        session.isAtBottom = true;
      }
    }
  } catch (err) {
    console.warn('[Session] History load failed for', session.sessionId, '- session resume still functional:', err.message);
    // NOTE: Do NOT clear session.sessionId here - the Claude SDK resume
    // works independently of UI history display
    if (session.containerEl) {
      session.containerEl.innerHTML = `
        <div class="welcome-message">
          <h2>Session Resumed</h2>
          <p>Could not load history. Continue your conversation.</p>
        </div>
      `;
    }
  }

  session.needsHistoryLoad = false;
}

async function resumeSession(sessionId, skipHashUpdate = false) {
  const session = getActiveSession();
  if (!session) return;

  session.sessionId = sessionId;
  saveSessionState(); // Persist immediately before history load - ensures sessionId survives even if loadSessionHistory fails
  if (!skipHashUpdate) updateHash(session.project.name, sessionId);
  closeSidebar();

  await loadSessionHistory(session);

  enableChat();
  saveSessionState();
}

function getToolSummaryFromInput(tool, input) {
  if (!input) return tool;
  switch (tool) {
    case 'Bash': return `$ ${(input.command || '').slice(0, 80)}`;
    case 'Read': return `Read ${input.file_path || input.path || ''}`;
    case 'Write': return `Write ${input.file_path || input.path || ''}`;
    case 'Edit': return `Edit ${input.file_path || input.path || ''}`;
    case 'Glob': return `Find ${input.pattern || ''}`;
    case 'Grep': return `Search ${input.pattern || ''}`;
    default: return tool;
  }
}

newSessionBtn.addEventListener('click', () => {
  const session = getActiveSession();
  if (!session) return;

  setModel(DEFAULT_MODEL);
  session.sessionId = null;
  updateHash(session.project.name);
  clearMessages(session);
  enableChat();
  closeSidebar();
  saveSessionState();
});

backToProjectsBtn.addEventListener('click', () => {
  sessionList.classList.add('hidden');
  projectList.classList.remove('hidden');
  newSessionBtn.classList.add('hidden');
  searchProjects(projectSearch.value);
});

function enableChat() {
  chatInput.disabled = false;
  sendBtn.disabled = false;
  modeBtn.disabled = false;
  modelBtn.disabled = false;
  attachBtn.disabled = false;
  chatInput.focus();
}

function updateTokenUsage(usage, session) {
  session = session || getActiveSession();
  if (!usage || !session) {
    contextBar.classList.add('hidden');
    tokenUsageEl.textContent = '';
    tokenUsageEl.classList.add('hidden');
    return;
  }

  // Extract values from new usage data structure
  const {
    cumulativeTotal,
    cumulativeInput,
    cumulativeOutput,
    cacheRead,
    cacheCreate,
    contextWindow,
    model,
    used,
    contextWindow: ctxWindow
  } = usage;

  // Support both old format (used, total) and new format (cumulativeTotal, contextWindow)
  const totalTokens = cumulativeTotal || used;
  const windowSize = contextWindow || ctxWindow;

  if (!totalTokens || !windowSize) {
    contextBar.classList.add('hidden');
    tokenUsageEl.textContent = '';
    tokenUsageEl.classList.add('hidden');
    return;
  }

  // Store metrics on session
  session.lastTokenUsage = totalTokens;
  session.lastContextWindow = windowSize;
  if (model) session.model = model;
  if (cacheRead !== undefined || cacheCreate !== undefined) {
    session.cacheMetrics = { cacheRead: cacheRead || 0, cacheCreate: cacheCreate || 0 };
  }

  if (state.sessions.indexOf(session) !== state.activeSessionIndex) return;

  // Format numbers for display (in thousands)
  const totalK = Math.round(totalTokens / 1000);
  const windowK = Math.round(windowSize / 1000);

  // Calculate percentage of context window being used
  const pct = Math.min(Math.round((totalTokens / windowSize) * 100), 100);

  // Update main display: "15k / 200k (8%)"
  tokenUsageEl.textContent = `${totalK}k / ${windowK}k (${pct}%)`;
  tokenUsageEl.classList.remove('hidden');

  // Color coding based on utilization
  if (pct > 95) {
    tokenUsageEl.style.color = 'var(--error)';
  } else if (pct > 80) {
    tokenUsageEl.style.color = 'var(--warning)';
  } else {
    tokenUsageEl.style.color = '';
  }

  // Update context bar
  contextBar.classList.remove('hidden');
  if (session.model) {
    contextModel.textContent = session.model;
    contextModel.classList.remove('hidden');
  }

  // Update visual bar
  contextUsageFill.style.width = `${pct}%`;
  contextUsageText.textContent = `${totalK}k/${windowK}k`;

  // Color the fill based on usage
  if (pct > 95) {
    contextUsageFill.style.background = 'var(--neon-red)';
  } else if (pct > 80) {
    contextUsageFill.style.background = 'var(--neon-orange)';
  } else {
    contextUsageFill.style.background = 'var(--neon-cyan)';
  }

  // Build tooltip with detailed breakdown
  const inputTokens = cumulativeInput || 0;
  const outputTokens = cumulativeOutput || 0;
  const cacheReadTokens = cacheRead || 0;
  const cacheCreateTokens = cacheCreate || 0;

  const tooltipText = `Input: ${inputTokens.toLocaleString()} tokens\n` +
                     `Output: ${outputTokens.toLocaleString()} tokens\n` +
                     `Cache Read: ${cacheReadTokens.toLocaleString()} tokens\n` +
                     `Cache Created: ${cacheCreateTokens.toLocaleString()} tokens\n` +
                     `Context Window: ${windowSize.toLocaleString()} tokens`;
  contextBar.title = tooltipText;
}

function sendNotification(title, body) {
  if (!state.notificationsEnabled || !document.hidden) return;
  try {
    const notif = new Notification(title, {
      body: body,
      icon: '/favicon.ico',
      tag: 'cleon-ui',
      silent: false
    });
    notif.onclick = () => {
      window.focus();
      notif.close();
    };
  } catch (e) {
    // Ignore - notifications may not be supported in this context
  }
}

/**
 * Linkify file paths in text
 * Detects common path patterns and wraps them in clickable links
 * Paths like /path/to/file, ./relative/path, ../parent/path, ~/home/path
 */
function linkifyFilePaths(text) {
  if (!text) return '';

  // Pattern to match file paths:
  // - Absolute paths: /path/to/file
  // - Relative paths: ./path or ../path
  // - Home paths: ~/path
  // Excludes paths already in code blocks or URLs
  const pathPattern = /(^|\s)(~?\.?\.?\/[\w\-./~\\]+)/g;

  return text.replace(pathPattern, (match, prefix, path) => {
    return `${prefix}<a class="file-link" href="#" data-path="${escapeAttr(path)}">${escapeHtml(path)}</a>`;
  });
}

function formatMarkdown(text) {
  if (!text) return '';

  // Use Marked.js if available, fallback to regex
  if (markdownInitialized && typeof marked !== 'undefined' && typeof DOMPurify !== 'undefined') {
    try {
      const html = marked.parse(text);
      return DOMPurify.sanitize(html, {
        ALLOWED_TAGS: ['h1','h2','h3','h4','h5','h6','p','br','strong','em','code','pre','a','ul','ol','li','blockquote','table','thead','tbody','tr','th','td','hr','del','div','span','button'],
        ALLOWED_ATTR: ['href','class','aria-label','target','rel'],
        FORBID_TAGS: ['script','iframe','object','embed','style'],
        FORBID_ATTR: ['onclick','onerror','onload','onmouseover']
      });
    } catch (e) {
      console.error('[Markdown] Parse error, falling back to regex:', e);
      // Fall through to regex fallback
    }
  }

  // Fallback regex renderer (original implementation)
  let html = escapeHtml(text);

  const codeBlocks = [];
  html = html.replace(/```(\w*)\n([\s\S]*?)```/g, (_, lang, code) => {
    const placeholder = `__CODE_BLOCK_${codeBlocks.length}__`;
    codeBlocks.push({ lang, code });
    return placeholder;
  });

  const inlineCodes = [];
  html = html.replace(/`([^`]+)`/g, (_, code) => {
    const placeholder = `__INLINE_CODE_${inlineCodes.length}__`;
    inlineCodes.push(code);
    return placeholder;
  });

  html = linkifyFilePaths(html);

  html = html.replace(/__INLINE_CODE_(\d+)__/g, (_, idx) => {
    return `<code>${inlineCodes[idx]}</code>`;
  });

  html = html.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
  html = html.replace(/\*([^*]+)\*/g, '<em>$1</em>');
  html = html.replace(/\n/g, '<br>');

  html = html.replace(/__CODE_BLOCK_(\d+)__/g, (_, idx) => {
    const block = codeBlocks[idx];
    const displayLang = block.lang || 'code';
    return `<div class="code-block-wrapper"><div class="code-block-header"><span class="code-lang">${displayLang}</span><button class="code-copy-btn" aria-label="Copy code">Copy</button></div><pre><code class="${block.lang}">${block.code}</code></pre></div>`;
  });

  return html;
}

function escapeHtml(str) {
  if (typeof str !== 'string') return String(str);
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function escapeAttr(str) {
  return escapeHtml(str).replace(/\n/g, '&#10;');
}

function formatDate(isoString) {
  const d = new Date(isoString);
  const now = new Date();
  const diffMs = now - d;
  const diffMins = Math.floor(diffMs / 60000);
  const diffHours = Math.floor(diffMs / 3600000);
  const diffDays = Math.floor(diffMs / 86400000);
  
  if (diffMins < 1) return 'Just now';
  if (diffMins < 60) return `${diffMins}m ago`;
  if (diffHours < 24) return `${diffHours}h ago`;
  if (diffDays < 7) return `${diffDays}d ago`;
  
  return d.toLocaleDateString();
}

async function readJsonResponse(res, url) {
  const text = await res.text();

  try {
    return text ? JSON.parse(text) : {};
  } catch (err) {
    const contentType = res.headers.get('content-type') || 'unknown content type';
    const snippet = text.slice(0, 80).replace(/\s+/g, ' ').trim();
    throw new Error(`Expected JSON from ${url}, got ${res.status} ${contentType}: ${snippet}`);
  }
}

async function api(url, body = null) {
  const opts = { headers: {} };
  
  if (state.token) {
    opts.headers['Authorization'] = `Bearer ${state.token}`;
  }
  
  if (body) {
    opts.method = 'POST';
    opts.headers['Content-Type'] = 'application/json';
    opts.body = JSON.stringify(body);
  }
  
  const res = await fetch(url, opts);
  const data = await readJsonResponse(res, url);
  
  if (!res.ok) {
    if (res.status === 401 || res.status === 403) {
      localStorage.removeItem('token');
      state.token = null;
      showAuth();
    }
    throw new Error(data.error || 'Request failed');
  }
  
  return data;
}

window.addEventListener('hashchange', () => {
  if (state.token) {
    const session = getActiveSession();
    const route = parseHash();

    // Guard against redundant reloads - only reload if hash differs from current session
    if (!session || !route) {
      restoreFromHash();
      return;
    }

    if (session.project.name !== route.projectName || session.sessionId !== route.sessionId) {
      restoreFromHash();
    }
  }
});

// ============================================
// File Paste/Drop Attachment Handling
// ============================================

// Allowed file types for attachments
function isAllowedFileType(file) {
  const allowedTypes = [
    'image/png', 'image/jpeg', 'image/gif', 'image/webp',
    'text/plain', 'text/markdown',
    'application/pdf'
  ];
  const allowedExtensions = ['.txt', '.md', '.pdf', '.png', '.jpg', '.jpeg', '.gif', '.webp'];

  if (allowedTypes.includes(file.type)) return true;

  const ext = '.' + file.name.split('.').pop().toLowerCase();
  return allowedExtensions.includes(ext);
}

// Determine attachment type from file
function getAttachmentType(file) {
  if (file.type.startsWith('image/')) return 'image';
  if (file.type === 'application/pdf' || file.name.endsWith('.pdf')) return 'pdf';
  if (file.name.endsWith('.md')) return 'markdown';
  return 'text';
}

// Convert file to base64 data URL
function fileToBase64(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}

// Truncate text for preview
function truncateText(text, maxLength) {
  if (!text) return '';
  if (text.length <= maxLength) return text;
  return text.slice(0, maxLength) + '...';
}

// Upload file to server (for PDFs that need server-side processing)
async function uploadFile(file) {
  const formData = new FormData();
  formData.append('file', file);

  const res = await fetch('/api/upload', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${state.token}`
    },
    body: formData
  });

  if (!res.ok) {
    const data = await readJsonResponse(res, '/api/upload').catch(err => {
      console.error('[Upload] Failed to parse error response:', err);
      return {};
    });
    throw new Error(data.error || 'File upload failed');
  }

  return readJsonResponse(res, '/api/upload');
}

// Process and add a file as an attachment
async function processAndAddAttachment(file) {
  const session = getActiveSession();
  if (!session) return;

  if (session.attachments.length >= MAX_ATTACHMENTS) {
    alert(`Maximum ${MAX_ATTACHMENTS} attachments allowed`);
    return;
  }

  const attachment = {
    id: Date.now() + Math.random().toString(36).substr(2, 9),
    name: file.name,
    type: getAttachmentType(file),
    size: file.size
  };

  try {
    if (attachment.type === 'image') {
      // Convert image to base64 for preview and sending
      attachment.data = await fileToBase64(file);
      attachment.preview = attachment.data;
      attachment.mediaType = file.type;
    } else if (attachment.type === 'text' || attachment.type === 'markdown') {
      // Read text content directly
      attachment.data = await file.text();
      attachment.preview = truncateText(attachment.data, 100);
    } else if (attachment.type === 'pdf') {
      // Upload PDF and get extracted text
      const result = await uploadFile(file);
      attachment.data = result.content;
      attachment.preview = truncateText(result.content, 100);
    }

    session.attachments.push(attachment);
    renderAttachmentPreview();
    chatInput.focus();
  } catch (err) {
    console.error('[Attachment] Error processing file:', err);
    alert(`Failed to process file: ${err.message}`);
  }
}

// Render attachment preview area
function renderAttachmentPreview() {
  const session = getActiveSession();
  if (!session || session.attachments.length === 0) {
    attachmentPreviewEl.classList.add('hidden');
    attachmentPreviewEl.innerHTML = '';
    return;
  }

  attachmentPreviewEl.classList.remove('hidden');
  attachmentPreviewEl.innerHTML = session.attachments.map(att => {
    if (att.type === 'image') {
      return `
        <div class="attachment-item image" data-id="${att.id}">
          <img src="${att.preview}" alt="${escapeAttr(att.name)}">
          <button class="attachment-remove" aria-label="Remove attachment">&times;</button>
        </div>
      `;
    }

    const icon = getFileIcon(att.name);
    return `
      <div class="attachment-item" data-id="${att.id}">
        <span class="attachment-icon">${icon}</span>
        <span class="attachment-name">${escapeHtml(att.name)}</span>
        <button class="attachment-remove" aria-label="Remove attachment">&times;</button>
      </div>
    `;
  }).join('');
}

// Remove attachment by ID via event delegation
function removeAttachment(id) {
  const session = getActiveSession();
  if (session) {
    session.attachments = session.attachments.filter(att => att.id !== id);
    renderAttachmentPreview();
  }
}

// Event delegation for attachment removal
attachmentPreviewEl.addEventListener('click', (e) => {
  const removeBtn = e.target.closest('.attachment-remove');
  if (removeBtn) {
    const attachmentItem = removeBtn.closest('.attachment-item');
    if (attachmentItem) {
      removeAttachment(attachmentItem.dataset.id);
    }
  }
});

// Format user message display with attachments
function formatUserMessageWithAttachments(content, attachments) {
  if (!attachments || attachments.length === 0) return content;

  const attachmentText = attachments.map(att => {
    if (att.type === 'image') {
      return `[Image: ${att.name}]`;
    }
    return `[${att.type.toUpperCase()}: ${att.name}]`;
  }).join(' ');

  return content ? `${content}\n\n${attachmentText}` : attachmentText;
}

// Paste event handler
document.addEventListener('paste', async (e) => {
  // Only handle if chat is enabled and a project is selected
  const session = getActiveSession();
  if (!session || chatInput.disabled) return;

  const items = e.clipboardData?.items;
  if (!items) return;

  const files = [];
  for (const item of items) {
    if (item.kind === 'file') {
      const file = item.getAsFile();
      if (file && isAllowedFileType(file)) {
        files.push(file);
      }
    }
  }

  if (files.length > 0) {
    e.preventDefault();
    for (const file of files) {
      await processAndAddAttachment(file);
    }
  }
});

// Attach button click handler (for mobile file selection)
attachBtn.addEventListener('click', () => {
  fileInput.click();
});

// File input change handler
fileInput.addEventListener('change', async (e) => {
  const files = Array.from(e.target.files || []);
  for (const file of files) {
    if (isAllowedFileType(file)) {
      await processAndAddAttachment(file);
    }
  }
  fileInput.value = ''; // Reset for re-selection
});

// Drag and drop handlers
let dragCounter = 0;

document.addEventListener('dragenter', (e) => {
  e.preventDefault();
  const session = getActiveSession();
  if (!session || chatInput.disabled) return;

  // Check if dragging files
  if (!e.dataTransfer?.types?.includes('Files')) return;

  dragCounter++;
  if (dragCounter === 1) {
    dropZoneOverlay.classList.remove('hidden');
  }
});

document.addEventListener('dragleave', (e) => {
  e.preventDefault();
  dragCounter--;
  if (dragCounter === 0) {
    dropZoneOverlay.classList.add('hidden');
  }
});

document.addEventListener('dragover', (e) => {
  e.preventDefault();
});

document.addEventListener('drop', async (e) => {
  e.preventDefault();
  dragCounter = 0;
  dropZoneOverlay.classList.add('hidden');

  const session = getActiveSession();
  if (!session || chatInput.disabled) return;

  const files = Array.from(e.dataTransfer?.files || []);
  for (const file of files) {
    if (isAllowedFileType(file)) {
      await processAndAddAttachment(file);
    }
  }
});

// ==================== File Tree & Editor Functions ====================

// File editor state
state.fileEditor = {
  isOpen: false,
  editorMode: false,
  expandedFolders: new Set(JSON.parse(localStorage.getItem('expandedFolders') || '[]')),
  selectedPath: null,
  openFiles: [],
  activeFileIndex: -1,
  unsavedChanges: new Set(),
  dirCache: {}, // Cache for lazy-loaded directory contents
  searchQuery: ''
};

// DOM references for file editor
const filesBtn = $('#files-btn');
const fileTreeDrawer = $('#file-tree-drawer');
const fileTreeOverlay = $('#file-tree-overlay');
const fileTreeContent = $('#file-tree-content');
const fileTreeSearch = $('#file-tree-search');
const closeFileTreeBtn = $('#close-file-tree');
const editorScreen = $('#editor-screen');
const editorHeader = $('#editor-header');
const editorFilePath = $('#editor-file-path');
const editorStatus = $('#editor-status');
const editorSaveBtn = $('#editor-save-btn');
const editorCloseBtn = $('#editor-close');
const editorContainer = $('#editor-container');
const editorGutter = $('#editor-gutter');

// Monaco Editor instance
let monacoEditor = null;

// Current file in editor
let currentEditorFile = null;
let editorOriginalContent = '';
let editorLanguage = 'plaintext';

// Map file extensions to Monaco languages
const monacoLanguageMap = {
  'js': 'javascript',
  'ts': 'typescript',
  'html': 'html',
  'css': 'css',
  'json': 'json',
  'md': 'markdown',
  'py': 'python',
  'rb': 'ruby',
  'sh': 'shell',
  'bash': 'shell',
  'yaml': 'yaml',
  'yml': 'yaml',
  'xml': 'xml',
  'sql': 'sql',
  'go': 'go',
  'rs': 'rust',
  'java': 'java',
  'c': 'c',
  'cpp': 'cpp',
  'h': 'c',
  'hpp': 'cpp',
  'php': 'php',
  'vue': 'vue',
  'svelte': 'svelte'
};

// Initialize Monaco Editor
function initMonacoEditor() {
  if (monacoEditor) {
    return monacoEditor;
  }

  const editorElement = $('#editor');
  if (!editorElement) {
    console.error('[Monaco] Editor element not found');
    return null;
  }

  // Require Monaco from the loader
  require.config({
    paths: {
      'vs': 'https://cdn.jsdelivr.net/npm/monaco-editor@0.45.0/min/vs'
    }
  });

  return new Promise((resolve, reject) => {
    require(['vs/editor/editor.main'], function() {
      monacoEditor = monaco.editor.create(editorElement, {
        value: '',
        language: 'plaintext',
        theme: 'vs-dark',
        automaticLayout: true,
        fontSize: 14,
        fontFamily: "'SF Mono', Monaco, 'Cascadia Code', 'Consolas', monospace",
        minimap: { enabled: false },
        lineNumbers: 'on',
        glyphMargin: false,
        folding: true,
        lineDecorationsWidth: 10,
        lineNumbersMinChars: 4,
        padding: { top: 0, bottom: 0 },
        scrollBeyondLastLine: false,
        renderLineHighlight: 'line',
        cursorBlinking: 'smooth',
        cursorSmoothCaretAnimation: 'on',
        smoothScrolling: true,
        tabSize: 2,
        wordWrap: 'on'
      });

      // Track content changes for status updates
      monacoEditor.onDidChangeModelContent(() => {
        updateEditorStatus();
      });

      // Add keyboard shortcuts
      monacoEditor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS, () => {
        saveCurrentFile();
      });

      monacoEditor.addCommand(monaco.KeyCode.Escape, () => {
        closeEditor();
      });

      console.log('[Monaco] Editor initialized');
      resolve(monacoEditor);
    });
  });
}

// Open file tree drawer
async function openFileTree() {
  const session = getActiveSession();
  if (!session) return;

  fileTreeDrawer.classList.remove('hidden');
  fileTreeOverlay.classList.remove('hidden');
  state.fileEditor.isOpen = true;

  // Load tree if not already cached
  if (!state.fileEditor.dirCache['']) {
    await loadFileTree();
  } else {
    // Re-render from cache
    renderFileTree();
  }
}

// Close file tree drawer
function closeFileTree() {
  fileTreeDrawer.classList.add('hidden');
  fileTreeOverlay.classList.add('hidden');
  state.fileEditor.isOpen = false;
}

// Load file tree from server (lazy loading)
async function loadFileTree() {
  const session = getActiveSession();
  if (!session) return;

  fileTreeContent.innerHTML = '<div class="file-tree-loading">Loading...</div>';

  try {
    // Load top-level directory only
    const res = await fetch(`/api/files/${encodeURIComponent(session.project.name)}/ls`, {
      headers: { 'Authorization': `Bearer ${state.token}` }
    });

    if (!res.ok) {
      throw new Error('Failed to load file tree');
    }

    const data = await readJsonResponse(res, res.url);
    // Cache top-level items
    state.fileEditor.dirCache[''] = data.items;
    state.fileEditor.projectPath = session.project.name;

    renderFileTree();
  } catch (err) {
    console.error('[FileTree] Error:', err);
    fileTreeContent.innerHTML = `<div class="file-tree-error">Error: ${escapeHtml(err.message)}</div>`;
  }
}

// Load directory contents on demand
async function loadDirectory(path) {
  // Return cached if available
  if (state.fileEditor.dirCache[path]) {
    return state.fileEditor.dirCache[path];
  }

  const session = getActiveSession();
  if (!session) return [];

  try {
    const res = await fetch(`/api/files/${encodeURIComponent(session.project.name)}/ls?path=${encodeURIComponent(path)}`, {
      headers: { 'Authorization': `Bearer ${state.token}` }
    });

    if (!res.ok) {
      console.error('[FileTree] Failed to load directory:', path);
      return [];
    }

    const data = await readJsonResponse(res, res.url);
    state.fileEditor.dirCache[path] = data.items;
    return data.items;
  } catch (err) {
    console.error('[FileTree] Error loading directory:', err);
    return [];
  }
}

// Render file tree (lazy loading)
async function renderFileTree() {
  fileTreeContent.innerHTML = '<div class="file-tree-loading">Loading...</div>';

  const rootItems = await loadDirectory('');
  const html = renderDirectoryItems(rootItems, '', 0, state.fileEditor.searchQuery.toLowerCase());
  fileTreeContent.innerHTML = html || '<div class="file-tree-empty">No files found</div>';

  // Restore expanded folders
  fileTreeContent.querySelectorAll('.tree-folder-header').forEach(header => {
    const path = header.dataset.path;
    if (state.fileEditor.expandedFolders.has(path)) {
      // Expand folder and load its contents
      const childrenDiv = header.nextElementSibling;
      expandFolder(header, childrenDiv, path);
    }
  });

  // Add click handlers
  fileTreeContent.querySelectorAll('.tree-folder-header').forEach(header => {
    header.addEventListener('click', () => toggleFolder(header.dataset.path, header));
  });

  fileTreeContent.querySelectorAll('.tree-file').forEach(file => {
    file.addEventListener('click', () => openFile(file.dataset.path));
  });
}

// Render directory items
function renderDirectoryItems(items, basePath, depth, searchQuery) {
  const entries = items
    .filter(item => {
      if (searchQuery) {
        const fullPath = item.path;
        return fullPath.toLowerCase().includes(searchQuery);
      }
      return true;
    })
    .map(item => ({
      ...item,
      depth
    }));

  // Sort: directories first, then alphabetically
  entries.sort((a, b) => {
    if (a.isDirectory !== b.isDirectory) {
      return a.isDirectory ? -1 : 1;
    }
    return a.name.localeCompare(b.name, undefined, { sensitivity: 'base' });
  });

  return entries.map(entry => {
    const indent = entry.depth * 16;
    const icon = getFileTreeIcon(entry.name, entry.isDirectory);

    if (entry.isDirectory) {
      return `
        <div class="tree-folder">
          <div class="tree-folder-header" data-path="${escapeAttr(entry.path)}" style="padding-left: ${indent}px">
            <span class="tree-chevron">▶</span>
            <span class="tree-icon">${icon}</span>
            <span class="tree-name">${escapeHtml(entry.name)}</span>
          </div>
          <div class="tree-folder-children hidden"></div>
        </div>`;
    } else {
      return `
        <div class="tree-file" data-path="${escapeAttr(entry.path)}" style="padding-left: ${indent}px">
          <span class="tree-icon">${icon}</span>
          <span class="tree-name">${escapeHtml(entry.name)}</span>
        </div>`;
    }
  }).join('');
}

// Expand a folder and load its contents
async function expandFolder(header, childrenDiv, path) {
  header.classList.add('expanded');
  const chevron = header.querySelector('.tree-chevron');
  if (chevron) chevron.textContent = '▼';

  // Load directory contents
  const items = await loadDirectory(path);

  if (items.length === 0) {
    childrenDiv.innerHTML = '<div class="tree-folder-empty">Empty folder</div>';
  } else {
    // Calculate depth from path (number of path separators)
    const depth = path ? path.split('/').filter(Boolean).length : 0;
    childrenDiv.innerHTML = renderDirectoryItems(items, path, depth + 1, state.fileEditor.searchQuery.toLowerCase());
    childrenDiv.classList.remove('hidden');

    // Recursively expand nested folders if they were saved
    childrenDiv.querySelectorAll('.tree-folder-header').forEach(childHeader => {
      const childPath = childHeader.dataset.path;
      if (state.fileEditor.expandedFolders.has(childPath)) {
        const childChildrenDiv = childHeader.nextElementSibling;
        expandFolder(childHeader, childChildrenDiv, childPath);
      } else {
        childHeader.addEventListener('click', () => toggleFolder(childHeader.dataset.path, childHeader));
      }
    });

    childrenDiv.querySelectorAll('.tree-file').forEach(file => {
      file.addEventListener('click', () => openFile(file.dataset.path));
    });
  }
}

// Get icon for file tree item
function getFileTreeIcon(name, isDir) {
  if (isDir) return '📁';

  const ext = name.split('.').pop()?.toLowerCase() || '';
  const iconMap = {
    'js': '📜', 'jsx': '⚛️', 'ts': '📘', 'tsx': '⚛️',
    'py': '🐍', 'rb': '💎', 'go': '🔵', 'rs': '🦀',
    'java': '☕', 'c': '⚙️', 'cpp': '⚙️', 'h': '📄',
    'html': '🌐', 'css': '🎨', 'scss': '🎨', 'less': '🎨',
    'json': '📋', 'yaml': '📋', 'yml': '📋', 'toml': '📋',
    'md': '📝', 'markdown': '📝', 'txt': '📄',
    'svg': '🖼️', 'png': '🖼️', 'jpg': '🖼️', 'gif': '🖼️',
    'sh': '💻', 'bash': '💻', 'zsh': '💻',
    'sql': '🗃️', 'graphql': '◉',
    'gitignore': '🙈', 'env': '🔐',
    'lock': '🔒', 'sum': '🔒'
  };

  return iconMap[ext] || '📄';
}

// Toggle folder expansion (lazy loading)
async function toggleFolder(path, header = null) {
  // Find header if not provided
  if (!header) {
    header = document.querySelector(`.tree-folder-header[data-path="${escapeAttr(path)}"]`);
    if (!header) return;
  }

  const childrenDiv = header.nextElementSibling;

  if (state.fileEditor.expandedFolders.has(path)) {
    // Collapse
    state.fileEditor.expandedFolders.delete(path);
    header.classList.remove('expanded');
    const chevron = header.querySelector('.tree-chevron');
    if (chevron) chevron.textContent = '▶';
    childrenDiv.classList.add('hidden');
  } else {
    // Expand
    state.fileEditor.expandedFolders.add(path);
    await expandFolder(header, childrenDiv, path);
  }

  // Save to localStorage
  localStorage.setItem('expandedFolders', JSON.stringify([...state.fileEditor.expandedFolders]));
}

// Open file in editor
async function openFile(filePath) {
  const session = getActiveSession();
  if (!session) return;

  // Close file tree
  closeFileTree();

  try {
    const res = await fetch(`/api/files/${encodeURIComponent(session.project.name)}/${encodeURIComponent(filePath)}`, {
      headers: { 'Authorization': `Bearer ${state.token}` }
    });

    if (!res.ok) {
      const err = await readJsonResponse(res, res.url);
      throw new Error(err.error || 'Failed to load file');
    }

    const data = await readJsonResponse(res, res.url);

    if (!data.editable) {
      alert('This file type cannot be edited in the browser.');
      return;
    }

    // Initialize Monaco if needed
    if (!monacoEditor) {
      await initMonacoEditor();
    }

    if (!monacoEditor) {
      alert('Failed to initialize editor');
      return;
    }

    // Store current file data
    currentEditorFile = {
      path: data.path,
      content: data.content,
      language: data.language
    };
    editorOriginalContent = data.content;

    // Detect language from file extension
    const ext = filePath.split('.').pop()?.toLowerCase() || '';
    editorLanguage = monacoLanguageMap[ext] || data.language || 'plaintext';

    // Update UI
    editorFilePath.textContent = data.path;

    // Set content and language in Monaco
    monacoEditor.setValue(data.content);
    monaco.editor.setModelLanguage(monacoEditor.getModel(), editorLanguage);

    updateEditorStatus();

    // Show editor
    editorScreen.classList.remove('hidden');
    state.fileEditor.editorMode = true;

    // Focus editor
    monacoEditor.focus();

  } catch (err) {
    console.error('[Editor] Error loading file:', err);
    alert(`Failed to open file: ${err.message}`);
  }
}

// Update editor status bar
function updateEditorStatus() {
  if (!monacoEditor) return;

  const content = monacoEditor.getValue();
  const hasChanges = currentEditorFile && content !== editorOriginalContent;
  const lineCount = monacoEditor.getModel()?.getLineCount() || content.split('\n').length;
  const charCount = content.length;

  if (hasChanges) {
    editorStatus.textContent = `Modified | ${lineCount} lines | ${charCount} chars`;
    editorSaveBtn.disabled = false;
  } else {
    editorStatus.textContent = `${lineCount} lines | ${charCount} chars`;
    editorSaveBtn.disabled = true;
  }
}

// Save current file
async function saveCurrentFile() {
  const session = getActiveSession();
  if (!session || !currentEditorFile || !monacoEditor) return;

  const content = monacoEditor.getValue();

  try {
    editorSaveBtn.disabled = true;
    editorSaveBtn.textContent = 'Saving...';

    const res = await fetch(`/api/files/${encodeURIComponent(session.project.name)}/${encodeURIComponent(currentEditorFile.path)}`, {
      method: 'PUT',
      headers: {
        'Authorization': `Bearer ${state.token}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ content })
    });

    if (!res.ok) {
      const err = await readJsonResponse(res, res.url);
      throw new Error(err.error || 'Failed to save file');
    }

    // Update original content
    editorOriginalContent = content;
    currentEditorFile.content = content;

    // Show success
    editorStatus.textContent = 'Saved!';
    setTimeout(() => updateEditorStatus(), 2000);

  } catch (err) {
    console.error('[Editor] Error saving file:', err);
    alert(`Failed to save file: ${err.message}`);
    editorSaveBtn.disabled = false;
  } finally {
    editorSaveBtn.textContent = 'Save';
  }
}

// Close editor
function closeEditor() {
  if (!monacoEditor) return;

  // Check for unsaved changes
  const content = monacoEditor.getValue();
  if (content !== editorOriginalContent) {
    if (!confirm('You have unsaved changes. Close anyway?')) {
      return;
    }
  }

  // Clear editor content
  monacoEditor.setValue('');

  editorScreen.classList.add('hidden');
  state.fileEditor.editorMode = false;
  currentEditorFile = null;
  editorOriginalContent = '';

  // Reset any mobile viewport adjustments
  resetEditorViewport();
}

// Event listeners for file tree
filesBtn.addEventListener('click', openFileTree);
closeFileTreeBtn.addEventListener('click', closeFileTree);
fileTreeOverlay.addEventListener('click', closeFileTree);

// File tree search
fileTreeSearch.addEventListener('input', (e) => {
  state.fileEditor.searchQuery = e.target.value;
  renderFileTree();
});

// Editor event listeners
editorCloseBtn.addEventListener('click', closeEditor);
editorSaveBtn.addEventListener('click', saveCurrentFile);

// Update buttons when session changes
function updateFilesButtonState() {
  const session = getActiveSession();
  filesBtn.disabled = !session;
}

// Hook into session switching
const originalSwitchToSession = switchToSession;
switchToSession = function(index) {
  originalSwitchToSession(index);
  updateFilesButtonState();

  // Clear file tree cache when switching sessions to ensure correct project files
  state.fileEditor.dirCache = {};

  // Close file tree when switching sessions
  if (state.fileEditor.isOpen) {
    closeFileTree();
  }
};

// Hook into session closing
const originalCloseSession = closeSession;
closeSession = function(index) {
  originalCloseSession(index);

  // Clear file tree cache if all sessions closed
  if (state.sessions.length === 0) {
    state.fileEditor.dirCache = {};
    updateFilesButtonState();
  }
};

// ==================== End File Tree & Editor Functions ====================

init();
