#!/usr/bin/env node

import 'dotenv/config';
import express from 'express';
import { WebSocketServer } from 'ws';
import http from 'http';
import path from 'path';
import { fileURLToPath } from 'url';
import multer from 'multer';
import helmet from 'helmet';
import cors from 'cors';
import rateLimit from 'express-rate-limit';

import { authRoutes, authenticateToken, authenticateWebSocket } from './auth.js';
import { projectRoutes } from './projects.js';
import { fileRoutes } from './files.js';
import { handleChat, handleAbort, handleQuestionResponse, handlePlanResponse } from './claude.js';
import { getAllCommands } from './commands.js';
import { processUpload, validateFile } from './uploads.js';
import logger from './logger.js';
import { subscribe, publish } from './bus.js';
import { getSessionsForUser } from './session-registry.js';
import { replayBufferToSSE } from './broadcast.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Express app
const app = express();
app.set('trust proxy', 1);
const server = http.createServer(app);

// Security middleware
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      styleSrc: ["'self'", "'unsafe-inline'", "https://cdn.jsdelivr.net"],
      scriptSrc: ["'self'", "https://cdn.jsdelivr.net"],
      connectSrc: ["'self'", "ws:", "wss:"],
      imgSrc: ["'self'", "data:", "blob:", "https://cdn.jsdelivr.net"]
    }
  }
}));

// CORS configuration
const configuredOrigins = process.env.ALLOWED_ORIGINS
  ? process.env.ALLOWED_ORIGINS.split(',')
  : [];

function isAllowedOrigin(origin, requestHost = null) {
  if (!origin) return true; // Same-origin, Postman, mobile apps
  if (configuredOrigins.includes(origin)) return true;
  // Always allow local development
  try {
    const url = new URL(origin);
    const hostname = url.hostname;
    if (requestHost && hostname === requestHost.split(':')[0]) return true;
    if (hostname === 'localhost' || hostname === '127.0.0.1') return true;
    // Allow local network IPs (192.168.x.x, 10.x.x.x, 172.16-31.x.x)
    if (/^(192\.168\.|10\.|172\.(1[6-9]|2[0-9]|3[01])\.)/.test(hostname)) return true;
  } catch {}
  return false;
}

app.use((req, res, next) => cors({
  origin: (origin, callback) => {
    if (isAllowedOrigin(origin, req.headers.host)) return callback(null, true);
    callback(new Error('Not allowed by CORS'));
  },
  credentials: true
})(req, res, next));

// Rate limiting
const limiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 100, // limit each IP to 100 requests per windowMs
  message: { error: 'Too many requests, please try again later' },
  standardHeaders: true,
  legacyHeaders: false,
  validate: { xForwardedForHeader: false }
});
app.use('/api/', limiter);

// Stricter rate limit for auth endpoints
const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10, // only 10 login/register attempts per 15 min
  message: { error: 'Too many authentication attempts, please try again later' },
  validate: { xForwardedForHeader: false }
});
app.use('/api/auth/login', authLimiter);
app.use('/api/auth/register', authLimiter);

// Body parsing with size limit
app.use(express.json({ limit: '1mb' }));

// Request logging
app.use((req, res, next) => {
  const start = Date.now();
  res.on('finish', () => {
    const duration = Date.now() - start;
    logger.info(`${req.method} ${req.path}`, {
      status: res.statusCode,
      duration: `${duration}ms`,
      ip: req.ip
    });
  });
  next();
});

// Configure multer for file uploads (memory storage)
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 } // 10MB
});

// Static files (frontend)
app.use(express.static(path.join(__dirname, '../public')));

// API Routes
app.use('/api/auth', authRoutes);
app.use('/api/projects', authenticateToken, projectRoutes);
app.use('/api/files', authenticateToken, fileRoutes);

// Health check
app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// Commands API - get global and project slash commands
app.get('/api/commands', authenticateToken, async (req, res) => {
  try {
    const projectPath = req.query.projectPath || null;
    const commands = await getAllCommands(projectPath);
    res.json(commands);
  } catch (err) {
    logger.error('Error fetching commands', { error: err.message, projectPath: req.query.projectPath });
    res.status(500).json({ error: 'Failed to fetch commands' });
  }
});

// File upload API - for PDF text extraction
app.post('/api/upload', authenticateToken, upload.single('file'), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: 'No file provided' });
    }

    validateFile(req.file);
    const result = await processUpload(req.file);

    res.json(result);
  } catch (err) {
    logger.error('File upload error', { error: err.message, filename: req.file?.originalname });
    res.status(400).json({ error: err.message });
  }
});

