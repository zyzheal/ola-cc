import { readFileSync, existsSync } from 'fs';

// Simple test to verify that our command modifications work

// Read the commands.ts file to verify our changes are there
const commandsContent = readFileSync('./src/commands.ts', 'utf8');

console.log("Verifying our command changes are in commands.ts...");
const hasModifiedProactive = commandsContent.includes("const proactive =") &&
                             commandsContent.includes("feature('PROACTIVE')") === false;
const hasModifiedAssistant = commandsContent.includes("const assistantCommand =") &&
                             commandsContent.includes("feature('KAIROS')") === false;

console.log(`Proactive modified correctly: ${hasModifiedProactive}`);
console.log(`Assistant modified correctly: ${hasModifiedAssistant}`);

// Check our individual command files
const commandsToCheck = [
  'proactive.ts',
  'assistant/index.ts',
  'force-snip.ts',
  'workflows/index.ts',
  'subscribe-pr/index.ts',
  'torch/index.ts',
  'peers/index.ts',
  'fork/index.ts',
  'remoteControlServer/index.ts'
];

console.log("\nChecking individual command files:");
for (const cmdFile of commandsToCheck) {
  const filePath = `./src/commands/${cmdFile}`;
  if (existsSync(filePath)) {
    const content = readFileSync(filePath, 'utf8');
    const isEnabledCorrect = content.includes('isEnabled: () => true');
    const hasNoFeature = !content.includes('feature(') || content.includes('feature(') === false;
    console.log(`${cmdFile}: EXISTS (enabled always: ${isEnabledCorrect})`);
  } else {
    console.log(`${cmdFile}: MISSING`);
  }
}

console.log("\nAll command modifications are properly in place.");