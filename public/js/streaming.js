import { setElementHtml } from './dom.js';
import { formatMarkdown } from './markdown.js';
class StreamingRenderer {
  constructor(element) {
    this.element = element;
    this.networkBuffer = '';
    this.displayedChars = 0;
    this.rafHandle = null;
    this.timeoutHandle = null;
    const prefersReducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    this.charInterval = prefersReducedMotion ? 0 : 5; // ms per char (~200 chars/sec)
  }

  appendNetworkChunk(chunk) {
    this.networkBuffer += chunk;
    if (!this.rafHandle) {
      this.scheduleRender();
    }
  }

  scheduleRender() {
    this.rafHandle = requestAnimationFrame(() => {
      this.renderNextChar();
    });
  }

  renderNextChar() {
    if (this.displayedChars < this.networkBuffer.length) {
      this.displayedChars++;
      this.element.textContent = this.networkBuffer.slice(0, this.displayedChars);

      // Schedule next character
      this.timeoutHandle = setTimeout(() => {
        this.scheduleRender();
      }, this.charInterval);
    } else {
      // Caught up with network buffer
      this.rafHandle = null;
    }
  }

  finalizeMarkdown() {
    // Skip to end and apply markdown
    this.element.textContent = this.networkBuffer;
    setElementHtml(this.element, formatMarkdown(this.networkBuffer));

    // Apply Prism highlighting to code blocks
    if (typeof Prism !== 'undefined') {
      this.element.querySelectorAll('pre code').forEach(block => {
        Prism.highlightElement(block);
      });
    }
  }

  skipToEnd() {
    this.destroy();
    this.finalizeMarkdown();
  }

  destroy() {
    if (this.rafHandle) {
      cancelAnimationFrame(this.rafHandle);
      this.rafHandle = null;
    }
    if (this.timeoutHandle) {
      clearTimeout(this.timeoutHandle);
      this.timeoutHandle = null;
    }
  }
}
function flushPendingText(session) {
  session = session || getActiveSession();
  if (!session || !session.pendingText) return;

  if (session.streamingRenderer) {
    session.streamingRenderer.skipToEnd();
    session.streamingRenderer.destroy();
    session.streamingRenderer = null;

    // Remove streaming class after finalization
    const streamingEl = session.containerEl?.querySelector('.message.streaming');
    if (streamingEl) {
      streamingEl.classList.remove('streaming');
    }
  } else {
    // Fallback for non-streaming
    const streamingEl = session.containerEl?.querySelector('.message.streaming');
    if (streamingEl) {
      setElementHtml(streamingEl, formatMarkdown(session.pendingText));
      streamingEl.classList.remove('streaming');
    }
  }

  session.pendingText = '';
  session.currentMessageMetadata = null;
}
function updateStreamingMessage(session) {
  session = session || getActiveSession();
  if (!session?.containerEl) return;

  let el = session.containerEl.querySelector('.message.streaming');
  if (!el) {
    el = document.createElement('div');
    el.className = 'message assistant streaming';
    // Attach metadata to the element
    if (session.currentMessageMetadata) {
      el.dataset.timestamp = session.currentMessageMetadata.timestamp || '';
      el.dataset.messageId = session.currentMessageMetadata.messageId || '';
      el.dataset.model = session.currentMessageMetadata.model || '';
    }
    session.containerEl.appendChild(el);
  }
  setElementHtml(el, formatMarkdown(session.pendingText));
  scrollToBottom(session);
}

export { StreamingRenderer, flushPendingText, updateStreamingMessage };
