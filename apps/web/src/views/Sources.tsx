import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { Alert, Button, Empty, Input, Modal, Pagination, Spin, Tag } from '../components/ui';
import { sourceJobInput } from '@tattoo/contracts';
import type {
  Source,
  SourceFeed,
  SourceJob,
  SourceJobInput,
  SourceSearchConfig,
  SourceSummary,
} from '@tattoo/contracts';
import { api, ApiError, errorMessage, jsonRequest, requestId } from '../api';
import { date, type Page } from '../ui';
import { SearchSettings } from '../components/sources/SearchSettings';
import {
  SourceJobState,
  sourceJobLabels,
  sourceJobPending,
  useSourceJob,
} from '../components/sources/SourceJob';

const pendingKey = 'tattoo:sources:pending';
const lastJobKey = 'tattoo:sources:last-job';
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
type SourceAction =
  | { kind: 'URL'; url: string; origin: 'url' | 'search' }
  | { kind: 'FEED'; feedId: string }
  | { kind: 'SEARCH'; query: string };

function pendingRequest(): SourceJobInput | null {
  try {
    const result = sourceJobInput.safeParse(
      JSON.parse(sessionStorage.getItem(pendingKey) ?? 'null'),
    );
    return result.success ? result.data : null;
  } catch {
    return null;
  }
}

function previousJob(): string | null {
  try {
    const id = sessionStorage.getItem(lastJobKey);
    return id && uuid.test(id) ? id : null;
  } catch {
    return null;
  }
}

function SourceLink({ url, children }: { url: string; children?: ReactNode }) {
  let valid = false;
  try {
    const parsed = new URL(url);
    valid = ['https:', 'http:'].includes(parsed.protocol) && !parsed.username && !parsed.password;
  } catch {
    /* Render invalid historical addresses as text. */
  }
  return valid ? (
    <a className="source-link" href={url} target="_blank" rel="noopener noreferrer">
      {children ?? url}
    </a>
  ) : (
    <span className="source-link">{children ?? url}</span>
  );
}

function SourceDetail({
  id,
  version,
  disabled,
  onCollect,
  onClose,
}: {
  id: string;
  version: number;
  disabled: boolean;
  onCollect: (url: string) => void;
  onClose: () => void;
}) {
  const [source, setSource] = useState<Source | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [reload, setReload] = useState(0);
  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    setError('');
    setSource(null);
    void api<Source>(`/sources/${id}`, { signal: controller.signal })
      .then((value) => {
        if (!controller.signal.aborted) setSource(value);
      })
      .catch((failure) => {
        if (!controller.signal.aborted) setError(errorMessage(failure));
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  }, [id, version, reload]);
  return (
    <Modal open title="资料详情" width={820} footer={null} onCancel={onClose}>
      {loading && <Spin />}
      {error && (
        <Alert
          type="error"
          showIcon
          message={error}
          action={<Button onClick={() => setReload((x) => x + 1)}>重新读取</Button>}
        />
      )}
      {source && (
        <>
          <h2 className="source-detail-title">{source.title || '未命名资料'}</h2>
          <SourceLink url={source.url} />
          {source.resolvedUrl && source.resolvedUrl !== source.url && (
            <p className="secondary">
              实际页面：
              <SourceLink url={source.resolvedUrl} />
            </p>
          )}
          <p className="secondary">
            获取于 {date(source.fetchedAt)}
            {source.publishedAt
              ? ` · 原文发布于 ${date(source.publishedAt)}`
              : ' · 原文发布时间未知'}
          </p>
          {source.feedUrl && (
            <p className="secondary">
              RSS 来源：
              <SourceLink url={source.feedUrl} />
            </p>
          )}
          {source.contentKind === 'feed' && (
            <Alert
              type="info"
              showIcon
              message="这是 RSS 提供的文字，可能仅为摘要。需要全文时，请明确抓取原文页面。"
            />
          )}
          <div className="source-body" aria-label="已保存资料内容">
            {source.text || '此条资料还没有可用文字，可尝试抓取正文。'}
          </div>
          <p className="form-note">
            在文章编辑器的“AI 写文章”中选择这份资料，后台会保存本次使用的内容快照。
          </p>
        </>
      )}
      <div className="modal-actions">
        {source && (
          <Button disabled={disabled} onClick={() => onCollect(source.url)}>
            {source.contentKind === 'feed' ? '抓取正文' : '重新抓取正文'}
          </Button>
        )}
        <Button onClick={onClose}>关闭</Button>
      </div>
    </Modal>
  );
}

