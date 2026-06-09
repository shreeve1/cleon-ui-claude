import * as State from "./js/state.js";
import * as Dom from "./js/dom.js";
import * as Utils from "./js/utils.js";
import * as Markdown from "./js/markdown.js";
import * as Streaming from "./js/streaming.js";
import * as Notifications from "./js/notifications.js";
import * as Messages from "./js/messages.js";
import * as Sessions from "./js/sessions.js";
import * as Input from "./js/input.js";
import * as TasksUi from "./js/tasks-ui.js";
import * as FilesUi from "./js/files-ui.js";
import * as Auth from "./js/auth.js";
import * as WsSse from "./js/ws-sse.js";

const { state } = State;
let longPressTimer = null;
let contextMenuMessage = null;

function parseHash() {
	const hash = window.location.hash.slice(1);
	if (!hash) return null;

	const projectMatch = hash.match(
		/^\/project\/([^/]+)(?:\/session\/([^/]+))?$/,
	);
	if (!projectMatch) return null;

	return {
		projectName: decodeURIComponent(projectMatch[1]),
		sessionId: projectMatch[2] ? decodeURIComponent(projectMatch[2]) : null,
	};
}

function updateHash(projectName, sessionId = null) {
	let hash = "";
	if (projectName) {
		hash = `/project/${encodeURIComponent(projectName)}`;
		if (sessionId) hash += `/session/${encodeURIComponent(sessionId)}`;
	}

	const newUrl = hash ? `#${hash}` : window.location.pathname;
	if (window.location.hash === "" && hash) {
		window.history.replaceState(null, "", newUrl);
	} else {
		window.history.pushState(null, "", newUrl);
	}
}

async function restoreFromHash() {
	const route = parseHash();
	if (!route) return;

	console.log("[Session] Restoring from hash:", route);

	try {
		const { path: projectPath } = await Input.api(
			`/api/projects/${encodeURIComponent(route.projectName)}/path`,
		);
		const displayName = projectPath.split("/").pop();

		await Input.selectProject(
			route.projectName,
			projectPath,
			displayName,
			true,
		);
		Input.closeSidebar();

		if (route.sessionId) {
			await Input.resumeSession(route.sessionId, true);
			const session = Sessions.getActiveSession();
			if (session && !session.sessionId) session.sessionId = route.sessionId;
		} else {
			Input.enableChat();
		}

		Sessions.saveSessionState();
	} catch (err) {
		console.error("Failed to restore from hash:", err);
	}
}

async function clearLegacyServiceWorkers() {
	if (!("serviceWorker" in navigator)) return false;

	try {
		const registrations = await navigator.serviceWorker.getRegistrations();
		if (registrations.length === 0) {
			sessionStorage.removeItem(State.SW_CLEANUP_RELOAD_KEY);
			return false;
		}

		await Promise.all(
			registrations.map((registration) => registration.unregister()),
		);

		if ("caches" in window) {
			const cacheNames = await caches.keys();
			await Promise.all(
				cacheNames.map((cacheName) => caches.delete(cacheName)),
			);
		}

		if (
			navigator.serviceWorker.controller &&
			!sessionStorage.getItem(State.SW_CLEANUP_RELOAD_KEY)
		) {
			sessionStorage.setItem(State.SW_CLEANUP_RELOAD_KEY, "1");
			window.location.reload();
			return true;
		}

		sessionStorage.removeItem(State.SW_CLEANUP_RELOAD_KEY);
	} catch (err) {
		console.warn("[ServiceWorker] Cleanup failed:", err);
	}

	return false;
}

function showMain() {
	Auth.showMain();
	Notifications.updateNotificationPermission();
	Input.loadCustomCommands();

	Sessions.restoreSessionState().then((restored) => {
		if (!restored) restoreFromHash();
		WsSse.connectWebSocket();
		WsSse.connectEventStream();
	});
}

