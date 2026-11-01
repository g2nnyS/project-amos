<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { Search, UserMinus, UserPlus, X } from 'lucide-vue-next'
import { Button } from '@/components/ui/button'
import PageHeader from '@/components/common/PageHeader.vue'
import EmptyState from '@/components/common/EmptyState.vue'
import StatusBadge from '@/components/common/StatusBadge.vue'
import ConfirmDialog from '@/components/management/ConfirmDialog.vue'
import InviteMemberDialog from '@/components/management/InviteMemberDialog.vue'
import NativeSelect from '@/components/management/NativeSelect.vue'
import {
  errorMessage,
  initialsOf,
  isTeamRole,
  roleRank,
  TEAM_ROLES,
  type InviteFormValues,
} from '@/components/management/utils'
import { useDataStore } from '@/stores/data'
import { useWorkspaceStore } from '@/stores/workspace'
import { useToast } from '@/composables/useToast'
import { formatDate } from '@/lib/format'
import type { TeamMember } from '@/types'

const data = useDataStore()
const workspace = useWorkspaceStore()
const { toast } = useToast()

const search = ref('')
const roleFilter = ref('all')
const searchInput = ref<HTMLInputElement | null>(null)

const inviteOpen = ref(false)
const roleTarget = ref<TeamMember | null>(null)
const roleNext = ref<TeamMember['role'] | null>(null)
const removeTarget = ref<TeamMember | null>(null)

const workspaceName = computed(() => workspace.activeWorkspace?.name ?? 'this workspace')
const members = computed<TeamMember[]>(() => data.members)
const existingEmails = computed(() => members.value.map((member) => member.email))

const ownerCount = computed(() => members.value.filter((member) => member.role === 'Owner').length)
const activeCount = computed(
  () => members.value.filter((member) => member.status === 'Active').length,
)
const invitedCount = computed(
  () => members.value.filter((member) => member.status === 'Invited').length,
)

const normalizedQuery = computed(() => search.value.trim().toLowerCase())
const hasFilters = computed(
  () => normalizedQuery.value.length > 0 || roleFilter.value !== 'all',
)

const filteredMembers = computed(() =>
  members.value
    .filter((member) => roleFilter.value === 'all' || member.role === roleFilter.value)
    .filter((member) => {
      const query = normalizedQuery.value
      if (!query) return true
      return (
        member.name.toLowerCase().includes(query) ||
        member.email.toLowerCase().includes(query)
      )
    })
    .slice()
    .sort((a, b) => {
      const rank = roleRank(a.role) - roleRank(b.role)
      if (rank !== 0) return rank
      return a.name.localeCompare(b.name)
    }),
)

const emptyTitle = computed(() =>
  members.value.length === 0 ? 'No members yet' : 'No members match',
)
const emptyDescription = computed(() =>
  members.value.length === 0
    ? `Invite someone to ${workspaceName.value}. Invitations are simulated locally.`
    : 'Try a different search term or switch the role filter.',
)

const roleDialogDescription = computed(() => {
  const member = roleTarget.value
  const nextRole = roleNext.value
  if (!member || !nextRole) return ''
  return `${member.name} will become ${nextRole === 'Admin' || nextRole === 'Owner' ? 'an' : 'a'} ${nextRole} in ${workspaceName.value}.`
})

const removeDialogDescription = computed(() => {
  const member = removeTarget.value
  if (!member) return ''
  return `${member.name} (${member.email}) will be removed from the local member list for ${workspaceName.value}. No real account access will change.`
})

watch(
  () => workspace.activeWorkspaceId,
  () => {
    search.value = ''
    roleFilter.value = 'all'
    inviteOpen.value = false
    roleTarget.value = null
    roleNext.value = null
    removeTarget.value = null
  },
)

function isSoleOwner(member: TeamMember): boolean {
  return member.role === 'Owner' && ownerCount.value <= 1
}

function displayedRole(member: TeamMember): TeamMember['role'] {
  if (roleTarget.value?.id === member.id && roleNext.value) return roleNext.value
  return member.role
}

function clearSearch() {
  search.value = ''
  searchInput.value?.focus()
}

function resetFilters() {
  search.value = ''
  roleFilter.value = 'all'
  searchInput.value?.focus()
}

function openInvite() {
  inviteOpen.value = true
}

function requestRoleChange(member: TeamMember, value: string) {
  if (!isTeamRole(value)) return
  const nextRole = value
  if (nextRole === member.role) return

  if (member.status === 'Invited' && nextRole === 'Owner') {
    toast('Cannot assign owner', 'An invited member cannot become an owner in this local demo.', 'error')
    return
  }

  if (isSoleOwner(member) && nextRole !== 'Owner') {
    toast(
      'Owner required',
      `${member.name} is the workspace's only owner. Promote another member to Owner before changing this role.`,
      'error',
    )
    return
  }

  roleTarget.value = member
  roleNext.value = nextRole
}

