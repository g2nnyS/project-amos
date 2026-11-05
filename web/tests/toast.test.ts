import { test } from 'node:test'
import assert from 'node:assert/strict'
import { useToast } from '../src/composables/useToast.js'

test('notifications expire, visible count is bounded, and failures remain dismissible', t => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const { toast, toasts, dismiss } = useToast()
  toast('完成', undefined, 'success')
  toast('说明', undefined, 'info')
  toast('失败', '请重试', 'error')
  toast('失败', '请重试', 'error')
  assert.deepEqual(toasts.value.map(item => item.title), ['完成', '说明'])
  t.mock.timers.tick(5000)
  assert.deepEqual(toasts.value.map(item => item.title), ['说明', '失败'])
  t.mock.timers.tick(60000)
  assert.deepEqual(toasts.value.map(item => item.title), ['失败'])
  dismiss(toasts.value[0]!.id)
  assert.equal(toasts.value.length, 0)
  toast('手动关闭', undefined, 'success')
  dismiss(toasts.value[0]!.id)
  t.mock.timers.tick(5000)
  assert.equal(toasts.value.length, 0)
})