function bindModuleGlobals() {
	Object.assign(window, {
		api: Input.api,
		clearTasks: TasksUi.clearTasks,
		connectEventStream: WsSse.connectEventStream,
		connectWebSocket: WsSse.connectWebSocket,
		enableChat: Input.enableChat,
		getActiveSession: Sessions.getActiveSession,
		handleWsMessage: WsSse.handleWsMessage,
		hideFileMentions: Input.hideFileMentions,
		hideSlashCommands: Input.hideSlashCommands,
		loadCustomCommands: Input.loadCustomCommands,
		openSidebar: Input.openSidebar,
		parseHash,
		renderAttachmentPreview: Input.renderAttachmentPreview,
		renderPlanConfirmation: Messages.renderPlanConfirmation,
		renderQuestion: Messages.renderQuestion,
		renderTaskPanel: TasksUi.renderTaskPanel,
		restoreFromHash,
		restoreSessionState: Sessions.restoreSessionState,
		scrollToBottom: Messages.scrollToBottom,
		StreamingRenderer: Streaming.StreamingRenderer,
		updateStreamingMessage: Streaming.updateStreamingMessage,
		showAuth: Auth.showAuth,
		showMain,
		updateHash,
		updateTokenUsage: Input.updateTokenUsage,
	});
}

function setActiveControlsDisabled(disabled) {
	Dom.abortBtn.classList.toggle("hidden", !disabled);
	Dom.chatInput.disabled = disabled;
	Dom.sendBtn.disabled = disabled;
	Dom.modeBtn.disabled = disabled;
	Dom.modelBtn.disabled = disabled;
	Dom.attachBtn.disabled = disabled;
}

function showContextMenu(messageEl, x, y) {
	const contextMenuEl = document.getElementById("message-context-menu");
	if (!contextMenuEl || !messageEl) return;

	contextMenuMessage = messageEl;
	const copyCodeBtn = contextMenuEl.querySelector('[data-action="copy-code"]');
	if (copyCodeBtn)
		copyCodeBtn.classList.toggle(
			"hidden",
			!messageEl.querySelector("pre code"),
		);

	contextMenuEl.style.left = `${x}px`;
	contextMenuEl.style.top = `${y}px`;
	contextMenuEl.classList.remove("hidden");
}

function hideContextMenu() {
	const contextMenuEl = document.getElementById("message-context-menu");
	if (contextMenuEl) contextMenuEl.classList.add("hidden");
	contextMenuMessage = null;
}

function bindSessionContainerEvents() {
	Dom.scrollToBottomBtn.addEventListener("click", () => {
		const session = Sessions.getActiveSession();
		if (!session?.containerEl) return;
		session.containerEl.scrollTo({
			top: session.containerEl.scrollHeight,
			behavior: "smooth",
		});
		session.unreadCount = 0;
		session.isAtBottom = true;
		Messages.updateScrollFAB(session);
	});

	Dom.sessionContainersEl.addEventListener("click", (e) => {
		const copyBtn = e.target.closest(".code-copy-btn");
		if (copyBtn) {
			const codeEl = copyBtn
				.closest(".code-block-wrapper")
				?.querySelector("code");
			if (codeEl) {
				navigator.clipboard.writeText(codeEl.textContent).then(() => {
					copyBtn.textContent = "Copied!";
					setTimeout(() => {
						copyBtn.textContent = "Copy";
					}, 2000);
				});
			}
			return;
		}

		const messageIdEl = e.target.closest(".message-id");
		if (messageIdEl?.title) {
			Utils.copyToClipboard(messageIdEl.title, messageIdEl);
			e.preventDefault();
			return;
		}

		const fileLinkEl = e.target.closest(".file-link");
		if (fileLinkEl?.dataset.path) {
			Utils.copyToClipboard(fileLinkEl.dataset.path, fileLinkEl);
			e.preventDefault();
			return;
		}

		// Tool pill expand/collapse delegation
		const header = e.target.closest(".tool-pill-header");
		if (!header) return;

		const pill = header.closest(".message.tool-pill");
		const output = pill?.querySelector(".tool-pill-output");
		if (!output) return;

		const isExpanded = !output.classList.contains("hidden");
		if (isExpanded) {
			output.classList.add("hidden");
			header.classList.remove("expanded");
		} else {
			output.classList.remove("hidden");
			header.classList.add("expanded");
		}
	});

	Dom.sessionContainersEl.addEventListener("contextmenu", (e) => {
		const messageEl = e.target.closest(".message");
		if (!messageEl) return;
		e.preventDefault();
		showContextMenu(messageEl, e.clientX, e.clientY);
	});

	Dom.sessionContainersEl.addEventListener(
		"touchstart",
		(e) => {
			const messageEl = e.target.closest(".message");
			if (!messageEl) return;
			const touch = e.touches[0];
			longPressTimer = setTimeout(
				() => showContextMenu(messageEl, touch.clientX, touch.clientY),
				500,
			);
		},
		{ passive: true },
	);
	Dom.sessionContainersEl.addEventListener("touchend", () =>
		clearTimeout(longPressTimer),
	);
	Dom.sessionContainersEl.addEventListener("touchmove", () =>
		clearTimeout(longPressTimer),
	);

	const contextMenuEl = document.getElementById("message-context-menu");
	contextMenuEl?.addEventListener("click", (e) => {
		const action = e.target.closest("[data-action]")?.dataset.action;
		if (!action || !contextMenuMessage) return;

		if (action === "copy-text")
			Utils.copyToClipboard(contextMenuMessage.textContent || "");
		if (action === "copy-code")
			Utils.copyToClipboard(
				contextMenuMessage.querySelector("pre code")?.textContent || "",
			);
		hideContextMenu();
	});

	document.addEventListener("click", (e) => {
		if (!contextMenuEl?.contains(e.target)) hideContextMenu();
		if (!e.target.closest("#session-bar")) {
			document
				.querySelectorAll(".session-tab.show-close")
				.forEach((tab) => tab.classList.remove("show-close"));
		}
	});
	document.addEventListener("touchstart", (e) => {
		if (!contextMenuEl?.contains(e.target)) hideContextMenu();
	});
}

