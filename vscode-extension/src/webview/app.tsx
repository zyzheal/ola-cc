/**
 * Webview App - React frontend running inside VSCode's webview.
 *
 * This file is the entry point for the webview bundle. It renders
 * the chat interface using the VSCode theme colors and communicates
 * with the extension host via the VSCode webview API.
 */

// Get the VSCode API for webview communication
declare function acquireVsCodeApi(): {
  getState(): unknown;
  setState(state: unknown): void;
  postMessage(message: unknown): void;
};

const vscode = acquireVsCodeApi();

// Restore state if available
const state = vscode.getState() as ChatState | null;
let messages: ChatMessage[] = state?.messages || [];
let config: WebviewConfig = state?.config || {};
let activeFileContext: FileContext | null = state?.activeFileContext || null;
let isStreaming = false;

/**
 * Initialize the webview UI.
 */
function init(): void {
  render();
  scrollToBottom();
  setupInputHandlers();
}

/**
 * Handle messages from the extension host.
 */
window.addEventListener('message', (event: MessageEvent) => {
  const message = event.data;

  switch (message.command) {
    case 'add_message':
      messages.push(message.message);
      saveState();
      render();
      scrollToBottom();
      break;

    case 'update_message':
      updateMessage(message.messageId, message.content, message.isStreaming);
      break;

    case 'clear_messages':
      messages = [];
      saveState();
      render();
      break;

    case 'load_history':
      messages = message.messages || [];
      saveState();
      render();
      break;

    case 'update_config':
      config = message.config || {};
      saveState();
      break;

    case 'update_file_context':
      activeFileContext = message.context;
      saveState();
      renderFileContext();
      break;

    case 'focus_input':
      const input = document.getElementById('chat-input') as HTMLTextAreaElement | null;
      input?.focus();
      break;

    case 'error':
      showError(message.message);
      isStreaming = false;
      updateSendButton();
      break;
  }
});

/**
 * Render the chat UI based on current message state.
 */
function render(): void {
  const container = document.getElementById('chat-messages');
  if (!container) return;

  if (messages.length === 0) {
    container.innerHTML = getWelcomeHTML();
    return;
  }

  const html = buildMessagesHTML();
  container.innerHTML = html;
}

/**
 * Build HTML for all messages.
 */
function buildMessagesHTML(): string {
  let html = '';

  for (const msg of messages) {
    if (msg.role === 'user') {
      html += `<div class="message user">${escapeHtml(msg.content)}</div>`;
    } else if (msg.role === 'assistant') {
      html += `<div class="message assistant">`;
      html += renderMarkdown(msg.content);
      if (msg.isStreaming) {
        html += '<span class="typing-indicator">Claude is thinking...</span>';
      }
      if (!msg.isStreaming && msg.content.includes('```')) {
        html += getCodeActionsHTML(msg.id);
      }
      html += '</div>';
    }
  }

  return html;
}

/**
 * Update a specific message by ID.
 */
function updateMessage(messageId: string, content: string, isStreaming: boolean): void {
  const idx = messages.findIndex(m => m.id === messageId);
  if (idx === -1) {
    // New message
    messages.push({
      id: messageId,
      role: 'assistant',
      content,
      timestamp: Date.now(),
      isStreaming,
    });
  } else {
    messages[idx].content = content;
    messages[idx].isStreaming = isStreaming;
  }

  isStreaming = isStreaming;
  saveState();
  render();
  scrollToBottom();
  updateSendButton();
}

/**
 * Send a user message to the extension host.
 */
function sendMessage(content: string): void {
  if (!content.trim() || isStreaming) return;

  vscode.postMessage({
    command: 'user_message',
    content: content,
  });

  // Clear input
  const input = document.getElementById('chat-input') as HTMLTextAreaElement | null;
  if (input) {
    input.value = '';
    resizeInput();
  }
}

/**
 * Show an error message.
 */
function showError(message: string): void {
  const container = document.getElementById('chat-messages');
  if (container) {
    container.innerHTML += `<div class="message error">Error: ${escapeHtml(message)}</div>`;
    scrollToBottom();
  }
}

/**
 * Update the file context badge.
 */
function renderFileContext(): void {
  const badge = document.getElementById('file-context-badge');
  if (!badge) return;

  if (activeFileContext && activeFileContext.path) {
    const filename = activeFileContext.path.split('/').pop() || activeFileContext.path;
    badge.textContent = `Active: ${filename} (${activeFileContext.language})`;
    badge.style.display = 'inline-block';
  } else {
    badge.style.display = 'none';
  }
}

/**
 * Update the send button state.
 */
function updateSendButton(): void {
  const btn = document.getElementById('send-button') as HTMLButtonElement | null;
  if (btn) {
    btn.disabled = isStreaming;
    btn.textContent = isStreaming ? 'Thinking...' : 'Send';
  }
}

/**
 * Scroll the message container to the bottom.
 */
function scrollToBottom(): void {
  const container = document.getElementById('chat-messages');
  if (container) {
    container.scrollTop = container.scrollHeight;
  }
}

/**
 * Save state to VSCode's state persistence.
 */
