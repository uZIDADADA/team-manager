export function requireWorkerToken(value?: string): string {
  const token = value?.trim() ?? '';
  if (!/^[A-Za-z0-9_-]{32,}$/.test(token)) {
    throw new Error('配置 transport.curlCffiToken 必须是至少 32 位的随机字母、数字、下划线或连字符');
  }
  return token;
}
