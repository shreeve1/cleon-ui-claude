import { spawn } from "child_process";
import { mkdtemp, rm } from "fs/promises";
import net from "net";
import os from "os";
import path from "path";
import { afterEach, describe, expect, it } from "vitest";

let serverProcess = null;
let tmpHome = null;

async function getFreePort() {
	return new Promise((resolve, reject) => {
		const server = net.createServer();
		server.on("error", reject);
		server.listen(0, "127.0.0.1", () => {
			const { port } = server.address();
			server.close(() => resolve(port));
		});
	});
}

async function startServer() {
	tmpHome = await mkdtemp(path.join(os.tmpdir(), "cleon-auth-test-"));
	const port = await getFreePort();
	const output = [];

	serverProcess = spawn(process.execPath, ["server/index.js"], {
		env: {
			...process.env,
			HOME: tmpHome,
			HOST: "127.0.0.1",
			JWT_SECRET: "abcdefghijklmnopqrstuvwxyz123456",
			NODE_ENV: "test",
			PORT: String(port),
		},
	});

	serverProcess.stdout.on("data", (chunk) => output.push(chunk.toString()));
	serverProcess.stderr.on("data", (chunk) => output.push(chunk.toString()));

	const baseUrl = `http://127.0.0.1:${port}`;
	const deadline = Date.now() + 5000;
	while (Date.now() < deadline) {
		try {
			const res = await fetch(`${baseUrl}/api/health`);
			if (res.ok) return baseUrl;
		} catch {
			// Wait for server listen.
		}
		await new Promise((resolve) => setTimeout(resolve, 100));
	}

	throw new Error(`Server did not start:\n${output.join("")}`);
}

async function postJson(baseUrl, route, body) {
	const res = await fetch(`${baseUrl}${route}`, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify(body),
	});
	return { status: res.status, data: await res.json() };
}

afterEach(async () => {
	if (serverProcess) {
		if (serverProcess.exitCode === null) {
			serverProcess.kill();
			await new Promise((resolve) => serverProcess.once("exit", resolve));
		}
		serverProcess = null;
	}
	if (tmpHome) {
		await rm(tmpHome, { recursive: true, force: true });
		tmpHome = null;
	}
});

describe("auth rate limiting", () => {
	it("does not let generic API traffic block the first valid login", async () => {
		const baseUrl = await startServer();

		const register = await postJson(baseUrl, "/api/auth/register", {
			username: "james",
			password: "correct-password",
		});
		expect(register.status).toBe(200);

		for (let i = 0; i < 120; i++) {
			const status = await fetch(`${baseUrl}/api/auth/status`);
			expect(status.status).toBe(200);
		}

		const login = await postJson(baseUrl, "/api/auth/login", {
			username: "james",
			password: "correct-password",
		});
		expect(login.status).toBe(200);
		expect(login.data.token).toBeTruthy();
	});

	it("still blocks repeated authentication attempts", async () => {
		const baseUrl = await startServer();

		for (let i = 0; i < 10; i++) {
			const login = await postJson(baseUrl, "/api/auth/login", {
				username: "missing",
				password: "wrong-password",
			});
			expect(login.status).toBe(401);
		}

		const blocked = await postJson(baseUrl, "/api/auth/login", {
			username: "missing",
			password: "wrong-password",
		});
		expect(blocked.status).toBe(429);
		expect(blocked.data.error).toContain("Too many authentication attempts");
	});
});
