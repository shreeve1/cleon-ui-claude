import { state } from './state.js';
import { escapeHtml, escapeAttr, formatTimestamp, formatDuration, getShortId, copyToClipboard, getToolIcon, getCompactSummary } from './utils.js';
import { formatMarkdown } from './markdown.js';
import { setElementHtml, abortBtn, chatInput, sendBtn, modeBtn, modelBtn, attachBtn, scrollToBottomBtn, unreadBadge } from './dom.js';
import { flushPendingText } from './streaming.js';
import { getActiveSession } from './sessions.js';

const CLUSTER_THRESHOLD = 3; // Minimum pills to form a cluster

function renderActivityStatus(session) {
  const el = document.getElementById('activity-status');
  if (!el) return;

  const labelEl = el.querySelector('.activity-label');
  const elapsedEl = el.querySelector('.activity-elapsed');
  const indicatorEl = el.querySelector('.activity-indicator');

  if (!session || !session.activityState) {
    el.classList.add('hidden');
    indicatorEl.className = 'activity-indicator';
    return;
  }

  const { state, label, description, elapsed } = session.activityState;

  el.classList.remove('hidden');

  // Set indicator animation class
  indicatorEl.className = 'activity-indicator ' + state;

  // Set label text
  labelEl.textContent = description ? `${label} — ${description}` : (label || '');

  // Set elapsed timer
  if (elapsed != null) {
    elapsedEl.textContent = `${elapsed}s`;
    elapsedEl.classList.remove('hidden');
  } else {
    elapsedEl.classList.add('hidden');
  }
}

function finishStreaming(session) {
  session = session || getActiveSession();
  if (!session) return;
  session.isStreaming = false;
  session.pendingPlanConfirmation = null;
  session.activityState = null;
  renderActivityStatus(session);

  // Ensure renderer is cleaned up
  if (session.streamingRenderer) {
    session.streamingRenderer.skipToEnd();
    session.streamingRenderer.destroy();
    session.streamingRenderer = null;
  }

  flushPendingText(session);

  // Only update UI controls if this is the active session
  if (state.sessions.indexOf(session) === state.activeSessionIndex) {
    abortBtn.classList.add('hidden');
    chatInput.disabled = false;
    sendBtn.disabled = false;
    modeBtn.disabled = false;
    modelBtn.disabled = false;
    attachBtn.disabled = false;
  }

  // Scope question cancellation to session container
  if (session.containerEl) {
    const streamingEl = session.containerEl.querySelector('.message.streaming');
    if (streamingEl) streamingEl.classList.remove('streaming');
    if (session.pendingQuestion) {
      const questionBlock = session.containerEl.querySelector('.message.question-block:not(.submitted)');
      if (questionBlock) {
        questionBlock.classList.add('cancelled');
        const submitBtn = questionBlock.querySelector('.question-submit');
        if (submitBtn) { submitBtn.disabled = true; submitBtn.textContent = 'Cancelled'; }
        questionBlock.querySelectorAll('.question-option').forEach(opt => { opt.style.pointerEvents = 'none'; });
        questionBlock.querySelectorAll('.question-custom-input').forEach(input => { input.disabled = true; });
      }
      session.pendingQuestion = null;
    }
    // Also clean up any pending plan confirmation
    if (session.pendingPlanConfirmation) {
      const planBlock = session.containerEl.querySelector('.plan-confirmation-block:not(.submitted)');
      if (planBlock) {
        markPlanConfirmationSubmitted(planBlock, 'rejected');
      }
      session.pendingPlanConfirmation = null;
    }
  }
}

