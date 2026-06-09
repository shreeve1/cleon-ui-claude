import express from "express";
import fs from "fs/promises";
import path from "path";
import { glob } from "glob";
import logger from "./logger.js";
import {
	CLAUDE_PROJECTS,
	extractProjectPathForFiles,
} from "./shared/project-paths.js";

const router = express.Router();

const MAX_TREE_FILES = 500; // Back to reasonable limit - will use lazy loading instead

const MAX_FILE_SIZE = 10 * 1024 * 1024; // 10MB

// Editable file extensions (text-based files only)
const EDITABLE_EXTENSIONS = new Set([
	".txt",
	".md",
	".markdown",
	".json",
	".yaml",
	".yml",
	".html",
	".htm",
	".css",
	".scss",
	".sass",
	".less",
	".js",
	".jsx",
	".ts",
	".tsx",
	".mjs",
	".cjs",
	".py",
	".rb",
	".php",
	".java",
	".c",
	".cpp",
	".h",
	".hpp",
	".go",
	".rs",
	".swift",
	".kt",
	".kts",
	".sh",
	".bash",
	".zsh",
	".fish",
	".sql",
	".graphql",
	".gql",
	".xml",
	".svg",
	".toml",
	".ini",
	".cfg",
	".conf",
	".config",
	".env",
	".gitignore",
	".dockerignore",
	".editorconfig",
	".vue",
	".svelte",
	".astro",
	".sol",
	".vy",
	".lua",
	".r",
	".jl",
	".dockerfile",
	"dockerfile",
	"makefile",
	"rakefile",
	"gemfile",
	".proto",
	".thrift",
	".graphqls",
]);

// Binary file extensions to reject
const BINARY_EXTENSIONS = new Set([
	".png",
	".jpg",
	".jpeg",
	".gif",
	".bmp",
	".ico",
	".webp",
	".tiff",
	".tif",
	".mp3",
	".mp4",
	".wav",
	".avi",
	".mov",
	".wmv",
	".flv",
	".mkv",
	".webm",
	".pdf",
	".doc",
	".docx",
	".xls",
	".xlsx",
	".ppt",
	".pptx",
	".zip",
	".tar",
	".gz",
	".rar",
	".7z",
	".bz2",
	".exe",
	".dll",
	".so",
	".dylib",
	".app",
	".dmg",
	".woff",
	".woff2",
	".ttf",
	".otf",
	".eot",
	".sqlite",
	".db",
]);

/**
 * Security: Validate file path stays within project directory
 * IMPORTANT: Call this immediately before each file operation
 */
async function validateFilePath(actualProjectPath, userPath) {
	const resolvedProject = path.resolve(actualProjectPath);
	const resolvedPath = path.resolve(actualProjectPath, userPath);

	// Check for path traversal
	const relativePath = path.relative(resolvedProject, resolvedPath);
	if (relativePath.startsWith("..") || path.isAbsolute(relativePath)) {
		throw new Error("Path traversal attempt detected");
	}

	// Resolve symlinks (async to avoid blocking)
	const realPath = await fs.realpath(resolvedPath);
	const realProject = await fs.realpath(resolvedProject);

	if (!realPath.startsWith(realProject)) {
		throw new Error("Access denied: symlink points outside project");
	}

	return realPath;
}

/**
 * Check if a file is editable based on extension
 */
function isEditableFile(filePath) {
	const ext = path.extname(filePath).toLowerCase();
	const basename = path.basename(filePath).toLowerCase();

	// Check for files without extensions (like Makefile, Dockerfile)
	if (EDITABLE_EXTENSIONS.has(basename)) return true;

	return EDITABLE_EXTENSIONS.has(ext);
}

/**
 * Check if a file is binary
 */
function isBinaryFile(filePath) {
	const ext = path.extname(filePath).toLowerCase();
	return BINARY_EXTENSIONS.has(ext);
}

/**
 * Get language for Prism.js highlighting based on file extension
 */
