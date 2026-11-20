import { ApiError } from './api.js'
import { t, type MessageKey } from '../i18n/index.js'
const messages: Readonly<Record<string, MessageKey>> = { password_busy: 'auth.errors.passwordBusy', password_invalid: 'auth.errors.passwordLength', enrollment_required: 'auth.errors.enrollmentRequired', setup_already_complete: 'auth.errors.setupComplete', invalid_credentials: 'auth.errors.invalidCredentials', rate_limited: 'auth.errors.rateLimited' }
export function authErrorMessage(error: unknown): string { if (error instanceof ApiError) { const key = messages[error.code]; return key ? t(key) : error.message } return error instanceof Error ? error.message : t('auth.errors.generic') }
