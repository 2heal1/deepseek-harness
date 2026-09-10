/** Runtime Profile UI copy. */

export type RuntimeProfileKey =
  | 'nav' | 'intro' | 'loading' | 'retry' | 'readOnly' | 'newProfile'
  | 'profiles' | 'profileId' | 'provider' | 'schemaVersion' | 'providerOptionsVersion'
  | 'executable' | 'model' | 'allowModelOverride' | 'resolution' | 'absolute'
  | 'searchPath' | 'cwdPolicy' | 'fixedCwd' | 'enforcement' | 'harnessTransport'
  | 'args' | 'ambientEnv' | 'literalEnv' | 'credentials' | 'nativeTools'
  | 'harnessTools' | 'providerOptions' | 'product' | 'permissionPolicy'
  | 'startupTimeout' | 'turnTimeout' | 'shutdownTimeout' | 'terminationTimeout'
  | 'capacity' | 'save' | 'probe' | 'setDefault' | 'delete' | 'routes'
  | 'routeId' | 'runtimeProfile' | 'toolName' | 'maxDepth'
  | 'providerUnavailable' | 'schemaIncompatible' | 'credentialUnknown'
  | 'credentialReady' | 'credentialMissing' | 'seatHint' | 'headerHint'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** Runtime Profile selector, fixed label, and editor copy. */
    'settings.runtimeProfile': RuntimeProfileKey
  }
}

/** English Runtime Profile UI copy. */
export const en: Record<RuntimeProfileKey, string> = {
  nav: 'Agent runtimes',
  intro: 'Configure executable-backed agent profiles and one-shot subagent routes.',
  loading: 'Loading Runtime Profiles...',
  retry: 'Retry',
  readOnly: 'This settings provider is read-only. Profile and route changes are disabled.',
  newProfile: 'New profile',
  profiles: 'Runtime Profiles',
  profileId: 'Profile ID',
  provider: 'Provider',
  schemaVersion: 'Schema version',
  providerOptionsVersion: 'Provider options version',
  executable: 'Executable',
  model: 'Default model',
  allowModelOverride: 'Allow per-session model override',
  resolution: 'Executable resolution',
  absolute: 'Absolute path',
  searchPath: 'Search paths, one per line',
  cwdPolicy: 'Working directory',
  fixedCwd: 'Fixed working directory',
  enforcement: 'Permission enforcement',
  harnessTransport: 'Harness tool transport',
  args: 'Arguments, one per line',
  ambientEnv: 'Ambient environment allowlist, one per line',
  literalEnv: 'Literal environment, NAME=value',
  credentials: 'Credential references, TARGET=REFERENCE',
  nativeTools: 'Product-native tools, one per line',
  harnessTools: 'Harness tools, one per line',
  providerOptions: 'Provider options JSON',
  product: 'Product configuration JSON',
  permissionPolicy: 'Permission policy JSON',
  startupTimeout: 'Startup timeout (ms)',
  turnTimeout: 'Turn timeout (ms)',
  shutdownTimeout: 'Shutdown timeout (ms)',
  terminationTimeout: 'Termination timeout (ms)',
  capacity: 'Maximum concurrent runs',
  save: 'Save',
  probe: 'Probe',
  setDefault: 'Set as default',
  delete: 'Remove',
  routes: 'One-shot subagent routes',
  routeId: 'Route ID',
  runtimeProfile: 'Runtime Profile',
  toolName: 'Tool name',
  maxDepth: 'Maximum depth',
  providerUnavailable: 'Provider unavailable',
  schemaIncompatible: 'Profile schema incompatible',
  credentialUnknown: 'status unavailable',
  credentialReady: 'configured',
  credentialMissing: 'missing',
  seatHint: 'Runtime Profile for the next Session',
  headerHint: 'Runtime Profile fixed when this Session started',
}

/** Simplified Chinese Runtime Profile UI copy. */
export const zh: Record<RuntimeProfileKey, string> = {
  nav: 'Agent 运行时',
  intro: '配置由可执行文件驱动的 Agent Profile 和一次性子 Agent Route。',
  loading: '正在加载 Runtime Profile...',
  retry: '重试',
  readOnly: '当前设置提供方只读，Profile 与 Route 修改已禁用。',
  newProfile: '新建 Profile',
  profiles: 'Runtime Profile',
  profileId: 'Profile ID',
  provider: 'Provider',
  schemaVersion: 'Schema 版本',
  providerOptionsVersion: 'Provider 选项版本',
  executable: '可执行文件',
  model: '默认模型',
  allowModelOverride: '允许会话覆盖模型',
  resolution: '可执行文件解析',
  absolute: '绝对路径',
  searchPath: '搜索路径，每行一项',
  cwdPolicy: '工作目录',
  fixedCwd: '固定工作目录',
  enforcement: '权限强制级别',
  harnessTransport: 'Harness 工具传输',
  args: '参数，每行一项',
  ambientEnv: '环境变量白名单，每行一项',
  literalEnv: '固定环境变量，NAME=value',
  credentials: '凭据引用，TARGET=REFERENCE',
  nativeTools: '产品原生工具，每行一项',
  harnessTools: 'Harness 工具，每行一项',
  providerOptions: 'Provider 选项 JSON',
  product: '产品配置 JSON',
  permissionPolicy: '权限策略 JSON',
  startupTimeout: '启动超时（毫秒）',
  turnTimeout: '轮次超时（毫秒）',
  shutdownTimeout: '关闭超时（毫秒）',
  terminationTimeout: '终止超时（毫秒）',
  capacity: '最大并发运行数',
  save: '保存',
  probe: '探测',
  setDefault: '设为默认',
  delete: '移除',
  routes: '一次性子 Agent Route',
  routeId: 'Route ID',
  runtimeProfile: 'Runtime Profile',
  toolName: '工具名',
  maxDepth: '最大深度',
  providerUnavailable: 'Provider 不可用',
  schemaIncompatible: 'Profile schema 不兼容',
  credentialUnknown: '状态不可用',
  credentialReady: '已配置',
  credentialMissing: '缺失',
  seatHint: '下一个会话使用的 Runtime Profile',
  headerHint: '本会话启动时固定的 Runtime Profile',
}
