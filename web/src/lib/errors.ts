import { ApiError } from './api.js'
const messages: Record<string, string> = { password_busy: '密码验证正在处理中，请稍后重试。', password_invalid: '密码需为 12 至 1024 个字符。', enrollment_required: '首次设置需要一次性身份验证。', setup_already_complete: '密码已完成设置，请使用登录方式。', invalid_credentials: '登录凭据无效，请重试。', rate_limited: '尝试过于频繁，请稍后重试。' }
export function authErrorMessage(error: unknown): string { return error instanceof ApiError ? (messages[error.code] ?? error.message) : error instanceof Error ? error.message : '操作失败，请重试。' }
