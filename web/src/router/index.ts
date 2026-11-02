import { createRouter, createWebHashHistory } from 'vue-router'
export default createRouter({ history: createWebHashHistory(), routes: [
  { path: '/', component: () => import('@/views/OverviewView.vue') },
  { path: '/rules', component: () => import('@/views/RulesView.vue') },
  { path: '/editor', component: () => import('@/views/EditorView.vue') },
  { path: '/proposals', component: () => import('@/views/ProposalsView.vue') },
  { path: '/proposals/:id', component: () => import('@/views/ProposalView.vue') },
  { path: '/versions', component: () => import('@/views/VersionsView.vue') },
  { path: '/versions/:version', component: () => import('@/views/VersionView.vue') },
  { path: '/audit', component: () => import('@/views/AuditView.vue') },
  { path: '/observations', component: () => import('@/views/ObservationsView.vue') },
  { path: '/simulate', component: () => import('@/views/SimulateView.vue') },
  { path: '/settings', component: () => import('@/views/SettingsView.vue') },
  { path: '/:pathMatch(.*)*', component: () => import('@/views/NotFoundView.vue') },
] })
