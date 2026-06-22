// Bounded-concurrency settle-all helper. Runs fn over items with at most
// `limit` promises in flight, returning Promise.allSettled-shaped results in
// input order. limit <= 0 is treated as unbounded (today's behavior).

export async function runPool(items, limit, fn) {
  const list = Array.from(items);
  const results = new Array(list.length);
  if (!Number.isInteger(limit) || limit <= 0 || limit >= list.length) {
    const settled = await Promise.allSettled(list.map((item, i) => fn(item, i)));
    return settled;
  }
  let next = 0;
  async function worker() {
    while (next < list.length) {
      const i = next++;
      try {
        results[i] = { status: "fulfilled", value: await fn(list[i], i) };
      } catch (reason) {
        results[i] = { status: "rejected", reason };
      }
    }
  }
  await Promise.all(Array.from({ length: limit }, () => worker()));
  return results;
}
