/** Deterministic test output; never invokes a model or external tool. */
export function createTestReply(message) {
  return { mode: 'test', reply: { role: 'assistant', content: `[测试回复，非模型输出] 收到：${message}` } }
}
