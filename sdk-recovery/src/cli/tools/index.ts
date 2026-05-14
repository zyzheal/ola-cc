import { ToolRegistry } from '../agent/tool-registry';
import { BashTool } from './bash-tool';
import { ReadTool } from './read-tool';
import { WriteTool } from './write-tool';
import { EditTool } from './edit-tool';
import { GlobTool } from './glob-tool';
import { GrepTool } from './grep-tool';
import { TodoWriteTool } from './todo-write-tool';

export function createDefaultRegistry(): ToolRegistry {
  const registry = new ToolRegistry();
  registry.register(BashTool);
  registry.register(ReadTool);
  registry.register(WriteTool);
  registry.register(EditTool);
  registry.register(GlobTool);
  registry.register(GrepTool);
  registry.register(TodoWriteTool);
  return registry;
}

export * from './bash-tool';
export * from './read-tool';
export * from './write-tool';
export * from './edit-tool';
export * from './glob-tool';
export * from './grep-tool';
export * from './todo-write-tool';
