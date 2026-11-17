// Module-loader hooks for worker.test.js only. They stand in for the two
// things worker.js imports that plain Node lacks: the `cloudflare:workers`
// runtime module, and `pg` (a TCP connection to Neon), which is replaced by
// a client backed by the test's PGlite. Nothing in src/ changes for this.
const stubs = {
  'cloudflare:workers': new URL('./cloudflare-workers.js', import.meta.url).href,
  pg: new URL('./pg.js', import.meta.url).href,
};

export async function resolve(specifier, context, next) {
  if (stubs[specifier]) return { url: stubs[specifier], shortCircuit: true };
  return next(specifier, context);
}
