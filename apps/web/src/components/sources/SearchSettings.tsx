import { useState } from 'react';
import { Alert, Button, Checkbox, Input, Tag } from '../ui';
import type { SourceSearchConfig, SourceSearchConfigInput } from '@tattoo/contracts';
import { api, errorMessage, jsonRequest } from '../../api';

export function SearchSettings({
  config,
  blocked,
  onDirty,
  onSaved,
}: {
  config: SourceSearchConfig | null;
  blocked: boolean;
  onDirty: (value: boolean) => void;
  onSaved: (value: SourceSearchConfig) => void;
}) {
  const [values, setValues] = useState<SourceSearchConfigInput>({
    baseUrl: config?.baseUrl ?? 'https://api.tavily.com',
    apiKey: '',
    clearApiKey: false,
  });
  const clearKey = values.clearApiKey;
  const [pending, setPending] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  function change(patch: Partial<SourceSearchConfigInput>) {
    setValues((current) => ({ ...current, ...patch }));
    onDirty(true);
    setNotice('');
  }
  async function save(values: SourceSearchConfigInput) {
    if (pending || blocked) return;
    if (!values.baseUrl.trim()) {
      setError('请输入 Tavily 服务地址');
      return;
    }
    setPending(true);
    setError('');
    setNotice('');
    try {
      const result = await api<SourceSearchConfig>('/sources/search-config', {
        method: 'PUT',
        ...jsonRequest({ ...values, apiKey: values.apiKey?.trim() || undefined }),
      });
      onDirty(false);
      onSaved(result);
      setNotice('配置已保存。明确点击搜索才会调用 Tavily。');
    } catch (failure) {
      setError(errorMessage(failure));
    } finally {
      setPending(false);
    }
  }
  return (
    <section className="surface source-panel" aria-label="Tavily 搜索配置">
      <div className="source-heading">
        <h2>Tavily 搜索配置</h2>
        <Tag>{config?.hasApiKey ? '已保存密钥' : '未配置密钥'}</Tag>
      </div>
      {error && <Alert type="error" showIcon message={error} />}
      {notice && <Alert type="success" showIcon message={notice} />}
      <form
        className="workspace-form"
        onSubmit={(event) => {
          event.preventDefault();
          void save(values);
        }}
      >
        <fieldset className="form-fields" disabled={pending || blocked}>
          <div className="form-field">
            <label htmlFor="tavily-base-url">Tavily 服务地址</label>
            <Input
              id="tavily-base-url"
              type="url"
              required
              autoComplete="off"
              maxLength={2000}
              value={values.baseUrl}
              aria-describedby="tavily-base-url-help"
              onChange={(event) => change({ baseUrl: event.target.value })}
            />
            <p id="tavily-base-url-help" className="form-note">
              填写基础地址，系统追加 /search；原生服务使用 https://api.tavily.com。
            </p>
          </div>
          <div className="form-field">
            <label htmlFor="tavily-api-key">Tavily API Key</label>
            <Input.Password
              id="tavily-api-key"
              autoComplete="new-password"
              placeholder={config?.hasApiKey ? '留空保留现有密钥' : '请输入 Tavily API Key'}
              disabled={clearKey || pending || blocked}
              maxLength={4096}
              value={values.apiKey ?? ''}
              aria-describedby="tavily-api-key-help"
              onChange={(event) => change({ apiKey: event.target.value })}
            />
            <p id="tavily-api-key-help" className="form-note">
              {config?.hasApiKey
                ? '留空保留已保存密钥。更换服务来源时需重新输入或明确清除。'
                : '仅在自己的页面输入，由后端加密保存。'}
            </p>
          </div>
          {config?.hasApiKey && (
            <Checkbox
              checked={clearKey}
              disabled={pending || blocked}
              onChange={(event) =>
                change({
                  clearApiKey: event.target.checked,
                  ...(event.target.checked ? { apiKey: '' } : {}),
                })
              }
            >
              清除 Tavily 密钥
            </Checkbox>
          )}
        </fieldset>
        <Button
          type="primary"
          htmlType="submit"
          loading={pending}
          disabled={pending || blocked}
          aria-label="保存 Tavily 搜索配置"
        >
          保存搜索配置
        </Button>
      </form>
      <p className="form-note">
        保存不执行搜索。实际搜索可能产生服务费用，使用基础搜索，每次最多返回 5 条候选。
      </p>
      {blocked && (
        <p className="form-note">搜索请求正在处理或尚未确认，请先取回本次任务再修改配置。</p>
      )}
    </section>
  );
}
