export function supportsEncryptedRequest(method: string): boolean {
  return ['POST', 'PUT'].includes(method.toUpperCase());
}
