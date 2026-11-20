export type PlatformErrorFlags = {
  invalidCover?: boolean;
  invalidBodyImage?: boolean;
  writePermissionDenied?: boolean;
};

/** Errors crossing the platform boundary contain safe messages and explicit retry semantics. */
export class PlatformError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly uncertain: boolean,
    public readonly suggestion = uncertain
      ? '请先在平台后台核对是否已创建，记录核对结果前不要重试'
      : '请检查账号、素材和平台权限后重试',
    private readonly flags: PlatformErrorFlags = {},
  ) {
    super(message);
    this.name = 'PlatformError';
  }

  get invalidCover() {
    return this.flags.invalidCover ?? false;
  }
  get invalidBodyImage() {
    return this.flags.invalidBodyImage ?? false;
  }
  get writePermissionDenied() {
    return this.flags.writePermissionDenied ?? false;
  }
}