export function Sources({ onDirtyChange }: { onDirtyChange: (dirty: boolean) => void }) {
  const [sources, setSources] = useState<Page<SourceSummary> | null>(null);
  const [feeds, setFeeds] = useState<Page<SourceFeed> | null>(null);
  const [jobs, setJobs] = useState<Page<SourceJob> | null>(null);
  const [config, setConfig] = useState<SourceSearchConfig | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState('');
  const [error, setError] = useState('');
  const [page, setPage] = useState(1);
  const [feedPage, setFeedPage] = useState(1);
  const [jobPage, setJobPage] = useState(1);
  const [searchInput, setSearchInput] = useState('');
  const [search, setSearch] = useState('');
  const [query, setQuery] = useState('');
  const [sourceUrl, setSourceUrl] = useState('');
  const [feedUrl, setFeedUrl] = useState('');
  const [feedTitle, setFeedTitle] = useState('');
  const [selected, setSelected] = useState<string | null>(null);
  const [version, setVersion] = useState(0);
  const [configDirty, setConfigDirty] = useState(false);
  const configDirtyRef = useRef(false);
  const [mutation, setMutation] = useState(false);
  const [posting, setPosting] = useState(false);
  const prepared = useRef<SourceJobInput | null>(pendingRequest());
  const submitting = useRef(false);
  const [unresolved, setUnresolved] = useState(Boolean(prepared.current));
  const [jobId, setJobId] = useState<string | null>(previousJob);
  const { job, error: jobError, loading: jobLoading, refresh: refreshJob } = useSourceJob(jobId);
  const lastCompleted = useRef<string | null>(null);
  const reload = useCallback(() => setVersion((x) => x + 1), []);
  const markDirty = useCallback(
    (dirty: boolean) => {
      configDirtyRef.current = dirty;
      setConfigDirty(dirty);
      onDirtyChange(dirty);
    },
    [onDirtyChange],
  );
  const waitingForJob = Boolean(jobId && (!job || job.id !== jobId));
  const busy =
    posting || unresolved || mutation || waitingForJob || Boolean(job && sourceJobPending(job));
  const searchBlocked =
    (unresolved && prepared.current?.kind === 'SEARCH') ||
    Boolean(job?.kind === 'SEARCH' && sourceJobPending(job));
  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    setLoadError('');
    void Promise.all([
      api<Page<SourceSummary>>(
        `/sources?page=${page}&pageSize=10&search=${encodeURIComponent(search)}`,
        { signal: controller.signal },
      ),
      api<Page<SourceFeed>>(`/sources/feeds?page=${feedPage}&pageSize=5`, {
        signal: controller.signal,
      }),
      api<Page<SourceJob>>(`/sources/jobs?page=${jobPage}&pageSize=5`, {
        signal: controller.signal,
      }),
      api<SourceSearchConfig | null>('/sources/search-config', { signal: controller.signal }),
    ])
      .then(([nextSources, nextFeeds, nextJobs, nextConfig]) => {
        if (controller.signal.aborted) return;
        setSources(nextSources);
        setFeeds(nextFeeds);
        setJobs(nextJobs);
        if (!configDirtyRef.current)
          setConfig((current) =>
            current && (!nextConfig || nextConfig.version < current.version) ? current : nextConfig,
          );
        setLoaded(true);
      })
      .catch((failure) => {
        if (!controller.signal.aborted) setLoadError(errorMessage(failure));
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  }, [page, feedPage, jobPage, search, version]);
  useEffect(() => {
    if (!job || sourceJobPending(job) || lastCompleted.current === job.id) return;
    lastCompleted.current = job.id;
    reload();
  }, [job, reload]);
  useEffect(() => {
    const warn = (event: BeforeUnloadEvent) => {
      if (!configDirty) return;
      event.preventDefault();
      event.returnValue = '';
    };
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, [configDirty]);
  useEffect(() => () => onDirtyChange(false), [onDirtyChange]);

  async function submit(action?: SourceAction) {
    if (
      submitting.current ||
      mutation ||
      (!prepared.current && (waitingForJob || (job && sourceJobPending(job))))
    )
      return;
    setError('');
    let input = prepared.current;
    if (!input) {
      if (!action) return;
      const parsed = sourceJobInput.safeParse({ ...action, requestKey: requestId() });
      if (!parsed.success) {
        setError(parsed.error.issues.map((issue) => issue.message).join('；'));
        return;
      }
      input = parsed.data;
    }
    try {
      sessionStorage.setItem(pendingKey, JSON.stringify(input));
    } catch {
      setError('浏览器无法保存待确认请求，请允许会话存储后重试。本次未发起采集或搜索。');
      return;
    }
    prepared.current = input;
    submitting.current = true;
    setPosting(true);
    setUnresolved(true);
    try {
      const result = await api<SourceJob>('/sources/jobs', {
        method: 'POST',
        ...jsonRequest(input),
      });
      setJobId(result.id);
      try {
        sessionStorage.setItem(lastJobKey, result.id);
        sessionStorage.removeItem(pendingKey);
      } catch {
        /* The persisted nonce still retrieves this exact job after reload. */
      }
      prepared.current = null;
      setUnresolved(false);
      reload();
    } catch (failure) {
      setError(errorMessage(failure));
      if (failure instanceof ApiError && failure.status >= 400 && failure.status < 500) {
        prepared.current = null;
        setUnresolved(false);
        try {
          sessionStorage.removeItem(pendingKey);
        } catch {
          /* A rejected request cannot bill. */
        }
      }
    } finally {
      submitting.current = false;
      setPosting(false);
    }
  }

  async function addFeed(values: { url: string; title?: string }) {
    if (busy) return;
    setMutation(true);
    setError('');
    try {
      await api<SourceFeed>('/sources/feeds', { method: 'POST', ...jsonRequest(values) });
      setFeedPage(1);
      reload();
    } catch (failure) {
      setError(errorMessage(failure));
    } finally {
      setMutation(false);
    }
  }
  async function removeFeed(feed: SourceFeed) {
    if (busy || !window.confirm('取消这项 RSS 订阅？已经保存的资料和历史任务会保留。')) return;
    setMutation(true);
    setError('');
    try {
      await api(`/sources/feeds/${feed.id}`, { method: 'DELETE' });
      setFeedPage(1);
      reload();
    } catch (failure) {
      setError(errorMessage(failure));
    } finally {
      setMutation(false);
    }
  }

  return (
    <>
      <div className="page-heading">
        <div>
          <h1>资料</h1>
          <p className="secondary">采集链接、订阅 RSS 或按需搜索，为写作积累资料。</p>
        </div>
        <Button onClick={reload} loading={loading} aria-label="刷新资料页面">
          刷新
        </Button>
      </div>
      {loadError && (
        <Alert
          type="error"
          showIcon
          message={loadError}
          action={<Button onClick={reload}>重新加载资料</Button>}
        />
      )}
      {error && <Alert type="error" showIcon message={error} />}
      {unresolved && (
        <Alert
          type="warning"
          showIcon
          message={`上次${prepared.current?.kind === 'SEARCH' ? '搜索' : '采集'}请求尚未确认。先取回同一任务，避免重复提交。`}
          action={
            <Button onClick={() => void submit()} loading={posting} aria-label="获取本次资料任务">
              获取本次资料任务
            </Button>
          }
        />
      )}
      <div className="source-grid">
        <section className="surface source-panel" aria-label="链接采集">
          <h2>采集链接</h2>
          <p className="secondary">提取公开网页的标题和文字，不执行网页脚本或下载原站图片。</p>
          <form
            className="workspace-form"
            onSubmit={(event) => {
              event.preventDefault();
              void submit({ kind: 'URL', url: sourceUrl, origin: 'url' });
            }}
          >
            <div className="form-field">
              <label htmlFor="source-url-input">原文链接</label>
              <Input
                id="source-url-input"
                type="url"
                required
                disabled={busy}
                placeholder="https://example.com/article"
                maxLength={4000}
                value={sourceUrl}
                onChange={(event) => setSourceUrl(event.target.value)}
              />
            </div>
            <Button
              htmlType="submit"
              type="primary"
              aria-label="采集链接"
              disabled={busy}
              loading={posting && prepared.current?.kind === 'URL'}
            >
              采集链接
            </Button>
          </form>
          <p className="form-note">
            登录页、付费墙和依赖脚本的页面可能无法提取。失败时不会保存伪正文。
          </p>
        </section>
        <section className="surface source-panel" aria-label="搜索资料">
          <h2>搜索资料</h2>
          <p className="secondary">Tavily 返回候选摘要；明确选择采集后才会保存原文。</p>
          <label className="source-query-label" htmlFor="source-query">
            搜索词
          </label>
          <Input.TextArea
            id="source-query"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            rows={2}
            maxLength={1000}
            disabled={busy}
          />
          <Button
            type="primary"
            aria-label="搜索 Tavily"
            onClick={() => void submit({ kind: 'SEARCH', query })}
            disabled={busy || !loaded || !config?.hasApiKey || configDirty || !query.trim()}
            loading={posting && prepared.current?.kind === 'SEARCH'}
          >
            搜索 Tavily
          </Button>
          <p className="form-note">
            搜索会调用外部服务，可能产生费用，不会自动重试。请先保存下方 Tavily 配置。
          </p>
        </section>
      </div>
      {(jobId || unresolved) && (
        <section className="surface source-panel" aria-label="本次资料任务">
          <div className="source-heading">
            <h2>本次资料任务</h2>
            {job && <SourceJobState state={job.state} />}
          </div>
          {jobLoading && !job && <Spin />}
          {jobError && (
            <Alert
              type="error"
              showIcon
              message={jobError}
              action={<Button onClick={refreshJob}>重新读取任务</Button>}
            />
          )}
          {job && (
            <>
              <p className="source-link">
                {sourceJobLabels[job.kind]} · {job.query || job.url} · {date(job.createdAt)}
              </p>
              {sourceJobPending(job) && (
                <p role="status" className="secondary">
                  后台正在处理，离开后可在最近任务中找回。
                </p>
              )}
              {job.error && (
                <Alert
                  type={job.state === 'UNCERTAIN' ? 'warning' : 'error'}
                  showIcon
                  message={job.error}
                />
              )}
              {job.state === 'UNCERTAIN' && (
                <p className="form-note">
                  请先核对服务记录。再次搜索会发起新的收费请求，系统不会自动重发。
                </p>
              )}
              {job.result && (
                <>
                  {job.kind !== 'SEARCH' && (
                    <p>
                      新建 {job.result.created} 份，更新 {job.result.updated}{' '}
                      份资料；重复链接保留原资料。
                    </p>
                  )}
                  {job.kind === 'SEARCH' && job.result.items.length === 0 && (
                    <Empty description="本次没有搜索到候选结果" />
                  )}
                  {job.result.items.map((item, index) => (
                    <article className="source-result" key={`${item.url}-${index}`}>
                      <h3>{item.title || '未命名搜索结果'}</h3>
                      <SourceLink url={item.url} />
                      <p className="source-snippet">{item.snippet}</p>
                      <Button
                        disabled={busy}
                        onClick={() =>
                          void submit({ kind: 'URL', url: item.url, origin: 'search' })
                        }
                        aria-label={`采集搜索结果：${item.title || item.url}`}
                      >
                        采集这条资料
                      </Button>
                    </article>
                  ))}
                  <div className="source-actions">
                    {job.result.sourceIds.map((id, index) => (
                      <Button key={id} onClick={() => setSelected(id)}>
                        查看资料 {index + 1}
                      </Button>
                    ))}
                  </div>
                </>
              )}
            </>
          )}
          <div className="source-actions">
            <Button onClick={refreshJob} disabled={!jobId}>
              刷新任务
            </Button>
            <Button onClick={() => setJobId(null)}>收起任务</Button>
          </div>
        </section>
      )}
      <section className="surface source-panel" aria-label="RSS 订阅">
        <h2>RSS 订阅</h2>
        <p className="secondary">
          添加 RSS / Atom
          地址后，明确点击拉取获取最新文字。当前不定时抓取，也不自动访问每条原文链接。
        </p>
        <form
          className="source-feed-form workspace-form"
          onSubmit={(event) => {
            event.preventDefault();
            void addFeed({ url: feedUrl, title: feedTitle });
          }}
        >
          <div className="form-field">
            <label htmlFor="source-feed-url">RSS 地址</label>
            <Input
              id="source-feed-url"
              type="url"
              required
              disabled={busy}
              maxLength={4000}
              placeholder="https://example.com/feed.xml"
              value={feedUrl}
              onChange={(event) => setFeedUrl(event.target.value)}
            />
          </div>
          <div className="form-field">
            <label htmlFor="source-feed-title">订阅名称（可选）</label>
            <Input
              id="source-feed-title"
              maxLength={200}
              disabled={busy}
              value={feedTitle}
              onChange={(event) => setFeedTitle(event.target.value)}
            />
          </div>
          <Button htmlType="submit" loading={mutation} disabled={busy} aria-label="添加订阅">
            添加订阅
          </Button>
        </form>
        {!loading && !loadError && feeds?.items.length === 0 && (
          <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="还没有 RSS 订阅" />
        )}
        {feeds?.items.map((feed) => (
          <div className="source-feed-row" key={feed.id}>
            <div>
              <strong>{feed.title || feed.url}</strong>
              <SourceLink url={feed.url} />
              <p className="secondary">
                {feed.lastFetchedAt ? `上次拉取：${date(feed.lastFetchedAt)}` : '尚未拉取'}
              </p>
              {feed.lastError && <p className="inline-error">{feed.lastError}</p>}
            </div>
            <div className="source-actions">
              <Button
                disabled={busy}
                onClick={() => void submit({ kind: 'FEED', feedId: feed.id })}
                aria-label={`拉取订阅：${feed.title || feed.url}`}
              >
                拉取
              </Button>
              <Button
                disabled={busy}
                onClick={() => void removeFeed(feed)}
                aria-label={`取消订阅：${feed.title || feed.url}`}
              >
                取消订阅
              </Button>
            </div>
          </div>
        ))}
        {feeds && feeds.total > 5 && (
          <Pagination
            current={feedPage}
            pageSize={5}
            total={feeds.total}
            onChange={setFeedPage}
            showSizeChanger={false}
          />
        )}
      </section>
      {loaded && (
        <SearchSettings
          key={config?.version ?? 0}
          config={config}
          blocked={Boolean(searchBlocked) || posting}
          onDirty={markDirty}
          onSaved={setConfig}
        />
      )}
      <section className="surface source-panel" aria-label="已保存资料">
        <div className="source-heading">
          <h2>已保存资料</h2>
          <span className="secondary">在 AI 写文章时可选择</span>
        </div>
        <Input.Search
          aria-label="搜索已保存资料"
          placeholder="按标题或内容查找"
          value={searchInput}
          onChange={(event) => setSearchInput(event.target.value)}
          onSearch={() => {
            setSearch(searchInput.trim());
            setPage(1);
          }}
          enterButton="查找"
          maxLength={200}
        />
        {!loaded && loading && <Spin />}
        {!loading && !loadError && sources?.items.length === 0 && (
          <Empty description="还没有匹配的资料" />
        )}
        {sources?.items.map((source) => (
          <button
            className="source-saved-row"
            type="button"
            key={source.id}
            onClick={() => setSelected(source.id)}
          >
            <span>
              <strong>{source.title || source.url}</strong>
              <span className="secondary source-link">{source.url}</span>
              <span className="secondary">
                {source.textLength} 字符 · {date(source.fetchedAt)}
              </span>
            </span>
            <Tag>{source.contentKind === 'feed' ? 'RSS 文字，可能为摘要' : '网页正文'}</Tag>
            <span>查看 →</span>
          </button>
        ))}
        {sources && sources.total > 10 && (
          <Pagination
            current={page}
            pageSize={10}
            total={sources.total}
            onChange={setPage}
            showSizeChanger={false}
          />
        )}
      </section>
      <section className="surface source-panel" aria-label="最近资料任务">
        <h2>最近任务</h2>
        {!loading && !loadError && jobs?.items.length === 0 && (
          <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="还没有采集或搜索任务" />
        )}
        {jobs?.items.map((item) => (
          <button
            type="button"
            className="source-task-row"
            key={item.id}
            onClick={() => {
              setJobId(item.id);
              try {
                sessionStorage.setItem(lastJobKey, item.id);
              } catch {
                /* History remains available. */
              }
            }}
          >
            <span>
              <strong>{sourceJobLabels[item.kind]}</strong>
              <span className="secondary source-link">{item.query || item.url}</span>
              <span className="secondary">{date(item.createdAt)}</span>
            </span>
            <SourceJobState state={item.state} />
            <span>查看 →</span>
          </button>
        ))}
        {jobs && jobs.total > 5 && (
          <Pagination
            current={jobPage}
            pageSize={5}
            total={jobs.total}
            onChange={setJobPage}
            showSizeChanger={false}
          />
        )}
      </section>
      {selected && (
        <SourceDetail
          id={selected}
          version={version}
          disabled={busy}
          onCollect={(url) => {
            setSelected(null);
            void submit({ kind: 'URL', url, origin: 'url' });
          }}
          onClose={() => setSelected(null)}
        />
      )}
    </>
  );
}
