import { state } from "./state.js";
import {
	$,
	setElementHtml,
	filesBtn,
	fileTreeDrawer,
	fileTreeOverlay,
	fileTreeContent,
	fileTreeSearch,
	closeFileTreeBtn,
	editorScreen,
	editorFilePath,
	editorStatus,
	editorSaveBtn,
	editorCloseBtn,
} from "./dom.js";
import { escapeHtml, escapeAttr } from "./utils.js";
import { getActiveSession } from "./sessions.js";

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

let monacoEditor = null;

// Current file in editor
let currentEditorFile = null;
let editorOriginalContent = "";
let editorLanguage = "plaintext";

// Map file extensions to Monaco languages
const monacoLanguageMap = {
	js: "javascript",
	ts: "typescript",
	html: "html",
	css: "css",
	json: "json",
	md: "markdown",
	py: "python",
	rb: "ruby",
	sh: "shell",
	bash: "shell",
	yaml: "yaml",
	yml: "yaml",
	xml: "xml",
	sql: "sql",
	go: "go",
	rs: "rust",
	java: "java",
	c: "c",
	cpp: "cpp",
	h: "c",
	hpp: "cpp",
	php: "php",
	vue: "vue",
	svelte: "svelte",
};

function handleEditorViewportResize() {
	if (!window.visualViewport) return;
	if (!editorScreen || editorScreen.classList.contains("hidden")) return;

	const vv = window.visualViewport;
	editorScreen.style.top = `${vv.offsetTop}px`;
	editorScreen.style.height = `${vv.height}px`;
	editorScreen.style.bottom = "auto";

	// Tell Monaco to recalculate its layout dimensions
	if (monacoEditor) {
		monacoEditor.layout();
	}
}

function resetEditorViewport() {
	if (!editorScreen) return;
	editorScreen.style.top = "";
	editorScreen.style.height = "";
	editorScreen.style.bottom = "";
	if (monacoEditor) {
		monacoEditor.layout();
	}
}

function initMonacoEditor() {
	if (monacoEditor) {
		return monacoEditor;
	}

	const editorElement = $("#editor");
	if (!editorElement) {
		console.error("[Monaco] Editor element not found");
		return null;
	}

	// Require Monaco from the loader
	require.config({
		paths: {
			vs: "https://cdn.jsdelivr.net/npm/monaco-editor@0.45.0/min/vs",
		},
	});

	return new Promise((resolve) => {
		require(["vs/editor/editor.main"], () => {
			monacoEditor = monaco.editor.create(editorElement, {
				value: "",
				language: "plaintext",
				theme: "vs-dark",
				automaticLayout: true,
				fontSize: 14,
				fontFamily: "'SF Mono', Monaco, 'Cascadia Code', 'Consolas', monospace",
				minimap: { enabled: false },
				lineNumbers: "on",
				glyphMargin: false,
				folding: true,
				lineDecorationsWidth: 10,
				lineNumbersMinChars: 4,
				padding: { top: 0, bottom: 0 },
				scrollBeyondLastLine: false,
				renderLineHighlight: "line",
				cursorBlinking: "smooth",
				cursorSmoothCaretAnimation: "on",
				smoothScrolling: true,
				tabSize: 2,
				wordWrap: "on",
			});

			// Track content changes for status updates
			monacoEditor.onDidChangeModelContent(() => {
				updateEditorStatus();
			});

			// Add keyboard shortcuts
			monacoEditor.addCommand(
				monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS,
				() => {
					saveCurrentFile();
				},
			);

			monacoEditor.addCommand(monaco.KeyCode.Escape, () => {
				closeEditor();
			});

			console.log("[Monaco] Editor initialized");
			resolve(monacoEditor);
		});
	});
}

// Open file tree drawer

