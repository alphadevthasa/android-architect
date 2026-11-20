// Linear comment and string stripping so signal scans do not match text in comments or string literals.
// Both functions keep one output line per input line and never backtrack: each character is visited once.

/**
 * Kotlin, Java and Gradle text: removes `//` trailing comments, block comments (across lines) and the contents of
 * string and char literals (the quotes stay). Triple-quoted strings span lines; an unterminated block comment or
 * triple-quoted string blanks the rest of the file, an unterminated single-line string ends at the line end.
 */
export function stripCode(lines) {
  let inBlock = false;
  let inRaw = false;
  return lines.map((line) => {
    const n = line.length;
    const out = [];
    let i = 0;
    while (i < n) {
      if (inBlock) {
        const j = line.indexOf('*/', i);
        if (j < 0) break;
        inBlock = false;
        i = j + 2;
        out.push(' ');
        continue;
      }
      if (inRaw) {
        const j = line.indexOf('"""', i);
        if (j < 0) break;
        inRaw = false;
        i = j + 3;
        out.push('""');
        continue;
      }
      const c = line[i];
      if (c === '/' && line[i + 1] === '/') break;
      if (c === '/' && line[i + 1] === '*') {
        inBlock = true;
        i += 2;
        continue;
      }
      if (c === '"' && line.startsWith('"""', i)) {
        inRaw = true;
        i += 3;
        continue;
      }
      if (c === '"' || c === "'") {
        let j = i + 1;
        while (j < n && line[j] !== c) j += line[j] === '\\' ? 2 : 1;
        out.push(c + c);
        i = j + 1;
        continue;
      }
      out.push(c);
      i++;
    }
    return out.join('');
  });
}

/** XML text: removes `<!-- ... -->` comments, also across lines (an unterminated comment blanks the rest). */
export function stripXmlComments(lines) {
  let inComment = false;
  return lines.map((line) => {
    let out = '';
    let i = 0;
    while (i < line.length) {
      if (inComment) {
        const j = line.indexOf('-->', i);
        if (j < 0) break;
        inComment = false;
        i = j + 3;
        out += ' ';
        continue;
      }
      const j = line.indexOf('<!--', i);
      if (j < 0) {
        out += line.slice(i);
        break;
      }
      out += line.slice(i, j);
      inComment = true;
      i = j + 4;
    }
    return out;
  });
}
