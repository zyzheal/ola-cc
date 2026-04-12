// Force config to be allowed and test the commands
import { allowConfigReading } from './src/utils/config.js';
allowConfigReading();

// Mock minimal config
globalThis.CLAUDE_CODE_GLOBAL_CONFIG = {
  userID: 'test-user',
  oauthAccount: null
};

import('./src/commands.js').then(module => {
  const getCommands = module.getCommands;

  getCommands().then(commands => {
    console.log('All commands:');
    for (const cmd of commands) {
      console.log(`- ${cmd.name} (enabled: ${cmd.isEnabled ? cmd.isEnabled() : 'N/A'})`);
    }

    // Find our newly added commands
    const newCommands = [
      'proactive',
      'assistant',
      'force-snip',
      'workflows',
      'subscribe-pr',
      'torch',
      'peers',
      'fork',
      'remote-control-server'
    ];

    console.log('\nChecking for new commands:');
    for (const name of newCommands) {
      const found = commands.find(cmd => cmd.name === name);
      console.log(`${name}: ${found ? 'FOUND' : 'NOT FOUND'} (${found ? (found.isEnabled ? found.isEnabled() : 'N/A') : ''})`);
    }
  }).catch(console.error);
}).catch(console.error);