function appendMessage(role, content, session, attachments = null) {
  session = session || getActiveSession();
  if (!session?.containerEl) return;
  removeWelcome(session);
  const div = document.createElement('div');
  div.className = `message ${role}`;

  // For assistant messages, add message header with metadata
  if (role === 'assistant') {
    // Check if we have metadata from streaming
    const metadata = session.currentMessageMetadata || {};
    const timestamp = metadata.timestamp || null;
    const messageId = metadata.messageId || null;
    const model = metadata.model || null;

    let headerHtml = '';
    if (timestamp || messageId || model) {
      headerHtml = '<div class="message-header">';
      if (timestamp) {
        headerHtml += `<span class="message-timestamp" title="${escapeAttr(timestamp)}">${escapeHtml(formatTimestamp(timestamp))}</span>`;
      }
      if (messageId) {
        headerHtml += `<span class="message-id" title="${escapeAttr(messageId)}">· ${escapeHtml(getShortId(messageId))}</span>`;
      }
      if (model) {
        headerHtml += `<span class="model-badge">${escapeHtml(model)}</span>`;
      }
      headerHtml += '</div>';
    }

    setElementHtml(div, headerHtml + formatMarkdown(content));

    // Store metadata on element for history loading
    if (timestamp) div.dataset.timestamp = timestamp;
    if (messageId) div.dataset.messageId = messageId;
    if (model) div.dataset.model = model;
  } else if (role === 'user' && attachments && attachments.length > 0) {
    // Render user message with image attachments
    const imageAttachments = attachments.filter(att => att.type === 'image');
    let contentHtml = escapeHtml(content);
    if (imageAttachments.length > 0) {
      const imagesHtml = imageAttachments.map(att =>
        `<img src="${att.data}" alt="${escapeAttr(att.name)}" class="message-image">`
      ).join('');
      contentHtml += `<div class="message-images">${imagesHtml}</div>`;
    }
    setElementHtml(div, contentHtml);
  } else {
    div.textContent = content;
  }

  session.containerEl.appendChild(div);
  scrollToBottom(session);
}

function appendSystemMessage(content, session) {
  session = session || getActiveSession();
  if (!session?.containerEl) return;
  removeWelcome(session);
  const div = document.createElement('div');
  div.className = 'message assistant';
  div.style.borderLeft = '3px solid var(--error)';
  div.textContent = content;
  session.containerEl.appendChild(div);
  scrollToBottom(session);
}

/**
 * Format timestamp to human-readable time
 * @param {string} isoString - ISO 8601 timestamp
 * @returns {string} Formatted time like "2:34 PM" or empty string if invalid
 */

function renderToolDetails(tool, input) {
  if (!input || Object.keys(input).length === 0) return '';

  const normalizedTool = tool.toLowerCase();

  switch (normalizedTool) {
    case 'read':
      if (input.offset !== undefined && input.limit !== undefined) {
        return `Lines ${input.offset}-${input.offset + input.limit} of ${escapeHtml(input.file_path || 'file')}`;
      } else if (input.file_path) {
        return `Full file: ${escapeHtml(input.file_path)}`;
      }
      return '';

    case 'bash':
      if (input.command) {
        return `<code>${escapeHtml(input.command)}</code>`;
      }
      return '';

    case 'grep':
      let details = '';
      if (input.pattern) details += `Pattern: <code>${escapeHtml(input.pattern)}</code>`;
      if (input.glob) details += ` in <code>${escapeHtml(input.glob)}</code>`;
      if (input.type) details += ` (${escapeHtml(input.type)} files)`;
      return details;

    case 'edit':
      if (input.old_string && input.new_string) {
        return `${escapeHtml(input.old_string)}... → ${escapeHtml(input.new_string)}...`;
      }
      return '';

    case 'glob':
      if (input.pattern) {
        const pathInfo = input.path ? ` in ${escapeHtml(input.path)}` : '';
        return `Pattern: <code>${escapeHtml(input.pattern)}</code>${pathInfo}`;
      }
      return '';

    case 'task':
      if (input.description) {
        const agentInfo = input.subagent_type ? ` (${escapeHtml(input.subagent_type)})` : '';
        return `Delegating${agentInfo}: ${escapeHtml(input.description)}`;
      }
      return '';

    case 'write':
      if (input.file_path) {
        return `File: ${escapeHtml(input.file_path)}`;
      }
      return '';

    default:
      return '';
  }
}

