import React, { useEffect, useRef, useState } from 'react';
import { Box, Text, useInput } from '../ink.js';
import { saveGlobalConfig } from '../utils/config.js';
import { normalizeApiKeyForConfig } from '../utils/authPortable.js';
import { Spinner } from './Spinner.js';
import { BaseTextInput } from './BaseTextInput.js';
import TextInput from './TextInput.js';

interface ProviderProfile {
  name: string
  provider: 'openai' | 'anthropic'
  apiUrl: string
  apiKey: string
  models: string[]
  defaultModel: string
  verified: boolean
  addedAt: string
}

interface ProfilesData {
  profiles: ProviderProfile[]
  activeProfile?: string
  activeModel?: string
}

type Props = {
  onDone(): void;
};

interface StepState {
  phase: 'select' | 'input-name' | 'input-url' | 'input-protocol' | 'input-key' | 'input-model' | 'verifying' | 'done'
  profileName: string
  apiUrl: string
  apiKey: string
  model: string
  provider: 'openai' | 'anthropic'
  verifyError: string | null
  inputError: string | null
  currentInput: string
  cursorOffset: number
}

const PRESETS = [
  { key: 'dashscope', label: 'DashScope (通义千问)', apiUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1', provider: 'openai' as const, defaultModel: 'qwen-plus' },
  { key: 'openai', label: 'OpenAI', apiUrl: 'https://api.openai.com/v1', provider: 'openai' as const, defaultModel: 'gpt-4o' },
  { key: 'custom', label: '自定义 provider', apiUrl: '', provider: 'openai' as const, defaultModel: '' },
];

function isValidProfileName(name: string): boolean {
  return name.length > 0 && name.length <= 50 && /^[a-zA-Z0-9_\-]+$/.test(name);
}

function isValidUrl(urlString: string): boolean {
  try {
    const url = new URL(urlString);
    return url.protocol === 'http:' || url.protocol === 'https:';
  } catch {
    return false;
  }
}

function loadProfiles(): ProfilesData {
  try {
    const { getSettingsForSource, updateSettingsForSource } = require('../utils/settings/settings.js');
    const sources = ['flagSettings', 'userSettings'];
    for (const source of sources) {
      const settings = getSettingsForSource(source);
      if (!settings) continue;
      const raw = settings.__olaProviders__;
      if (raw && typeof raw === 'object') {
        return raw as ProfilesData;
      }
    }
  } catch { /* ignore */ }
  return { profiles: [] };
}

function saveProfiles(data: ProfilesData): void {
  try {
    const { updateSettingsForSource } = require('../utils/settings/settings.js');
    updateSettingsForSource('userSettings', {
      __olaProviders__: {
        profiles: data.profiles,
        activeProfile: data.activeProfile,
        activeModel: data.activeModel,
      },
    });
  } catch { /* ignore */ }
}

async function verifyProviderProfile(profile: ProviderProfile): Promise<{ success: boolean; error?: string }> {
  const modelToTest = profile.models[0] || profile.defaultModel || 'unknown';
  try {
    const { createOpenAICompatibleShimClient } = require('../services/api/openaiShim.js');
    const { getAnthropicClient } = require('../services/api/client.js');

    if (profile.provider === 'openai') {
      const prevOpenai = process.env.CLAUDE_CODE_USE_OPENAI;
      const prevKey = process.env.OPENAI_API_KEY;
      const prevBase = process.env.OPENAI_API_BASE;
      const prevBaseUrl = process.env.OPENAI_BASE_URL;

      process.env.CLAUDE_CODE_USE_OPENAI = 'true';
      process.env.OPENAI_API_KEY = profile.apiKey;
      process.env.OPENAI_API_BASE = profile.apiUrl;
      process.env.OPENAI_BASE_URL = profile.apiUrl;

      try {
        const client = createOpenAICompatibleShimClient({
          apiKey: profile.apiKey,
          maxRetries: 0,
          model: modelToTest,
        });

        const result = await (client.beta.messages.create({
          model: modelToTest,
          messages: [{ role: 'user', content: 'Hi' }],
          max_tokens: 10,
          stream: false,
        }) as any);

        const response = await result;
        if (response && response.id) return { success: true };
        return { success: false, error: 'Unexpected response format' };
      } finally {
        if (prevOpenai !== undefined) process.env.CLAUDE_CODE_USE_OPENAI = prevOpenai;
        else delete process.env.CLAUDE_CODE_USE_OPENAI;
        if (prevKey !== undefined) process.env.OPENAI_API_KEY = prevKey;
        else delete process.env.OPENAI_API_KEY;
        if (prevBase !== undefined) process.env.OPENAI_API_BASE = prevBase;
        else delete process.env.OPENAI_API_BASE;
        if (prevBaseUrl !== undefined) process.env.OPENAI_BASE_URL = prevBaseUrl;
        else delete process.env.OPENAI_BASE_URL;
      }
    } else {
      const prevKey = process.env.ANTHROPIC_API_KEY;
      const prevBase = process.env.ANTHROPIC_BASE_URL;
      process.env.ANTHROPIC_API_KEY = profile.apiKey;
      if (profile.apiUrl) process.env.ANTHROPIC_BASE_URL = profile.apiUrl;
      try {
        const client = await getAnthropicClient({
          apiKey: profile.apiKey,
          maxRetries: 0,
        });
        const result = await (client.beta.messages.create({
          model: modelToTest || 'claude-sonnet-4-20250514',
          messages: [{ role: 'user', content: 'Hi' }],
          max_tokens: 10,
          stream: false,
        }) as any);

        const response = await result;
        if (response && response.id) return { success: true };
        return { success: false, error: 'Unexpected response format' };
      } finally {
        if (prevKey !== undefined) process.env.ANTHROPIC_API_KEY = prevKey;
        else delete process.env.ANTHROPIC_API_KEY;
        if (prevBase !== undefined) process.env.ANTHROPIC_BASE_URL = prevBase;
        else delete process.env.ANTHROPIC_BASE_URL;
      }
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { success: false, error: message.length > 300 ? message.slice(0, 300) + '...' : message };
  }
}

function approveProviderApiKey(profile: ProviderProfile): void {
  if (profile.provider !== 'anthropic' || !profile.apiKey) return;
  const normalizedKey = normalizeApiKeyForConfig(profile.apiKey);
  saveGlobalConfig(current => {
    const approved = current.customApiKeyResponses?.approved ?? [];
    if (approved.includes(normalizedKey)) return current;
    return {
      ...current,
      customApiKeyResponses: {
        ...current.customApiKeyResponses,
        approved: [...approved, normalizedKey],
      },
    };
  });
}

function activateProfile(profile: ProviderProfile): void {
  const data = loadProfiles();
  const existing = data.profiles.findIndex(p => p.name === profile.name);
  if (existing >= 0) data.profiles[existing] = profile;
  else data.profiles.push(profile);
  data.activeProfile = profile.name;
  data.activeModel = profile.defaultModel;
  saveProfiles(data);
  approveProviderApiKey(profile);

  try {
    const { syncProcessScopedOlaProviders, setProcessScopedActiveProfile } = require('../utils/managedEnv.js');
    syncProcessScopedOlaProviders(data);
    setProcessScopedActiveProfile(profile.name, profile.defaultModel);
  } catch { /* ignore */ }
}

// Simple text input wrapper for onboarding
function SimpleTextInput({ value, onChange, onSubmit, onExit, placeholder, columns = 80 }: {
  value: string;
  onChange: (value: string) => void;
  onSubmit: (value: string) => void;
  onExit?: () => void;
  placeholder: string;
  columns?: number;
}) {
  const [cursorOffset, setCursorOffset] = useState(value.length);
  const valueRef = useRef(value);
  valueRef.current = value;

  // Sync cursor offset when value changes externally
  useEffect(() => {
    setCursorOffset(value.length);
  }, [value]);

  return (
    <TextInput
      value={value}
      onChange={onChange}
      onSubmit={onSubmit}
      onExit={onExit}
      onPaste={(text) => {
        onChange(valueRef.current + text);
      }}
      placeholder={placeholder}
      columns={columns}
      cursorOffset={cursorOffset}
      onChangeCursorOffset={setCursorOffset}
      showCursor
      focus
    />
  );
}

export function ConfigApiStep({ onDone }: Props): React.ReactNode {
  const [state, setState] = useState<StepState>({
    phase: 'select',
    profileName: '',
    apiUrl: '',
    apiKey: '',
    model: '',
    provider: 'openai',
    verifyError: null,
    inputError: null,
    currentInput: '',
    cursorOffset: 0,
  });

  // Verify profile when entering verifying phase
  useEffect(() => {
    if (state.phase !== 'verifying') return;
    let cancelled = false;
    (async () => {
      const profile: ProviderProfile = {
        name: state.profileName,
        provider: state.provider,
        apiUrl: state.apiUrl,
        apiKey: state.apiKey,
        models: [state.model],
        defaultModel: state.model,
        verified: false,
        addedAt: new Date().toISOString(),
      };
      const result = await verifyProviderProfile(profile);
      if (cancelled) return;
      if (result.success) {
        profile.verified = true;
      } else {
        profile.verified = false;
      }
      activateProfile(profile);
      setState(prev => ({ ...prev, phase: 'done', verifyError: result.error || null }));
    })();
    return () => { cancelled = true; };
  }, [state.phase]);

  // Only capture input in phases without SimpleTextInput (select, input-protocol, done).
  // When SimpleTextInput is rendered (input-name, input-url, input-key, input-model),
  // it has its own useInput handler. Setting isActive=false prevents calling setState
  // while BaseTextInput is rendering, which causes React's "setState during render" error.
  const isConfigApiStepInputActive = state.phase === 'select' || state.phase === 'input-protocol' || state.phase === 'done';

  // Handle key input for select/protocol/done phases
  useInput((input, key) => {
    if (state.phase === 'done') {
      onDone();
      return;
    }

    if (state.phase === 'input-protocol') {
      if (input === '1') {
        setState(prev => ({
          ...prev,
          phase: 'input-key',
          provider: 'openai',
          currentInput: '',
          cursorOffset: 0,
          inputError: null,
        }));
      } else if (input === '2') {
        setState(prev => ({
          ...prev,
          phase: 'input-key',
          provider: 'anthropic',
          currentInput: '',
          cursorOffset: 0,
          inputError: null,
        }));
      } else if (key.escape) {
        setState(prev => ({ ...prev, phase: 'input-url', currentInput: prev.apiUrl, cursorOffset: prev.apiUrl.length, inputError: null }));
      }
      return;
    }

    if (state.phase === 'select') {
      if (key.escape) {
        onDone();
        return;
      }
      if (key.return || input === ' ') {
        return;
      }
      const num = parseInt(input);
      if (num >= 1 && num <= PRESETS.length) {
        const preset = PRESETS[num - 1];
        if (preset.key === 'custom') {
          setState(prev => ({
            ...prev,
            phase: 'input-name',
            profileName: '',
            apiUrl: '',
            model: '',
            provider: preset.provider,
            currentInput: '',
            cursorOffset: 0,
            inputError: null,
          }));
        } else {
          setState(prev => ({
            ...prev,
            phase: 'input-key',
            profileName: preset.key,
            apiUrl: preset.apiUrl,
            model: preset.defaultModel,
            provider: preset.provider,
            currentInput: '',
            cursorOffset: 0,
            inputError: null,
          }));
        }
      } else if (input === 's' || input === 'S') {
        onDone();
      }
      return;
    }
  }, { isActive: isConfigApiStepInputActive });

  // Render select phase
  if (state.phase === 'select') {
    return (
      <Box flexDirection="column" gap={1} paddingLeft={1}>
        <Text bold>配置 API 访问:</Text>
        <Text dimColor>选择 AI provider:</Text>
        {PRESETS.map((preset, i) => (
          <Text key={preset.key}>
            <Text color="cyan">{i + 1}.</Text> {preset.label}
          </Text>
        ))}
        <Text dimColor>按数字选择 · S 跳过 · Esc 退出</Text>
      </Box>
    );
  }

  // Render verifying phase
  if (state.phase === 'verifying') {
    return (
      <Box flexDirection="column" gap={1} paddingLeft={1}>
        <Text dimColor>正在验证连接...</Text>
        <Spinner />
      </Box>
    );
  }

  // Render protocol selection phase
  if (state.phase === 'input-protocol') {
    return (
      <Box flexDirection="column" gap={1} paddingLeft={1}>
        <Text bold>协议类型:</Text>
        <Text>
          <Text color="cyan">1.</Text> OpenAI 兼容协议
          {state.provider === 'openai' && <Text color="green"> (已检测)</Text>}
        </Text>
        <Text>
          <Text color="cyan">2.</Text> Anthropic 协议
          {state.provider === 'anthropic' && <Text color="green"> (已检测)</Text>}
        </Text>
        <Text dimColor>按 1/2 选择 · Esc 返回</Text>
      </Box>
    );
  }

  // Render done phase
  if (state.phase === 'done') {
    const statusText = state.verifyError
      ? `已保存 "${state.profileName}"，但验证未通过: ${state.verifyError}`
      : `已配置 "${state.profileName}" (${state.model})`;
    return (
      <Box flexDirection="column" gap={1} paddingLeft={1}>
        <Text>{statusText}</Text>
        <Text dimColor>按 Enter 继续</Text>
      </Box>
    );
  }

  // Render input phases with BaseTextInput
  const phaseLabels: Record<string, string> = {
    'input-name': 'Provider 名称:',
    'input-url': 'API URL:',
    'input-protocol': '协议类型:',
    'input-key': 'API Key:',
    'input-model': '模型名称:',
  };
  const placeholders: Record<string, string> = {
    'input-name': 'my-provider',
    'input-url': 'https://...',
    'input-key': 'sk-...',
    'input-model': 'qwen-plus',
  };

  const handleSubmit = (value: string) => {
    const val = value.trim();
    if (state.phase === 'input-name') {
      if (!val) {
        setState(prev => ({ ...prev, inputError: '名称不能为空' }));
        return;
      }
      if (!isValidProfileName(val)) {
        setState(prev => ({ ...prev, inputError: '名称只能包含字母、数字、连字符和下划线' }));
        return;
      }
      setState(prev => ({
        ...prev,
        phase: 'input-url',
        profileName: val,
        currentInput: '',
        cursorOffset: 0,
        inputError: null,
      }));
    } else if (state.phase === 'input-url') {
      if (!val) {
        setState(prev => ({ ...prev, inputError: 'URL不能为空' }));
        return;
      }
      if (!isValidUrl(val)) {
        setState(prev => ({ ...prev, inputError: '无效的URL (需要 http(s) 协议)' }));
        return;
      }
      // Auto-detect provider type based on URL pattern.
      // URLs with '/anthropic' path use Anthropic-compatible protocol.
      const isAnthropicUrl = val.includes('/anthropic');
      const detectedProvider = isAnthropicUrl ? 'anthropic' as const : 'openai' as const;
      setState(prev => ({
        ...prev,
        phase: 'input-protocol',
        apiUrl: val,
        provider: detectedProvider,
        currentInput: '',
        cursorOffset: 0,
        inputError: null,
      }));
    } else if (state.phase === 'input-protocol') {
      return; // Protocol selection handled by useInput (1/2 keys)
    } else if (state.phase === 'input-key') {
      if (!val) {
        setState(prev => ({ ...prev, inputError: 'API Key不能为空' }));
        return;
      }
      setState(prev => ({
        ...prev,
        phase: 'input-model',
        apiKey: val,
        currentInput: '',
        cursorOffset: 0,
        inputError: null,
      }));
    } else if (state.phase === 'input-model') {
      if (!val) {
        setState(prev => ({ ...prev, inputError: '模型名称不能为空' }));
        return;
      }
      setState(prev => ({
        ...prev,
        phase: 'verifying',
        model: val,
        currentInput: '',
        cursorOffset: 0,
        inputError: null,
      }));
    }
  };

  const handleExit = () => {
    if (state.phase === 'input-name') {
      setState(prev => ({ ...prev, phase: 'select', currentInput: '', cursorOffset: 0, inputError: null }));
    } else if (state.phase === 'input-url') {
      setState(prev => ({ ...prev, phase: 'input-name', currentInput: prev.profileName, cursorOffset: prev.profileName.length, inputError: null }));
    } else if (state.phase === 'input-protocol') {
      setState(prev => ({ ...prev, phase: 'input-url', currentInput: prev.apiUrl, cursorOffset: prev.apiUrl.length, inputError: null }));
    } else if (state.phase === 'input-key') {
      // Preset flows (apiUrl already filled) go back to select; custom flow goes to protocol
      if (state.apiUrl && PRESETS.some(p => p.key === state.profileName)) {
        setState(prev => ({ ...prev, phase: 'select', currentInput: '', cursorOffset: 0, inputError: null }));
      } else {
        setState(prev => ({ ...prev, phase: 'input-protocol', currentInput: '', cursorOffset: 0, inputError: null }));
      }
    } else if (state.phase === 'input-model') {
      setState(prev => ({ ...prev, phase: 'input-key', currentInput: prev.apiKey, cursorOffset: prev.apiKey.length, inputError: null }));
    }
  };

  return (
    <Box flexDirection="column" gap={1} paddingLeft={1}>
      <Text bold>{phaseLabels[state.phase]}</Text>
      <SimpleTextInput
        value={state.currentInput}
        onChange={(value) => {
          setState(prev => ({ ...prev, currentInput: value, cursorOffset: value.length, inputError: null }));
        }}
        onSubmit={handleSubmit}
        onExit={handleExit}
        placeholder={placeholders[state.phase]}
      />
      {state.inputError && <Text color="error">{state.inputError}</Text>}
      <Text dimColor>Enter 确认 · Esc 返回</Text>
    </Box>
  );
}
