import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { test } from 'node:test'
import ts from 'typescript'

const CHAT_METHODS = Object.freeze([
  'chatgpt',
  'chatgpt1',
  'getAllConversations',
  'destroyConversations',
  'endAllConversations',
  'switch2Picture',
  'switch2Text',
  'switch2Audio',
  'switchTTSSource',
  'setDefaultRole',
  'totalAvailable',
  'joinConversation'
])

async function parseShell (relativePath) {
  const url = new URL(relativePath, import.meta.url)
  const source = await readFile(url, 'utf8')
  return {
    source,
    file: ts.createSourceFile(
      url.pathname,
      source,
      ts.ScriptTarget.ES2022,
      true,
      ts.ScriptKind.JS
    )
  }
}

function importsOf (file) {
  return file.statements
    .filter(ts.isImportDeclaration)
    .map(node => node.moduleSpecifier.text)
}

function exportedClass (file) {
  const classes = file.statements.filter(ts.isClassDeclaration)
  assert.equal(classes.length, 1)
  const declaration = classes[0]
  assert.ok(declaration.modifiers?.some(item => item.kind === ts.SyntaxKind.ExportKeyword))
  return declaration
}

function methodNames (declaration) {
  return declaration.members
    .filter(ts.isMethodDeclaration)
    .filter(member => member.name.getText() !== 'constructor')
    .map(member => member.name.getText())
}

function assertSingleDelegate (source, className, method, target) {
  const pattern = new RegExp(
    `async\\s+${method}\\s*\\(event\\)\\s*\\{\\s*` +
    `return await getProductionYunzaiAgent\\(\\)\\.${target}\\.${method}\\(event\\)\\s*` +
    '\\}'
  )
  assert.match(source, pattern, `${className}.${method} must be a one-for-one delegate`)
}

test('chat BYM and approval shells preserve metadata rules and delegate one-for-one', async () => {
  const chat = await parseShell('../../apps/chat.js')
  const bym = await parseShell('../../apps/bym.js')
  const approval = await parseShell('../../apps/approval.js')

  const expectedImports = [
    '../../../lib/plugins/plugin.js',
    '../dist/runtime/production-yunzai-agent.js'
  ]
  for (const shell of [chat, bym, approval]) {
    assert.deepEqual(importsOf(shell.file), expectedImports)
  }

  const chatClass = exportedClass(chat.file)
  assert.equal(chatClass.name?.text, 'chatgpt')
  assert.deepEqual(methodNames(chatClass), CHAT_METHODS)
  assert.match(chat.source, /name:\s*'ChatGpt 对话'/)
  assert.match(chat.source, /event:\s*'message'/)
  assert.match(chat.source, /priority:\s*1144/)
  assert.match(chat.source, /rule:\s*getProductionYunzaiAgent\(\)\.chatController\.rules/)
  for (const method of CHAT_METHODS) {
    assertSingleDelegate(chat.source, 'chatgpt', method, 'chatController')
  }

  const bymClass = exportedClass(bym.file)
  assert.equal(bymClass.name?.text, 'bym')
  assert.deepEqual(methodNames(bymClass), ['bym'])
  assert.match(bym.source, /name:\s*'ChatGPT-Plugin 伪人bym'/)
  assert.match(bym.source, /event:\s*'message'/)
  assert.match(bym.source, /priority:\s*5000/)
  assert.match(bym.source, /priority:\s*'-1000000'/)
  assert.match(bym.source, /reg:\s*'\^\[\^#\]\[sS\]\*'/)
  assertSingleDelegate(bym.source, 'bym', 'bym', 'bymController')

  const approvalClass = exportedClass(approval.file)
  assert.equal(approvalClass.name?.text, 'approval')
  assert.deepEqual(methodNames(approvalClass), ['confirmToolOperation'])
  assert.match(approval.source, /name:\s*'GroupMate 工具审批'/)
  assert.match(approval.source, /event:\s*'message'/)
  assert.match(approval.source, /priority:\s*1143/)
  assert.match(approval.source, /reg:\s*'\^\(确认\|拒绝\)\$'/)
  assertSingleDelegate(
    approval.source,
    'approval',
    'confirmToolOperation',
    'approvalController'
  )
})

test('owner diagnostics is a thin production-root shell with fixed master rules', async () => {
  const diagnostics = await parseShell('../../apps/diagnostics.js')

  assert.deepEqual(importsOf(diagnostics.file), [
    '../../../lib/plugins/plugin.js',
    '../dist/runtime/production-yunzai-agent.js'
  ])
  const declaration = exportedClass(diagnostics.file)
  assert.equal(declaration.name?.text, 'diagnostics')
  assert.deepEqual(methodNames(declaration), ['status', 'diagnose'])
  assert.match(diagnostics.source, /name:\s*'GroupMate 主人诊断'/)
  assert.match(diagnostics.source, /event:\s*'message'/)
  assert.match(diagnostics.source, /reg:\s*'\^#GroupMate状态\$'/)
  assert.match(
    diagnostics.source,
    /reg:\s*'\^#GroupMate诊断\\\\s\+\(\[0-9a-f\]\{32\}\)\$'/
  )
  assert.equal((diagnostics.source.match(/permission:\s*'master'/g) ?? []).length, 2)
  assert.match(diagnostics.source, /\.diagnosticsController\.handleStatus\(/)
  assert.match(diagnostics.source, /\.diagnosticsController\.handleInspect\(/)
  for (const forbidden of [
    'Config', 'Redis', 'MetricsRegistry', 'TraceStore', 'OwnerDiagnostics',
    'initializeProductionYunzaiAgent'
  ]) {
    assert.equal(diagnostics.source.includes(forbidden), false, `${forbidden} direct edge`)
  }
})

test('production root is initialized before shells load in any filesystem order', async () => {
  const index = await parseShell('../../index.js')
  const initialization = index.source.indexOf('initializeProductionYunzaiAgent({')
  const discovery = index.source.indexOf("fs.readdirSync(resolvePluginPath('apps'))")

  assert.ok(initialization >= 0)
  assert.ok(discovery >= 0)
  assert.ok(initialization < discovery)
  assert.match(index.source, /Promise\.allSettled\(files\.map\(/)
  assert.doesNotMatch(index.source, /sort\([^)]*(chat|diagnostics)/i)
})