function maybeCluster(session) {
  if (!session?.containerEl) return;

  const children = Array.from(session.containerEl.children);

  // Find consecutive run of unclustered tool pills at the END of the container
  let run = [];
  for (let i = children.length - 1; i >= 0; i--) {
    const child = children[i];
    if (child.classList.contains('tool-pill') && !child.closest('.tool-cluster')) {
      run.unshift(child);
    } else if (child.classList.contains('tool-cluster')) {
      // Found an existing cluster at the end - stop here, we may add to it
      break;
    } else {
      break; // Hit a non-tool message, stop
    }
  }

  if (run.length < CLUSTER_THRESHOLD) return; // Not enough to cluster

  // Check if there's already a cluster right before this run
  const firstPill = run[0];
  const prevSibling = firstPill.previousElementSibling;

  if (prevSibling && prevSibling.classList.contains('tool-cluster')) {
    // Add pills to existing cluster
    const clusterBody = prevSibling.querySelector('.tool-cluster-body');
    run.forEach(pill => clusterBody.appendChild(pill));
    updateClusterHeader(prevSibling);
  } else {
    // Create new cluster
    const cluster = document.createElement('div');
    cluster.className = 'tool-cluster';

    const header = document.createElement('div');
    header.className = 'tool-cluster-header';
    setElementHtml(header, '<span class="tool-cluster-chevron">&#x25BE;</span> <span class="tool-cluster-summary"></span>');
    header.classList.add('expanded');

    const body = document.createElement('div');
    body.className = 'tool-cluster-body';

    // Insert cluster where first pill was
    firstPill.parentNode.insertBefore(cluster, firstPill);
    cluster.appendChild(header);
    cluster.appendChild(body);

    // Move pills into cluster body
    run.forEach(pill => body.appendChild(pill));

    updateClusterHeader(cluster);

    // Click handler for cluster header
    header.addEventListener('click', () => {
      const isExpanded = !body.classList.contains('hidden');
      body.classList.toggle('hidden');
      header.classList.toggle('expanded');
      const chevron = header.querySelector('.tool-cluster-chevron');
      if (chevron) {
        chevron.textContent = isExpanded ? '\u25B8' : '\u25BE';
      }
    });
  }
}

function updateClusterHeader(cluster) {
  const pills = cluster.querySelectorAll('.message.tool-pill');
  const total = pills.length;

  // Count by tool type
  const toolCounts = {};
  let doneCount = 0;
  let errorCount = 0;

  pills.forEach(pill => {
    const toolName = pill.dataset.tool || 'unknown';
    toolCounts[toolName] = (toolCounts[toolName] || 0) + 1;
    if (pill.classList.contains('success')) doneCount++;
    if (pill.classList.contains('error')) errorCount++;
  });

  const running = total - doneCount - errorCount;

  // Build summary: "5 tool calls (3 Bash, 2 Grep)"
  const breakdown = Object.entries(toolCounts)
    .map(([tool, count]) => `${count} ${tool}`)
    .join(', ');

  let statusStr = '';
  if (running > 0) {
    statusStr = ` \u2014 ${doneCount}/${total} done`;
  } else if (errorCount > 0) {
    statusStr = ` \u2014 ${doneCount} done, ${errorCount} failed`;
  } else {
    statusStr = ` \u2014 all done`;
  }

  const summaryEl = cluster.querySelector('.tool-cluster-summary');
  if (summaryEl) {
    summaryEl.textContent = `${total} tool calls (${breakdown})${statusStr}`;
  }
}

function appendToolMessage(tool, summary, id, status, session, metadata = null, input = null) {
  session = session || getActiveSession();
  if (!session?.containerEl) return;
  removeWelcome(session);

  const div = document.createElement('div');
  div.className = `message tool-pill ${status}`;
  div.dataset.toolId = id || '';
  div.dataset.tool = tool.toLowerCase();  // For CSS color selectors

  // Store metadata
  if (metadata) {
    div.dataset.timestamp = metadata.timestamp || '';
    div.dataset.messageId = metadata.messageId || '';
    div.dataset.model = metadata.model || '';
    div.dataset.startTime = metadata.startTime || '';
  }

  const serverSummary = typeof summary === 'object' ? (summary.summary || JSON.stringify(summary)) : summary;
  const compactSummary = getCompactSummary(tool, input || {}) || serverSummary;
  const detailsHtml = renderToolDetails(tool, input || {});

  const statusText = status === 'running' ? '⋯' : status === 'success' ? '✓' : '✗';
  const durationHtml = status === 'running' ? '<span class="tool-pill-duration">0.0s</span>' : '';

  setElementHtml(div, `
    <div class="tool-pill-header expanded" data-tool-id="${escapeHtml(id || '')}">
      <div class="tool-pill-top">
        <div style="display: flex; align-items: center; gap: 4px;">
          <span class="tool-pill-icon">${getToolIcon(tool)}</span>
          <span class="tool-pill-name">${escapeHtml(tool)}</span>
          <span class="tool-pill-summary">${escapeHtml(compactSummary)}</span>
          <span class="tool-pill-chevron">▾</span>
        </div>
        <div style="display: flex; align-items: center; gap: 4px;">
          <span class="tool-pill-status ${status}">${statusText}</span>
          ${durationHtml}
        </div>
      </div>
    </div>
    <div class="tool-pill-output">${detailsHtml ? `<div class="tool-pill-output-command">${detailsHtml}</div>` : ''}</div>
  `);

  session.containerEl.appendChild(div);
  scrollToBottom(session);
  maybeCluster(session);
}

