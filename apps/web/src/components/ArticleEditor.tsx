import { useEffect, useRef, useState } from 'react';
import { Alert, Button, Input, Modal, Spin, Tag, Tooltip } from 'antd';
import { EditorContent, Node, useEditor, type Editor } from '@tiptap/react';
import StarterKit from '@tiptap/starter-kit';
import type {
  Article,
  ArticleInput,
  ArticlePreview,
  Asset,
  DocumentNode,
  Revision,
  RevisionSummary,
} from '@tattoo/contracts';
import { articleInput, initialDocument, safeHttpUrl } from '@tattoo/contracts';
import { api, ApiError, errorMessage, jsonRequest } from '../api';
import { date, type Page } from '../ui';
import '../editor.css';

const assetIdPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const assetUrl = (id: string) => `/api/v1/assets/${id}`;

// Only an asset reference is persisted. Browser URLs are derived at render time.
const LocalImage = Node.create({
  name: 'image',
  group: 'block',
  atom: true,
  draggable: true,
  addAttributes() {
    return {
      assetId: {
        default: null,
        parseHTML: (element: HTMLElement) => element.getAttribute('data-asset-id'),
      },
      alt: { default: '', parseHTML: (element: HTMLElement) => element.getAttribute('alt') ?? '' },
    };
  },
  parseHTML() {
    return [
      {
        tag: 'img[data-asset-id]',
        getAttrs: (element: HTMLElement) =>
          assetIdPattern.test(element.getAttribute('data-asset-id') ?? '') ? {} : false,
      },
    ];
  },
  renderHTML({ node }) {
    return [
      'img',
      {
        'data-asset-id': node.attrs.assetId,
        src: assetUrl(String(node.attrs.assetId)),
        alt: node.attrs.alt,
      },
    ];
  },
});

const WritingKit = StarterKit.extend({
  addExtensions() {
    return (this.parent?.() ?? []).map((extension) => {
      if (extension.name === 'link')
        return extension.extend({
          addAttributes() {
            return {
              href: {
                default: null,
                parseHTML: (element: HTMLElement) => element.getAttribute('href'),
              },
            };
          },
        });
      if (extension.name === 'orderedList')
        return extension.extend({
          addAttributes() {
            return {
              start: {
                default: 1,
                parseHTML: (element: HTMLElement) =>
                  element.hasAttribute('start') ? Number(element.getAttribute('start')) : 1,
              },
            };
          },
        });
      return extension;
    });
  },
});

const blankArticle = (): ArticleInput => ({
  title: '',
  author: '',
  digest: '',
  sourceUrl: '',
  coverId: null,
  document: structuredClone(initialDocument),
});
const fields = (article: ArticleInput): ArticleInput => ({
  title: article.title,
  author: article.author,
  digest: article.digest,
  sourceUrl: article.sourceUrl,
  coverId: article.coverId,
  document: article.document,
});
const fingerprint = (value: ArticleInput) => JSON.stringify(fields(value));
const isSafeLink = (href: string) => safeHttpUrl.safeParse(href).success;

// Unknown structures are rejected as a whole, giving the writer a chance to paste plain text.
function pasteProblem(html: string): string | null {
  if (new TextEncoder().encode(html).byteLength > 2 * 1024 * 1024)
    return '粘贴内容超过 2 MiB，请分段粘贴。';
  const parsed = document.createElement('template');
  parsed.innerHTML = html;
  const allowed = new Set([
    'P',
    'DIV',
    'SPAN',
    'BR',
    'H2',
    'H3',
    'STRONG',
    'B',
    'EM',
    'I',
    'S',
    'STRIKE',
    'DEL',
    'U',
    'UL',
    'OL',
    'LI',
    'BLOCKQUOTE',
    'PRE',
    'CODE',
    'HR',
    'A',
    'IMG',
    'META',
  ]);
  const elements = [...parsed.content.querySelectorAll('*')];
  if (elements.length > 5000) return '粘贴内容节点过多，请分段粘贴。';
  for (const element of elements) {
    if (element.tagName === 'IMG') {
      const id = element.getAttribute('data-asset-id') ?? '';
      const src = element.getAttribute('src');
      if (!assetIdPattern.test(id) || src !== assetUrl(id))
        return '粘贴内容含外链图片。请先将图片保存到本地，再用「正文图片」上传；本次粘贴未插入。';
    }
    if (!allowed.has(element.tagName))
      return '粘贴内容含暂不支持的结构。请使用 Ctrl/Cmd + Shift + V 粘贴为纯文本，再进行排版。';
    if ([...element.attributes].some((attribute) => /^on/i.test(attribute.name)))
      return '粘贴内容含事件属性，未插入。请粘贴为纯文本。';
    if (element.tagName === 'A' && !isSafeLink(element.getAttribute('href') ?? ''))
      return '正文链接只支持不含凭据的 HTTP / HTTPS 地址，本次粘贴未插入。';
    if (
      element.tagName === 'OL' &&
      element.hasAttribute('type') &&
      element.getAttribute('type') !== '1'
    )
      return '当前只支持数字有序列表，请转换列表编号后重新粘贴，或粘贴为纯文本。';
  }
  return null;
}

