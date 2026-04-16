/**
 * ChatPanel - Manages the VSCode webview for Claude Code chat.
 *
 * This class handles the lifecycle of the webview panel, message passing
 * between VSCode and the webview, and integration with the Claude API.
 *
 * The webview renders a chat interface that mirrors the CLI experience,
 * with streaming responses and support for code blocks, markdown, etc.
 */
import * as vscode from 'vscode';
import * as path from 'path';
import { StatusBarManager } from '../utils/StatusBarManager';
import { ClaudeClient } from '../utils/ClaudeClient';

/** Message types for VSCode <-> Webview communication */
interface WebviewMessage {
  command: string;
  [key: string]: unknown;
}

interface UserMessageData {
  type: 'user_message';
  content: string;
  context?: {
    language: string;
    text: string;
    path: string;
    selection: unknown;
  };
}

/**
 * ChatPanel manages a VSCode webview that displays the Claude chat interface.
 */
export class ChatPanel {
  private panel: vscode.WebviewPanel | undefined;
  private client: ClaudeClient;
  private statusBar: StatusBarManager;
  private context: vscode.ExtensionContext;
  private messageHistory: ChatMessage[] = [];
  private activeFileContext: FileContext | null = null;
  private isStreaming = false;

  constructor(context: vscode.ExtensionContext, statusBar: StatusBarManager) {
    this.context = context;
    this.statusBar = statusBar;
    this.client = new ClaudeClient();
  }

  /**
   * Show the chat panel, creating it if it doesn't exist.
   */
  async show(): Promise<void> {
    if (this.panel) {
      this.panel.reveal(vscode.ViewColumn.Two);
      return;
    }

    // Create the webview panel
    this.panel = vscode.window.createWebviewPanel(
      'claudeChat',
      'Claude Code',
      vscode.ViewColumn.Two,
      {
        enableScripts: true,
        retainContextWhenHidden: true,
        localResourceRoots: [
          vscode.Uri.file(path.join(this.context.extensionPath, 'dist', 'webview')),
        ],
      }
    );

    this.panel.webview.html = this.getWebviewHtml();

    // Handle messages from the webview
    this.panel.webview.onDidReceiveMessage(
      async (message: WebviewMessage) => {
        await this.handleWebviewMessage(message);
      },
      undefined,
      this.context.subscriptions
    );

    // Handle panel disposal
    this.panel.onDidDispose(
      () => {
        this.panel = undefined;
        this.statusBar.updateStatus('idle');
      },
      undefined,
      this.context.subscriptions
    );

    // Send initial config to webview
    this.sendConfigToWebview();
    this.sendHistoryToWebview();
  }

