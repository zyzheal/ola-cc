/**
 * Webview App - React frontend mounted inside VSCode's webview.
 *
 * This file is the entry point for the webview bundle. It renders
 * the chat interface using the VSCode theme colors and communicates
 * with the extension host via the VSCode webview API.
 */
import { marked } from 'marked';

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
let connectionStatus: 'connected' | 'disconnected' | 'configuring' = 'connected';
let workspaceName = '';
let inputHandlersBound = false;
let sessionRestored = state?.messages?.length > 0 || false;
let draggedFilePath = '';
let attachedFiles: Array<{name: string; content: string; language: string; type: string}> = [];

/**
 * Initialize the webview UI.
 */
function init(): void {
  renderInputArea();
  render();
  scrollToBottom();
  setupDragDrop();
  setupBackToTop();
  setupKeyboardShortcuts();
  if (sessionRestored) {
    showSessionRestoreBanner();
    sessionRestored = false;
  }
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

    case 'tool_start':
      showToolCard(message.toolUseId, message.toolName, message.input, 'running');
      break;
    case 'tool_complete':
      updateToolCard(message.toolUseId, message.toolName, message.result, 'complete');
      break;
    case 'tool_error':
      updateToolCard(message.toolUseId, message.toolName, message.error, 'error');
      break;
    case 'tool_requires_confirmation':
      showConfirmationDialog(message.toolUseId, message.toolName, message.input);
      break;
    case 'tool_confirmation_request':
      showConfirmationDialog(message.toolUseId, message.toolName, message.input);
      break;
    case 'agent_iteration':
      updateAgentProgress(message.current, message.max);
      break;
    case 'agent_done':
      hideAgentProgress();
      isStreaming = false;
      updateSendButton();
      break;

    case 'connection_status':
      connectionStatus = message.status || 'connected';
      updateConnectionStatus();
      break;

    case 'workspace_info':
      workspaceName = message.workspaceName || '';
      renderWelcomeOrHeader();
      break;

    case 'file_attached':
      attachedFiles.push({
        name: message.fileName || 'unknown',
        content: message.content || '',
        language: message.language || '',
        type: message.fileType || 'file',
      });
      updateAttachBadge();
      break;
  }
});

/**
 * Render the chat UI based on current message state.
 */
function render(): void {
  renderWelcomeOrHeader();
  renderMessages();
  renderFileContext();
  if (!inputHandlersBound) {
    setupInputHandlers();
    inputHandlersBound = true;
  }
}

/**
 * Render the header/welcome area.
 */
function renderWelcomeOrHeader(): void {
  const container = document.getElementById('chat-messages');
  if (!container) return;

  // Ensure header exists
  let header = document.getElementById('chat-header');
  if (!header) {
    header = document.createElement('div');
    header.id = 'chat-header';
    header.className = 'chat-header';
    header.innerHTML = `
      <div class="header-left">
        <span class="connection-status" id="connection-status"></span>
        <span class="header-title">Claude Code</span>
      </div>
      <div class="header-center">
        <input type="text" id="search-input" class="search-input" placeholder="Search messages... (Ctrl+F)" />
      </div>
      <div class="header-right">
        <button class="header-btn" id="export-btn" title="Export Chat">
          <span class="codicon codicon-download"></span>
        </button>
        <button class="header-btn" id="new-chat-btn" title="New Chat">
          <span class="codicon codicon-add"></span>
        </button>
      </div>
    `;
    container.parentElement?.insertBefore(header, container);

    document.getElementById('new-chat-btn')?.addEventListener('click', () => {
      vscode.postMessage({ command: 'new_chat' });
    });

    document.getElementById('export-btn')?.addEventListener('click', () => {
      (window as unknown as Record<string, unknown>).exportChat();
    });

    document.getElementById('search-input')?.addEventListener('input', (e: Event) => {
      const target = e.target as HTMLInputElement;
      (window as unknown as Record<string, unknown>).searchMessages(target.value);
    });
  }

  updateConnectionStatus();

  if (messages.length === 0) {
    container.innerHTML = getWelcomeHTML();
  }
}

/**
 * Render the input area (textarea + send button + file context badge).
 */
