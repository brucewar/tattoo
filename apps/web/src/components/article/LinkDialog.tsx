import { useEffect, useState } from 'react';
import { Input, Modal } from 'antd';
import type { Editor } from '@tiptap/react';
import { isSafeLink } from './document';

export function ArticleLinkDialog({
  open,
  editor,
  onClose,
}: {
  open: boolean;
  editor: Editor | null;
  onClose: () => void;
}) {
  const [link, setLink] = useState('');
  const [linkError, setLinkError] = useState('');
  useEffect(() => {
    if (open) {
      setLink(String(editor?.getAttributes('link').href ?? ''));
      setLinkError('');
    }
  }, [open, editor]);
  return (
    <Modal
      open={open}
      title="正文链接"
      okText="应用链接"
      cancelText="取消"
      onCancel={() => onClose()}
      onOk={() => {
        if (!link.trim()) {
          editor?.chain().focus().extendMarkRange('link').unsetLink().run();
          onClose();
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
        onClose();
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
  );
}
