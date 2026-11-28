import { useEffect, useRef, useState } from 'react';
import { Alert, Button, Input, Spin, Tooltip } from './ui';
import { ArrowsInSimple, ArrowsOutSimple, SidebarSimple, FloppyDisk } from '@phosphor-icons/react';
import { EditorContent, useEditor } from '@tiptap/react';
import type { Article, ArticleInput, Asset, DocumentNode } from '@tattoo/contracts';
import { articleInput, initialDocument } from '@tattoo/contracts';
import { api, ApiError, errorMessage, jsonRequest } from '../api';
import { blankArticle, fields, fingerprint } from './article/model';
import { WritingKit, LocalImage, isSafeLink, pasteProblem } from './article/document';
import { ArticleToolbar } from './article/Toolbar';
import { ArticleMetadata } from './article/Metadata';
import { ArticleRevisionActions } from './article/RevisionViews';
import { ArticleLinkDialog } from './article/LinkDialog';
import { ArticleDelivery } from './article/ArticleDelivery';
import { ArticleGeneration } from './ai/ArticleGeneration';
import '../editor.css';

export function ArticleEditor({
  id,
  onBack,
  onDirtyChange,
  remoteWritesEnabled,
  onInspectRecords,
  onConfigureModels,
}: {
  id: string | null;
  onBack: () => void;
  onDirtyChange: (dirty: boolean) => void;
  remoteWritesEnabled: boolean;
  onInspectRecords: () => void;
  onConfigureModels: () => void;
}) {
  const [article, setArticle] = useState<Article | null>(null);
  const [draft, setDraft] = useState<ArticleInput>(blankArticle);
  const [baseline, setBaseline] = useState(() => fingerprint(blankArticle()));
  const [loading, setLoading] = useState(Boolean(id));
  const [loadAttempt, setLoadAttempt] = useState(0);
  const [saving, setSaving] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [conflict, setConflict] = useState(false);
  const [linkOpen, setLinkOpen] = useState(false);
  const [revisionActive, setRevisionActive] = useState(false);
  const [deliveryActive, setDeliveryActive] = useState(false);
  const [aiActive, setAiActive] = useState(false);
  const [metadataOpen, setMetadataOpen] = useState(true);
  const [focusMode, setFocusMode] = useState(false);
  const bodyFile = useRef<HTMLInputElement>(null);
  const coverFile = useRef<HTMLInputElement>(null);
  const mounted = useRef(true);
  const uploadHandler = useRef<(file: File, cover: boolean) => void>(() => undefined);
  const dirty = fingerprint(draft) !== baseline;
  const busy = saving || uploading;
  const overlayActive = revisionActive || deliveryActive || linkOpen || aiActive;
  const editor = useEditor({
    extensions: [
      WritingKit.configure({
        heading: { levels: [2, 3] },
        trailingNode: false,
        link: {
          openOnClick: false,
          autolink: false,
          linkOnPaste: false,
          protocols: ['http', 'https'],
          isAllowedUri: isSafeLink,
          HTMLAttributes: { target: null, rel: 'noopener noreferrer nofollow', class: null },
        },
      }),
      LocalImage,
    ],
    content: initialDocument,
    shouldRerenderOnTransaction: true,
    editorProps: {
      attributes: {
        role: 'textbox',
        'aria-label': '文章正文',
        'aria-multiline': 'true',
        spellcheck: 'true',
      },
      handlePaste: (_view, event) => {
        const files = [...(event.clipboardData?.files ?? [])];
        if (files.length) {
          event.preventDefault();
          if (files.length > 1) {
            setNotice('一次粘贴一张图片，请分次上传；本次未上传任何图片。');
            return true;
          }
          if (files[0]) uploadHandler.current(files[0], false);
          return true;
        }
        const html = event.clipboardData?.getData('text/html');
        if (html) {
          const problem = pasteProblem(html);
          if (problem) {
            setNotice(problem);
            return true;
          }
          setNotice('已粘贴支持的正文结构；字体、颜色和自定义样式使用统一排版。');
        }
        return false;
      },
      handleDrop: (_view, event) => {
        const files = [...(event.dataTransfer?.files ?? [])];
        if (!files.length) {
          const html = event.dataTransfer?.getData('text/html');
          const problem = html ? pasteProblem(html) : null;
          if (problem) {
            setNotice(problem);
            return true;
          }
          return false;
        }
        event.preventDefault();
        if (files.length > 1) {
          setNotice('一次拖入一张图片，请分次上传；本次未上传任何图片。');
          return true;
        }
        if (files[0]) uploadHandler.current(files[0], false);
        return true;
      },
    },
    onUpdate: ({ editor: instance }) => {
      setDraft((current) => ({ ...current, document: instance.getJSON() as DocumentNode }));
      setNotice('');
    },
  });

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  useEffect(() => {
    onDirtyChange(dirty || busy);
    return () => onDirtyChange(false);
  }, [dirty, busy, onDirtyChange]);
  useEffect(() => {
    const beforeUnload = (event: BeforeUnloadEvent) => {
      if (dirty || busy) {
        event.preventDefault();
        event.returnValue = '';
      }
    };
    window.addEventListener('beforeunload', beforeUnload);
    return () => window.removeEventListener('beforeunload', beforeUnload);
  }, [dirty, busy]);
  useEffect(() => {
    editor?.setEditable(!busy && !loading && !overlayActive, false);
  }, [editor, busy, loading, overlayActive]);
  useEffect(() => {
    if (!id || !editor) return;
    const controller = new AbortController();
    setLoading(true);
    setError('');
    api<Article>(`/articles/${id}`, { signal: controller.signal })
      .then((result) => {
        editor.commands.setContent(result.document, { emitUpdate: false });
        const value = { ...fields(result), document: editor.getJSON() as DocumentNode };
        setArticle(result);
        setDraft(value);
        setBaseline(fingerprint(value));
      })
      .catch((failure) => {
        if (!controller.signal.aborted) setError(errorMessage(failure));
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  }, [id, editor, loadAttempt]);

  async function upload(file: File, cover: boolean) {
    if (busy) return;
    if (!['image/jpeg', 'image/png'].includes(file.type)) {
      setError('请选择 JPG 或 PNG 图片。');
      return;
    }
    if (file.size > 10 * 1024 * 1024) {
      setError('单张图片不能超过 10 MiB。');
      return;
    }
    setUploading(true);
    setError('');
    setNotice('正在上传并检查图片…');
    try {
      const asset = await api<Asset>('/assets', {
        method: 'POST',
        body: file,
        headers: { 'Content-Type': file.type, 'X-Filename': encodeURIComponent(file.name) },
        timeoutMs: 30000,
      });
      if (!mounted.current) return;
      if (cover) setDraft((current) => ({ ...current, coverId: asset.id }));
      else
        editor
          ?.chain()
          .focus()
          .insertContent({ type: 'image', attrs: { assetId: asset.id, alt: file.name } })
          .run();
      setNotice(cover ? '封面已上传，请保存文章。' : '图片已插入正文，请保存文章。');
    } catch (failure) {
      if (mounted.current) setError(errorMessage(failure));
    } finally {
      if (mounted.current) setUploading(false);
    }
  }
  uploadHandler.current = (file, cover) => {
    void upload(file, cover);
  };

  async function save() {
    if (!editor || busy || loading || overlayActive || (id && !article)) return;
    setError('');
    setNotice('');
    const parsed = articleInput.safeParse({ ...draft, document: editor.getJSON() });
    if (!parsed.success) {
      setError(parsed.error.issues[0]?.message ?? '请检查文章格式。');
      return;
    }
    setSaving(true);
    try {
      const result = await api<Article>(article ? `/articles/${article.id}` : '/articles', {
        method: article ? 'PATCH' : 'POST',
        ...jsonRequest(
          article ? { ...parsed.data, expectedVersion: article.version } : parsed.data,
        ),
      });
      editor.commands.setContent(result.document, { emitUpdate: false });
      const value = { ...fields(result), document: editor.getJSON() as DocumentNode };
      setNotice(
        article?.revisionId === result.revisionId
          ? `内容未变化，仍为修订 v${result.version}。`
          : `已保存为修订 v${result.version}。`,
      );
      setArticle(result);
      setDraft(value);
      setBaseline(fingerprint(value));
      setConflict(false);
    } catch (failure) {
      if (failure instanceof ApiError && failure.status === 409) {
        setConflict(true);
        setError(
          '保存冲突：文章已在另一处更新。你的本地编辑仍保留，请先复制需要保留的内容，再加载最新修订。',
        );
      } else setError(errorMessage(failure));
    } finally {
      setSaving(false);
    }
  }

  async function reloadLatest() {
    if (!article || busy || !window.confirm('加载最新修订将替换当前未保存的编辑。确定继续吗？'))
      return;
    setLoading(true);
    setError('');
    try {
      const result = await api<Article>(`/articles/${article.id}`);
      editor?.commands.setContent(result.document, { emitUpdate: false });
      const value = {
        ...fields(result),
        document: (editor?.getJSON() ?? result.document) as DocumentNode,
      };
      setArticle(result);
      setDraft(value);
      setBaseline(fingerprint(value));
      setConflict(false);
      setNotice('已加载最新修订。');
    } catch (failure) {
      setError(errorMessage(failure));
    } finally {
      setLoading(false);
    }
  }

  const update = (key: keyof Omit<ArticleInput, 'document' | 'coverId'>, value: string) => {
    setDraft((current) => ({ ...current, [key]: value }));
    setNotice('');
  };
  const back = () => {
    if (
      (dirty || busy) &&
      !window.confirm('文章有未保存修改或正在处理的操作。确定离开并放弃本地编辑吗？')
    )
      return;
    onBack();
  };
  useEffect(() => {
    const keydown = (event: KeyboardEvent) => {
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 's') {
        event.preventDefault();
        void save();
      }
    };
    window.addEventListener('keydown', keydown);
    return () => window.removeEventListener('keydown', keydown);
  });

  return (
    <div className={`article-workspace${focusMode ? ' is-focused' : ''}`}>
      <div className="article-topline">
        <Button type="text" onClick={back}>
          ← 返回内容列表
        </Button>
        <span
          className={`save-state${dirty ? ' is-unsaved' : ''}`}
          role="status"
          aria-live="polite"
        >
          {loading
            ? '正在打开文章…'
            : uploading
              ? '图片处理中…'
              : saving
                ? '正在保存…'
                : dirty
                  ? '有未保存修改'
                  : article
                    ? `已保存 · 修订 v${article.version}`
                    : '新文章 · 尚未保存'}
        </span>
      </div>
      <div className="page-heading article-heading">
        <div>
          <h1>{id || article ? '编辑文章' : '新建文章'}</h1>
          <p className="secondary">每次保存，保留一份可回看的修订。</p>
        </div>
        <div className="article-actions">
          <ArticleRevisionActions
            article={article}
            dirty={dirty}
            busy={busy || loading || deliveryActive || linkOpen || aiActive}
            onNotice={setNotice}
            onError={setError}
            onActivityChange={setRevisionActive}
          />
          <ArticleDelivery
            article={article}
            dirty={dirty}
            busy={busy || loading || revisionActive || linkOpen || aiActive}
            remoteWritesEnabled={remoteWritesEnabled}
            onNotice={setNotice}
            onInspectRecords={onInspectRecords}
            onActivityChange={setDeliveryActive}
          />
          <Button
            type="primary"
            aria-label="保存文章"
            aria-keyshortcuts="Control+s Meta+s"
            title="保存文章（Ctrl / ⌘ + S）"
            onClick={() => void save()}
            loading={saving}
            disabled={busy || loading || overlayActive || Boolean(id && !article)}
          >
            <FloppyDisk size={16} aria-hidden="true" />
            保存文章
          </Button>
        </div>
      </div>
      <div className="writing-view-controls" aria-label="写作视图">
        <span className="writing-shortcut-hint">
          手动保存 <kbd>Ctrl / ⌘ S</kbd>
        </span>
        <Tooltip title={metadataOpen ? '收起文章信息，扩大写作区域' : '展开作者、摘要和封面设置'}>
          <Button
            type="text"
            size="small"
            aria-label="文章信息"
            aria-controls="article-metadata-panel"
            aria-expanded={metadataOpen && !focusMode}
            onClick={() => {
              if (focusMode) {
                setFocusMode(false);
                setMetadataOpen(true);
              } else setMetadataOpen((value) => !value);
            }}
          >
            <SidebarSimple size={16} aria-hidden="true" />
            文章信息
          </Button>
        </Tooltip>
        <Tooltip title={focusMode ? '显示文章信息和 AI 创作工具' : '收起辅助面板，专注正文'}>
          <Button
            type="text"
            size="small"
            aria-label={focusMode ? '退出专注写作' : '专注写作'}
            aria-pressed={focusMode}
            onClick={() => setFocusMode((value) => !value)}
          >
            {focusMode ? (
              <ArrowsInSimple size={16} aria-hidden="true" />
            ) : (
              <ArrowsOutSimple size={16} aria-hidden="true" />
            )}
            {focusMode ? '退出专注' : '专注写作'}
          </Button>
        </Tooltip>
      </div>
      <div hidden={focusMode}>
        <ArticleGeneration
          articleId={article?.id ?? id}
          draft={draft}
          editor={editor}
          disabled={
            busy ||
            loading ||
            revisionActive ||
            deliveryActive ||
            linkOpen ||
            Boolean(id && !article)
          }
          onActivityChange={setAiActive}
          onAdoptArticle={(result) => {
            editor?.commands.setContent(result.document, { emitUpdate: false });
            setDraft((current) => ({
              ...current,
              title: result.title,
              digest: result.digest,
              document: result.document,
            }));
          }}
          onAdoptCover={(coverId) => setDraft((current) => ({ ...current, coverId }))}
          onNotice={setNotice}
          onConfigureModels={onConfigureModels}
        />
      </div>
      {error && (
        <Alert
          type="error"
          showIcon
          message={error}
          action={
            conflict ? (
              <Button size="small" onClick={() => void reloadLatest()}>
                加载最新修订
              </Button>
            ) : id && !article ? (
              <Button size="small" onClick={() => setLoadAttempt((value) => value + 1)}>
                重新加载文章
              </Button>
            ) : undefined
          }
        />
      )}
      {notice && <Alert type="info" showIcon message={notice} />}
      {loading ? (
        <div className="surface loading-panel">
          <Spin />
          <p className="secondary">正在读取已保存内容…</p>
        </div>
      ) : id && !article ? (
        <div className="surface loading-panel">
          <p className="secondary">暂时无法打开文章，请重新加载。</p>
        </div>
      ) : (
        <div className={`article-layout${!metadataOpen || focusMode ? ' without-metadata' : ''}`}>
          <section className="surface writing-surface" aria-label="文章编辑器">
            <div className="article-title-field">
              <label htmlFor="article-title">标题</label>
              <Input.TextArea
                id="article-title"
                className="article-title-input"
                rows={1}
                value={draft.title}
                placeholder="未命名文章"
                disabled={busy || overlayActive}
                onChange={(event) => update('title', event.target.value)}
              />
            </div>
            <label className="body-label">正文</label>
            <ArticleToolbar
              editor={editor}
              disabled={busy || overlayActive}
              onImage={() => bodyFile.current?.click()}
              onLink={() => {
                setLinkOpen(true);
              }}
            />
            <EditorContent editor={editor} className="article-editor" />
            <div className="editor-footnote">
              <span>支持标题、列表、引用、代码与图片；粘贴内容使用统一排版。</span>
              <span>
                保存快捷键 <kbd>Ctrl / ⌘ S</kbd>
              </span>
            </div>
          </section>
          <div id="article-metadata-panel" hidden={!metadataOpen || focusMode}>
            <ArticleMetadata
              draft={draft}
              article={article}
              disabled={busy || overlayActive}
              onChange={update}
              onCover={() => coverFile.current?.click()}
              onRemoveCover={() => setDraft((current) => ({ ...current, coverId: null }))}
            />
          </div>
        </div>
      )}
      <input
        ref={bodyFile}
        type="file"
        accept="image/jpeg,image/png"
        className="visually-hidden"
        aria-label="上传正文图片"
        data-testid="body-image-input"
        onChange={(event) => {
          const file = event.target.files?.[0];
          event.target.value = '';
          if (file) void upload(file, false);
        }}
      />
      <input
        ref={coverFile}
        type="file"
        accept="image/jpeg,image/png"
        className="visually-hidden"
        aria-label="上传文章封面"
        data-testid="cover-image-input"
        onChange={(event) => {
          const file = event.target.files?.[0];
          event.target.value = '';
          if (file) void upload(file, true);
        }}
      />
      <ArticleLinkDialog open={linkOpen} editor={editor} onClose={() => setLinkOpen(false)} />
    </div>
  );
}
