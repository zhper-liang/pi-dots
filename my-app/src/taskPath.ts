/** Every control carries the owning Bot as well as the Task identity. */
export function taskPath(task: { taskId: number; bot: { id: string }; groupId?: string; groupChild?: boolean }, suffix = '') {
  if (task.groupId) return `/api/groups/${encodeURIComponent(task.groupId)}${task.groupChild ? `/children/${task.taskId}` : ''}${suffix}`
  return `/api/bots/${encodeURIComponent(task.bot.id)}/tasks/${task.taskId}${suffix}`
}