function bindChatEvents() {
	Dom.chatForm.addEventListener("submit", (e) => {
		e.preventDefault();
		const content = Dom.chatInput.value.trim();
		const session = Sessions.getActiveSession();
		if (!content || session?.isStreaming) return;
		if (!session) {
			alert("Please select a project first (tap the menu icon)");
			return;
		}
		Input.sendMessage(content);
	});

	Dom.chatInput.addEventListener("input", () => {
		Dom.chatInput.style.height = "auto";
		Dom.chatInput.style.height = `${Math.min(Dom.chatInput.scrollHeight, 150)}px`;
	});
	Dom.chatInput.addEventListener("input", Input.handleSlashCommandInput);
	Dom.chatInput.addEventListener("input", Input.handleFileMentionInput);
	Dom.chatInput.addEventListener("blur", () => {
		setTimeout(Input.hideSlashCommands, 150);
		setTimeout(Input.hideFileMentions, 150);
	});
	Dom.chatInput.addEventListener("focus", () => {
		setTimeout(
			() =>
				Dom.chatInput.scrollIntoView({ behavior: "smooth", block: "center" }),
			300,
		);
	});
	Dom.chatInput.addEventListener("keydown", (e) => {
		if (e.key === "Tab" && e.shiftKey) {
			e.preventDefault();
			Input.cycleMode();
			return;
		}
		if (
			!Dom.slashCommandsEl.classList.contains("hidden") &&
			Input.handleSlashCommandKeydown(e)
		)
			return;
		if (
			!Dom.fileMentionsEl.classList.contains("hidden") &&
			Input.handleFileMentionKeydown(e)
		)
			return;
		if (e.key === "Enter" && !e.shiftKey) {
			e.preventDefault();
			Dom.chatForm.dispatchEvent(new Event("submit"));
		}
	});
}

