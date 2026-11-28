import {
  createContext,
  useContext,
  useId,
  useRef,
  useState,
  type ButtonHTMLAttributes,
  type ComponentProps,
  type CSSProperties,
  type InputHTMLAttributes,
  type ReactNode,
  type TextareaHTMLAttributes,
} from 'react';
import {
  CircleNotch,
  CheckCircle,
  WarningCircle,
  Info,
  Eye,
  EyeSlash,
  MagnifyingGlass,
  FileText,
  CaretLeft,
  CaretRight,
} from '@phosphor-icons/react';
import { Button as BaseButton } from './button';
import { Input as BaseInput } from './input';
import { Textarea } from './textarea';
import { Badge } from './badge';
import { Checkbox as BaseCheckbox } from './checkbox';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from './dialog';
import {
  Select as BaseSelect,
  SelectTrigger,
  SelectValue,
  SelectContent,
  SelectItem,
} from './select';
import { Tooltip as BaseTooltip, TooltipTrigger, TooltipContent } from './tooltip';
import { cn } from '@/lib/utils';

// Application controls keep business views independent of the underlying primitives.
// Focus management, keyboard selection and portal behavior come from shadcn/Radix.
type ButtonProps = Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'type'> & {
  type?: 'primary' | 'default' | 'text' | 'link' | 'dashed';
  htmlType?: 'button' | 'submit' | 'reset';
  size?: 'small' | 'middle' | 'large';
  loading?: boolean;
  block?: boolean;
  danger?: boolean;
  icon?: ReactNode;
};

export function Button({
  type = 'default',
  htmlType = 'button',
  size,
  loading,
  block,
  danger,
  icon,
  children,
  className,
  disabled,
  ...props
}: ButtonProps) {
  return (
    <BaseButton
      {...props}
      data-ui="button"
      type={htmlType}
      variant={
        danger
          ? 'destructive'
          : type === 'primary'
            ? 'default'
            : type === 'text'
              ? 'ghost'
              : type === 'link'
                ? 'link'
                : 'outline'
      }
      size={size === 'small' ? 'sm' : size === 'large' ? 'lg' : 'default'}
      disabled={disabled || loading}
      aria-busy={loading || undefined}
      className={cn(block && 'w-full', className)}
    >
      {loading ? <CircleNotch className="animate-spin" aria-hidden /> : icon}
      {children}
    </BaseButton>
  );
}

type InputProps = Omit<InputHTMLAttributes<HTMLInputElement>, 'size'> & {
  status?: 'error' | 'warning';
  size?: 'small' | 'middle' | 'large';
  allowClear?: boolean;
};
function TextInput({
  status,
  size: _size,
  allowClear: _allowClear,
  className,
  ...props
}: InputProps) {
  return (
    <BaseInput
      {...props}
      data-ui="input"
      className={cn(status === 'error' && 'border-destructive', className)}
    />
  );
}
function Password({ className, ...props }: InputProps) {
  const [visible, setVisible] = useState(false);
  return (
    <div className={cn('password-field', className)}>
      <TextInput {...props} type={visible ? 'text' : 'password'} />
      <Button
        type="text"
        size="small"
        aria-label={visible ? '隐藏密码' : '显示密码'}
        aria-pressed={visible}
        onClick={() => setVisible(!visible)}
        disabled={props.disabled}
      >
        {visible ? <EyeSlash aria-hidden /> : <Eye aria-hidden />}
      </Button>
    </div>
  );
}
type TextAreaProps = TextareaHTMLAttributes<HTMLTextAreaElement> & {
  status?: 'error' | 'warning';
  autoSize?: { minRows: number; maxRows: number } | boolean;
};
function TextArea({ status, autoSize, rows, className, ...props }: TextAreaProps) {
  return (
    <Textarea
      {...props}
      data-ui="textarea"
      rows={rows ?? (typeof autoSize === 'object' ? autoSize.minRows : 4)}
      className={cn(status === 'error' && 'border-destructive', className)}
    />
  );
}
function Search({
  enterButton,
  onSearch,
  className,
  ...props
}: InputProps & { enterButton?: ReactNode; onSearch?: (value: string) => void }) {
  return (
    <div className={cn('search-field', className)}>
      <TextInput
        {...props}
        onKeyDown={(event) => {
          props.onKeyDown?.(event);
          if (event.key === 'Enter' && !event.nativeEvent.isComposing) {
            event.preventDefault();
            onSearch?.(event.currentTarget.value);
          }
        }}
      />
      <Button
        aria-label={typeof enterButton === 'string' ? enterButton : '搜索'}
        disabled={props.disabled}
        onClick={() => onSearch?.(String(props.value ?? ''))}
      >
        {enterButton || <MagnifyingGlass aria-hidden />}
      </Button>
    </div>
  );
}
export const Input = Object.assign(TextInput, { Password, TextArea, Search });
export function InputNumber({
  value,
  onChange,
  precision: _precision,
  ...props
}: Omit<InputProps, 'value' | 'onChange' | 'type'> & {
  value?: number | null;
  onChange?: (value: number | null) => void;
  precision?: number;
}) {
  return (
    <TextInput
      {...props}
      type="number"
      value={value ?? ''}
      onChange={(event) =>
        onChange?.(event.target.value === '' ? null : event.target.valueAsNumber)
      }
    />
  );
}

