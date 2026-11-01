import { LayoutDashboard, ListChecks, FilePenLine, GitPullRequest, History, ScrollText, Eye, FlaskConical, Settings } from 'lucide-vue-next'
export const navItems = [
  { label: '总览', to: '/', icon: LayoutDashboard },
  { label: '规则库', to: '/rules', icon: ListChecks },
  { label: '候选编辑', to: '/editor', icon: FilePenLine },
  { label: '提案', to: '/proposals', icon: GitPullRequest },
  { label: '版本', to: '/versions', icon: History },
  { label: '治理审计', to: '/audit', icon: ScrollText },
  { label: '观察记录', to: '/observations', icon: Eye },
  { label: '动作模拟', to: '/simulate', icon: FlaskConical },
  { label: '设置', to: '/settings', icon: Settings },
]
export function isActivePath(path: string, target: string) { return target === '/' ? path === '/' : path === target || path.startsWith(`${target}/`) }
export function pageLabelForPath(path: string) { return navItems.find(item => isActivePath(path, item.to))?.label ?? '未找到页面' }
