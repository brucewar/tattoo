// Compatibility exports while callers move to the generic document and platform renderer paths.
export { ContentError, inspectDocument } from './document';
export {
  RENDER_VERSION,
  renderDocument,
  validateWechat,
  type WechatLimits,
} from '../platforms/wechat/renderer';