export function Checkbox({
  children,
  checked,
  onChange,
  className,
  ...props
}: Omit<ComponentProps<typeof BaseCheckbox>, 'onChange' | 'onCheckedChange'> & {
  onChange?: (event: { target: { checked: boolean } }) => void;
}) {
  const generated = useId();
  const id = props.id ?? generated;
  return (
    <label
      className={cn('checkbox-field', props.disabled && 'is-disabled', className)}
      htmlFor={id}
    >
      <BaseCheckbox
        {...props}
        id={id}
        checked={checked}
        onCheckedChange={(next) => onChange?.({ target: { checked: next === true } })}
      />
      {children && <span>{children}</span>}
    </label>
  );
}

type Option = { value: string; label: ReactNode; disabled?: boolean };
export function Select({
  options,
  value,
  onChange,
  disabled,
  loading,
  placeholder = '请选择',
  className,
  style,
  id,
  'aria-label': ariaLabel,
  'aria-describedby': describedBy,
}: {
  options: Option[];
  value?: string;
  onChange?: (value: string) => void;
  disabled?: boolean;
  loading?: boolean;
  placeholder?: string;
  className?: string;
  style?: CSSProperties;
  id?: string;
  'aria-label'?: string;
  'aria-describedby'?: string;
}) {
  return (
    <BaseSelect value={value || ''} onValueChange={onChange} disabled={disabled || loading}>
      <SelectTrigger
        data-ui="select"
        id={id}
        aria-label={ariaLabel}
        aria-describedby={describedBy}
        aria-busy={loading || undefined}
        className={cn('w-full', className)}
        style={style}
      >
        <SelectValue placeholder={placeholder} />
      </SelectTrigger>
      <SelectContent position="popper">
        {options.map((option) => (
          <SelectItem key={option.value} value={option.value} disabled={option.disabled}>
            {option.label}
          </SelectItem>
        ))}
      </SelectContent>
    </BaseSelect>
  );
}

const RadioContext = createContext<{
  value: string;
  disabled?: boolean;
  name: string;
  change?: (value: string) => void;
}>({ value: '', name: '' });
function RadioItem({
  value,
  children,
  disabled,
}: {
  value: string;
  children: ReactNode;
  disabled?: boolean;
}) {
  const group = useContext(RadioContext);
  return (
    <label className="radio-field">
      <input
        type="radio"
        name={group.name}
        value={value}
        checked={group.value === value}
        disabled={disabled || group.disabled}
        onChange={() => group.change?.(value)}
      />
      <span>{children}</span>
    </label>
  );
}
function RadioGroup({
  value,
  onChange,
  options,
  children,
  disabled,
  className,
  ...props
}: {
  value?: string;
  onChange?: (event: { target: { value: string } }) => void;
  options?: (Option | string)[];
  children?: ReactNode;
  disabled?: boolean;
  className?: string;
  'aria-label'?: string;
  id?: string;
}) {
  const name = useId();
  return (
    <RadioContext.Provider
      value={{
        value: value ?? '',
        disabled,
        name,
        change: (next) => onChange?.({ target: { value: next } }),
      }}
    >
      <div
        {...props}
        data-ui="radio-group"
        role="radiogroup"
        className={cn('radio-group', className)}
      >
        {options
          ? options.map((option) => {
              const item = typeof option === 'string' ? { value: option, label: option } : option;
              return (
                <RadioItem key={item.value} value={item.value} disabled={item.disabled}>
                  {item.label}
                </RadioItem>
              );
            })
          : children}
      </div>
    </RadioContext.Provider>
  );
}
export const Radio = Object.assign(RadioItem, { Group: RadioGroup });

