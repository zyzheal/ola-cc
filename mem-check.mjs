// Simple memory leak detection: import the bundle multiple times,
// check if heap grows monotonically after GC.

const results = [];
for (let i = 0; i < 3; i++) {
  // Clear require cache for ESM modules is not possible,
  // but we can check if globals accumulate
  const startHeap = process.memoryUsage().heapUsed;
  
  // The bundle is cached after first import, so we just measure
  // the state after GC cycles
  if (global.gc) global.gc();
  await new Promise(r => setTimeout(r, 100));
  if (global.gc) global.gc();
  
  const mem = process.memoryUsage();
  results.push({
    iteration: i + 1,
    heapMB: (mem.heapUsed / 1024 / 1024).toFixed(1),
    rssMB: (mem.rss / 1024 / 1024).toFixed(1),
    externalMB: (mem.external / 1024 / 1024).toFixed(1),
  });
}

console.table(results);

// Check for monotonic heap growth (indicator of leak)
const heaps = results.map(r => parseFloat(r.heapMB));
const isMonotonic = heaps.every((v, i) => i === 0 || v >= heaps[i - 1]);
console.log('Monotonic heap growth:', isMonotonic);
console.log('Heap delta:', (heaps[heaps.length - 1] - heaps[0]).toFixed(1), 'MB');
