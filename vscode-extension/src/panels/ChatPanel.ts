/**
 * ChatViewProvider - Manages the VSCode sidebar webview for Claude Code chat.
 *
 * This class implements WebviewViewProvider to embed the Claude chat
 * interface in the VSCode sidebar. It handles message passing between
 * VSCode and the webview, and integration with the Claude API.
 *
 * The webview renders a chat interface that mirrors the CLI experience,
 * with streaming responses and support for code blocks, markdown, etc.
 *
 * Note: WebviewView does NOT support retainContextWhenHidden. When the
 * sidebar collapses, the webview DOM is destroyed and resolveWebviewView()
 * is called again. We must re-send full history and config on every resolve.
 */
import * as vscode from 'vscode';
import * as path from 'path';
import * as crypto from 'crypto';
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
 * ChatViewProvider implements vscode.WebviewViewProvider to display
 * the Claude chat interface in the VSCode sidebar.
 */
export class ChatViewProvider implements vscode.WebviewViewProvider {
  public static readonly viewType = 'claudeCode.sidebar';

  private view: vscode.WebviewView | undefined;
  private client: ClaudeClient;
  private statusBar: StatusBarManager;
  private context: vscode.ExtensionContext;
  private messageHistory: ChatMessage[] = [];
  private activeFileContext: FileContext | null = null;
  private isStreaming = false;
  private isResolving = false;
  private pendingSave = false;
  private saveDebounceTimer: NodeJS.Timeout | undefined;

  private messageHandlerDisposable: vscode.Disposable | undefined;
  private _onDidChangeVisibility = new vscode.EventEmitter<boolean>();
  readonly onDidChangeVisibility = this._onDidChangeVisibility.event;

  constructor(context: vscode.ExtensionContext, statusBar: StatusBarManager, apiKey?: string) {
    this.context = context;
    this.statusBar = statusBar;
    this.client = new ClaudeClient(apiKey);
  }

  /**
   * Called by VSCode when the sidebar view is first created or
   * re-created after the sidebar was collapsed (DOM destroyed).
   */
  resolveWebviewView(
    webviewView: vscode.WebviewView,
    _context: vscode.WebviewViewResolveContext,
    _token: vscode.CancellationToken
  ): void {
    this.view = webviewView;
    this.view.webview.options = {
      enableScripts: true,
      localResourceRoots: [
        vscode.Uri.file(path.join(this.context.extensionPath, 'dist', 'webview')),
      ],
    };
    this.view.webview.html = this.getWebviewHtml();
    this.setupMessageHandlers();

    // Restore session from file storage first, then send history/config
    this.isResolving = true;
    this.loadSession().then(messages => {
      if (messages) {
        this.messageHistory = messages;
      }
      this.sendConfigToWebview();
      this.sendHistoryToWebview();
      this.isResolving = false;
    }).catch(() => {
      // If load fails, still send empty history
      this.sendConfigToWebview();
      this.sendHistoryToWebview();
      this.isResolving = false;
    });
  }

  /**
   * Set up message handlers for the webview.
   * Disposes old handler before re-registering to prevent listener leaks on re-resolve.
   */
  private setupMessageHandlers(): void {
    this.messageHandlerDisposable?.dispose();
    if (!this.view) return;
    this.messageHandlerDisposable = this.view.webview.onDidReceiveMessage(
      async (message: WebviewMessage) => {
        await this.handleWebviewMessage(message);
      }
    );
  }

  /**
   * Focus the sidebar view.
   */
  async show(): Promise<void> {
    this.view?.show?.(true);
  }

  /**
   * Post a message to the webview.
   */
  postMessage(msg: unknown): void {
    this.view?.webview.postMessage(msg);
  }