function bindSessionEvents() {
	Dom.sessionTabsEl.addEventListener("click", (e) => {
		const closeBtn = e.target.closest(".close-tab");
		if (closeBtn) {
			Sessions.closeSession(
				parseInt(closeBtn.closest(".session-tab").dataset.index, 10),
			);
			return;
		}

		const tab = e.target.closest(".session-tab");
		if (!tab) return;

		const isMobile = window.matchMedia("(max-width: 767px)").matches;
		if (isMobile && !tab.classList.contains("show-close")) {
			Dom.sessionTabsEl
				.querySelectorAll(".session-tab")
				.forEach((item) => item.classList.remove("show-close"));
			tab.classList.add("show-close");
			return;
		}

		Sessions.switchToSession(parseInt(tab.dataset.index, 10));
		FilesUi.updateFilesButtonState();
		state.fileEditor.dirCache = {};
		if (state.fileEditor.isOpen) FilesUi.closeFileTree();
	});

	Dom.newSessionTabBtn.addEventListener("click", () => {
		if (state.sessions.length >= State.MAX_SESSIONS) {
			alert(`Maximum ${State.MAX_SESSIONS} sessions reached`);
			return;
		}
		state.forceNewTab = true;
		Input.openSidebar();
	});

	Dom.abortBtn.addEventListener("click", () => {
		const session = Sessions.getActiveSession();
		if (session?.sessionId && session.isStreaming) {
			state.ws.send(
				JSON.stringify({ type: "abort", sessionId: session.sessionId }),
			);
		}
	});

	document.addEventListener("keydown", (e) => {
		if (!e.ctrlKey || e.shiftKey || e.altKey || e.metaKey) return;
		const num = parseInt(e.key, 10);
		if (num >= 1 && num <= State.MAX_SESSIONS) {
			e.preventDefault();
			if (num - 1 < state.sessions.length) Sessions.switchToSession(num - 1);
		}
	});
}

function bindSidebarEvents() {
	Dom.menuBtn.addEventListener("click", Input.openSidebar);
	Dom.closeSidebarBtn.addEventListener("click", Input.closeSidebar);
	Dom.sidebarOverlay.addEventListener("click", Input.closeSidebar);

	Dom.projectSearch.addEventListener("input", () => {
		clearTimeout(state.searchTimeout);
		state.searchTimeout = setTimeout(
			() => Input.searchProjects(Dom.projectSearch.value),
			State.SEARCH_DEBOUNCE_MS,
		);
	});
	Dom.projectSearch.addEventListener("focus", () => {
		if (!Dom.projectSearch.value) Input.searchProjects("");
	});
	Dom.backToProjectsBtn.addEventListener("click", () => {
		Dom.sessionList.classList.add("hidden");
		Dom.projectList.classList.remove("hidden");
		Dom.newSessionBtn.classList.add("hidden");
		Input.searchProjects(Dom.projectSearch.value);
	});
	Dom.newSessionBtn.addEventListener("click", () => {
		const session = Sessions.getActiveSession();
		if (!session) return;
		Input.setModel(State.DEFAULT_MODEL);
		session.sessionId = null;
		updateHash(session.project.name);
		Messages.clearMessages(session);
		Input.enableChat();
		Input.closeSidebar();
		Sessions.saveSessionState();
	});
}

function bindAttachmentEvents() {
	Dom.attachmentPreviewEl.addEventListener("click", (e) => {
		const item = e.target
			.closest(".attachment-remove")
			?.closest(".attachment-item");
		if (item) Input.removeAttachment(item.dataset.id);
	});
	Dom.attachBtn.addEventListener("click", () => Dom.fileInput.click());
	Dom.fileInput.addEventListener("change", async (e) => {
		for (const file of Array.from(e.target.files || [])) {
			if (Input.isAllowedFileType(file))
				await Input.processAndAddAttachment(file);
		}
		Dom.fileInput.value = "";
	});

	document.addEventListener("paste", async (e) => {
		const session = Sessions.getActiveSession();
		if (!session || Dom.chatInput.disabled) return;
		const files = Array.from(e.clipboardData?.items || [])
			.filter((item) => item.kind === "file")
			.map((item) => item.getAsFile())
			.filter((file) => file && Input.isAllowedFileType(file));
		if (files.length === 0) return;
		e.preventDefault();
		for (const file of files) await Input.processAndAddAttachment(file);
	});

	let dragCounter = 0;
	document.addEventListener("dragenter", (e) => {
		e.preventDefault();
		if (
			!Sessions.getActiveSession() ||
			Dom.chatInput.disabled ||
			!e.dataTransfer?.types?.includes("Files")
		)
			return;
		dragCounter++;
		if (dragCounter === 1) Dom.dropZoneOverlay.classList.remove("hidden");
	});
	document.addEventListener("dragleave", (e) => {
		e.preventDefault();
		dragCounter--;
		if (dragCounter === 0) Dom.dropZoneOverlay.classList.add("hidden");
	});
	document.addEventListener("dragover", (e) => e.preventDefault());
	document.addEventListener("drop", async (e) => {
		e.preventDefault();
		dragCounter = 0;
		Dom.dropZoneOverlay.classList.add("hidden");
		if (!Sessions.getActiveSession() || Dom.chatInput.disabled) return;
		for (const file of Array.from(e.dataTransfer?.files || [])) {
			if (Input.isAllowedFileType(file))
				await Input.processAndAddAttachment(file);
		}
	});
}