async function openFileTree() {
	const session = getActiveSession();
	if (!session) return;

	fileTreeDrawer.classList.remove("hidden");
	fileTreeOverlay.classList.remove("hidden");
	state.fileEditor.isOpen = true;

	// Load tree if not already cached
	if (!state.fileEditor.dirCache[""]) {
		await loadFileTree();
	} else {
		// Re-render from cache
		renderFileTree();
	}
}

// Close file tree drawer

function closeFileTree() {
	fileTreeDrawer.classList.add("hidden");
	fileTreeOverlay.classList.add("hidden");
	state.fileEditor.isOpen = false;
}

// Load file tree from server (lazy loading)

async function loadFileTree() {
	const session = getActiveSession();
	if (!session) return;

	setElementHtml(
		fileTreeContent,
		'<div class="file-tree-loading">Loading...</div>',
	);

	try {
		// Load top-level directory only
		const res = await fetch(
			`/api/files/${encodeURIComponent(session.project.name)}/ls`,
			{
				headers: { Authorization: `Bearer ${state.token}` },
			},
		);

		if (!res.ok) {
			throw new Error("Failed to load file tree");
		}

		const data = await readJsonResponse(res, res.url);
		// Cache top-level items
		state.fileEditor.dirCache[""] = data.items;
		state.fileEditor.projectPath = session.project.name;

		renderFileTree();
	} catch (err) {
		console.error("[FileTree] Error:", err);
		setElementHtml(
			fileTreeContent,
			`<div class="file-tree-error">Error: ${escapeHtml(err.message)}</div>`,
		);
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
		const res = await fetch(
			`/api/files/${encodeURIComponent(session.project.name)}/ls?path=${encodeURIComponent(path)}`,
			{
				headers: { Authorization: `Bearer ${state.token}` },
			},
		);

		if (!res.ok) {
			console.error("[FileTree] Failed to load directory:", path);
			return [];
		}

		const data = await readJsonResponse(res, res.url);
		state.fileEditor.dirCache[path] = data.items;
		return data.items;
	} catch (err) {
		console.error("[FileTree] Error loading directory:", err);
		return [];
	}
}

// Render file tree (lazy loading)

async function renderFileTree() {
	setElementHtml(
		fileTreeContent,
		'<div class="file-tree-loading">Loading...</div>',
	);

	const rootItems = await loadDirectory("");
	const html = renderDirectoryItems(
		rootItems,
		0,
		state.fileEditor.searchQuery.toLowerCase(),
	);
	setElementHtml(
		fileTreeContent,
		html || '<div class="file-tree-empty">No files found</div>',
	);

	// Restore expanded folders
	fileTreeContent.querySelectorAll(".tree-folder-header").forEach((header) => {
		const path = header.dataset.path;
		if (state.fileEditor.expandedFolders.has(path)) {
			// Expand folder and load its contents
			const childrenDiv = header.nextElementSibling;
			expandFolder(header, childrenDiv, path);
		}
	});

	// Add click handlers
	fileTreeContent.querySelectorAll(".tree-folder-header").forEach((header) => {
		header.addEventListener("click", () =>
			toggleFolder(header.dataset.path, header),
		);
	});

	fileTreeContent.querySelectorAll(".tree-file").forEach((file) => {
		file.addEventListener("click", () => openFile(file.dataset.path));
	});
}

// Render directory items

function renderDirectoryItems(items, depth, searchQuery) {
	const entries = items
		.filter((item) => {
			if (searchQuery) {
				const fullPath = item.path;
				return fullPath.toLowerCase().includes(searchQuery);
			}
			return true;
		})
		.map((item) => ({
			...item,
			depth,
		}));

	// Sort: directories first, then alphabetically
	entries.sort((a, b) => {
		if (a.isDirectory !== b.isDirectory) {
			return a.isDirectory ? -1 : 1;
		}
		return a.name.localeCompare(b.name, undefined, { sensitivity: "base" });
	});

	return entries
		.map((entry) => {
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
		})
		.join("");
}

