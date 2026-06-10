import {
	state,
	MODES,
	MAX_ATTACHMENTS,
	PREVIEW_TRUNCATE_LENGTH,
	MAX_SESSIONS,
	SEARCH_DEBOUNCE_MS,
	DEFAULT_MODEL,
	getFavorites,
	toggleFavorite,
	isFavorite,
	setModelState,
} from "./state.js";
import {
	escapeHtml,
	escapeAttr,
	formatDate,
	fileToBase64,
	truncateText,
} from "./utils.js";
import {
	setElementHtml,
	chatInput,
	sendBtn,
	modeBtn,
	modelBtn,
	modelDropdown,
	attachBtn,
	abortBtn,
	slashCommandsEl,
	fileMentionsEl,
	attachmentPreviewEl,
	fileInput,
	dropZoneOverlay,
	newSessionTabBtn,
	sidebar,
	sidebarOverlay,
	projectSearch,
	projectList,
	sessionList,
	sessionsContainer,
	newSessionBtn,
	backToProjectsBtn,
	projectNameEl,
	tokenUsageEl,
	contextBar,
	contextModel,
	contextUsageFill,
	contextUsageText,
} from "./dom.js";
import {
	getActiveSession,
	createSession,
	createSessionContainer,
	switchToSession,
	renderSessionBar,
	saveSessionState,
	loadSessionHistory,
} from "./sessions.js";
import {
	appendMessage,
	appendSystemMessage,
	removeWelcome,
	clearMessages,
	scrollToBottom,
	sendPlanResponse,
	markPlanConfirmationSubmitted,
} from "./messages.js";
import { initializeMarkdownRenderer } from "./markdown.js";

// Built-in commands (always available)
const BUILTIN_COMMANDS = [
	{
		name: "/compact",
		desc: "Use compact mode for shorter responses",
		source: "builtin",
	},
	{
		name: "/verbose",
		desc: "Use verbose mode for detailed responses",
		source: "builtin",
	},
	{ name: "/clear", desc: "Clear the current conversation", source: "builtin" },
	{ name: "/help", desc: "Show available commands", source: "builtin" },
	{
		name: "/model",
		desc: "Show or change the current model",
		source: "builtin",
	},
	{ name: "/tokens", desc: "Show current token usage", source: "builtin" },
	{
		name: "/context",
		desc: "Show context window information",
		source: "builtin",
	},
	{ name: "/reset", desc: "Reset conversation context", source: "builtin" },
];

// Built-in command handlers - commands that execute locally in the UI
// Commands not in this map (like /compact, /verbose) are sent to Claude
const BUILTIN_COMMAND_HANDLERS = {
	"/clear": handleClearCommand,
	"/reset": handleClearCommand, // Same behavior as /clear
	"/help": handleHelpCommand,
	"/tokens": handleTokensCommand,
	"/context": handleContextCommand,
	"/model": handleModelCommand,
};

function updateModelUI(model = state.selectedModel) {
	modelBtn.title = model.charAt(0).toUpperCase() + model.slice(1);
	modelDropdown.querySelectorAll(".dropdown-item").forEach((item) => {
		item.classList.toggle("active", item.dataset.model === model);
	});
	modelDropdown.classList.add("hidden");
}

function setModel(model) {
	setModelState(model);
	updateModelUI(model);
}

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
	const args = parts.slice(1).join(" ");
	return { command, args };
}

// Model selection

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
		appendCommandMessage("Please select a project first.");
		return;
	}

	session.sessionId = null;
	updateHash(session.project.name);
	clearMessages(session);
	enableChat();
	appendCommandMessage("Session cleared. Starting fresh.", session);
	saveSessionState();
}

// Handler for /help command

function handleHelpCommand() {
	const commands = getAllCommands();

	// Group commands by source
	const builtin = commands.filter((c) => c.source === "builtin");
	const global = commands.filter((c) => c.source === "global");
	const project = commands.filter((c) => c.source === "project");

	let helpText = "Available Commands:\n\n";

	if (builtin.length > 0) {
		helpText += "Built-in:\n";
		for (const cmd of builtin) {
			helpText += `  ${cmd.name} - ${cmd.desc}\n`;
		}
	}

	if (global.length > 0) {
		helpText += "\nGlobal:\n";
		for (const cmd of global) {
			helpText += `  ${cmd.name} - ${cmd.desc}\n`;
		}
	}

	if (project.length > 0) {
		helpText += "\nProject:\n";
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
		appendCommandMessage("No token usage data yet. Send a message first.");
		return;
	}

	const usedK = Math.round(session.lastTokenUsage / 1000);
	const totalK = Math.round(session.lastContextWindow / 1000);
	const pct = Math.round(
		(session.lastTokenUsage / session.lastContextWindow) * 100,
	);

	appendCommandMessage(`Token Usage: ${usedK}k / ${totalK}k (${pct}%)`);
}

