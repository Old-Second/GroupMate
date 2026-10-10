export function updateCommandMessage (input: Readonly<{
  isMaster: boolean
  version: string
  commit: string | null
}>): string | null {
  if (!input.isMaster) return null
  const version = /^\d+\.\d+\.\d+(?:[-+][\w.-]+)?$/.test(input.version) ? input.version : '未知'
  const commit = input.commit !== null && /^[a-f0-9]{7,40}$/.test(input.commit) ? input.commit : '未知'
  return `GroupMate 当前版本：${version}（${commit}）\n` +
    '更新请由维护者完成本地验证，再从 groupmate 分支按受控部署流程发布。\n' +
    '版本与更新说明：https://github.com/Old-Second/GroupMate'
}
