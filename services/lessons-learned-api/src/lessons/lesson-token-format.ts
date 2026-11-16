export function emitsRepresentationTokens(): boolean {
  return process.env.LESSONS_LEARNED_TOKEN_FORMAT === 'representation';
}
