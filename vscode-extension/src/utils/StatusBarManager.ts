/**
 * StatusBarManager - Manages the VSCode status bar indicator for Claude Code.
 *
 * Shows the current state (idle, streaming, error) in the status bar,
 * providing visual feedback to the user about Claude's activity.
 */
import * as vscode from 'vscode';

type StatusType = 'idle' | 'streaming' | 'error' | 'ready';

/**
 * StatusBarManager provides a status bar item showing Claude's current state.
 */
export class StatusBarManager {
  private statusBarItem: vscode.StatusBarItem;

  constructor(context: vscode.ExtensionContext) {
    this.statusBarItem = vscode.window.createStatusBarItem(
      vscode.StatusBarAlignment.Right,
      100
    );
    this.statusBarItem.tooltip = 'Claude Code - AI Coding Assistant';
    this.statusBarItem.command = 'claude.chat';
    this.updateStatus('ready');
    this.statusBarItem.show();
    context.subscriptions.push(this.statusBarItem);
  }

  /**
   * Update the status bar with the current state.
   */
  updateStatus(status: StatusType): void {
    switch (status) {
      case 'idle':
        this.statusBarItem.text = '$(comment-discussion) Claude';
        this.statusBarItem.color = undefined;
        break;

      case 'streaming':
        this.statusBarItem.text = '$(loading~spin) Claude';
        this.statusBarItem.color = new vscode.ThemeColor('statusBarItem.warningForeground');
        this.statusBarItem.backgroundColor = new vscode.ThemeColor('statusBarItem.warningBackground');
        break;

      case 'error':
        this.statusBarItem.text = '$(error) Claude';
        this.statusBarItem.color = new vscode.ThemeColor('statusBarItem.errorForeground');
        this.statusBarItem.backgroundColor = new vscode.ThemeColor('statusBarItem.errorBackground');
        break;

      case 'ready':
        this.statusBarItem.text = '$(comment-discussion) Claude';
        this.statusBarItem.color = new vscode.ThemeColor('statusBarItem.prominentForeground');
        break;
    }
  }

  /**
   * Dispose of the status bar item.
   */
  dispose(): void {
    this.statusBarItem.dispose();
  }
}
