/**
 * HoverProvider - Provides Claude-powered hover insights.
 *
 * When users hover over code elements, this provider can offer
 * Claude-generated explanations. Disabled by default (opt-in)
 * to avoid excessive API calls.
 */
import * as vscode from 'vscode';

/**
 * HoverProvider shows Claude insights when hovering over code.
 * This is opt-in via settings to avoid unnecessary API calls.
 */
export class HoverProvider implements vscode.HoverProvider {
  private recentHovers: Map<string, number> = new Map();
  private readonly HOVER_COOLDOWN_MS = 5000; // 5s cooldown per symbol

  async provideHover(
    document: vscode.TextDocument,
    position: vscode.Position
  ): Promise<vscode.Hover | undefined> {
    const config = vscode.workspace.getConfiguration('claude');
    if (!config.get<boolean>('enableHoverInsights', false)) {
      return undefined;
    }

    const wordRange = document.getWordRangeAtPosition(position);
    if (!wordRange) {
      return undefined;
    }

    const word = document.getText(wordRange);
    if (!word || word.length < 3) {
      return undefined; // Skip very short words
    }

    // Rate limiting - don't hover the same symbol too frequently
    const cacheKey = `${document.uri.toString()}:${word}:${wordRange.start.line}`;
    const lastHover = this.recentHovers.get(cacheKey);
    if (lastHover && Date.now() - lastHover < this.HOVER_COOLDOWN_MS) {
      return undefined;
    }
    this.recentHovers.set(cacheKey, Date.now());

    // Get the symbol's context (line range)
    const line = document.lineAt(position.line);
    const symbolContext = line.text.trim();

    // Build a quick insight hover
    const hoverContent = new vscode.MarkdownString();
    hoverContent.appendText(`Quick insight for "${word}"`);
    hoverContent.appendMarkdown('\n\n---\n');
    hoverContent.appendText(symbolContext);
    hoverContent.appendMarkdown('\n\n');
    hoverContent.appendMarkdown('[Ask Claude for explanation](command:claude.explain)');
    hoverContent.isTrusted = true;

    return new vscode.Hover(hoverContent);
  }
}
