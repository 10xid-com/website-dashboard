// The forms Worker's entry point. client.js is browser code, so it comes in
// as text (the Text rule in wrangler.jsonc) and is served, never run here.
import client from './client.js';
import { createHandler } from './handler.js';

const handle = createHandler(client);

export default {
  fetch: (request, env) => handle(request, env),
};
