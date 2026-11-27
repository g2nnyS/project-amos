import { t } from '../i18n/index.js'
import type { Candidate } from '../types/index.js'

export interface GeneratedProposalMeta {
  title: string
  rationale: string
  expiresAt: string
}

const expiresInSevenDays = () => new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString()

export function generateProposalMeta(projectId: string, baseVersion: number, candidate: Candidate): GeneratedProposalMeta {
  const count = candidate.rules.length
  const title = t('editor.autoTitle', { count })
  const rationale = t('editor.autoRationale', { projectId, baseVersion })
  return { title, rationale, expiresAt: expiresInSevenDays() }
}

export function generateRollbackProposalMeta(projectId: string, baseVersion: number, version: number): GeneratedProposalMeta {
  const title = t('version.autoTitle', { version })
  const rationale = t('version.autoRationale', { projectId, baseVersion, version })
  return { title, rationale, expiresAt: expiresInSevenDays() }
}