function bindEditorEvents() {
	Dom.filesBtn.addEventListener("click", FilesUi.openFileTree);
	Dom.closeFileTreeBtn.addEventListener("click", FilesUi.closeFileTree);
	Dom.fileTreeOverlay.addEventListener("click", FilesUi.closeFileTree);
	Dom.fileTreeSearch.addEventListener("input", (e) => {
		state.fileEditor.searchQuery = e.target.value;
		FilesUi.renderFileTree();
	});
	Dom.editorCloseBtn.addEventListener("click", FilesUi.closeEditor);
	Dom.editorSaveBtn.addEventListener("click", FilesUi.saveCurrentFile);

	if (window.visualViewport) {
		window.visualViewport.addEventListener("resize", () => {
			if (document.activeElement === Dom.chatInput)
				Dom.chatInput.scrollIntoView({ behavior: "smooth", block: "center" });
			FilesUi.handleEditorViewportResize();
		});
		window.visualViewport.addEventListener(
			"scroll",
			FilesUi.handleEditorViewportResize,
		);
	}
}

function bindModelAndModeEvents() {
	Dom.modeBtn.addEventListener("click", Input.cycleMode);
	Dom.modelBtn.addEventListener("click", (e) => {
		e.stopPropagation();
		Dom.modelDropdown.classList.toggle("hidden");
	});
	Dom.modelDropdown.querySelectorAll(".dropdown-item").forEach((item) => {
		item.addEventListener("click", () => Input.setModel(item.dataset.model));
	});
	document.addEventListener("click", () =>
		Dom.modelDropdown.classList.add("hidden"),
	);
	Dom.slashCommandsEl.addEventListener("click", (e) => {
		const commandEl = e.target.closest(".slash-command");
		if (commandEl) Input.insertSlashCommand(commandEl.dataset.command);
	});
	Dom.fileMentionsEl.addEventListener("click", (e) => {
		const fileItem = e.target.closest(".file-mention-item");
		if (fileItem) Input.selectFileMention(fileItem.dataset.file);
	});
}

function bindEventHandlers() {
	Dom.authForm.addEventListener("submit", Auth.handleAuthSubmit);
	bindModelAndModeEvents();
	bindChatEvents();
	bindSessionContainerEvents();
	bindSessionEvents();
	bindSidebarEvents();
	bindAttachmentEvents();
	bindEditorEvents();

	window.addEventListener("hashchange", () => {
		if (!state.token) return;
		const session = Sessions.getActiveSession();
		const route = parseHash();
		if (
			!session ||
			!route ||
			session.project.name !== route.projectName ||
			session.sessionId !== route.sessionId
		) {
			restoreFromHash();
		}
	});
}

async function init() {
	State.init();
	Dom.initDomElements();
	bindModuleGlobals();
	bindEventHandlers();

	if (Markdown.initializeMarkdownRenderer()) {
		console.log("[Markdown] Initialized Marked.js + DOMPurify + Prism.js");
	} else {
		console.log("[Markdown] Using fallback regex renderer");
	}

	document
		.getElementById("task-panel-toggle")
		?.addEventListener("click", TasksUi.toggleTaskPanel);
	Input.setModel(state.selectedModel);
	Input.updateModeButton();
	FilesUi.updateFilesButtonState();

	if (await clearLegacyServiceWorkers()) return;

	const status = await Input.api("/api/auth/status").catch(() => ({
		needsSetup: true,
	}));
	if (status.needsSetup) {
		Dom.authBtn.textContent = "Create Account";
		Dom.authForm.dataset.mode = "register";
	}

	if (state.token) showMain();
	else Auth.showAuth();
}

init();

export {
	parseHash,
	updateHash,
	restoreFromHash,
	clearLegacyServiceWorkers,
	showMain,
	setActiveControlsDisabled,
	init,
};