function renderInputArea(): void {
  const root = document.getElementById('root');
  if (!root || root.querySelector('.chat-input-container')) return;

  // Hidden file input
  const fileInput = document.createElement('input');
  fileInput.type = 'file';
  fileInput.id = 'file-attach-input';
  fileInput.style.display = 'none';
  fileInput.multiple = true;
  fileInput.onchange = () => handleFileSelect(fileInput.files);
  root.appendChild(fileInput);

  const container = document.createElement('div');
  container.className = 'chat-input-container';
  container.innerHTML = `
    <textarea id="chat-input" class="chat-input" placeholder="Type a message..."></textarea>
    <div style="display:flex;justify-content:space-between;align-items:center;margin-top:4px;">
      <div id="file-context-badge" style="display:none;"></div>
      <div style="display:flex;align-items:center;gap:4px;">
        <span id="attach-badge" style="display:none;font-size:11px;color:var(--vscode-descriptionForeground);"></span>
        <button id="attach-btn" class="header-btn" title="Attach file">&#128206;</button>
        <button id="send-button" class="send-button">Send</button>
      </div>
    </div>
  `;
  root.appendChild(container);

  // Attach button click handler
  document.getElementById('attach-btn')?.addEventListener('click', () => {
    document.getElementById('file-attach-input')?.click();
  });
}

/**
 * Handle file selection from file picker or drag-drop (local files).
 */
async function handleFileSelect(files: FileList | null): Promise<void> {
  if (!files || files.length === 0) return;

  for (const file of Array.from(files)) {
    const content = await file.text();
    const ext = file.name.split('.').pop() || '';
    attachedFiles.push({
      name: file.name,
      content,
      language: ext,
      type: file.type.startsWith('image/') ? 'image' : 'file',
    });
  }
  updateAttachBadge();
}

/**
 * Update the attachment badge to show count of attached files.
 */
function updateAttachBadge(): void {
  const badge = document.getElementById('attach-badge');
  if (!badge) return;

  if (attachedFiles.length > 0) {
    const names = attachedFiles.map(f => f.name).join(', ');
    badge.textContent = `${attachedFiles.length} attached: ${names}`;
    badge.style.display = 'inline';
    badge.title = names;
  } else {
    badge.style.display = 'none';
  }
}

/**
 * Clear attached files (called after sending message).
 */
function clearAttachedFiles(): void {
  attachedFiles = [];
  updateAttachBadge();
}

/**
 * Render messages in the chat container.
 */
function renderMessages(): void {
  const container = document.getElementById('chat-messages');
  if (!container) return;

  // Ensure messages-container exists
  let msgContainer = document.getElementById('messages-container');
  if (!msgContainer) {
    msgContainer = document.createElement('div');
    msgContainer.id = 'messages-container';
    msgContainer.className = 'messages-container';
    container.appendChild(msgContainer);
  }

  if (messages.length === 0) {
    // Welcome screen is handled by renderWelcomeOrHeader
    msgContainer.innerHTML = '';
    return;
  }

  const html = buildMessagesHTML();
  msgContainer.innerHTML = html;
}

/**
 * Build HTML for all messages.
 */
function buildMessagesHTML(): string {
  let html = '';

  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i];
    if (msg.role === 'user') {
      html += `<div class="message user">
        <div class="message-actions">
          <button class="message-action-btn" onclick="copyMessage('${msg.id}')">Copy</button>
          <button class="message-action-btn" onclick="quoteMessage('${msg.id}')">Quote</button>
        </div>
        ${escapeHtml(msg.content)}
      </div>`;
    } else if (msg.role === 'assistant') {
      // Use displayText if available (content may be ContentBlock[])
      const displayContent = msg.displayText ?? msg.content;
      const contentHtml = renderMarkdown(displayContent);
      const shouldCollapse = contentHtml.length > 2000;
      const collapseId = `collapse-${msg.id}`;
      const toggleId = `toggle-${msg.id}`;

      html += `<div class="message assistant">
        <div class="message-actions">
          <button class="message-action-btn" onclick="copyMessage('${msg.id}')">Copy</button>
        </div>`;

      if (shouldCollapse) {
        html += `<button class="toggle-collapse-btn" id="${toggleId}" onclick="toggleCollapse('${toggleId}', '${collapseId}')">Show more</button>`;
        html += `<div class="collapsible-content collapsed" id="${collapseId}">`;
        html += contentHtml.substring(0, 500) + '...';
        html += `</div>`;
        html += `<div class="collapsible-content hidden" id="${collapseId}-full">`;
        html += contentHtml;
        html += `</div>`;
      } else {
        html += contentHtml;
      }

      if (msg.isStreaming) {
        html += '<span class="typing-indicator">Claude is thinking...</span>';
      }
      html += '</div>';
    }
  }

  return html;
}

