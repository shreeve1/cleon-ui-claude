export function escapeHtml(str) {
	if (typeof str !== "string") return String(str);
	return str
		.replace(/&/g, "&amp;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;")
		.replace(/"/g, "&quot;")
		.replace(/'/g, "&#39;");
}

export function escapeAttr(str) {
	return escapeHtml(str).replace(/\n/g, "&#10;");
}

export function formatDate(isoString) {
	const d = new Date(isoString);
	const now = new Date();
	const diffMs = now - d;
	const diffMins = Math.floor(diffMs / 60000);
	const diffHours = Math.floor(diffMs / 3600000);
	const diffDays = Math.floor(diffMs / 86400000);

	if (diffMins < 1) return "Just now";
	if (diffMins < 60) return `${diffMins}m ago`;
	if (diffHours < 24) return `${diffHours}h ago`;
	if (diffDays < 7) return `${diffDays}d ago`;

	return d.toLocaleDateString();
}

/**
 * Format timestamp to human-readable time
 * @param {string} isoString - ISO 8601 timestamp
 * @returns {string} Formatted time like "2:34 PM" or empty string if invalid
 */
export function formatTimestamp(isoString) {
	if (!isoString) return "";
	const date = new Date(isoString);
	if (isNaN(date.getTime())) return "";
	return date.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
}

/**
 * Format duration in milliseconds to human-readable string
 * @param {number} durationMs - Duration in milliseconds
 * @returns {string} Formatted duration like "1.2s" or "234ms"
 */
export function formatDuration(durationMs) {
	if (durationMs === null || durationMs === undefined) return "";
	const ms = Number(durationMs);
	if (isNaN(ms)) return "";
	if (ms < 1000) return `${ms}ms`;
	return `${(ms / 1000).toFixed(1)}s`;
}

/**
 * Get short UUID (last 8 characters)
 * @param {string} uuid - Full UUID
 * @returns {string} Short UUID
 */
export function getShortId(uuid) {
	if (!uuid) return "";
	return uuid.slice(-8);
}

/**
 * Copy text to clipboard with optional feedback
 * @param {string} text - Text to copy
 * @param {HTMLElement} feedbackEl - Optional element for visual feedback
 */
export function copyToClipboard(text, feedbackEl = null) {
	if (!text) return;
	navigator.clipboard
		.writeText(text)
		.then(() => {
			if (feedbackEl) {
				const originalText = feedbackEl.textContent;
				feedbackEl.textContent = "Copied!";
				setTimeout(() => {
					feedbackEl.textContent = originalText;
				}, 1500);
			}
		})
		.catch((err) => {
			console.warn("Failed to copy:", err);
		});
}

// Truncate text for preview
export function truncateText(text, maxLength) {
	if (!text) return "";
	if (text.length <= maxLength) return text;
	return text.slice(0, maxLength) + "...";
}

// Convert file to base64 data URL
export function fileToBase64(file) {
	return new Promise((resolve, reject) => {
		const reader = new FileReader();
		reader.onload = () => resolve(reader.result);
		reader.onerror = reject;
		reader.readAsDataURL(file);
	});
}

export function createClientId() {
	const cryptoApi = globalThis.crypto;
	if (cryptoApi?.randomUUID) return cryptoApi.randomUUID();

	if (cryptoApi?.getRandomValues) {
		const bytes = cryptoApi.getRandomValues(new Uint8Array(16));
		bytes[6] = (bytes[6] & 0x0f) | 0x40;
		bytes[8] = (bytes[8] & 0x3f) | 0x80;
		const hex = Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0"));
		return `${hex.slice(0, 4).join("")}-${hex.slice(4, 6).join("")}-${hex.slice(6, 8).join("")}-${hex.slice(8, 10).join("")}-${hex.slice(10).join("")}`;
	}

	return `session-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

export function getToolIcon(tool) {
	const icons = {
		Bash: "$",
		Read: "R",
		Write: "W",
		Edit: "E",
		Glob: "G",
		Grep: "?",
		Task: "T",
		TodoWrite: "✓",
		Todowrite: "✓",
	};
	return icons[tool] || "*";
}

export function getCompactSummary(tool, input) {
	if (!input || Object.keys(input).length === 0) return "";

	const normalizedTool = tool.toLowerCase();

	switch (normalizedTool) {
		case "bash":
			if (input.command) {
				const cmd =
					input.command.length > 60
						? input.command.slice(0, 57) + "..."
						: input.command;
				return `$ ${cmd}`;
			}
			return "";

		case "read":
			if (input.file_path) {
				const parts = input.file_path.split("/");
				return parts[parts.length - 1];
			}
			return "";

		case "write":
			if (input.file_path) {
				const parts = input.file_path.split("/");
				return parts[parts.length - 1];
			}
			return "";

		case "edit":
			if (input.file_path) {
				const parts = input.file_path.split("/");
				return parts[parts.length - 1];
			}
			return "";

		case "grep":
			if (input.pattern) {
				const pat =
					input.pattern.length > 40
						? input.pattern.slice(0, 37) + "..."
						: input.pattern;
				return pat;
			}
			return "";

		case "glob":
			if (input.pattern) {
				return input.pattern;
			}
			return "";

		case "task":
			if (input.description) {
				const desc =
					input.description.length > 50
						? input.description.slice(0, 47) + "..."
						: input.description;
				return desc;
			}
			return "";

		default:
			return "";
	}
}
