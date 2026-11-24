import { useEffect, useRef, useState } from 'react';
import { Alert, Button, Input, Modal, Radio } from 'antd';
import type { Editor } from '@tiptap/react';
import type {
  AiGenerationInput,
  AiGenerationJob,
  AiGenerationKind,
  AiGenerationResult,
  AiModels,
  ArticleInput,
  DocumentNode,
} from '@tattoo/contracts';
import { aiGenerationInput } from '@tattoo/contracts';
import { api, ApiError, errorMessage, jsonRequest, requestId } from '../../api';
import { fingerprint } from '../article/model';
import { SourcePicker } from '../sources/SourcePicker';
import {
  GenerationProgress,
  GenerationResult,
  generationPending,
  useGenerationJob,
} from './Generation';

type CreationKind = Extract<AiGenerationKind, 'ARTICLE' | 'REWRITE' | 'COVER' | 'ILLUSTRATION'>;
type RewriteScope = 'document' | 'selection';
type AdoptionContext = {
  fingerprint: string;
  document: string;
  scope: RewriteScope;
  from: number;
  to: number;
  selectionTrusted: boolean;
};
type StoredTask = { id: string; scope: RewriteScope };
type PendingTask = { input: AiGenerationInput; scope: RewriteScope };

const labels: Record<CreationKind, string> = {
  ARTICLE: 'AI 写文章',
  REWRITE: 'AI 改写',
  COVER: '生成封面',
  ILLUSTRATION: '生成插图',
};

function readTask(key: string): StoredTask | null {
  try {
    const value: unknown = JSON.parse(sessionStorage.getItem(key) ?? 'null');
    if (!value || typeof value !== 'object') return null;
    const item = value as Record<string, unknown>;
    return typeof item.id === 'string' && (item.scope === 'selection' || item.scope === 'document')
      ? { id: item.id, scope: item.scope }
      : null;
  } catch {
    return null;
  }
}

function readPendingTask(key: string, kind: CreationKind): PendingTask | null {
  try {
    const value: unknown = JSON.parse(sessionStorage.getItem(key) ?? 'null');
    if (!value || typeof value !== 'object') return null;
    const stored = value as Record<string, unknown>;
    const input = aiGenerationInput.safeParse(stored.input);
    if (
      !input.success ||
      input.data.kind !== kind ||
      !['document', 'selection'].includes(String(stored.scope))
    )
      return null;
    return { input: input.data, scope: stored.scope as RewriteScope };
  } catch {
    return null;
  }
}

function hasDocumentContent(node: DocumentNode): boolean {
  if (node.type === 'text') return Boolean(node.text?.trim());
  if (node.type !== 'doc' && node.type !== 'paragraph') return true;
  return (node.content ?? []).some(hasDocumentContent);
}

