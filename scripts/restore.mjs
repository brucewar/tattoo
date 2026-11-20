import { restore, cliOptions, reportFailure } from './lib/backup.mjs';

try {
  const options = cliOptions('restore');
  if (options) await restore(options);
} catch (error) {
  reportFailure(error);
}
