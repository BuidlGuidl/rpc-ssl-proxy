/**
 * Splice per-item answers back into a batch response.
 *
 * A middleware that answers some items of a batch itself (invalid items, disabled
 * methods) removes them from req.body, lets the rest of the batch be processed, and
 * calls spliceIntoBatchResponse(res, entries, remaining) with the answers it produced,
 * each tagged with the item's position in the batch as this middleware saw it, and
 * the items it left in req.body. When the handler sends an array, the entries are
 * inserted at those positions. If the handler sends one error object for the whole
 * batch (a safety net: every path is meant to answer per item already), that error
 * is copied once per remaining item, with the item's own id, and the entries are
 * inserted into that array, so a batch always gets an array back.
 *
 * Wrappers stack: the middleware that runs first wraps res.send first, so its entries
 * are inserted last, when the array already contains everything the later
 * middlewares put back. Entries must therefore carry indexes relative to the batch
 * as that middleware saw it, and be inserted in ascending order.
 *
 * @param {object} res - Express response
 * @param {{ index: number, response: object }[]} entries - answers to put back
 * @param {object[]} [remaining] - the items left in req.body after removal
 */
function spliceIntoBatchResponse(res, entries, remaining) {
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
      if (!Array.isArray(answers) && answers && typeof answers === 'object' && answers.error && Array.isArray(remaining)) {
        answers = remaining.map(item => ({ jsonrpc: "2.0", id: item?.id ?? null, error: answers.error }));
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
