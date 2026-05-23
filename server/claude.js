import { query } from '@anthropic-ai/claude-agent-sdk';
import { promises as fs } from 'fs';
import path from 'path';
import os from 'os';
import { randomUUID } from 'crypto';
import { taskManager, broadcastTaskUpdate } from './tasks.js';
import { broadcastToSession, startSessionBuffer } from './broadcast.js';
import { publish } from './bus.js';
import { createActivityTracker } from './activity.js';
import { register, setStatus } from './session-registry.js';
import { eventDelivery } from './event-delivery.js';

// Constants
const DEFAULT_CONTEXT_WINDOW = 200000;
const TOOL_OUTPUT_TRUNCATE_LENGTH = 1500;
const TOOL_SUMMARY_TRUNCATE_LENGTH = 200;

// Model-specific context window sizes
const MODEL_CONTEXT_WINDOWS = {
  'claude-3-opus-20240229': 200000,
  'claude-3-sonnet-20240229': 200000,
  'claude-3-haiku-20240307': 200000,
  'claude-3-5-sonnet-20241022': 200000,
  'claude-3-5-sonnet-20240620': 200000,
  'claude-3-5-haiku-20241022': 200000,
  // Newer models - update as SDK adds them
  'default': 200000
};

function getClaudeSdkEnv() {
  const env = { ...process.env };
  delete env.ANTHROPIC_API_KEY;
  delete env.ANTHROPIC_AUTH_TOKEN;
  return env;
}

function formatConversationHistory(messages, maxChars = 100000) {
  if (!messages || messages.length === 0) return '';

  const lines = [];
  let totalChars = 0;

  const recentMessages = messages.slice(-50);

  for (const msg of recentMessages) {
    let line = '';
    const timestamp = msg.timestamp ? `[${new Date(msg.timestamp).toLocaleTimeString()}] ` : '';

    if (msg.role === 'user') {
      line = `${timestamp}USER: ${msg.content || ''}`;
    } else if (msg.role === 'assistant') {
      const content = msg.content || '';
      const truncated = content.length > 2000
        ? content.slice(0, 2000) + '...[truncated]'
        : content;
      line = `${timestamp}ASSISTANT: ${truncated}`;
    } else if (msg.role === 'tool') {
      line = `${timestamp}TOOL (${msg.tool}): ${msg.summary || 'executed'}`;
    }

    if (line) {
      totalChars += line.length;
      if (totalChars > maxChars) break;
      lines.push(line);
    }
  }

  if (lines.length === 0) return '';

  return `<conversation-history>
Previous conversation context (${lines.length} messages):

${lines.join('\n\n')}

</conversation-history>

`;
}

