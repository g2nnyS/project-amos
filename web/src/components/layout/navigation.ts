import { House, LayoutDashboard, ListChecks, FilePenLine, GitPullRequest, History, ScrollText, Eye, FlaskConical, ServerCog, Settings } from 'lucide-vue-next'
import { t, type MessageKey } from '@/i18n'

export interface NavItem { labelKey: MessageKey; to: string; icon: typeof LayoutDashboard }
export interface NavSection { labelKey: MessageKey; items: NavItem[] }

export const navSections: NavSection[] = [
  {
    labelKey: 'nav.sections.workspace',
    items: [
      { labelKey: 'nav.home', to: '/', icon: House },
      { labelKey: 'nav.boundary', to: '/boundary', icon: LayoutDashboard },
      { labelKey: 'nav.rules', to: '/rules', icon: ListChecks },
      { labelKey: 'nav.editor', to: '/editor', icon: FilePenLine },
    ],
  },
  {
    labelKey: 'nav.sections.governance',
    items: [
      { labelKey: 'nav.proposals', to: '/proposals', icon: GitPullRequest },
      { labelKey: 'nav.versions', to: '/versions', icon: History },
      { labelKey: 'nav.audit', to: '/audit', icon: ScrollText },
    ],
  },
  {
    labelKey: 'nav.sections.system',
    items: [
      { labelKey: 'nav.observations', to: '/observations', icon: Eye },
      { labelKey: 'nav.simulate', to: '/simulate', icon: FlaskConical },
      { labelKey: 'nav.harnesses', to: '/harnesses', icon: ServerCog },
      { labelKey: 'nav.settings', to: '/settings', icon: Settings },
    ],
  },
]

export const navItems: NavItem[] = navSections.flatMap(section => section.items)

export function isActivePath(path: string, target: string) {
  return target === '/' ? path === '/' : path === target || path.startsWith(`${target}/`)
}

export function pageLabelForPath(path: string) {
  const item = navItems.find(entry => isActivePath(path, entry.to))
  return t(item?.labelKey ?? 'nav.notFound')
}
