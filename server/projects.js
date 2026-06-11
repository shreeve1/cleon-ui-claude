import express from "express";
import { promises as fs } from "fs";
import path from "path";
import { glob } from "glob";
import logger from "./logger.js";
import {
	CLAUDE_PROJECTS,
	extractProjectPath,
	decodeProjectName,
} from "./shared/project-paths.js";
import { jsonlEntryToHistoryMessages } from "./shared/session-jsonl.js";

const router = express.Router();

// Constants
const MAX_PROJECTS = 30;
const MAX_SESSIONS = 30;
const MAX_FILE_RESULTS = 20;
const SESSION_PREVIEW_LENGTH = 120;

/**
 * GET /api/projects/search?q=/path/to/project
 * Search projects by path substring
 */
router.get("/search", async (req, res) => {
	const query = (req.query.q || "").toLowerCase().trim();

	try {
		let entries;
		try {
			entries = await fs.readdir(CLAUDE_PROJECTS, { withFileTypes: true });
		} catch (err) {
			if (err.code === "ENOENT") {
				return res.json([]); // No Claude projects yet
			}
			throw err;
		}

		const projects = [];

		for (const entry of entries) {
			if (!entry.isDirectory()) continue;

			// Extract actual project path from sessions or decode from name
			const projectDir = path.join(CLAUDE_PROJECTS, entry.name);
			const actualPath = await extractProjectPath(projectDir, entry.name);

			// Filter by search query
			if (query && !actualPath.toLowerCase().includes(query)) continue;

			// Count sessions
			const files = await fs.readdir(projectDir);
			const sessions = files.filter(
				(f) => f.endsWith(".jsonl") && !f.startsWith("agent-"),
			);

			projects.push({
				name: entry.name,
				path: actualPath,
				displayName: path.basename(actualPath),
				sessionCount: sessions.length,
			});
		}

		// Sort by path
		projects.sort((a, b) => a.path.localeCompare(b.path));

		res.json(projects.slice(0, MAX_PROJECTS));
	} catch (err) {
		logger.error("[Projects] Search error:", err);
		res.status(500).json({ error: "Failed to search projects" });
	}
});

/**
 * GET /api/projects/:name/sessions
 * List sessions for a project, sorted by most recent
 */
router.get("/:name/sessions", async (req, res) => {
	const projectDir = path.join(CLAUDE_PROJECTS, req.params.name);

	try {
		let files;
		try {
			files = await fs.readdir(projectDir);
		} catch (err) {
			if (err.code === "ENOENT") {
				return res.json([]);
			}
			throw err;
		}

		const jsonlFiles = files.filter(
			(f) => f.endsWith(".jsonl") && !f.startsWith("agent-"),
		);

		// Get file stats and previews
		const sessions = await Promise.all(
			jsonlFiles.map(async (file) => {
				const filePath = path.join(projectDir, file);
				const stats = await fs.stat(filePath);
				const preview = await getSessionPreview(filePath);

				// Extract session ID from filename
				const sessionId = path.basename(file, ".jsonl");

				return {
					id: sessionId,
					file,
					lastModified: stats.mtime.toISOString(),
					preview,
				};
			}),
		);

		// Sort by most recent first
		sessions.sort(
			(a, b) => new Date(b.lastModified) - new Date(a.lastModified),
		);

		res.json(sessions.slice(0, MAX_SESSIONS));
	} catch (err) {
		logger.error("[Projects] Sessions error:", err);
		res.status(500).json({ error: "Failed to load sessions" });
	}
});

/**
 * GET /api/projects/:name/sessions/:sessionId/messages
 * Get messages for a specific session
 */
router.get("/:name/sessions/:sessionId/messages", async (req, res) => {
	const { name, sessionId } = req.params;
	const limit = parseInt(req.query.limit) || 100;

	try {
		const messages = await getSessionMessages(name, sessionId, limit);
		res.json({ messages });
	} catch (err) {
		logger.error("[Projects] Messages error:", err);
		res.status(500).json({ error: "Failed to load messages" });
	}
});

/**
 * GET /api/projects/:name/path
 * Get the actual filesystem path for a project
 */
router.get("/:name/path", async (req, res) => {
	const projectDir = path.join(CLAUDE_PROJECTS, req.params.name);

	try {
		const actualPath = await extractProjectPath(projectDir, req.params.name);
		res.json({ path: actualPath });
	} catch (err) {
		// Fallback to decoded name
		res.json({ path: decodeProjectName(req.params.name) });
	}
});

/**
 * Extract actual project path from session files (cwd field)
 * Falls back to decoding the directory name
 */

/**
 * Extract first meaningful user message as session preview
 */