// Handler for /context command

function handleContextCommand() {
	const session = getActiveSession();
	if (!session || session.lastContextWindow === null) {
		appendCommandMessage("No context data yet. Send a message first.");
		return;
	}

	const usedK = session.lastTokenUsage
		? Math.round(session.lastTokenUsage / 1000)
		: 0;
	const totalK = Math.round(session.lastContextWindow / 1000);
	const pct = session.lastTokenUsage
		? Math.round((session.lastTokenUsage / session.lastContextWindow) * 100)
		: 0;
	const remaining = session.lastContextWindow - (session.lastTokenUsage || 0);
	const remainingK = Math.round(remaining / 1000);

	appendCommandMessage(
		`Context Window: ${totalK}k tokens total\nUsed: ${usedK}k (${pct}%)\nRemaining: ${remainingK}k`,
	);
}

// Handler for /model command

function handleModelCommand() {
	appendCommandMessage(
		"Model: Claude (via Claude Code SDK)\nModel switching is not yet supported in the web UI.",
	);
}

// Append a command feedback message (styled differently from assistant messages)

function appendCommandMessage(content, session) {
	session = session || getActiveSession();
	if (!session?.containerEl) return;
	removeWelcome(session);
	const div = document.createElement("div");
	div.className = "message command-feedback";
	div.style.borderLeft = "3px solid var(--neon-cyan)";
	div.style.fontFamily = "monospace";
	div.style.whiteSpace = "pre-wrap";
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
			source: cmd.source,
		});
	}

	return Array.from(commandMap.values());
}

// Load custom commands from the API

async function loadCustomCommands(projectPath = null) {
	try {
		let url = "/api/commands";
		if (projectPath) {
			url += `?projectPath=${encodeURIComponent(projectPath)}`;
		}
		state.customCommands = await api(url);
	} catch (err) {
		console.warn("[Commands] Failed to load custom commands:", err);
		state.customCommands = [];
	}
}

