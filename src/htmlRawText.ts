export function escapeScriptRawText(value: string): string {
  return value.replace(/<\/script/gi, '<\\/script');
}

export function escapeStyleRawText(value: string): string {
  return value.replace(/<\/style/gi, '<\\/style');
}