/**
 * Update a specific message by ID.
 */
function updateMessage(messageId: string, content: string, streaming: boolean): void {
  const idx = messages.findIndex(m => m.id === messageId);
  if (idx === -1) {
    // New message
    messages.push({
      id: messageId,
      role: 'assistant',
      content,
      timestamp: Date.now(),
      isStreaming: streaming,
    });
  } else {
    messages[idx].content = content;
    messages[idx].isStreaming = streaming;
  }

  isStreaming = streaming;
  saveState();
  renderMessages();
  scrollToBottom();
  updateSendButton();
}

/**
 * Send a user message to the extension host.
 */
function sendMessage(content: string): void {
  if (!content.trim() || isStreaming) return;

  const msg: Record<string, unknown> = {
    command: 'user_message',
    content: content,
  };

  // Include attached files if any
  if (attachedFiles.length > 0) {
    msg.attachments = attachedFiles.map(f => ({
      name: f.name,
      content: f.content,
      language: f.language,
      type: f.type,
    }));
    clearAttachedFiles();
  }

  vscode.postMessage(msg);

  // Reset history navigation
  historyIndex = -1;

  // Clear input
  const input = document.getElementById('chat-input') as HTMLTextAreaElement | null;
  if (input) {
    input.value = '';
    resizeInput();
  }
}

/**
 * Stop the current streaming response.
 */
function stopStreaming(): void {
  vscode.postMessage({ command: 'stop_generation' });
  isStreaming = false;
  updateSendButton();
}

/**
 * Show an error message.
 */
function showError(message: string): void {
  const container = document.getElementById('chat-messages');
  if (container) {
    const errorHtml = `
      <div class="message error">
        <span>Error: ${escapeHtml(message)}</span>
        <button class="retry-btn" onclick="retryLastMessage()">Retry</button>
      </div>`;
    container.insertAdjacentHTML('beforeend', errorHtml);
    scrollToBottom();
  }
}

/**
 * Retry the last user message.
 */
(window as unknown as Record<string, unknown>).retryLastMessage = function() {
  // Find the last user message
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].role === 'user') {
      sendMessage(messages[i].content);
      // Remove the error message
      const container = document.getElementById('chat-messages');
      if (container) {
        const errorEl = container.querySelector('.message.error');
        errorEl?.remove();
      }
      return;
    }
  }
};

/**
 * Update the file context badge.
 */
function renderFileContext(): void {
  const badge = document.getElementById('file-context-badge');
  if (!badge) return;

  if (activeFileContext && activeFileContext.path) {
    const filename = activeFileContext.path.split('/').pop() || activeFileContext.path;
    badge.innerHTML = `
      <span class="badge-text">Active: ${escapeHtml(filename)} (${escapeHtml(activeFileContext.language)})</span>
      <span class="badge-close" onclick="clearFileContext()" title="Clear file context">&times;</span>
    `;
    badge.style.display = 'inline-flex';
  } else {
    badge.style.display = 'none';
  }
}

/**
 * Clear the file context.
 */
(window as unknown as Record<string, unknown>).clearFileContext = function() {
  vscode.postMessage({ command: 'clear_file_context' });
  activeFileContext = null;
  saveState();
  renderFileContext();
};

/**
 * Update the connection status indicator.
 */
function updateConnectionStatus(): void {
  const el = document.getElementById('connection-status');
  if (!el) return;

  el.className = `connection-status status-${connectionStatus}`;
  el.title = connectionStatus === 'connected' ? 'Connected'
    : connectionStatus === 'disconnected' ? 'Disconnected'
    : 'Configuring...';
}

/**
 * Update the send button state.
 */