function Toolbar({
  editor,
  disabled,
  onImage,
  onLink,
}: {
  editor: Editor | null;
  disabled: boolean;
  onImage: () => void;
  onLink: () => void;
}) {
  const buttons: { label: string; text: string; active?: boolean; run: () => void }[] = [
    {
      label: '正文段落',
      text: '正文',
      active: editor?.isActive('paragraph'),
      run: () => {
        editor?.chain().focus().setParagraph().run();
      },
    },
    {
      label: '二级标题',
      text: 'H2',
      active: editor?.isActive('heading', { level: 2 }),
      run: () => {
        editor?.chain().focus().toggleHeading({ level: 2 }).run();
      },
    },
    {
      label: '三级标题',
      text: 'H3',
      active: editor?.isActive('heading', { level: 3 }),
      run: () => {
        editor?.chain().focus().toggleHeading({ level: 3 }).run();
      },
    },
    {
      label: '加粗',
      text: 'B',
      active: editor?.isActive('bold'),
      run: () => {
        editor?.chain().focus().toggleBold().run();
      },
    },
    {
      label: '斜体',
      text: 'I',
      active: editor?.isActive('italic'),
      run: () => {
        editor?.chain().focus().toggleItalic().run();
      },
    },
    {
      label: '删除线',
      text: 'S̶',
      active: editor?.isActive('strike'),
      run: () => {
        editor?.chain().focus().toggleStrike().run();
      },
    },
    {
      label: '下划线',
      text: 'U̲',
      active: editor?.isActive('underline'),
      run: () => {
        editor?.chain().focus().toggleUnderline().run();
      },
    },
    {
      label: '无序列表',
      text: '• 列表',
      active: editor?.isActive('bulletList'),
      run: () => {
        editor?.chain().focus().toggleBulletList().run();
      },
    },
    {
      label: '有序列表',
      text: '1. 列表',
      active: editor?.isActive('orderedList'),
      run: () => {
        editor?.chain().focus().toggleOrderedList().run();
      },
    },
    {
      label: '引用',
      text: '引用',
      active: editor?.isActive('blockquote'),
      run: () => {
        editor?.chain().focus().toggleBlockquote().run();
      },
    },
    {
      label: '行内代码',
      text: '</>',
      active: editor?.isActive('code'),
      run: () => {
        editor?.chain().focus().toggleCode().run();
      },
    },
    {
      label: '代码块',
      text: '代码块',
      active: editor?.isActive('codeBlock'),
      run: () => {
        editor?.chain().focus().toggleCodeBlock().run();
      },
    },
    {
      label: '分隔线',
      text: '分隔线',
      run: () => {
        editor?.chain().focus().setHorizontalRule().run();
      },
    },
    {
      label: '换行',
      text: '换行',
      run: () => {
        editor?.chain().focus().setHardBreak().run();
      },
    },
    { label: '正文链接', text: '链接', active: editor?.isActive('link'), run: onLink },
    { label: '正文图片', text: '图片', run: onImage },
    {
      label: '撤销',
      text: '撤销',
      run: () => {
        editor?.chain().focus().undo().run();
      },
    },
    {
      label: '重做',
      text: '重做',
      run: () => {
        editor?.chain().focus().redo().run();
      },
    },
  ];
  return (
    <div className="editor-toolbar" role="group" aria-label="正文格式工具">
      {buttons.map((button) => (
        <Tooltip title={button.label} key={button.label}>
          <button
            type="button"
            aria-label={button.label}
            aria-pressed={button.active}
            disabled={disabled || !editor}
            className={button.active ? 'is-active' : ''}
            onMouseDown={(event) => event.preventDefault()}
            onClick={button.run}
          >
            {button.text}
          </button>
        </Tooltip>
      ))}
    </div>
  );
}