function updateToolResult(id, success, output, session, resultMetadata = null) {
  session = session || getActiveSession();
  if (!session?.containerEl) return;

  const toolMsgs = session.containerEl.querySelectorAll('.message.tool-pill');
  let target = null;

  if (id) {
    target = session.containerEl.querySelector(`.message.tool-pill[data-tool-id="${id}"]`);
  }
  if (!target && toolMsgs.length > 0) {
    target = toolMsgs[toolMsgs.length - 1];
  }

  if (target) {
    target.classList.remove('running');
    target.classList.add(success ? 'success' : 'error');

    const statusEl = target.querySelector('.tool-pill-status');
    if (statusEl) {
      statusEl.textContent = success ? '✓' : '✗';
      statusEl.className = `tool-pill-status ${success ? 'success' : 'error'}`;
    }

    // Store result metadata (duration, etc.) and display duration
    if (resultMetadata) {
      if (resultMetadata.duration !== null && resultMetadata.duration !== undefined) {
        target.dataset.duration = String(resultMetadata.duration);
        const durationEl = target.querySelector('.tool-pill-duration');
        if (durationEl) {
          durationEl.textContent = formatDuration(resultMetadata.duration);
        }
      }
      if (resultMetadata.timestamp) {
        target.dataset.resultTimestamp = resultMetadata.timestamp;
      }
    }

    if (output && output.trim()) {
      const outputEl = target.querySelector('.tool-pill-output');
      if (outputEl) {
        // If there's an existing command detail div, keep it and append output after
        const existingCommand = outputEl.querySelector('.tool-pill-output-command');
        if (existingCommand) {
          const outputText = document.createElement('pre');
          outputText.textContent = output;
          outputEl.appendChild(outputText);
        } else {
          outputEl.textContent = output;
        }

        // Always show output expanded
        outputEl.classList.remove('hidden');
        const header = target.querySelector('.tool-pill-header');
        if (header) header.classList.add('expanded');
      }
    }

    // Update cluster header if this pill is inside a cluster
    const parentCluster = target.closest('.tool-cluster');
    if (parentCluster) {
      updateClusterHeader(parentCluster);
    }
  }
  scrollToBottom(session);
}

function renderQuestion(data, session) {
  session = session || getActiveSession();
  if (!session?.containerEl) return;
  removeWelcome(session);

  const div = document.createElement('div');
  div.className = 'message question-block';
  div.dataset.questionId = data.id;

  let html = '';

  data.questions.forEach((q, qIndex) => {
    const isMultiple = q.multiSelect || q.multiple || false;

    html += `
      <div class="question-group" data-question-index="${qIndex}" data-multiple="${isMultiple}">
        <div class="question-header">${escapeHtml(q.header || '')}</div>
        <div class="question-text">${escapeHtml(q.question)}</div>
        <div class="question-options">
    `;

    if (q.options && q.options.length > 0) {
      q.options.forEach(opt => {
        html += `
          <div class="question-option" data-label="${escapeAttr(opt.label)}" data-qindex="${qIndex}">
            <span class="option-label">${escapeHtml(opt.label)}</span>
            ${opt.description ? `<span class="option-desc">${escapeHtml(opt.description)}</span>` : ''}
          </div>
        `;
      });
    }

    html += `
        </div>
        <div class="question-custom-container">
          <input type="text" class="question-custom-input" data-qindex="${qIndex}" placeholder="Type your own answer...">
        </div>
      </div>
    `;
  });

  html += `
    <button class="question-submit" disabled>Submit Answer</button>
  `;

  setElementHtml(div, html);
  session.containerEl.appendChild(div);

  div.querySelectorAll('.question-option').forEach(opt => {
    opt.addEventListener('click', () => handleOptionSelect(opt));
  });

  div.querySelectorAll('.question-custom-input').forEach(input => {
    input.addEventListener('input', () => handleCustomInputChange(input));
  });

  div.querySelector('.question-submit').addEventListener('click', submitQuestionResponse);

  scrollToBottom(session);
}