// Expand a folder and load its contents

async function expandFolder(header, childrenDiv, path) {
	header.classList.add("expanded");
	const chevron = header.querySelector(".tree-chevron");
	if (chevron) chevron.textContent = "▼";

	// Load directory contents
	const items = await loadDirectory(path);

	if (items.length === 0) {
		setElementHtml(
			childrenDiv,
			'<div class="tree-folder-empty">Empty folder</div>',
		);
	} else {
		// Calculate depth from path (number of path separators)
		const depth = path ? path.split("/").filter(Boolean).length : 0;
		setElementHtml(
			childrenDiv,
			renderDirectoryItems(
				items,
				depth + 1,
				state.fileEditor.searchQuery.toLowerCase(),
			),
		);
		childrenDiv.classList.remove("hidden");

		// Recursively expand nested folders if they were saved
		childrenDiv
			.querySelectorAll(".tree-folder-header")
			.forEach((childHeader) => {
				const childPath = childHeader.dataset.path;
				if (state.fileEditor.expandedFolders.has(childPath)) {
					const childChildrenDiv = childHeader.nextElementSibling;
					expandFolder(childHeader, childChildrenDiv, childPath);
				} else {
					childHeader.addEventListener("click", () =>
						toggleFolder(childHeader.dataset.path, childHeader),
					);
				}
			});

		childrenDiv.querySelectorAll(".tree-file").forEach((file) => {
			file.addEventListener("click", () => openFile(file.dataset.path));
		});
	}
}

// Get icon for file tree item

function getFileTreeIcon(name, isDir) {
	if (isDir) return "📁";

	const ext = name.split(".").pop()?.toLowerCase() || "";
	const iconMap = {
		js: "📜",
		jsx: "⚛️",
		ts: "📘",
		tsx: "⚛️",
		py: "🐍",
		rb: "💎",
		go: "🔵",
		rs: "🦀",
		java: "☕",
		c: "⚙️",
		cpp: "⚙️",
		h: "📄",
		html: "🌐",
		css: "🎨",
		scss: "🎨",
		less: "🎨",
		json: "📋",
		yaml: "📋",
		yml: "📋",
		toml: "📋",
		md: "📝",
		markdown: "📝",
		txt: "📄",
		svg: "🖼️",
		png: "🖼️",
		jpg: "🖼️",
		gif: "🖼️",
		sh: "💻",
		bash: "💻",
		zsh: "💻",
		sql: "🗃️",
		graphql: "◉",
		gitignore: "🙈",
		env: "🔐",
		lock: "🔒",
		sum: "🔒",
	};

	return iconMap[ext] || "📄";
}

// Toggle folder expansion (lazy loading)

async function toggleFolder(path, header = null) {
	// Find header if not provided
	if (!header) {
		header = document.querySelector(
			`.tree-folder-header[data-path="${escapeAttr(path)}"]`,
		);
		if (!header) return;
	}

	const childrenDiv = header.nextElementSibling;

	if (state.fileEditor.expandedFolders.has(path)) {
		// Collapse
		state.fileEditor.expandedFolders.delete(path);
		header.classList.remove("expanded");
		const chevron = header.querySelector(".tree-chevron");
		if (chevron) chevron.textContent = "▶";
		childrenDiv.classList.add("hidden");
	} else {
		// Expand
		state.fileEditor.expandedFolders.add(path);
		await expandFolder(header, childrenDiv, path);
	}

	// Save to localStorage
	localStorage.setItem(
		"expandedFolders",
		JSON.stringify([...state.fileEditor.expandedFolders]),
	);
}

// Open file in editor

