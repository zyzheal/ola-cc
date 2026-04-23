/**
 * Claude Code VSCode Extension - Entry Point
 *
 * This extension embeds Claude Code's AI capabilities inside VSCode,
 * providing a sidebar chat view, code actions, and editor integration.
 *
 * Architecture:
 * - extension.ts: VSCode extension lifecycle, command registration
 * - panels/ChatPanel.ts: ChatViewProvider for the sidebar webview
 * - providers/: Code actions, hover providers, completion providers
 * - webview/: Frontend code that runs inside VSCode webviews
 */
import * as vscode from 'vscode';
import { ChatViewProvider } from './panels/ChatPanel';
import { CodeActionProvider } from './providers/CodeActionProvider';
import { HoverProvider } from './providers/HoverProvider';
import { StatusBarManager } from './utils/StatusBarManager';

// Global state
let chatProvider: ChatViewProvider | undefined;
let statusBar: StatusBarManager | undefined;
let codeActionDisposable: vscode.Disposable | undefined;
let hoverDisposable: vscode.Disposable | undefined;
let hoverProvider: HoverProvider | undefined;

/**
 * Extension activation - called when the extension is first activated.
 */
export async function activate(context: vscode.ExtensionContext): Promise<void> {
  console.log('Claude Code extension activated');

  // Initialize status bar
  statusBar = new StatusBarManager(context);
  statusBar.updateStatus('idle');

  // Initialize chat view provider and register as WebviewViewProvider
  const provider = new ChatViewProvider(context, statusBar);
  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(ChatViewProvider.viewType, provider)
  );
  chatProvider = provider;

  // Register commands
  registerCommands(context, chatProvider);

  // Register providers (conditionally based on settings)
  registerProviders(context);

  // Register event listeners
  registerEventListeners(context, chatProvider);
}

/**
 * Register all VSCode commands contributed by this extension.
 */
function registerCommands(context: vscode.ExtensionContext, provider: ChatViewProvider): void {
  // Main chat command - opens/focuses the sidebar
  const chatCmd = vscode.commands.registerCommand('claude.chat', async () => {
    await provider.show();
    provider.focusInput();
  });
  context.subscriptions.push(chatCmd);

  // Explain code - uses current selection or active file
  const explainCmd = vscode.commands.registerCommand('claude.explain', async () => {
    const context = getEditorContext();
    await provider.show();
    provider.sendMessage({
      type: 'user_message',
      content: `Please explain this code:\n\n\`\`\`${context.language}\n${context.text}\n\`\`\``,
      context,
    });
  });
  context.subscriptions.push(explainCmd);

  // Refactor code
  const refactorCmd = vscode.commands.registerCommand('claude.refactor', async () => {
    const context = getEditorContext();
    await provider.show();
    provider.sendMessage({
      type: 'user_message',
      content: `Please refactor this code to improve readability and maintainability:\n\n\`\`\`${context.language}\n${context.text}\n\`\`\``,
      context,
    });
  });
  context.subscriptions.push(refactorCmd);

  // Fix issue
  const fixCmd = vscode.commands.registerCommand('claude.fix', async () => {
    const context = getEditorContext();
    await provider.show();
    provider.sendMessage({
      type: 'user_message',
      content: `Please identify and fix any issues in this code:\n\n\`\`\`${context.language}\n${context.text}\n\`\`\``,
      context,
    });
  });
  context.subscriptions.push(fixCmd);

  // Generate tests
  const testsCmd = vscode.commands.registerCommand('claude.generateTests', async () => {
    const context = getEditorContext();
    await provider.show();
    provider.sendMessage({
      type: 'user_message',
      content: `Please generate comprehensive unit tests for this code:\n\n\`\`\`${context.language}\n${context.text}\n\`\`\``,
      context,
    });
  });
  context.subscriptions.push(testsCmd);

  // Review code
  const reviewCmd = vscode.commands.registerCommand('claude.review', async () => {
    const context = getEditorContext();
    await provider.show();
    provider.sendMessage({
      type: 'user_message',
      content: `Please review this code for best practices, potential bugs, and improvements:\n\n\`\`\`${context.language}\n${context.text}\n\`\`\``,
      context,
    });
  });
  context.subscriptions.push(reviewCmd);

  // Clear chat
  const clearCmd = vscode.commands.registerCommand('claude.clearChat', () => {
    provider.clearChat();
  });
  context.subscriptions.push(clearCmd);

  // Focus input
  const focusCmd = vscode.commands.registerCommand('claude.focusInput', async () => {
    await provider.show();
    provider.focusInput();
  });
  context.subscriptions.push(focusCmd);
}