function renderPlanConfirmation(data, session) {
  if (!session || !session.containerEl) return;

  const div = document.createElement('div');
  div.className = 'message plan-confirmation-block';
  div.dataset.confirmationId = data.id;

  setElementHtml(div, `
    <div class="plan-confirmation-header">
      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
        <path d="M9 11l3 3L22 4"/>
        <path d="M21 12v7a2 2 0 01-2 2H5a2 2 0 01-2-2V5a2 2 0 012-2h11"/>
      </svg>
      <span>Plan complete. Ready to implement?</span>
    </div>
    <div class="plan-confirmation-actions">
      <button class="plan-confirm-btn plan-approve-btn" data-action="approve">Approve Plan</button>
      <button class="plan-confirm-btn plan-reject-btn" data-action="reject">Reject &amp; Revise</button>
    </div>
    <div class="plan-feedback-container hidden">
      <input type="text" class="plan-feedback-input" placeholder="What should be revised? (optional)">
      <button class="plan-confirm-btn plan-send-feedback-btn">Send Feedback</button>
    </div>
  `);

  // Approve button handler
  div.querySelector('.plan-approve-btn').addEventListener('click', () => {
    sendPlanResponse(session, data.id, true, null);
    markPlanConfirmationSubmitted(div, 'approved');
  });

  // Reject button handler - shows feedback input
  div.querySelector('.plan-reject-btn').addEventListener('click', () => {
    div.querySelector('.plan-feedback-container').classList.remove('hidden');
    div.querySelector('.plan-reject-btn').classList.add('hidden');
    div.querySelector('.plan-feedback-input').focus();
  });

  // Send feedback button handler
  div.querySelector('.plan-send-feedback-btn').addEventListener('click', () => {
    const feedback = div.querySelector('.plan-feedback-input').value.trim();
    sendPlanResponse(session, data.id, false, feedback || null);
    markPlanConfirmationSubmitted(div, 'rejected');
  });

  // Also allow Enter key on feedback input
  div.querySelector('.plan-feedback-input').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      const feedback = e.target.value.trim();
      sendPlanResponse(session, data.id, false, feedback || null);
      markPlanConfirmationSubmitted(div, 'rejected');
    }
  });

  session.containerEl.appendChild(div);
  scrollToBottom(session);
}

function handleOptionSelect(optionEl) {
  const qIndex = parseInt(optionEl.dataset.qindex);
  const label = optionEl.dataset.label;
  const questionGroup = optionEl.closest('.question-group');
  const isMultiple = questionGroup.dataset.multiple === 'true';

  const session = getActiveSession();
  if (!session || !session.pendingQuestion) return;

  if (!session.pendingQuestion.selectedAnswers[qIndex]) {
    session.pendingQuestion.selectedAnswers[qIndex] = [];
  }

  const answers = session.pendingQuestion.selectedAnswers[qIndex];
  const existingIndex = answers.indexOf(label);

  if (isMultiple) {
    if (existingIndex >= 0) {
      answers.splice(existingIndex, 1);
      optionEl.classList.remove('selected');
    } else {
      answers.push(label);
      optionEl.classList.add('selected');
    }
  } else {
    questionGroup.querySelectorAll('.question-option').forEach(opt => {
      opt.classList.remove('selected');
    });
    session.pendingQuestion.selectedAnswers[qIndex] = [label];
    optionEl.classList.add('selected');
  }

  const customInput = questionGroup.querySelector('.question-custom-input');
  if (customInput) {
    customInput.value = '';
  }

  updateSubmitButtonState();
}

function handleCustomInputChange(inputEl) {
  const qIndex = parseInt(inputEl.dataset.qindex);
  const value = inputEl.value.trim();
  const questionGroup = inputEl.closest('.question-group');

  const session = getActiveSession();
  if (!session || !session.pendingQuestion) return;

  questionGroup.querySelectorAll('.question-option').forEach(opt => {
    opt.classList.remove('selected');
  });

  if (value) {
    session.pendingQuestion.selectedAnswers[qIndex] = [value];
  } else {
    delete session.pendingQuestion.selectedAnswers[qIndex];
  }

  updateSubmitButtonState();
}