async function openFile(filePath) {
	const session = getActiveSession();
	if (!session) return;

	// Close file tree
	closeFileTree();

	try {
		const res = await fetch(
			`/api/files/${encodeURIComponent(session.project.name)}/${encodeURIComponent(filePath)}`,
			{
				headers: { Authorization: `Bearer ${state.token}` },
			},
		);

		if (!res.ok) {
			const err = await readJsonResponse(res, res.url);
			throw new Error(err.error || "Failed to load file");
		}

		const data = await readJsonResponse(res, res.url);

		if (!data.editable) {
			alert("This file type cannot be edited in the browser.");
			return;
		}

		// Initialize Monaco if needed
		if (!monacoEditor) {
			await initMonacoEditor();
		}

		if (!monacoEditor) {
			alert("Failed to initialize editor");
			return;
		}

		// Store current file data
		currentEditorFile = {
			path: data.path,
			content: data.content,
			language: data.language,
		};
		editorOriginalContent = data.content;

		// Detect language from file extension
		const ext = filePath.split(".").pop()?.toLowerCase() || "";
		editorLanguage = monacoLanguageMap[ext] || data.language || "plaintext";

		// Update UI
		editorFilePath.textContent = data.path;

		// Set content and language in Monaco
		monacoEditor.setValue(data.content);
		monaco.editor.setModelLanguage(monacoEditor.getModel(), editorLanguage);

		updateEditorStatus();

		// Show editor
		editorScreen.classList.remove("hidden");
		state.fileEditor.editorMode = true;

		// Focus editor
		monacoEditor.focus();
	} catch (err) {
		console.error("[Editor] Error loading file:", err);
		alert(`Failed to open file: ${err.message}`);
	}
}

// Update editor status bar

function updateEditorStatus() {
	if (!monacoEditor) return;

	const content = monacoEditor.getValue();
	const hasChanges = currentEditorFile && content !== editorOriginalContent;
	const lineCount =
		monacoEditor.getModel()?.getLineCount() || content.split("\n").length;
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
		editorSaveBtn.textContent = "Saving...";

		const res = await fetch(
			`/api/files/${encodeURIComponent(session.project.name)}/${encodeURIComponent(currentEditorFile.path)}`,
			{
				method: "PUT",
				headers: {
					Authorization: `Bearer ${state.token}`,
					"Content-Type": "application/json",
				},
				body: JSON.stringify({ content }),
			},
		);

		if (!res.ok) {
			const err = await readJsonResponse(res, res.url);
			throw new Error(err.error || "Failed to save file");
		}

		// Update original content
		editorOriginalContent = content;
		currentEditorFile.content = content;

		// Show success
		editorStatus.textContent = "Saved!";
		setTimeout(() => updateEditorStatus(), 2000);
	} catch (err) {
		console.error("[Editor] Error saving file:", err);
		alert(`Failed to save file: ${err.message}`);
		editorSaveBtn.disabled = false;
	} finally {
		editorSaveBtn.textContent = "Save";
	}
}

// Close editor

function closeEditor() {
	if (!monacoEditor) return;

	// Check for unsaved changes
	const content = monacoEditor.getValue();
	if (content !== editorOriginalContent) {
		if (!confirm("You have unsaved changes. Close anyway?")) {
			return;
		}
	}

	// Clear editor content
	monacoEditor.setValue("");

	editorScreen.classList.add("hidden");
	state.fileEditor.editorMode = false;
	currentEditorFile = null;
	editorOriginalContent = "";

	// Reset any mobile viewport adjustments
	resetEditorViewport();
}

// Update buttons when session changes

function updateFilesButtonState() {
	const session = getActiveSession();
	filesBtn.disabled = !session;
}

// ==================== End File Tree & Editor Functions ====================

export {
	handleEditorViewportResize,
	resetEditorViewport,
	initMonacoEditor,
	openFileTree,
	closeFileTree,
	loadFileTree,
	loadDirectory,
	renderFileTree,
	renderDirectoryItems,
	expandFolder,
	getFileTreeIcon,
	toggleFolder,
	openFile,
	updateEditorStatus,
	saveCurrentFile,
	closeEditor,
	updateFilesButtonState,
};
