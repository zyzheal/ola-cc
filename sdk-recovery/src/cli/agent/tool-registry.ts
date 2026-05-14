import Ajv from 'ajv';

export interface ToolDefinition {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  execute(input: Record<string, unknown>, context: ToolContext): Promise<ToolResult>;
}

export interface ToolContext {
  cwd: string;
  sessionId: string;
}

export interface ToolResult {
  content: Array<{ type: string; text: string }>;
  isError?: boolean;
}

const ajv = new Ajv({ allErrors: true });

export class ToolRegistry {
  private tools = new Map<string, ToolDefinition>();
  private schemaCache = new Map<string, ReturnType<typeof ajv.compile>>();
  private allowedTools: Set<string> | null = null; // null means all allowed
  private disallowedTools = new Set<string>();

  register(tool: ToolDefinition): void {
    // Validate schema on registration
    try {
      ajv.compile(tool.inputSchema);
    } catch (err) {
      throw new Error(`Invalid schema for tool "${tool.name}": ${err}`);
    }
    this.tools.set(tool.name, tool);
  }

  /**
   * Set the list of allowed tools. If set, only these tools can be executed.
   * Pass null to reset to allowing all registered tools.
   */
  setAllowedTools(tools: string[] | null): void {
    this.allowedTools = tools ? new Set(tools) : null;
  }

  /**
   * Set the list of disallowed tools. These tools cannot be executed.
   */
  setDisallowedTools(tools: string[]): void {
    this.disallowedTools = new Set(tools);
  }

  /**
   * Check if a tool can be used based on allowed/disallowed filters.
   */
  canUseTool(name: string): boolean {
    if (this.disallowedTools.has(name)) return false;
    if (this.allowedTools && !this.allowedTools.has(name)) return false;
    return true;
  }

  get(name: string): ToolDefinition | undefined {
    const tool = this.tools.get(name);
    if (!tool || !this.canUseTool(name)) return undefined;
    return tool;
  }

  list(): ToolDefinition[] {
    return Array.from(this.tools.values()).filter((t) => this.canUseTool(t.name));
  }

  async execute(name: string, input: unknown, context: ToolContext): Promise<ToolResult> {
    if (!this.canUseTool(name)) {
      return { content: [{ type: 'text', text: `Tool "${name}" is not allowed` }], isError: true };
    }

    const tool = this.tools.get(name);
    if (!tool) {
      return { content: [{ type: 'text', text: `Unknown tool: ${name}` }], isError: true };
    }

    // Validate input against schema (cached)
    let validate = this.schemaCache.get(name);
    if (!validate) {
      validate = ajv.compile(tool.inputSchema);
      this.schemaCache.set(name, validate);
    }
    if (!validate(input)) {
      const errors = validate.errors?.map(e => `${e.instancePath} ${e.message}`).join(', ');
      return { content: [{ type: 'text', text: `Invalid input for ${name}: ${errors}` }], isError: true };
    }

    return tool.execute(input as Record<string, unknown>, context);
  }
}
