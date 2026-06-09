export const MAX_ATTACHMENTS = 5;
export const PREVIEW_TRUNCATE_LENGTH = 100;
export const TOOL_COMMAND_PREVIEW_LENGTH = 80;
export const WS_RECONNECT_MAX_DELAY = 30000;
export const SEARCH_DEBOUNCE_MS = 300;
export const DEFAULT_MODEL = "opus";
export const MAX_SESSIONS = 5;
export const SW_CLEANUP_RELOAD_KEY = "cleon-sw-cleanup-reloaded";

export const MODES = [
	{ name: "default", label: "Default", color: "var(--neon-cyan)" },
	{ name: "plan", label: "Plan Mode", color: "var(--neon-green)" },
	{ name: "bypass", label: "Bypass Permissions", color: "var(--neon-red)" },
];

function getStorageItem(key) {
	if (typeof localStorage === "undefined") return null;
	return localStorage.getItem(key);
}

function setStorageItem(key, value) {
	if (typeof localStorage === "undefined") return;
	localStorage.setItem(key, value);
}

function createFileEditorState() {
	return {
		isOpen: false,
		editorMode: false,
		expandedFolders: new Set(
			JSON.parse(getStorageItem("expandedFolders") || "[]"),
		),
		selectedPath: null,
		openFiles: [],
		activeFileIndex: -1,
		unsavedChanges: new Set(),
		dirCache: {}, // Cache for lazy-loaded directory contents
		searchQuery: "",
	};
}

export const state = {
	token: getStorageItem("token"),
	ws: null,
	wsReconnectAttempts: 0,
	notificationsEnabled: false,
	eventSource: null,
	sseConnected: false,
	sessions: [],
	activeSessionIndex: -1,
	modeIndex: 2,
	currentMode: "bypass",
	searchTimeout: null,
	customCommands: [],
	forceNewTab: false,
	selectedModel: getStorageItem("selectedModel") || DEFAULT_MODEL,
	fileEditor: createFileEditorState(),
};

// Favorites storage utilities
export function getFavorites() {
	try {
		return JSON.parse(getStorageItem("favoriteProjects") || "[]");
	} catch {
		return [];
	}
}

export function toggleFavorite(projectPath) {
	const favorites = getFavorites();
	const index = favorites.indexOf(projectPath);
	if (index === -1) {
		favorites.push(projectPath);
	} else {
		favorites.splice(index, 1);
	}
	setStorageItem("favoriteProjects", JSON.stringify(favorites));
	return index === -1; // returns true if now favorited
}

export function isFavorite(projectPath) {
	return getFavorites().includes(projectPath);
}

export function setModelState(model) {
	state.selectedModel = model;
	setStorageItem("selectedModel", model);
}

export function init() {
	state.token = getStorageItem("token");
	state.selectedModel = getStorageItem("selectedModel") || DEFAULT_MODEL;
	state.fileEditor = createFileEditorState();
	return state;
}