export function Alert({
  type = 'info',
  message,
  description,
  action,
  className,
  showIcon = true,
  closable,
  onClose,
}: {
  type?: 'success' | 'error' | 'warning' | 'info';
  message: ReactNode;
  description?: ReactNode;
  action?: ReactNode;
  className?: string;
  showIcon?: boolean;
  closable?: boolean;
  onClose?: () => void;
}) {
  const Icon = type === 'success' ? CheckCircle : type === 'info' ? Info : WarningCircle;
  return (
    <div
      className={cn('notice', `notice-${type}`, className)}
      role={type === 'error' ? 'alert' : 'note'}
      aria-live={type === 'error' ? 'assertive' : 'polite'}
      aria-atomic="true"
    >
      {showIcon && <Icon size={18} aria-hidden className="notice-icon" />}
      <div className="notice-copy">
        <div className="notice-title">{message}</div>
        {description && <div className="notice-description">{description}</div>}
      </div>
      {action && <div className="notice-action">{action}</div>}
      {closable && (
        <Button type="text" size="small" aria-label="关闭提示" onClick={onClose}>
          ×
        </Button>
      )}
    </div>
  );
}

export function Tag({
  color = 'default',
  children,
  className,
}: {
  color?: string;
  children?: ReactNode;
  className?: string;
}) {
  return (
    <Badge
      data-ui="badge"
      variant="secondary"
      className={cn('status-badge', `status-${color}`, className)}
    >
      {children}
    </Badge>
  );
}
export function Spin({ size = 'default' }: { size?: 'small' | 'default' | 'large' }) {
  return (
    <CircleNotch
      aria-label="加载中"
      className={cn('spinner animate-spin', size === 'small' && 'spinner-small')}
    />
  );
}
function EmptyState({
  description = '暂无内容',
  children,
}: {
  description?: ReactNode;
  image?: unknown;
  children?: ReactNode;
}) {
  return (
    <div className="empty-state">
      <FileText size={30} aria-hidden />
      <p>{description}</p>
      {children}
    </div>
  );
}
export const Empty = Object.assign(EmptyState, { PRESENTED_IMAGE_SIMPLE: null });

export function Pagination({
  current = 1,
  pageSize = 20,
  total,
  onChange,
  className,
  disabled,
}: {
  current?: number;
  pageSize?: number;
  total: number;
  onChange?: (page: number) => void;
  className?: string;
  showSizeChanger?: boolean;
  size?: string;
  disabled?: boolean;
}) {
  const count = Math.max(1, Math.ceil(total / pageSize));
  return (
    <nav aria-label="分页" className={cn('pagination', className)}>
      <span className="secondary">
        共 {total} 条 · 第 {current} / {count} 页
      </span>
      <Button
        size="small"
        aria-label="上一页"
        disabled={disabled || current <= 1}
        onClick={() => onChange?.(current - 1)}
      >
        <CaretLeft aria-hidden />
      </Button>
      <Button
        size="small"
        aria-label="下一页"
        disabled={disabled || current >= count}
        onClick={() => onChange?.(current + 1)}
      >
        <CaretRight aria-hidden />
      </Button>
    </nav>
  );
}
export function Steps({
  current = 0,
  status,
  items,
}: {
  current?: number;
  status?: string;
  items: { title: ReactNode }[];
  size?: string;
}) {
  return (
    <ol className="task-steps" aria-label="任务进度">
      {items.map((item, index) => (
        <li
          key={index}
          aria-current={index === current ? 'step' : undefined}
          className={
            index < current
              ? 'is-complete'
              : index === current
                ? status === 'error'
                  ? 'is-error'
                  : 'is-current'
                : ''
          }
        >
          <span aria-hidden>{index < current ? '✓' : index + 1}</span>
          {item.title}
        </li>
      ))}
    </ol>
  );
}

