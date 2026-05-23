const fs = require('fs');
const path = require('path');

// Load settings from ~/.claude/settings.json
function loadClaudeSettings() {
  const settingsPath = path.join(process.env.HOME || process.env.USERPROFILE, '.claude', 'settings.json');

  if (!fs.existsSync(settingsPath)) {
    console.warn(`[PM2] Settings file not found: ${settingsPath}`);
    return {};
  }

  try {
    const content = fs.readFileSync(settingsPath, 'utf8');
    const settings = JSON.parse(content);

    // Extract Anthropic settings from env section
    // NOTE: ANTHROPIC_AUTH_TOKEN is intentionally EXCLUDED from this list.
    // When absent, the Claude SDK will use OAuth from ~/.anthropic/auth.json,
    // matching the system Claude Code authentication method.
    // Only inject ANTHROPIC_AUTH_TOKEN here if you explicitly want API key auth.
    const envSettings = {};
    if (settings.env) {
      // REMOVED: ANTHROPIC_AUTH_TOKEN (use OAuth by default)
      if (settings.env.ANTHROPIC_BASE_URL) {
        envSettings.ANTHROPIC_BASE_URL = settings.env.ANTHROPIC_BASE_URL;
      }
      if (settings.env.ANTHROPIC_DEFAULT_HAIKU_MODEL) {
        envSettings.ANTHROPIC_DEFAULT_HAIKU_MODEL = settings.env.ANTHROPIC_DEFAULT_HAIKU_MODEL;
      }
      if (settings.env.ANTHROPIC_DEFAULT_SONNET_MODEL) {
        envSettings.ANTHROPIC_DEFAULT_SONNET_MODEL = settings.env.ANTHROPIC_DEFAULT_SONNET_MODEL;
      }
      if (settings.env.ANTHROPIC_DEFAULT_OPUS_MODEL) {
        envSettings.ANTHROPIC_DEFAULT_OPUS_MODEL = settings.env.ANTHROPIC_DEFAULT_OPUS_MODEL;
      }
    }

    console.log('[PM2] Loaded settings from ~/.claude/settings.json');
    console.log('[PM2] Auth: OAuth (via ~/.anthropic/auth.json)');
    console.log('[PM2] API URL:', envSettings.ANTHROPIC_BASE_URL || 'default');
    console.log('[PM2] Haiku Model:', envSettings.ANTHROPIC_DEFAULT_HAIKU_MODEL || 'default');

    return envSettings;
  } catch (err) {
    console.error(`[PM2] Failed to load settings from ${settingsPath}:`, err.message);
    return {};
  }
}

// Load settings dynamically (fresh on every start/reload)
const claudeSettings = loadClaudeSettings();

module.exports = {
  apps: [
    {
      name: 'cleon-ui',
      script: 'server/index.js',
      instances: 1,
      exec_mode: 'fork',
      autorestart: true,
      watch: false,
      max_memory_restart: '500M',
      env: {
        NODE_ENV: 'production',
        PORT: 3010,
        HOST: '0.0.0.0',
        ...claudeSettings // Load Anthropic settings dynamically
      },
      env_development: {
        NODE_ENV: 'development',
        ...claudeSettings
      }
    }
  ]
};
