/**
 * 引擎统一错误：纯 JS 只依赖 Error，不依赖中文文案。
 * 对外返回结构化 code（字符串）或抛 EngineError（err.code 可判定）。
 */

export class EngineError extends Error {
  constructor(code, message, extra = {}) {
    super(message || code);
    this.name = 'EngineError';
    this.code = code;
    Object.assign(this, extra);
  }
}

export function engineError(code, message, extra = {}) {
  return new EngineError(code, message, extra);
}

export function isEngineError(err) {
  return !!err && typeof err === 'object' && typeof err.code === 'string';
}

/** 断言辅助（只用于编程错误/非法入参，业务条件一律走 {ok,error}）。 */
export function assertFiniteMs(ms, name = 'nowMs') {
  if (typeof ms !== 'number' || !Number.isFinite(ms)) {
    throw engineError('INVALID_ARGUMENT', `${name} must be a finite number`, { field: name });
  }
}

export function assertTimeZone(tz) {
  if (typeof tz !== 'string' || tz.length === 0) {
    throw engineError('INVALID_ARGUMENT', 'tz must be an IANA time zone string', { field: 'tz' });
  }
}
