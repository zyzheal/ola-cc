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
import { ClaudeClient, ContentBlock } from '../utils/ClaudeClient';

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

  private pendingAttachments: Array<{path: string; content: string; language: string}> = [];

  private messageHandlerDisposable: vscode.Disposable | undefined;
  private _onDidChangeVisibility = new vscode.EventEmitter<boolean>();
  readonly onDidChangeVisibility = this._onDidChangeVisibility.event;

  /**
   * Phase 2: Promise bridge for tool confirmation.
   * Maps toolUseId -> { resolve } to pause/resume agentLoop.
   */
  private confirmationPendingTools = new Map<string, {
    resolve: (approved: boolean) => void;
    toolName: string;
    input: unknown;
  }>();

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
      this.sendInitialStatus();
      this.isResolving = false;
    }).catch(() => {
      // If load fails, still send empty history
      this.sendConfigToWebview();
      this.sendHistoryToWebview();
      this.sendInitialStatus();
      this.isResolving = false;
    });
  }

  /**
   * Send initial connection status and workspace info to webview.
   */
  private sendInitialStatus(): void {
    this.postMessageToWebview({
      command: 'connection_status',
      status: this.client.isConfigured() ? 'connected' : 'disconnected',
    });
    const workspaceFolders = vscode.workspace.workspaceFolders;
    const workspaceName = workspaceFolders?.[0]?.name || '';
    this.postMessageToWebview({
      command: 'workspace_info',
      workspaceName,
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
    let assistantContentBlocks: ContentBlock[] = [];

    try {
      await this.client.agentLoop(apiMessages, {
        onChunk: (chunk: string) => {
          fullContent += chunk;
          this.postMessageToWebview({
            command: 'update_message',
            messageId: assistantMsgId,
            content: fullContent,
            isStreaming: true,
          });
        },
        onToolStart: (toolUse: ContentBlock) => {
          assistantContentBlocks.push(toolUse);
          this.postMessageToWebview({
            command: 'tool_start',
            toolUseId: toolUse.id,
            toolName: toolUse.name,
            input: toolUse.input,
          });
        },
        onToolComplete: (toolUse: ContentBlock, result: unknown) => {
          this.postMessageToWebview({
            command: 'tool_complete',
            toolUseId: toolUse.id,
            toolName: toolUse.name,
            result,
          });
        },
        onToolError: (toolUse: ContentBlock, error: string) => {
          this.postMessageToWebview({
            command: 'tool_error',
            toolUseId: toolUse.id,
            toolName: toolUse.name,
            error,
          });
        },
        onIteration: (current: number, max: number) => {
          this.postMessageToWebview({
            command: 'agent_iteration',
            current,
            max,
          });
        },
        // Phase 2: Promise-based tool confirmation bridge
        onToolConfirmation: (toolUse: ContentBlock) => {
          const toolUseId = toolUse.id || `tool_${Date.now()}`;
          return new Promise<boolean>((resolve) => {
            this.confirmationPendingTools.set(toolUseId, {
              resolve,
              toolName: toolUse.name || 'unknown',
              input: toolUse.input,
            });
            this.postMessageToWebview({
              command: 'tool_confirmation_request',
              toolUseId,
              toolName: toolUse.name,
              input: toolUse.input,
            });
          });
        },
        onComplete: (stopReason: string) => {
          console.log(`agentLoop complete: ${stopReason}`);
          // Build full content: text blocks + tool_use blocks for persistence
          const contentBlocks: ContentBlock[] = [];
          if (fullContent) {
            contentBlocks.push({ type: 'text', text: fullContent });
          }
          contentBlocks.push(...assistantContentBlocks);

          const assistantMsg: ChatMessage = {
            id: assistantMsgId,
            role: 'assistant',
            content: contentBlocks.length > 0 ? contentBlocks : fullContent,
            displayText: fullContent,
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
          this.postMessageToWebview({ command: 'agent_done' });
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
    this.pendingAttachments = [];
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
        // Handle attachments from webview (file picker)
        if (message.attachments && Array.isArray(message.attachments)) {
          for (const attachment of message.attachments as Array<{name: string; content: string; language: string; type: string}>) {
            this.pendingAttachments.push({
              path: attachment.name,
              content: attachment.content,
              language: attachment.language,
            });
          }
        }
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

      case 'new_chat':
        await this.clearChat();
        break;

      case 'stop_generation':
        this.client.cancel();
        this.isStreaming = false;
        this.statusBar.updateStatus('idle');
        this.postMessageToWebview({ command: 'agent_done' });
        break;

      case 'clear_file_context':
        this.activeFileContext = null;
        this.postMessageToWebview({
          command: 'update_file_context',
          context: null,
        });
        break;

      case 'export_chat':
        this.exportChat(message.content as string);
        break;

      case 'run_in_terminal':
        this.runInTerminal(message.content as string);
        break;

      case 'tool_approve': {
        const pending = this.confirmationPendingTools.get(message.toolUseId);
        if (pending) {
          pending.resolve(true);
          this.confirmationPendingTools.delete(message.toolUseId);
        }
        this.postMessageToWebview({ command: 'tool_approved', toolName: message.toolName });
        break;
      }

      case 'tool_deny': {
        const pending = this.confirmationPendingTools.get(message.toolUseId);
        if (pending) {
          pending.resolve(false);
          this.confirmationPendingTools.delete(message.toolUseId);
        }
        this.postMessageToWebview({
          command: 'tool_denied',
          toolName: message.toolName,
        });
        break;
      }

      case 'cancel_agent_loop':
        // Reject all pending confirmations on cancel
        for (const [toolUseId, pending] of this.confirmationPendingTools.entries()) {
          pending.resolve(false);
          this.confirmationPendingTools.delete(toolUseId);
        }
        this.client.cancel();
        this.isStreaming = false;
        this.statusBar.updateStatus('idle');
        this.postMessageToWebview({ command: 'agent_done' });
        break;

      case 'read_and_attach_file': {
        const filePath = message.path as string;
        try {
          const uri = vscode.Uri.file(filePath);
          const content = await vscode.workspace.fs.readFile(uri);
          const text = new TextDecoder().decode(content);
          const ext = filePath.split('.').pop() || '';

          this.pendingAttachments.push({
            path: filePath,
            content: text,
            language: ext,
          });

          this.postMessageToWebview({
            command: 'file_attached',
            fileName: path.basename(filePath),
            language: ext,
            content: text,
            fileType: ext === 'png' || ext === 'jpg' || ext === 'jpeg' || ext === 'gif' || ext === 'svg' ? 'image' : 'file',
          });
        } catch (err) {
          this.postMessageToWebview({
            command: 'error',
            message: `Cannot read file: ${filePath}`,
          });
        }
        break;
      }
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

    // Add pending file attachments as user context
    if (this.pendingAttachments.length > 0) {
      for (const attachment of this.pendingAttachments) {
        messages.push({
          role: 'user',
          content: `File: ${attachment.path}\nLanguage: ${attachment.language}\n\n\`\`\`${attachment.language}\n${attachment.content}\n\`\`\``,
        });
      }
      this.pendingAttachments = []; // Clear after adding
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

    // Append the current user message
    messages.push({
      role: 'user',
      content: data.content,
    });

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
   * Export chat to markdown file.
   */
  private async exportChat(content: string): Promise<void> {
    const uri = await vscode.window.showSaveDialog({
      filters: { 'Markdown': ['md'] },
      title: 'Export Chat',
      defaultUri: vscode.Uri.file('chat-export.md'),
    });

    if (uri) {
      await vscode.workspace.fs.writeFile(uri, Buffer.from(content, 'utf8'));
      vscode.window.showInformationMessage('Chat exported successfully');
    }
  }

  /**
   * Run code in integrated terminal.
   */
  private runInTerminal(code: string): Promise<void> {
    const terminal = vscode.window.createTerminal('Claude Code');
    terminal.show();
    terminal.sendText(code);
    return Promise.resolve();
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
      position: relative;
    }
    #chat-header {
      display: flex;
      justify-content: space-between;
      align-items: center;
      padding: 8px 12px;
      border-bottom: 1px solid var(--vscode-widget-border, #454545);
      background: var(--vscode-sideBar-background);
      gap: 8px;
    }
    .header-left { display: flex; align-items: center; gap: 8px; flex-shrink: 0; }
    .header-center { flex: 1; max-width: 300px; }
    .header-right { display: flex; align-items: center; gap: 4px; flex-shrink: 0; }
    .header-title { font-weight: 600; font-size: 13px; white-space: nowrap; }
    .search-input {
      width: 100%;
      padding: 4px 8px;
      background: var(--vscode-input-background);
      color: var(--vscode-input-foreground);
      border: 1px solid var(--vscode-widget-border, #454545);
      border-radius: 4px;
      font-size: 11px;
      outline: none;
    }
    .search-input:focus {
      border-color: var(--vscode-focusBorder, #007fd4);
    }
    .search-input::placeholder {
      color: var(--vscode-input-placeholderForeground, #888888);
    }
    .search-highlight {
      background: rgba(234, 179, 8, 0.1);
      border-left: 2px solid var(--vscode-terminal-ansiYellow);
    }
    .no-results {
      text-align: center;
      padding: 24px;
      color: var(--vscode-descriptionForeground);
    }
    .header-btn {
      padding: 4px 8px;
      background: transparent;
      color: var(--vscode-button-foreground);
      border: 1px solid var(--vscode-widget-border, #454545);
      border-radius: 4px;
      cursor: pointer;
      font-size: 11px;
      display: flex;
      align-items: center;
      justify-content: center;
      min-width: 24px;
      height: 24px;
    }
    .header-btn:hover { background: var(--vscode-list-hoverBackground, #2a2d2e); }
    .connection-status {
      width: 8px;
      height: 8px;
      border-radius: 50%;
      display: inline-block;
    }
    .status-connected { background: var(--vscode-terminal-ansiGreen, #2ea043); }
    .status-disconnected { background: var(--vscode-terminal-ansiRed, #f85149); }
    .status-configuring { background: var(--vscode-terminal-ansiYellow, #d29922); }
    #messages-container { flex: 1; overflow-y: auto; }
    .message {
      margin-bottom: 16px;
      line-height: 1.5;
      position: relative;
      padding-right: 24px;
    }
    .message-actions {
      position: absolute;
      right: 0;
      top: 4px;
      display: flex;
      gap: 4px;
      opacity: 0;
      transition: opacity 0.2s;
    }
    .message:hover .message-actions { opacity: 1; }
    .message-action-btn {
      background: transparent;
      border: 1px solid var(--vscode-widget-border, #454545);
      border-radius: 4px;
      padding: 2px 6px;
      cursor: pointer;
      font-size: 10px;
      color: var(--vscode-descriptionForeground);
    }
    .message-action-btn:hover { background: var(--vscode-list-hoverBackground, #2a2d2e); }
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
    .message table {
      border-collapse: collapse;
      margin: 8px 0;
      width: 100%;
    }
    .message th, .message td {
      border: 1px solid var(--vscode-widget-border, #454545);
      padding: 4px 8px;
      text-align: left;
    }
    .message th { background: var(--vscode-sideBar-background); }
    .message blockquote {
      border-left: 3px solid var(--vscode-button-background);
      padding-left: 12px;
      margin: 8px 0;
      color: var(--vscode-descriptionForeground);
    }
    .message hr {
      border: none;
      border-top: 1px solid var(--vscode-widget-border, #454545);
      margin: 12px 0;
    }
    .message h1, .message h2, .message h3, .message h4, .message h5, .message h6 {
      margin: 12px 0 8px;
      font-weight: 600;
    }
    .message h1 { font-size: 18px; border-bottom: 1px solid var(--vscode-widget-border); padding-bottom: 4px; }
    .message h2 { font-size: 16px; border-bottom: 1px solid var(--vscode-widget-border); padding-bottom: 4px; }
    .message h3 { font-size: 14px; }
    .message input[type="checkbox"] {
      margin-right: 6px;
      accent-color: var(--vscode-button-background);
    }
    .code-block-wrapper {
      margin: 8px 0;
      border-radius: 6px;
      overflow: hidden;
      border: 1px solid var(--vscode-widget-border, #454545);
    }
    .code-block-header {
      display: flex;
      justify-content: space-between;
      align-items: center;
      padding: 4px 12px;
      background: var(--vscode-sideBar-background);
      border-bottom: 1px solid var(--vscode-widget-border, #454545);
      font-size: 11px;
    }
    .code-lang { color: var(--vscode-descriptionForeground); }
    .code-actions { display: flex; gap: 4px; }
    .copy-code-btn, .run-code-btn {
      background: transparent;
      border: 1px solid var(--vscode-widget-border, #454545);
      border-radius: 4px;
      padding: 2px 8px;
      cursor: pointer;
      font-size: 10px;
      color: var(--vscode-descriptionForeground);
      transition: background 0.2s;
    }
    .copy-code-btn:hover, .run-code-btn:hover { background: var(--vscode-list-hoverBackground, #2a2d2e); }
    .run-code-btn { color: var(--vscode-terminal-ansiGreen); }
    .chat-input-container {
      border-top: 1px solid var(--vscode-widget-border, #454545);
      padding: 8px 12px;
      background: var(--vscode-sideBar-background);
      position: relative;
    }
    .chat-input-container.drag-over {
      background: var(--vscode-list-dropBackground, rgba(0, 127, 212, 0.1));
      border: 2px dashed var(--vscode-focusBorder, #007fd4);
    }
    .drop-hint {
      position: absolute;
      top: 50%;
      left: 50%;
      transform: translate(-50%, -50%);
      padding: 8px 16px;
      background: var(--vscode-button-background);
      color: var(--vscode-button-foreground);
      border-radius: 8px;
      font-size: 12px;
      pointer-events: none;
      z-index: 10;
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
      transition: background 0.2s, opacity 0.2s;
    }
    .send-button:hover { opacity: 0.9; }
    .send-button:disabled { opacity: 0.5; cursor: not-allowed; }
    .send-button.stop-button {
      background: var(--vscode-terminal-ansiRed, #f85149);
    }
    .send-button:focus-visible {
      outline: 2px solid var(--vscode-focusBorder, #007fd4);
      outline-offset: 2px;
    }
    .retry-btn {
      margin-top: 8px;
      padding: 4px 12px;
      background: var(--vscode-button-background);
      color: var(--vscode-button-foreground);
      border: none;
      border-radius: 4px;
      cursor: pointer;
      font-size: 11px;
    }
    .retry-btn:hover { opacity: 0.9; }
    .typing-indicator { color: var(--vscode-descriptionForeground, #888); font-style: italic; }
    .file-context-badge {
      font-size: 11px;
      color: var(--vscode-descriptionForeground, #888);
      padding: 4px 8px;
      background: var(--vscode-badge-background, #4d4d4d);
      border-radius: 12px;
      margin-bottom: 8px;
      display: inline-flex;
      align-items: center;
      gap: 8px;
    }
    .badge-close {
      cursor: pointer;
      font-size: 14px;
      line-height: 1;
      opacity: 0.7;
    }
    .badge-close:hover { opacity: 1; }
    .session-restore-banner {
      background: var(--vscode-input-background);
      border: 1px solid var(--vscode-widget-border, #454545);
      border-radius: 6px;
      padding: 8px 12px;
      margin-bottom: 12px;
      font-size: 12px;
      color: var(--vscode-descriptionForeground);
      display: flex;
      justify-content: space-between;
      align-items: center;
    }
    .dismiss-banner {
      cursor: pointer;
      font-size: 14px;
      opacity: 0.7;
    }
    .dismiss-banner:hover { opacity: 1; }
    .toggle-collapse-btn {
      display: block;
      width: 100%;
      padding: 4px;
      background: transparent;
      border: 1px solid var(--vscode-widget-border, #454545);
      border-radius: 4px;
      color: var(--vscode-descriptionForeground);
      cursor: pointer;
      font-size: 11px;
      margin: 4px 0;
      transition: background 0.2s;
    }
    .toggle-collapse-btn:hover { background: var(--vscode-list-hoverBackground, #2a2d2e); }
    .collapsible-content.collapsed {
      max-height: 300px;
      overflow: hidden;
      position: relative;
    }
    .collapsible-content.collapsed::after {
      content: '';
      position: absolute;
      bottom: 0;
      left: 0;
      right: 0;
      height: 60px;
      background: linear-gradient(transparent, var(--vscode-editor-background));
    }
    .collapsible-content.hidden { display: none; }
    .back-to-top-btn {
      position: absolute;
      bottom: 12px;
      right: 12px;
      padding: 6px 10px;
      background: var(--vscode-button-background);
      color: var(--vscode-button-foreground);
      border: none;
      border-radius: 50%;
      cursor: pointer;
      font-size: 14px;
      opacity: 0;
      transition: opacity 0.3s;
      z-index: 5;
      box-shadow: 0 2px 8px rgba(0, 0, 0, 0.3);
    }
    .back-to-top-btn.visible { opacity: 0.8; }
    .back-to-top-btn:hover { opacity: 1; }
    .welcome-screen {
      display: flex;
      flex-direction: column;
      align-items: center;
      justify-content: center;
      height: 100%;
      text-align: center;
      color: var(--vscode-descriptionForeground, #888);
      padding: 24px;
      animation: fadeIn 0.3s ease-in;
    }
    @keyframes fadeIn {
      from { opacity: 0; transform: translateY(8px); }
      to { opacity: 1; transform: translateY(0); }
    }
    .workspace-label {
      font-size: 11px;
      color: var(--vscode-button-background);
      margin-top: 8px;
      padding: 2px 8px;
      background: rgba(14, 99, 156, 0.1);
      border-radius: 12px;
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
      transition: background 0.2s, border-color 0.2s;
    }
    .suggestion-btn:hover {
      background: var(--vscode-list-hoverBackground, #2a2d2e);
      border-color: var(--vscode-focusBorder, #007fd4);
    }
    .suggestion-btn:focus-visible {
      outline: 2px solid var(--vscode-focusBorder, #007fd4);
      outline-offset: 2px;
    }
    .tool-card {
      border: 1px solid var(--vscode-widget-border);
      border-radius: 6px;
      margin: 8px 0;
      padding: 8px 12px;
      background: var(--vscode-sideBar-background);
      transition: all 0.2s;
    }
    .tool-card:hover { box-shadow: 0 2px 8px rgba(0, 0, 0, 0.2); }
    .tool-card.running { border-left: 3px solid var(--vscode-progress-foreground); animation: pulse 1.5s infinite; }
    .tool-card.complete { border-left: 3px solid var(--vscode-terminal-ansiGreen); }
    .tool-card.error { border-left: 3px solid var(--vscode-terminal-ansiRed); }
    @keyframes pulse {
      0%, 100% { opacity: 1; }
      50% { opacity: 0.7; }
    }
    .tool-header { display: flex; justify-content: space-between; align-items: center; }
    .tool-name { font-weight: bold; font-size: 12px; }
    .tool-status { font-size: 11px; color: var(--vscode-descriptionForeground); }
    .tool-details { margin-top: 6px; font-size: 12px; font-family: monospace; white-space: pre-wrap; word-break: break-all; }
    .agent-progress { display: flex; align-items: center; gap: 8px; padding: 4px 0; font-size: 11px; }
    .agent-progress-bar { flex: 1; height: 4px; background: var(--vscode-progress-background); border-radius: 2px; }
    .agent-progress-fill { height: 100%; background: var(--vscode-progress-foreground); border-radius: 2px; transition: width 0.3s; }
    .confirmation-dialog { border: 1px solid var(--vscode-input-border); border-radius: 6px; padding: 12px; margin: 8px 0; background: var(--vscode-input-background); }
    .confirmation-buttons { display: flex; gap: 8px; margin-top: 8px; }
    .confirmation-buttons button { padding: 6px 16px; border: none; border-radius: 4px; cursor: pointer; transition: opacity 0.2s; }
    .confirmation-buttons button:hover { opacity: 0.9; }
    .btn-approve { background: var(--vscode-button-background); color: var(--vscode-button-foreground); }
    .btn-deny { background: var(--vscode-button-secondaryBackground); color: var(--vscode-button-secondaryForeground); }
    .cancel-btn { background: var(--vscode-errorForeground); color: white; border: none; padding: 6px 16px; border-radius: 4px; cursor: pointer; margin-top: 4px; transition: opacity 0.2s; }
    .cancel-btn:hover { opacity: 0.8; }
    .message.error {
      background: rgba(248, 81, 73, 0.1);
      border: 1px solid var(--vscode-terminal-ansiRed);
      border-radius: 6px;
      padding: 12px;
      margin: 8px 0;
      color: var(--vscode-terminal-ansiRed);
    }
    /* Scrollbar styling */
    ::-webkit-scrollbar { width: 10px; }
    ::-webkit-scrollbar-track { background: transparent; }
    ::-webkit-scrollbar-thumb { background: var(--vscode-scrollbarSlider-background, rgba(121, 121, 121, 0.4)); border-radius: 5px; }
    ::-webkit-scrollbar-thumb:hover { background: var(--vscode-scrollbarSlider-hoverBackground, rgba(100, 100, 100, 0.7)); }
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
  content: string | ContentBlock[];
  /** Plain text extracted from content for display in the UI */
  displayText?: string;
  timestamp: number;
  isStreaming?: boolean;
}

/**
 * Message for the Claude API.
 */
interface ApiMessage {
  role: 'system' | 'user' | 'assistant';
  content: string | ContentBlock[];
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
