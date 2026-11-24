import { useCallback, useEffect, useState } from 'react';
import { Alert, Button, Input, Modal, Spin, Tag } from 'antd';
import type {
  AiGenerationJob,
  AiGenerationKind,
  AiGenerationResult,
  AiGenerationState,
  AiProtocol,
  DocumentNode,
} from '@tattoo/contracts';
import { api, errorMessage } from '../../api';
import { date } from '../../ui';

export const generationLabels: Record<AiGenerationKind, string> = {
  ARTICLE: '文章生成',
  REWRITE: '内容改写',
  COVER: '封面生成',
  ILLUSTRATION: '插图生成',
  TEST_TEXT: '文本模型验证',
  TEST_IMAGE: '图片模型验证',
};

export const protocolLabels: Record<AiProtocol, string> = {
  'chat-completions': 'Chat Completions',
  responses: 'Responses',
  'anthropic-messages': 'Anthropic Messages',
  'images-generations': 'Images Generations',
};

const states: Record<AiGenerationState, { label: string; color: string }> = {
  QUEUED: { label: '排队中', color: 'default' },
  RUNNING: { label: '生成中', color: 'processing' },
  SUCCEEDED: { label: '已生成', color: 'success' },
  FAILED: { label: '生成失败', color: 'error' },
  UNCERTAIN: { label: '结果未取回', color: 'warning' },
};

export const generationPending = (job: { state: AiGenerationState }) =>
  job.state === 'QUEUED' || job.state === 'RUNNING';

export function documentText(node: DocumentNode): string {
  if (node.type === 'text') return node.text ?? '';
  if (node.type === 'hardBreak') return '\n';
  const separator = ['doc', 'bulletList', 'orderedList', 'listItem', 'blockquote'].includes(
    node.type,
  )
    ? '\n\n'
    : '';
  return (node.content ?? []).map(documentText).join(separator);
}

export function GenerationState({ state }: { state: AiGenerationState }) {
  const value = states[state];
  return <Tag color={value.color}>{value.label}</Tag>;
}

export function useGenerationJob(id: string | null, enabled = true) {
  const [job, setJob] = useState<AiGenerationJob | null>(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const [version, setVersion] = useState(0);
  const refresh = useCallback(() => setVersion((current) => current + 1), []);
  useEffect(() => {
    setJob(null);
    setError('');
  }, [id]);
  useEffect(() => {
    if (!id || !enabled) return;
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const load = async () => {
      setLoading(true);
      try {
        const result = await api<AiGenerationJob>(`/ai/jobs/${id}`, {
          signal: controller.signal,
        });
        if (controller.signal.aborted) return;
        setJob(result);
        setError('');
        if (generationPending(result)) timer = setTimeout(() => void load(), 1500);
      } catch (failure) {
        if (!controller.signal.aborted) setError(errorMessage(failure));
      } finally {
        if (!controller.signal.aborted) setLoading(false);
      }
    };
    void load();
    return () => {
      controller.abort();
      clearTimeout(timer);
    };
  }, [id, enabled, version]);
  return { job, error, loading, refresh };
}

export function GenerationResult({ result }: { result: AiGenerationResult }) {
  if (result.type === 'image')
    return (
      <figure className="ai-image-result">
        <img src={result.asset.url} alt="AI 生成的候选图片" />
        <figcaption>
          候选图片 · {result.asset.mime === 'image/jpeg' ? 'JPG' : 'PNG'} ·{' '}
          {Math.max(1, Math.round(result.asset.size / 1024))} KB
        </figcaption>
      </figure>
    );
  if (result.type === 'text')
    return (
      <Input.TextArea
        aria-label="生成的文字内容"
        value={result.text}
        readOnly
        autoSize={{ minRows: 5, maxRows: 16 }}
      />
    );
  return (
    <section className="ai-article-result" aria-label="生成的文章候选">
      <h3>{result.title}</h3>
      {result.digest && <p className="secondary">{result.digest}</p>}
      <div className="ai-result-body">{documentText(result.document)}</div>
    </section>
  );
}

export function GenerationProgress({ job }: { job: AiGenerationJob }) {
  return (
    <div className="ai-job-progress" aria-label="生成任务状态">
      <div className="ai-job-heading">
        <GenerationState state={job.state} />
        <span>{job.model}</span>
      </div>
      {generationPending(job) && (
        <p role="status" className="secondary">
          <Spin size="small" />
          {job.state === 'QUEUED' ? '等待后台处理，关闭窗口后仍会继续。' : '模型正在生成，请稍候。'}
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
        <p className="form-note">未收到可用结果。再次生成会发起新的模型调用，可能产生额外费用。</p>
      )}
    </div>
  );
}

export function GenerationDetail({ id, onClose }: { id: string; onClose: () => void }) {
  const { job, error, loading, refresh } = useGenerationJob(id);
  return (
    <Modal open title="生成任务详情" width={760} footer={null} onCancel={onClose}>
      {error && <Alert type="error" showIcon message={error} />}
      {!job && loading && (
        <div className="loading-panel">
          <Spin />
        </div>
      )}
      {job && (
        <>
          <p className="secondary">
            {generationLabels[job.kind]} · {protocolLabels[job.protocol]} · {date(job.createdAt)}
          </p>
          <GenerationProgress job={job} />
          {job.prompt && <p className="ai-task-prompt">{job.prompt}</p>}
          {job.result && <GenerationResult result={job.result} />}
          <p className="form-note">
            文章和图片候选需要在编辑页明确采用并保存，生成本身不会投递到微信。
          </p>
        </>
      )}
      <div className="modal-actions">
        <Button onClick={refresh} aria-label="刷新生成任务" loading={loading}>
          刷新
        </Button>
        <Button onClick={onClose}>关闭</Button>
      </div>
    </Modal>
  );
}
