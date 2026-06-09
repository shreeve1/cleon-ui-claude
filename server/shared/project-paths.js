import path from "path";
import os from "os";
import { promises as fs } from "fs";

export const CLAUDE_PROJECTS = path.join(os.homedir(), ".claude", "projects");

/**
 * Extract actual project path from session files (cwd field).
 * Falls back to decoding the directory name via dash-decoding.
 * Used by projects.js (original behavior).
 */
export async function extractProjectPath(projectDir, projectName) {
	try {
		const files = await fs.readdir(projectDir);
		const jsonlFiles = files.filter(
			(f) => f.endsWith(".jsonl") && !f.startsWith("agent-"),
		);

		// Try each session file until we find one with a cwd field
		for (const jsonlFile of jsonlFiles) {
			try {
				const content = await fs.readFile(
					path.join(projectDir, jsonlFile),
					"utf8",
				);
				const lines = content.split("\n").filter(Boolean);

				for (const line of lines.slice(0, 30)) {
					try {
						const entry = JSON.parse(line);
						if (entry.cwd) {
							return entry.cwd;
						}
					} catch {
						/* skip malformed */
					}
				}
			} catch {
				/* skip unreadable files */
			}
		}

		return decodeProjectName(projectName);
	} catch {
		return decodeProjectName(projectName);
	}
}

/**
 * Extract actual project path from session files (cwd field).
 * Falls back to decoding the directory name via decodeURIComponent.
 * Used by files.js (original behavior).
 */
export async function extractProjectPathForFiles(projectDir, projectName) {
	try {
		const files = await fs.readdir(projectDir);
		const jsonlFiles = files.filter(
			(f) => f.endsWith(".jsonl") && !f.startsWith("agent-"),
		);

		// Try each session file until we find one with a cwd field
		for (const sessionFile of jsonlFiles) {
			try {
				const content = await fs.readFile(
					path.join(projectDir, sessionFile),
					"utf8",
				);
				const lines = content.split("\n").filter(Boolean);

				for (const line of lines) {
					const entry = JSON.parse(line);
					if (entry.cwd) {
						return entry.cwd;
					}
				}
			} catch {}
		}

		// Fallback: decode the project name
		return decodeURIComponent(projectName);
	} catch {
		return decodeURIComponent(projectName);
	}
}

/**
 * Decode project name back to path using dash-decoding.
 * Note: This is lossy for paths with actual dashes.
 */
export function decodeProjectName(name) {
	// Handle absolute paths (start with -)
	if (name.startsWith("-")) {
		return "/" + name.slice(1).replace(/-/g, "/");
	}
	return name.replace(/-/g, "/");
}
