/**
 * Splice per-item answers back into a batch response.
 *
 * A middleware that answers some items of a batch itself (invalid items, disabled
 * methods) removes them from req.body, lets the rest of the batch be processed, and
 * calls spliceIntoBatchResponse(res, entries) with the answers it produced, each
 * tagged with the item's position in the original batch. When the handler sends an
 * array, the entries are inserted at those positions; a non-array body (a single
 * error object for the whole batch, e.g. from the rate limiter) is sent unchanged.
 *
 * Wrappers stack: the middleware that runs first wraps res.send first, so its entries
 * are inserted last, when the array already contains everything the later
 * middlewares put back. Entries must therefore carry indexes relative to the batch
 * as that middleware saw it, and be inserted in ascending order.
 *
 * @param {object} res - Express response
 * @param {{ index: number, response: object }[]} entries - answers to put back
 */
function spliceIntoBatchResponse(res, entries) {
  const sorted = entries.slice().sort((a, b) => a.index - b.index);
  const originalSend = res.send;
  let mergedOnce = false; // res.send(object) re-enters res.send(string) via res.json
  res.send = function (body) {
    if (mergedOnce) return originalSend.call(this, body);
    mergedOnce = true;
    let merged = body;
    try {
      let answers = body;
      if (typeof body === 'string') {
        try { answers = JSON.parse(body); } catch { answers = body; }
      }
      if (Array.isArray(answers)) {
        merged = answers.slice();
        for (const e of sorted) merged.splice(e.index, 0, e.response);
        if (typeof body === 'string') merged = JSON.stringify(merged);
      }
    } catch (err) {
      console.error('[batchMerge] merge failed, sending upstream body unchanged:', err?.message || err);
      merged = body;
    }
    return originalSend.call(this, merged);
  };
}

export { spliceIntoBatchResponse };