// SSE Event Stream
app.get('/api/events', (req, res) => {
  const token = req.query.token;
  const user = authenticateWebSocket(token);
  if (!user) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  logger.info('SSE connected', { username: user.username });

  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive',
    'X-Accel-Buffering': 'no'
  });

  if (res.socket) res.socket.setNoDelay(true);
  res.flushHeaders();
  res.write('retry: 2000\n\n');

  const userSessions = getSessionsForUser(user.username);
  res.write(`data: ${JSON.stringify({ type: 'state-snapshot', sessions: userSessions })}\n\n`);

  for (const s of userSessions.filter(s => s.status === 'streaming')) {
    replayBufferToSSE(s.sessionId, res);
  }

  const unsubscribe = subscribe(user.username, (event) => {
    try {
      res.write(`data: ${JSON.stringify(event)}\n\n`);
    } catch (err) {
      logger.error('SSE write error', { username: user.username, error: err.message });
    }
  });

  const heartbeat = setInterval(() => {
    try {
      res.write(`data: ${JSON.stringify({ type: 'heartbeat' })}\n\n`);
    } catch (err) {
      clearInterval(heartbeat);
    }
  }, 30000);

  req.on('close', () => {
    logger.info('SSE disconnected', { username: user.username });
    unsubscribe();
    clearInterval(heartbeat);
  });
});

// SPA fallback - serve index.html for all non-API routes
app.get('*', (req, res) => {
  if (!req.path.startsWith('/api')) {
    res.sendFile(path.join(__dirname, '../public/index.html'));
  } else {
    res.status(404).json({ error: 'Not found' });
  }
});

// WebSocket server with origin validation
const wss = new WebSocketServer({
  server,
  verifyClient: (info) => {
    // Validate origin
    const origin = info.origin || info.req.headers.origin;
    if (!isAllowedOrigin(origin, info.req.headers.host)) {
      logger.warn('WebSocket connection rejected: invalid origin', { origin });
      return false;
    }

    // Extract token from query string
    const url = new URL(info.req.url, 'http://localhost');
    const token = url.searchParams.get('token');

    const user = authenticateWebSocket(token);
    if (!user) {
      logger.warn('WebSocket connection rejected: invalid token');
      return false;
    }

    // Attach user to request for later use
    info.req.user = user;
    return true;
  }
});

// WebSocket connection handler
wss.on('connection', (ws, req) => {
  const user = req.user;
  logger.info('WebSocket connected', { username: user.username });

  ws.isAlive = true;
  ws.on('pong', () => { ws.isAlive = true; });

  ws.on('message', async (data) => {
    try {
      const msg = JSON.parse(data.toString());

      switch (msg.type) {
        case 'chat':
          await handleChat(msg, ws, user.username);
          break;

        case 'abort':
          const success = await handleAbort(msg.sessionId);
          publish(user.username, {
            type: 'abort-result',
            sessionId: msg.sessionId,
            success
          });
          break;

        case 'question-response':
          const responseSuccess = await handleQuestionResponse(
            msg.sessionId,
            msg.toolUseId,
            msg.answers
          );
          publish(user.username, {
            type: 'question-response-result',
            sessionId: msg.sessionId,
            success: responseSuccess
          });
          break;

        case 'plan-response': {
          const planSuccess = await handlePlanResponse(
            msg.sessionId,
            msg.toolUseId,
            msg.approved,
            msg.feedback
          );
          publish(user.username, {
            type: 'plan-response-result',
            sessionId: msg.sessionId,
            success: planSuccess
          });
          break;
        }

        case 'ping':
          ws.send(JSON.stringify({ type: 'pong' }));
          break;

        default:
          logger.debug('Unknown WebSocket message type', { type: msg.type });
      }

    } catch (err) {
      logger.error('WebSocket message handling error', { error: err.message, username: user.username });
      ws.send(JSON.stringify({
        type: 'error',
        sessionId: msg.sessionId || null,
        message: err.message || 'Internal error'
      }));
    }
  });

  ws.on('close', () => {
    logger.info('WebSocket disconnected', { username: user.username });
  });

  ws.on('error', (err) => {
    logger.error('WebSocket error', { username: user.username, error: err.message });
  });
});

// Heartbeat to detect broken connections
const heartbeatInterval = setInterval(() => {
  wss.clients.forEach((ws) => {
    if (ws.isAlive === false) {
      return ws.terminate();
    }
    ws.isAlive = false;
    ws.ping();
  });
}, 30000);

wss.on('close', () => {
  clearInterval(heartbeatInterval);
});

// Start server
const PORT = process.env.PORT || 3010;
const HOST = process.env.HOST || '0.0.0.0';

server.listen(PORT, HOST, () => {
  logger.info('Cleon UI started', {
    local: `http://localhost:${PORT}`,
    network: `http://${HOST}:${PORT}`
  });
});

// Graceful shutdown
process.on('SIGTERM', () => {
  logger.info('SIGTERM received, shutting down...');
  server.close(() => {
    logger.info('Server closed');
    process.exit(0);
  });
});

process.on('SIGINT', () => {
  logger.info('SIGINT received, shutting down...');
  server.close(() => {
    logger.info('Server closed');
    process.exit(0);
  });
});
