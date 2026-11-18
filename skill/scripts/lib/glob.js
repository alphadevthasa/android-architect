const SPECIAL = /[.+^$()|[\]\\]/;

/**
 * Convert a POSIX glob into an anchored RegExp matched against relative
 * POSIX paths. Supports `**` (any depth, including zero directories when
 * written as `**\/`), `*` and `?` (within one path segment) and `{a,b}`.
 */
export function globToRegExp(glob) {
  let re = '';
  let braceDepth = 0;
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === '*') {
      if (glob[i + 1] === '*') {
        if (glob[i + 2] === '/') {
          re += '(?:.*/)?';
          i += 2;
        } else {
          re += '.*';
          i += 1;
        }
      } else {
        re += '[^/]*';
      }
    } else if (c === '?') {
      re += '[^/]';
    } else if (c === '{') {
      re += '(?:';
      braceDepth++;
    } else if (c === '}' && braceDepth > 0) {
      re += ')';
      braceDepth--;
    } else if (c === ',' && braceDepth > 0) {
      re += '|';
    } else {
      re += SPECIAL.test(c) || c === '{' || c === '}' ? '\\' + c : c;
    }
  }
  return new RegExp(`^${re}$`);
}