function openRemove(member: TeamMember) {
  if (isSoleOwner(member)) {
    toast(
      'Owner required',
      `${member.name} is the workspace's only owner and cannot be removed. Promote another member to Owner first.`,
      'error',
    )
    return
  }
  removeTarget.value = member
}

async function inviteMember(values: InviteFormValues) {
  try {
    const existingIds = new Set(members.value.map((member) => member.id))
    await data.inviteMember(values)
    const created = members.value.find(
      (member) => !existingIds.has(member.id) && member.email.toLowerCase() === values.email.toLowerCase(),
    )
    if (!created) throw new Error('The invitation was not added to this workspace.')
    inviteOpen.value = false
    toast(
      'Invitation simulated',
      `${created.name} was added to ${workspaceName.value} as ${created.role}. No email was sent.`,
      'success',
    )
  } catch (error) {
    toast('Could not invite member', errorMessage(error), 'error')
  }
}

async function applyRoleChange() {
  const member = roleTarget.value
  const nextRole = roleNext.value
  if (!member || !nextRole) return
  try {
    await data.updateMember(member.id, { role: nextRole })
    const updated = members.value.find((item) => item.id === member.id)
    if (!updated || updated.role !== nextRole) {
      throw new Error('The role was not changed.')
    }
    roleTarget.value = null
    roleNext.value = null
    toast('Role updated', `${member.name} is now ${nextRole} in ${workspaceName.value}.`, 'success')
  } catch (error) {
    toast('Could not change role', errorMessage(error), 'error')
  }
}

async function removeMember() {
  const member = removeTarget.value
  if (!member) return
  try {
    await data.removeMember(member.id)
    if (members.value.some((item) => item.id === member.id)) {
      throw new Error('The member could not be removed.')
    }
    removeTarget.value = null
    toast('Member removed', `${member.name} was removed from the local member list for ${workspaceName.value}.`, 'success')
  } catch (error) {
    toast('Could not remove member', errorMessage(error), 'error')
  }
}
</script>