function updateSubmitButtonState() {
  const session = getActiveSession();
  if (!session || !session.pendingQuestion || !session.containerEl) return;

  const questionBlock = session.containerEl.querySelector(
    `.message.question-block[data-question-id="${session.pendingQuestion.id}"]`
  );
  if (!questionBlock) return;

  const submitBtn = questionBlock.querySelector('.question-submit');
  const totalQuestions = session.pendingQuestion.questions.length;
  const answeredQuestions = Object.keys(session.pendingQuestion.selectedAnswers).filter(
    key => session.pendingQuestion.selectedAnswers[key]?.length > 0
  ).length;

  submitBtn.disabled = answeredQuestions < totalQuestions;
}

function submitQuestionResponse() {
  const session = getActiveSession();
  if (!session || !session.pendingQuestion || !session.sessionId) return;

  const answers = session.pendingQuestion.selectedAnswers;

  state.ws.send(JSON.stringify({
    type: 'question-response',
    sessionId: session.sessionId,
    toolUseId: session.pendingQuestion.id,
    answers: answers
  }));

  const questionBlock = session.containerEl?.querySelector(
    `.message.question-block[data-question-id="${session.pendingQuestion.id}"]`
  );
  if (questionBlock) {
    questionBlock.classList.add('submitted');
    const submitBtn = questionBlock.querySelector('.question-submit');
    if (submitBtn) {
      submitBtn.disabled = true;
      submitBtn.textContent = 'Submitted';
    }
    questionBlock.querySelectorAll('.question-option').forEach(opt => {
      opt.style.pointerEvents = 'none';
    });
    questionBlock.querySelectorAll('.question-custom-input').forEach(input => {
      input.disabled = true;
    });
  }

  session.pendingQuestion = null;
}

function sendPlanResponse(session, toolUseId, approved, feedback) {
  if (!session || !session.sessionId || !state.ws) return;
  state.ws.send(JSON.stringify({
    type: 'plan-response',
    sessionId: session.sessionId,
    toolUseId: toolUseId,
    approved: approved,
    feedback: feedback
  }));
}

function markPlanConfirmationSubmitted(element, status) {
  element.classList.add('submitted');
  const actions = element.querySelector('.plan-confirmation-actions');
  const feedbackContainer = element.querySelector('.plan-feedback-container');
  if (actions) setElementHtml(actions, `<span class="plan-status plan-status-${status}">${status === 'approved' ? 'Plan approved' : 'Plan rejected — revising...'}</span>`);
  if (feedbackContainer) feedbackContainer.classList.add('hidden');
}

function removeWelcome(session) {
  session = session || getActiveSession();
  if (!session?.containerEl) return;
  const welcome = session.containerEl.querySelector('.welcome-message');
  if (welcome) welcome.remove();
}

function clearMessages(session) {
  session = session || getActiveSession();
  if (!session?.containerEl) return;
  const isResuming = !!session.sessionId;
  setElementHtml(session.containerEl, `
    <div class="welcome-message">
      <h2>${isResuming ? 'Continuing Session' : 'New Session'}</h2>
      <p>${isResuming ? 'Continuing session - conversation context preserved.' : 'New session - no conversation history.'}</p>
    </div>
  `);
  session.pendingText = '';
}

function updateScrollFAB(session) {
  const active = getActiveSession();
  if (!session || session !== active) return;
  if (session.isAtBottom || session.unreadCount === 0) {
    scrollToBottomBtn.classList.add('hidden');
  } else {
    scrollToBottomBtn.classList.remove('hidden');
    if (session.unreadCount > 0) {
      unreadBadge.textContent = session.unreadCount;
      unreadBadge.classList.remove('hidden');
    } else {
      unreadBadge.classList.add('hidden');
    }
  }
}

function scrollToBottom(session) {
  session = session || getActiveSession();
  if (!session?.containerEl) return;
  if (session.isAtBottom !== false) {
    requestAnimationFrame(() => {
      session.containerEl.scrollTop = session.containerEl.scrollHeight;
    });
  } else {
    session.unreadCount++;
    updateScrollFAB(session);
  }
}



export { renderActivityStatus, finishStreaming, appendMessage, appendSystemMessage, renderToolDetails, maybeCluster, updateClusterHeader, appendToolMessage, updateToolResult, renderQuestion, renderPlanConfirmation, handleOptionSelect, handleCustomInputChange, updateSubmitButtonState, submitQuestionResponse, sendPlanResponse, markPlanConfirmationSubmitted, removeWelcome, clearMessages, updateScrollFAB, scrollToBottom };