async function loadSessionHistory(projectPath, sessionId, limit = 50) {
  const CLAUDE_PROJECTS = path.join(os.homedir(), '.claude', 'projects');

  const projectName = '-' + projectPath.slice(1).replace(/\//g, '-');
  const projectDir = path.join(CLAUDE_PROJECTS, projectName);

  try {
    const files = await fs.readdir(projectDir);
    const jsonlFiles = files.filter(f =>
      f.endsWith('.jsonl') &&
      !f.startsWith('agent-') &&
      f.startsWith(sessionId)
    );

    if (jsonlFiles.length === 0) {
      console.log(`[Claude] No session file found for ${sessionId}`);
      return [];
    }

    const messages = [];
    const sessionFile = path.join(projectDir, jsonlFiles[0]);
    const content = await fs.readFile(sessionFile, 'utf8');
    const lines = content.split('\n').filter(Boolean);

    for (const line of lines) {
      try {
        const entry = JSON.parse(line);
        if (entry.sessionId !== sessionId) continue;

        const msg = parseHistoryEntry(entry);
        if (msg) messages.push(msg);
      } catch { }
    }

    messages.sort((a, b) => new Date(a.timestamp) - new Date(b.timestamp));
    return messages.slice(-limit);

  } catch (err) {
    console.error('[Claude] Failed to load session history:', err.message);
    return [];
  }
}

function parseHistoryEntry(entry) {
  const timestamp = entry.timestamp || new Date().toISOString();

  if (entry.type === 'user' || entry.message?.role === 'user') {
    let text = entry.message?.content;
    if (Array.isArray(text)) {
      text = text.filter(t => t.type === 'text').map(t => t.text).join('\n');
    }
    if (typeof text === 'string' && text.length > 0 &&
        !text.startsWith('<command-') &&
        !text.startsWith('{')) {
      return { role: 'user', content: text, timestamp };
    }
  }

  if (entry.type === 'assistant' || entry.message?.role === 'assistant') {
    const content = entry.message?.content;
    if (Array.isArray(content)) {
      const textParts = content.filter(c => c.type === 'text').map(c => c.text);
      if (textParts.length > 0) {
        return { role: 'assistant', content: textParts.join('\n'), timestamp };
      }
    }
    if (typeof content === 'string' && content.length > 0) {
      return { role: 'assistant', content, timestamp };
    }
  }

  return null;
}

// Track active sessions for abort capability
const activeSessions = new Map();

// Track pending question responses - map of toolUseId -> { resolve, reject }
// Used by canUseTool callback to wait for user responses to AskUserQuestion
const pendingQuestionCallbacks = new Map();

// Track pending plan confirmations - map of toolUseId -> { resolve, reject }
// Used by canUseTool callback to wait for user confirmation of ExitPlanMode
const pendingPlanConfirmations = new Map();

// Track tool execution start times - map of toolUseId -> startTime (Date)
const toolStartTimes = new Map();

// Track current model per session - map of sessionId -> model
const sessionModels = new Map();

// Track tool use to task mapping - map of toolUseId -> taskId
// Used to complete tasks when tool results arrive
const toolUseToTaskMap = new Map();

/**
 * Process messages from a query stream
 * Used both for initial query and after question responses
 * Captures model information and adds it to messages
 */
async function processQueryStream(queryInstance, ws, sessionInfo, onSessionId) {
  if (sessionInfo.activityTracker) {
    sessionInfo.activityTracker.startThinking();
  }

  for await (const message of queryInstance) {
    // Capture session ID from first message
    if (message.session_id && onSessionId) {
      onSessionId(message.session_id);
    }

    // Extract model from token usage for subsequent messages
    if (message.type === 'result' && message.modelUsage) {
      const usage = extractTokenUsage(message.modelUsage);
      if (usage && usage.model) {
        sessionModels.set(message.session_id, usage.model);
      }
      if (usage) {
        sendMessage(sessionInfo.ws, {
          type: 'token-usage',
          sessionId: message.session_id,
          ...usage
        }, sessionInfo.username);
      }
    }

    // Transform and forward message (pass current model, sessionId, ws, and username for task tracking)
    const currentModel = message.session_id ? sessionModels.get(message.session_id) : null;
    const transformed = transformMessage(message, currentModel, message.session_id, sessionInfo.ws, sessionInfo.username);
    if (transformed) {
      sendMessage(sessionInfo.ws, {
        type: 'claude-message',
        sessionId: message.session_id,
        data: transformed
      }, sessionInfo.username);
    }

    // Track activity based on message type
    if (sessionInfo.activityTracker && transformed) {
      if (transformed.type === 'tool_use') {
        const summaryText = typeof transformed.summary === 'object'
          ? transformed.summary.summary
          : (transformed.summary || transformed.tool);
        sessionInfo.activityTracker.startTool(transformed.tool, summaryText);
      } else if (transformed.type === 'tool_result') {
        sessionInfo.activityTracker.completeTool();
      }
    }
  }
}

/**
 * Handle incoming chat message from WebSocket
 */
export async function handleChat(msg, ws, username) {
  const { content, projectPath, sessionId, isNewSession, mode, attachments } = msg;
  const projectDisplayName = projectPath ? projectPath.split('/').pop() : '';

  const permissionModeMap = {
    'default': 'default',
    'plan': 'plan',
    'bypass': 'bypassPermissions'
  };
  const permissionMode = permissionModeMap[mode] || 'default';

  // Build prompt with attachments
  let prompt = content || '';
  let tempImagePaths = [];

  if (sessionId && !isNewSession) {
    try {
      console.log(`[Claude] Loading history for session ${sessionId}`);
      const history = await loadSessionHistory(projectPath, sessionId, 50);

      if (history.length > 0) {
        const historyBlock = formatConversationHistory(history);
        prompt = historyBlock + 'CONTINUING CONVERSATION - User asks: ' + prompt;
        console.log(`[Claude] Prepended ${history.length} history messages to prompt`);
      }
    } catch (err) {
      console.error('[Claude] Failed to load history:', err);
    }
  }

  if (attachments && attachments.length > 0) {
    const textAttachments = [];

    for (const att of attachments) {
      if (att.type === 'image') {
        // Save image to temp file in project directory so Claude can read it
        try {
          const base64Data = att.data.replace(/^data:image\/\w+;base64,/, '');
          const ext = att.mediaType?.split('/')[1] || 'png';
          // Save in project directory for better access
          const tempDir = path.join(projectPath, '.claude-uploads');
          await fs.mkdir(tempDir, { recursive: true });
          const tempPath = path.join(tempDir, `upload-${randomUUID()}.${ext}`);
          await fs.writeFile(tempPath, Buffer.from(base64Data, 'base64'));
          tempImagePaths.push(tempPath);

          // Add instruction to read the image - use relative path from project
          const relativePath = path.relative(projectPath, tempPath);
          textAttachments.push(`\n\n[User attached an image: ${att.name}. Please use the Read tool to view the image at: ${relativePath}]`);
        } catch (err) {
          console.error('[Claude] Failed to save temp image:', err);
          textAttachments.push(`\n\n[User tried to attach an image: ${att.name}, but it failed to process]`);
        }
      } else {
        // Add text-based attachments to context
        textAttachments.push(`\n\n--- ${att.name} ---\n${att.data}`);
      }
    }

    if (textAttachments.length > 0) {
      prompt += textAttachments.join('');
    }
  }


  // Create session info object (mutable WS reference for reconnection support)
  const sessionInfo = { queryInstance: null, ws, username, activityTracker: null };

  const options = {
    cwd: projectPath,
    model: msg.model || undefined,
    permissionMode,
    systemPrompt: { type: 'preset', preset: 'claude_code' },
    settingSources: ['project', 'user', 'local'],
    env: { ...getClaudeSdkEnv(), DEBUG_CLAUDE_AGENT_SDK: '1' },
    stderr: (data) => {
      console.log(`[Claude:stderr] ${data.trimEnd()}`);
    },
    // Custom permission callback to intercept AskUserQuestion
    canUseTool: async (toolName, input, { toolUseID, signal }) => {
      // Intercept AskUserQuestion to wait for user input
      if (toolName === 'AskUserQuestion') {
        console.log(`[Claude] AskUserQuestion intercepted - toolUseId: ${toolUseID}`);

        sendMessage(sessionInfo.ws, {
          type: 'claude-message',
          sessionId: currentSessionId,
          data: {
            type: 'question',
            id: toolUseID,
            questions: input.questions || []
          }
        }, username);

        // Wait for user response
        try {
          const answers = await new Promise((resolve, reject) => {
            pendingQuestionCallbacks.set(toolUseID, { resolve, reject });

            // Handle abort signal
            signal.addEventListener('abort', () => {
              pendingQuestionCallbacks.delete(toolUseID);
              reject(new Error('Question cancelled'));
            });
          });

          console.log(`[Claude] Question answered - toolUseId: ${toolUseID}`);

          // Return allow with the answers included in updatedInput
          return {
            behavior: 'allow',
            updatedInput: {
              ...input,
              answers: answers
            }
          };
        } catch (err) {
          console.log(`[Claude] Question cancelled or error: ${err.message}`);
          return {
            behavior: 'deny',
            message: 'User cancelled the question'
          };
        }
      }

      // Intercept ExitPlanMode to wait for user confirmation
      if (toolName === 'ExitPlanMode') {
        console.log(`[Claude] ExitPlanMode intercepted - toolUseId: ${toolUseID}`);

        sendMessage(sessionInfo.ws, {
          type: 'claude-message',
          sessionId: currentSessionId,
          data: {
            type: 'plan-confirmation',
            id: toolUseID
          }
        }, username);

        // Wait for user approval/rejection
        try {
          const response = await new Promise((resolve, reject) => {
            pendingPlanConfirmations.set(toolUseID, { resolve, reject });

            // Handle abort signal
            signal.addEventListener('abort', () => {
              pendingPlanConfirmations.delete(toolUseID);
              reject(new Error('Plan confirmation cancelled'));
            });
          });

          console.log(`[Claude] Plan confirmation response - toolUseId: ${toolUseID}, approved: ${response.approved}`);

          if (response.approved) {
            return {
              behavior: 'allow',
              updatedInput: input
            };
          } else {
            return {
              behavior: 'deny',
              message: response.feedback
                ? `User rejected the plan. Feedback: ${response.feedback}`
                : 'User rejected the plan. Please revise.'
            };
          }
        } catch (err) {
          console.log(`[Claude] Plan confirmation cancelled or error: ${err.message}`);
          return {
            behavior: 'deny',
            message: 'Plan confirmation cancelled'
          };
        }
      }

      // Allow all other tools
      return {
        behavior: 'allow',
        updatedInput: input
      };
    }
  };

  // Resume existing session (unless explicitly new)
  if (sessionId && !isNewSession) {
    options.resume = sessionId;
  }

  // Load MCP servers from ~/.claude.json
  const mcpServers = await loadMcpConfig(projectPath);
  if (mcpServers) {
    options.mcpServers = mcpServers;
  }

  let currentSessionId = sessionId;
  let queryInstance = null;

  try {
    console.log(`[Claude] Starting query - project: ${projectPath}, session: ${sessionId || 'NEW'}, resuming: ${!!(sessionId && !isNewSession)}`);
    if (tempImagePaths.length > 0) {
      console.log(`[Claude] Saved ${tempImagePaths.length} image(s) to temp files:`);
      tempImagePaths.forEach(p => console.log(`  - ${p}`));
    }
    console.log(`[Claude] Prompt length: ${prompt.length} chars`);

    queryInstance = query({
      prompt,
      options
    });

    const isResuming = sessionId && !isNewSession;
    if (isResuming) {
      await queryInstance.setPermissionMode(permissionMode);
    }

    // Assign queryInstance to sessionInfo
    sessionInfo.queryInstance = queryInstance;

    // Track for abort
    if (currentSessionId) {
      activeSessions.set(currentSessionId, sessionInfo);
      startSessionBuffer(currentSessionId);
      register(currentSessionId, { username, projectPath, projectName: projectDisplayName, displayName: projectDisplayName, status: 'streaming' });
      publish(username, { type: 'session-status', sessionId: currentSessionId, status: 'streaming' });
      sessionInfo.activityTracker = createActivityTracker((event) => eventDelivery.deliver(username, event), currentSessionId);
    }

    // Process streaming messages
    await processQueryStream(queryInstance, ws, sessionInfo, (sid) => {
      if (!currentSessionId) {
        currentSessionId = sid;
        startSessionBuffer(currentSessionId);
        activeSessions.set(currentSessionId, sessionInfo);
        register(currentSessionId, { username, projectPath, projectName: projectDisplayName, displayName: projectDisplayName, status: 'streaming' });
        sendMessage(sessionInfo.ws, {
          type: 'session-created',
          sessionId: currentSessionId
        }, username);
        publish(username, { type: 'session-status', sessionId: currentSessionId, status: 'streaming' });
        sessionInfo.activityTracker = createActivityTracker((event) => eventDelivery.deliver(username, event), currentSessionId);
      }
    });

    // Stream complete
    console.log(`[Claude] Query complete - session: ${currentSessionId}`);
    sendMessage(sessionInfo.ws, {
      type: 'claude-done',
      sessionId: currentSessionId
    }, username);

  } catch (err) {
    console.error('[Claude] Query error:', err);

    // Detect rate limit errors from Anthropic API
    const errMsg = err.message || '';
    const isRateLimit = errMsg.includes('429') ||
                        errMsg.includes('rate limit') ||
                        errMsg.includes('Rate limit') ||
                        errMsg.includes('1302');

    const userMessage = isRateLimit
      ? 'Rate limit reached. The API is temporarily throttled — please wait a moment and try again.'
      : errMsg || 'Query failed';

    sendMessage(sessionInfo.ws, {
      type: 'error',
      sessionId: currentSessionId || msg.sessionId || null,
      message: userMessage
    }, username);
  } finally {
    if (sessionInfo.activityTracker) {
      sessionInfo.activityTracker.finish();
      sessionInfo.activityTracker = null;
    }

    if (currentSessionId) {
      activeSessions.delete(currentSessionId);
      setStatus(currentSessionId, 'idle');
      publish(username, { type: 'session-status', sessionId: currentSessionId, status: 'idle' });
      taskManager.clearSession(currentSessionId);
      // Clean up tool use to task mappings for this session
      for (const [toolUseId, taskId] of toolUseToTaskMap) {
        const task = taskManager.getTask(currentSessionId, taskId);
        if (task) {
          toolUseToTaskMap.delete(toolUseId);
        }
      }

      // Clean up any pending plan confirmations for this session
      for (const [toolUseId, callback] of pendingPlanConfirmations) {
        callback.reject(new Error('Session ended'));
        pendingPlanConfirmations.delete(toolUseId);
      }
    }

    // Clean up temp image files
    for (const tempPath of tempImagePaths) {
      try {
        await fs.unlink(tempPath);
      } catch {
        // Ignore cleanup errors
      }
    }
  }
}

/**
 * Abort an active session
 */
export async function handleAbort(sessionId) {
  const sessionInfo = activeSessions.get(sessionId);

  if (!sessionInfo) {
    console.log(`[Claude] Abort: session ${sessionId} not found`);
    return false;
  }

  try {
    console.log(`[Claude] Aborting session: ${sessionId}`);

    if (typeof sessionInfo.queryInstance.interrupt === 'function') {
      await sessionInfo.queryInstance.interrupt();
    }

    if (sessionInfo.activityTracker) {
      sessionInfo.activityTracker.finish();
      sessionInfo.activityTracker = null;
    }

    activeSessions.delete(sessionId);
    taskManager.clearSession(sessionId);
    // Clean up tool use to task mappings for this session
    for (const [toolUseId, taskId] of toolUseToTaskMap) {
      const task = taskManager.getTask(sessionId, taskId);
      if (task) {
        toolUseToTaskMap.delete(toolUseId);
      }
    }
    return true;

  } catch (err) {
    console.error(`[Claude] Abort error for ${sessionId}:`, err);
    activeSessions.delete(sessionId);
    return false;
  }
}

/**
 * Check if session is active
 */
export function isSessionActive(sessionId) {
  return activeSessions.has(sessionId);
}

/**
 * Resubscribe to an active session with a new WebSocket
 * Returns true if session found and updated, false otherwise
 */
export function resubscribeSession(sessionId, newWs) {
  const sessionInfo = activeSessions.get(sessionId);
  if (!sessionInfo) return false;
  sessionInfo.ws = newWs;

  return true;
}

/**
 * Handle question response from frontend
 * Resolves the pending promise from the canUseTool callback
 */
export async function handleQuestionResponse(sessionId, toolUseId, answers) {
  console.log(`[Claude] Received question response for tool ${toolUseId}`);
  console.log(`[Claude] Answer payload:`, JSON.stringify(answers, null, 2));

  // Find and resolve the pending callback
  const callback = pendingQuestionCallbacks.get(toolUseId);
  if (!callback) {
    console.log(`[Claude] No pending callback found for toolUseId: ${toolUseId}`);
    return false;
  }

  // Remove from pending and resolve
  pendingQuestionCallbacks.delete(toolUseId);
  callback.resolve(answers);

  return true;
}

/**
 * Handle plan confirmation response from frontend
 * Resolves the pending promise from the canUseTool callback
 */
export async function handlePlanResponse(sessionId, toolUseId, approved, feedback) {
  console.log(`[Claude] Received plan response for tool ${toolUseId}, approved: ${approved}`);

  const callback = pendingPlanConfirmations.get(toolUseId);
  if (!callback) {
    console.log(`[Claude] No pending plan callback found for toolUseId: ${toolUseId}`);
    return false;
  }

  pendingPlanConfirmations.delete(toolUseId);
  callback.resolve({ approved, feedback });

  return true;
}

/**
 * Send message to WebSocket (handles stringify + error checking)
 * Broadcasts to all session subscribers if sessionId is present
 */
function sendMessage(ws, data, username) {
  if (data.sessionId) {
    // Buffer for SSE replay
    broadcastToSession(data.sessionId, data);
    // Publish to event bus for SSE delivery
    if (username) {
      publish(username, data);
    }
  } else {
    // No sessionId - fall back to direct WS send
    if (ws && ws.readyState === 1) { // WebSocket.OPEN
      ws.send(JSON.stringify(data));
    }
  }
}

// Generate timestamp in ISO 8601 format
function generateTimestamp() {
  return new Date().toISOString();
}

/**
 * Transform SDK message for frontend display
 * Simplifies tool outputs to show minimal relevant info
 * Adds timestamp and message ID to all message types for tracking
 * Tracks tool execution timing for performance monitoring
 * Includes model information when available
 * Creates/completes tasks for tool execution
 */
function transformMessage(msg, model = null, sessionId = null, ws = null, username = null) {
  if (!msg || !msg.type) return null;

  // Common metadata for all messages
  const timestamp = generateTimestamp();
  const messageId = randomUUID();

  // Text content from assistant
  if (msg.type === 'assistant' && msg.message?.content) {
    const content = msg.message.content;

    // Extract text blocks
    if (Array.isArray(content)) {
      const texts = content
        .filter(c => c.type === 'text')
        .map(c => c.text)
        .join('');

      if (texts) {
        const result = {
          type: 'text',
          content: texts,
          timestamp,
          messageId
        };
        // Add model if available
        if (model) {
          result.model = model;
        }
        return result;
      }

      // Check for tool use blocks
      const toolUse = content.find(c => c.type === 'tool_use');
      if (toolUse) {
        // Skip AskUserQuestion - it's handled by canUseTool callback
        if (toolUse.name === 'AskUserQuestion') {
          return null;
        }

        // Skip ExitPlanMode - it's handled by canUseTool callback
        if (toolUse.name === 'ExitPlanMode') {
          return null;
        }

        // Record start time for this tool
        const startTime = new Date();
        toolStartTimes.set(toolUse.id, startTime);

        // Clean up old entries (keep last 100 to prevent memory leaks)
        if (toolStartTimes.size > 100) {
          const firstKey = toolStartTimes.keys().next().value;
          toolStartTimes.delete(firstKey);
        }

        // Create a task for this tool execution
        if (sessionId && ws) {
          const summary = getToolSummary(toolUse.name, toolUse.input);
          const taskTitle = typeof summary === 'object' ? summary.summary : summary;
          const task = taskManager.trackTaskStart(sessionId, {
            title: taskTitle,
            progress: 0,
            metadata: {
              tool: toolUse.name,
              toolUseId: toolUse.id,
              input: toolUse.input
            }
          });

          // Map toolUseId to taskId for completion
          toolUseToTaskMap.set(toolUse.id, task.taskId);

          // Broadcast task started
          broadcastTaskUpdate(ws, 'task-started', task, username, sessionId);

          // Clean up old mappings (keep last 100)
          if (toolUseToTaskMap.size > 100) {
            const firstKey = toolUseToTaskMap.keys().next().value;
            toolUseToTaskMap.delete(firstKey);
          }
        }

        const result = {
          type: 'tool_use',
          tool: toolUse.name,
          id: toolUse.id,
          summary: getToolSummary(toolUse.name, toolUse.input),
          timestamp,
          messageId,
          startTime: startTime.toISOString(),
          input: sanitizeToolInput(toolUse.name, toolUse.input)
        };
        // Add model if available
        if (model) {
          result.model = model;
        }
        // Ensure summary is an object with backward-compatible string summary
        if (typeof result.summary === 'object' && result.summary.summary) {
          // Already has object format - good!
          // The frontend can access result.summary.summary (string) and result.summary.fullCommand, etc.
        } else if (typeof result.summary === 'string') {
          // For backward compatibility with old format
          result.summary = { summary: result.summary };
        }
        return result;
      }
    }

    if (typeof content === 'string') {
      const result = {
        type: 'text',
        content,
        timestamp,
        messageId
      };
      // Add model if available
      if (model) {
        result.model = model;
      }
      return result;
    }
  }

  // Tool result (check before generic user return)
  if (msg.type === 'user' && msg.message?.content) {
    const content = msg.message.content;
    if (Array.isArray(content)) {
      const toolResult = content.find(c => c.type === 'tool_result');
      if (toolResult) {
        const toolUseId = toolResult.tool_use_id;
        const startTime = toolStartTimes.get(toolUseId);
        const endTime = new Date();

        // Calculate duration if we have start time
        let duration = null;
        let startTimeIso = null;
        if (startTime) {
          duration = endTime.getTime() - startTime.getTime();
          startTimeIso = startTime.toISOString();
          // Clean up after use
          toolStartTimes.delete(toolUseId);
        }

        // Complete or fail the task
        if (sessionId && ws) {
          const taskId = toolUseToTaskMap.get(toolUseId);
          if (taskId) {
            let task;
            if (toolResult.is_error) {
              task = taskManager.trackTaskFailed(sessionId, taskId, toolResult.content);
              if (task) {
                broadcastTaskUpdate(ws, 'task-failed', task, username, sessionId);
              }
            } else {
              task = taskManager.trackTaskComplete(sessionId, taskId, {
                output: typeof toolResult.content === 'string'
                  ? toolResult.content
                  : JSON.stringify(toolResult.content)
              });
              if (task) {
                broadcastTaskUpdate(ws, 'task-completed', task, username, sessionId);
              }
            }
            // Clean up mapping
            toolUseToTaskMap.delete(toolUseId);
          }
        }

        const result = {
          type: 'tool_result',
          id: toolUseId,
          success: !toolResult.is_error,
          output: truncateOutput(
            typeof toolResult.content === 'string'
              ? toolResult.content
              : JSON.stringify(toolResult.content),
            TOOL_OUTPUT_TRUNCATE_LENGTH
          ),
          timestamp,
          messageId,
          duration,
          startTime: startTimeIso
        };
        // Note: tool_result doesn't get model field as it's from the user side
        return result;
      }
    }
  }

  // User message echo - only reached if NOT a tool_result
  if (msg.type === 'user') {
    return null; // Don't echo back, frontend already shows it
  }

  // Result message (end of turn)
  if (msg.type === 'result') {
    return null; // Handled separately for token usage
  }

  return null;
}

/**
 * Sanitize bash command - redact secrets and truncate
 */
function sanitizeBashCommand(cmd) {
  if (!cmd || typeof cmd !== 'string') return '';
  let sanitized = cmd
    .replace(/(-H\s+["']?Authorization:\s*Bearer\s+)[^\s"']+/gi, '$1[REDACTED]')
    .replace(/(Bearer\s+)[A-Za-z0-9_\-\.]{20,}/g, '$1[REDACTED]')
    .replace(/(-u\s+)[^\s:]+:[^\s@]+(@)/g, '$1[REDACTED]$2')
    .replace(/(https?:\/\/)[^:@\s]+:[^:@\s]+(@)/g, '$1[REDACTED]$2')
    .replace(/((?:API_KEY|SECRET|TOKEN|PASSWORD|PASS)\s*=\s*)[^\s;]+/gi, '$1[REDACTED]');
  return truncateOutput(sanitized, 200);
}

/**
 * Sanitize tool input for client consumption
 */
function sanitizeToolInput(tool, input) {
  if (!input) return {};

  const normalizedTool = tool.toLowerCase();
  switch (normalizedTool) {
    case 'bash':
      return { command: sanitizeBashCommand(input.command || input.cmd || '') };
    case 'read':
      return { file_path: input.file_path || input.path, offset: input.offset, limit: input.limit };
    case 'write':
      return { file_path: input.file_path || input.path };
    case 'edit':
      const oldStr = String(input.old_string || '').slice(0, 30);
      const newStr = String(input.new_string || '').slice(0, 30);
      return { file_path: input.file_path || input.path, old_string: oldStr, new_string: newStr };
    case 'glob':
      return { pattern: input.pattern, path: input.path };
    case 'grep':
      return { pattern: input.pattern, path: input.path, glob: input.glob, type: input.type };
    case 'task':
      return { description: input.description || input.prompt, subagent_type: input.subagent_type };
    default:
      return {};
  }
}

// Tool summary formatters (data-driven approach)
// Returns object with summary string and full command details
const toolFormatters = {
  bash: (i) => {
    const fullCommand = i.command || i.cmd || '';
    return {
      summary: `$ ${truncateOutput(fullCommand, TOOL_SUMMARY_TRUNCATE_LENGTH)}`,
      fullCommand: fullCommand
    };
  },
  read: (i) => {
    const filePath = i.file_path || i.path || null;
    return {
      summary: `Reading ${filePath || 'file'}`,
      filePath: filePath
    };
  },
  write: (i) => {
    const filePath = i.file_path || i.path || null;
    return {
      summary: `Writing ${filePath || 'file'}`,
      filePath: filePath
    };
  },
  edit: (i) => {
    const filePath = i.file_path || i.path || null;
    return {
      summary: `Editing ${filePath || 'file'}`,
      filePath: filePath
    };
  },
  glob: (i) => {
    const pattern = i.pattern || null;
    return {
      summary: `Finding ${pattern || 'files'}`,
      pattern: pattern
    };
  },
  grep: (i) => {
    const pattern = i.pattern || i.query || null;
    const fullQuery = i.query || pattern || '';
    return {
      summary: `Searching: ${truncateOutput(pattern || '', TOOL_SUMMARY_TRUNCATE_LENGTH)}`,
      pattern: pattern,
      fullQuery: fullQuery
    };
  },
  todowrite: (i) => {
    const todos = i.todos || [];
    const todoCount = todos.length;
    const completedCount = todos.filter(t => t.status === 'completed' || t.status === 'done').length;
    return {
      summary: todoCount === 0 ? 'Updating todo list' : `Updating todo list (${completedCount}/${todoCount} completed)`,
      todos: todos,
      todoCount: todoCount,
      completedCount: completedCount
    };
  },
  todoread: () => ({ summary: 'Reading todo list' }),
  task: (i) => {
    const description = i?.prompt || i?.task || i?.description || '';
    return {
      summary: description
        ? `Task: ${truncateOutput(description, TOOL_SUMMARY_TRUNCATE_LENGTH)}`
        : 'Delegating task',
      taskDescription: description
    };
  },
  taskoutput: (i) => {
    const taskId = i?.task_id || '';
    return {
      summary: taskId ? `Checking task ${taskId}` : 'Checking task output',
      taskId
    };
  }
};

/**
 * Get tool summary with full command details
 * Returns object with backward-compatible 'summary' string and additional fields
 * @param {string} tool - Tool name
 * @param {object} input - Tool input parameters
 * @returns {object} Object with summary string and optional fullCommand, filePath, pattern fields
 */
function getToolSummary(tool, input) {
  if (!input) {
    return { summary: tool };
  }
  const formatter = toolFormatters[tool.toLowerCase()];
  if (formatter) {
    return formatter(input);
  }
  // Default: return tool name as summary
  return { summary: tool };
}

/**
 * Truncate long output for display
 */
function truncateOutput(content, maxLength) {
  if (typeof content !== 'string') return String(content);
  if (content.length <= maxLength) return content;
  return content.slice(0, maxLength) + `\n... (${content.length - maxLength} more chars)`;
}

/**
 * Extract token usage from SDK modelUsage
 * Returns enhanced metrics with model-specific context windows and separate cache metrics
 */
function extractTokenUsage(modelUsage) {
  if (!modelUsage) return null;

  const modelKey = Object.keys(modelUsage)[0];
  const data = modelUsage[modelKey];

  if (!data) return null;

  // Get raw token counts from SDK
  const input = data.cumulativeInputTokens || data.inputTokens || 0;
  const output = data.cumulativeOutputTokens || data.outputTokens || 0;
  const cacheRead = data.cumulativeCacheReadInputTokens || data.cacheReadInputTokens || 0;
  const cacheCreate = data.cumulativeCacheCreationInputTokens || data.cacheCreationInputTokens || 0;

  // Calculate cumulative total (all tokens in conversation history)
  const cumulativeTotal = input + output + cacheRead + cacheCreate;

  // Get model-specific context window
  const contextWindow = MODEL_CONTEXT_WINDOWS[modelKey] ||
                       parseInt(process.env.CONTEXT_WINDOW) ||
                       DEFAULT_CONTEXT_WINDOW;

  // Estimate current context (this is approximate since SDK manages context internally)
  // The SDK may truncate/summarize, so we use the minimum of cumulative and context window
  // In reality, the SDK manages this and we don't have direct visibility
  const estimatedContextUsed = Math.min(cumulativeTotal, contextWindow);

  // Calculate what percentage of context is actually being used on each turn
  // This uses the input tokens from the most recent turn (approximation)
  const currentTurnTokens = data.inputTokens || data.cumulativeInputTokens || 0;
  const contextUtilization = Math.min((currentTurnTokens / contextWindow) * 100, 100);

  return {
    // Cumulative metrics
    cumulativeTotal,
    cumulativeInput: input,
    cumulativeOutput: output,

    // Cache metrics (separate from context)
    cacheRead,
    cacheCreate,

    // Context window info
    contextWindow,
    model: modelKey,

    // Estimated utilization
    estimatedContextUsed,
    contextUtilization,

    // Backward compatibility - keep 'used' for existing code
    used: cumulativeTotal
  };
}

/**
 * Load MCP server config from ~/.claude.json
 */
async function loadMcpConfig(projectPath) {
  try {
    const configPath = path.join(os.homedir(), '.claude.json');
    const content = await fs.readFile(configPath, 'utf8');
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

// Log active sessions periodically for monitoring
setInterval(() => {
  if (activeSessions.size > 0) {
    console.log(`[Claude] Active sessions: ${activeSessions.size}`);
  }
}, 30 * 60 * 1000);