function sendMessage(content) {
	// Check if this is a local built-in command (e.g., /clear, /help, /tokens)
	// Commands like /compact and /verbose are NOT in the handler map and will be sent to Claude
	if (isLocalBuiltinCommand(content)) {
		const { command, args } = parseCommand(content);
		executeBuiltinCommand(command, args);
		chatInput.value = "";
		chatInput.style.height = "auto";
		return; // Don't send to Claude
	}

	const session = getActiveSession();
	if (!session) {
		appendCommandMessage("Please create or select a session first.");
		return;
	}

	const mode = MODES[state.modeIndex];

	console.log(
		"[Session] Sending message with sessionId:",
		session.sessionId,
		"isNewSession:",
		!session.sessionId,
	);

	// Context loss detection: warn if sending as new session but UI already shows messages
	if (
		!session.sessionId &&
		session.containerEl &&
		session.containerEl.children.length > 1
	) {
		console.warn(
			"[Session] WARNING: Sending as new session but UI shows existing messages - possible context loss",
		);
	}

	const message = {
		type: "chat",
		content: content,
		mode: mode.name,
		model: state.selectedModel,
		projectPath: session.project.path,
		sessionId: session.sessionId,
		isNewSession: !session.sessionId,
	};

	// Add attachments if present
	if (session.attachments.length > 0) {
		message.attachments = session.attachments.map((att) => ({
			type: att.type,
			name: att.name,
			data: att.data,
			mediaType: att.mediaType,
		}));
	}

	if (!state.ws || state.ws.readyState !== WebSocket.OPEN) {
		appendSystemMessage("Connection lost. Reconnecting...", session);
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
	const displayContent = formatUserMessageWithAttachments(
		content,
		session.attachments,
	);
	appendMessage("user", displayContent, session, session.attachments);

	// Clear attachments after sending
	session.attachments = [];
	renderAttachmentPreview();

	chatInput.value = "";
	chatInput.style.height = "auto";

	session.isStreaming = true;
	abortBtn.classList.remove("hidden");
	chatInput.disabled = true;
	sendBtn.disabled = true;
	modeBtn.disabled = true;
	modelBtn.disabled = true;
	attachBtn.disabled = true;
}

// Mobile keyboard handling for Monaco Editor

function calculateCommandScore(cmd, query) {
	const nameLower = cmd.name.toLowerCase();

	// Highest priority: exact name match
	if (nameLower === query) return 1000;

	// High priority: name starts with query (prefix match)
	if (nameLower.startsWith(query)) return 500 + query.length * 10;

	// Medium priority: query is a word in the name (for multi-word commands)
	const words = nameLower.split(/[\s_-]/);
	if (words.some((word) => word === query)) return 300 + query.length * 10;

	// Lower priority: name contains the query anywhere (substring match)
	if (nameLower.includes(query)) return 100 + query.length * 10;

	// No match
	return 0;
}

function handleSlashCommandInput() {
	const value = chatInput.value;

	if (!value.startsWith("/")) {
		hideSlashCommands();
		return;
	}

	const query = value.slice(1).toLowerCase();
	const allCommands = getAllCommands();

	// Score and filter commands by name only
	const scoredCommands = allCommands
		.map((cmd) => ({ cmd, score: calculateCommandScore(cmd, query) }))
		.filter((item) => item.score > 0)
		.sort((a, b) => b.score - a.score) // Sort descending by score
		.map((item) => item.cmd); // Extract commands

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

	setElementHtml(
		slashCommandsEl,
		commands
			.map((cmd, i) => {
				const sourceClass = `source-${cmd.source || "builtin"}`;
				const sourceLabel = ["global", "project", "skill"].includes(cmd.source)
					? cmd.source
					: "";
				return `
      <div class="slash-command${i === 0 ? " selected" : ""}" data-command="${escapeAttr(cmd.name)}">
        <div class="slash-command-header">
          <span class="slash-command-name">${escapeHtml(cmd.name)}</span>
          ${sourceLabel ? `<span class="slash-command-source ${sourceClass}">${sourceLabel}</span>` : ""}
        </div>
        <div class="slash-command-desc">${escapeHtml(cmd.desc)}</div>
      </div>
    `;
			})
			.join(""),
	);
}

function showSlashCommands() {
	slashCommandsEl.classList.remove("hidden");
}

function hideSlashCommands() {
	slashCommandsEl.classList.add("hidden");
	const session = getActiveSession();
	if (session) session.slashCommandSelectedIndex = -1;
}

function handleSlashCommandKeydown(e) {
	const session = getActiveSession();
	if (!session) return false;

	const items = slashCommandsEl.querySelectorAll(".slash-command");
	if (items.length === 0) return false;

	if (e.key === "ArrowDown") {
		e.preventDefault();
		session.slashCommandSelectedIndex = Math.min(
			session.slashCommandSelectedIndex + 1,
			items.length - 1,
		);
		updateSlashCommandSelection(items);
		return true;
	}

	if (e.key === "ArrowUp") {
		e.preventDefault();
		session.slashCommandSelectedIndex = Math.max(
			session.slashCommandSelectedIndex - 1,
			0,
		);
		updateSlashCommandSelection(items);
		return true;
	}

	if (e.key === "Enter" || e.key === "Tab") {
		e.preventDefault();
		const selected = items[session.slashCommandSelectedIndex];
		if (selected) {
			const command = selected.dataset.command;
			// If it's a local builtin command and Enter (not Tab), execute immediately
			if (e.key === "Enter" && isLocalBuiltinCommand(command)) {
				hideSlashCommands();
				const { command: cmd, args } = parseCommand(command);
				executeBuiltinCommand(cmd, args);
				chatInput.value = "";
				chatInput.style.height = "auto";
				return true;
			}
			insertSlashCommand(command);
		}
		return true;
	}

	if (e.key === "Escape") {
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
		item.classList.toggle("selected", i === session.slashCommandSelectedIndex);
	});
	items[session.slashCommandSelectedIndex]?.scrollIntoView({
		block: "nearest",
	});
}