export function Tooltip({ title, children }: { title: ReactNode; children: ReactNode }) {
  return (
    <BaseTooltip>
      <TooltipTrigger asChild>{children}</TooltipTrigger>
      <TooltipContent>{title}</TooltipContent>
    </BaseTooltip>
  );
}

export function Modal({
  open,
  title,
  children,
  onCancel,
  onOk,
  footer,
  width = 640,
  closable = true,
  maskClosable = true,
  keyboard = true,
  confirmLoading,
  okText = '确定',
  cancelText = '取消',
  okButtonProps,
  cancelButtonProps,
  className,
  zIndex,
  returnFocusRef,
  destroyOnClose: _destroy,
  ..._props
}: {
  open?: boolean;
  title: ReactNode;
  children?: ReactNode;
  onCancel?: () => void;
  onOk?: () => void;
  footer?: ReactNode;
  width?: number | string;
  closable?: boolean;
  maskClosable?: boolean;
  keyboard?: boolean;
  confirmLoading?: boolean;
  okText?: string;
  cancelText?: string;
  okButtonProps?: ButtonProps;
  cancelButtonProps?: ButtonProps;
  className?: string;
  zIndex?: number;
  returnFocusRef?: { current: HTMLElement | null };
  destroyOnClose?: boolean;
}) {
  const modalOpener = useRef<HTMLElement | null>(null);
  const dialogContent = useRef<HTMLDivElement | null>(null);
  return (
    <Dialog
      open={Boolean(open)}
      onOpenChange={(next) => {
        if (!next && closable) onCancel?.();
      }}
    >
      <DialogContent
        ref={dialogContent}
        className={cn('workspace-dialog', !closable && 'dialog-no-close', className)}
        style={
          {
            '--dialog-width': typeof width === 'number' ? `${width}px` : width,
            ...(zIndex ? { zIndex } : {}),
          } as CSSProperties
        }
        onEscapeKeyDown={(event) => {
          if (!keyboard || !closable) event.preventDefault();
        }}
        onInteractOutside={(event) => {
          if (!maskClosable || !closable) event.preventDefault();
        }}
        onCloseAutoFocus={(event) => {
          // These dialogs are driven by application state instead of DialogTrigger.
          // Radix restores focus to body without a trigger; restore the opener below.
          const opener = returnFocusRef?.current ?? modalOpener.current;
          if (opener?.isConnected) {
            event.preventDefault();
            opener.focus();
          }
        }}
        onOpenAutoFocus={(event) => {
          if (
            document.activeElement instanceof HTMLElement &&
            document.activeElement !== document.body
          )
            modalOpener.current = document.activeElement;
          // Embedded documents have their own keyboard events. Keep the first
          // focus on a parent-document control so Escape works on opening.
          if (closable && dialogContent.current?.querySelector('iframe')) {
            const close = dialogContent.current.querySelector<HTMLButtonElement>(
              '[data-slot="dialog-close"]',
            );
            if (close) {
              event.preventDefault();
              close.focus();
            }
          }
        }}
      >
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription className="sr-only">
            查看内容并完成本次操作。关闭后返回工作台。
          </DialogDescription>
        </DialogHeader>
        <div className="dialog-body">{children}</div>
        {footer !== null && (
          <div className="modal-actions">
            {footer ?? (
              <>
                <Button onClick={onCancel} {...cancelButtonProps}>
                  {cancelText}
                </Button>
                <Button type="primary" onClick={onOk} loading={confirmLoading} {...okButtonProps}>
                  {okText}
                </Button>
              </>
            )}
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
