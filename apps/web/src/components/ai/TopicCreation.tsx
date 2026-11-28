import { useEffect, useRef, useState } from 'react';
import { Alert, Button, Empty, Input, Modal, Pagination, Spin, Steps } from '../ui';
import type { AiModels, TopicCreationTask } from '@tattoo/contracts';
import { api, ApiError, errorMessage, jsonRequest, requestId } from '../../api';
import { date, type Page } from '../../ui';
import { GenerationResult, GenerationState, generationPending } from './Generation';

type PendingRequest =
  | { action: 'create'; requestKey: string; topic: string }
  | { action: 'retry-cover' | 'resume-save'; requestKey: string; taskId: string };

const pendingKey = 'tattoo:topic-creation:pending';
const selectedKey = 'tattoo:topic-creation:selected';
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function readPending(): PendingRequest | null {
  try {
    const value: unknown = JSON.parse(sessionStorage.getItem(pendingKey) ?? 'null');
    if (!value || typeof value !== 'object') return null;
    const input = value as Record<string, unknown>;
    if (typeof input.requestKey !== 'string' || !uuid.test(input.requestKey)) return null;
    if (
      input.action === 'create' &&
      typeof input.topic === 'string' &&
      input.topic.trim() &&
      input.topic.length <= 2000
    )
      return { action: 'create', requestKey: input.requestKey, topic: input.topic };
    if (
      (input.action === 'retry-cover' || input.action === 'resume-save') &&
      typeof input.taskId === 'string' &&
      uuid.test(input.taskId)
    )
      return { action: input.action, requestKey: input.requestKey, taskId: input.taskId };
  } catch {
    // Nothing is submitted until a new request has been persisted successfully.
  }
  return null;
}

function readSelected(): string | null {
  try {
    const id = sessionStorage.getItem(selectedKey);
    return id && uuid.test(id) ? id : null;
  } catch {
    return null;
  }
}

const stepIndex: Record<TopicCreationTask['stage'], number> = {
  ARTICLE: 0,
  COVER: 1,
  SAVE: 2,
  DONE: 3,
};