function getLanguageFromPath(filePath) {
	const ext = path.extname(filePath).toLowerCase();
	const basename = path.basename(filePath).toLowerCase();

	const langMap = {
		".js": "javascript",
		".jsx": "javascript",
		".mjs": "javascript",
		".cjs": "javascript",
		".ts": "typescript",
		".tsx": "typescript",
		".py": "python",
		".rb": "ruby",
		".java": "java",
		".c": "c",
		".cpp": "cpp",
		".h": "c",
		".hpp": "cpp",
		".go": "go",
		".rs": "rust",
		".swift": "swift",
		".kt": "kotlin",
		".kts": "kotlin",
		".sh": "bash",
		".bash": "bash",
		".zsh": "bash",
		".json": "json",
		".html": "html",
		".htm": "html",
		".css": "css",
		".scss": "css",
		".sass": "css",
		".less": "css",
		".md": "markdown",
		".markdown": "markdown",
		".yaml": "yaml",
		".yml": "yaml",
		".sql": "sql",
		".xml": "markup",
		".svg": "markup",
		".vue": "javascript",
		".svelte": "javascript",
		".astro": "javascript",
		".graphql": "graphql",
		".gql": "graphql",
		".lua": "lua",
		".r": "r",
		".jl": "julia",
		".sol": "solidity",
		".vy": "python",
		".proto": "protobuf",
	};

	if (langMap[ext]) return langMap[ext];
	if (basename === "dockerfile") return "docker";
	if (basename === "makefile") return "makefile";

	return "plaintext";
}

/**
 * Build hierarchical tree structure from flat file list
 */
function buildFileTree(files) {
	const tree = {};

	for (const file of files) {
		const parts = file.split("/");
		let current = tree;

		for (let i = 0; i < parts.length; i++) {
			const part = parts[i];
			if (!part) continue;

			const isLast = i === parts.length - 1;
			// A part is a directory if it's not the last part, or if the original path ends with /
			const isDirectory = !isLast;

			if (!current[part]) {
				current[part] = isDirectory ? { __isDir: true } : { __isFile: true };
			} else if (isDirectory && current[part].__isFile) {
				// Entry exists as a file, but we're treating it as a directory now
				// This happens when a directory contains both files and subdirectories
				current[part] = { __isDir: true };
			}

			if (!isLast) {
				current = current[part];
			}
		}
	}

	return tree;
}

/**
 * Get file tree structure for a project
 */
router.get("/:project/tree", async (req, res) => {
	const { project } = req.params;

	try {
		// Get the actual project path (resolve from session files like projects.js does)
		const projectDir = path.join(CLAUDE_PROJECTS, project);
		const actualPath = await extractProjectPathForFiles(projectDir, project);

		// Verify project exists
		try {
			await fs.access(actualPath);
		} catch {
			return res.status(404).json({ error: "Project not found" });
		}

		// Build file list with glob (include hidden files)
		const files = await glob("**/*", {
			cwd: actualPath,
			absolute: false,
			nodir: false,
			dot: true, // Include hidden files
			ignore: [
				"**/node_modules/**",
				"**/.git/**",
				"**/.DS_Store",
				"**/dist/**",
				"**/build/**",
				"**/.next/**",
				"**/coverage/**",
				"**/__pycache__/**",
				"**/.pytest_cache/**",
				"**/vendor/**",
				"**/.venv/**",
				"**/venv/**",
				"**/*.min.js",
				"**/*.min.css",
				"**/.env.local",
				"**/.env.*.local",
				// System directories to skip
				"**/Library/**",
				"**/Applications/**",
				"**/Desktop/**",
				"**/Documents/**",
				"**/Downloads/**",
				"**/Movies/**",
				"**/Music/**",
				"**/Pictures/**",
				"**/.Trash/**",
				"**/.localized/**",
				"**/System/**",
				"**/bin/**",
				"**/etc/**",
				"**/usr/**",
				"**/tmp/**",
				"**/var/**",
			],
		});

		// Limit file count
		if (files.length > MAX_TREE_FILES) {
			logger.warn("File tree truncated", {
				project,
				count: files.length,
				max: MAX_TREE_FILES,
			});
			files.length = MAX_TREE_FILES;
		}

		const tree = buildFileTree(files);

		logger.info("File tree generated", { project, fileCount: files.length });
		res.json({ tree, projectPath: project });
	} catch (err) {
		logger.error("Error generating file tree", { error: err.message, project });
		res.status(500).json({ error: err.message });
	}
});

