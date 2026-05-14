import type { MessageParam } from '../../utils/anthropic-types';

export type SessionMetadata = {
  id: string;
  model: string;
  cwd: string;
  startTime: number;
  lastActivity: number;
  turnCount: number;
  totalCostUsd: number;
};

export type SessionData = {
  metadata: SessionMetadata;
  messages: MessageParam[];
  permissionRules: Array<unknown>;
};