function updateSendButton(): void {
  const btn = document.getElementById('send-button') as HTMLButtonElement | null;
  if (btn) {
    btn.disabled = false;
    if (isStreaming) {
      btn.textContent = 'Stop';
      btn.className = 'send-button stop-button';
      btn.onclick = () => stopStreaming();
    } else {
      btn.textContent = 'Send';
      btn.className = 'send-button';
      btn.onclick = () => handleSend();
    }
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

  // Send button - handler is set dynamically by updateSendButton()
  if (sendBtn) {
    sendBtn.onclick = () => handleSend();
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

// ---- Message Actions ----

/**
 * Copy a message content to clipboard.
 */
(window as unknown as Record<string, unknown>).copyMessage = function(messageId: string) {
  const msg = messages.find(m => m.id === messageId);
  if (msg) {
    vscode.postMessage({ command: 'copy_to_clipboard', content: msg.content });
  }
};

/**
 * Quote a message in the input (prefix with >).
 */
(window as unknown as Record<string, unknown>).quoteMessage = function(messageId: string) {
  const msg = messages.find(m => m.id === messageId);
  if (msg) {
    const input = document.getElementById('chat-input') as HTMLTextAreaElement | null;
    if (input) {
      const quoteLines = msg.content.split('\n').map(line => `> ${line}`).join('\n');
      input.value = input.value ? input.value + '\n\n' + quoteLines : quoteLines;
      input.focus();
      resizeInput();
    }
  }
};

/**
 * Toggle collapse state for long messages.
 */
(window as unknown as Record<string, unknown>).toggleCollapse = function(toggleId: string, contentId: string) {
  const toggleBtn = document.getElementById(toggleId);
  const collapsedEl = document.getElementById(contentId);
  const fullEl = document.getElementById(contentId + '-full');

  if (!collapsedEl || !fullEl || !toggleBtn) return;

  const isCollapsed = collapsedEl.style.display === 'none' || collapsedEl.classList.contains('collapsed');
  if (isCollapsed) {
    collapsedEl.style.display = 'none';
    fullEl.style.display = 'block';
    toggleBtn.textContent = 'Show less';
  } else {
    collapsedEl.style.display = 'block';
    fullEl.style.display = 'none';
    toggleBtn.textContent = 'Show more';
  }
};

// ---- Drag & Drop Support ----

/**
 * Setup drag and drop handlers for the input area.
 */
function setupDragDrop(): void {
  const inputContainer = document.querySelector('.chat-input-container');
  const input = document.getElementById('chat-input');

  if (!inputContainer || !input) return;

  inputContainer.addEventListener('dragover', (e: DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    inputContainer.classList.add('drag-over');
  });

  inputContainer.addEventListener('dragleave', (e: DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    inputContainer.classList.remove('drag-over');
  });

  inputContainer.addEventListener('drop', async (e: DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    inputContainer.classList.remove('drag-over');

    const files = e.dataTransfer?.files;
    if (files && files.length > 0) {
      for (const file of Array.from(files)) {
        const filePath = (file as any).path;
        if (filePath) {
          // Send file path to extension host for reading
          vscode.postMessage({ command: 'read_and_attach_file', path: filePath });
        }
      }
    }
  });
}

// ---- Back to Top Button ----

let backToTopSetup = false;

/**
 * Create and manage the back-to-top button.
 */
function setupBackToTop(): void {
  if (backToTopSetup) return;
  const container = document.getElementById('chat-messages');
  if (!container) return;

  const btn = document.createElement('button');
  btn.id = 'back-to-top-btn';
  btn.className = 'back-to-top-btn';
  btn.innerHTML = '&#9650;';
  btn.title = 'Back to top';
  btn.onclick = () => {
    container.scrollTo({ top: 0, behavior: 'smooth' });
  };
  container.parentElement?.appendChild(btn);

  container.addEventListener('scroll', () => {
    if (container.scrollTop > 300) {
      btn.classList.add('visible');
    } else {
      btn.classList.remove('visible');
    }
  });

  backToTopSetup = true;
}

// ---- Session Restore Banner ----

/**
 * Show a banner when session is restored from previous conversation.
 */
function showSessionRestoreBanner(): void {
  if (!sessionRestored) return;

  const container = document.getElementById('chat-messages');
  if (!container) return;

  const banner = document.createElement('div');
  banner.className = 'session-restore-banner';
  banner.innerHTML = `
    <span>Previous session restored. Showing ${messages.length} messages from last conversation.</span>
    <span class="dismiss-banner" onclick="dismissBanner(this)">&times;</span>
  `;
  container.parentElement?.insertBefore(banner, container);

  // Auto-dismiss after 5 seconds
  setTimeout(() => {
    banner.remove();
  }, 5000);
}

(window as unknown as Record<string, unknown>).dismissBanner = function(el: HTMLElement) {
  el.parentElement?.remove();
};

// ---- HTML Generation ----

/**
 * Get the welcome screen HTML.
 */
function getWelcomeHTML(): string {
  const workspaceLabel = workspaceName ? `Workspace: ${escapeHtml(workspaceName)}` : '';
  const fileSuggestion = activeFileContext?.path
    ? `Explain ${escapeHtml(activeFileContext.path.split('/').pop() || 'file')}`
    : 'Explain this file';

  return `
    <div class="welcome-screen">
      <h2>Claude Code</h2>
      ${workspaceLabel ? `<p class="workspace-label">${workspaceLabel}</p>` : ''}
      <p style="font-size: 12px; margin-top: 8px;">Your AI coding assistant, built into VSCode</p>
      <div class="suggestions">
        <button class="suggestion-btn" onclick="sendSuggestion('${escapeForAttr(fileSuggestion)}')">${escapeHtml(fileSuggestion)}</button>
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

// Make tool approval/denial and cancel available for inline onclick
(window as unknown as Record<string, unknown>).approveTool = approveTool;
(window as unknown as Record<string, unknown>).denyTool = denyTool;
(window as unknown as Record<string, unknown>).cancelAgentLoop = cancelAgentLoop;

/**
 * Copy code to clipboard from a code block.
 */
(window as unknown as Record<string, unknown>).copyCodeBlock = function(blockId: string) {
  const block = document.getElementById(blockId);
  if (block) {
    const code = block.textContent || '';
    vscode.postMessage({ command: 'copy_to_clipboard', content: code });
    // Visual feedback
    const btn = block.parentElement?.querySelector('.copy-code-btn');
    if (btn) {
      const originalText = btn.textContent;
      btn.textContent = 'Copied!';
      setTimeout(() => { btn.textContent = originalText; }, 1500);
    }
  }
};

/**
 * Export chat to markdown file.
 */
(window as unknown as Record<string, unknown>).exportChat = function() {
  const markdown = messages.map(msg => {
    const role = msg.role === 'user' ? '**You**' : '**Claude**';
    return `${role}:\n\n${msg.content}\n\n---\n`;
  }).join('\n');

  vscode.postMessage({ command: 'export_chat', content: markdown });
};

/**
 * Search/filter messages by keyword.
 */
(window as unknown as Record<string, unknown>).searchMessages = function(query: string) {
  const container = document.getElementById('messages-container');
  if (!container) return;

  if (!query.trim()) {
    renderMessages();
    return;
  }

  const lowerQuery = query.toLowerCase();
  const messageEls = container.querySelectorAll('.message');
  messageEls.forEach(el => {
    const text = el.textContent?.toLowerCase() || '';
    el.style.display = text.includes(lowerQuery) ? '' : 'none';
  });
};

/**
 * Run code block in terminal (send to extension host).
 */
(window as unknown as Record<string, unknown>).runCodeBlock = function(blockId: string) {
  const block = document.getElementById(blockId);
  if (block) {
    const code = block.textContent || '';
    vscode.postMessage({ command: 'run_in_terminal', content: code });
  }
};

// ---- Keyboard Shortcuts ----

/**
 * Setup global keyboard shortcuts.
 */
function setupKeyboardShortcuts(): void {
  document.addEventListener('keydown', (e: KeyboardEvent) => {
    // Ctrl/Cmd + K: Focus input
    if ((e.ctrlKey || e.metaKey) && e.key === 'k') {
      e.preventDefault();
      const input = document.getElementById('chat-input') as HTMLTextAreaElement | null;
      input?.focus();
    }
    // Ctrl/Cmd + E: Export chat
    if ((e.ctrlKey || e.metaKey) && e.key === 'e') {
      e.preventDefault();
      (window as unknown as Record<string, unknown>).exportChat();
    }
    // Ctrl/Cmd + F: Focus search
    if ((e.ctrlKey || e.metaKey) && e.key === 'f') {
      const searchInput = document.getElementById('search-input') as HTMLInputElement | null;
      if (searchInput) {
        e.preventDefault();
        searchInput.focus();
      }
    }
    // Escape: Clear search
    if (e.key === 'Escape') {
      const searchInput = document.getElementById('search-input') as HTMLInputElement | null;
      if (searchInput && searchInput.value) {
        searchInput.value = '';
        renderMessages();
      }
    }
    // Arrow Up/Down in input: Navigate message history
    const input = document.getElementById('chat-input') as HTMLTextAreaElement | null;
    if (input && document.activeElement === input) {
      if (e.key === 'ArrowUp' && input.selectionStart === 0) {
        e.preventDefault();
        navigateHistory(-1);
      } else if (e.key === 'ArrowDown' && input.selectionStart === input.value.length) {
        e.preventDefault();
        navigateHistory(1);
      }
    }
  });
}

// ---- Message History Navigation ----

let historyIndex = -1;
let userMessages: ChatMessage[] = [];

/**
 * Navigate through user message history.
 */
function navigateHistory(direction: number): void {
  userMessages = messages.filter(m => m.role === 'user');
  if (userMessages.length === 0) return;

  historyIndex += direction;
  historyIndex = Math.max(-1, Math.min(historyIndex, userMessages.length - 1));

  const input = document.getElementById('chat-input') as HTMLTextAreaElement | null;
  if (!input) return;

  if (historyIndex === -1) {
    input.value = '';
  } else {
    input.value = userMessages[historyIndex].content;
  }
  resizeInput();
}

let codeBlockCounter = 0;

// Cached marked renderer for performance
const cachedRenderer = new marked.Renderer();
cachedRenderer.code = (code: string | { text: string; lang?: string; escaped?: boolean }, language?: string) => {
  const text = typeof code === 'string' ? code : code.text;
  const lang = typeof code === 'string' ? language : (code as { lang?: string }).lang;
  const blockId = `code-${Date.now()}-${codeBlockCounter++}`;

  let highlighted = escapeHtml(text);
  if (lang && typeof (window as any).hljs !== 'undefined') {
    const hljs = (window as any).hljs;
    if (hljs.getLanguage(lang)) {
      highlighted = hljs.highlight(text, { language: lang }).value;
    }
  }

  const langLabel = lang ? `<span class="code-lang">${escapeHtml(lang)}</span>` : '';
  const runnableLangs = ['javascript', 'typescript', 'python', 'bash', 'sh', 'shell', 'node'];
  const isRunnable = lang && runnableLangs.includes(lang.toLowerCase());
  const runBtn = isRunnable ? `<button class="run-code-btn" onclick="runCodeBlock('${blockId}')">Run</button>` : '';

  return `<div class="code-block-wrapper">
    <div class="code-block-header">
      ${langLabel}
      <div class="code-actions">
        ${runBtn}
        <button class="copy-code-btn" onclick="copyCodeBlock('${blockId}')">Copy</button>
      </div>
    </div>
    <pre><code id="${blockId}" class="hljs language-${escapeHtml(lang || '')}">${highlighted}</code></pre>
  </div>`;
};

cachedRenderer.link = (href: string | { href: string; title?: string; text: string }, title?: string, text?: string) => {
  const url = typeof href === 'string' ? href : href.href;
  const titleAttr = typeof href === 'string' ? title : (href as { title?: string }).title;
  const linkText = typeof href === 'string' ? text : (href as { text: string }).text;
  const titleHtml = titleAttr ? ` title="${escapeForAttr(titleAttr)}"` : '';
  return `<a href="${escapeForAttr(url)}" target="_blank" rel="noopener noreferrer"${titleHtml}>${linkText}</a>`;
};

/**
 * Render markdown content using the marked library.
 */
function renderMarkdown(text: string): string {
  if (!text) return '';

  codeBlockCounter = 0; // Reset counter for each render pass

  const html = marked.parse(text, {
    renderer: cachedRenderer,
    breaks: true,
    gfm: true,
  });

  return html as string;
}

/**
 * Escape HTML special characters.
 */
function escapeHtml(text: string): string {
  const div = document.createElement('div');
  div.textContent = text;
  return div.innerHTML;
}

/**
 * Escape a string for use in an HTML attribute.
 */
function escapeForAttr(text: string): string {
  return text
    .replace(/\\/g, '\\\\')
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/`/g, '\\`');
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

/**
 * Send messages from webview to extension host.
 */
function approveTool(toolUseId: string, toolName: string): void {
  (window as any).vscode.postMessage({ command: 'tool_approve', toolUseId, toolName });
}

function denyTool(toolUseId: string, toolName: string): void {
  (window as any).vscode.postMessage({ command: 'tool_deny', toolUseId, toolName });
}

function cancelAgentLoop(): void {
  (window as any).vscode.postMessage({ command: 'cancel_agent_loop' });
}

/**
 * Show a tool execution card in the chat.
 */
function showToolCard(toolUseId: string | undefined, toolName: string, input: unknown, state: 'running' | 'complete' | 'error'): void {
  const container = document.getElementById('chat-messages');
  if (!container) return;

  const card = document.createElement('div');
  card.className = `tool-card ${state}`;
  card.id = `tool-${toolUseId || toolName}-${Date.now()}`;

  const statusText = state === 'running' ? 'Running...' : state === 'complete' ? 'Complete' : 'Error';
  card.innerHTML = `
    <div class="tool-header">
      <span class="tool-name">${escapeHtml(toolName)}</span>
      <span class="tool-status">${statusText}</span>
    </div>
    <div class="tool-details">${escapeHtml(JSON.stringify(input, null, 2))}</div>
  `;

  container.appendChild(card);
  scrollToBottom();
}

/**
 * Update an existing tool card with result.
 */
function updateToolCard(_toolUseId: string | undefined, toolName: string, result: unknown, state: 'complete' | 'error'): void {
  const cards = document.querySelectorAll('.tool-card.running');
  for (const card of cards) {
    if (card.querySelector('.tool-name')?.textContent === toolName) {
      card.className = `tool-card ${state}`;
      const statusEl = card.querySelector('.tool-status');
      if (statusEl) statusEl.textContent = state === 'complete' ? 'Complete' : 'Error';
      const detailsEl = card.querySelector('.tool-details');
      if (detailsEl) detailsEl.textContent = typeof result === 'string' ? result : JSON.stringify(result, null, 2);
      break;
    }
  }
  scrollToBottom();
}

/**
 * Update agent loop progress bar.
 */
function updateAgentProgress(current: number, max: number): void {
  let bar = document.getElementById('agent-progress-bar');
  if (!bar) {
    const container = document.getElementById('chat-messages');
    if (!container) return;
    const pct = max > 0 ? (current / max) * 100 : 0;
    bar = document.createElement('div');
    bar.id = 'agent-progress-bar';
    bar.className = 'agent-progress';
    bar.innerHTML = `<span>Agent loop: ${current}/${max}</span><div class="agent-progress-bar"><div class="agent-progress-fill" id="agent-progress-fill" style="width:${pct}%"></div></div><button class="cancel-btn" onclick="cancelAgentLoop()">Cancel</button>`;
    container.appendChild(bar);
  } else {
    bar.querySelector('span')!.textContent = `Agent loop: ${current}/${max}`;
    const fill = document.getElementById('agent-progress-fill');
    const pct = max > 0 ? (current / max) * 100 : 0;
    if (fill) fill.style.width = `${pct}%`;
  }
  scrollToBottom();
}

/**
 * Hide the agent loop progress bar.
 */
function hideAgentProgress(): void {
  const bar = document.getElementById('agent-progress-bar');
  if (bar) bar.remove();
}

/**
 * Show a confirmation dialog for tool execution.
 */
function showConfirmationDialog(toolUseId: string, toolName: string, input: unknown): void {
  const container = document.getElementById('chat-messages');
  if (!container) return;

  const dialog = document.createElement('div');
  dialog.className = 'confirmation-dialog';
  dialog.id = `confirm-${toolUseId}`;
  const escapedToolUseId = escapeForAttr(toolUseId);
  const escapedToolName = escapeForAttr(toolName);
  dialog.innerHTML = `
    <div><strong>Tool requires confirmation:</strong> ${escapeHtml(toolName)}</div>
    <div class="tool-details">${escapeHtml(JSON.stringify(input, null, 2))}</div>
    <div class="confirmation-buttons">
      <button class="btn-approve" onclick="approveTool('${escapedToolUseId}', '${escapedToolName}')">Approve</button>
      <button class="btn-deny" onclick="denyTool('${escapedToolUseId}', '${escapedToolName}')">Deny</button>
    </div>
  `;
  container.appendChild(dialog);
  scrollToBottom();
}

// Initialize on load
init();