/**
 * List directory contents (for lazy loading)
 */
router.get("/:project/ls", async (req, res) => {
	const { project } = req.params;
	const dirPath = req.query.path || "";

	try {
		// Get the actual project path
		const projectDir = path.join(CLAUDE_PROJECTS, project);
		const actualPath = await extractProjectPathForFiles(projectDir, project);
		const targetPath = dirPath ? path.join(actualPath, dirPath) : actualPath;

		// Verify path exists
		try {
			const stats = await fs.stat(targetPath);
			if (!stats.isDirectory()) {
				return res.status(400).json({ error: "Not a directory" });
			}
		} catch (err) {
			return res.status(404).json({ error: "Directory not found" });
		}

		// List directory contents using glob to include hidden files
		// Use targetPath as cwd for subdirectories to ensure proper relative paths
		const pattern = "{*,.*}";
		const files = await glob(pattern, {
			cwd: targetPath,
			absolute: false,
			nodir: false,
			dot: true, // Include hidden files
			ignore: [
				"**/node_modules/**",
				"**/.git/**",
				"**/.DS_Store",
				"**/dist/**",
				"**/build/**",
				"**/.next/**",
				"**/coverage/**",
				"**/__pycache__/**",
				"**/.pytest_cache/**",
				"**/vendor/**",
				"**/.venv/**",
				"**/venv/**",
				"**/.env.local",
				"**/.env.*.local",
				// System directories to skip
				"**/Library/**",
				"**/Applications/**",
				"**/Desktop/**",
				"**/Documents/**",
				"**/Downloads/**",
				"**/Movies/**",
				"**/Music/**",
				"**/Pictures/**",
				"**/.Trash/**",
				"**/.localized/**",
				"**/System/**",
				"**/bin/**",
				"**/etc/**",
				"**/usr/**",
				"**/tmp/**",
				"**/var/**",
			],
		});

		const ignorePatterns = [".env.local", ".env.*.local"];

		// Get file stats to determine directories
		const items = [];
		for (const name of files) {
			// Skip remaining ignored patterns
			if (ignorePatterns.some((p) => name.includes(p))) continue;

			const filePath = path.join(targetPath, name);
			const isDir = (await fs.stat(filePath)).isDirectory();

			items.push({
				name,
				path: dirPath ? `${dirPath}/${name}` : name,
				isDirectory: isDir,
			});
		}

		// Sort: directories first, then alphabetically
		items.sort((a, b) => {
			if (a.isDirectory !== b.isDirectory) {
				return a.isDirectory ? -1 : 1;
			}
			return a.name.localeCompare(b.name, undefined, { sensitivity: "base" });
		});

		logger.info("Directory listed", {
			project,
			path: dirPath || "/",
			count: items.length,
		});
		res.json({ items, path: dirPath || "/" });
	} catch (err) {
		logger.error("Error listing directory", {
			error: err.message,
			project,
			path: dirPath,
		});
		res.status(500).json({ error: err.message });
	}
});

/**
 * Get file content
 */
