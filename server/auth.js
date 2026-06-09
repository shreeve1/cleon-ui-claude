import express from "express";
import Database from "better-sqlite3";
import bcrypt from "bcrypt";
import jwt from "jsonwebtoken";
import path from "path";
import os from "os";
import fs from "fs";
import logger from "./logger.js";

const router = express.Router();

// Database in ~/.cleon-ui/
// Migrate from old directory if it exists
const oldDbDir = path.join(os.homedir(), ".claude-lite");
const dbDir = path.join(os.homedir(), ".cleon-ui");

if (!fs.existsSync(dbDir) && fs.existsSync(oldDbDir)) {
	logger.info("[Auth] Migrating from .claude-lite to .cleon-ui...");
	fs.renameSync(oldDbDir, dbDir);
	logger.info("[Auth] Migration complete");
} else if (!fs.existsSync(dbDir)) {
	fs.mkdirSync(dbDir, { recursive: true });
}

const db = new Database(path.join(dbDir, "auth.db"));

// Initialize schema
db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY,
    username TEXT UNIQUE NOT NULL,
    password_hash TEXT NOT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  )
`);

const JWT_SECRET = process.env.JWT_SECRET;
const JWT_EXPIRY = "7d";

// Enforce JWT_SECRET in production
if (!JWT_SECRET) {
	if (process.env.NODE_ENV === "production") {
		throw new Error(
			"JWT_SECRET environment variable must be set in production",
		);
	}
	logger.warn(
		"[Auth] WARNING: JWT_SECRET not set. Using insecure default for development only.",
	);
}

const EFFECTIVE_JWT_SECRET =
	JWT_SECRET || "cleon-ui-dev-secret-DO-NOT-USE-IN-PROD";

if (JWT_SECRET && JWT_SECRET.length < 32) {
	throw new Error("JWT_SECRET must be at least 32 characters for security");
}

function hasUser() {
	const result = db.prepare("SELECT COUNT(*) as count FROM users").get();
	return result.count > 0;
}

/**
 * GET /api/auth/status
 * Check if initial setup is needed
 */
router.get("/status", (req, res) => {
	res.json({ needsSetup: !hasUser() });
});

/**
 * POST /api/auth/register
 * Create account - only allowed once (first user)
 */
router.post("/register", async (req, res) => {
	try {
		if (hasUser()) {
			return res.status(403).json({
				error: "Registration disabled. Account already exists.",
			});
		}

		const { username, password } = req.body;

		if (!username || !password) {
			return res.status(400).json({ error: "Username and password required" });
		}

		if (username.length < 3) {
			return res
				.status(400)
				.json({ error: "Username must be at least 3 characters" });
		}

		if (password.length < 6) {
			return res
				.status(400)
				.json({ error: "Password must be at least 6 characters" });
		}

		const hash = await bcrypt.hash(password, 10);

		db.prepare("INSERT INTO users (username, password_hash) VALUES (?, ?)").run(
			username,
			hash,
		);

		logger.info(`[Cleon Auth] Account created: ${username}`);
		res.json({ success: true, message: "Account created. Please log in." });
	} catch (err) {
		logger.error("[Auth] Registration error:", err);
		res.status(500).json({ error: "Registration failed" });
	}
});

/**
 * POST /api/auth/login
 * Authenticate and return JWT
 */
router.post("/login", async (req, res) => {
	try {
		const { username, password } = req.body;

		if (!username || !password) {
			return res.status(400).json({ error: "Username and password required" });
		}

		const user = db
			.prepare("SELECT * FROM users WHERE username = ?")
			.get(username);

		if (!user) {
			return res.status(401).json({ error: "Invalid credentials" });
		}

		const valid = await bcrypt.compare(password, user.password_hash);

		if (!valid) {
			return res.status(401).json({ error: "Invalid credentials" });
		}

		const token = jwt.sign(
			{ id: user.id, username: user.username },
			EFFECTIVE_JWT_SECRET,
			{ expiresIn: JWT_EXPIRY },
		);

		logger.info(`[Cleon Auth] Login successful: ${username}`);
		res.json({ token, username: user.username });
	} catch (err) {
		logger.error("[Auth] Login error:", err);
		res.status(500).json({ error: "Login failed" });
	}
});

/**
 * Middleware: Verify JWT token for protected routes
 */
export function authenticateToken(req, res, next) {
	const authHeader = req.headers.authorization;
	const token = authHeader?.split(" ")[1];

	if (!token) {
		return res.status(401).json({ error: "Authentication required" });
	}

	try {
		const user = jwt.verify(token, EFFECTIVE_JWT_SECRET);
		req.user = user;
		next();
	} catch (err) {
		return res.status(403).json({ error: "Invalid or expired token" });
	}
}

/**
 * Verify JWT for WebSocket connections
 * Returns user object or null
 */
export function authenticateWebSocket(token) {
	if (!token) return null;

	try {
		return jwt.verify(token, EFFECTIVE_JWT_SECRET);
	} catch {
		return null;
	}
}

export { router as authRoutes };
