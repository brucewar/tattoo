export const image = 'ghcr.io/brucewar/tattoo';
export const repository = 'brucewar/tattoo';
export const digestPattern = /^sha256:[0-9a-f]{64}$/;

export async function registryAccessToken(token, actor, fetcher = fetch) {
  if (!token || !actor) throw new Error('GitHub Actions registry credentials are required');
  const query = new URLSearchParams({
    service: 'ghcr.io',
    scope: 'repository:brucewar/tattoo:pull,push',
  });
  const response = await fetcher(`https://ghcr.io/token?${query}`, {
    headers: { Authorization: `Basic ${Buffer.from(`${actor}:${token}`).toString('base64')}` },
    redirect: 'error',
    signal: AbortSignal.timeout(20000),
  });
  if (!response.ok)
    throw new Error(
      `GHCR authentication returned HTTP ${response.status}; check repository package permissions`,
    );
  const result = await response.json();
  const access = result.token ?? result.access_token;
  if (typeof access !== 'string' || !access)
    throw new Error('GHCR did not return a registry token');
  return access;
}

export async function registryDigest(tag, access, fetcher = fetch) {
  if (!/^[A-Za-z0-9_][A-Za-z0-9_.-]{0,127}$/.test(tag) || !access)
    throw new Error('Invalid registry tag lookup');
  const response = await fetcher(`https://ghcr.io/v2/brucewar/tattoo/manifests/${tag}`, {
    method: 'HEAD',
    headers: {
      Authorization: `Bearer ${access}`,
      Accept:
        'application/vnd.oci.image.index.v1+json, application/vnd.oci.image.manifest.v1+json, application/vnd.docker.distribution.manifest.list.v2+json, application/vnd.docker.distribution.manifest.v2+json',
    },
    redirect: 'error',
    signal: AbortSignal.timeout(20000),
  });
  if (response.status === 404) return null;
  if (!response.ok)
    throw new Error(
      `GHCR tag lookup returned HTTP ${response.status}; refusing to treat an inaccessible tag as absent`,
    );
  const digest = response.headers.get('docker-content-digest');
  if (!digestPattern.test(digest ?? ''))
    throw new Error('GHCR returned an invalid manifest digest');
  return digest;
}

export function releaseVersion(value) {
  if (typeof value !== 'string' || value.length > 128) return null;
  const match =
    /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/.exec(
      value,
    );
  if (
    !match ||
    match[4]
      ?.split('.')
      .some((part) => /^\d+$/.test(part) && part.length > 1 && part.startsWith('0'))
  )
    return null;
  return { value, stable: !match[4], numbers: match.slice(1, 4).map(BigInt) };
}

export function publicationPlan({ eventName, repository: repo, ref, sha }) {
  if (eventName !== 'push' || repo !== repository || !/^[0-9a-f]{40}$/.test(sha ?? ''))
    throw new Error('Only verified push commits in brucewar/tattoo can publish');
  if (ref === 'refs/heads/main') return { tag: `sha-${sha}`, alias: 'edge', sha };
  if (!ref?.startsWith('refs/tags/v')) throw new Error('Unsupported publication ref');
  const version = releaseVersion(ref.slice('refs/tags/v'.length));
  if (!version) throw new Error('Release tags must be vMAJOR.MINOR.PATCH or a valid prerelease');
  return { tag: version.value, alias: version.stable ? 'latest' : null, sha };
}

export function mayUpdateLatest(tag, tags) {
  const candidate = releaseVersion(tag);
  if (!candidate?.stable) return false;
  return !tags.some((value) => {
    const other = releaseVersion(value.startsWith('v') ? value.slice(1) : value);
    if (!other?.stable) return false;
    for (let index = 0; index < 3; index++) {
      if (other.numbers[index] !== candidate.numbers[index])
        return other.numbers[index] > candidate.numbers[index];
    }
    return false;
  });
}

export async function githubJson(path, token, fetcher = fetch) {
  if (!token) throw new Error('GitHub Actions token is required for publication');
  const response = await fetcher(`https://api.github.com${path}`, {
    headers: {
      Accept: 'application/vnd.github+json',
      Authorization: `Bearer ${token}`,
      'X-GitHub-Api-Version': '2022-11-28',
    },
    signal: AbortSignal.timeout(20000),
  });
  if (response.status === 404) return null;
  if (!response.ok)
    throw new Error(
      `GitHub publication metadata returned HTTP ${response.status}; check workflow permissions`,
    );
  return response.json();
}