router.get("/:project/*", async (req, res) => {
	const { project } = req.params;
	// Handle wildcard - req.params[0] contains everything after :project/
	const relativePath = req.params[0];

	if (!relativePath) {
		return res.status(400).json({ error: "File path is required" });
	}

	try {
		// Get the actual project path (resolve from session files like projects.js does)
		const projectDir = path.join(CLAUDE_PROJECTS, project);
		const actualPath = await extractProjectPathForFiles(projectDir, project);

		const safePath = await validateFilePath(actualPath, relativePath);

		// Check if file exists and get stats
		let stats;
		try {
			stats = await fs.stat(safePath);
		} catch (err) {
			if (err.code === "ENOENT") {
				return res.status(404).json({ error: "File not found" });
			}
			throw err;
		}

		// Reject directories
		if (stats.isDirectory()) {
			return res.status(400).json({ error: "Cannot read directory" });
		}

		// Check file size
		if (stats.size > MAX_FILE_SIZE) {
			return res.status(413).json({
				error: "File too large",
				maxSize: MAX_FILE_SIZE,
				actualSize: stats.size,
			});
		}

		// Check for binary files
		if (isBinaryFile(relativePath)) {
			return res.status(400).json({
				error: "Binary file - cannot edit",
				isBinary: true,
			});
		}

		// Read file content
		const content = await fs.readFile(safePath, "utf8");

		// Determine if editable
		const editable = isEditableFile(relativePath);
		const language = getLanguageFromPath(relativePath);

		logger.info("File read", {
			project,
			path: relativePath,
			size: stats.size,
			editable,
		});

		res.json({
			path: relativePath,
			content,
			size: stats.size,
			modified: stats.mtime,
			editable,
			language,
		});
	} catch (err) {
		if (
			err.message.includes("Path traversal") ||
			err.message.includes("symlink")
		) {
			logger.warn("Security: Invalid file access attempt", {
				project,
				path: relativePath,
				error: err.message,
			});
			return res.status(403).json({ error: "Access denied" });
		}

		logger.error("Error reading file", {
			error: err.message,
			project,
			path: relativePath,
		});
		res.status(500).json({ error: err.message });
	}
});

/**
 * Save file content
 */
router.put("/:project/*", async (req, res) => {
	const { project } = req.params;
	const relativePath = req.params[0];
	const { content } = req.body;

	if (!relativePath) {
		return res.status(400).json({ error: "File path is required" });
	}

	if (content === undefined) {
		return res.status(400).json({ error: "Content is required" });
	}

	// Size limit: 10MB
	if (content.length > MAX_FILE_SIZE) {
		return res.status(413).json({
			error: "File too large",
			maxSize: MAX_FILE_SIZE,
		});
	}

	try {
		// Get the actual project path (resolve from session files like projects.js does)
		const projectDir = path.join(CLAUDE_PROJECTS, project);
		const actualPath = await extractProjectPathForFiles(projectDir, project);

		const safePath = await validateFilePath(actualPath, relativePath);

		// Check if file is editable
		if (!isEditableFile(relativePath)) {
			return res.status(400).json({ error: "File type is not editable" });
		}

		// Check if file exists (for update vs create)
		let exists = false;
		try {
			await fs.access(safePath);
			exists = true;
		} catch {
			// File doesn't exist, we'll create it
		}

		// Create parent directories if needed
		const parentDir = path.dirname(safePath);
		await fs.mkdir(parentDir, { recursive: true });

		// Write file
		await fs.writeFile(safePath, content, "utf8");

		logger.info("File saved", {
			project,
			path: relativePath,
			size: content.length,
			created: !exists,
		});

		res.json({
			message: exists ? "File saved" : "File created",
			path: relativePath,
			size: content.length,
		});
	} catch (err) {
		if (
			err.message.includes("Path traversal") ||
			err.message.includes("symlink")
		) {
			logger.warn("Security: Invalid file write attempt", {
				project,
				path: relativePath,
				error: err.message,
			});
			return res.status(403).json({ error: "Access denied" });
		}

		logger.error("Error saving file", {
			error: err.message,
			project,
			path: relativePath,
		});
		res.status(500).json({ error: err.message });
	}
});

export { router as fileRoutes };
