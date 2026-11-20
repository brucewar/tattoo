import { backup, cliOptions, reportFailure } from './lib/backup.mjs';

try {
  const options = cliOptions('backup');
  if (options) await backup(options);
} catch (error) {
  reportFailure(error);
}