export function TopicCreation({
  open,
  onClose,
  onOpenArticle,
  onConfigureModels,
}: {
  open: boolean;
  onClose: () => void;
  onOpenArticle: (id: string) => void;
  onConfigureModels: () => void;
}) {
  const [pending, setPending] = useState<PendingRequest | null>(readPending);
  const [topic, setTopic] = useState(() => {
    const stored = readPending();
    return stored?.action === 'create' ? stored.topic : '';
  });
  const [selected, setSelected] = useState<string | null>(readSelected);
  const [task, setTask] = useState<TopicCreationTask | null>(null);
  const [items, setItems] = useState<TopicCreationTask[]>([]);
  const [page, setPage] = useState(1);
  const [total, setTotal] = useState(0);
  const [models, setModels] = useState<AiModels | null>(null);
  const [modelsError, setModelsError] = useState('');
  const [loadingModels, setLoadingModels] = useState(false);
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [loadError, setLoadError] = useState('');
  const [version, setVersion] = useState(0);
  const submitting = useRef(false);

  useEffect(() => {
    if (!open) return;
    const controller = new AbortController();
    setLoadingModels(true);
    setModelsError('');
    api<AiModels>('/ai/models', { signal: controller.signal })
      .then((value) => {
        if (!controller.signal.aborted) setModels(value);
      })
      .catch((failure) => {
        if (!controller.signal.aborted) setModelsError(errorMessage(failure));
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoadingModels(false);
      });
    return () => controller.abort();
  }, [open, version]);

  useEffect(() => {
    if (!open) return;
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const load = async () => {
      setLoading(true);
      try {
        const [list, current] = await Promise.all([
          api<Page<TopicCreationTask>>(`/ai/topics?page=${page}&pageSize=10`, {
            signal: controller.signal,
          }),
          selected
            ? api<TopicCreationTask>(`/ai/topics/${selected}`, { signal: controller.signal }).catch(
                (failure: unknown) => {
                  if (failure instanceof ApiError && failure.status === 404) {
                    if (!controller.signal.aborted) {
                      setSelected(null);
                      try {
                        sessionStorage.removeItem(selectedKey);
                      } catch {
                        // The server's task history remains the source of truth.
                      }
                    }
                    return null;
                  }
                  throw failure;
                },
              )
            : Promise.resolve(null),
        ]);
        if (controller.signal.aborted) return;
        setItems(list.items);
        setTotal(list.total);
        setTask(current);
        setLoadError('');
        if (list.items.some(generationPending) || (current && generationPending(current)))
          timer = setTimeout(() => void load(), 1500);
      } catch (failure) {
        if (!controller.signal.aborted) setLoadError(errorMessage(failure));
      } finally {
        if (!controller.signal.aborted) setLoading(false);
      }
    };
    void load();
    return () => {
      controller.abort();
      clearTimeout(timer);
    };
  }, [open, selected, page, version]);

  function selectTask(value: TopicCreationTask) {
    setTask(value);
    setSelected(value.id);
    try {
      sessionStorage.setItem(selectedKey, value.id);
    } catch {
      // The task is also available from the server's history after reopening.
    }
  }

  async function submit(action: PendingRequest) {
    if (submitting.current) return;
    setError('');
    const serialized = JSON.stringify(action);
    try {
      sessionStorage.setItem(pendingKey, serialized);
      if (sessionStorage.getItem(pendingKey) !== serialized) throw new Error('storage unavailable');
    } catch {
      setError('无法保存本次请求标识，尚未发起生成。请允许浏览器会话存储后重试。');
      return;
    }
    setPending(action);
    submitting.current = true;
    setBusy(true);
    try {
      const result = await api<TopicCreationTask>(
        action.action === 'create' ? '/ai/topics' : `/ai/topics/${action.taskId}/${action.action}`,
        {
          method: 'POST',
          ...jsonRequest(
            action.action === 'create'
              ? { requestKey: action.requestKey, topic: action.topic }
              : { requestKey: action.requestKey },
          ),
        },
      );
      selectTask(result);
      setPending(null);
      try {
        if (sessionStorage.getItem(pendingKey) === serialized)
          sessionStorage.removeItem(pendingKey);
      } catch {
        // Replaying a leftover entry only retrieves this same accepted request.
      }
      setPage(1);
      setVersion((current) => current + 1);
    } catch (failure) {
      setError(errorMessage(failure));
      if (failure instanceof ApiError && [400, 404, 409, 422].includes(failure.status)) {
        setPending(null);
        try {
          if (sessionStorage.getItem(pendingKey) === serialized)
            sessionStorage.removeItem(pendingKey);
        } catch {
          // A leftover rejected request can be retrieved safely after storage recovers.
        }
      }
    } finally {
      submitting.current = false;
      setBusy(false);
    }
  }

  function create() {
    if (pending) return void submit(pending);
    const value = topic.trim();
    if (!value || value.length > 2000 || /[\u0000\uD800-\uDFFF]/u.test(value)) {
      setError('请输入有效主题，最多 2000 字符。');
      return;
    }
    void submit({ action: 'create', requestKey: requestId(), topic: value });
  }

  const configured = Boolean(models?.text && models.image);
  const active = Boolean(task && generationPending(task));
  return (
    <Modal open={open} title="主题创作" width={820} footer={null} onCancel={onClose}>
      <p className="secondary">
        输入一个主题，AI 自动构思文章并根据内容生成封面，完成后保存为可编辑的新稿件。
      </p>
      <label className="form-field">
        创作主题
        <Input.TextArea
          aria-label="创作主题"
          value={topic}
          onChange={(event) => setTopic(event.target.value)}
          placeholder="例如：普通人如何把 AI 变成自己的学习助手"
          autoSize={{ minRows: 3, maxRows: 6 }}
          maxLength={2000}
          disabled={busy || Boolean(pending)}
        />
      </label>
      <p className="form-note">
        会调用已配置的文本和图片模型，可能产生两项服务费用。无需提供资料或封面要求；生成后请审阅内容，再决定是否存入微信草稿。
      </p>
      {modelsError && <Alert type="error" showIcon message={modelsError} />}
      {!loadingModels && !modelsError && !configured && (
        <Alert
          type="info"
          showIcon
          message="请先配置文本模型和图片模型，两项齐全后才能开始主题创作。"
          action={
            <Button
              size="small"
              onClick={() => {
                onClose();
                onConfigureModels();
              }}
            >
              前往模型配置
            </Button>
          }
        />
      )}
      {error && <Alert type="error" showIcon message={error} />}
      {pending && (
        <Alert
          type="warning"
          showIcon
          message="上次请求尚未确认，取回时会使用原请求标识，不会重复创建同一任务。"
        />
      )}
      <div className="modal-actions">
        <Button
          type="primary"
          aria-label={pending ? '取回上次创作请求' : '生成文章和封面'}
          loading={busy}
          disabled={!pending && (loadingModels || !configured || active || !topic.trim())}
          onClick={create}
        >
          {pending ? '取回上次创作请求' : '生成文章和封面'}
        </Button>
        <Button onClick={() => setVersion((current) => current + 1)} disabled={busy}>
          刷新创作任务
        </Button>
      </div>
      {loadError && <Alert type="error" showIcon message={loadError} />}
      {task && (
        <section className="topic-current-task" aria-label="本次主题创作">
          <div className="ai-job-heading">
            <h3>{task.topic}</h3>
            <GenerationState state={task.state} />
          </div>
          <Steps
            size="small"
            current={stepIndex[task.stage]}
            status={['FAILED', 'UNCERTAIN'].includes(task.state) ? 'error' : 'process'}
            items={[{ title: '生成文章' }, { title: '生成封面' }, { title: '保存成稿' }]}
          />
          {generationPending(task) && (
            <p role="status" className="secondary">
              <Spin size="small" />{' '}
              {task.state === 'QUEUED'
                ? '等待后台处理，关闭窗口或切换页面后仍会继续。'
                : task.stage === 'ARTICLE'
                  ? '正在根据主题构思并生成文章…'
                  : task.stage === 'COVER'
                    ? '文章已生成，正在根据内容生成封面…'
                    : '图文已生成，正在保存新稿件…'}
            </p>
          )}
          {task.error && (
            <Alert
              type={task.state === 'UNCERTAIN' ? 'warning' : 'error'}
              showIcon
              message={task.error}
            />
          )}
          {task.canRetryCover && (
            <div className="topic-retry-cover">
              <p className="form-note">
                已保留生成的文章。仅重新生成封面会发起一次新的图片请求，不会重新生成文章。
                {task.state === 'UNCERTAIN' && '上次调用可能已收费，请先核对模型服务记录。'}
              </p>
              <Button
                aria-label="仅重新生成封面"
                disabled={busy || Boolean(pending)}
                onClick={() =>
                  void submit({ action: 'retry-cover', requestKey: requestId(), taskId: task.id })
                }
              >
                仅重新生成封面
              </Button>
            </div>
          )}
          {task.canResumeSave && (
            <div className="topic-resume-save">
              <p className="form-note">文章与封面已保留，完成保存不会再次调用模型。</p>
              <Button
                aria-label="完成成稿保存"
                disabled={busy || Boolean(pending)}
                onClick={() =>
                  void submit({ action: 'resume-save', requestKey: requestId(), taskId: task.id })
                }
              >
                完成保存
              </Button>
            </div>
          )}
          {task.articleResult && task.state !== 'SUCCEEDED' && (
            <details className="topic-article-preview">
              <summary>查看已生成的文章</summary>
              <GenerationResult result={task.articleResult} />
            </details>
          )}
          {task.state === 'SUCCEEDED' && task.articleId && (
            <div className="modal-actions">
              <p className="secondary">文章和封面已保存，可打开检查、修改和预览。</p>
              <Button
                type="primary"
                onClick={() => {
                  onClose();
                  onOpenArticle(task.articleId!);
                }}
              >
                打开成稿编辑
              </Button>
            </div>
          )}
        </section>
      )}
      <section className="topic-task-history" aria-label="主题创作记录">
        <h3>创作记录</h3>
        {!items.length && loading ? (
          <Spin />
        ) : !items.length ? (
          <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="还没有主题创作记录" />
        ) : (
          <div className="topic-task-list">
            {items.map((item) => (
              <button
                type="button"
                className={`topic-task-row${selected === item.id ? ' selected' : ''}`}
                key={item.id}
                onClick={() => selectTask(item)}
              >
                <span>
                  <strong>{item.topic}</strong>
                  <span className="secondary">{date(item.createdAt)}</span>
                </span>
                <GenerationState state={item.state} />
              </button>
            ))}
          </div>
        )}
        {total > 10 && (
          <Pagination
            className="pagination"
            current={page}
            pageSize={10}
            total={total}
            showSizeChanger={false}
            onChange={setPage}
          />
        )}
      </section>
    </Modal>
  );
}
