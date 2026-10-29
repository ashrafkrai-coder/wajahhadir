export function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));
}

export function csvCell(value) {
  let text = String(value);
  if (/^[=+@-]/.test(text)) text = "'" + text;
  return `"${text.replace(/"/g, '""')}"`;
}

export function uniqueNames(text, existing = []) {
  const seen = new Set(existing.map((name) => String(name).trim().toLocaleLowerCase()));
  const result = [];
  for (const raw of String(text).split(/\r?\n/)) {
    const name = raw.replace(/^\s*\d+[.)\-\s]+/, '').trim();
    const key = name.toLocaleLowerCase();
    if (name && !seen.has(key)) {
      seen.add(key);
      result.push(name);
    }
  }
  return result;
}

export function isValidBackup(data) {
  return Boolean(data && data.app === 'Hadir Wajah' && Array.isArray(data.students) && data.attendance && typeof data.attendance === 'object' && !Array.isArray(data.attendance));
}
