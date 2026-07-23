// Shared "race two strategies, take the first confirmed win" helper.
// Used by both the accept executor (Path A vs Path B) and the decline executor
// (email-link vs portal). Resolves as soon as any task is a confirmed win;
// otherwise waits for all to settle and returns the best non-error result.

/** Attach a name to a promise result; never rejects (errors become a result). */
export function tagResult(name, promise) {
  return promise.then(
    (r) => ({ ...r, __name: name }),
    (err) => ({ ok: false, outcome: 'error', __name: name, error: String(err) })
  );
}

/**
 * Resolve with the first result for which `onSettle(name,result)` returns true;
 * if none win, resolve with the all-settled "best" (first non-error, else first).
 * @param {Array<Promise<object>>} tasks  promises produced by tagResult()
 * @param {(name:string, result:object)=>boolean} onSettle
 */
export function firstSuccessOrAll(tasks, onSettle) {
  return new Promise((resolve) => {
    let remaining = tasks.length;
    const all = [];
    let resolved = false;
    for (const t of tasks) {
      t.then((result) => {
        all.push(result);
        const win = onSettle(result.__name, result);
        if (win && !resolved) {
          resolved = true;
          resolve(result);
        }
        if (--remaining === 0 && !resolved) {
          resolved = true;
          resolve(all.find((r) => r && r.outcome !== 'error') || all[0] || null);
        }
      });
    }
  });
}