async function getSessionPreview(filePath) {
	try {
		const content = await fs.readFile(filePath, "utf8");
		const lines = content.split("\n").filter(Boolean);

		for (const line of lines.slice(0, 50)) {
			try {
				const entry = JSON.parse(line);

				// Look for user messages
				if (entry.type === "user" || entry.message?.role === "user") {
					let text = entry.message?.content || entry.content;

					// Handle array format
					if (Array.isArray(text)) {
						text = text.find((t) => t.type === "text")?.text || text[0]?.text;
					}

					// Skip system/internal messages
					if (
						typeof text === "string" &&
						text.length > 0 &&
						!text.startsWith("<") &&
						!text.startsWith("{") &&
						!text.includes("CRITICAL:")
					) {
						const preview = text.slice(0, SESSION_PREVIEW_LENGTH);
						return (
							preview + (text.length > SESSION_PREVIEW_LENGTH ? "..." : "")
						);
					}
				}
			} catch {
				/* skip malformed */
			}
		}

		return "New session";
	} catch {
		return "New session";
	}
}

async function getSessionMessages(projectName, sessionId, limit = 100) {
	const projectDir = path.join(CLAUDE_PROJECTS, projectName);
	const files = await fs.readdir(projectDir);
	const jsonlFiles = files.filter(
		(f) => f.endsWith(".jsonl") && !f.startsWith("agent-"),
	);

	const messages = [];

	for (const file of jsonlFiles) {
		const content = await fs.readFile(path.join(projectDir, file), "utf8");
		const lines = content.split("\n").filter(Boolean);

		for (const line of lines) {
			try {
				const entry = JSON.parse(line);
				if (entry.sessionId !== sessionId) continue;

				for (const msg of jsonlEntryToHistoryMessages(entry)) {
					messages.push(msg);
				}
			} catch {
				/* skip malformed */
			}
		}
	}

	messages.sort((a, b) => new Date(a.timestamp) - new Date(b.timestamp));
	return messages.slice(-limit);
}

/**
 * GET /api/projects/:name/files/search?q=query
 * Search files within a project using glob patterns
 */
router.get("/:name/files/search", async (req, res) => {
	const { name } = req.params;
	const query = (req.query.q || "").trim();

	try {
		// Get the actual project path
		const projectDir = path.join(CLAUDE_PROJECTS, name);
		const actualPath = await extractProjectPath(projectDir, name);

		// Check if project path exists and is absolute
		if (!actualPath || !path.isAbsolute(actualPath)) {
			return res.status(400).json({ error: "Invalid project path" });
		}

		// Resolve and normalize the path to prevent traversal attacks
		const resolvedPath = path.resolve(actualPath);

		// Verify the resolved path doesn't escape to sensitive directories
		const sensitivePatterns = [
			"/etc",
			"/var",
			"/usr",
			"/bin",
			"/sbin",
			"/root",
		];
		if (sensitivePatterns.some((p) => resolvedPath.startsWith(p))) {
			return res
				.status(403)
				.json({ error: "Access to this path is not allowed" });
		}

		// Check if directory exists
		try {
			const stats = await fs.stat(resolvedPath);
			if (!stats.isDirectory()) {
				return res
					.status(400)
					.json({ error: "Project path is not a directory" });
			}
		} catch (err) {
			return res.status(404).json({ error: "Project directory not found" });
		}

		// Sanitize query to prevent path traversal in search
		const sanitizedQuery = query.replace(/\.\./g, "").replace(/[<>:"|?*]/g, "");

		// Build glob pattern based on query
		let pattern;
		if (sanitizedQuery.includes("/") || sanitizedQuery.includes("\\")) {
			pattern = path.join(resolvedPath, "**", `*${sanitizedQuery}*`);
		} else if (sanitizedQuery) {
			pattern = path.join(resolvedPath, "**", `*${sanitizedQuery}*`);
		} else {
			pattern = path.join(resolvedPath, "**", "*");
		}

		// Execute glob search
		const files = await glob(pattern, {
			cwd: resolvedPath,
			absolute: false,
			nodir: true,
			ignore: [
				"**/node_modules/**",
				"**/.git/**",
				"**/dist/**",
				"**/build/**",
				"**/.claude/**",
				"**/coverage/**",
				"**/*.log",
				"**/.DS_Store",
			],
			limit: MAX_FILE_RESULTS,
		});

		// Verify each file path stays within the project directory
		const safeFiles = files.filter((file) => {
			const fullPath = path.resolve(resolvedPath, file);
			return fullPath.startsWith(resolvedPath);
		});

		// Sort by relevance (exact matches first, then alphabetical)
		const lowerQuery = sanitizedQuery.toLowerCase();
		safeFiles.sort((a, b) => {
			const aLower = a.toLowerCase();
			const bLower = b.toLowerCase();
			const aExact = aLower.includes(lowerQuery);
			const bExact = bLower.includes(lowerQuery);

			if (aExact && !bExact) return -1;
			if (!aExact && bExact) return 1;
			return a.localeCompare(b);
		});

		res.json({ files: safeFiles.slice(0, MAX_FILE_RESULTS) });
	} catch (err) {
		logger.error("[Projects] File search error:", err);
		res.status(500).json({ error: "Failed to search files" });
	}
});

export { router as projectRoutes };
