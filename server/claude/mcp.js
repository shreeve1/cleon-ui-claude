import { promises as fs } from "fs";
import path from "path";
import os from "os";

/**
 * Load MCP server config from ~/.claude.json
 */
export async function loadMcpConfig(projectPath) {
	try {
		const configPath = path.join(os.homedir(), ".claude.json");
		const content = await fs.readFile(configPath, "utf8");
		const config = JSON.parse(content);

		let mcpServers = {};

		// Global MCP servers
		if (config.mcpServers) {
			mcpServers = { ...config.mcpServers };
		}

		// Project-specific MCP servers
		if (config.claudeProjects && projectPath) {
			const projectConfig = config.claudeProjects[projectPath];
			if (projectConfig?.mcpServers) {
				mcpServers = { ...mcpServers, ...projectConfig.mcpServers };
			}
		}

		return Object.keys(mcpServers).length > 0 ? mcpServers : null;
	} catch {
		return null;
	}
}
