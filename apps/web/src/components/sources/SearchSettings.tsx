import { useState } from 'react';
import { Alert, Button, Checkbox, Form, Input, Tag } from 'antd';
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
  const [form] = Form.useForm<SourceSearchConfigInput>();
  const clearKey = Form.useWatch('clearApiKey', form) === true;
  const [pending, setPending] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  async function save(values: SourceSearchConfigInput) {
    if (pending || blocked) return;
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
      <Form
        form={form}
        name="source-search-config"
        layout="vertical"
        requiredMark={false}
        initialValues={{
          baseUrl: config?.baseUrl ?? 'https://api.tavily.com',
          apiKey: '',
          clearApiKey: false,
        }}
        onValuesChange={() => {
          onDirty(true);
          setNotice('');
        }}
        onFinish={save}
        disabled={pending || blocked}
      >
        <Form.Item
          name="baseUrl"
          label="Tavily 服务地址"
          rules={[{ required: true, whitespace: true, message: '请输入 Tavily 服务地址' }]}
          extra="填写基础地址，系统追加 /search；原生服务使用 https://api.tavily.com。"
        >
          <Input autoComplete="off" maxLength={2000} />
        </Form.Item>
        <Form.Item
          name="apiKey"
          label="Tavily API Key"
          extra={
            config?.hasApiKey
              ? '留空保留已保存密钥。更换服务来源时需重新输入或明确清除。'
              : '仅在自己的页面输入，由后端加密保存。'
          }
        >
          <Input.Password
            autoComplete="new-password"
            placeholder={config?.hasApiKey ? '留空保留现有密钥' : '请输入 Tavily API Key'}
            disabled={clearKey || pending || blocked}
            maxLength={4096}
          />
        </Form.Item>
        {config?.hasApiKey && (
          <Form.Item name="clearApiKey" valuePropName="checked">
            <Checkbox
              onChange={(event) => event.target.checked && form.setFieldValue('apiKey', '')}
            >
              清除 Tavily 密钥
            </Checkbox>
          </Form.Item>
        )}
        <Button
          type="primary"
          htmlType="submit"
          loading={pending}
          aria-label="保存 Tavily 搜索配置"
        >
          保存搜索配置
        </Button>
      </Form>
      <p className="form-note">
        保存不执行搜索。实际搜索可能产生服务费用，使用基础搜索，每次最多返回 5 条候选。
      </p>
      {blocked && (
        <p className="form-note">搜索请求正在处理或尚未确认，请先取回本次任务再修改配置。</p>
      )}
    </section>
  );
}
