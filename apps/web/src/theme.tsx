import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useId,
  useState,
  type ReactNode,
} from 'react';
import { Sun, Moon, Desktop } from '@phosphor-icons/react';
import { Select } from './components/ui';

export type ThemePreference = 'light' | 'dark' | 'system';
const storageKey = 'tattoo:theme';
const valid = (value: unknown): value is ThemePreference =>
  value === 'light' || value === 'dark' || value === 'system';
function readPreference(): ThemePreference {
  try {
    const stored = localStorage.getItem(storageKey);
    return valid(stored) ? stored : 'system';
  } catch {
    return 'system';
  }
}
function applyTheme(preference: ThemePreference) {
  const dark =
    preference === 'dark' ||
    (preference === 'system' && matchMedia('(prefers-color-scheme: dark)').matches);
  const resolved = dark ? 'dark' : 'light';
  document.documentElement.classList.toggle('dark', dark);
  document.documentElement.dataset.theme = resolved;
  document.documentElement.dataset.themePreference = preference;
  document.documentElement.style.colorScheme = resolved;
  document
    .querySelector('meta[name="theme-color"]')
    ?.setAttribute('content', dark ? '#191a1c' : '#ffffff');
}
const ThemeContext = createContext<{
  preference: ThemePreference;
  setPreference: (value: ThemePreference) => void;
}>({ preference: 'system', setPreference: () => {} });

export function ThemeProvider({ children }: { children: ReactNode }) {
  const [preference, setTheme] = useState<ThemePreference>(readPreference);
  const setPreference = useCallback((value: ThemePreference) => {
    setTheme(value);
    applyTheme(value);
    try {
      localStorage.setItem(storageKey, value);
    } catch {
      /* Private mode still supports this session's choice. */
    }
  }, []);
  useEffect(() => {
    applyTheme(preference);
    const query = matchMedia('(prefers-color-scheme: dark)');
    const change = () => {
      if (preference === 'system') applyTheme(preference);
    };
    query.addEventListener('change', change);
    return () => query.removeEventListener('change', change);
  }, [preference]);
  useEffect(() => {
    const sync = (event: StorageEvent) => {
      if (event.key === storageKey || event.key === null) {
        const next = valid(event.newValue) ? event.newValue : 'system';
        setTheme(next);
        applyTheme(next);
      }
    };
    window.addEventListener('storage', sync);
    return () => window.removeEventListener('storage', sync);
  }, []);
  return (
    <ThemeContext.Provider value={{ preference, setPreference }}>{children}</ThemeContext.Provider>
  );
}
export function ThemePicker() {
  const { preference, setPreference } = useContext(ThemeContext);
  const Icon = preference === 'dark' ? Moon : preference === 'light' ? Sun : Desktop;
  const id = useId();
  return (
    <div className="theme-picker">
      <Icon aria-hidden size={17} />
      <label htmlFor={id} className="sr-only">
        外观主题
      </label>
      <Select
        id={id}
        aria-label="外观主题"
        value={preference}
        onChange={(value) => {
          if (valid(value)) setPreference(value);
        }}
        options={[
          { value: 'light', label: '浅色' },
          { value: 'dark', label: '深色' },
          { value: 'system', label: '跟随系统' },
        ]}
      />
    </div>
  );
}