<template>
  <div class="page">
    <PageHeader
      title="Team"
      description="People with access to this workspace. Invites, role changes, and removals happen locally in this demo and never send email."
    >
      <template #actions>
        <span class="hidden items-center gap-2 text-[11.5px] text-muted-foreground sm:inline-flex">
          <span class="tabular">{{ members.length }}</span>
          members
          <span class="text-muted-foreground/50">·</span>
          <span class="tabular">{{ invitedCount }}</span>
          invited
        </span>
        <Button size="sm" class="gap-1.5" @click="openInvite">
          <UserPlus class="size-3.5" aria-hidden="true" />
          Invite member
        </Button>
      </template>
    </PageHeader>

    <section class="panel" aria-labelledby="team-heading">
      <h2 id="team-heading" class="sr-only">Workspace members</h2>

      <div class="filterbar">
        <div class="relative w-full sm:w-[260px]">
          <label for="team-search" class="sr-only">Search members</label>
          <Search
            class="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground"
            aria-hidden="true"
          />
          <input
            id="team-search"
            ref="searchInput"
            v-model="search"
            type="search"
            autocomplete="off"
            spellcheck="false"
            placeholder="Search by name or email…"
            class="h-8 w-full rounded-md border border-input bg-background pl-8 pr-8 text-[12.5px] text-foreground placeholder:text-muted-foreground/70 transition-colors hover:border-border focus:border-ring focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/25 [&::-webkit-search-cancel-button]:hidden"
          />
          <button
            v-if="search"
            type="button"
            class="absolute right-1.5 top-1/2 grid size-5 -translate-y-1/2 place-items-center rounded-[4px] text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
            aria-label="Clear search"
            @click="clearSearch"
          >
            <X class="size-3" aria-hidden="true" />
          </button>
        </div>

        <div class="w-full sm:w-[140px]">
          <label for="team-role-filter" class="sr-only">Filter by role</label>
          <NativeSelect id="team-role-filter" v-model="roleFilter">
            <option value="all">All roles</option>
            <option v-for="role in TEAM_ROLES" :key="role" :value="role">{{ role }}</option>
          </NativeSelect>
        </div>

        <button
          v-if="hasFilters"
          type="button"
          class="ml-auto h-7 rounded-md px-2 text-[11.5px] font-medium text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
          @click="resetFilters"
        >
          Reset filters
        </button>

        <p v-else class="ml-auto hidden text-[11px] text-muted-foreground sm:block" aria-live="polite">
          <span class="tabular">{{ activeCount }}</span>
          active
          <span class="text-muted-foreground/50">·</span>
          <span class="tabular">{{ invitedCount }}</span>
          invited
        </p>
      </div>

      <div v-if="filteredMembers.length === 0" class="p-4 sm:p-5">
        <EmptyState :title="emptyTitle" :description="emptyDescription">
          <Button v-if="hasFilters" variant="outline" size="sm" @click="resetFilters">
            Clear search and filters
          </Button>
          <Button v-else size="sm" class="gap-1.5" @click="openInvite">
            <UserPlus class="size-3.5" aria-hidden="true" />
            Invite member
          </Button>
        </EmptyState>
      </div>

      <div v-else class="overflow-x-auto scroll-thin">
        <table class="data-table min-w-[720px]">
          <caption class="sr-only">Members of {{ workspaceName }}, owners first</caption>
          <thead>
            <tr>
              <th scope="col">Member</th>
              <th scope="col" class="w-[150px]">Role</th>
              <th scope="col" class="w-[110px]">Status</th>
              <th scope="col" class="w-[130px]">Joined</th>
              <th scope="col" class="w-[64px]">
                <span class="sr-only">Actions</span>
              </th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="member in filteredMembers" :key="member.id">
              <td>
                <span class="flex min-w-0 items-center gap-2.5">
                  <span
                    class="grid size-7 shrink-0 place-items-center rounded-full border border-border bg-muted text-[10px] font-semibold uppercase text-muted-foreground"
                    aria-hidden="true"
                  >
                    {{ initialsOf(member.name) }}
                  </span>
                  <span class="min-w-0">
                    <span class="flex items-center gap-1.5">
                      <span class="truncate text-[13px] font-medium text-foreground">
                        {{ member.name }}
                      </span>
                      <span
                        v-if="isSoleOwner(member)"
                        class="rounded-[4px] border border-border px-1 text-[9.5px] font-semibold uppercase tracking-[0.06em] text-muted-foreground"
                      >
                        Owner
                      </span>
                    </span>
                    <span class="block truncate text-[11.5px] text-muted-foreground">
                      {{ member.email }}
                    </span>
                  </span>
                </span>
              </td>
              <td>
                <div class="w-[118px]">
                  <NativeSelect
                    :id="`member-role-${member.id}`"
                    :model-value="displayedRole(member)"
                    :disabled="isSoleOwner(member)"
                    :sr-label="`Role for ${member.name}`"
                    @update:model-value="requestRoleChange(member, $event)"
                  >
                    <option v-for="role in TEAM_ROLES" :key="role" :value="role" :disabled="member.status === 'Invited' && role === 'Owner' && member.role !== 'Owner'">
                      {{ role }}
                    </option>
                  </NativeSelect>
                </div>
                <p v-if="isSoleOwner(member)" class="mt-1 text-[10px] text-muted-foreground">
                  Last owner
                </p>
              </td>
              <td>
                <StatusBadge :status="member.status" />
              </td>
              <td class="tabular whitespace-nowrap text-[12px] text-muted-foreground">
                {{ formatDate(member.joinedAt) }}
              </td>
              <td class="text-right">
                <Button
                  variant="ghost"
                  size="icon-sm"
                  class="text-muted-foreground hover:text-destructive"
                  :disabled="isSoleOwner(member)"
                  :aria-label="`Remove ${member.name}`"
                  @click="openRemove(member)"
                >
                  <UserMinus class="size-4" aria-hidden="true" />
                </Button>
              </td>
            </tr>
          </tbody>
        </table>
      </div>

      <div
        v-if="filteredMembers.length > 0"
        class="flex flex-wrap items-center justify-between gap-2 border-t border-hairline px-3.5 py-2.5 text-[11px] text-muted-foreground"
      >
        <p aria-live="polite">
          Showing
          <span class="tabular text-foreground">{{ filteredMembers.length }}</span>
          of
          <span class="tabular text-foreground">{{ members.length }}</span>
          {{ members.length === 1 ? 'member' : 'members' }}. Role and removal changes are saved
          locally.
        </p>
        <p class="tabular">
          {{ ownerCount }} {{ ownerCount === 1 ? 'owner' : 'owners' }}
        </p>
      </div>
    </section>

    <InviteMemberDialog
      v-model:open="inviteOpen"
      :existing-emails="existingEmails"
      @submit="inviteMember"
    />

    <ConfirmDialog
      :open="Boolean(roleTarget)"
      title="Change role?"
      :description="roleDialogDescription"
      confirm-label="Change role"
      @update:open="(value) => { if (!value) { roleTarget = null; roleNext = null } }"
      @confirm="applyRoleChange"
    />

    <ConfirmDialog
      :open="Boolean(removeTarget)"
      title="Remove member?"
      :description="removeDialogDescription"
      confirm-label="Remove member"
      destructive
      @update:open="(value) => { if (!value) removeTarget = null }"
      @confirm="removeMember"
    />
  </div>
</template>