export function ArticleEditor({
  id,
  onBack,
  onDirtyChange,
}: {
  id: string | null;
  onBack: () => void;
  onDirtyChange: (dirty: boolean) => void;
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
  const [link, setLink] = useState('');
  const [linkError, setLinkError] = useState('');
  const [historyOpen, setHistoryOpen] = useState(false);
  const [history, setHistory] = useState<RevisionSummary[]>([]);
  const [historyPage, setHistoryPage] = useState(1);
  const [historyTotal, setHistoryTotal] = useState(0);
  const [historyLoading, setHistoryLoading] = useState(false);
  const [historyError, setHistoryError] = useState('');
  const [historicalRevision, setHistoricalRevision] = useState<Revision | null>(null);
  const [previewSnapshot, setPreviewSnapshot] = useState<Article | Revision | null>(null);
  const [preview, setPreview] = useState<ArticlePreview | null>(null);
  const [previewTitle, setPreviewTitle] = useState('');
  const [previewLoading, setPreviewLoading] = useState(false);
  const bodyFile = useRef<HTMLInputElement>(null);
  const coverFile = useRef<HTMLInputElement>(null);
  const mounted = useRef(true);
  const uploadHandler = useRef<(file: File, cover: boolean) => void>(() => undefined);
  const dirty = fingerprint(draft) !== baseline;
  const busy = saving || uploading;
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
    editor?.setEditable(!busy && !loading, false);
  }, [editor, busy, loading]);
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
    if (!editor || busy || loading || (id && !article)) return;
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

  async function openHistory(page = 1) {
    if (!article) return;
    setHistoryOpen(true);
    setHistoryLoading(true);
    setHistoryError('');
    setHistoryPage(page);
    try {
      const result = await api<Page<RevisionSummary>>(
        `/articles/${article.id}/revisions?page=${page}&pageSize=20`,
      );
      setHistory(result.items);
      setHistoryTotal(result.total);
    } catch (failure) {
      setHistoryError(errorMessage(failure));
    } finally {
      setHistoryLoading(false);
    }
  }

  async function openPreview(revisionId?: string) {
    if (!article || busy) return;
    const savedArticle = article;
    if (!revisionId && dirty) {
      setNotice('当前有未保存修改，请先保存后再预览当前文章。');
      return;
    }
    setError('');
    setPreviewLoading(true);
    try {
      let snapshot: Article | Revision = savedArticle;
      if (revisionId)
        snapshot = await api<Revision>(`/articles/${savedArticle.id}/revisions/${revisionId}`);
      const result = await api<ArticlePreview>(`/articles/${savedArticle.id}/preview`, {
        method: 'POST',
        ...jsonRequest({ revisionId: revisionId ?? savedArticle.revisionId }),
      });
      setHistoricalRevision(revisionId ? (snapshot as Revision) : null);
      if (revisionId) setHistoryOpen(false);
      setPreviewSnapshot(snapshot);
      setPreviewTitle(snapshot.title);
      setPreview(result);
    } catch (failure) {
      setError(errorMessage(failure));
    } finally {
      setPreviewLoading(false);
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
    <div className="article-workspace">
      <div className="article-topline">
        <Button type="text" onClick={back}>
          ← 返回内容列表
        </Button>
        <span className="save-state" role="status" aria-live="polite">
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
          <p className="eyebrow">留住每一次创作</p>
          <h1>{id || article ? '编辑文章' : '新建文章'}</h1>
          <p className="secondary">明确保存，每次变化形成一份独立修订。</p>
        </div>
        <div className="article-actions">
          <Button onClick={() => void openHistory()} disabled={!article || busy || loading}>
            修订历史
          </Button>
          <Button
            onClick={() => void openPreview()}
            loading={previewLoading}
            disabled={!article || busy || loading}
          >
            微信预览
          </Button>
          <Button
            type="primary"
            aria-label="保存文章"
            onClick={() => void save()}
            loading={saving}
            disabled={busy || loading || Boolean(id && !article)}
          >
            保存文章
          </Button>
        </div>
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
        <div className="article-layout">
          <section className="surface writing-surface" aria-label="文章编辑器">
            <div className="article-title-field">
              <label htmlFor="article-title">标题</label>
              <Input
                id="article-title"
                value={draft.title}
                placeholder="未命名文章"
                disabled={busy}
                onChange={(event) => update('title', event.target.value)}
              />
            </div>
            <label className="body-label">正文</label>
            <Toolbar
              editor={editor}
              disabled={busy}
              onImage={() => bodyFile.current?.click()}
              onLink={() => {
                setLink(String(editor?.getAttributes('link').href ?? ''));
                setLinkError('');
                setLinkOpen(true);
              }}
            />
            <EditorContent editor={editor} className="article-editor" />
            <div className="editor-footnote">
              支持二 / 三级标题、文字样式、列表、引用、代码和本地图片。外部格式使用统一排版。
            </div>
          </section>
          <aside className="surface article-metadata" aria-label="文章信息">
            <h2>文章信息</h2>
            <p className="secondary">不完整的稿件也可以先保存。</p>
            <div className="metadata-field">
              <label htmlFor="article-author">作者</label>
              <Input
                id="article-author"
                value={draft.author}
                disabled={busy}
                onChange={(event) => update('author', event.target.value)}
              />
            </div>
            <div className="metadata-field">
              <label htmlFor="article-digest">摘要</label>
              <Input.TextArea
                id="article-digest"
                rows={4}
                value={draft.digest}
                disabled={busy}
                onChange={(event) => update('digest', event.target.value)}
              />
            </div>
            <div className="metadata-field">
              <label htmlFor="article-source">原文链接</label>
              <Input
                id="article-source"
                placeholder="https://"
                value={draft.sourceUrl}
                disabled={busy}
                onChange={(event) => update('sourceUrl', event.target.value)}
              />
              <p className="form-note">仅支持 HTTP / HTTPS，正文外链在预览中显示为文字与网址。</p>
            </div>
            <div className="metadata-field">
              <span className="field-label">文章封面</span>
              {draft.coverId ? (
                <img className="article-cover" src={assetUrl(draft.coverId)} alt="文章封面" />
              ) : (
                <div className="cover-empty">尚未选择封面</div>
              )}
              <div className="cover-actions">
                <Button onClick={() => coverFile.current?.click()} disabled={busy}>
                  {draft.coverId ? '更换封面' : '上传封面'}
                </Button>
                {draft.coverId && (
                  <Button
                    type="text"
                    disabled={busy}
                    onClick={() => setDraft((current) => ({ ...current, coverId: null }))}
                  >
                    移除封面
                  </Button>
                )}
              </div>
              <p className="form-note">
                JPG / PNG，单张不超过 10 MiB、2000 万像素。图片读取需要登录。
              </p>
            </div>
            {article && (
              <p className="saved-at">
                最近保存
                <br />
                <strong>{date(article.updatedAt)}</strong>
              </p>
            )}
          </aside>
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
      <Modal
        open={linkOpen}
        title="正文链接"
        okText="应用链接"
        cancelText="取消"
        onCancel={() => setLinkOpen(false)}
        onOk={() => {
          if (!link.trim()) {
            editor?.chain().focus().extendMarkRange('link').unsetLink().run();
            setLinkOpen(false);
            return;
          }
          if (!isSafeLink(link.trim())) {
            setLinkError('请输入不含账号密码的 HTTP / HTTPS 网址。');
            return;
          }
          if (editor?.state.selection.empty && !editor.isActive('link')) {
            setLinkError('请先在正文中选中需要添加链接的文字。');
            return;
          }
          editor?.chain().focus().extendMarkRange('link').setLink({ href: link.trim() }).run();
          setLinkOpen(false);
        }}
      >
        <label htmlFor="article-link">链接地址</label>
        <Input
          id="article-link"
          value={link}
          onChange={(event) => setLink(event.target.value)}
          placeholder="https://"
        />
        <p className="form-note">先选中文字。留空可移除已有链接；预览显示文字与网址。</p>
        {linkError && (
          <p className="inline-error" role="alert">
            {linkError}
          </p>
        )}
      </Modal>
      <Modal
        open={historyOpen}
        title="修订历史"
        onCancel={() => setHistoryOpen(false)}
        footer={null}
        width={680}
      >
        <p className="secondary">查看已保存快照。后续编辑不会覆盖这些内容。</p>
        {historyError && <Alert type="error" showIcon message={historyError} />}
        {historyLoading ? (
          <div className="loading-panel">
            <Spin />
          </div>
        ) : (
          <div className="revision-list">
            {history.map((revision) => (
              <div key={revision.id} className="revision-row">
                <div>
                  <strong>
                    修订 v{revision.version}{' '}
                    {revision.id === article?.revisionId && <Tag>当前修订</Tag>}
                  </strong>
                  <span className="revision-title">{revision.title}</span>
                  <span className="secondary">{date(revision.createdAt)}</span>
                </div>
                <Button onClick={() => void openPreview(revision.id)} loading={previewLoading}>
                  查看 v{revision.version}
                </Button>
              </div>
            ))}
          </div>
        )}
        {historyTotal > 20 && (
          <div className="history-pages">
            <Button
              disabled={historyPage <= 1 || historyLoading}
              onClick={() => void openHistory(historyPage - 1)}
            >
              上一页
            </Button>
            <span>第 {historyPage} 页</span>
            <Button
              disabled={historyPage * 20 >= historyTotal || historyLoading}
              onClick={() => void openHistory(historyPage + 1)}
            >
              下一页
            </Button>
          </div>
        )}
      </Modal>
      <Modal
        open={Boolean(preview)}
        title={
          historicalRevision
            ? `历史修订 v${preview?.version} · 只读`
            : `微信预览 · 修订 v${preview?.version}`
        }
        width={760}
        footer={null}
        onCancel={() => {
          if (historicalRevision) setHistoryOpen(true);
          setPreview(null);
          setHistoricalRevision(null);
        }}
        className="article-preview-modal"
      >
        <p className="secondary">固定公众号排版的近似效果，最终以微信后台为准。</p>
        {preview?.warnings.map((warning, index) => (
          <Alert key={index} type="warning" showIcon message={warning} />
        ))}
        {previewSnapshot && (
          <dl className="revision-metadata">
            <div>
              <dt>作者</dt>
              <dd>{previewSnapshot.author || '未填写'}</dd>
            </div>
            <div>
              <dt>摘要</dt>
              <dd>{previewSnapshot.digest || '未填写'}</dd>
            </div>
            <div>
              <dt>原文链接</dt>
              <dd>{previewSnapshot.sourceUrl || '未填写'}</dd>
            </div>
            <div>
              <dt>保存时间</dt>
              <dd>
                {date(
                  'createdAt' in previewSnapshot
                    ? previewSnapshot.createdAt
                    : previewSnapshot.updatedAt,
                )}
              </dd>
            </div>
            {previewSnapshot.coverId && (
              <div>
                <dt>封面</dt>
                <dd>
                  <img
                    src={assetUrl(previewSnapshot.coverId)}
                    alt={historicalRevision ? '历史修订封面' : '预览封面'}
                    className="history-cover"
                  />
                </dd>
              </div>
            )}
          </dl>
        )}
        {preview && (
          <div className="preview-paper">
            <h2>{previewTitle}</h2>
            <iframe
              title="微信正文预览"
              sandbox="allow-same-origin"
              srcDoc={`<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src 'self'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'"><style>body{margin:0;padding:0 4px;font-family:system-ui,'Microsoft YaHei',sans-serif}img{max-width:100%}</style></head><body>${preview.html}</body></html>`}
            />
          </div>
        )}
      </Modal>
    </div>
  );
}