function saveState(): void {
  vscode.setState({
    messages,
    config,
    activeFileContext,
  });
}

/**
 * Setup input event handlers.
 */
function setupInputHandlers(): void {
  const input = document.getElementById('chat-input') as HTMLTextAreaElement | null;
  const sendBtn = document.getElementById('send-button') as HTMLButtonElement | null;

  // Auto-resize input
  if (input) {
    input.addEventListener('input', resizeInput);

    // Send on Enter (Shift+Enter for newline)
    input.addEventListener('keydown', (e: KeyboardEvent) => {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        handleSend();
      }
    });
  }

  // Send button
  if (sendBtn) {
    sendBtn.addEventListener('click', handleSend);
  }
}

/**
 * Handle send button click or Enter key.
 */
function handleSend(): void {
  const input = document.getElementById('chat-input') as HTMLTextAreaElement | null;
  if (input) {
    sendMessage(input.value);
  }
}

/**
 * Auto-resize the textarea input.
 */
function resizeInput(): void {
  const input = document.getElementById('chat-input') as HTMLTextAreaElement | null;
  if (input) {
    input.style.height = 'auto';
    input.style.height = Math.min(input.scrollHeight, 150) + 'px';
  }
}

// ---- HTML Generation ----

/**
 * Get the welcome screen HTML.
 */
function getWelcomeHTML(): string {
  return `
    <div class="welcome-screen">
      <h2>Claude Code</h2>
      <p>Your AI coding assistant, built into VSCode</p>
      <p style="font-size: 12px; margin-top: 8px;">Ask me anything about your code</p>
      <div class="suggestions">
        <button class="suggestion-btn" onclick="sendSuggestion('Explain this file')">Explain this file</button>
        <button class="suggestion-btn" onclick="sendSuggestion('Find bugs in my code')">Find bugs</button>
        <button class="suggestion-btn" onclick="sendSuggestion('Write tests')">Write tests</button>
        <button class="suggestion-btn" onclick="sendSuggestion('Improve performance')">Improve performance</button>
      </div>
    </div>`;
}

// Make sendSuggestion available globally
(window as unknown as Record<string, unknown>).sendSuggestion = function(text: string) {
  sendMessage(text);
};

/**
 * Get action buttons for assistant messages with code.
 */
function getCodeActionsHTML(messageId: string): string {
  return `
    <div class="code-actions">
      <button class="action-btn" onclick="applyCode('${messageId}')">Apply to Editor</button>
      <button class="action-btn" onclick="copyCode('${messageId}')">Copy Code</button>
    </div>`;
}

/**
 * Apply code to the active editor.
 */
(window as unknown as Record<string, unknown>).applyCode = function(messageId: string) {
  const msg = messages.find(m => m.id === messageId);
  if (msg) {
    const code = extractCodeBlocks(msg.content);
    vscode.postMessage({ command: 'apply_to_editor', content: code });
  }
};

/**
 * Copy code to clipboard.
 */
(window as unknown as Record<string, unknown>).copyCode = function(messageId: string) {
  const msg = messages.find(m => m.id === messageId);
  if (msg) {
    const code = extractCodeBlocks(msg.content);
    vscode.postMessage({ command: 'copy_to_clipboard', content: code });
  }
};

/**
 * Extract code blocks from markdown content.
 */
function extractCodeBlocks(content: string): string {
  const match = content.match(/```[\w]*\n([\s\S]*?)```/);
  return match ? match[1] : content;
}

/**
 * Render markdown-like content as HTML.
 */
function renderMarkdown(text: string): string {
  if (!text) return '';

  // Escape HTML first
  let html = escapeHtml(text);

  // Code blocks (must come before inline code)
  html = html.replace(/```(\w+)?\n([\s\S]*?)```/g, '<pre><code class="lang-$1">$2</code></pre>');

  // Inline code
  html = html.replace(/`([^`]+)`/g, '<code>$1</code>');

  // Bold
  html = html.replace(/\*\*([^\*]+)\*\*/g, '<strong>$1</strong>');

  // Italic
  html = html.replace(/\*([^\*]+)\*/g, '<em>$1</em>');

  // Links
  html = html.replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2" target="_blank">$1</a>');

  // Line breaks
  html = html.replace(/\n\n/g, '</p><p>');
  html = html.replace(/\n/g, '<br>');

  return '<p>' + html + '</p>';
}

/**
 * Escape HTML special characters.
 */
function escapeHtml(text: string): string {
  const div = document.createElement('div');
  div.textContent = text;
  return div.innerHTML;
}

// ---- Types ----

interface ChatMessage {
  id: string;
  role: 'user' | 'assistant' | 'system';
  content: string;
  timestamp: number;
  isStreaming?: boolean;
}

interface ChatState {
  messages: ChatMessage[];
  config: WebviewConfig;
  activeFileContext: FileContext | null;
}

interface WebviewConfig {
  showThinking?: boolean;
  model?: string;
}

interface FileContext {
  path: string;
  language: string;
  text: string;
  selection: unknown;
}

// Initialize on load
init();
