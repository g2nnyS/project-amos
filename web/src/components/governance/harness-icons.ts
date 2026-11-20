import type { Component } from 'vue'
import { Blocks, Bot, Pi, Shell, Sparkle, SquareTerminal, Terminal } from 'lucide-vue-next'

/** Icon shown in front of each harness entry in the probe list. */
export const harnessIcons: Readonly<Record<string, Component>> = {
  pi: Pi,
  opencode: SquareTerminal,
  codex: Bot,
  'claude-code': Sparkle,
  dsh: Terminal,
  'oh-my-pi': Shell,
}

/** Unknown harness ids from the service fall back to a neutral app mark. */
export function harnessIcon(id: string): Component {
  return harnessIcons[id] ?? Blocks
}