  /**
   * Notify visibility change.
   */
  onVisibilityChange(visible: boolean): void {
    this._onDidChangeVisibility.fire(visible);
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
    this.onMessageAdded(); // Trigger session persistence
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
          // TODO: When streaming parser is upgraded to detect tool_use content blocks,
          // route tool_use/tool_result events to webview via postMessageToWebview:
          //   { command: 'tool_start', toolName, input }
          //   { command: 'tool_complete', toolName, result }
          //   { command: 'tool_error', toolName, error }
          //   { command: 'agent_iteration', current, max }
          //   { command: 'agent_done' }
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
          this.onMessageAdded(); // Trigger session persistence
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
  async clearChat(): Promise<void> {
    this.messageHistory = [];
    this.postMessageToWebview({
      command: 'clear_messages',
    });
    // Also delete persisted session
    try {
      const uri = vscode.Uri.joinPath(this.context.globalStorageUri, 'session.json');
      await vscode.workspace.fs.delete(uri);
    } catch {
      // File may not exist, ignore
    }
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
   * API key is loaded from SecretStorage first, then other settings are refreshed.
   */
  async onConfigChanged(): Promise<void> {
    await this.client.loadApiKeyFromSecretStorage(this.context);
    this.client.onConfigChanged(); // Only refreshes model/maxTokens/temperature, not apiKey
    this.sendConfigToWebview();
  }

  /**
   * Dispose of resources.
   */
  dispose(): void {
    clearTimeout(this.saveDebounceTimer);
    this.messageHandlerDisposable?.dispose();
    this._onDidChangeVisibility.dispose();
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
   * Post a message to the webview (internal helper).
   */
  private postMessageToWebview(message: unknown): void {
    this.postMessage(message);
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
   * Called when a message is added to history.
   * Saves immediately every 10 messages, otherwise debounces 10 seconds.
   */
  async onMessageAdded(): Promise<void> {
    if (this.saveDebounceTimer) clearTimeout(this.saveDebounceTimer);

    if (this.messageHistory.length % 10 === 0) {
      this.saveDebounceTimer = undefined;
      await this.saveSession();
    } else {
      this.saveDebounceTimer = setTimeout(() => this.saveSession(), 10_000);
    }
  }

  /**
   * Persist current session to global storage with atomic write.
   */
  async saveSession(): Promise<void> {
    if (this.pendingSave) return;
    this.pendingSave = true;

    try {
      const uri = vscode.Uri.joinPath(this.context.globalStorageUri, 'session.json');
      const content = JSON.stringify({
        messages: this.messageHistory,
        savedAt: Date.now(),
        version: 1,
      });

      const tmpUri = vscode.Uri.joinPath(this.context.globalStorageUri, 'session.json.tmp');
      await vscode.workspace.fs.writeFile(tmpUri, new TextEncoder().encode(content));
      await vscode.workspace.fs.rename(tmpUri, uri, { overwrite: true });
    } finally {
      this.pendingSave = false;
    }
  }

  /**
   * Load session from global storage. Returns null if not found or expired (>7 days).
   */
  async loadSession(): Promise<ChatMessage[] | null> {
    try {
      const uri = vscode.Uri.joinPath(this.context.globalStorageUri, 'session.json');
      const data = await vscode.workspace.fs.readFile(uri);
      const session = JSON.parse(new TextDecoder().decode(data));
      if (Date.now() - session.savedAt > 7 * 24 * 60 * 60 * 1000) {
        await vscode.workspace.fs.delete(uri);
        return null;
      }
      return session.messages;
    } catch {
      return null;
    }
  }

  /**
   * Generate the HTML for the webview.
   * The actual chat UI is rendered by the app.js bundle built from app.tsx.
   * Only minimal CSS and the script tag are included here.
   */
  private getWebviewHtml(): string {
    const scriptUri = this.view?.webview.asWebviewUri(
      vscode.Uri.file(path.join(this.context.extensionPath, 'dist', 'webview', 'app.js'))
    );
    const highlightJsUri = this.view?.webview.asWebviewUri(
      vscode.Uri.file(path.join(this.context.extensionPath, 'dist', 'webview', 'highlight.js'))
    );
    const highlightCssUri = this.view?.webview.asWebviewUri(
      vscode.Uri.file(path.join(this.context.extensionPath, 'dist', 'webview', 'highlight-css.js'))
    );
    const nonce = this.getNonce();

    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta http-equiv="Content-Security-Policy"
    content="default-src 'none'; style-src ${this.view?.webview.cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}';">
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
    .tool-card { border: 1px solid var(--vscode-widget-border); border-radius: 6px; margin: 8px 0; padding: 8px 12px; background: var(--vscode-sideBar-background); }
    .tool-card.running { border-left: 3px solid var(--vscode-progress-foreground); }
    .tool-card.complete { border-left: 3px solid var(--vscode-terminal-ansiGreen); }
    .tool-card.error { border-left: 3px solid var(--vscode-terminal-ansiRed); }
    .tool-header { display: flex; justify-content: space-between; align-items: center; }
    .tool-name { font-weight: bold; font-size: 12px; }
    .tool-status { font-size: 11px; color: var(--vscode-descriptionForeground); }
    .tool-details { margin-top: 6px; font-size: 12px; font-family: monospace; white-space: pre-wrap; word-break: break-all; }
    .agent-progress { display: flex; align-items: center; gap: 8px; padding: 4px 0; font-size: 11px; }
    .agent-progress-bar { flex: 1; height: 4px; background: var(--vscode-progress-background); border-radius: 2px; }
    .agent-progress-fill { height: 100%; background: var(--vscode-progress-foreground); border-radius: 2px; transition: width 0.3s; }
    .confirmation-dialog { border: 1px solid var(--vscode-input-border); border-radius: 6px; padding: 12px; margin: 8px 0; background: var(--vscode-input-background); }
    .confirmation-buttons { display: flex; gap: 8px; margin-top: 8px; }
    .confirmation-buttons button { padding: 4px 12px; border: none; border-radius: 4px; cursor: pointer; }
    .btn-approve { background: var(--vscode-button-background); color: var(--vscode-button-foreground); }
    .btn-deny { background: var(--vscode-button-secondaryBackground); color: var(--vscode-button-secondaryForeground); }
    .cancel-btn { background: var(--vscode-errorForeground); color: white; border: none; padding: 4px 12px; border-radius: 4px; cursor: pointer; margin-top: 4px; }
  </style>
</head>
<body>
  <div id="root"></div>
  <script nonce="${nonce}" src="${highlightJsUri}"></script>
  <script nonce="${nonce}" src="${highlightCssUri}"></script>
  <script nonce="${nonce}" src="${scriptUri}"></script>
</body>
</html>`;
  }

  /**
   * Generate a cryptographically secure nonce for CSP.
   */
  private getNonce(): string {
    return crypto.randomUUID().replace(/-/g, '');
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
 * Chat message stored in the view's history.
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
