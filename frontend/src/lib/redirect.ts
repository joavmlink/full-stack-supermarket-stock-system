// URL parsers drop tabs and newlines, so "/\t/host" would become "//host".
const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f]/;

/**
 * Where to go after signing in: the page the user asked for, if it is a path
 * inside this app. Anything else (another origin, `//host`, a backslash or a
 * control character, the sign-in page itself, a value that is not a string)
 * goes home.
 */
export function safeRedirectPath(from: unknown): string {
  if (
    typeof from !== 'string' ||
    !from.startsWith('/') ||
    from.startsWith('//') ||
    from.includes('\\') ||
    CONTROL_CHARACTERS.test(from)
  ) {
    return '/';
  }
  if (from === '/login' || from.startsWith('/login?') || from.startsWith('/login#')) return '/';
  return from;
}