/**
 * Register code providers (code actions, hover, etc.)
 */
function registerProviders(context: vscode.ExtensionContext): void {
  // Code action provider - offers Claude actions in the editor
  const codeActionProvider = new CodeActionProvider();
  codeActionDisposable = vscode.languages.registerCodeActionsProvider(
    { pattern: '**/*.{ts,tsx,js,jsx,py,go,rs,rb,java,c,cpp,h,hpp}' },
    codeActionProvider,
    {
      providedCodeActionKinds: CodeActionProvider.providedCodeActionKinds,
    }
  );
  context.subscriptions.push(codeActionDisposable);

  // Hover provider - only register if enabled in settings
  const config = vscode.workspace.getConfiguration('claude');
  if (config.get<boolean>('enableHoverInsights', false)) {
    hoverProvider = new HoverProvider();
    hoverDisposable = vscode.languages.registerHoverProvider(
      { pattern: '**/*' },
      hoverProvider
    );
    context.subscriptions.push(hoverDisposable);
  }
}

/**
 * Register event listeners for VSCode events.
 */
function registerEventListeners(
  context: vscode.ExtensionContext,
  provider: ChatViewProvider
): void {
  // Listen for configuration changes
  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration(e => {
      if (e.affectsConfiguration('claude')) {
        provider.onConfigChanged();
        statusBar?.updateStatus('idle');

        // Re-register/unregister hover provider when enableHoverInsights changes
        if (e.affectsConfiguration('claude.enableHoverInsights')) {
          updateHoverProviderRegistration(context);
        }
      }
    })
  );

  // Listen for text editor changes to update context
  context.subscriptions.push(
    vscode.window.onDidChangeActiveTextEditor(editor => {
      if (editor) {
        provider.updateActiveFileContext({
          path: editor.document.uri.fsPath,
          language: editor.document.languageId,
          text: getSelectedOrFullText(editor),
          selection: editor.selection.isEmpty ? null : editor.selection,
        });
      }
    })
  );

  // Listen for text selection changes
  context.subscriptions.push(
    vscode.window.onDidChangeTextEditorSelection(e => {
      if (e.textEditor.document.uri.scheme === 'file' && !e.selections[0]?.isEmpty) {
        provider.updateActiveFileContext({
          path: e.textEditor.document.uri.fsPath,
          language: e.textEditor.document.languageId,
          text: e.textEditor.document.getText(e.selections[0]),
          selection: e.selections[0],
        });
      }
    })
  );
}

/**
 * Toggle hover provider registration based on current setting.
 */
function updateHoverProviderRegistration(context: vscode.ExtensionContext): void {
  const config = vscode.workspace.getConfiguration('claude');
  const enabled = config.get<boolean>('enableHoverInsights', false);

  if (enabled && !hoverDisposable) {
    // Enable: register the hover provider
    hoverProvider = new HoverProvider();
    hoverDisposable = vscode.languages.registerHoverProvider(
      { pattern: '**/*' },
      hoverProvider
    );
    context.subscriptions.push(hoverDisposable);
  } else if (!enabled && hoverDisposable) {
    // Disable: dispose the hover provider
    hoverDisposable.dispose();
    hoverDisposable = undefined;
    hoverProvider = undefined;
  }
}

/**
 * Extract editor context (text and language) for commands.
 */
function getEditorContext(): EditorContext {
  const editor = vscode.window.activeTextEditor;
  if (!editor) {
    return {
      language: 'text',
      text: '',
      path: '',
      selection: null,
    };
  }

  return {
    language: editor.document.languageId,
    text: getSelectedOrFullText(editor),
    path: editor.document.uri.fsPath,
    selection: editor.selection.isEmpty ? null : editor.selection,
  };
}

/**
 * Get selected text if there is a selection, otherwise get the full document.
 */
function getSelectedOrFullText(editor: vscode.TextEditor): string {
  const config = vscode.workspace.getConfiguration('claude');
  const selectionOnly = config.get<boolean>('includeSelectionOnly', true);

  if (selectionOnly && !editor.selection.isEmpty) {
    return editor.document.getText(editor.selection);
  }
  return editor.document.getText();
}

/**
 * Editor context interface for passing to Claude.
 */
export interface EditorContext {
  language: string;
  text: string;
  path: string;
  selection: vscode.Selection | null;
}

/**
 * Extension deactivation - called when the extension is deactivated.
 */
export function deactivate(): void {
  chatProvider?.dispose();
  statusBar?.dispose();
  console.log('Claude Code extension deactivated');
}
