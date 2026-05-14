// Hardcoded dangerous command patterns - cannot be bypassed
const DANGEROUS_PATTERNS = [
  { pattern: /rm\s+-rf\s+\/\s*$/, reason: 'Recursive force-delete of root directory' },
  { pattern: /rm\s+-rf\s+\/\*$/, reason: 'Recursive force-delete of root contents' },
  { pattern: /rm\s+-rf\s+\*\s*$/, reason: 'Recursive force-delete of current directory' },
  { pattern: /rm\s+.*--no-preserve-root/, reason: 'Removing with no preserve root' },
  { pattern: /dd\s+if=\/dev\/zero/, reason: 'Zero-filling device' },
  { pattern: /dd\s+if=\/dev\/null/, reason: 'Null-filling device' },
  { pattern: /dd\s+of=\/dev\/sd/, reason: 'Writing to disk device' },
  { pattern: /mkfs\./, reason: 'Filesystem formatting' },
  { pattern: /fdisk\s/, reason: 'Disk partitioning' },
  { pattern: /:\s*>\s*\/etc\/sudoers/, reason: 'Modifying sudoers' },
  { pattern: /\.ssh\/authorized_keys/, reason: 'Modifying SSH authorized keys' },
  { pattern: /curl\s+\S+\s*\|\s*(ba)?sh/, reason: 'Piping curl to shell' },
  { pattern: /wget\s+\S+\s*\|\s*(ba)?sh/, reason: 'Piping wget to shell' },
  { pattern: /eval\s*\(\s*base64/, reason: 'Evaluating base64-encoded content' },
  { pattern: /eval\s*\(\s*\$?\(/, reason: 'Evaluating command substitution' },
  { pattern: />\s*\/dev\/sda/, reason: 'Writing directly to disk device' },
  { pattern: /chmod\s+777\s+\/$/, reason: 'Making root world-executable' },
  { pattern: /systemctl\s+disable\s+(firewall|ufw|iptables)/, reason: 'Disabling firewall' },
  { pattern: /base64\s+-d\s*\|\s*(ba)?sh/, reason: 'Decoding and executing base64' },
  { pattern: /\beval\b.*\bbase64\b/, reason: 'Evaluating base64 content' },
  { pattern: /\$\(.*base64.*\)/, reason: 'Command substitution with base64' },
  { pattern: /mkfs\.\w+/, reason: 'Filesystem formatting' },
  { pattern: /shred\s+/, reason: 'Secure file deletion' },
  { pattern: /:\s*>\s*\/etc\/passwd/, reason: 'Modifying passwd file' },
  { pattern: /:\s*>\s*\/etc\/shadow/, reason: 'Modifying shadow file' },
];

export interface BlacklistResult {
  isDangerous: boolean;
  reason?: string;
  pattern?: string;
}

export function checkCommandDanger(command: string): BlacklistResult {
  // Normalize: remove extra whitespace, quotes, and escape sequences for pattern matching
  const normalized = command
    .replace(/\\['"]/g, '') // Remove escaped quotes
    .replace(/\s+/g, ' ')   // Normalize whitespace
    .trim();

  // Check original and normalized versions
  for (const { pattern, reason } of DANGEROUS_PATTERNS) {
    if (pattern.test(command) || pattern.test(normalized) || pattern.test(command.toLowerCase())) {
      return { isDangerous: true, reason, pattern: pattern.source };
    }
  }
  return { isDangerous: false };
}

export function checkToolDanger(
  toolName: string,
  input: Record<string, unknown>,
): BlacklistResult {
  if (toolName !== 'Bash') {
    return { isDangerous: false };
  }

  const command = (input.command as string) ?? '';
  return checkCommandDanger(command);
}
