import { appendFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import {
  digestPattern,
  githubJson,
  image,
  mayUpdateLatest,
  publicationPlan,
  registryAccessToken,
  registryDigest,
  repository,
} from './lib/publication.mjs';

function docker(args, quiet = false) {
  return execFileSync('docker', args, {
    encoding: 'utf8',
    stdio: quiet ? ['ignore', 'pipe', 'pipe'] : 'inherit',
    windowsHide: true,
    timeout: 15 * 60 * 1000,
  });
}
function requireDigest() {
  const digest = process.env.DIGEST;
  if (!digestPattern.test(digest ?? ''))
    throw new Error('Published image digest is missing or invalid');
  return digest;
}
async function output(name, value) {
  if (!process.env.GITHUB_OUTPUT || /[\r\n]/.test(value)) throw new Error('Invalid Actions output');
  await appendFile(process.env.GITHUB_OUTPUT, `${name}=${value}\n`);
}

async function main() {
  const plan = publicationPlan({
    eventName: process.env.GITHUB_EVENT_NAME,
    repository: process.env.GITHUB_REPOSITORY,
    ref: process.env.GITHUB_REF,
    sha: process.env.GITHUB_SHA,
  });
  const token = process.env.GH_TOKEN;
  switch (process.argv[2]) {
    case 'prepare': {
      // A tag from an unmerged branch must not publish with repository package permissions.
      if (process.env.GITHUB_REF.startsWith('refs/tags/'))
        execFileSync('git', ['merge-base', '--is-ancestor', plan.sha, 'origin/main'], {
          stdio: 'ignore',
          windowsHide: true,
        });
      const access = await registryAccessToken(token, process.env.GITHUB_ACTOR);
      const target = await registryDigest(plan.tag, access);
      const source =
        target ??
        (plan.tag === `sha-${plan.sha}` ? null : await registryDigest(`sha-${plan.sha}`, access));
      await output('tag', plan.tag);
      await output('target_exists', String(Boolean(target)));
      await output('reuse_digest', source ?? '');
      console.info(
        `Prepared ${image}:${plan.tag}; ${source ? 'reuse existing digest' : 'build new image'}`,
      );
      break;
    }
    case 'reuse': {
      const digest = requireDigest();
      docker(['pull', '--platform', 'linux/amd64', `${image}@${digest}`]);
      const [metadata] = JSON.parse(docker(['image', 'inspect', `${image}@${digest}`], true));
      if (metadata.Config?.Labels?.['org.opencontainers.image.revision'] !== plan.sha)
        throw new Error(
          'Existing immutable tag belongs to another revision; refusing to overwrite',
        );
      if (process.env.TARGET_EXISTS !== 'true')
        docker([
          'buildx',
          'imagetools',
          'create',
          '--prefer-index=false',
          '--tag',
          `${image}:${plan.tag}`,
          `${image}@${digest}`,
        ]);
      break;
    }
    case 'finalize': {
      const digest = requireDigest();
      let update = Boolean(plan.alias);
      if (plan.alias === 'edge') {
        const current = await githubJson(`/repos/${repository}/git/ref/heads/main`, token);
        if (!/^[0-9a-f]{40}$/.test(current?.object?.sha ?? ''))
          throw new Error('Unable to confirm current main commit');
        update = current.object.sha === plan.sha;
      } else if (plan.alias === 'latest') {
        // Another version may have been tagged while this image was building.
        execFileSync('git', ['fetch', 'origin', '--tags'], {
          stdio: 'ignore',
          windowsHide: true,
          timeout: 30000,
        });
        const tags = execFileSync('git', ['tag', '--merged', 'origin/main', '--list', 'v*'], {
          encoding: 'utf8',
          windowsHide: true,
        })
          .trim()
          .split('\n');
        update = mayUpdateLatest(plan.tag, tags);
      }
      if (update)
        docker([
          'buildx',
          'imagetools',
          'create',
          '--prefer-index=false',
          '--tag',
          `${image}:${plan.alias}`,
          `${image}@${digest}`,
        ]);
      const summary = `Published ${image}:${plan.tag}\n\nDigest: \`${image}@${digest}\`\n\nRevision: \`${plan.sha}\`\n\nPlatform: linux/amd64\n\n${update ? `Updated alias: ${plan.alias}` : 'No mutable alias updated'}\n`;
      if (process.env.GITHUB_STEP_SUMMARY)
        await appendFile(process.env.GITHUB_STEP_SUMMARY, summary);
      console.info(summary);
      break;
    }
    default:
      throw new Error('Expected prepare, reuse, or finalize publication action');
  }
}
main().catch((error) => {
  console.error(error instanceof Error ? error.message : 'Image publication failed');
  process.exitCode = 1;
});
