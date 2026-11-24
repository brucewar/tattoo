import { describe, expect, it } from 'vitest';
import {
  githubJson,
  mayUpdateLatest,
  publicationPlan,
  registryAccessToken,
  registryDigest,
} from '../../scripts/lib/publication.mjs';

const sha = 'a'.repeat(40);
const digest = 'sha256:' + 'b'.repeat(64);
const context = { eventName: 'push', repository: 'brucewar/tattoo', sha };

describe('GHCR publication gates and immutable tags', () => {
  it('authenticates only with the workflow credentials and does not expose them in failures', async () => {
    const token = await registryAccessToken(
      'test-token',
      'test-actor',
      async (url: string, init: RequestInit) => {
        expect(url).toContain('scope=repository%3Abrucewar%2Ftattoo%3Apull%2Cpush');
        expect((init.headers as Record<string, string>).Authorization).toBe(
          'Basic ' + Buffer.from('test-actor:test-token').toString('base64'),
        );
        return Response.json({ token: 'registry-access' });
      },
    );
    expect(token).toBe('registry-access');
    await expect(
      registryAccessToken(
        'test-token',
        'test-actor',
        async () => new Response('', { status: 403 }),
      ),
    ).rejects.toThrow('HTTP 403');
    await expect(
      registryAccessToken('test-token', 'test-actor', async () => Response.json({})),
    ).rejects.toThrow('registry token');
  });
  it('checks exact private/public manifests; only 404 means an absent immutable tag', async () => {
    expect(
      await registryDigest('0.1.0-rc.1', 'access', async () => new Response(null, { status: 404 })),
    ).toBeNull();
    expect(
      await registryDigest('0.1.0-rc.1', 'access', async (_url: string, init: RequestInit) => {
        expect(init.method).toBe('HEAD');
        return new Response(null, { headers: { 'Docker-Content-Digest': digest } });
      }),
    ).toBe(digest);
    for (const status of [401, 403, 500])
      await expect(
        registryDigest('0.1.0-rc.1', 'access', async () => new Response(null, { status })),
      ).rejects.toThrow(`HTTP ${status}`);
    await expect(
      registryDigest('0.1.0-rc.1', 'access', async () => new Response(null)),
    ).rejects.toThrow('digest');
    await expect(registryDigest('../unsafe', 'access')).rejects.toThrow('Invalid registry');
  });
  it('main publishes a complete SHA and edge; prereleases never advertise latest', () => {
    expect(publicationPlan({ ...context, ref: 'refs/heads/main' })).toEqual({
      tag: `sha-${sha}`,
      alias: 'edge',
      sha,
    });
    expect(publicationPlan({ ...context, ref: 'refs/tags/v0.1.0-rc.1' })).toEqual({
      tag: '0.1.0-rc.1',
      alias: null,
      sha,
    });
    expect(publicationPlan({ ...context, ref: 'refs/tags/v1.2.3' }).alias).toBe('latest');
  });
  it.each([
    { ...context, eventName: 'pull_request', ref: 'refs/heads/main' },
    { ...context, repository: 'someone/tattoo', ref: 'refs/heads/main' },
    { ...context, ref: 'refs/heads/feature' },
    { ...context, ref: 'refs/heads/main', sha: 'main; echo unsafe' },
    { ...context, ref: 'refs/tags/v1.2.3\nINJECT=value' },
    { ...context, ref: 'refs/tags/v01.2.3' },
    { ...context, ref: 'refs/tags/v1.2.3-01' },
  ])('rejects untrusted or malformed publication input %#', (value) =>
    expect(() => publicationPlan(value)).toThrow(),
  );
  it('older stable releases and RCs cannot downgrade latest; version ordering is numeric', () => {
    const versions = ['v2.10.0', 'v99.0.0-rc.1'];
    expect(mayUpdateLatest('2.9.0', versions)).toBe(false);
    expect(mayUpdateLatest('2.10.0', versions)).toBe(true);
    expect(mayUpdateLatest('3.0.0', versions)).toBe(true);
    expect(mayUpdateLatest('100.0.0-rc.1', versions)).toBe(false);
  });
  it('fails explicitly on GitHub permission and network errors without asking for other credentials', async () => {
    await expect(
      githubJson('/test', 'test-token', async () => new Response('', { status: 403 })),
    ).rejects.toThrow('HTTP 403');
    await expect(githubJson('/test', '', async () => new Response('{}'))).rejects.toThrow('token');
    await expect(
      githubJson('/test', 'test-token', async () => {
        throw new Error('network unavailable');
      }),
    ).rejects.toThrow('network');
  });
});
