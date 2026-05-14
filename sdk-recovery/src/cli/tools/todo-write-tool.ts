import type { ToolDefinition, ToolResult, ToolContext } from '../agent/tool-registry';

export const TodoWriteTool: ToolDefinition = {
  name: 'TodoWrite',
  description: 'Update the todo list. Use to track progress on multi-step tasks.',
  inputSchema: {
    type: 'object',
    properties: {
      todos: {
        type: 'array',
        description: 'Complete list of todos (replaces all existing)',
        items: {
          type: 'object',
          properties: {
            content: { type: 'string' },
            status: { type: 'string', enum: ['pending', 'in_progress', 'completed'] },
          },
          required: ['content', 'status'],
        },
      },
    },
    required: ['todos'],
  },
  async execute(input: Record<string, unknown>, _context: ToolContext): Promise<ToolResult> {
    const todos = input.todos as Array<{ content: string; status: string }>;
    const formatted = todos.map(t => {
      const icon = t.status === 'completed' ? '✅' : t.status === 'in_progress' ? '🔄' : '⬜';
      return `${icon} ${t.content}`;
    }).join('\n');
    return {
      content: [{ type: 'text', text: `Todo list updated (${todos.length} items):\n${formatted}` }],
    };
  },
};