  /**
   * Send a message to Claude and stream the response.
   */
  async sendMessage(data: UserMessageData): Promise<void> {
    if (this.isStreaming) {
      return; // Ignore if already streaming
    }

    // Add user message to history
    const userMsg: ChatMessage = {
      id: generateId(),
      role: 'user',
      content: data.content,
      timestamp: Date.now(),
    };
    this.messageHistory.push(userMsg);
    this.postMessageToWebview({
      command: 'add_message',
      message: userMsg,
    });

    // Build messages array for API
    const apiMessages = this.buildApiMessages(data);

    // Start streaming response
    this.isStreaming = true;
    this.statusBar.updateStatus('streaming');

    const assistantMsgId = generateId();
    let fullContent = '';

    try {
      await this.client.streamCompletion(apiMessages, {
        onChunk: (chunk: string) => {
          fullContent += chunk;
          this.postMessageToWebview({
            command: 'update_message',
            messageId: assistantMsgId,
            content: fullContent,
            isStreaming: true,
          });
        },
        onComplete: () => {
          const assistantMsg: ChatMessage = {
            id: assistantMsgId,
            role: 'assistant',
            content: fullContent,
            timestamp: Date.now(),
          };
          this.messageHistory.push(assistantMsg);
          this.postMessageToWebview({
            command: 'update_message',
            messageId: assistantMsgId,
            content: fullContent,
            isStreaming: false,
          });
          this.isStreaming = false;
          this.statusBar.updateStatus('idle');
        },
        onError: (error: Error) => {
          this.postMessageToWebview({
            command: 'error',
            message: error.message,
          });
          this.isStreaming = false;
          this.statusBar.updateStatus('error');
        },
      });
    } catch (error) {
      this.isStreaming = false;
      this.statusBar.updateStatus('error');
      this.postMessageToWebview({
        command: 'error',
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }

  /**
   * Clear the chat history.
   */
  clearChat(): void {
    this.messageHistory = [];
    this.postMessageToWebview({
      command: 'clear_messages',
    });
  }

  /**
   * Focus the chat input in the webview.
   */
  focusInput(): void {
    this.postMessageToWebview({
      command: 'focus_input',
    });
  }

  /**
   * Update the active file context when the user switches files.
   */
  updateActiveFileContext(context: FileContext): void {
    this.activeFileContext = context;
    this.postMessageToWebview({
      command: 'update_file_context',
      context,
    });
  }

  /**
   * Handle configuration changes.
   */
  onConfigChanged(): void {
    this.client.onConfigChanged();
    this.sendConfigToWebview();
  }

  /**
   * Dispose of the chat panel.
   */
  dispose(): void {
    this.panel?.dispose();
    this.client.dispose();
  }

  // -----------------------------------------------------------------------
  // Private helpers
  // -----------------------------------------------------------------------

  /**
   * Handle incoming messages from the webview.
   */
  private async handleWebviewMessage(message: WebviewMessage): Promise<void> {
    switch (message.command) {
      case 'user_message':
        await this.sendMessage({
          type: 'user_message',
          content: message.content as string,
        });
        break;

      case 'apply_to_editor':
        this.applyToEditor(message.content as string);
        break;

      case 'copy_to_clipboard':
        vscode.env.clipboard.writeText(message.content as string);
        break;

      case 'open_file':
        this.openFile(message.path as string);
        break;
    }
  }

  /**
   * Build API messages from user input and history.
   */
  private buildApiMessages(data: UserMessageData): ApiMessage[] {
    const messages: ApiMessage[] = [];
    const config = vscode.workspace.getConfiguration('claude');

    // Add system prompt
    const systemPrompt = config.get<string>('systemPrompt', '');
    messages.push({
      role: 'system',
      content: systemPrompt || this.getDefaultSystemPrompt(),
    });

    // Include active file context if configured
    if (this.activeFileContext && config.get<boolean>('includeFileContext', true)) {
      messages.push({
        role: 'system',
        content: `Active file: ${this.activeFileContext.path}\nLanguage: ${this.activeFileContext.language}\n\nHere is the current file content:\n\`\`\`${this.activeFileContext.language}\n${this.activeFileContext.text}\n\`\`\``,
      });
    }

    // Add conversation history (last N messages to stay within token limits)
    const maxHistory = 20;
    const recentHistory = this.messageHistory.slice(-maxHistory);
    for (const msg of recentHistory) {
      if (msg.content) {
        messages.push({
          role: msg.role as 'user' | 'assistant',
          content: msg.content,
        });
      }
    }

    return messages;
  }

  /**
   * Apply code from Claude's response to the active editor.
   */
  private applyToEditor(content: string): void {
    const editor = vscode.window.activeTextEditor;
    if (!editor) {
      vscode.window.showInformationMessage('No active editor to apply changes to');
      return;
    }

    editor.edit(editBuilder => {
      if (!editor.selection.isEmpty) {
        editBuilder.replace(editor.selection, content);
      } else {
        editBuilder.insert(editor.selection.start, content);
      }
    });
  }

  /**
   * Open a file in the editor.
   */
  private async openFile(filePath: string): Promise<void> {
    try {
      const uri = vscode.Uri.file(filePath);
      const doc = await vscode.workspace.openTextDocument(uri);
      await vscode.window.showTextDocument(doc);
    } catch {
      vscode.window.showErrorMessage(`Cannot open file: ${filePath}`);
    }
  }

  /**
   * Post a message to the webview.
   */
  private postMessageToWebview(message: unknown): void {
    this.panel?.webview.postMessage(message);
  }

  /**
   * Send current configuration to the webview.
   */
  private sendConfigToWebview(): void {
    const config = vscode.workspace.getConfiguration('claude');
    this.postMessageToWebview({
      command: 'update_config',
      config: {
        showThinking: config.get<boolean>('showThinking', false),
        model: config.get<string>('model', 'claude-sonnet-4-20250514'),
      },
    });
  }

  /**
   * Send message history to the webview.
   */
  private sendHistoryToWebview(): void {
    this.postMessageToWebview({
      command: 'load_history',
      messages: this.messageHistory,
    });
  }

  /**
   * Generate the HTML for the webview.
   * This embeds the React-based chat UI rendered as HTML with inline JS.
   */
  private getWebviewHtml(): string {
    const scriptUri = this.panel?.webview.asWebviewUri(
      vscode.Uri.file(path.join(this.context.extensionPath, 'dist', 'webview', 'app.js'))
    );
    const nonce = this.getNonce();

    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta http-equiv="Content-Security-Policy"
    content="default-src 'none'; style-src ${this.panel?.webview.cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}';">
  <meta http-equiv="Content-Security-Policy"
    content="default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${nonce}';">
  <title>Claude Code</title>
  <style>
    :root {
      --vscode-font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
      --vscode-font-size: 13px;
      --vscode-editor-background: var(--vscode-editor-background, #1e1e1e);
      --vscode-editor-foreground: var(--vscode-editor-foreground, #d4d4d4);
      --vscode-sideBar-background: var(--vscode-sideBar-background, #252526);
      --vscode-input-background: var(--vscode-input-background, #3c3c3c);
      --vscode-input-foreground: var(--vscode-input-foreground, #cccccc);
      --vscode-button-background: var(--vscode-button-background, #0e639c);
      --vscode-button-foreground: var(--vscode-button-foreground, #ffffff);
    }
    * { box-sizing: border-box; margin: 0; padding: 0; }
    html, body, #root { height: 100%; width: 100%; }
    body {
      font-family: var(--vscode-font-family);
      font-size: var(--vscode-font-size);
      color: var(--vscode-editor-foreground);
      background: var(--vscode-editor-background);
      overflow: hidden;
    }
    #root {
      display: flex;
      flex-direction: column;
      height: 100%;
    }
    .chat-messages {
      flex: 1;
      overflow-y: auto;
      padding: 12px;
    }
    .message {
      margin-bottom: 16px;
      line-height: 1.5;
    }
    .message.user {
      background: var(--vscode-input-background);
      border-radius: 8px;
      padding: 8px 12px;
      margin-left: 24px;
    }
    .message.assistant {
      margin-right: 24px;
    }
    .message pre {
      background: var(--vscode-sideBar-background);
      border-radius: 4px;
      padding: 8px 12px;
      overflow-x: auto;
      margin: 8px 0;
    }
    .message code {
      font-family: 'Menlo', 'Monaco', 'Courier New', monospace;
      font-size: 12px;
    }
    .message p { margin: 8px 0; }
    .message ul, .message ol { margin: 8px 0 8px 20px; }
    .chat-input-container {
      border-top: 1px solid var(--vscode-widget-border, #454545);
      padding: 8px 12px;
      background: var(--vscode-sideBar-background);
    }
    .chat-input {
      width: 100%;
      min-height: 40px;
      max-height: 150px;
      padding: 8px 12px;
      border: 1px solid var(--vscode-widget-border, #454545);
      border-radius: 4px;
      background: var(--vscode-input-background);
      color: var(--vscode-input-foreground);
      font-family: var(--vscode-font-family);
      font-size: var(--vscode-font-size);
      resize: vertical;
      outline: none;
    }
    .chat-input:focus {
      border-color: var(--vscode-focusBorder, #007fd4);
    }
    .chat-input::placeholder {
      color: var(--vscode-input-placeholderForeground, #888888);
    }
    .send-button {
      margin-top: 8px;
      padding: 6px 16px;
      background: var(--vscode-button-background);
      color: var(--vscode-button-foreground);
      border: none;
      border-radius: 4px;
      cursor: pointer;
      font-size: var(--vscode-font-size);
    }
    .send-button:hover { opacity: 0.9; }
    .send-button:disabled { opacity: 0.5; cursor: not-allowed; }
    .typing-indicator { color: var(--vscode-descriptionForeground, #888); font-style: italic; }
    .file-context-badge {
      font-size: 11px;
      color: var(--vscode-descriptionForeground, #888);
      padding: 4px 8px;
      background: var(--vscode-badge-background, #4d4d4d);
      border-radius: 12px;
      margin-bottom: 8px;
      display: inline-block;
    }
    .welcome-screen {
      display: flex;
      flex-direction: column;
      align-items: center;
      justify-content: center;
      height: 100%;
      text-align: center;
      color: var(--vscode-descriptionForeground, #888);
      padding: 24px;
    }
    .welcome-screen h2 {
      font-size: 20px;
      color: var(--vscode-editor-foreground);
      margin-bottom: 12px;
    }
    .welcome-screen p { margin: 4px 0; }
    .suggestions {
      display: flex;
      flex-wrap: wrap;
      gap: 8px;
      justify-content: center;
      margin-top: 16px;
    }
    .suggestion-btn {
      padding: 6px 12px;
      background: var(--vscode-input-background);
      border: 1px solid var(--vscode-widget-border, #454545);
      border-radius: 16px;
      color: var(--vscode-input-foreground);
      cursor: pointer;
      font-size: 12px;
    }
    .suggestion-btn:hover {
      background: var(--vscode-list-hoverBackground, #2a2d2e);
    }
  </style>
</head>
<body>
  <div id="root"></div>
  <script nonce="${nonce}">
    // Claude Code VSCode Webview - Chat UI
    // This runs inside VSCode's webview with full VSCode API access via acquireVsCodeApi()

    const vscode = acquireVsCodeApi();
    let messages = [];
    let config = {};
    let isStreaming = false;

    // Message handler from VSCode extension
    window.addEventListener('message', event => {
      const message = event.data;
      switch (message.command) {
        case 'add_message':
          messages.push(message.message);
          renderMessages();
          break;
        case 'update_message':
          const idx = messages.findIndex(m => m.id === message.messageId);
          if (idx !== -1) {
            messages[idx].content = message.content;
            messages[idx].isStreaming = message.isStreaming;
            renderMessages();
          }
          break;
        case 'clear_messages':
          messages = [];
          renderMessages();
          break;
        case 'load_history':
          messages = message.messages || [];
          renderMessages();
          break;
        case 'update_config':
          config = message.config || {};
          break;
        case 'update_file_context':
          updateFileContext(message.context);
          break;
        case 'focus_input':
          document.getElementById('chat-input')?.focus();
          break;
        case 'error':
          showError(message.message);
          break;
      }
    });

    let activeFileContext = null;

    function updateFileContext(ctx) {
      activeFileContext = ctx;
      const badge = document.getElementById('file-context-badge');
      if (ctx && ctx.path) {
        badge.textContent = 'Active: ' + ctx.path.split('/').pop() + ' (' + ctx.language + ')';
        badge.style.display = 'inline-block';
      } else {
        badge.style.display = 'none';
      }
    }

    function renderMessages() {
      const container = document.getElementById('chat-messages');
      const inputContainer = document.getElementById('chat-input-container');
      if (!container) return;

      if (messages.length === 0) {
        container.innerHTML = getWelcomeHTML();
        return;
      }

      let html = '<span id="file-context-badge" style="display:none" class="file-context-badge"></span>';
      for (const msg of messages) {
        if (msg.role === 'user') {
          html += '<div class="message user">' + escapeHtml(msg.content) + '</div>';
        } else {
          html += '<div class="message assistant">' + renderMarkdown(msg.content) +
            (msg.isStreaming ? ' <span class="typing-indicator">...</span>' : '') +
            getActionButtons(msg.content, msg.id) + '</div>';
        }
      }

      container.innerHTML = html;
      container.scrollTop = container.scrollHeight;
    }

    function getWelcomeHTML() {
      return '<div class="welcome-screen">' +
        '<h2>Claude Code</h2>' +
        '<p>Your AI coding assistant, built into VSCode</p>' +
        '<p style="font-size: 12px; margin-top: 8px;">Ask me anything about your code</p>' +
        '<div class="suggestions">' +
        '<button class="suggestion-btn" onclick="sendSuggestion(this.textContent)">Explain this file</button>' +
        '<button class="suggestion-btn" onclick="sendSuggestion(this.textContent)">Find bugs in my code</button>' +
        '<button class="suggestion-btn" onclick="sendSuggestion(this.textContent)">Write tests</button>' +
        '<button class="suggestion-btn" onclick="sendSuggestion(this.textContent)">Improve performance</button>' +
        '</div></div>';
    }

    function sendSuggestion(text) {
      sendMessage(text);
    }

    function sendMessage(content) {
      if (!content.trim()) return;
      vscode.postMessage({ command: 'user_message', content: content });
      document.getElementById('chat-input').value = '';
      resizeInput();
    }

    function getActionButtons(content, msgId) {
      if (!content.includes('\`')) return '';
      return '<div style="margin-top:4px">' +
        '<button onclick="applyCode(\\'' + msgId + '\\')" style="margin-right:4px;padding:2px 8px;font-size:11px;cursor:pointer;background:var(--vscode-button-background);color:var(--vscode-button-foreground);border:none;border-radius:2px">Apply to Editor</button>' +
        '<button onclick="copyCode(\\'' + msgId + '\\')" style="padding:2px 8px;font-size:11px;cursor:pointer;background:var(--vscode-input-background);color:var(--vscode-input-foreground);border:1px solid var(--vscode-widget-border);border-radius:2px">Copy</button>' +
        '</div>';
    }

    function applyCode(msgId) {
      const msg = messages.find(m => m.id === msgId);
      if (msg) {
        const code = extractCodeBlocks(msg.content);
        vscode.postMessage({ command: 'apply_to_editor', content: code });
      }
    }

    function copyCode(msgId) {
      const msg = messages.find(m => m.id === msgId);
      if (msg) {
        const code = extractCodeBlocks(msg.content);
        vscode.postMessage({ command: 'copy_to_clipboard', content: code });
      }
    }

    function extractCodeBlocks(content) {
      const match = content.match(/\`\`\`[\\w]*\\n([\\s\\S]*?)\`\`\`/);
      return match ? match[1] : content;
    }

    function renderMarkdown(text) {
      if (!text) return '';
      let html = escapeHtml(text);

      // Code blocks
      html = html.replace(/\`\`\`(\\w+)?\\n([\\s\\S]*?)\`\`\`/g, '<pre><code class="lang-$1">$2</code></pre>');
      // Inline code
      html = html.replace(/\`([^\`]+)\`/g, '<code>$1</code>');
      // Bold
      html = html.replace(/\\*\\*([^\\*]+)\\*\\*/g, '<strong>$1</strong>');
      // Italic
      html = html.replace(/\\*([^\\*]+)\\*/g, '<em>$1</em>');
      // Line breaks to paragraphs
      html = html.replace(/\\n\\n/g, '</p><p>');
      html = '<p>' + html + '</p>';
      html = html.replace(/<p><\\/p>/g, '');

      return html;
    }

    function escapeHtml(text) {
      const div = document.createElement('div');
      div.textContent = text;
      return div.innerHTML;
    }

    function showError(message) {
      const container = document.getElementById('chat-messages');
      if (container) {
        container.innerHTML += '<div class="message" style="color:#f48771">Error: ' + escapeHtml(message) + '</div>';
        container.scrollTop = container.scrollHeight;
      }
    }

    function resizeInput() {
      const input = document.getElementById('chat-input');
      if (input) {
        input.style.height = 'auto';
        input.style.height = Math.min(input.scrollHeight, 150) + 'px';
      }
    }

    // Initialize with empty state
    renderMessages();
  </script>
  <script nonce="${nonce}" src="${scriptUri}"></script>
</body>
</html>`;
  }

  /**
   * Generate a nonce for CSP.
   */
  private getNonce(): string {
    let text = '';
    const possible = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
    for (let i = 0; i < 32; i++) {
      text += possible.charAt(Math.floor(Math.random() * possible.length));
    }
    return text;
  }

  /**
   * Default system prompt for the VSCode extension.
   */
  private getDefaultSystemPrompt(): string {
    return `You are Claude Code, an AI coding assistant integrated into VSCode. You help developers with:

- **Code Explanation**: Breaking down complex code into understandable parts
- **Refactoring**: Improving code quality, readability, and maintainability
- **Debugging**: Identifying and fixing bugs and issues
- **Test Generation**: Writing comprehensive unit and integration tests
- **Code Review**: Providing feedback on best practices and potential improvements
- **General Coding**: Answering questions and providing guidance

Guidelines:
- Be concise and direct
- Use code examples when helpful
- Explain your reasoning briefly
- Respect the user's existing code style
- When suggesting changes, provide the full updated code block`;
  }
}

/**
 * Chat message stored in the panel's history.
 */
interface ChatMessage {
  id: string;
  role: 'user' | 'assistant' | 'system';
  content: string;
  timestamp: number;
  isStreaming?: boolean;
}

/**
 * Message for the Claude API.
 */
interface ApiMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

/**
 * File context for the active editor.
 */
interface FileContext {
  path: string;
  language: string;
  text: string;
  selection: unknown;
}

/**
 * Generate a unique message ID.
 */
function generateId(): string {
  return 'msg_' + Math.random().toString(36).substring(2, 15) + Date.now().toString(36);
}
