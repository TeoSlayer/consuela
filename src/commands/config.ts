import inquirer from 'inquirer';
import chalk from 'chalk';
import Conf from 'conf';

interface GlobalConfig {
  geminiApiKey?: string;
}

const globalConf = new Conf<GlobalConfig>({
  projectName: 'consuela-global',
  configName: 'config',
});

export async function configCommand(): Promise<void> {
  console.log(chalk.green.bold('\n🧹 Consuela - Global Configuration\n'));

  const existingKey = globalConf.get('geminiApiKey');

  if (existingKey) {
    const maskedKey = existingKey.slice(0, 8) + '...' + existingKey.slice(-4);
    console.log(chalk.gray(`Current API key: ${maskedKey}\n`));

    const { action } = await inquirer.prompt([
      {
        type: 'list',
        name: 'action',
        message: 'What would you like to do?',
        choices: [
          { name: 'Update API key', value: 'update' },
          { name: 'Remove API key', value: 'remove' },
          { name: 'Cancel', value: 'cancel' },
        ],
      },
    ]);

    if (action === 'cancel') {
      return;
    }

    if (action === 'remove') {
      globalConf.delete('geminiApiKey');
      console.log(chalk.yellow('\nAPI key removed.'));
      return;
    }
  }

  const { geminiApiKey } = await inquirer.prompt([
    {
      type: 'password',
      name: 'geminiApiKey',
      message: 'Enter your Gemini API key:',
      mask: '*',
      validate: (input: string) => {
        if (!input || input.length < 10) {
          return 'Please enter a valid Gemini API key';
        }
        return true;
      },
    },
  ]);

  globalConf.set('geminiApiKey', geminiApiKey);

  console.log(chalk.green('\n✓ API key saved successfully!'));
  console.log(chalk.gray('\nYou can now run `consuela init` in any project directory.\n'));
}

export function getGlobalApiKey(): string | undefined {
  // Check environment variable first (useful for CI/CD)
  const envKey = process.env.GEMINI_API_KEY;
  if (envKey) return envKey;
  return globalConf.get('geminiApiKey');
}

export function hasGlobalApiKey(): boolean {
  return !!process.env.GEMINI_API_KEY || !!globalConf.get('geminiApiKey');
}
