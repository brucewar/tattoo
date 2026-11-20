import { Tooltip } from 'antd';
import type { Editor } from '@tiptap/react';

export function ArticleToolbar({
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