export function ArticleGeneration({
  articleId,
  draft,
  editor,
  disabled,
  onActivityChange,
  onAdoptArticle,
  onAdoptCover,
  onNotice,
  onConfigureModels,
}: {
  articleId: string | null;
  draft: ArticleInput;
  editor: Editor | null;
  disabled: boolean;
  onActivityChange: (active: boolean) => void;
  onAdoptArticle: (result: Extract<AiGenerationResult, { type: 'article' }>) => void;
  onAdoptCover: (assetId: string) => void;
  onNotice: (text: string) => void;
  onConfigureModels: () => void;
}) {
  const [kind, setKind] = useState<CreationKind | null>(null);
  const [prompt, setPrompt] = useState('');
  const [references, setReferences] = useState('');
  const [sourceIds, setSourceIds] = useState<string[]>([]);
  const [scope, setScope] = useState<RewriteScope>('document');
  const [selectedText, setSelectedText] = useState('');
  const [jobScope, setJobScope] = useState<RewriteScope>('document');
  const [models, setModels] = useState<AiModels | null>(null);
  const [modelsError, setModelsError] = useState('');
  const [modelsLoading, setModelsLoading] = useState(false);
  const [reloadModels, setReloadModels] = useState(0);
  const [jobId, setJobId] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const [unresolved, setUnresolved] = useState(false);
  const [error, setError] = useState('');
  const [adopted, setAdopted] = useState(false);
  const submitting = useRef(false);
  const request = useRef<{ input: AiGenerationInput; context: AdoptionContext } | null>(null);
  const heldRequests = useRef(
    new Map<CreationKind, { input: AiGenerationInput; context: AdoptionContext }>(),
  );
  const contexts = useRef(new Map<string, AdoptionContext>());
  const selectionAtOpen = useRef({ from: 0, to: 0, document: '' });
  const previousArticle = useRef(articleId);
  const {
    job,
    error: jobError,
    loading: jobLoading,
    refresh,
  } = useGenerationJob(jobId, Boolean(kind));
  const open = Boolean(kind);
  const active = pending || unresolved || Boolean(job && generationPending(job));
  const image = kind === 'COVER' || kind === 'ILLUSTRATION';
  const configured = models && Boolean(image ? models.image : models.text);
  const storageKey = (value: CreationKind) => `tattoo:ai:${articleId ?? 'new'}:${value}`;
  useEffect(() => {
    const previous = previousArticle.current;
    previousArticle.current = articleId;
    if (previous !== null || !articleId) return;
    // Saving a new article assigns its ID; keep its original request nonce unchanged.
    for (const value of Object.keys(labels) as CreationKind[]) {
      for (const suffix of ['', ':pending']) {
        const oldKey = `tattoo:ai:new:${value}${suffix}`;
        const newKey = `tattoo:ai:${articleId}:${value}${suffix}`;
        try {
          const stored = sessionStorage.getItem(oldKey);
          if (stored && !sessionStorage.getItem(newKey)) {
            sessionStorage.setItem(newKey, stored);
            sessionStorage.removeItem(oldKey);
          }
        } catch {
          /* The original entry remains usable until the next reload. */
        }
      }
    }
  }, [articleId]);
  useEffect(() => {
    onActivityChange(open);
    return () => onActivityChange(false);
  }, [open, onActivityChange]);
  useEffect(() => {
    if (!open) return;
    const controller = new AbortController();
    setModelsLoading(true);
    setModelsError('');
    api<AiModels>('/ai/models', { signal: controller.signal })
      .then((result) => {
        if (!controller.signal.aborted) setModels(result);
      })
      .catch((failure) => {
        if (!controller.signal.aborted) setModelsError(errorMessage(failure));
      })
      .finally(() => {
        if (!controller.signal.aborted) setModelsLoading(false);
      });
    return () => controller.abort();
  }, [open, reloadModels]);

  function start(value: CreationKind) {
    if (disabled || !editor) return;
    const { from, to } = editor.state.selection;
    const selected = editor.state.doc.textBetween(from, to, '\n');
    selectionAtOpen.current = { from, to, document: JSON.stringify(editor.getJSON()) };
    const storedPending = readPendingTask(`${storageKey(value)}:pending`, value);
    const held =
      heldRequests.current.get(value) ??
      (storedPending
        ? {
            input: storedPending.input,
            context: {
              fingerprint: '',
              document: '',
              scope: storedPending.scope,
              from: 0,
              to: 0,
              selectionTrusted: false,
            },
          }
        : null);
    if (held) heldRequests.current.set(value, held);
    setSelectedText(held?.context.scope === 'selection' ? (held.input.sourceText ?? '') : selected);
    setScope(held?.context.scope ?? (selected.trim() ? 'selection' : 'document'));
    setPrompt(held?.input.prompt ?? (value === 'ARTICLE' ? draft.title : ''));
    setReferences(value === 'ARTICLE' ? (held?.input.sourceText ?? '') : '');
    setSourceIds(value === 'ARTICLE' ? (held?.input.sourceIds ?? []) : []);
    setError('');
    setAdopted(false);
    setModels(null);
    const saved = readTask(storageKey(value));
    setJobId(saved?.id ?? null);
    setJobScope(saved?.scope ?? 'document');
    request.current = held ?? null;
    setUnresolved(Boolean(held));
    setKind(value);
  }

  async function generate() {
    if (
      !kind ||
      !editor ||
      pending ||
      submitting.current ||
      (job && generationPending(job)) ||
      (!unresolved && jobId && !job)
    )
      return;
    setError('');
    let current = request.current;
    if (!current) {
      if (!configured) return;
      if (!prompt.trim()) {
        setError('请填写生成要求。');
        return;
      }
      const selection = selectionAtOpen.current;
      const sourceText =
        kind === 'ARTICLE'
          ? references
          : kind === 'REWRITE'
            ? scope === 'selection'
              ? selectedText
              : editor.getText({ blockSeparator: '\n' })
            : editor.getText({ blockSeparator: '\n' });
      if (kind === 'REWRITE' && !sourceText.trim()) {
        setError('当前没有可改写的文字，请先输入正文或选择一段文字。');
        return;
      }
      if (sourceText.length > 80000) {
        setError('参考或原文超过 80000 个字符，请缩短后再生成。');
        return;
      }
      current = {
        input: {
          requestKey: requestId(),
          kind,
          prompt: prompt.trim(),
          ...(sourceText ? { sourceText } : {}),
          ...(kind === 'ARTICLE' && sourceIds.length ? { sourceIds } : {}),
          ...(articleId ? { articleId } : {}),
        },
        context: {
          fingerprint: fingerprint(draft),
          document:
            kind === 'REWRITE' && scope === 'selection'
              ? selection.document
              : JSON.stringify(editor.getJSON()),
          scope,
          from: selection.from,
          to: selection.to,
          selectionTrusted: true,
        },
      };
      request.current = current;
      heldRequests.current.set(kind, current);
    }
    try {
      sessionStorage.setItem(
        `${storageKey(kind)}:pending`,
        JSON.stringify({ input: current.input, scope: current.context.scope }),
      );
    } catch {
      if (!unresolved) {
        request.current = null;
        heldRequests.current.delete(kind);
      }
      setError('浏览器无法保存待确认请求，请允许此页面使用会话存储后重试。本次未调用模型。');
      return;
    }
    submitting.current = true;
    setPending(true);
    setUnresolved(true);
    try {
      const result = await api<AiGenerationJob>('/ai/jobs', {
        method: 'POST',
        ...jsonRequest(current.input),
      });
      contexts.current.set(result.id, current.context);
      setJobScope(current.context.scope);
      setJobId(result.id);
      setAdopted(false);
      try {
        sessionStorage.setItem(
          storageKey(kind),
          JSON.stringify({ id: result.id, scope: current.context.scope }),
        );
        sessionStorage.removeItem(`${storageKey(kind)}:pending`);
      } catch {
        /* Recent tasks remain available on the models page. */
      }
      request.current = null;
      heldRequests.current.delete(kind);
      setUnresolved(false);
    } catch (failure) {
      setError(errorMessage(failure));
      if (failure instanceof ApiError && failure.status >= 400 && failure.status < 500) {
        request.current = null;
        heldRequests.current.delete(kind);
        try {
          sessionStorage.removeItem(`${storageKey(kind)}:pending`);
        } catch {
          /* Retrying the stored nonce remains safe. */
        }
        setUnresolved(false);
      }
    } finally {
      submitting.current = false;
      setPending(false);
    }
  }

  function adopt() {
    if (!editor || !job?.result || adopted || pending || unresolved || job.state !== 'SUCCEEDED')
      return;
    setError('');
    const result = job.result;
    const context = contexts.current.get(job.id);
    if (result.type === 'article') {
      const hasContent = Boolean(
        draft.title.trim() ||
        draft.digest.trim() ||
        hasDocumentContent(editor.getJSON() as DocumentNode),
      );
      const changed = context && context.fingerprint !== fingerprint(draft);
      if (
        (hasContent || changed) &&
        !window.confirm(
          '采用这篇 AI 文章将替换当前标题、摘要和正文。当前内容可以先复制保留；采用后仍需点击保存文章。确定采用吗？',
        )
      )
        return;
      onAdoptArticle(result);
    } else if (result.type === 'text') {
      if (jobScope === 'selection') {
        if (!context?.selectionTrusted || context.document !== JSON.stringify(editor.getJSON())) {
          setError(
            '原选中文字已变化，或页面重新打开后无法确认原位置。请复制候选文字手动采用，或重新选择原文生成。',
          );
          return;
        }
        const nodes: DocumentNode[] = result.text
          .split(/\n{2,}/)
          .filter(Boolean)
          .map((text) => ({ type: 'paragraph', content: [{ type: 'text', text }] }));
        editor.chain().focus().insertContentAt({ from: context.from, to: context.to }, nodes).run();
      } else {
        if (
          !window.confirm(
            '采用改写将替换当前正文，包括正文图片和排版；标题、摘要与封面保持不变。采用后仍需保存文章。确定采用吗？',
          )
        )
          return;
        const nodes: DocumentNode[] = result.text
          .split(/\n{2,}/)
          .filter(Boolean)
          .map((text) => ({ type: 'paragraph', content: [{ type: 'text', text }] }));
        editor.commands.setContent({
          type: 'doc',
          content: nodes.length ? nodes : [{ type: 'paragraph' }],
        });
      }
    } else if (job.kind === 'COVER') {
      if (
        draft.coverId &&
        !window.confirm('将这张候选图片设为文章封面？保存后成为新修订，历史修订中的图片会保留。')
      )
        return;
      onAdoptCover(result.asset.id);
    } else {
      editor
        .chain()
        .focus()
        .insertContent({ type: 'image', attrs: { assetId: result.asset.id, alt: 'AI 生成插图' } })
        .run();
    }
    setAdopted(true);
    setKind(null);
    onNotice('AI 候选已采用到当前编辑内容，请检查后保存文章。');
  }

  return (
    <>
      <div className="ai-editor-actions" aria-label="AI 创作">
        {(['ARTICLE', 'REWRITE', 'COVER', 'ILLUSTRATION'] as const).map((value) => (
          <Button
            key={value}
            aria-label={labels[value]}
            onClick={() => start(value)}
            disabled={disabled || !editor}
          >
            {labels[value]}
          </Button>
        ))}
      </div>
      <Modal
        open={open}
        title={kind ? labels[kind] : 'AI 创作'}
        width={780}
        footer={null}
        onCancel={() => {
          if (!pending) setKind(null);
        }}
        closable={!pending}
        keyboard={!pending}
        maskClosable={false}
      >
        <p className="secondary">
          生成会调用你配置的模型，可能产生服务费用。候选结果由你明确采用，生成本身不会保存或投递文章。
        </p>
        {modelsError && (
          <Alert
            type="error"
            showIcon
            message={modelsError}
            action={
              <Button size="small" onClick={() => setReloadModels((value) => value + 1)}>
                重新读取配置
              </Button>
            }
          />
        )}
        {!modelsLoading && models && !configured && (
          <Alert
            type="info"
            showIcon
            message={image ? '尚未配置图片模型' : '尚未配置文本模型'}
            action={
              <Button size="small" onClick={onConfigureModels}>
                前往模型配置
              </Button>
            }
          />
        )}
        {kind === 'REWRITE' && (
          <div className="ai-input-field">
            <span className="field-label">改写范围</span>
            <Radio.Group
              value={scope}
              onChange={(event) => setScope(event.target.value as RewriteScope)}
              disabled={active}
              aria-label="改写范围"
            >
              <Radio value="document">整篇正文</Radio>
              <Radio value="selection" disabled={!selectedText.trim()}>
                选中文字
              </Radio>
            </Radio.Group>
            {scope === 'selection' && (
              <Input.TextArea
                aria-label="选中的原文"
                value={selectedText}
                readOnly
                autoSize={{ minRows: 2, maxRows: 6 }}
              />
            )}
          </div>
        )}
        <div className="ai-input-field">
          <label htmlFor="ai-generation-prompt">
            {kind === 'ARTICLE' ? '主题与写作要求' : kind === 'REWRITE' ? '改写要求' : '图片要求'}
          </label>
          <Input.TextArea
            id="ai-generation-prompt"
            value={prompt}
            onChange={(event) => setPrompt(event.target.value)}
            rows={3}
            maxLength={6000}
            disabled={active}
            placeholder={
              image ? '描述画面、风格、构图和需要避免的元素' : '描述主题、读者、语气和篇幅等要求'
            }
          />
        </div>
        {kind === 'ARTICLE' && (
          <SourcePicker value={sourceIds} onChange={setSourceIds} disabled={active} />
        )}
        {kind === 'ARTICLE' && (
          <div className="ai-input-field">
            <label htmlFor="ai-generation-references">参考资料（可选）</label>
            <Input.TextArea
              id="ai-generation-references"
              value={references}
              onChange={(event) => setReferences(event.target.value)}
              rows={3}
              maxLength={80000}
              disabled={active}
              placeholder="粘贴本次创作希望参考的内容"
            />
          </div>
        )}
        {error && <Alert type="error" showIcon message={error} />}
        {unresolved && !pending && (
          <p className="form-note">
            请求结果尚未取回。再次点击只获取同一请求的任务，不会自动发起新一轮生成；也可在模型配置页查看最近任务。
          </p>
        )}
        {jobError && (
          <Alert
            type="error"
            showIcon
            message={jobError}
            action={
              <Button size="small" onClick={refresh}>
                重新读取任务
              </Button>
            }
          />
        )}
        {job && <GenerationProgress job={job} />}
        {job?.result && (
          <div className="ai-candidate" aria-label="本次生成候选">
            <p className="secondary">生成要求：{job.prompt}</p>
            {job.kind === 'REWRITE' && (
              <p className="form-note">
                本次候选适用范围：{jobScope === 'selection' ? '先前选中的文字' : '整篇正文'}
                。上方改写范围用于下一次生成。
              </p>
            )}
            <GenerationResult result={job.result} />
            {job.kind === 'REWRITE' &&
              jobScope === 'selection' &&
              !contexts.current.get(job.id)?.selectionTrusted && (
                <p className="form-note">
                  这是先前选中文字的改写结果。当前无法确认原位置，请复制文字手动采用。
                </p>
              )}
          </div>
        )}
        <div className="modal-actions ai-generation-footer">
          <Button onClick={() => setKind(null)} disabled={pending}>
            关闭
          </Button>
          <Button
            aria-label={unresolved ? '获取本次生成任务' : job ? '重新生成' : '开始生成'}
            onClick={() => void generate()}
            loading={pending}
            disabled={
              Boolean(job && generationPending(job)) ||
              modelsLoading ||
              (!configured && !unresolved) ||
              (!unresolved && Boolean(jobId && !job)) ||
              jobLoading
            }
          >
            {unresolved ? '获取本次生成任务' : job ? '重新生成' : '开始生成'}
          </Button>
          {job?.result && (
            <Button
              type="primary"
              aria-label="采用生成结果"
              onClick={adopt}
              disabled={adopted || active || job.state !== 'SUCCEEDED'}
            >
              采用生成结果
            </Button>
          )}
        </div>
      </Modal>
    </>
  );
}
