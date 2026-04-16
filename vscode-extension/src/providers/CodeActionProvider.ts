/**
 * CodeActionProvider - Provides Claude Code actions in the editor context menu.
 *
 * When users right-click on code, this provider offers Claude-related actions
 * like "Explain with Claude", "Refactor with Claude", etc.
 */
import * as vscode from 'vscode';

/**
 * CodeActionProvider registers Claude-specific code actions
 * that appear in the editor context menu and lightbulb.
 */
export class CodeActionProvider implements vscode.CodeActionProvider {
  /** The kinds of code actions this provider offers */
  public static readonly providedCodeActionKinds = [
    vscode.CodeActionKind.Refactor,
    vscode.CodeActionKind.QuickFix,
  ];

  /**
   * Provide code actions for the given range and context.
   */
  provideCodeActions(
    document: vscode.TextDocument,
    range: vscode.Range | vscode.Selection,
    context: vscode.CodeActionContext
  ): vscode.CodeAction[] {
    const actions: vscode.CodeAction[] = [];

    // Only offer actions if there's a selection
    if (range.isEmpty) {
      return actions;
    }

    // Explain code
    const explainAction = this.createAction(
      document,
      range,
      'Explain with Claude',
      'claude.explain',
      vscode.CodeActionKind.Refactor
    );
    actions.push(explainAction);

    // Refactor code
    const refactorAction = this.createAction(
      document,
      range,
      'Refactor with Claude',
      'claude.refactor',
      vscode.CodeActionKind.Refactor
    );
    actions.push(refactorAction);

    // Fix code
    if (context.diagnostics.length > 0) {
      const fixAction = this.createAction(
        document,
        range,
        'Fix with Claude',
        'claude.fix',
        vscode.CodeActionKind.QuickFix
      );
      actions.push(fixAction);
    }

    // Generate tests
    const testAction = this.createAction(
      document,
      range,
      'Generate Tests with Claude',
      'claude.generateTests',
      vscode.CodeActionKind.Refactor
    );
    actions.push(testAction);

    // Review code
    const reviewAction = this.createAction(
      document,
      range,
      'Review with Claude',
      'claude.review',
      vscode.CodeActionKind.Refactor
    );
    actions.push(reviewAction);

    return actions;
  }

  /**
   * Create a code action that triggers a Claude command.
   */
  private createAction(
    document: vscode.TextDocument,
    range: vscode.Range,
    title: string,
    command: string,
    kind: vscode.CodeActionKind
  ): vscode.CodeAction {
    const action = new vscode.CodeAction(title, kind);
    action.command = {
      command,
      title,
      arguments: [document, range],
    };
    return action;
  }
}
