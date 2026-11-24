import { useCallback, useEffect, useState } from 'react';
import { Tag } from 'antd';
import type { SourceJob, SourceJobState as JobState } from '@tattoo/contracts';
import { api, errorMessage } from '../../api';

export const sourceJobLabels = { URL: '链接采集', FEED: 'RSS 拉取', SEARCH: '搜索' } as const;
export const sourceJobPending = (job: { state: JobState }) =>
  job.state === 'QUEUED' || job.state === 'RUNNING';

const states: Record<JobState, { text: string; color: string }> = {
  QUEUED: { text: '排队中', color: 'default' },
  RUNNING: { text: '获取中', color: 'processing' },
  SUCCEEDED: { text: '已完成', color: 'success' },
  FAILED: { text: '获取失败', color: 'error' },
  UNCERTAIN: { text: '结果待核对', color: 'warning' },
};

export function SourceJobState({ state }: { state: JobState }) {
  return <Tag color={states[state].color}>{states[state].text}</Tag>;
}

export function useSourceJob(id: string | null) {
  const [job, setJob] = useState<SourceJob | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [version, setVersion] = useState(0);
  const refresh = useCallback(() => setVersion((value) => value + 1), []);
  useEffect(() => {
    setJob(null);
    setError('');
  }, [id]);
  useEffect(() => {
    if (!id) return;
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const load = async () => {
      setLoading(true);
      try {
        const result = await api<SourceJob>(`/sources/jobs/${id}`, { signal: controller.signal });
        if (controller.signal.aborted) return;
        setJob(result);
        setError('');
        if (sourceJobPending(result)) timer = setTimeout(() => void load(), 1500);
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
  }, [id, version]);
  return { job, loading, error, refresh };
}