function insertSlashCommand(command) {
	// Replace existing text with the command
	chatInput.value = command + " ";

	chatInput.focus();
	// Move cursor to end of input
	chatInput.selectionStart = chatInput.selectionEnd = chatInput.value.length;
	hideSlashCommands();
	chatInput.dispatchEvent(new Event("input"));
}

// File Mention Functions

function handleFileMentionInput() {
	const session = getActiveSession();
	if (!session) return;

	const value = chatInput.value;
	const cursorPos = chatInput.selectionStart;
	const textBeforeCursor = value.slice(0, cursorPos);
	const lastAtIndex = textBeforeCursor.lastIndexOf("@");

	// No @ found or @ is at the very end with nothing after it
	if (lastAtIndex === -1) {
		hideFileMentions();
		return;
	}

	const textAfterAt = textBeforeCursor.slice(lastAtIndex + 1);

	// Check if there's whitespace after @ (which would mean @ mention is complete)
	if (textAfterAt.includes(" ")) {
		hideFileMentions();
		return;
	}

	// Check if we're at the start or after whitespace
	if (
		lastAtIndex > 0 &&
		textBeforeCursor[lastAtIndex - 1] !== " " &&
		textBeforeCursor[lastAtIndex - 1] !== "\n"
	) {
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
		renderFileMentions([], "no-project");
		showFileMentions();
		return;
	}

	try {
		const { files } = await api(
			`/api/projects/${encodeURIComponent(session.project.name)}/files/search?q=${encodeURIComponent(query)}`,
		);
		renderFileMentions(files);
		showFileMentions();
	} catch (err) {
		console.error("[FileMention] Failed to fetch files:", err);
		hideFileMentions();
	}
}

function renderFileMentions(files, displayState = "normal") {
	const session = getActiveSession();
	if (session) session.fileMentionSelectedIndex = 0;

	if (displayState === "no-project") {
		setElementHtml(
			fileMentionsEl,
			'<div class="file-mention-no-project">Select a project to search files</div>',
		);
		return;
	}

	if (files.length === 0) {
		setElementHtml(
			fileMentionsEl,
			'<div class="file-mention-empty">No files found</div>',
		);
		return;
	}

	setElementHtml(
		fileMentionsEl,
		files
			.map((file, i) => {
				const icon = getFileIcon(file);
				return `
      <div class="file-mention-item${i === 0 ? " selected" : ""}" data-file="${escapeAttr(file)}">
        <span class="file-icon">${icon}</span>
        <span class="file-path">${escapeHtml(file)}</span>
      </div>
    `;
			})
			.join(""),
	);
}

function getFileIcon(filePath) {
	const ext = filePath.split(".").pop().toLowerCase();
	const iconMap = {
		js: "📜",
		ts: "📘",
		jsx: "⚛️",
		tsx: "⚛️",
		py: "🐍",
		json: "📋",
		md: "📝",
		css: "🎨",
		scss: "🎨",
		html: "🌐",
		svg: "🖼️",
		png: "🖼️",
		jpg: "🖼️",
		jpeg: "🖼️",
		gif: "🖼️",
		yml: "⚙️",
		yaml: "⚙️",
		toml: "⚙️",
		sh: "🔧",
		bash: "🔧",
		zsh: "🔧",
	};
	return iconMap[ext] || "📄";
}

function showFileMentions() {
	fileMentionsEl.classList.remove("hidden");
}

function hideFileMentions() {
	fileMentionsEl.classList.add("hidden");
	const session = getActiveSession();
	if (session) {
		session.fileMentionSelectedIndex = 0;
		session.fileMentionQuery = "";
		session.fileMentionStartPos = -1;
		clearTimeout(session.fileMentionDebounceTimer);
	}
}

function handleFileMentionKeydown(e) {
	const session = getActiveSession();
	if (!session) return false;

	const items = fileMentionsEl.querySelectorAll(".file-mention-item");
	if (items.length === 0) return false;

	if (e.key === "ArrowDown") {
		e.preventDefault();
		session.fileMentionSelectedIndex = Math.min(
			session.fileMentionSelectedIndex + 1,
			items.length - 1,
		);
		updateFileMentionSelection(items);
		return true;
	}

	if (e.key === "ArrowUp") {
		e.preventDefault();
		session.fileMentionSelectedIndex = Math.max(
			session.fileMentionSelectedIndex - 1,
			0,
		);
		updateFileMentionSelection(items);
		return true;
	}

	if (e.key === "Enter" || e.key === "Tab") {
		e.preventDefault();
		const selected = items[session.fileMentionSelectedIndex];
		if (selected) {
			selectFileMention(selected.dataset.file);
		}
		return true;
	}

	if (e.key === "Escape") {
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
		item.classList.toggle("selected", i === session.fileMentionSelectedIndex);
	});
	items[session.fileMentionSelectedIndex]?.scrollIntoView({ block: "nearest" });
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
	chatInput.dispatchEvent(new Event("input"));
}

