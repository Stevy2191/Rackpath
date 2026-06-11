// In-memory pub/sub hub for Server-Sent Events, keyed by scan job id.
//
// The scanner POSTs host results and progress updates to the API; those
// handlers call publish() to fan the event out to every browser currently
// subscribed to that job's /stream endpoint. State lives in-process, which is
// fine for the single-instance API container Rackpath ships.

// Map<jobId(string), Set<res>>
const subscribers = new Map();

function subscribe(jobId, res) {
  const key = String(jobId);
  if (!subscribers.has(key)) {
    subscribers.set(key, new Set());
  }
  subscribers.get(key).add(res);
}

function unsubscribe(jobId, res) {
  const key = String(jobId);
  const set = subscribers.get(key);
  if (!set) return;
  set.delete(res);
  if (set.size === 0) {
    subscribers.delete(key);
  }
}

// Push an event to all clients subscribed to `jobId`. `event` is the SSE event
// name (e.g. "host", "progress", "scan_complete"); `data` is JSON-serialized.
function publish(jobId, event, data) {
  const set = subscribers.get(String(jobId));
  if (!set || set.size === 0) return;

  const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const res of set) {
    try {
      res.write(payload);
    } catch (err) {
      // A broken pipe just means the client went away; drop it.
      set.delete(res);
    }
  }
}

module.exports = { subscribe, unsubscribe, publish };
