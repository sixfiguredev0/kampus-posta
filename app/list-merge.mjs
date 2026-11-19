// A first-page refresh keeps rows older than that page (loaded via "Зареди още") and the cursor that continues after them.
// shortcut: kept older rows are not rechecked for moves/expunges until the folder or search changes.
export function mergeFirstPage(rows, cursor, page) {
  const fresh = page.messages;
  if (!fresh.length || rows.some(row => row.epoch !== fresh[0].epoch)) return { rows: fresh, cursor: page.cursor };
  const oldest = Math.min(...fresh.map(row => row.uid));
  const older = rows.filter(row => row.uid < oldest);
  return older.length ? { rows: [...fresh, ...older], cursor } : { rows: fresh, cursor: page.cursor };
}