// Mode button functions

function cycleMode() {
	// If switching away from plan mode while confirmation is pending, auto-deny
	const activeSession = getActiveSession();
	if (activeSession && activeSession.pendingPlanConfirmation) {
		sendPlanResponse(
			activeSession,
			activeSession.pendingPlanConfirmation.id,
			false,
			"Mode changed",
		);
		activeSession.pendingPlanConfirmation = null;
		if (activeSession.containerEl) {
			const planBlock = activeSession.containerEl.querySelector(
				".plan-confirmation-block:not(.submitted)",
			);
			if (planBlock) {
				markPlanConfirmationSubmitted(planBlock, "rejected");
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
	modeBtn.classList.remove("mode-default", "mode-plan", "mode-bypass");

	// Add current mode class
	modeBtn.classList.add(`mode-${mode.name}`);

	// Update title/tooltip
	modeBtn.title = mode.label;
}

function openSidebar() {
	sidebar.classList.remove("hidden");
	sidebarOverlay.classList.remove("hidden");
	projectSearch.focus();
}

function closeSidebar() {
	sidebar.classList.add("hidden");
	sidebarOverlay.classList.add("hidden");
	state.forceNewTab = false;
}

async function searchProjects(query) {
	setElementHtml(projectList, '<div class="loading">Searching</div>');
	sessionList.classList.add("hidden");
	projectList.classList.remove("hidden");
	newSessionBtn.classList.add("hidden");

	try {
		const projects = await api(
			`/api/projects/search?q=${encodeURIComponent(query)}`,
		);

		if (projects.length === 0) {
			setElementHtml(
				projectList,
				`
        <div class="empty-state">
          ${query ? "No projects match your search" : "No Claude projects found"}
        </div>
      `,
			);
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

		setElementHtml(
			projectList,
			projects
				.map((p) => {
					const favored = isFavorite(p.path);
					return `
        <div class="project-item" data-name="${escapeAttr(p.name)}" data-path="${escapeAttr(p.path)}">
          <button class="favorite-btn${favored ? " active" : ""}" data-path="${escapeAttr(p.path)}" aria-label="${favored ? "Unfavorite" : "Favorite"}">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="${favored ? "currentColor" : "none"}" stroke="currentColor" stroke-width="2">
              <polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"></polygon>
            </svg>
          </button>
          <span class="session-count">${p.sessionCount}</span>
          <span class="project-name">${escapeHtml(p.displayName)}</span>
          <span class="project-path">${escapeHtml(p.path)}</span>
        </div>
      `;
				})
				.join(""),
		);

		// Add click handlers for favorite buttons
		projectList.querySelectorAll(".favorite-btn").forEach((btn) => {
			btn.addEventListener("click", (e) => {
				e.stopPropagation();
				const path = btn.dataset.path;
				toggleFavorite(path);
				// Re-render to update order and button state
				searchProjects(projectSearch.value);
			});
		});

		projectList.querySelectorAll(".project-item").forEach((el) => {
			el.addEventListener("click", () => {
				selectProject(
					el.dataset.name,
					el.dataset.path,
					el.querySelector(".project-name").textContent,
				);
			});
		});
	} catch (err) {
		setElementHtml(
			projectList,
			`<div class="empty-state">Error: ${escapeHtml(err.message)}</div>`,
		);
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
		activeSession.pendingText = "";
		activeSession.pendingQuestion = null;
		activeSession.pendingPlanConfirmation = null;
		activeSession.attachments = [];
		activeSession.lastTokenUsage = null;
		activeSession.lastContextWindow = null;
		activeSession.hasUnread = false;
		activeSession.needsHistoryLoad = false;
		activeSession.fileMentionSelectedIndex = 0;
		activeSession.fileMentionQuery = "";
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
		projectList.classList.add("hidden");
		sessionList.classList.remove("hidden");
		setElementHtml(
			sessionsContainer,
			'<div class="loading">Loading sessions</div>',
		);
		newSessionBtn.classList.remove("hidden");

		try {
			const sessions = await api(
				`/api/projects/${encodeURIComponent(name)}/sessions`,
			);

			if (sessions.length === 0) {
				setElementHtml(
					sessionsContainer,
					'<div class="empty-state">No sessions yet</div>',
				);
			} else {
				setElementHtml(
					sessionsContainer,
					sessions
						.map(
							(s) => `
          <div class="session-item" data-id="${escapeAttr(s.id)}">
            <span class="session-preview">${escapeHtml(s.preview)}</span>
            <span class="session-date">${formatDate(s.lastModified)}</span>
          </div>
        `,
						)
						.join(""),
				);

				sessionsContainer.querySelectorAll(".session-item").forEach((el) => {
					el.addEventListener("click", () => resumeSession(el.dataset.id));
				});
			}
		} catch (err) {
			setElementHtml(
				sessionsContainer,
				`<div class="empty-state">Error: ${escapeHtml(err.message)}</div>`,
			);
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
	if (prevSession) prevSession.containerEl.classList.remove("active");
	state.activeSessionIndex = -1; // Reset to force switch
	switchToSession(state.sessions.length - 1);

	projectNameEl.textContent = displayName;
	if (!skipHashUpdate) updateHash(name);

	// Load custom commands for this project
	loadCustomCommands(path);

	projectList.classList.add("hidden");
	sessionList.classList.remove("hidden");
	setElementHtml(
		sessionsContainer,
		'<div class="loading">Loading sessions</div>',
	);
	newSessionBtn.classList.remove("hidden");

	// Initialize container with welcome message
	clearMessages(session);

	try {
		const sessions = await api(
			`/api/projects/${encodeURIComponent(name)}/sessions`,
		);

		if (sessions.length === 0) {
			setElementHtml(
				sessionsContainer,
				'<div class="empty-state">No sessions yet</div>',
			);
		} else {
			setElementHtml(
				sessionsContainer,
				sessions
					.map(
						(s) => `
        <div class="session-item" data-id="${escapeAttr(s.id)}">
          <span class="session-preview">${escapeHtml(s.preview)}</span>
          <span class="session-date">${formatDate(s.lastModified)}</span>
        </div>
      `,
					)
					.join(""),
			);

			sessionsContainer.querySelectorAll(".session-item").forEach((el) => {
				el.addEventListener("click", () => resumeSession(el.dataset.id));
			});
		}
	} catch (err) {
		setElementHtml(
			sessionsContainer,
			`<div class="empty-state">Error: ${escapeHtml(err.message)}</div>`,
		);
	}

	saveSessionState();
}

async function resumeSession(sessionId, skipHashUpdate = false) {
	const session = getActiveSession();
	if (!session) return;

	// Unwatch old session before overwriting
	if (session.sessionId && session.sessionId !== sessionId) {
		if (state.ws?.readyState === WebSocket.OPEN) {
			state.ws.send(
				JSON.stringify({
					type: "unwatch-session",
					projectName: session.project.name,
					sessionId: session.sessionId,
				}),
			);
		}
	}

	session.sessionId = sessionId;
	saveSessionState(); // Persist immediately before history load - ensures sessionId survives even if loadSessionHistory fails
	if (!skipHashUpdate) updateHash(session.project.name, sessionId);
	closeSidebar();

	// Watch before history load so live JSONL writes are buffered instead of missed.
	if (state.ws?.readyState === WebSocket.OPEN) {
		state.ws.send(
			JSON.stringify({
				type: "watch-session",
				projectName: session.project.name,
				sessionId,
			}),
		);
	}

	await loadSessionHistory(session);

	if (
		session !== getActiveSession() ||
		!state.sessions.includes(session) ||
		session.sessionId !== sessionId
	) {
		return;
	}

	enableChat();
	saveSessionState();
}

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
		contextBar.classList.add("hidden");
		tokenUsageEl.textContent = "";
		tokenUsageEl.classList.add("hidden");
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
		contextWindow: ctxWindow,
	} = usage;

	// Support both old format (used, total) and new format (cumulativeTotal, contextWindow)
	const totalTokens = cumulativeTotal || used;
	const windowSize = contextWindow || ctxWindow;

	if (!totalTokens || !windowSize) {
		contextBar.classList.add("hidden");
		tokenUsageEl.textContent = "";
		tokenUsageEl.classList.add("hidden");
		return;
	}

	// Store metrics on session
	session.lastTokenUsage = totalTokens;
	session.lastContextWindow = windowSize;
	if (model) session.model = model;
	if (cacheRead !== undefined || cacheCreate !== undefined) {
		session.cacheMetrics = {
			cacheRead: cacheRead || 0,
			cacheCreate: cacheCreate || 0,
		};
	}

	if (state.sessions.indexOf(session) !== state.activeSessionIndex) return;

	// Format numbers for display (in thousands)
	const totalK = Math.round(totalTokens / 1000);
	const windowK = Math.round(windowSize / 1000);

	// Calculate percentage of context window being used
	const pct = Math.min(Math.round((totalTokens / windowSize) * 100), 100);

	// Update main display: "15k / 200k (8%)"
	tokenUsageEl.textContent = `${totalK}k / ${windowK}k (${pct}%)`;
	tokenUsageEl.classList.remove("hidden");

	// Color coding based on utilization
	if (pct > 95) {
		tokenUsageEl.style.color = "var(--error)";
	} else if (pct > 80) {
		tokenUsageEl.style.color = "var(--warning)";
	} else {
		tokenUsageEl.style.color = "";
	}

	// Update context bar
	contextBar.classList.remove("hidden");
	if (session.model) {
		contextModel.textContent = session.model;
		contextModel.classList.remove("hidden");
	}

	// Update visual bar
	contextUsageFill.style.width = `${pct}%`;
	contextUsageText.textContent = `${totalK}k/${windowK}k`;

	// Color the fill based on usage
	if (pct > 95) {
		contextUsageFill.style.background = "var(--neon-red)";
	} else if (pct > 80) {
		contextUsageFill.style.background = "var(--neon-orange)";
	} else {
		contextUsageFill.style.background = "var(--neon-cyan)";
	}

	// Build tooltip with detailed breakdown
	const inputTokens = cumulativeInput || 0;
	const outputTokens = cumulativeOutput || 0;
	const cacheReadTokens = cacheRead || 0;
	const cacheCreateTokens = cacheCreate || 0;

	const tooltipText =
		`Input: ${inputTokens.toLocaleString()} tokens\n` +
		`Output: ${outputTokens.toLocaleString()} tokens\n` +
		`Cache Read: ${cacheReadTokens.toLocaleString()} tokens\n` +
		`Cache Created: ${cacheCreateTokens.toLocaleString()} tokens\n` +
		`Context Window: ${windowSize.toLocaleString()} tokens`;
	contextBar.title = tooltipText;
}

async function readJsonResponse(res, url) {
	const text = await res.text();

	try {
		return text ? JSON.parse(text) : {};
	} catch (err) {
		const contentType =
			res.headers.get("content-type") || "unknown content type";
		const snippet = text.slice(0, 80).replace(/\s+/g, " ").trim();
		throw new Error(
			`Expected JSON from ${url}, got ${res.status} ${contentType}: ${snippet}`,
		);
	}
}

async function api(url, body = null) {
	const opts = { headers: {} };

	if (state.token) {
		opts.headers["Authorization"] = `Bearer ${state.token}`;
	}

	if (body) {
		opts.method = "POST";
		opts.headers["Content-Type"] = "application/json";
		opts.body = JSON.stringify(body);
	}

	const res = await fetch(url, opts);
	const data = await readJsonResponse(res, url);

	if (!res.ok) {
		if (res.status === 401 || res.status === 403) {
			localStorage.removeItem("token");
			state.token = null;
			showAuth();
		}
		throw new Error(data.error || "Request failed");
	}

	return data;
}

// ============================================
// File Paste/Drop Attachment Handling
// ============================================

// Allowed file types for attachments

function isAllowedFileType(file) {
	const allowedTypes = [
		"image/png",
		"image/jpeg",
		"image/gif",
		"image/webp",
		"text/plain",
		"text/markdown",
		"application/pdf",
	];
	const allowedExtensions = [
		".txt",
		".md",
		".pdf",
		".png",
		".jpg",
		".jpeg",
		".gif",
		".webp",
	];

	if (allowedTypes.includes(file.type)) return true;

	const ext = "." + file.name.split(".").pop().toLowerCase();
	return allowedExtensions.includes(ext);
}

// Determine attachment type from file

function getAttachmentType(file) {
	if (file.type.startsWith("image/")) return "image";
	if (file.type === "application/pdf" || file.name.endsWith(".pdf"))
		return "pdf";
	if (file.name.endsWith(".md")) return "markdown";
	return "text";
}

// Convert file to base64 data URL

async function uploadFile(file) {
	const formData = new FormData();
	formData.append("file", file);

	const res = await fetch("/api/upload", {
		method: "POST",
		headers: {
			Authorization: `Bearer ${state.token}`,
		},
		body: formData,
	});

	if (!res.ok) {
		const data = await readJsonResponse(res, "/api/upload").catch((err) => {
			console.error("[Upload] Failed to parse error response:", err);
			return {};
		});
		throw new Error(data.error || "File upload failed");
	}

	return readJsonResponse(res, "/api/upload");
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
		size: file.size,
	};

	try {
		if (attachment.type === "image") {
			// Convert image to base64 for preview and sending
			attachment.data = await fileToBase64(file);
			attachment.preview = attachment.data;
			attachment.mediaType = file.type;
		} else if (attachment.type === "text" || attachment.type === "markdown") {
			// Read text content directly
			attachment.data = await file.text();
			attachment.preview = truncateText(attachment.data, 100);
		} else if (attachment.type === "pdf") {
			// Upload PDF and get extracted text
			const result = await uploadFile(file);
			attachment.data = result.content;
			attachment.preview = truncateText(result.content, 100);
		}

		session.attachments.push(attachment);
		renderAttachmentPreview();
		chatInput.focus();
	} catch (err) {
		console.error("[Attachment] Error processing file:", err);
		alert(`Failed to process file: ${err.message}`);
	}
}

// Render attachment preview area

function renderAttachmentPreview() {
	const session = getActiveSession();
	if (!session || session.attachments.length === 0) {
		attachmentPreviewEl.classList.add("hidden");
		attachmentPreviewEl.replaceChildren();
		return;
	}

	attachmentPreviewEl.classList.remove("hidden");
	setElementHtml(
		attachmentPreviewEl,
		session.attachments
			.map((att) => {
				if (att.type === "image") {
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
			})
			.join(""),
	);
}

// Remove attachment by ID via event delegation

function removeAttachment(id) {
	const session = getActiveSession();
	if (session) {
		session.attachments = session.attachments.filter((att) => att.id !== id);
		renderAttachmentPreview();
	}
}

// Format user message display with attachments

function formatUserMessageWithAttachments(content, attachments) {
	if (!attachments || attachments.length === 0) return content;

	const attachmentText = attachments
		.map((att) => {
			if (att.type === "image") {
				return `[Image: ${att.name}]`;
			}
			return `[${att.type.toUpperCase()}: ${att.name}]`;
		})
		.join(" ");

	return content ? `${content}\n\n${attachmentText}` : attachmentText;
}

export {
	setModel,
	updateModelUI,
	isLocalBuiltinCommand,
	parseCommand,
	executeBuiltinCommand,
	handleClearCommand,
	handleHelpCommand,
	handleTokensCommand,
	handleContextCommand,
	handleModelCommand,
	appendCommandMessage,
	getAllCommands,
	loadCustomCommands,
	sendMessage,
	calculateCommandScore,
	handleSlashCommandInput,
	renderSlashCommands,
	showSlashCommands,
	hideSlashCommands,
	handleSlashCommandKeydown,
	updateSlashCommandSelection,
	insertSlashCommand,
	handleFileMentionInput,
	fetchFileMentions,
	renderFileMentions,
	getFileIcon,
	showFileMentions,
	hideFileMentions,
	handleFileMentionKeydown,
	updateFileMentionSelection,
	selectFileMention,
	cycleMode,
	updateModeButton,
	openSidebar,
	closeSidebar,
	searchProjects,
	selectProject,
	resumeSession,
	enableChat,
	updateTokenUsage,
	readJsonResponse,
	api,
	isAllowedFileType,
	getAttachmentType,
	uploadFile,
	processAndAddAttachment,
	renderAttachmentPreview,
	removeAttachment,
	formatUserMessageWithAttachments,
};
