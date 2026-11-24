import { useCallback, useEffect, useRef, useState } from 'react';
import {
  Alert,
  Button,
  Checkbox,
  Empty,
  Form,
  Input,
  InputNumber,
  Pagination,
  Select,
  Spin,
  Tag,
} from 'antd';
import type {
  AiCapability,
  AiGenerationJob,
  AiGenerationSummary,
  AiModelConfig,
  AiModelInput,
  AiModels,
} from '@tattoo/contracts';
import { api, ApiError, errorMessage, jsonRequest, requestId } from '../api';
import { date, type Page } from '../ui';
import {
  GenerationDetail,
  GenerationProgress,
  GenerationResult,
  GenerationState,
  generationLabels,
  generationPending,
  protocolLabels,
  useGenerationJob,
} from '../components/ai/Generation';

const validationStorageKey = (capability: AiCapability) =>
  `tattoo:ai:validation:${capability}:pending`;

function readValidationRequest(capability: AiCapability): string | null {
  try {
    const value = sessionStorage.getItem(validationStorageKey(capability));
    return value && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value)
      ? value
      : null;
  } catch {
    return null;
  }
}

function ModelEditor({
  capability,
  config,
  onSaved,
  onDirty,
  onValidated,
}: {
  capability: AiCapability;
  config: AiModelConfig | null;
  onSaved: (value: AiModelConfig) => void;
  onDirty: (changed: boolean) => void;
  onValidated: () => void;
}) {
  const [form] = Form.useForm<AiModelInput>();
  const clearKey = Form.useWatch('clearApiKey', form) === true;
  const [pending, setPending] = useState(false);
  const [changed, setChanged] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const verificationRequest = useRef<string | null>(readValidationRequest(capability));
  const [unresolvedValidation, setUnresolvedValidation] = useState(
    Boolean(verificationRequest.current),
  );
  const [jobId, setJobId] = useState<string | null>(() =>
    !verificationRequest.current &&
    config?.lastValidation &&
    generationPending(config.lastValidation)
      ? config.lastValidation.jobId
      : null,
  );
  const lastCompleted = useRef<string | null>(null);
  const submitting = useRef(false);
  const { job, error: jobError, loading: jobLoading, refresh } = useGenerationJob(jobId);
  const image = capability === 'image';
  const protocol =
    Form.useWatch('protocol', form) ??
    (image ? 'images-generations' : (config?.protocol ?? 'chat-completions'));
  const anthropic = !image && protocol === 'anthropic-messages';
  const endpoint = image
    ? '/images/generations'
    : protocol === 'responses'
      ? '/responses'
      : anthropic
        ? '/messages'
        : '/chat/completions';
  const title = image ? '图片模型' : '文本模型';
  const checking = Boolean(job && generationPending(job));
  const waitingForJob = Boolean(jobId && !job);
  useEffect(() => {
    if (!job || generationPending(job) || lastCompleted.current === job.id) return;
    lastCompleted.current = job.id;
    onValidated();
  }, [job, onValidated]);
  async function save(values: AiModelInput) {
    if (submitting.current || unresolvedValidation) return;
    submitting.current = true;
    setPending(true);
    setError('');
    setNotice('');
    try {
      const result = await api<AiModelConfig>(`/ai/models/${capability}`, {
        method: 'PUT',
        ...jsonRequest({
          ...values,
          protocol: image ? 'images-generations' : values.protocol,
          anthropicMaxTokens:
            values.protocol === 'anthropic-messages' ? values.anthropicMaxTokens : 4096,
          apiKey: values.apiKey?.trim() || undefined,
        }),
      });
      onDirty(false);
      setChanged(false);
      onSaved(result);
      setNotice('配置已保存。请执行实际生成验证，确认这项能力可用。');
    } catch (failure) {
      setError(errorMessage(failure));
    } finally {
      submitting.current = false;
      setPending(false);
    }
  }
  async function verify() {
    if (!config || changed || pending || submitting.current || checking || waitingForJob) return;
    const requestKey = verificationRequest.current ?? requestId();
    try {
      sessionStorage.setItem(validationStorageKey(capability), requestKey);
    } catch {
      setError('浏览器无法保存待确认请求，请允许此页面使用会话存储后重试。本次未调用模型。');
      return;
    }
    verificationRequest.current = requestKey;
    submitting.current = true;
    setPending(true);
    setUnresolvedValidation(true);
    setError('');
    setNotice('');
    try {
      const result = await api<AiGenerationJob>('/ai/jobs', {
        method: 'POST',
        ...jsonRequest({
          requestKey: verificationRequest.current,
          kind: image ? 'TEST_IMAGE' : 'TEST_TEXT',
          prompt: '',
        }),
      });
      setJobId(result.id);
      try {
        sessionStorage.removeItem(validationStorageKey(capability));
      } catch {
        /* The stored nonce can safely retrieve this job after reload. */
      }
      verificationRequest.current = null;
      setUnresolvedValidation(false);
      onValidated();
    } catch (failure) {
      setError(errorMessage(failure));
      if (failure instanceof ApiError && failure.status >= 400 && failure.status < 500) {
        verificationRequest.current = null;
        setUnresolvedValidation(false);
        try {
          sessionStorage.removeItem(validationStorageKey(capability));
        } catch {
          /* The rejected nonce cannot cause an extra model call. */
        }
      }
    } finally {
      submitting.current = false;
      setPending(false);
    }
  }
  const validation = config?.lastValidation;
  return (
    <section className="surface model-settings" aria-label={title}>
      <div className="model-heading">
        <div>
          <h2>{title}</h2>
          <p className="secondary">{image ? '用于封面和正文插图。' : '用于文章生成和内容改写。'}</p>
        </div>
        <Tag color={!changed && validation?.state === 'SUCCEEDED' ? 'success' : 'default'}>
          {changed
            ? '待保存'
            : validation?.state === 'SUCCEEDED'
              ? '生成验证通过'
              : config
                ? '已保存'
                : '未配置'}
        </Tag>
      </div>
      {error && <Alert type="error" showIcon message={error} />}
      {notice && <Alert type="success" showIcon message={notice} />}
      <Form
        form={form}
        name={`model-${capability}`}
        layout="vertical"
        requiredMark={false}
        initialValues={{
          protocol: image ? 'images-generations' : (config?.protocol ?? 'chat-completions'),
          anthropicMaxTokens: config?.anthropicMaxTokens ?? 4096,
          baseUrl: config?.baseUrl ?? '',
          model: config?.model ?? '',
          apiKey: '',
          clearApiKey: false,
          imageSize: config?.imageSize ?? '',
          imageResponseFormat: config?.imageResponseFormat ?? 'auto',
        }}
        onValuesChange={() => {
          setChanged(true);
          setNotice('');
          onDirty(true);
        }}
        onFinish={save}
        disabled={pending || checking || waitingForJob || unresolvedValidation}
      >
        {!image && (
          <Form.Item
            label="接口协议"
            name="protocol"
            rules={[{ required: true, message: '请选择接口协议' }]}
          >
            <Select
              getPopupContainer={(trigger) => trigger.parentElement ?? trigger}
              options={[
                { label: 'Chat Completions', value: 'chat-completions' },
                { label: 'Responses', value: 'responses' },
                { label: 'Anthropic Messages', value: 'anthropic-messages' },
              ]}
            />
          </Form.Item>
        )}
        <Form.Item
          label="服务地址"
          name="baseUrl"
          rules={[{ required: true, whitespace: true, message: '请输入服务地址' }]}
          extra={`填写 API 基础地址（含版本前缀），例如 ${anthropic ? 'https://api.anthropic.com/v1' : 'https://api.openai.com/v1'}；系统会追加 ${endpoint}。本机服务可使用 HTTP 环回地址。`}
        >
          <Input placeholder="https://api.example.com/v1" autoComplete="off" maxLength={2000} />
        </Form.Item>
        {anthropic && (
          <Form.Item
            label="最大输出 tokens"
            name="anthropicMaxTokens"
            rules={[
              { required: true, message: '请输入最大输出 tokens' },
              { type: 'integer', min: 1, max: 128000, message: '请输入 1 至 128000 的整数' },
            ]}
            extra="Messages 接口需要此上限；请填写所选模型支持的数值。达到上限的截断结果不会作为候选采用。"
          >
            <InputNumber min={1} max={128000} precision={0} />
          </Form.Item>
        )}
        <Form.Item
          label="模型名称"
          name="model"
          rules={[{ required: true, whitespace: true, message: '请输入模型名称' }]}
        >
          <Input placeholder="填写服务商支持的模型名称" autoComplete="off" maxLength={200} />
        </Form.Item>
        <Form.Item
          label="API Key"
          name="apiKey"
          extra={
            config?.hasApiKey
              ? '已保存密钥；留空保留现有密钥，或勾选下方选项明确清除。'
              : '由后端加密保存；无需密钥的本机服务可以留空。'
          }
        >
          <Input.Password
            disabled={clearKey || pending || checking || waitingForJob || unresolvedValidation}
            autoComplete="new-password"
            placeholder={config?.hasApiKey ? '留空保留现有密钥' : '请输入 API Key（如需要）'}
            maxLength={4096}
          />
        </Form.Item>
        {config?.hasApiKey && (
          <Form.Item name="clearApiKey" valuePropName="checked">
            <Checkbox
              onChange={(event) => {
                if (event.target.checked) form.setFieldValue('apiKey', '');
              }}
            >
              清除已保存密钥（无密钥服务）
            </Checkbox>
          </Form.Item>
        )}
        {image && (
          <>
            <Form.Item
              label="图片尺寸（可选）"
              name="imageSize"
              extra="留空使用服务默认尺寸；需要横版封面时，填写模型支持的宽×高，例如 1536x1024。"
            >
              <Input placeholder="例如 1536x1024" maxLength={30} />
            </Form.Item>
            <Form.Item label="图片返回方式" name="imageResponseFormat">
              <Select
                getPopupContainer={(trigger) => trigger.parentElement ?? trigger}
                options={[
                  { label: '服务默认（推荐）', value: 'auto' },
                  { label: 'Base64 图片', value: 'b64_json' },
                  { label: '图片链接', value: 'url' },
                ]}
              />
            </Form.Item>
          </>
        )}
        <div className="model-actions">
          <Button
            htmlType="submit"
            type="primary"
            aria-label={`保存${title}配置`}
            loading={pending}
          >
            保存配置
          </Button>
          <Button
            onClick={() => void verify()}
            aria-label={
              unresolvedValidation ? `获取本次${image ? '图片' : '文本'}验证任务` : `验证${title}`
            }
            disabled={!config || changed || pending || checking || waitingForJob}
          >
            {unresolvedValidation ? '获取本次验证任务' : '实际生成验证'}
          </Button>
        </div>
      </Form>
      <p className="form-note">
        验证会实际调用模型，可能产生服务费用。文本与图片需要分别验证，保存配置本身不代表生成成功。
      </p>
      {unresolvedValidation && !pending && (
        <p className="form-note">
          上次验证请求尚未确认。获取任务会复用同一请求，不会另起一轮生成。
        </p>
      )}
      {!job && validation && (
        <div className="model-validation">
          <GenerationState state={validation.state} />
          {validation.checkedAt && <span className="secondary">{date(validation.checkedAt)}</span>}
          {validation.error && <p className="inline-error">{validation.error}</p>}
          <Button type="link" onClick={() => setJobId(validation.jobId)}>
            查看上次验证
          </Button>
        </div>
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
      {job && (
        <div className="model-validation" aria-label={`${title}验证结果`}>
          {config && job.configVersion !== config.version && (
            <Alert
              type="warning"
              showIcon
              message="这份结果使用的是旧配置，请分别验证当前模型配置。"
            />
          )}
          <GenerationProgress job={job} />
          {job.result && <GenerationResult result={job.result} />}
        </div>
      )}
      {!job && jobLoading && <Spin size="small" />}
    </section>
  );
}

export function Models({ onDirtyChange }: { onDirtyChange: (changed: boolean) => void }) {
  const [models, setModels] = useState<AiModels | null>(null);
  const [tasks, setTasks] = useState<AiGenerationSummary[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [selected, setSelected] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [version, setVersion] = useState(0);
  const dirty = useRef({ text: false, image: false });
  const reload = useCallback(() => setVersion((current) => current + 1), []);
  const markDirty = (capability: AiCapability, changed: boolean) => {
    dirty.current[capability] = changed;
    onDirtyChange(dirty.current.text || dirty.current.image);
  };
  useEffect(() => {
    const warn = (event: BeforeUnloadEvent) => {
      if (!dirty.current.text && !dirty.current.image) return;
      event.preventDefault();
      event.returnValue = '';
    };
    window.addEventListener('beforeunload', warn);
    return () => {
      window.removeEventListener('beforeunload', warn);
      onDirtyChange(false);
    };
  }, [onDirtyChange]);
  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    setError('');
    void Promise.all([
      api<AiModels>('/ai/models', { signal: controller.signal }),
      api<Page<AiGenerationSummary>>(`/ai/jobs?page=${page}&pageSize=10`, {
        signal: controller.signal,
      }),
    ])
      .then(([configured, recent]) => {
        if (controller.signal.aborted) return;
        setModels(configured);
        setTasks(recent.items);
        setTotal(recent.total);
      })
      .catch((failure) => {
        if (!controller.signal.aborted) setError(errorMessage(failure));
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  }, [page, version]);
  return (
    <>
      <div className="page-heading">
        <div>
          <p className="eyebrow">把创作能力接入工作台</p>
          <h1>模型配置</h1>
          <p className="secondary">文本与图片可使用不同服务；密钥保存在自己的实例中。</p>
        </div>
        <Button onClick={reload} aria-label="刷新模型配置" loading={loading}>
          刷新
        </Button>
      </div>
      {error && (
        <Alert
          type="error"
          showIcon
          message={error}
          action={<Button onClick={reload}>重新加载</Button>}
        />
      )}
      {!models && loading && (
        <div className="surface loading-panel">
          <Spin />
          <p className="secondary">正在读取模型配置…</p>
        </div>
      )}
      {models && (
        <div className="model-grid">
          {(['text', 'image'] as const).map((capability) => (
            <ModelEditor
              key={`${capability}-${models[capability]?.version ?? 0}`}
              capability={capability}
              config={models[capability]}
              onSaved={(value) =>
                setModels((current) => (current ? { ...current, [capability]: value } : current))
              }
              onDirty={(changed) => markDirty(capability, changed)}
              onValidated={reload}
            />
          ))}
        </div>
      )}
      <section className="surface ai-task-list" aria-label="最近生成任务">
        <div className="model-heading">
          <div>
            <h2>最近生成任务</h2>
            <p className="secondary">关闭生成窗口后，可在这里找回状态与候选结果。</p>
          </div>
        </div>
        {!tasks.length ? (
          <Empty description="还没有生成任务" />
        ) : (
          tasks.map((task) => (
            <button
              key={task.id}
              className="ai-task-row"
              type="button"
              onClick={() => setSelected(task.id)}
            >
              <span>
                <strong>{generationLabels[task.kind]}</strong>
                <span className="secondary">
                  {task.model} · {protocolLabels[task.protocol]} · {date(task.createdAt)}
                </span>
              </span>
              <GenerationState state={task.state} />
              <span className="content-open">查看结果 →</span>
            </button>
          ))
        )}
      </section>
      {total > 10 && (
        <Pagination
          className="pagination"
          current={page}
          total={total}
          pageSize={10}
          showSizeChanger={false}
          onChange={setPage}
        />
      )}
      {selected && (
        <GenerationDetail
          id={selected}
          onClose={() => {
            setSelected(null);
            reload();
          }}
        />
      )}
    </>
  );
}
