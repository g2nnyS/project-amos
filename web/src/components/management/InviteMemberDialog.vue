<script setup lang="ts">
import { computed, nextTick, reactive, watch } from 'vue'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { useToast } from '@/composables/useToast'
import NativeSelect from './NativeSelect.vue'
import {
  focusById,
  INVITE_ROLES,
  isInviteRole,
  isValidEmail,
  type InviteFormValues,
} from './utils'

const props = defineProps<{
  open: boolean
  existingEmails: string[]
}>()

const emit = defineEmits<{
  'update:open': [value: boolean]
  submit: [values: InviteFormValues]
}>()
const { toast } = useToast()

const form = reactive({
  name: '',
  email: '',
  role: 'Member',
})

const errors = reactive<{ name?: string; email?: string; role?: string }>({})

const isOpen = computed({
  get: () => props.open,
  set: (value: boolean) => emit('update:open', value),
})

const knownEmails = computed(() => new Set(props.existingEmails.map((email) => email.trim().toLowerCase())))

watch(
  () => props.open,
  (open) => {
    if (!open) return
    form.name = ''
    form.email = ''
    form.role = 'Member'
    errors.name = undefined
    errors.email = undefined
    errors.role = undefined
    void nextTick(() => focusById('invite-member-name'))
  },
)

function handleSubmit() {
  errors.name = undefined
  errors.email = undefined
  errors.role = undefined

  const name = form.name.trim()
  const email = form.email.trim()

  if (!name) {
    errors.name = 'Enter a name.'
  } else if (name.length > 80) {
    errors.name = 'Use 80 characters or fewer.'
  }

  if (!email) {
    errors.email = 'Enter an email address.'
  } else if (!isValidEmail(email)) {
    errors.email = 'Enter a valid email address, such as name@company.com.'
  } else if (knownEmails.value.has(email.toLowerCase())) {
    errors.email = 'This email already has access to the workspace.'
    toast('Could not invite member', errors.email, 'error')
  }

  if (!isInviteRole(form.role)) {
    errors.role = 'Choose Admin, Member, or Viewer.'
  }

  const firstInvalid = errors.name ? 'invite-member-name' : errors.email ? 'invite-member-email' : errors.role ? 'invite-member-role' : null
  if (firstInvalid) {
    void nextTick(() => focusById(firstInvalid))
    return
  }

  const role = form.role
  if (!isInviteRole(role)) return

  emit('submit', { name, email, role })
}
</script>

<template>
  <Dialog v-model:open="isOpen">
    <DialogContent class="max-h-[90dvh] overflow-y-auto sm:max-w-md">
      <DialogHeader>
        <DialogTitle>Invite member</DialogTitle>
        <DialogDescription>
          Add someone to this workspace as a local demo record. No email is sent and nothing leaves this device.
        </DialogDescription>
      </DialogHeader>

      <form class="space-y-4" novalidate @submit.prevent="handleSubmit">
        <div class="space-y-1.5">
          <Label for="invite-member-name">Name</Label>
          <Input
            id="invite-member-name"
            v-model="form.name"
            type="text"
            autocomplete="off"
            maxlength="100"
            placeholder="e.g. Jordan Lee"
            :aria-invalid="errors.name ? 'true' : undefined"
            :aria-describedby="errors.name ? 'invite-member-name-error' : undefined"
          />
          <p v-if="errors.name" id="invite-member-name-error" role="alert" class="text-xs text-destructive">
            {{ errors.name }}
          </p>
        </div>

        <div class="space-y-1.5">
          <Label for="invite-member-email">Email</Label>
          <Input
            id="invite-member-email"
            v-model="form.email"
            type="email"
            autocomplete="off"
            maxlength="120"
            placeholder="name@company.com"
            :aria-invalid="errors.email ? 'true' : undefined"
            :aria-describedby="errors.email ? 'invite-member-email-error' : 'invite-member-email-hint'"
          />
          <p v-if="errors.email" id="invite-member-email-error" role="alert" class="text-xs text-destructive">
            {{ errors.email }}
          </p>
          <p v-else id="invite-member-email-hint" class="text-xs text-muted-foreground">
            Used only to identify the member in this local workspace.
          </p>
        </div>

        <div class="space-y-1.5">
          <Label for="invite-member-role">Role</Label>
          <NativeSelect id="invite-member-role" v-model="form.role" :invalid="Boolean(errors.role)">
            <option v-for="role in INVITE_ROLES" :key="role" :value="role">{{ role }}</option>
          </NativeSelect>
          <p v-if="errors.role" id="invite-member-role-error" role="alert" class="text-xs text-destructive">
            {{ errors.role }}
          </p>
          <p v-else class="text-xs text-muted-foreground">
            Owner access is assigned when a workspace is created, so invites cannot change who owns this workspace.
          </p>
        </div>

        <DialogFooter class="gap-2 pt-1">
          <Button type="button" variant="outline" @click="isOpen = false">Cancel</Button>
          <Button type="submit">Simulate invite</Button>
        </DialogFooter>
      </form>
    </DialogContent>
  </Dialog>
</template>
